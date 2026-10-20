import { describe, expect, test } from '@jest/globals';
import { DocumentCatalog } from '../src/database/document-catalog.js';
import { AiWriterService, NO_EVIDENCE_MESSAGE } from '../src/ai/ai-writer.service.js';
import { jest } from '@jest/globals';

describe('RAG basic access and version boundaries', () => {
  const owner = { user_id: 'alice', space_id: 's', team_ids: ['alpha'] };
  const hit = (version = 1) => ({ pointId: String(version), score: 1, payload: { doc_id: 'd', document_version: version, is_active: true } });
  function setup(visibility = 'private') {
    const catalog = new DocumentCatalog({ metadataEnabled: false } as any);
    const doc: any = { doc_id: 'd', owner_id: 'alice', space_id: 's', visibility, team_id: 'alpha', document_version: 1, active_index_version: 1 };
    catalog.records.set('d', doc); return { catalog, doc };
  }
  test('private, team, cross-space and former-member reads use current access', async () => {
    const { catalog, doc } = setup();
    expect(await catalog.readableHits([hit()], owner)).toHaveLength(1);
    expect(await catalog.readableHits([hit()], { ...owner, user_id: 'bob' })).toHaveLength(0);
    doc.visibility = 'team';
    expect(await catalog.readableHits([hit()], { ...owner, user_id: 'bob' })).toHaveLength(1);
    expect(await catalog.readableHits([hit()], { ...owner, user_id: 'bob', team_ids: [] })).toHaveLength(0);
    expect(await catalog.readableHits([hit()], { ...owner, space_id: 'other' })).toHaveLength(0);
    doc.visibility = 'public';
    expect(await catalog.readableHits([hit()], { user_id: 'other', space_id: 'other', team_ids: [] })).toHaveLength(1);
  });
  test('old active index remains valid while a new version builds; stale hits disappear after activation', async () => {
    const { catalog, doc } = setup(); doc.document_version = 2;
    expect((await catalog.readableHits([hit(1), hit(2)], owner)).map(h => h.payload.document_version)).toEqual([1]);
    doc.active_index_version = 2;
    expect((await catalog.readableHits([hit(1), hit(2)], owner)).map(h => h.payload.document_version)).toEqual([2]);
    doc.deleted_at = new Date();
    expect(await catalog.readableHits([hit(1), hit(2)], owner)).toHaveLength(0);
    doc.deleted_at = null; doc.document_version = 3; doc.active_index_version = 3;
    expect((await catalog.readableHits([hit(1), hit(2), hit(3)], owner)).map(h => h.payload.document_version)).toEqual([3]);
  });
  test('zero authorized evidence refuses without calling generation and captures an empty actual candidate pool', async () => {
    const debug = { schema_version: 1, candidate_stage: 'authorized_fused_before_rerank', candidate_limit: 20, candidates: [], ranked: [] };
    const complete = jest.fn(async () => 'must not be called');
    const writer = new AiWriterService({ searchWithTrace: async () => ({ citations: [], trace: { trace_id: 'empty' }, retrieval_debug: debug }) } as any,
      { recentText: async () => '' } as any, { complete } as any, {} as any,
      { select: async () => ({ name: 'search_knowledge_base', arguments: { query: 'missing', retrieval_domain: 'public' } }), intentFor: () => 'knowledge_qa' } as any,
      { recordCompletion: async () => undefined } as any, {} as any, { promptText: async () => '' } as any);
    const result = await writer.complete({ query: 'missing', include_evidence: true, scope: { document_ids: [] },
      current_context: { title: '', tags: [], cursor_before: '', cursor_after: '', selected_text: '' } } as any, owner);
    expect(result.answer).toBe(NO_EVIDENCE_MESSAGE);
    expect(complete).not.toHaveBeenCalled();
    expect(result.evidence_snapshot?.model_called).toBe(false);
    expect(result.evidence_snapshot?.retrieval_debug?.candidates).toEqual([]);
  });
});
