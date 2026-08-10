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
    // 第1步：如果配置为 none，直接返回原结果，不做重排
    if (this.config.rerankProvider === 'none') return hits;
    // 第2步：只取前 topN 个候选进入重排，减少模型调用开销
    const candidates = hits.slice(0, topN);
    // 剩余结果保留，稍后拼回
    const tail = hits.slice(topN);
    // 第3步：没有候选直接返回原结果
    if (!candidates.length) return hits;
    // 第4步：使用 BGE 等模型做交叉编码重排
    if (this.config.rerankProvider === 'bge') {
      // 调用推理 Worker，传入 query 和每个候选的文本段落，获取重排分数数组
      const scores = await this.worker.rerank(query, candidates.map((hit) => buildPassage(hit.payload)));
      // 第5步：用模型返回的分数替换原 score
      const reranked: SearchHit[] = candidates.map((hit, index) => ({
        ...hit,
        score: scores[index] ?? 0,
        payload: {
          ...hit.payload,
          pre_rerank_score: hit.score,// 保存重排前的 RRF 分数
          rerank_score: round(scores[index] ?? 0, 4),// 保存重排后的分数
        },
      }));
      // 第6步：按重排后的分数降序，再拼回未重排的 tail
      return reranked.sort((a, b) => b.score - a.score).concat(tail);
    }
    if (this.config.runtimeMode === 'real') {
      throw new Error(`Real RAG mode forbids rerank provider '${this.config.rerankProvider}'`);
    }
    // 第7步：如果没有配置模型，使用启发式规则重排
    const queryTerms = tokenizeKeyword(query);
    const reranked: SearchHit[] = candidates.map((hit) => {
      // 综合打分：原始分55% + 字段匹配35% + 来源质量10%
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
