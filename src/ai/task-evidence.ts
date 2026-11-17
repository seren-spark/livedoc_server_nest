/**
 * @file 任务证据上下文。筛选当前任务需要的证据并压缩工具历史，保留来源与缺口。
 */
import type { AgentCitation } from './document-agent.types.js';
import { tokenizeKeyword } from '../retrieval/text-utils.js';

export interface TaskEvidence {
  citation: AgentCitation;
  content: string;
}

export interface TaskEvidenceReference {
  citation_id: string;
  title: string;
  version?: number;
  snapshot_hash?: string;
  start_offset?: number;
  end_offset?: number;
  read_tool: 'read_task_evidence';
}

export interface ToolCompaction {
  compacted: true;
  summary: string;
  evidence_references: TaskEvidenceReference[];
  navigation: Record<string, unknown>[];
  missing: string[];
  conflicts: string[];
}

export type TaskContextEvent =
  | { kind: 'compaction'; source: 'tool' | 'dependencies'; before_tokens: number; after_tokens: number;
      citation_ids: string[]; descriptor: ToolCompaction }
  | { kind: 'retrieval'; citation_id: string; offset: number; next_offset: number | null; returned_tokens: number };

/**
 * 递归提取工具或候选数据中的证据引用。
 *
 * @param evidence 本次可用的引用标识与原文证据。
 * @returns 整理后的结果列表。
 */
export function evidenceReferences(evidence: TaskEvidence[]): TaskEvidenceReference[] {
  return evidence.map(({ citation }) => ({ citation_id: citation.id, title: citation.title,
    ...(citation.version === undefined ? {} : { version: citation.version }),
    ...(citation.snapshot_hash ? { snapshot_hash: citation.snapshot_hash } : {}),
    ...(citation.start_offset === undefined ? {} : { start_offset: citation.start_offset }),
    ...(citation.end_offset === undefined ? {} : { end_offset: citation.end_offset }),
    read_tool: 'read_task_evidence' }));
}

const NAVIGATION_FIELDS = new Set([
  'offset', 'total_length', 'next_offset', 'region_id', 'read_region_ids', 'unread_region_ids', 'unread_count',
  'partial', 'content_offset', 'next_content_offset', 'total_content_length', 'doc_id', 'wiki_id', 'knowledge_layer',
]);

/**
 * 压缩工具结果时保留由服务端维护的来源句柄与分页信息。
 *
 *  Keep server-owned source handles and paging metadata outside the model-written summary.
 *
 * @param raw 尚未规范化或压缩的原始数据。
 * @param value 待校验或转换的值。
 * @param available 本次仍可使用的候选或额度。
 * @returns ToolCompaction 类型的处理结果。
 */
export function toolCompaction(raw: unknown, value: unknown, available: TaskEvidence[]): ToolCompaction {
  const result = value as { summary?: unknown; missing?: unknown; conflicts?: unknown } | null;
  /**
   * 从未知输入中过滤出有效字符串数组。
   *
   * @param items 需要处理的条目集合。
   * @returns 条件是否满足的判断结果。
   */
  const strings = (items: unknown) => Array.isArray(items) && items.length <= 20 &&
    items.every((item) => typeof item === 'string' && item.length <= 2000);
  if (!result || typeof result.summary !== 'string' || !result.summary.trim() ||
    !strings(result.missing) || !strings(result.conflicts)) throw new Error('资料压缩结构无效，请缩小范围');
  const ids = new Set<string>();
  const missing = new Set(result.missing as string[]);
  const conflicts = new Set(result.conflicts as string[]);
  const navigation: Record<string, unknown>[] = [];
  /**
   * 递归收集任务数据中的证据、缺口和冲突信息。
   *
   * @param node 当前语法树或编辑器节点。
   */
  const visit = (node: unknown) => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.missing)) record.missing.forEach((item) => { if (typeof item === 'string') missing.add(item); });
    if (Array.isArray(record.conflicts)) record.conflicts.forEach((item) => {
      if (typeof item === 'string') conflicts.add(item);
      else if (item && typeof item === 'object' && typeof item.description === 'string') conflicts.add(item.description);
    });
    if (typeof record.citation_id === 'string') ids.add(record.citation_id);
    if (Array.isArray(record.citation_ids)) record.citation_ids.forEach((id) => { if (typeof id === 'string') ids.add(id); });
    const page = Object.fromEntries(Object.entries(record).filter(([key]) => NAVIGATION_FIELDS.has(key)));
    if (Object.keys(page).length) navigation.push(page);
    for (const [key, child] of Object.entries(record))
      if (!['content', 'markdown', 'text', 'original_json', 'source_content'].includes(key)) visit(child);
  };
  visit(raw);
  return { compacted: true, summary: result.summary.trim(),
    evidence_references: evidenceReferences(available.filter((item) => ids.has(item.citation.id))),
    navigation, missing: [...missing], conflicts: [...conflicts] };
}

/**
 * 在 Token 预算内选择证据预览，完整证据仍可通过稳定来源标识读取。
 *
 *  Select previews under a token budget; full adopted evidence stays available by its stable handle.
 *
 * @param evidence 本次可用的引用标识与原文证据。
 * @param goal 筛选资料或生成结果时需要满足的任务目标。
 * @param budget 本次处理允许使用的 Token 或调用预算。
 * @param perSourceBudget 分配给单个来源的上下文 Token 上限。
 * @param extract 从原文提取相关片段的回调。
 * @param count 需要读取或处理的数量。
 * @returns 整理后的结果列表。
 */
export function selectTaskEvidence(
  evidence: TaskEvidence[], goal: string, budget: number, perSourceBudget: number,
  extract: (content: string, goal: string, budget: number) => string,
  count: (content: string) => number,
): TaskEvidence[] {
  const terms = new Set(tokenizeKeyword(goal));
  const ranked = evidence.map((item, index) => {
    const body = new Set(tokenizeKeyword(`${item.citation.title}\n${item.content.slice(0, 12000)}`));
    return { item, index, score: [...terms].filter((term) => body.has(term)).length };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const selected: Array<{ item: TaskEvidence; index: number }> = [];
  let remaining = Math.max(0, budget);
  for (const { item, index } of ranked) {
    if (remaining <= 0) break;
    const content = extract(item.content, goal, Math.min(perSourceBudget, remaining));
    if (!content) continue;
    const tokens = count(content);
    if (tokens > remaining) throw new Error('证据预览超过分配预算');
    remaining -= tokens;
    selected.push({ item: { citation: item.citation, content }, index });
  }
  return selected.sort((a, b) => a.index - b.index).map(({ item }) => item);
}
