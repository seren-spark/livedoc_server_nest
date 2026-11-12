import { randomUUID, createHash } from 'node:crypto';
import { jest } from '@jest/globals';
import { AppConfig } from '../src/config/app-config.js';
import { DatabaseService } from '../src/database/database.service.js';
import { ConversationConstraintsService } from '../src/ai/conversation-constraints.service.js';
import { agentMemoryDocumentId } from '../src/ai/conversation-constraints.service.js';
import { ConversationMemoryService } from '../src/ai/memory.service.js';
import { CONVERSATION_TURN_SCOPE_BACKFILL } from '../src/database/conversation-constraints-schema.js';
import { request } from './fixtures/agent-request.js';
import type { AgentMessage } from '../src/ai/document-agent.types.js';

const suite = process.env.GRAPH_MYSQL_TEST === 'true' ? describe : describe.skip;
suite('constraint state transactions in isolated MySQL', () => {
  let db: DatabaseService;
  let config: AppConfig;
  const context = { user_id: `constraints-${randomUUID()}`, space_id: 'space-a', team_ids: [] };
  const signal = new AbortController().signal;
  const input = { ...request(), query: '接下来始终保留代码块' };
  const keep = async (): Promise<AgentMessage> => ({ role: 'assistant', content: JSON.stringify({
    upsert: [{ kind: 'constraint', text: input.query, quote: input.query }], remove: [],
  }) });
  const empty = async (): Promise<AgentMessage> => ({ role: 'assistant', content: '{"upsert":[],"remove":[]}' });
  beforeAll(async () => {
    expect(new URL(process.env.DATABASE_URL!).pathname).toBe('/livedoc_langgraph_integration_test');
    config = new AppConfig();
    Object.assign(config, { conversationConstraintsEnabled: true });
    db = new DatabaseService(config);
    await db.onModuleInit();
  }, 120000);
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    if (!db) return;
    await db.query(`DELETE inputs FROM conversation_constraint_inputs inputs
      JOIN conversation_constraint_states states ON inputs.scope_key=states.scope_key WHERE states.user_id=?`, [context.user_id]);
    await db.query('DELETE FROM conversation_constraint_states WHERE user_id=?', [context.user_id]);
    await db.query('DELETE FROM conversation_turns WHERE user_id=?', [context.user_id]);
    await db.query('DELETE FROM agent_runs WHERE user_id=?', [context.user_id]);
    await db.onModuleDestroy();
  });

  test('a different service instance reads state and replays the same receipt', async () => {
    const first = new ConversationConstraintsService(config, db);
    const original = await first.prepare(input, context, 'first', keep, signal);
    const second = new ConversationConstraintsService(config, db);
    let invoked = false;
    const replayed = await second.prepare(input, context, 'first', async () => {
      invoked = true; return empty();
    }, signal);
    expect(replayed).toEqual(original);
    expect(invoked).toBe(false);
    const later = await second.prepare(input, context, 'later', empty, signal);
    expect(later.items).toEqual(original.items);
  });

  test('a failed receipt insert rolls back the state update', async () => {
    const service = new ConversationConstraintsService(config, db);
    const isolated = { ...input, conversation_id: randomUUID() };
    const transaction = db.transaction.bind(db);
    jest.spyOn(db, 'transaction').mockImplementation(async (work) => transaction(async (manager) => {
      const query = manager.query.bind(manager);
      jest.spyOn(manager, 'query').mockImplementation(async (sql: string, parameters?: any[]) => {
        if (sql.startsWith('INSERT INTO conversation_constraint_inputs')) throw new Error('Controlled receipt failure');
        return query(sql, parameters);
      });
      return work(manager);
    }));
    await expect(service.prepare(isolated, context, 'rollback', keep, signal))
      .rejects.toMatchObject({ code: 'MEMORY_UPDATE_FAILED' });
    jest.restoreAllMocks();
    const saved = await service.prepare(isolated, context, 'rollback', empty, signal);
    expect(saved.revision).toBe(1);
    expect(saved.items).toEqual([]);
  });

  test('two service instances reject stale writes instead of overwriting newer constraints', async () => {
    const isolated = { ...input, conversation_id: randomUUID() };
    const first = new ConversationConstraintsService(config, db);
    const second = new ConversationConstraintsService(config, db);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const ready = new Promise<void>((done) => { entered = done; });
    const old = first.prepare(isolated, context, 'old', async () => {
      entered(); await gate; return keep();
    }, signal);
    await ready;
    await second.prepare(isolated, context, 'new', keep, signal);
    release();
    await expect(old).rejects.toMatchObject({ code: 'MEMORY_VERSION_CONFLICT' });
  });

  test('attributes old Agent history to its document without mixing other documents', async () => {
    const id = randomUUID();
    const turn = createHash('sha256').update(`agent:${id}`).digest('hex').slice(0, 32);
    const identity = { kind: 'article' as const, article_id: 'old-article', draft_version: 1 };
    await db.query(`INSERT INTO agent_runs
      (run_id,request_id,user_id,space_id,conversation_id,mode,status,payload)
      VALUES (?,?,?,?,?,'ask','completed',?)`,
      [id, id, context.user_id, context.space_id, input.conversation_id, JSON.stringify({ identity })]);
    await db.query(`INSERT INTO conversation_turns
      (turn_id,conversation_id,user_id,space_id,doc_id,user_content,assistant_content,created_at,expires_at)
      VALUES (?,?,?,?,NULL,?,?,UTC_TIMESTAMP(6),DATE_ADD(UTC_TIMESTAMP(6),INTERVAL 1 DAY))`,
      [turn, input.conversation_id, context.user_id, context.space_id, '历史用户要求', '历史候选']);
    await db.query(CONVERSATION_TURN_SCOPE_BACKFILL);
    const memory = new ConversationMemoryService(config, db);
    expect(await memory.recentText(input.conversation_id, context, agentMemoryDocumentId(identity)))
      .toContain('历史用户要求');
    expect(await memory.recentText(input.conversation_id, context,
      agentMemoryDocumentId({ ...identity, article_id: 'another-article' }))).toBe('');
  });
});
