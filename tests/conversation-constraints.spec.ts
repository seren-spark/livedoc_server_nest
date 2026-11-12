import { AppConfig } from '../src/config/app-config.js';
import { ConversationConstraintsService } from '../src/ai/conversation-constraints.service.js';
import { request } from './fixtures/agent-request.js';
import type { AgentMessage } from '../src/ai/document-agent.types.js';
import { constraintContinuation } from '../src/ai/graph/agent-graph.workflow.js';

const context = { user_id: 'alice', space_id: 'space-a', team_ids: [] };
const signal = new AbortController().signal;
function setup() {
  const config = new AppConfig();
  Object.assign(config, { conversationConstraintsEnabled: true });
  return { service: new ConversationConstraintsService(config, { memoryEnabled: false } as any), config };
}
function response(value: unknown) {
  return async (): Promise<AgentMessage> => ({ role: 'assistant', content: JSON.stringify(value) });
}
const empty = response({ upsert: [], remove: [] });
const keep = (quote = '接下来始终保留代码块') => response({
  upsert: [{ kind: 'constraint', text: quote, quote }], remove: [],
});

describe('persistent conversation constraints', () => {
  test('retains continuation semantics for checkpoints without constraint annotations', () => {
    expect(constraintContinuation({ constraintNext: 'compose' })).toBe('compose');
    expect(constraintContinuation({ questions: { reader: { question: '缺少资料' } } })).toBe('clarify');
    expect(constraintContinuation({ needsApproval: true, approved: false })).toBe('make_plan');
    expect(constraintContinuation({ plan: { goal: '', outline: [], constraints: [], steps: [] } })).toBe('decide_next');
    expect(constraintContinuation({})).toBe('compose');
  });
  test('retains an attributed constraint beyond the recent six turns', async () => {
    const { service } = setup();
    const input = { ...request(), query: '接下来始终保留代码块' };
    await service.prepare(input, context, 'turn-1', keep(), signal);
    let state;
    for (let index = 2; index <= 9; index++)
      state = await service.prepare({ ...input, query: '继续解释' }, context, `turn-${index}`, empty, signal);
    expect(state!.items).toEqual([expect.objectContaining({ text: input.query, source_id: 'turn-1', quote: input.query })]);
    expect(state!.revision).toBe(9);
  });

  test('replaces and cancels only explicitly referenced existing constraints', async () => {
    const { service } = setup();
    const input = request();
    const first = await service.prepare({ ...input, query: '接下来始终保留代码块' }, context, 'one', keep(), signal);
    const id = first.items[0]!.id;
    const revised = await service.prepare(input, context, 'two', response({ upsert: [
      { id, kind: 'constraint', text: '允许修改代码块', quote: '允许修改代码块' },
    ], remove: [] }), signal, '改为允许修改代码块');
    expect(revised.items[0]!.text).toBe('允许修改代码块');
    const cleared = await service.prepare(input, context, 'three', response({
      upsert: [], remove: [{ id, quote: '取消代码块要求' }],
    }), signal, '取消代码块要求');
    expect(cleared.items).toEqual([]);
  });

  test.each([
    { kind: 'knowledge', doc_id: 'k', persisted_version: 1 },
    { kind: 'article', article_id: 'a', draft_version: 1 },
    { kind: 'import', import_id: 'i' },
    { kind: 'unsaved', local_id: 'u' },
  ] as const)('scopes state by the full document identity %j', async (identity) => {
    const { service } = setup();
    const input = { ...request(), query: '接下来始终保留代码块' };
    input.editor_snapshot.identity = identity;
    await service.prepare(input, context, 'first', keep(), signal);
    for (const other of [
      { ...context, user_id: 'bob' }, { ...context, space_id: 'other' },
    ]) expect((await service.prepare(input, other, 'other', empty, signal)).items).toEqual([]);
    const second = { ...input, conversation_id: 'other' };
    expect((await service.prepare(second, context, 'other', empty, signal)).items).toEqual([]);
    const otherDoc = structuredClone(input);
    otherDoc.editor_snapshot.identity = { kind: 'unsaved', local_id: 'different' };
    expect((await service.prepare(otherDoc, context, 'other', empty, signal)).items).toEqual([]);
  });

  test('records empty extraction and replays exactly once without another model request', async () => {
    const { service } = setup();
    const input = request();
    let calls = 0;
    const turn = async () => { calls++; return empty(); };
    const first = await service.prepare(input, context, 'same', turn, signal);
    expect(await service.prepare(input, context, 'same', turn, signal)).toEqual(first);
    expect(calls).toBe(1);
    await expect(service.prepare({ ...input, query: 'changed' }, context, 'same', turn, signal))
      .rejects.toMatchObject({ code: 'MEMORY_INPUT_CHANGED' });
  });

  test('rejects fabricated source quotes, invalid removals and oversize states atomically', async () => {
    const { service, config } = setup();
    const input = { ...request(), query: '接下来始终保留代码块' };
    const saved = await service.prepare(input, context, 'first', keep(), signal);
    await expect(service.prepare(input, context, 'bad', keep('模型自己提出的要求'), signal))
      .rejects.toMatchObject({ code: 'MEMORY_UPDATE_FAILED' });
    await expect(service.prepare(input, context, 'remove', response({ upsert: [], remove: [{ id: 'unknown', quote: input.query }] }), signal))
      .rejects.toMatchObject({ code: 'MEMORY_UPDATE_FAILED' });
    Object.assign(config, { shortMemoryTokenBudget: 1 });
    await expect(service.prepare(input, context, 'overflow', empty, signal))
      .rejects.toMatchObject({ code: 'MEMORY_CONTEXT_EXCEEDED' });
    Object.assign(config, { shortMemoryTokenBudget: 4000 });
    const next = await service.prepare(input, context, 'after', empty, signal);
    expect(next.items).toEqual(saved.items);
    expect(next.revision).toBe(saved.revision + 1);
  });

  test('accepts an omitted no-op array and rejects malformed updates without changing saved state', async () => {
    const { service } = setup();
    const input = { ...request(), query: '接下来始终保留代码块' };
    const state = await service.prepare(input, context, 'upsert-only', response({
      upsert: [{ kind: 'constraint', text: input.query, quote: input.query }],
    }), signal);
    for (const delta of [{}, { upsert: [], remove: null }, { upsert: 'invalid', remove: [] }])
      await expect(service.prepare(input, context, JSON.stringify(delta), response(delta), signal))
        .rejects.toMatchObject({ code: 'MEMORY_UPDATE_FAILED' });
    const cleared = await service.prepare(input, context, 'remove-only', response({
      remove: [{ id: state.items[0]!.id, quote: '取消要求' }],
    }), signal, '取消要求');
    expect(cleared.items).toEqual([]);
  });

  test('concurrent updates cannot overwrite a committed newer state', async () => {
    const { service } = setup();
    const input = { ...request(), query: '接下来始终保留代码块' };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const old = service.prepare(input, context, 'slow', async () => {
      entered(); await gate; return keep()();
    }, signal);
    await ready;
    await service.prepare(input, context, 'fast', keep(), signal);
    release();
    await expect(old).rejects.toMatchObject({ code: 'MEMORY_VERSION_CONFLICT' });
  });

  test('expiry and document deletion remove active state and processing receipts', async () => {
    const { service, config } = setup();
    const input = { ...request(), query: '接下来始终保留代码块' };
    input.editor_snapshot.identity = { kind: 'knowledge', doc_id: 'k', persisted_version: 1 };
    Object.assign(config, { memoryTtlDays: -1 });
    await service.prepare(input, context, 'expired', keep(), signal);
    Object.assign(config, { memoryTtlDays: 30 });
    expect((await service.prepare(input, context, 'expired', empty, signal)).items).toEqual([]);
    await service.prepare(input, context, 'saved', keep(), signal);
    await service.deleteDocument('k');
    expect((await service.prepare(input, context, 'saved', empty, signal)).items).toEqual([]);
  });

  test('cancelled extraction cannot save its late result', async () => {
    const { service } = setup();
    const input = { ...request(), query: '接下来始终保留代码块' };
    const abort = new AbortController();
    await expect(service.prepare(input, context, 'cancelled', async () => {
      abort.abort(); return keep()();
    }, abort.signal)).rejects.toThrow();
    expect((await service.prepare(input, context, 'after', empty, signal)).items).toEqual([]);
  });
});
