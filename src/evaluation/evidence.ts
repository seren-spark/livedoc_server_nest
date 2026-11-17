/**
 * @file 评测证据快照。记录检索来源及内容摘要，使评测结果能够追溯到实际证据。
 */
import { createHash } from 'node:crypto';
import type { Citation, RetrievalDebug } from '../common/types.js';

/**
 * 计算内容的 SHA-256 摘要。
 *
 * @param text 待处理的文本。
 * @returns 整理后的文本或标识。
 */
export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

// Shared by the prompt and the evaluation response, so diagnostics use the actual input.
/**
 * 整理提示词实际使用的证据字段，使评测诊断与真实输入一致。
 *
 * @param citations 包含来源、原文位置与内容的检索引用。
 * @returns 整理后的结果列表。
 */
export function promptEvidence(citations: Citation[]) {
  return citations.map(({ index, citation_id, title, heading_path, document_version, content }) =>
    ({ index, citation_id, title, heading_path, document_version, content }));
}

/**
 * 从检索结果整理可复现的证据记录。
 *
 * @param retrieval 共享知识检索服务。
 * @returns 整理后的状态与操作结果对象；未找到或不可用时可能为空。
 */
export function retrievalEvidence(retrieval: RetrievalDebug) {
  /**
   * 收集评测输出实际使用的来源。
   *
   * @param hits 包含来源、原文位置与内容的检索引用。
   * @returns 整理后的结果列表；未找到或不可用时可能为空。
   */
  const sources = (hits: Citation[]) => hits.map(c => ({ doc_id: c.doc_id, chunk_id: c.chunk_id,
    document_version: c.document_version, content: c.content, source_content: c.source_content ?? null }));
  return { schema_version: retrieval.schema_version, candidate_stage: retrieval.candidate_stage, candidate_limit: retrieval.candidate_limit,
    ...(retrieval.selection_strategy ? { selection_strategy: retrieval.selection_strategy } : {}),
    candidates: sources(retrieval.candidates), ranked: sources(retrieval.ranked) };
}

/**
 * 保存来源内容及摘要，形成评测证据快照。
 *
 * @param traceId 检索追踪标识。
 * @param prompt 发送给模型的提示词。
 * @param citations 包含来源、原文位置与内容的检索引用。
 * @param modelCalled 当前阶段是否已经发起模型调用。
 * @param retrieval 共享知识检索服务（可选）。
 * @returns 整理后的状态与操作结果对象；未找到或不可用时可能为空。
 */
export function evidenceSnapshot(traceId: string, prompt: string, citations: Citation[], modelCalled: boolean, retrieval?: RetrievalDebug) {
  const evidence = promptEvidence(citations);
  return {
    schema_version: 1, trace_id: traceId, model_called: modelCalled,
    prompt_sha256: modelCalled ? sha256(prompt) : null,
    evidence_sha256: sha256(JSON.stringify(evidence)),
    citations: evidence.map((item, index) => ({ ...item, doc_id: citations[index]!.doc_id, chunk_id: citations[index]!.chunk_id })),
    ...(retrieval ? { retrieval_debug: retrieval, retrieval_debug_sha256: sha256(JSON.stringify(retrievalEvidence(retrieval))) } : {}),
  };
}
