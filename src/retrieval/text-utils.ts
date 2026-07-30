import { Jieba } from '@node-rs/jieba';
import { dict } from '@node-rs/jieba/dict.js';

const HASH_TOKEN_PATTERN = /[A-Za-z0-9_#+.-]+|[\u4e00-\u9fff]/gu;
const KEYWORD_TOKEN_PATTERN = /^(?:[A-Za-z0-9_#+.-]+|[\u4e00-\u9fff]+)$/u;
const jieba = Jieba.withDict(dict) as unknown as {
  cutForSearch?: (value: string, hmm?: boolean) => string[];
  cut: (value: string, hmm: boolean) => string[];
};

export function tokenizeHash(text: string): string[] {
  return text.toLowerCase().match(HASH_TOKEN_PATTERN) ?? [text.slice(0, 64)];
}

export function tokenizeKeyword(text: string): string[] {
  const raw = jieba.cutForSearch?.(text, true) ?? jieba.cut(text, true);
  return raw
    .map((item) => item.trim().toLowerCase())
    .filter((item) => KEYWORD_TOKEN_PATTERN.test(item));
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function elapsedMs(started: number): number {
  return round(performance.now() - started, 2);
}
