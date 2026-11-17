/**
 * @file 文档长期记忆。合并和筛选有证据支持的文档记忆，生成写作上下文。
 */
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

  /**
   * 初始化实例依赖与本地状态。
   *
   * @param config 应用运行配置。
   * @param database 共享数据库服务。
   */
  constructor(
    private readonly config: AppConfig,
    private readonly database: DatabaseService,
  ) {
    this.repository = new DocumentMemoryRepository(database);
    this.tokenizer = getEncoding(
      this.config.tokenizerEncoding as Parameters<typeof getEncoding>[0],
    );
  }

  /**
   * 按标识读取文档记忆。
   *
   * @param docId 知识文档标识。
   * @returns 文档记忆档案；未找到或不可用时可能为空。
   */
  async get(docId: string): Promise<DocumentMemoryProfile | null> {
    if (!this.database.memoryEnabled) return this.profiles.get(docId) ?? null;
    return this.repository.findByDocumentId(docId);
  }

  /**
   * 将当前记录标记为等待后台处理。
   *
   * @param document 当前知识文档记录。
   * @returns 文档记忆档案。
   */
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
   *
   * @param docId 知识文档标识。
   */
  async markExtracting(docId: string): Promise<void> {
    await this.patchStatus(docId, 'extracting', null);
  }

  /**
   * 保存后台处理失败状态及错误原因。
   *
   * @param docId 知识文档标识。
   * @param error 本次操作捕获的异常。
   */
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
   *
   * @param options 当前知识文档记录。
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
    /**
     * 只保留置信度 ≥ 配置阈值的项
     *
     * @param item 本次正在处理的条目。
     * @returns 条件是否满足的判断结果。
     */
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

  /**
   * 把有效记忆整理为写作提示词中的上下文。
   *
   * @param docId 知识文档标识。
   * @param documentVersion documentVersion 参数（number | undefined）。
   * @param query 用户问题或检索查询。
   * @returns 整理后的文本或标识。
   */
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

  /**
   * 删除指定文档对应的数据及关联记录。
   *
   * @param docId 知识文档标识。
   */
  async deleteDocument(docId: string): Promise<void> {
    if (this.database.memoryEnabled) {
      await this.repository.delete(docId);
    } else this.profiles.delete(docId);
  }

  /**
   * 仅更新记忆档案的状态及相关版本信息。
   *
   * @param docId 知识文档标识。
   * @param status 本次需要记录或切换到的状态。
   * @param lastError 最近一次执行失败的异常。
   */
  private async patchStatus(
    docId: string,
    status: DocumentMemoryProfile['status'],
    lastError: string | null,
  ): Promise<void> {
    const current = await this.get(docId);
    if (!current) return;
    await this.persist({ ...current, status, last_error: lastError, updated_at: new Date() });
  }

  /**
   * 将当前记忆档案写入启用的存储路径。
   *
   * @param profile 模型配置或文档记忆档案。
   */
  private async persist(profile: DocumentMemoryProfile): Promise<void> {
    if (!this.database.memoryEnabled) {
      this.profiles.set(profile.doc_id, profile);
      return;
    }
    await this.repository.save(profile);
  }
}

/**
 * 创建尚未提取记忆时的初始文档档案。
 *
 * @param document 当前知识文档记录。
 * @param status 本次需要记录或切换到的状态。
 * @returns 文档记忆档案。
 */
function emptyProfile(document: DocumentRecord, status: DocumentMemoryProfile['status']): DocumentMemoryProfile {
  const now = new Date();
  return {
    doc_id: document.doc_id, space_id: document.space_id, source_document_version: 0,
    status, glossary: [], style_tags: [], global_settings: [],
    source_chunk_hashes: [], last_error: null, created_at: now, updated_at: now,
  };
}

/**
 * 合并已有记忆与新提取项，保留有效来源和稳定标识。
 *
 * @param retained 筛选后需要保留的条目。
 * @param incoming incoming 参数（T[]）。
 * @param key 查询或存储使用的键。
 * @param limit 本次读取或处理的数量上限。
 * @returns 整理后的结果列表。
 */
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

/**
 * 筛选仍有原文依据且满足数量限制的记忆项。
 *
 * @param items 需要处理的条目集合。
 * @param fullExtraction 是否执行完整信息提取。
 * @param currentHashes 当前内容各区域的摘要。
 * @returns 整理后的结果列表。
 */
function retainItems<T extends { evidence: MemoryEvidence[] }>(
  items: T[],
  fullExtraction: boolean,
  currentHashes: ReadonlySet<string>,
): T[] {
  return fullExtraction
    ? []
    : items.filter((item) => item.evidence.some((evidence) => currentHashes.has(evidence.hash)));
}

/**
 * 从自动记忆项整理术语、风格及全局设定字段。
 *
 * @param type 当前数据或节点类型。
 * @param value 待校验或转换的值。
 * @param item 本次正在处理的条目。
 * @param evidenceByHash 按内容摘要索引的原文证据。
 * @returns 整理后的状态与操作结果对象。
 */
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

/**
 * 为记忆项查找能够支持其内容的原文证据。
 *
 * @param hashes 用于匹配和去重的内容摘要集合。
 * @param source 当前来源内容或来源记录。
 * @returns 整理后的结果列表。
 */
function evidenceFor(hashes: string[] | undefined, source: ReadonlyMap<string, MemoryEvidence>): MemoryEvidence[] {
  return [...new Set(hashes ?? [])].map((hash) => source.get(hash)).filter((item): item is MemoryEvidence => Boolean(item)).slice(0, 3);
}

/**
 * 根据记忆内容生成可跨次提取复用的稳定标识。
 *
 * @param type 当前数据或节点类型。
 * @param value 待校验或转换的值。
 * @returns 整理后的文本或标识。
 */
function stableItemId(type: string, value: string): string {
  return createHash('sha256').update(`${type}:${normalize(value)}`).digest('hex').slice(0, 32);
}

/**
 * 组合记忆类型与规范化内容，生成记忆项的去重键。
 *
 * @param type 当前数据或节点类型。
 * @param value 待校验或转换的值。
 * @returns 整理后的文本或标识。
 */
function memoryKeyFor(type: string, value: string): string {
  return `${type}:${normalize(value)}`;
}

/**
 * 将输入转换为比较和去重使用的规范形式。
 *
 * @param value 待校验或转换的值。
 * @returns 整理后的文本或标识。
 */
function normalize(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

/**
 * 清理记忆文本中的空白或无效内容。
 *
 * @param value 待校验或转换的值。
 * @param max max 对应的数量或范围限制。
 * @returns 整理后的文本或标识。
 */
function clean(value: unknown, max: number): string {
  return String(value ?? '').trim().replace(/\s+/gu, ' ').slice(0, max);
}

/**
 * 清理字符串并去重，保留有效内容。
 *
 * @param values 待转换或去重的值集合。
 * @param maxItems maxItems 对应的数量或范围限制。
 * @param maxLength maxLength 对应的数量或范围限制。
 * @returns 整理后的字符串列表。
 */
function uniqueStrings(values: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => clean(value, maxLength)).filter(Boolean))].slice(0, maxItems);
}

/**
 * 将数值限制到给定边界内。
 *
 * @param value 待校验或转换的值。
 * @returns 计算得到的数值。
 */
function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

/**
 * 验证置信度是否为允许范围内的有效数值。
 *
 * @param value 待校验或转换的值。
 * @param minimum minimum 对应的数量或范围限制。
 * @returns 条件是否满足的判断结果。
 */
function validConfidence(value: number, minimum: number): boolean {
  return Number.isFinite(Number(value)) && Number(value) >= minimum;
}
