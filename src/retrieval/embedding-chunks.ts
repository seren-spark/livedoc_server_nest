import { buildChunkPassage, chunkMarkdown } from './chunker.js';
import type { AppConfig } from '../config/app-config.js';
import type { EmbeddingService } from '../inference/embedding.service.js';

// Used by production indexing and offline framework exports with identical token budgets.
export async function prepareEmbeddingChunks(docId: string, title: string, content: string,
  config: Pick<AppConfig, 'chunkMaxTokens' | 'chunkOverlapTokens'>, embeddings: Pick<EmbeddingService, 'countTokens'>) {
    let planningBudget = config.chunkMaxTokens;

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const chunks = chunkMarkdown(docId, title, content, {
        maxTokens: planningBudget,
        overlapTokens: Math.min(
          config.chunkOverlapTokens,
          Math.max(0, planningBudget - 1),
        ),
      });
      /**
       * passages = [
              "title: RAG 学习笔记\npath: RAG 学习笔记 > 检索 > Dense\nDense 负责语义召回，使用 BGE 模型生成向量。",
              "title: RAG 学习笔记\npath: RAG 学习笔记 > 检索 > Sparse\nSparse 负责词项匹配，擅长精确命中。"
            ]       
       */
      //把每个 chunk 拼成最终 passage：title: xxx\npath: xxx\n[正文]。
      const passages = chunks.map(buildChunkPassage);
      //计算每个passage token
      const actualCounts = await embeddings.countTokens(passages);
      if (actualCounts.length !== passages.length) {
        throw new Error(
          `Embedding tokenizer returned ${actualCounts.length} counts for ${passages.length} passages`,
        );
      }

      const largest = Math.max(0, ...actualCounts);
      if (largest <= config.chunkMaxTokens) {
        chunks.forEach((chunk, index) => {
          chunk.token_count = actualCounts[index] ?? 0;
        });
        return { chunks, passages };
      }

      const scaled = Math.floor(
        planningBudget * (config.chunkMaxTokens / largest) * 0.92,
      );
      planningBudget = Math.max(64, Math.min(planningBudget - 16, scaled));
    }

    throw new Error(
      `Unable to keep embedding passages within CHUNK_MAX_TOKENS=${config.chunkMaxTokens}; check title/heading metadata or reduce CHUNK_MAX_TOKENS`,
    );
}
