import { parentPort, workerData } from 'node:worker_threads';

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
    const { env, pipeline } = await import('@huggingface/transformers');
    env.cacheDir = config.cacheDir;
    embeddingPipeline = await pipeline('feature-extraction', config.embeddingModel, {
      dtype: config.dtype as any,
    });
  }
  return embeddingPipeline;
}

async function getReranker() {
  if (!rerankModel || !rerankTokenizer) {
    const { AutoModelForSequenceClassification, AutoTokenizer, env } = await import(
      '@huggingface/transformers'
    );
    env.cacheDir = config.cacheDir;
    [rerankTokenizer, rerankModel] = await Promise.all([
      AutoTokenizer.from_pretrained(config.rerankModel),
      AutoModelForSequenceClassification.from_pretrained(config.rerankModel, {
      dtype: config.dtype as any,
      }),
    ]);
  }
  return { model: rerankModel, tokenizer: rerankTokenizer };
}

parentPort?.on('message', async (message: { id: number; type: string; payload: any }) => {
  try {
    if (message.type === 'embed') {
      const model = await getEmbeddingPipeline();
      const output = await model(message.payload.texts, { pooling: 'cls', normalize: true });
      const raw = output.tolist() as number[][] | number[][][];
      const vectors = Array.isArray(raw[0]?.[0]) ? (raw as number[][][]).map((item) => item[0]!) : raw;
      parentPort?.postMessage({ id: message.id, result: vectors });
      return;
    }
    if (message.type === 'rerank') {
      const { model, tokenizer } = await getReranker();
      const queries = message.payload.passages.map(() => message.payload.query);
      const inputs = await tokenizer(queries, {
        text_pair: message.payload.passages,
        padding: true,
        truncation: true,
      });
      const output = await model(inputs);
      const logits = output.logits.tolist() as Array<number | number[]>;
      const scores = logits.map((value) => {
        const raw = Array.isArray(value) ? Number(value.at(-1) ?? 0) : Number(value);
        return 1 / (1 + Math.exp(-raw));
      });
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
});
