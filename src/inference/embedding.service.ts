import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AppConfig } from '../config/app-config.js';
import { tokenizeHash } from '../retrieval/text-utils.js';
import { InferenceWorkerService } from './inference-worker.service.js';

@Injectable()
export class EmbeddingService {
  constructor(
    private readonly config: AppConfig,
    private readonly worker: InferenceWorkerService,
  ) {}

  get dim(): number {
    return this.config.embeddingDim;
  }

  async embed(text: string): Promise<number[]> {
    return (await this.embedBatch([text]))[0] ?? [];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (this.config.embeddingProvider === 'transformers') return this.worker.embed(texts);
    return texts.map((text) => hashEmbedding(text, this.config.embeddingDim));
  }
}

export function hashEmbedding(text: string, dimension: number): number[] {
  const vector = new Array<number>(dimension).fill(0);
  for (const token of tokenizeHash(text)) {
    const digest = createHash('md5').update(token).digest();
    const index = digest.readUInt32BE(0) % dimension;
    const sign = digest[4]! % 2 === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign;
  }
  const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
  return norm ? vector.map((item) => item / norm) : vector;
}
