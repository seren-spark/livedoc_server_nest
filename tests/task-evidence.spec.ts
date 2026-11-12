import { describe, expect, test } from '@jest/globals';
import { evidenceReferences, selectTaskEvidence, toolCompaction, type TaskEvidence } from '../src/ai/task-evidence.js';

const source: TaskEvidence = { citation: { id: 'read-a', title: '回滚资料', kind: 'document', doc_id: 'doc', version: 3,
  start_offset: 40, end_offset: 80 }, content: '回滚窗口为48小时。\n\n```ts\nconst windowHours = 48;\n```' };

describe('recoverable task evidence context', () => {
  test('keeps stable server source handles and paging outside the model summary', () => {
    const value = toolCompaction({ citation_id: 'read-a', content: source.content, offset: 40, next_offset: 80,
      missing: ['负责人未确认'], conflicts: [{ description: '日期冲突', evidence_ids: ['read-a'] }],
      sources: [{ citation_id: 'unknown', content: 'untrusted' }] },
    { summary: '回滚48小时，代码需回取原文。', missing: ['预算未记录'], conflicts: ['两个资料时间不同'] }, [source]);
    expect(value.evidence_references).toEqual(evidenceReferences([source]));
    expect(value.navigation).toContainEqual({ offset: 40, next_offset: 80 });
    expect(value.missing).toEqual(['预算未记录', '负责人未确认']);
    expect(value.conflicts).toEqual(['两个资料时间不同', '日期冲突']);
    expect(JSON.stringify(value)).not.toContain('untrusted');
    expect(source.content).toContain('const windowHours = 48;');
  });

  test('rejects malformed summaries instead of dropping unresolved state', () => {
    expect(() => toolCompaction({}, { summary: 'summary', missing: 'none', conflicts: [] }, [source])).toThrow();
    expect(() => toolCompaction({}, { summary: '', missing: [], conflicts: [] }, [source])).toThrow();
  });

  test('selects task-relevant previews under a budget and preserves the original evidence', () => {
    const unrelated: TaskEvidence = { citation: { id: 'b', title: '午餐', kind: 'text' }, content: '午餐时间十二点' };
    const extract = (content: string, _goal: string, budget: number) => content.slice(0, budget);
    const selected = selectTaskEvidence([unrelated, source], '回滚窗口', 9, 9, extract, (text) => text.length);
    expect(selected.map((item) => item.citation.id)).toEqual(['read-a']);
    expect(selected[0]!.content.length).toBeLessThanOrEqual(9);
    expect(source.content).toContain('```ts');
    expect(selectTaskEvidence([source], '回滚', 0, 4, extract, (text) => text.length)).toEqual([]);
  });
});
