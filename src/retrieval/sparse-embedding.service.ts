import { Injectable } from '@nestjs/common';
import * as murmurhash from 'murmurhash-js';
import { tokenizeKeyword } from './text-utils.js';

export interface SparseEmbedding {
  indices: number[];
  values: number[];
}

@Injectable()
export class SparseEmbeddingService {
  embedDocument(text: string): SparseEmbedding {
    const counts = new Map<string, number>();
    for (const token of this.tokenize(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
    // Different tokens can produce the same 32-bit hash. Qdrant requires sparse
    // indices to be unique, so combine colliding token weights by index before
    // sorting and serializing the vector.
    const weightsByIndex = new Map<number, number>();
    for (const [token, frequency] of counts) {
      const index = this.tokenId(token);
      const weight = 1 + Math.log(frequency);
      weightsByIndex.set(index, (weightsByIndex.get(index) ?? 0) + weight);
    }
    const pairs = [...weightsByIndex.entries()].map(([index, value]) => ({
      index,
      value,
    }));
    pairs.sort((a, b) => a.index - b.index);
    return {
      indices: pairs.map((item) => item.index),
      values: pairs.map((item) => item.value),
    };
  }

  embedQuery(text: string): SparseEmbedding {
    const indices = [...new Set(this.tokenize(text).map((token) => this.tokenId(token)))].sort((a, b) => a - b);
    return { indices, values: indices.map(() => 1) };
  }

  tokenize(text: string): string[] {
    return tokenizeKeyword(text).filter((item) => item.length <= 40);
  }

  private tokenId(token: string): number {
    return murmurhash.murmur3(token) >>> 0;
  }
}
