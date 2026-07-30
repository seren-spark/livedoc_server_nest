import { Injectable } from '@nestjs/common';
import { getEncoding, type Tiktoken } from 'js-tiktoken';
import type { Citation } from '../common/types.js';
import { AppConfig } from '../config/app-config.js';
import { tokenizeKeyword } from './text-utils.js';

@Injectable()
export class ContextCompressorService {
  private readonly tokenizer: Tiktoken;

  constructor(private readonly config: AppConfig) {
    this.tokenizer = getEncoding(this.config.tokenizerEncoding as Parameters<typeof getEncoding>[0]);
  }

  compress(citations: Citation[], query: string): Citation[] {
    const result: Citation[] = [];
    let remaining = this.config.contextTokenBudget;
    for (const citation of citations) {
      if (remaining <= 0) break;
      const content = this.extractRelevant(
        citation.content,
        query,
        Math.min(this.config.contextPerCitationTokens, remaining),
      );
      if (!content) continue;
      result.push({ ...citation, content });
      remaining -= this.count(content);
    }
    return result;
  }

  extractRelevant(content: string, query: string, tokenBudget: number): string {
    const sentences = splitSentences(content);
    if (!sentences.length || tokenBudget <= 0) return '';
    const queryTerms = new Set(tokenizeKeyword(query));
    const candidates = sentences.map((text, index) => ({
      text,
      index,
      score: sentenceScore(text, queryTerms, index),
    }));
    candidates.sort((a, b) => b.score - a.score || a.index - b.index);
    const selected: typeof candidates = [];
    let used = 0;
    for (const candidate of candidates) {
      const count = this.count(candidate.text);
      const separator = selected.length ? 1 : 0;
      if (!selected.length && count > tokenBudget) return this.truncate(candidate.text, tokenBudget);
      if (used + count + separator <= tokenBudget) {
        selected.push(candidate);
        used += count + separator;
      }
      if (used >= tokenBudget) break;
    }
    return selected.sort((a, b) => a.index - b.index).map((item) => item.text).join(' … ');
  }

  count(text: string): number {
    return this.tokenizer.encode(text).length;
  }

  truncate(text: string, budget: number): string {
    if (budget <= 0) return '';
    const tokens = this.tokenizer.encode(text);
    return tokens.length <= budget ? text : this.tokenizer.decode(tokens.slice(0, budget)).trimEnd();
  }
}

export function splitSentences(content: string): string[] {
  const normalized = content.trim().replace(/[ \t]+/g, ' ');
  return normalized.match(/[^。！？!?；;\n]+[。！？!?；;]?/gu)?.map((item) => item.trim()).filter(Boolean) ?? [];
}

function sentenceScore(sentence: string, queryTerms: Set<string>, index: number): number {
  const terms = tokenizeKeyword(sentence);
  if (!terms.length) return 0;
  const unique = new Set(terms);
  const overlapCount = [...queryTerms].filter((term) => unique.has(term)).length;
  const overlap = overlapCount / Math.max(queryTerms.size, 1);
  const coverage = overlapCount / unique.size;
  return overlap * 0.8 + coverage * 0.2 + (1 / (index + 1)) * 0.05;
}
