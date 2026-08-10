import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { AppConfig } from "../config/app-config.js";
import { tokenizeHash } from "../retrieval/text-utils.js";
import { InferenceWorkerService } from "./inference-worker.service.js";
import { estimateTokens } from "../retrieval/chunker.js";

@Injectable()
export class EmbeddingService {
  //依赖配置和推理 Worker。
  constructor(
    private readonly config: AppConfig,
    private readonly worker: InferenceWorkerService,
  ) {}
  //向量维度，从配置读。
  get dim(): number {
    return this.config.embeddingDim;
  }

  async embed(text: string): Promise<number[]> {
    //单个文本 embedding，复用 batch。
    return (await this.embedBatch([text]))[0] ?? [];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    //默认 embeddingProvider = 'hash' 。也就是说， 如果不配置环境变量，Dense 向量不是真模型生成的，而是 hashEmbedding 生成的伪向量 。这是本地开发无 GPU 时的回退方案。
    if (this.config.embeddingProvider === "transformers")
      return this.worker.embed(texts);
    if (this.config.runtimeMode === 'real') {
      throw new Error(`Real RAG mode forbids embedding provider '${this.config.embeddingProvider}'`);
    }
    return texts.map((text) => hashEmbedding(text, this.config.embeddingDim));
  }

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
