import { parentPort, workerData } from "node:worker_threads";

interface WorkerConfig {
  embeddingModel: string;
  rerankModel: string;
  dtype: string;
  cacheDir: string;
}

const config = workerData as WorkerConfig;
let embeddingPipeline: any;
let rerankModel: any;
let rerankTokenizer: any;

async function getEmbeddingPipeline() {
  if (!embeddingPipeline) {
    const { env, pipeline } = await import("@huggingface/transformers");
    env.cacheDir = config.cacheDir;
    embeddingPipeline = await pipeline(
      "feature-extraction",
      config.embeddingModel,
      {
        dtype: config.dtype as any,
      },
    );
  }
  return embeddingPipeline;
}

async function countEmbeddingTokens(texts: string[]): Promise<number[]> {
  const model = await getEmbeddingPipeline();
  const tokenizer = model.tokenizer;
  if (!tokenizer)
    throw new Error("Embedding pipeline did not expose its tokenizer");
  const counts: number[] = [];
  for (const text of texts) {
    const encoded = await tokenizer(text, {
      padding: false,
      truncation: false,
    });
    const ids = encoded.input_ids.tolist() as number[] | number[][];
    counts.push(
      Array.isArray(ids[0]) ? (ids[0] as number[]).length : ids.length,
    );
  }
  return counts;
}

/**
 * 获取 rerank 模型
 * @returns 包含模型和分词器的 Promise
 */
async function getReranker() {
  if (!rerankModel || !rerankTokenizer) {
    // 使用 @huggingface/transformers 库
    const { AutoModelForSequenceClassification, AutoTokenizer, env } =
      await import("@huggingface/transformers");
    env.cacheDir = config.cacheDir;
    // 加载模型
    [rerankTokenizer, rerankModel] = await Promise.all([
      AutoTokenizer.from_pretrained(config.rerankModel),
      AutoModelForSequenceClassification.from_pretrained(config.rerankModel, {
        dtype: config.dtype as any,
      }),
    ]);
  }
  return { model: rerankModel, tokenizer: rerankTokenizer };
}

parentPort?.on(
  "message",
  async (message: { id: number; type: string; payload: any }) => {
    try {
      if (message.type === "embed") {
        const model = await getEmbeddingPipeline();
        /**
       * output = {
       *    logits: Tensor {
       *      dims: [3, 1],  // [batch_size, num_classes]
       *      data: Float32Array [3.2, -0.5, 1.8]  // 3 个 passage 的 logit
       *   }
       *  }
       * 
       */
        const output = await model(message.payload.texts, {
          pooling: "cls", // 用 [CLS] token 的输出作为整句表示
          normalize: true, // L2 归一化，使余弦相似度 = 内积
          truncation: true, // 超过模型最大长度自动截断
        });
        //
        const raw = output.tolist() as number[][] | number[][][];
        const vectors = Array.isArray(raw[0]?.[0])
          ? (raw as number[][][]).map((item) => item[0]!)
          : raw;
        parentPort?.postMessage({ id: message.id, result: vectors });
        return;
      }
      if (message.type === "count_embedding_tokens") {
        const counts = await countEmbeddingTokens(message.payload.texts);
        parentPort?.postMessage({ id: message.id, result: counts });
        return;
      }
      if (message.type === "rerank") {
        // 获取 rerank 模型
        const { model, tokenizer } = await getReranker();
        //queries 是一个数组，长度和 passages 相同，每个元素都是同一个 query
        // 这是为了模型输入的格式要求
        const queries = message.payload.passages.map(
          () => message.payload.query,
        );
        const inputs = await tokenizer(queries, {
          text_pair: message.payload.passages,
          padding: true, // 填充到相同长度
          truncation: true, // 截断超长文本
        });
        const output = await model(inputs);
        // 从输出中提取 logits 模型输出的原始分数
        const logits = output.logits.tolist() as Array<number | number[]>;
        // 把 logits 转为 0-1 之间的概率分数
        const scores = logits.map((value) => {
          const raw = Array.isArray(value)
            ? Number(value.at(-1) ?? 0)
            : Number(value);
          return 1 / (1 + Math.exp(-raw));
        });
        //通过 postMessage 把结果发回主线程
        parentPort?.postMessage({ id: message.id, result: scores });
        return;
      }
      throw new Error(`Unknown inference task: ${message.type}`);
    } catch (error) {
      parentPort?.postMessage({
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);
