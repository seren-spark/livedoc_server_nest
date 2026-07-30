import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/app-config.js';
import type { SearchHit } from '../retrieval/vector-store.service.js';
import { tokenizeKeyword } from '../retrieval/text-utils.js';
import { round } from '../retrieval/text-utils.js';
import { InferenceWorkerService } from './inference-worker.service.js';

@Injectable()
export class RerankerService {
  constructor(
    private readonly config: AppConfig,
    private readonly worker: InferenceWorkerService,
  ) {}

  async rerank(query: string, hits: SearchHit[], topN: number): Promise<SearchHit[]> {
    if (this.config.rerankProvider === 'none') return hits;
    const candidates = hits.slice(0, topN);
    const tail = hits.slice(topN);
    if (!candidates.length) return hits;
    if (this.config.rerankProvider === 'bge') {
      const scores = await this.worker.rerank(query, candidates.map((hit) => buildPassage(hit.payload)));
      const reranked: SearchHit[] = candidates.map((hit, index) => ({
        ...hit,
        score: scores[index] ?? 0,
        payload: {
          ...hit.payload,
          pre_rerank_score: hit.score,
          rerank_score: round(scores[index] ?? 0, 4),
        },
      }));
      return reranked.sort((a, b) => b.score - a.score).concat(tail);
    }
    const queryTerms = tokenizeKeyword(query);
    const reranked: SearchHit[] = candidates.map((hit) => {
      const score = hit.score * 0.55 + fieldMatchScore(queryTerms, hit.payload) * 0.35 + sourceQualityScore(hit.payload) * 0.1;
      return { ...hit, score, payload: { ...hit.payload, rerank_score: round(score, 4) } };
    });
    return reranked.sort((a, b) => b.score - a.score).concat(tail);
  }
}

export function buildPassage(payload: Record<string, any>): string {
  return [
    `title: ${payload.title ?? ''}`,
    `path: ${(payload.heading_path ?? []).join(' > ')}`,
    `tags: ${(payload.tags ?? []).join(' ')}`,
    String(payload.content ?? ''),
  ].join('\n');
}

function fieldMatchScore(queryTerms: string[], payload: Record<string, any>): number {
  if (!queryTerms.length) return 0;
  const title = String(payload.title ?? '').toLowerCase();
  const tags = (payload.tags ?? []).join(' ').toLowerCase();
  const heading = (payload.heading_path ?? []).join(' ').toLowerCase();
  const content = String(payload.content ?? '').toLowerCase();
  let score = 0;
  for (const term of queryTerms) {
    if (title.includes(term)) score += 2;
    else if (tags.includes(term) || heading.includes(term)) score += 1.5;
    else if (content.includes(term)) score += 1;
  }
  return Math.min(score / queryTerms.length, 1);
}

function sourceQualityScore(payload: Record<string, any>): number {
  if (payload.visibility === 'private') return 1;
  return ['article', 'public_article'].includes(payload.source_type) ? 0.8 : 0.6;
}
