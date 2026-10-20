import { createHash } from 'node:crypto';
import type { Citation, RetrievalDebug } from '../common/types.js';

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

// Shared by the prompt and the evaluation response, so diagnostics use the actual input.
export function promptEvidence(citations: Citation[]) {
  return citations.map(({ index, citation_id, title, heading_path, document_version, content }) =>
    ({ index, citation_id, title, heading_path, document_version, content }));
}

export function retrievalEvidence(retrieval: RetrievalDebug) {
  const sources = (hits: Citation[]) => hits.map(c => ({ doc_id: c.doc_id, chunk_id: c.chunk_id,
    document_version: c.document_version, content: c.content, source_content: c.source_content ?? null }));
  return { schema_version: retrieval.schema_version, candidate_stage: retrieval.candidate_stage, candidate_limit: retrieval.candidate_limit,
    candidates: sources(retrieval.candidates), ranked: sources(retrieval.ranked) };
}

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
