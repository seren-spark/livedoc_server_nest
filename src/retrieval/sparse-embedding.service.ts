import { Injectable } from '@nestjs/common';
import { tokenizeKeyword } from './text-utils.js';

export interface SparseEmbedding {
  indices: number[];
  values: number[];
}

@Injectable()
export class SparseEmbeddingService {
  private readonly k = 1.2;
  private readonly b = 0.75;
  private readonly averageLength = 256;

  embedDocument(text: string): SparseEmbedding {
    const tokens = this.tokenize(text);
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    const pairs = [...counts.entries()].map(([token, frequency]) => ({
      index: Math.abs(murmurHash3(token)),
      value:
        (frequency * (this.k + 1)) /
        (frequency + this.k * (1 - this.b + (this.b * tokens.length) / this.averageLength)),
    }));
    pairs.sort((a, b) => a.index - b.index);
    return { indices: pairs.map((item) => item.index), values: pairs.map((item) => item.value) };
  }

  embedQuery(text: string): SparseEmbedding {
    const indices = [...new Set(this.tokenize(text).map((token) => Math.abs(murmurHash3(token))))].sort(
      (a, b) => a - b,
    );
    return { indices, values: indices.map(() => 1) };
  }

  tokenize(text: string): string[] {
    return tokenizeKeyword(text).filter((item) => item.length <= 40);
  }
}

// MurmurHash3 x86_32, matching Python mmh3.hash token ids used by FastEmbed BM25.
export function murmurHash3(value: string, seed = 0): number {
  const bytes = Buffer.from(value, 'utf8');
  let hash = seed | 0;
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  let index = 0;
  while (index + 4 <= bytes.length) {
    let k = bytes.readUInt32LE(index);
    index += 4;
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    hash ^= k;
    hash = (hash << 13) | (hash >>> 19);
    hash = (Math.imul(hash, 5) + 0xe6546b64) | 0;
  }
  let tail = 0;
  const remaining = bytes.length & 3;
  if (remaining === 3) tail ^= bytes[index + 2]! << 16;
  if (remaining >= 2) tail ^= bytes[index + 1]! << 8;
  if (remaining >= 1) {
    tail ^= bytes[index]!;
    tail = Math.imul(tail, c1);
    tail = (tail << 15) | (tail >>> 17);
    tail = Math.imul(tail, c2);
    hash ^= tail;
  }
  hash ^= bytes.length;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash | 0;
}
