import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { getEncoding, type Tiktoken } from "js-tiktoken";
import { LlmService } from "../../ai/llm.service.js";
import { AppConfig } from "../../config/app-config.js";
import { chunkMarkdown } from "../../retrieval/chunker.js";
import { DocumentsService } from "../documents.service.js";
import { DocumentMemoryJobsService } from "./document-memory-jobs.service.js";
import { DocumentMemoryService } from "./document-memory.service.js";
import type {
  ExtractedDocumentMemory,
  MemoryEvidence,
} from "./document-memory.types.js";

interface MemoryChunk {
  hash: string;
  anchor: string;
  content: string;
}

@Injectable()
export class DocumentMemoryWorkerService {
  private readonly tokenizer: Tiktoken;

  constructor(
    private readonly config: AppConfig,
    private readonly jobs: DocumentMemoryJobsService,
    private readonly profiles: DocumentMemoryService,
    private readonly documents: DocumentsService,
    private readonly llm: LlmService,
  ) {
    this.tokenizer = getEncoding(
      this.config.tokenizerEncoding as Parameters<typeof getEncoding>[0],
    );
  }

  async runOnce(workerId: string): Promise<boolean> {
    //抢任务 + 版本校验
    if (!this.config.documentMemoryEnabled) return false;
    const job = await this.jobs.claimNext(workerId);
    if (!job) return false;
    try {
      //如果版本不一致，直接标记 superseded（过期作废），不浪费 LLM 调用。
      const document = await this.documents.get(job.doc_id);
      if (!document || document.deleted_at || document.document_version !== job.document_version) {
        await this.jobs.supersede(job);
        return true;
      }
      //更新状态
      await this.profiles.markExtracting(document.doc_id);
      const previous = await this.profiles.get(document.doc_id);
      //-----------markdown 切片----------------
      const chunks = chunkMarkdown(
        document.doc_id,
        document.title,
        document.content,
        {
          maxTokens: this.config.chunkMaxTokens,
          overlapTokens: this.config.chunkOverlapTokens,
        },
      ).map(
        (chunk): MemoryChunk => ({
          hash: createHash("sha256")
            .update(chunk.retrieval_content ?? chunk.content)
            .digest("hex")
            .slice(0, 32),
          anchor: chunk.source_anchor,
          content: chunk.retrieval_content ?? chunk.content,
        }),
      );

      const currentHashes = chunks.map((chunk) => chunk.hash);
      const previousHashes = new Set(previous?.source_chunk_hashes ?? []);
      const changed = chunks.filter((chunk) => !previousHashes.has(chunk.hash));
      // 首次提取，或文档内容变化超过 50%，则自动执行全量提取。
      const fullExtraction =
        !previous?.source_chunk_hashes.length ||
        changed.length / Math.max(chunks.length, 1) > 0.5;
      // 全量提取chunks或仅提取变化部分
      const selected = fullExtraction ? chunks : changed;
      // 从文档中提取术语表 风格标签 全局设置
      const extracted = await this.extractBatches(selected);
      // 第二次版本检查 + 写入记忆
      const latest = await this.documents.get(job.doc_id);
      if (
        !latest || latest.deleted_at || latest.document_version !== job.document_version ||
        !(await this.jobs.isActive(job))
      ) {
        await this.jobs.supersede(job);
        return true;
      }

      const evidenceByHash = new Map<string, MemoryEvidence>(
        chunks.map((chunk) => [
          chunk.hash,
          {
            hash: chunk.hash,
            anchor: chunk.anchor,
            snippet: chunk.content.slice(0, 240),
          },
        ]),
      );
      await this.profiles.applyExtraction({
        document: latest,
        extracted, // LLM 提取的原始结果
        evidenceByHash, // 证据映射
        currentHashes, // 当前所有 chunk hash
        fullExtraction, // 是否全量提取
      });
      await this.jobs.succeed(job);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const terminal = await this.jobs.fail(job, message);
      if (terminal) await this.profiles.markFailed(job.doc_id, message);
      else {
        const document = await this.documents.get(job.doc_id);
        if (document) await this.profiles.markPending(document);
      }
    }
    return true;
  }

  /**
   * 从文档中提取术语表 风格标签 全局设置
   * @param chunks 文档内容的 chunk 数组
   * @returns 从文档中提取的术语表 风格标签 全局设置
   */
  private async extractBatches(
    chunks: MemoryChunk[],
  ): Promise<ExtractedDocumentMemory> {
    const combined: ExtractedDocumentMemory = {
      glossary: [],
      style_tags: [],
      global_settings: [],
    };
    for (const batch of this.pack(chunks)) {
      const extracted = await this.llm.extractDocumentMemory(batch);
      combined.glossary.push(...extracted.glossary);
      combined.style_tags.push(...extracted.style_tags);
      combined.global_settings.push(...extracted.global_settings);
    }
    return combined;
  }

  /**
   * 把 chunk 按容量打包成 batch，就能让每次 LLM 调用都处理尽可能多的内容，减少请求次数、提高效率
   */
  private pack(chunks: MemoryChunk[]): MemoryChunk[][] {
    //一批chunk
    const batches: MemoryChunk[][] = [];
    //当前正在装的 batch
    let current: MemoryChunk[] = [];
    let used = 0;
    for (const chunk of chunks) {
      const count = this.tokenizer.encode(chunk.content).length; // 当前 chunk 的 token 数
      if (current.length && used + count > this.config.summaryMapInputTokens) {
        batches.push(current); // 当前 batch 已满，封存
        current = []; // 开启新 batch
        used = 0;
      }
      current.push(chunk); // 把 chunk 放进当前 batch
      used += count; // 累加已用 token
    }

    if (current.length) batches.push(current);
    return batches;
  }
}
