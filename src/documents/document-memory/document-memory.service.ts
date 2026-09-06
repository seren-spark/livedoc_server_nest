import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { getEncoding, type Tiktoken } from 'js-tiktoken';
import { AppConfig } from '../../config/app-config.js';
import { DatabaseService } from '../../database/database.service.js';
import type { DocumentRecord } from '../document.types.js';
import type {
  DocumentMemoryProfile,
  ExtractedDocumentMemory,
  GlobalSettingMemoryItem,
  GlossaryMemoryItem,
  MemoryEvidence,
  StyleMemoryItem,
} from './document-memory.types.js';
import { DocumentMemoryRepository } from './document-memory.repository.js';

const LIMITS = { glossary: 30, style_tags: 8, global_settings: 20 } as const;

@Injectable()
export class DocumentMemoryService {
  private readonly profiles = new Map<string, DocumentMemoryProfile>();
  private readonly tokenizer: Tiktoken;
  private readonly repository: DocumentMemoryRepository;

  constructor(
    private readonly config: AppConfig,
    private readonly database: DatabaseService,
  ) {
    this.repository = new DocumentMemoryRepository(database);
    this.tokenizer = getEncoding(
      this.config.tokenizerEncoding as Parameters<typeof getEncoding>[0],
    );
  }

  async get(docId: string): Promise<DocumentMemoryProfile | null> {
    if (!this.database.memoryEnabled) return this.profiles.get(docId) ?? null;
    return this.repository.findByDocumentId(docId);
  }

  async markPending(document: DocumentRecord): Promise<DocumentMemoryProfile> {
    const current = await this.get(document.doc_id);
    const profile = current
      ? { ...current, status: 'pending' as const, last_error: null, updated_at: new Date() }
      : emptyProfile(document, 'pending');
    await this.persist(profile);
    return profile;
  }

  /**
   * 标记文档为正在提取中
   */
  async markExtracting(docId: string): Promise<void> {
    await this.patchStatus(docId, 'extracting', null);
  }

  async markFailed(docId: string, error: string): Promise<void> {
    await this.patchStatus(docId, 'failed', error.slice(0, 2000));
  }

  /**
   * 应用文档记忆提取结果
   * @param document 文档记录
   * @param extracted LLM 提取的原始结果
   * @param evidenceByHash 证据映射
   * @param currentHashes 当前所有 chunk hash
   * @param fullExtraction 是否全量提取
   * @returns 更新后的文档记忆配置
   */
  async applyExtraction(options: {
    document: DocumentRecord;
    extracted: ExtractedDocumentMemory;
    evidenceByHash: Map<string, MemoryEvidence>;
    currentHashes: string[];
    fullExtraction: boolean;
  }): Promise<DocumentMemoryProfile> {
   //获取上一份记忆，没有则创建空档案
    const previous = (await this.get(options.document.doc_id)) ?? emptyProfile(options.document, 'extracting');
    const currentHashSet = new Set(options.currentHashes);
    //从旧记忆里决定保留哪些项
    const retainedGlossary = retainItems(previous.glossary, options.fullExtraction, currentHashSet);
    const retainedStyles = retainItems(previous.style_tags, options.fullExtraction, currentHashSet);
    const retainedSettings = retainItems(previous.global_settings, options.fullExtraction, currentHashSet);
    //只保留置信度 ≥ 配置阈值的项
    const isConfident = (item: { confidence: number }) =>
      validConfidence(item.confidence, this.config.documentMemoryMinConfidence);
    //新抽到的术语表先按置信度过滤
    const autoGlossary = options.extracted.glossary
      .filter(isConfident)
      .map((item): GlossaryMemoryItem => ({
        ...autoFields('glossary', item.term, item, options.evidenceByHash),
        term: clean(item.term, 160),
        definition: clean(item.definition, 1000),
        aliases: uniqueStrings(item.aliases ?? [], 10, 160),
      }))
      //
      .filter((item) => item.term && item.definition);
    const autoStyles = options.extracted.style_tags
      .filter(isConfident)
      .map((item): StyleMemoryItem => ({
        ...autoFields('style', item.label, item, options.evidenceByHash),
        label: clean(item.label, 120),
        instruction: clean(item.instruction, 1000),
      }))
      .filter((item) => item.label && item.instruction);
    const autoSettings = options.extracted.global_settings
      .filter(isConfident)
      .map((item): GlobalSettingMemoryItem => ({
        ...autoFields('setting', item.key, item, options.evidenceByHash),
        key: clean(item.key, 160),
        value: clean(item.value, 1200),
      }))
      .filter((item) => item.key && item.value);

    const next: DocumentMemoryProfile = {
      ...previous,
      source_document_version: options.document.document_version,
      status: 'ready',
      glossary: mergeItems(retainedGlossary, autoGlossary, (item) => memoryKeyFor('glossary', item.term), LIMITS.glossary),
      style_tags: mergeItems(retainedStyles, autoStyles, (item) => memoryKeyFor('style', item.label), LIMITS.style_tags),
      global_settings: mergeItems(retainedSettings, autoSettings, (item) => memoryKeyFor('setting', item.key), LIMITS.global_settings),
      source_chunk_hashes: [...new Set(options.currentHashes)],
      last_error: null,
      updated_at: new Date(),
    };
    await this.persist(next);
    return next;
  }

