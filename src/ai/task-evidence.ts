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

/** Keep server-owned source handles and paging metadata outside the model-written summary. */
export function toolCompaction(raw: unknown, value: unknown, available: TaskEvidence[]): ToolCompaction {
  const result = value as { summary?: unknown; missing?: unknown; conflicts?: unknown } | null;
  const strings = (items: unknown) => Array.isArray(items) && items.length <= 20 &&
    items.every((item) => typeof item === 'string' && item.length <= 2000);
  if (!result || typeof result.summary !== 'string' || !result.summary.trim() ||
    !strings(result.missing) || !strings(result.conflicts)) throw new Error('资料压缩结构无效，请缩小范围');
  const ids = new Set<string>();
  const missing = new Set(result.missing as string[]);
  const conflicts = new Set(result.conflicts as string[]);
  const navigation: Record<string, unknown>[] = [];
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

/** Select previews under a token budget; full adopted evidence stays available by its stable handle. */
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
