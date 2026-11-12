import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { AppConfig } from '../src/config/app-config.js';
import { DatabaseService } from '../src/database/database.service.js';
import type { WorkspaceService } from '../src/workspace/workspace.service.js';
import { WritingSkillsService } from '../src/ai/writing-skills.service.js';
import type { SaveWritingSkillInput } from '../src/ai/writing-skills.types.js';

const suite = process.env.GRAPH_MYSQL_TEST === 'true' ? describe : describe.skip;
const definition: SaveWritingSkillInput = {
  name: '数据库专项', description: '验证跨实例 Skill 状态', parameters: [],
  steps: [{ id: 'read', capability: 'read', description: '读取当前资料', depends_on: [] }],
  allowed_tools: ['read_current_document', 'finish_answer'], acceptance: ['引用真实来源'],
};

suite('writing skill persistence in isolated MySQL', () => {
  let database: DatabaseService;
  let first: WritingSkillsService;
  let second: WritingSkillsService;
  const context = { user_id: `skills-${randomUUID()}`, space_id: 'skills-space', team_ids: [] };

  beforeAll(async () => {
    expect(new URL(process.env.DATABASE_URL!).pathname).toBe('/livedoc_langgraph_integration_test');
    database = new DatabaseService(new AppConfig());
    await database.onModuleInit();
    first = new WritingSkillsService(database, {} as WorkspaceService);
    second = new WritingSkillsService(database, {} as WorkspaceService);
  }, 120000);

  afterAll(async () => {
    if (!database) return;
    await database.query('DELETE FROM writing_skills WHERE owner_id=? AND space_id=?', [context.user_id, context.space_id]);
    await database.onModuleDestroy();
  });

  test('another instance reads the saved definition and rejects another owner or space', async () => {
    const created = await first.save(context, definition);
    expect(await second.get(context, created.skill_id)).toEqual(created);
    await expect(second.get({ ...context, user_id: 'someone-else' }, created.skill_id)).rejects.toMatchObject({ status: 404 });
    await expect(second.get({ ...context, space_id: 'another-space' }, created.skill_id)).rejects.toMatchObject({ status: 404 });
  });

  test('concurrent instances accept one CAS update and keep the current revision', async () => {
    const created = await first.save(context, definition);
    const results = await Promise.allSettled([
      first.save(context, { ...definition, expected_revision: 1, name: 'first' }, created.skill_id),
      second.save(context, { ...definition, expected_revision: 1, name: 'second' }, created.skill_id),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await first.get(context, created.skill_id)).revision).toBe(2);
  });

  test('a stale delete fails and a saved task snapshot survives a successful delete', async () => {
    const created = await first.save(context, definition);
    const snapshot = await second.snapshot(context, { skill_id: created.skill_id, skill_revision: 1 });
    await first.save(context, { ...definition, expected_revision: 1, name: 'new' }, created.skill_id);
    await expect(second.delete(context, created.skill_id, 1)).rejects.toMatchObject({ status: 409 });
    await second.delete(context, created.skill_id, 2);
    await expect(first.get(context, created.skill_id)).rejects.toMatchObject({ status: 404 });
    expect(first.toPlan(snapshot, '恢复原任务').steps[0]!.description).toBe('读取当前资料');
  });
});
