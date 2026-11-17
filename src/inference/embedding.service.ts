/**
 * @file 文本向量化。为查询和文档生成稠密向量，复用缓存并检查模型 Token 预算。
 */
import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { AppConfig } from "../config/app-config.js";
import { tokenizeHash } from "../retrieval/text-utils.js";
import { InferenceWorkerService } from "./inference-worker.service.js";
import { estimateTokens } from "../retrieval/chunker.js";

@Injectable()
export class EmbeddingService {
  // ponytail: process-local 1024-entry reuse. Persistent reuse can follow measured cold-start costs.
  private readonly vectors = new Map<string, Promise<number[]>>();
  //依赖配置和推理 Worker。
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param config 应用运行配置。
   * @param worker InferenceWorkerService 依赖实例。
   */
  constructor(
    private readonly config: AppConfig,
    private readonly worker: InferenceWorkerService,
  ) {}
  //向量维度，从配置读。
  /**
   * 向量维度，从配置读。
   *
   * @returns 计算得到的数值。
   */
  get dim(): number {
    return this.config.embeddingDim;
  }

  /**
   * 单文本 embedding 复用 batch 接口，取第一个结果
   * @param text 待处理的文本。
   * 768 维稠密向量（BGE 模型输出）
   * number[]: [0.0234, -0.0567, 0.1234, ..., 0.0891]
   *
   * @returns 计算得到的数值向量或评分列表。
   */
  async embed(text: string): Promise<number[]> {
    return (await this.embedBatch([text]))[0] ?? [];
  }
/**
   * 批量 embedding
   * @param texts 需要批量生成向量的文本列表。
   * @returns 与输入文本顺序一致的稠密向量数组。
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    //默认 embeddingProvider = 'hash' 。也就是说， 如果不配置环境变量，Dense 向量不是真模型生成的，而是 hashEmbedding 生成的伪向量 。这是本地开发无 GPU 时的回退方案。
    if (this.config.embeddingProvider === "transformers")
      return this.embedCached(texts);
    if (this.config.runtimeMode === 'real') {
      throw new Error(`Real RAG mode forbids embedding provider '${this.config.embeddingProvider}'`);
    }
    return texts.map((text) => hashEmbedding(text, this.config.embeddingDim));
  }

  /**
   * 优先复用已计算的文本向量，仅对未命中部分发起推理。
   *
   * @param texts 需要批量处理的文本列表。
   * @returns 各输入文本对应的向量数组。
   */
  private async embedCached(texts: string[]): Promise<number[][]> {
    const keys = texts.map((text) => createHash('sha256').update(JSON.stringify([
      this.config.embeddingProvider, this.config.embeddingModel, this.config.embeddingDim,
      this.config.modelDtype, text,
    ])).digest('hex'));
    const requested = new Map<string, Promise<number[]>>();
    const missing = new Map<string, string>();
    for (const [index, key] of keys.entries()) {
      const cached = this.vectors.get(key);
      if (cached) {
        this.vectors.delete(key);
        this.vectors.set(key, cached);
        requested.set(key, cached);
      } else missing.set(key, texts[index]!);
    }
    if (missing.size) {
      const batch = this.worker.embed([...missing.values()]).then((rows) => {
        if (rows.length !== missing.size || rows.some((row) => row.length !== this.dim ||
          row.some((value) => !Number.isFinite(value)))) throw new Error('Embedding returned invalid vectors');
        return rows;
      });
      for (const [index, key] of [...missing.keys()].entries()) {
        const vector: Promise<number[]> = batch.then((rows) => [...rows[index]!]).catch((error) => {
          if (this.vectors.get(key) === vector) this.vectors.delete(key);
          throw error;
        });
        this.vectors.set(key, vector);
        requested.set(key, vector);
        if (this.vectors.size > 1024) this.vectors.delete(this.vectors.keys().next().value!);
      }
    }
    return Promise.all(keys.map(async (key) => [...await requested.get(key)!]));
  }

  /**
   * 计算输入文本的 Token 数，用于预算检查。
   *
   * @param texts 需要批量处理的文本列表。
   * @returns 计算得到的数值向量或评分列表。
   */
  async countTokens(texts: string[]): Promise<number[]> {
    if (this.config.embeddingProvider === "transformers") {
      return this.worker.countEmbeddingTokens(texts);
    }
    if (this.config.runtimeMode === "real") {
      throw new Error(
        `Real RAG mode forbids token counting for provider '${this.config.embeddingProvider}'`,
      );
    }
    return texts.map(estimateTokens);
  }
}

//基于 hash 生成稠密向量
/**
 * 基于 hash 生成稠密向量
 *
 * @param text 待处理的文本。
 * @param dimension 生成向量使用的维度。
 * @returns 计算得到的数值向量或评分列表。
 */
export function hashEmbedding(text: string, dimension: number): number[] {
  //初始化全 0 向量，维度默认 384。
  const vector = new Array<number>(dimension).fill(0);
  //对文本分词
  for (const token of tokenizeHash(text)) {
    //对每个 token 算 MD5 hash
    const digest = createHash("md5").update(token).digest();
    //取 MD5 前 4 字节作为无符号整数，对 384 取模，得到要更新的维度下标。
    const index = digest.readUInt32BE(0) % dimension;
    //取第 5 个字节判断奇偶，决定 +1 还是 -1。
    const sign = digest[4]! % 2 === 0 ? 1 : -1;
    //对应维度累加 ±1。
    vector[index] = (vector[index] ?? 0) + sign;
  }
  //计算 L2 范数。
  const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
  //归一化。如果范数为 0（空文本）就返回原向量。
  return norm ? vector.map((item) => item / norm) : vector;
}
