import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { getEncoding, type Tiktoken } from 'js-tiktoken';
import { LlmService } from '../ai/llm.service.js';
import { AppConfig } from '../config/app-config.js';
import { chunkMarkdown } from '../retrieval/chunker.js';
import { DocumentsService } from './documents.service.js';
import { DocumentMemoryJobsService } from './document-memory-jobs.service.js';
import { DocumentMemoryService } from './document-memory.service.js';
import type { ExtractedDocumentMemory, MemoryEvidence } from './document-memory.types.js';

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
    if (!this.config.documentMemoryEnabled) return false;
    const job = await this.jobs.claimNext(workerId);
    if (!job) return false;
    try {
      const document = await this.documents.require(job.doc_id);
      if (document.document_version !== job.document_version) {
        await this.jobs.supersede(job);
        return true;
      }
      await this.profiles.markExtracting(document.doc_id);
      const previous = await this.profiles.get(document.doc_id);
      const chunks = chunkMarkdown(document.doc_id, document.title, document.content, {
        maxTokens: this.config.chunkMaxTokens,
        overlapTokens: this.config.chunkOverlapTokens,
      }).map((chunk): MemoryChunk => ({
        hash: createHash('sha256').update(chunk.content).digest('hex').slice(0, 32),
        anchor: chunk.source_anchor,
        content: chunk.content,
      }));
      const currentHashes = chunks.map((chunk) => chunk.hash);
      const previousHashes = new Set(previous?.source_chunk_hashes ?? []);
      const changed = chunks.filter((chunk) => !previousHashes.has(chunk.hash));
      const fullExtraction = job.force_full || !previous?.source_chunk_hashes.length ||
        changed.length / Math.max(chunks.length, 1) > 0.5;
      const selected = fullExtraction ? chunks : changed;
      const extracted = await this.extractBatches(selected);
      const latest = await this.documents.require(job.doc_id);
      if (latest.document_version !== job.document_version || !(await this.jobs.isActive(job))) {
        await this.jobs.supersede(job);
        return true;
      }
      const evidenceByHash = new Map<string, MemoryEvidence>(chunks.map((chunk) => [
        chunk.hash,
        { hash: chunk.hash, anchor: chunk.anchor, snippet: chunk.content.slice(0, 240) },
      ]));
      await this.profiles.applyExtraction({
        document: latest,
        extracted,
        evidenceByHash,
        currentHashes,
        fullExtraction,
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

  private async extractBatches(chunks: MemoryChunk[]): Promise<ExtractedDocumentMemory> {
    const combined: ExtractedDocumentMemory = { glossary: [], style_tags: [], global_settings: [] };
    for (const batch of this.pack(chunks)) {
      const extracted = await this.llm.extractDocumentMemory(batch);
      combined.glossary.push(...extracted.glossary);
      combined.style_tags.push(...extracted.style_tags);
      combined.global_settings.push(...extracted.global_settings);
    }
    return combined;
  }

  private pack(chunks: MemoryChunk[]): MemoryChunk[][] {
    const batches: MemoryChunk[][] = [];
    let current: MemoryChunk[] = [];
    let used = 0;
    for (const chunk of chunks) {
      const count = this.tokenizer.encode(chunk.content).length;
      if (current.length && used + count > this.config.summaryMapInputTokens) {
        batches.push(current);
        current = [];
        used = 0;
      }
      current.push(chunk);
      used += count;
    }
    if (current.length) batches.push(current);
    return batches;
  }
}
