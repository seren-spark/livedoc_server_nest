import { ConflictException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { getEncoding, type Tiktoken } from 'js-tiktoken';
import type { DocumentMemoryUpdateDto } from '../common/dto.js';
import { AppConfig } from '../config/app-config.js';
import { DatabaseService } from '../database/database.service.js';
import type { DocumentRecord } from './document.types.js';
import type {
  DocumentMemoryProfile,
  ExtractedDocumentMemory,
  GlobalSettingMemoryItem,
  GlossaryMemoryItem,
  MemoryEvidence,
  StyleMemoryItem,
} from './document-memory.types.js';

const LIMITS = { glossary: 30, style_tags: 8, global_settings: 20 } as const;

@Injectable()
export class DocumentMemoryService {
  private readonly profiles = new Map<string, DocumentMemoryProfile>();
  private readonly tokenizer: Tiktoken;

  constructor(
    private readonly config: AppConfig,
    private readonly database: DatabaseService,
  ) {
    this.tokenizer = getEncoding(
      this.config.tokenizerEncoding as Parameters<typeof getEncoding>[0],
    );
  }

  async get(docId: string): Promise<DocumentMemoryProfile | null> {
    if (!this.database.memoryEnabled) return this.profiles.get(docId) ?? null;
    const rows = await this.database.query<Record<string, unknown>>(
      'SELECT * FROM document_memory_profiles WHERE doc_id=?',
      [docId],
    );
    return rows[0] ? mapProfile(rows[0]) : null;
  }

  async markPending(document: DocumentRecord): Promise<DocumentMemoryProfile> {
    const current = await this.get(document.doc_id);
    const profile = current
      ? { ...current, status: 'pending' as const, last_error: null, updated_at: new Date() }
      : emptyProfile(document, 'pending');
    await this.persist(profile);
    return profile;
  }

  async markExtracting(docId: string): Promise<void> {
    await this.patchStatus(docId, 'extracting', null);
  }

  async markFailed(docId: string, error: string): Promise<void> {
    await this.patchStatus(docId, 'failed', error.slice(0, 2000));
  }

  async applyExtraction(options: {
    document: DocumentRecord;
    extracted: ExtractedDocumentMemory;
    evidenceByHash: Map<string, MemoryEvidence>;
    currentHashes: string[];
    fullExtraction: boolean;
  }): Promise<DocumentMemoryProfile> {
    const previous = (await this.get(options.document.doc_id)) ?? emptyProfile(options.document, 'extracting');
    const currentHashSet = new Set(options.currentHashes);
    const suppressed = new Set(previous.suppressed_keys);
    const pinnedGlossary = previous.glossary.filter((item) => item.pinned);
    const pinnedStyles = previous.style_tags.filter((item) => item.pinned);
    const pinnedSettings = previous.global_settings.filter((item) => item.pinned);
    const retainedGlossary = options.fullExtraction
      ? pinnedGlossary
      : previous.glossary.filter((item) => item.pinned || item.evidence.some((e) => currentHashSet.has(e.hash)));
    const retainedStyles = options.fullExtraction
      ? pinnedStyles
      : previous.style_tags.filter((item) => item.pinned || item.evidence.some((e) => currentHashSet.has(e.hash)));
    const retainedSettings = options.fullExtraction
      ? pinnedSettings
      : previous.global_settings.filter((item) => item.pinned || item.evidence.some((e) => currentHashSet.has(e.hash)));

    const autoGlossary = options.extracted.glossary
      .filter((item) => validConfidence(item.confidence, this.config.documentMemoryMinConfidence))
      .map((item): GlossaryMemoryItem => ({
        id: stableItemId('glossary', item.term),
        term: clean(item.term, 160),
        definition: clean(item.definition, 1000),
        aliases: uniqueStrings(item.aliases ?? [], 10, 160),
        evidence: evidenceFor(item.evidence_hashes, options.evidenceByHash),
        confidence: clamp(item.confidence),
        origin: 'auto',
        pinned: false,
      }))
      .filter((item) => item.term && item.definition && !suppressed.has(memoryKeyFor('glossary', item.term)));
    const autoStyles = options.extracted.style_tags
      .filter((item) => validConfidence(item.confidence, this.config.documentMemoryMinConfidence))
      .map((item): StyleMemoryItem => ({
        id: stableItemId('style', item.label),
        label: clean(item.label, 120),
        instruction: clean(item.instruction, 1000),
        evidence: evidenceFor(item.evidence_hashes, options.evidenceByHash),
        confidence: clamp(item.confidence),
        origin: 'auto',
        pinned: false,
      }))
      .filter((item) => item.label && item.instruction && !suppressed.has(memoryKeyFor('style', item.label)));
    const autoSettings = options.extracted.global_settings
      .filter((item) => validConfidence(item.confidence, this.config.documentMemoryMinConfidence))
      .map((item): GlobalSettingMemoryItem => ({
        id: stableItemId('setting', item.key),
        key: clean(item.key, 160),
        value: clean(item.value, 1200),
        evidence: evidenceFor(item.evidence_hashes, options.evidenceByHash),
        confidence: clamp(item.confidence),
        origin: 'auto',
        pinned: false,
      }))
      .filter((item) => item.key && item.value && !suppressed.has(memoryKeyFor('setting', item.key)));

    const next: DocumentMemoryProfile = {
      ...previous,
      source_document_version: options.document.document_version,
      memory_version: previous.memory_version + 1,
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

  async updateByUser(
    document: DocumentRecord,
    input: DocumentMemoryUpdateDto,
  ): Promise<DocumentMemoryProfile> {
    const current = (await this.get(document.doc_id)) ?? emptyProfile(document, 'ready');
    if (current.memory_version !== input.expected_memory_version) {
      throw new ConflictException({
        message: 'Document memory version conflict',
        current_memory_version: current.memory_version,
      });
    }
    const previousKeys = new Set([
      ...current.glossary.map((item) => memoryKeyFor('glossary', item.term)),
      ...current.style_tags.map((item) => memoryKeyFor('style', item.label)),
      ...current.global_settings.map((item) => memoryKeyFor('setting', item.key)),
    ]);
    const glossary = input.glossary.map((item): GlossaryMemoryItem => {
      const previous = item.id ? current.glossary.find((candidate) => candidate.id === item.id) : undefined;
      const term = clean(item.term, 160);
      const definition = clean(item.definition, 1000);
      const aliases = uniqueStrings(item.aliases, 10, 160);
      if (previous && previous.term === term && previous.definition === definition &&
        sameStrings(previous.aliases, aliases)) return previous;
      return {
        id: item.id || randomUUID().replaceAll('-', ''), term, definition, aliases,
        evidence: previous?.evidence ?? [], confidence: 1, origin: 'user', pinned: true,
      };
    });
    const styleTags = input.style_tags.map((item): StyleMemoryItem => {
      const previous = item.id ? current.style_tags.find((candidate) => candidate.id === item.id) : undefined;
      const label = clean(item.label, 120);
      const instruction = clean(item.instruction, 1000);
      if (previous && previous.label === label && previous.instruction === instruction) return previous;
      return {
        id: item.id || randomUUID().replaceAll('-', ''), label, instruction,
        evidence: previous?.evidence ?? [], confidence: 1, origin: 'user', pinned: true,
      };
    });
    const globalSettings = input.global_settings.map((item): GlobalSettingMemoryItem => {
      const previous = item.id ? current.global_settings.find((candidate) => candidate.id === item.id) : undefined;
      const key = clean(item.key, 160);
      const value = clean(item.value, 1200);
      if (previous && previous.key === key && previous.value === value) return previous;
      return {
        id: item.id || randomUUID().replaceAll('-', ''), key, value,
        evidence: previous?.evidence ?? [], confidence: 1, origin: 'user', pinned: true,
      };
    });
    const nextKeys = new Set([
      ...glossary.map((item) => memoryKeyFor('glossary', item.term)),
      ...styleTags.map((item) => memoryKeyFor('style', item.label)),
      ...globalSettings.map((item) => memoryKeyFor('setting', item.key)),
    ]);
    const suppressed = new Set(current.suppressed_keys);
    for (const key of previousKeys) if (!nextKeys.has(key)) suppressed.add(key);
    for (const key of nextKeys) suppressed.delete(key);
    const next: DocumentMemoryProfile = {
      ...current,
      memory_version: current.memory_version + 1,
      status: 'ready',
      glossary,
      style_tags: styleTags,
      global_settings: globalSettings,
      suppressed_keys: [...suppressed],
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
      return bMatch - aMatch || Number(b.pinned) - Number(a.pinned) || b.confidence - a.confidence;
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
      await this.database.query('DELETE FROM document_memory_profiles WHERE doc_id=?', [docId]);
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
    await this.database.query(
      `INSERT INTO document_memory_profiles
        (doc_id,space_id,source_document_version,memory_version,status,glossary,
         style_tags,global_settings,suppressed_keys,source_chunk_hashes,last_error,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
        source_document_version=VALUES(source_document_version),
        memory_version=VALUES(memory_version),status=VALUES(status),glossary=VALUES(glossary),
        style_tags=VALUES(style_tags),global_settings=VALUES(global_settings),
        suppressed_keys=VALUES(suppressed_keys),source_chunk_hashes=VALUES(source_chunk_hashes),
        last_error=VALUES(last_error),updated_at=VALUES(updated_at)`,
      [profile.doc_id, profile.space_id, profile.source_document_version, profile.memory_version,
        profile.status, JSON.stringify(profile.glossary), JSON.stringify(profile.style_tags),
        JSON.stringify(profile.global_settings), JSON.stringify(profile.suppressed_keys),
        JSON.stringify(profile.source_chunk_hashes), profile.last_error, profile.created_at, profile.updated_at],
    );
  }
}

function emptyProfile(document: DocumentRecord, status: DocumentMemoryProfile['status']): DocumentMemoryProfile {
  const now = new Date();
  return {
    doc_id: document.doc_id, space_id: document.space_id, source_document_version: 0,
    memory_version: 0, status, glossary: [], style_tags: [], global_settings: [],
    suppressed_keys: [], source_chunk_hashes: [], last_error: null, created_at: now, updated_at: now,
  };
}

function mergeItems<T extends { pinned: boolean; confidence: number }>(
  retained: T[], incoming: T[], key: (item: T) => string, limit: number,
): T[] {
  const byKey = new Map<string, T>();
  for (const item of [...retained, ...incoming]) {
    const normalized = key(item);
    const current = byKey.get(normalized);
    if (!current || (!current.pinned && item.pinned) || (current.pinned === item.pinned && item.confidence > current.confidence)) {
      byKey.set(normalized, item);
    }
  }
  return [...byKey.values()]
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.confidence - a.confidence)
    .slice(0, limit);
}

function evidenceFor(hashes: string[] | undefined, source: Map<string, MemoryEvidence>): MemoryEvidence[] {
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

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function mapProfile(row: Record<string, unknown>): DocumentMemoryProfile {
  return {
    doc_id: String(row.doc_id), space_id: String(row.space_id),
    source_document_version: Number(row.source_document_version), memory_version: Number(row.memory_version),
    status: row.status as DocumentMemoryProfile['status'],
    glossary: parseArray<GlossaryMemoryItem>(row.glossary),
    style_tags: parseArray<StyleMemoryItem>(row.style_tags),
    global_settings: parseArray<GlobalSettingMemoryItem>(row.global_settings),
    suppressed_keys: parseArray<string>(row.suppressed_keys),
    source_chunk_hashes: parseArray<string>(row.source_chunk_hashes),
    last_error: row.last_error == null ? null : String(row.last_error),
    created_at: new Date(row.created_at as string | Date), updated_at: new Date(row.updated_at as string | Date),
  };
}
