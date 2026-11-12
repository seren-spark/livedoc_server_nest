import { describe, expect, jest, test } from '@jest/globals';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AgentGraphService } from '../src/ai/graph/agent-graph.service.js';
const alice = { user_id: 'alice', space_id: 'space', team_ids: [] };
function harness() {
  const artifacts = new Map<string, any>([
    ['brief', { goal: '研究' }],
    ['coverage', { candidate_version: 1, items: [], source_keys: ['source'] }],
    ['notes', { notes: [{ question_id: 'q1', findings: [] }, { question_id: 'q2', findings: [] }, { question_id: 'q1', findings: [] }], source_keys: ['source'] }],
    ['source', { citations: [{ id: 'doc', kind: 'document', doc_id: 'doc', version: 1 }], wiki_reads: [] }],
  ]);
  const repository = { get: jest.fn<any>(async (_id: string, context: typeof alice) => {
    if (context.user_id !== 'alice') throw new NotFoundException('任务不存在');
    return { payload: { research_brief_key: 'brief', research_coverage_key: 'coverage', research_notes_key: 'notes' } };
  }), artifact: jest.fn<any>(async (_id: string, key: string) => artifacts.get(key)) };
  const document = { validateGraphSources: jest.fn<any>().mockResolvedValue(undefined) };
  const service = new AgentGraphService(repository as any, {} as any, document as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  jest.spyOn(service, 'authorizeProgress').mockResolvedValue(undefined);
  return { service, repository, document, artifacts };
}
describe('research artifact access', () => {
  test('pages notes by question and verifies the exact stored source references once', async () => {
    const h = harness();
    const result = await h.service.research('run', alice, 'q1', 0, 1);
    expect(result).toMatchObject({ total: 2, next_offset: 1, notes: [{ question_id: 'q1' }] });
    expect(result.coverage).not.toHaveProperty('source_keys');
    expect(h.document.validateGraphSources).toHaveBeenCalledTimes(1);
    expect(h.document.validateGraphSources).toHaveBeenCalledWith(h.artifacts.get('source').citations, [], alice);
  });
  test('revoking a cached source also blocks notes from steps no longer present in active progress', async () => {
    const h = harness();
    h.document.validateGraphSources.mockRejectedValue(new ForbiddenException('资料权限已撤回'));
    await expect(h.service.research('run', alice, undefined, 0, 10)).rejects.toThrow(ForbiddenException);
    expect(h.document.validateGraphSources).toHaveBeenCalledTimes(1);
  });
  test('rejects another owner, invalid pages and cached content without source provenance', async () => {
    const h = harness();
    await expect(h.service.research('run', { ...alice, user_id: 'bob' }, undefined, 0, 10)).rejects.toThrow(NotFoundException);
    await expect(h.service.research('run', alice, undefined, -1, 10)).rejects.toThrow('分页参数');
    h.artifacts.set('notes', [{ question_id: 'q1', findings: [] }]);
    await expect(h.service.research('run', alice, undefined, 0, 10)).rejects.toThrow('来源校验信息');
  });
});
