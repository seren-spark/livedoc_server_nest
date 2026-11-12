import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { AppConfig } from '../src/config/app-config.js';
import { DatabaseService } from '../src/database/database.service.js';
import { WritingPreferencesService } from '../src/ai/writing-preferences.service.js';
import type { PreferenceTurn } from '../src/ai/writing-preferences.types.js';

const suite = process.env.GRAPH_MYSQL_TEST === 'true' ? describe : describe.skip;
const input = '请记住我偏好简洁表达';
const save: PreferenceTurn = async () => ({ role: 'assistant', content: JSON.stringify({
  save: [{ text: '简洁表达', quote: input }], candidates: [],
}) });

suite('writing preference transactions in isolated MySQL', () => {
  let database: DatabaseService;
  let config: AppConfig;
  const context = { user_id: `preferences-${randomUUID()}`, space_id: `preferences-space-${randomUUID()}`, team_ids: [] };

  beforeAll(async () => {
    expect(new URL(process.env.DATABASE_URL!).pathname).toBe('/livedoc_langgraph_integration_test');
    config = new AppConfig();
    Object.assign(config, { shortMemoryTokenBudget: 4000 });
    database = new DatabaseService(config);
    await database.onModuleInit();
  }, 120000);

  afterEach(() => { jest.restoreAllMocks(); });
  afterAll(async () => {
    if (!database) return;
    await database.query('DELETE FROM writing_preference_inputs WHERE space_id=?', [context.space_id]);
    await database.query('DELETE FROM writing_preference_states WHERE space_id=?', [context.space_id]);
    await database.onModuleDestroy();
  });

  test('a new instance reads persistent preferences and replays the original input receipt', async () => {
    const actor = { ...context, user_id: context.user_id + '-read' };
    const first = new WritingPreferencesService(config, database);
    const original = await first.prepare(actor, 'one', input, save);
    const second = new WritingPreferencesService(config, database);
    const turn = jest.fn<PreferenceTurn>();
    const replayed = await second.prepare(actor, 'one', input, turn);
    expect(replayed.snapshot).toEqual(original.snapshot);
    expect(replayed.replayed).toBe(true);
    expect(turn).not.toHaveBeenCalled();
    expect(await second.get(actor)).toEqual(original.state);
    expect((await second.get({ ...actor, user_id: 'someone-else' })).items).toEqual([]);
    expect((await second.get({ ...actor, space_id: 'another-space' })).items).toEqual([]);
  });

  test('two instances accept one CAS mutation and concurrent duplicate inputs share one receipt', async () => {
    const actor = { ...context, user_id: context.user_id + '-cas' };
    const first = new WritingPreferencesService(config, database);
    const second = new WritingPreferencesService(config, database);
    const mutations = await Promise.allSettled([
      first.mutate(actor, { request_id: 'first', expected_revision: 0, action: 'save', text: '简洁表达' }),
      second.mutate(actor, { request_id: 'second', expected_revision: 0, action: 'save', text: '详细说明' }),
    ]);
    expect(mutations.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(mutations.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await first.get(actor)).revision).toBe(1);
    const duplicateActor = { ...context, user_id: context.user_id + '-duplicate' };
    const duplicates = await Promise.all([
      first.prepare(duplicateActor, 'same', input, save),
      second.prepare(duplicateActor, 'same', input, save),
    ]);
    expect(duplicates[0]!.snapshot).toEqual(duplicates[1]!.snapshot);
    expect((await first.get(duplicateActor)).items).toHaveLength(1);
    const [receipt] = await database.query<{ total: string }>(
      'SELECT COUNT(*) AS total FROM writing_preference_inputs WHERE space_id=? AND user_id=?',
      [duplicateActor.space_id, duplicateActor.user_id],
    );
    expect(Number(receipt!.total)).toBe(1);
  });

  test('a failed receipt insert rolls back the state and permits an ordinary retry', async () => {
    const actor = { ...context, user_id: context.user_id + '-rollback' };
    const service = new WritingPreferencesService(config, database);
    const transaction = database.transaction.bind(database);
    jest.spyOn(database, 'transaction').mockImplementation(async (work) => transaction(async (manager) => {
      const query = manager.query.bind(manager);
      jest.spyOn(manager, 'query').mockImplementation(async (sql: string, parameters?: any[]) => {
        if (sql.startsWith('INSERT INTO writing_preference_inputs')) throw new Error('Controlled receipt failure');
        return query(sql, parameters);
      });
      return work(manager);
    }));
    await expect(service.prepare(actor, 'rollback', input, save)).rejects.toMatchObject({ code: 'PREFERENCE_UPDATE_FAILED' });
    jest.restoreAllMocks();
    expect(await service.get(actor)).toEqual({ revision: 0, items: [] });
    const retried = await service.prepare(actor, 'rollback', input, save);
    expect(retried.snapshot.items.map((item) => item.text)).toEqual(['简洁表达']);
    expect(retried.state.revision).toBe(1);
  });

  test('a stale extraction cannot overwrite a mutation committed by another instance', async () => {
    const actor = { ...context, user_id: context.user_id + '-stale' };
    const first = new WritingPreferencesService(config, database);
    const second = new WritingPreferencesService(config, database);
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((done) => { entered = done; });
    const gate = new Promise<void>((done) => { release = done; });
    const slow = first.prepare(actor, 'slow', input, async () => { entered(); await gate; return save([]); });
    await ready;
    const current = await second.mutate(actor, { request_id: 'newer', expected_revision: 0, action: 'save', text: '口语表达' });
    release();
    await expect(slow).rejects.toMatchObject({ code: 'PREFERENCE_VERSION_CONFLICT', retryable: true });
    expect(await first.get(actor)).toEqual(current);
  });
});
