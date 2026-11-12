import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { AppConfig } from '../src/config/app-config.js';
import type { DatabaseService } from '../src/database/database.service.js';
import { WritingPreferencesService } from '../src/ai/writing-preferences.service.js';
import type { PreferenceMutation, PreferenceState, PreferenceTurn } from '../src/ai/writing-preferences.types.js';

const context = { user_id: 'preferences-alice', space_id: 'space-a', team_ids: [] };
const remembered = '请记住我偏好简洁表达';
const response = (value: unknown): PreferenceTurn => async () => ({ role: 'assistant', content: JSON.stringify(value) });
const empty = response({ save: [], candidates: [] });
const saveResponse = (quote = remembered) => response({ save: [{ text: '简洁表达', quote }], candidates: [] });

function setup() {
  const config = new AppConfig();
  Object.assign(config, { shortMemoryTokenBudget: 4000 });
  return { config, service: new WritingPreferencesService(config, { memoryEnabled: false } as DatabaseService) };
}

async function save(service: WritingPreferencesService, text = '简洁表达', revision = 0, id = 'manual-save') {
  return service.mutate(context, { request_id: id, expected_revision: revision, action: 'save', text });
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('user-scoped writing preferences', () => {
  test('explicit saving produces an attributed confirmed snapshot through the supplied model turn', async () => {
    const { service } = setup();
    const turn = jest.fn<PreferenceTurn>().mockImplementation(saveResponse());
    const result = await service.prepare(context, 'input-1', remembered, turn);
    expect(result.snapshot).toEqual({ revision: 1, items: [{ id: result.saved_ids[0], text: '简洁表达' }] });
    expect(result.state.items[0]).toMatchObject({ status: 'confirmed', source: {
      kind: 'user_input', input_id: 'input-1', quote: remembered,
    } });
    expect(turn).toHaveBeenCalledTimes(1);
    const messages = turn.mock.calls[0]![0];
    expect(JSON.parse(messages[1]!.content!)).toEqual({ purpose: 'writing_preferences', previous: [], input: remembered });
    expect(messages[0]!.content).toContain('当前明确要求始终优先');
  });

  test('a correction remains pending until the user confirms it', async () => {
    const { service } = setup();
    const text = '刚才的说明太书面，我更喜欢口语表达';
    const candidate = await service.prepare(context, 'correction', text, response({ save: [], candidates: [
      { text: '口语表达', quote: '我更喜欢口语表达' },
    ] }));
    expect(candidate.snapshot.items).toEqual([]);
    expect(candidate.candidate_ids).toHaveLength(1);
    const confirmed = await service.mutate(context, { request_id: 'confirm', expected_revision: 1,
      action: 'confirm', id: candidate.candidate_ids[0] });
    expect(service.snapshot(confirmed).items.map((item) => item.text)).toEqual(['口语表达']);
  });

  test.each([
    ['请不要记住我偏好简洁表达', '我偏好简洁表达'],
    ['仅本次记住我偏好简洁表达', '我偏好简洁表达'],
    ['记住我偏好短段落；我偏好简洁表达', '我偏好简洁表达'],
  ])('a model save outside an explicit persistent source clause stays unconfirmed: %s', async (text, quote) => {
    const { service } = setup();
    const result = await service.prepare(context, 'ambiguous', text, saveResponse(quote));
    expect(result.saved_ids).toEqual([]);
    expect(result.snapshot.items).toEqual([]);
    expect(result.state.items[0]!.status).toBe('pending');
  });

  test('accepts an explicit source quote with terminal punctuation', async () => {
    const { service } = setup();
    const quote = remembered + '。';
    const result = await service.prepare(context, 'punctuation', quote, saveResponse(quote));
    expect(result.saved_ids).toHaveLength(1);
  });

  test('conflicting candidates require explicit replacement and rejected candidates preserve the prior preference', async () => {
    const { service } = setup();
    const original = await save(service);
    const originalId = original.items[0]!.id;
    const candidate = await service.prepare(context, 'conflict', '我更喜欢详细说明', response({ save: [], candidates: [
      { text: '详细说明', quote: '我更喜欢详细说明', conflicts_with: [originalId] },
    ] }));
    const id = candidate.candidate_ids[0]!;
    await expect(service.mutate(context, { request_id: 'bad-confirm', expected_revision: 2, action: 'confirm', id }))
      .rejects.toMatchObject({ status: 409 });
    expect(service.snapshot(await service.get(context)).items).toEqual(service.snapshot(original).items);
    const confirmed = await service.mutate(context, { request_id: 'replace', expected_revision: 2, action: 'confirm', id,
      replace_ids: [originalId] });
    expect(service.snapshot(confirmed).items).toEqual([{ id, text: '详细说明' }]);
    await expect(service.mutate(context, { request_id: 'twice', expected_revision: 3, action: 'confirm', id }))
      .rejects.toMatchObject({ status: 409 });
  });

  test('rejecting a candidate allows a later explicit request to save that preference', async () => {
    const { service } = setup();
    const candidate = await service.prepare(context, 'suggestion', '我更喜欢口语表达', response({ save: [], candidates: [
      { text: '口语表达', quote: '我更喜欢口语表达' },
    ] }));
    await service.mutate(context, { request_id: 'reject', expected_revision: 1, action: 'reject', id: candidate.candidate_ids[0] });
    const turn = jest.fn<PreferenceTurn>().mockImplementation(response({ save: [{ text: '口语表达', quote: '记住我偏好口语表达' }], candidates: [] }));
    const saved = await service.prepare(context, 'explicit-later', '记住我偏好口语表达', turn);
    expect(JSON.parse(turn.mock.calls[0]![0][1]!.content!).previous).toEqual([]);
    expect(saved.snapshot.items.map((item) => item.text)).toEqual(['口语表达']);
  });

  test('editing an unconfirmed candidate cannot remove a confirmed preference', async () => {
    const { service } = setup();
    const original = await save(service);
    const candidate = await service.prepare(context, 'pending', '我更喜欢详细说明', response({ save: [], candidates: [
      { text: '详细说明', quote: '我更喜欢详细说明', conflicts_with: [original.items[0]!.id] },
    ] }));
    await expect(service.mutate(context, { request_id: 'edit-and-replace', expected_revision: 2, action: 'update',
      id: candidate.candidate_ids[0], text: '按步骤说明', replace_ids: [original.items[0]!.id] }))
      .rejects.toMatchObject({ status: 400 });
    const edited = await service.mutate(context, { request_id: 'edit', expected_revision: 2, action: 'update',
      id: candidate.candidate_ids[0], text: '按步骤说明' });
    expect(service.snapshot(edited).items).toEqual(service.snapshot(original).items);
    expect(edited.items.find((item) => item.id === candidate.candidate_ids[0])).toMatchObject({
      text: '按步骤说明', status: 'pending', conflicts_with: [original.items[0]!.id], source: { kind: 'manual', quote: '按步骤说明' },
    });
  });

  test('confirmed modifications and deletion affect future snapshots while existing snapshots remain stable', async () => {
    const { service } = setup();
    const first = await save(service);
    const snapshot = service.snapshot(first);
    const changed = await service.mutate(context, { request_id: 'change', expected_revision: 1, action: 'update',
      id: first.items[0]!.id, text: '详细说明' });
    expect(service.snapshot(changed).items[0]!.text).toBe('详细说明');
    expect(snapshot.items[0]!.text).toBe('简洁表达');
    const deleted = await service.mutate(context, { request_id: 'delete', expected_revision: 2, action: 'delete', id: first.items[0]!.id });
    expect(service.snapshot(deleted).items).toEqual([]);
  });

  test('state is reusable across conversations and documents and is isolated by user and space', async () => {
    const { service } = setup();
    const first = await service.prepare(context, 'conversation-one:document-one', remembered, saveResponse());
    const later = await service.prepare(context, 'conversation-two:document-two', '本次请详细说明', empty);
    expect(later.snapshot).toEqual(first.snapshot);
    expect((await service.get({ ...context, user_id: 'bob' })).items).toEqual([]);
    expect((await service.get({ ...context, space_id: 'another-space' })).items).toEqual([]);
  });

  test('same input replays the receipt without another model request and detects changed input', async () => {
    const { service } = setup();
    const turn = jest.fn<PreferenceTurn>().mockImplementation(saveResponse());
    const original = await service.prepare(context, 'same', remembered, turn);
    const replayed = await service.prepare(context, 'same', remembered, turn);
    expect(replayed.replayed).toBe(true);
    expect(replayed.snapshot).toEqual(original.snapshot);
    expect(turn).toHaveBeenCalledTimes(1);
    await expect(service.prepare(context, 'same', 'changed', turn)).rejects.toMatchObject({ code: 'PREFERENCE_INPUT_CHANGED' });
  });

  test('empty extraction receipts are also deduplicated', async () => {
    const { service } = setup();
    const turn = jest.fn<PreferenceTurn>().mockImplementation(empty);
    const first = await service.prepare(context, 'empty', '仅本次缩成一段', turn);
    const again = await service.prepare(context, 'empty', '仅本次缩成一段', turn);
    expect(first.snapshot).toEqual({ revision: 0, items: [] });
    expect(again.replayed).toBe(true);
    expect(turn).toHaveBeenCalledTimes(1);
  });

  test('manual mutations are idempotent and stale revisions cannot overwrite state', async () => {
    const { service } = setup();
    const operation: PreferenceMutation = { request_id: 'operation', expected_revision: 0, action: 'save', text: '简洁表达' };
    const first = await service.mutate(context, operation);
    expect(await service.mutate(context, operation)).toEqual(first);
    await expect(service.mutate(context, { ...operation, text: 'changed' })).rejects.toMatchObject({ status: 409 });
    await expect(save(service, '另一个要求', 0, 'stale')).rejects.toMatchObject({ status: 409 });
    expect(await service.get(context)).toEqual(first);
  });

  test.each([
    { save: [{ text: '虚构偏好', quote: '用户没有说过' }], candidates: [] },
    { save: [], candidates: [{ text: '详细说明', quote: remembered, conflicts_with: ['unknown'] }] },
    { save: 'invalid', candidates: [] },
  ])('invalid extraction preserves the committed state: %j', async (delta) => {
    const { service } = setup();
    const previous = await save(service);
    await expect(service.prepare(context, 'bad', remembered, response(delta))).rejects.toMatchObject({ code: 'PREFERENCE_UPDATE_FAILED' });
    expect(await service.get(context)).toEqual(previous);
  });

  test('model and storage failure preserve state and leave the input retryable', async () => {
    const { service } = setup();
    const previous = await save(service);
    await expect(service.prepare(context, 'model-failure', remembered, async () => { throw new Error('unavailable'); }))
      .rejects.toMatchObject({ code: 'PREFERENCE_UPDATE_FAILED', retryable: true });
    const commit = jest.spyOn(service.repository, 'commit').mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(service.prepare(context, 'storage-failure', '本次请详细说明', empty)).rejects.toMatchObject({ code: 'PREFERENCE_UPDATE_FAILED' });
    expect(await service.get(context)).toEqual(previous);
    commit.mockRestore();
    expect((await service.prepare(context, 'storage-failure', '本次请详细说明', empty)).snapshot).toEqual(service.snapshot(previous));
  });

  test('concurrent extraction rejects a stale result and duplicate concurrent input commits once', async () => {
    const { service } = setup();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const ready = new Promise<void>((done) => { entered = done; });
    const pending = service.prepare(context, 'slow', remembered, async () => { entered(); await gate; return saveResponse()([]); });
    await ready;
    const committed = await save(service);
    release();
    await expect(pending).rejects.toMatchObject({ code: 'PREFERENCE_VERSION_CONFLICT', retryable: true });
    expect(await service.get(context)).toEqual(committed);
    const other = { ...context, user_id: 'same-input-user' };
    const same = await Promise.all([
      service.prepare(other, 'duplicate', remembered, saveResponse()),
      service.prepare(other, 'duplicate', remembered, saveResponse()),
    ]);
    expect(same[0]!.snapshot).toEqual(same[1]!.snapshot);
    expect((await service.get(other)).items).toHaveLength(1);
  });

  test('enforces both confirmed item count and the injection token budget without partial writes', async () => {
    const { service, config } = setup();
    const tokenCount = jest.spyOn(service, 'tokenCount').mockReturnValue(0);
    let state: PreferenceState = { revision: 0, items: [] };
    for (let index = 0; index < 20; index++) state = await save(service, `要求 ${index}`, state.revision, `save-${index}`);
    await expect(save(service, '第21条', state.revision, 'overflow')).rejects.toMatchObject({ code: 'PREFERENCE_CONTEXT_EXCEEDED' });
    expect(await service.get(context)).toEqual(state);
    tokenCount.mockRestore();
    const other = { ...context, user_id: 'token-budget-user' };
    Object.assign(config, { shortMemoryTokenBudget: 1 });
    await expect(service.mutate(other, { request_id: 'tokens', expected_revision: 0, action: 'save', text: '简洁表达' }))
      .rejects.toMatchObject({ code: 'PREFERENCE_CONTEXT_EXCEEDED' });
    expect((await service.get(other)).items).toEqual([]);
  });

  test('confirmed and pending preferences remain until explicitly changed or deleted', async () => {
    const { service } = setup();
    const first = await save(service);
    const pending = await service.prepare(context, 'pending', '我更喜欢口语表达', response({ save: [], candidates: [
      { text: '口语表达', quote: '我更喜欢口语表达' },
    ] }));
    jest.useFakeTimers({ now: new Date('2100-01-01T00:00:00Z') });
    expect(await service.get(context)).toEqual(pending.state);
    expect(service.snapshot(await service.get(context)).items).toEqual(service.snapshot(first).items);
  });

  test('an aborted extraction cannot commit its late response', async () => {
    const { service } = setup();
    const abort = new AbortController();
    await expect(service.prepare(context, 'abort', remembered, async () => { abort.abort(); return saveResponse()([]); }, abort.signal))
      .rejects.toThrow();
    expect((await service.get(context)).items).toEqual([]);
  });
});