  async promptText(
    docId: string | undefined,
    documentVersion: number | undefined,
    query: string,
  ): Promise<string> {
    if (!this.config.documentMemoryEnabled || !docId || !documentVersion) return '';
    const profile = await this.get(docId);
    if (!profile || profile.status !== 'ready' || profile.source_document_version !== documentVersion) return '';
    const queryText = normalize(query);
    const matchingGlossary = [...profile.glossary].sort((a, b) => {
      const aMatch = queryText.includes(normalize(a.term)) ? 1 : 0;
      const bMatch = queryText.includes(normalize(b.term)) ? 1 : 0;
      return bMatch - aMatch || b.confidence - a.confidence;
    });
    const sections = [
      ...profile.global_settings.map((item) => `设定｜${item.key}：${item.value}`),
      ...matchingGlossary.map((item) => `术语｜${item.term}：${item.definition}`),
      ...profile.style_tags.map((item) => `风格｜${item.label}：${item.instruction}`),
    ];
    const result: string[] = [];
    let used = 0;
    for (const section of sections) {
      const count = this.tokenizer.encode(section).length;
      if (used + count > this.config.documentMemoryTokenBudget) continue;
      result.push(section);
      used += count;
    }
    return result.join('\n');
  }

  async deleteDocument(docId: string): Promise<void> {
    if (this.database.memoryEnabled) {
      await this.repository.delete(docId);
    } else this.profiles.delete(docId);
  }

  private async patchStatus(
    docId: string,
    status: DocumentMemoryProfile['status'],
    lastError: string | null,
  ): Promise<void> {
    const current = await this.get(docId);
    if (!current) return;
    await this.persist({ ...current, status, last_error: lastError, updated_at: new Date() });
  }

  private async persist(profile: DocumentMemoryProfile): Promise<void> {
    if (!this.database.memoryEnabled) {
      this.profiles.set(profile.doc_id, profile);
      return;
    }
    await this.repository.save(profile);
  }
}

function emptyProfile(document: DocumentRecord, status: DocumentMemoryProfile['status']): DocumentMemoryProfile {
  const now = new Date();
  return {
    doc_id: document.doc_id, space_id: document.space_id, source_document_version: 0,
    status, glossary: [], style_tags: [], global_settings: [],
    source_chunk_hashes: [], last_error: null, created_at: now, updated_at: now,
  };
}

function mergeItems<T extends { confidence: number }>(
  retained: T[], incoming: T[], key: (item: T) => string, limit: number,
): T[] {
  const byKey = new Map<string, T>();
  for (const item of [...retained, ...incoming]) {
    const normalized = key(item);
    const current = byKey.get(normalized);
    if (!current || item.confidence > current.confidence) {
      byKey.set(normalized, item);
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);
}

function retainItems<T extends { evidence: MemoryEvidence[] }>(
  items: T[],
  fullExtraction: boolean,
  currentHashes: ReadonlySet<string>,
): T[] {
  return fullExtraction
    ? []
    : items.filter((item) => item.evidence.some((evidence) => currentHashes.has(evidence.hash)));
}

function autoFields(
  type: 'glossary' | 'style' | 'setting',
  value: string,
  item: { evidence_hashes?: string[]; confidence: number },
  evidenceByHash: ReadonlyMap<string, MemoryEvidence>,
) {
  return {
    id: stableItemId(type, value),
    evidence: evidenceFor(item.evidence_hashes, evidenceByHash),
    confidence: clamp(item.confidence),
  };
}

function evidenceFor(hashes: string[] | undefined, source: ReadonlyMap<string, MemoryEvidence>): MemoryEvidence[] {
  return [...new Set(hashes ?? [])].map((hash) => source.get(hash)).filter((item): item is MemoryEvidence => Boolean(item)).slice(0, 3);
}

function stableItemId(type: string, value: string): string {
  return createHash('sha256').update(`${type}:${normalize(value)}`).digest('hex').slice(0, 32);
}

function memoryKeyFor(type: string, value: string): string {
  return `${type}:${normalize(value)}`;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

function clean(value: unknown, max: number): string {
  return String(value ?? '').trim().replace(/\s+/gu, ' ').slice(0, max);
}

function uniqueStrings(values: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => clean(value, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function validConfidence(value: number, minimum: number): boolean {
  return Number.isFinite(Number(value)) && Number(value) >= minimum;
}
