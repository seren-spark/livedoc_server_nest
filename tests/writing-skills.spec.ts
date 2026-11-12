import { describe, expect, jest, test } from '@jest/globals';
import type { AccessContext } from '../src/common/types.js';
import type { DatabaseService } from '../src/database/database.service.js';
import type { WorkspaceService } from '../src/workspace/workspace.service.js';
import type { NoteTemplate } from '../src/workspace/workspace.types.js';
import { BUILTIN_WRITING_SKILLS, WritingSkillsService } from '../src/ai/writing-skills.service.js';
import type { SaveWritingSkillInput } from '../src/ai/writing-skills.types.js';

const alice: AccessContext = { user_id: 'alice', space_id: 'space-a', team_ids: [] };
const bob: AccessContext = { ...alice, user_id: 'bob' };
const otherSpace: AccessContext = { ...alice, space_id: 'space-b' };
const template = (id: string): NoteTemplate => ({ template_id: id, name: id, description: '模板',
  markdown: '# 示例', instructions: '使用小节', revision: 1 });

function setup() {
  const getTemplate = jest.fn<(context: AccessContext, id: string) => Promise<NoteTemplate>>()
    .mockImplementation(async (_context, id) => template(id));
  const service = new WritingSkillsService({ metadataEnabled: false } as DatabaseService,
    { getTemplate } as unknown as WorkspaceService);
  return { service, getTemplate };
}

function definition(): SaveWritingSkillInput {
  return {
    name: '个人技术写作', description: '根据资料整理技术说明',
    parameters: [{ name: 'audience', label: '目标读者', required: true }],
    steps: [
      { id: 'read', capability: 'read', description: '阅读用户资料', depends_on: [] },
      { id: 'compose', capability: 'compose', description: '面向{{audience}}组织说明', depends_on: ['read'] },
    ],
    allowed_tools: ['read_current_document', 'read_reference', 'finish_answer', 'propose_new_document', 'request_clarification'],
    acceptance: ['使用已读证据，缺失内容标为待确认'],
  };
}

describe('writing skill lifecycle and snapshots', () => {
  test('lists only metadata and resolves full content after explicit selection', async () => {
    const { service, getTemplate } = setup();
    const metadata = await service.list(alice);
    expect(metadata).toHaveLength(BUILTIN_WRITING_SKILLS.length);
    expect(metadata[0]).toMatchObject({ builtin: true, revision: 1, enabled: true });
    for (const row of metadata) {
      expect(row).not.toHaveProperty('steps');
      expect(row).not.toHaveProperty('allowed_tools');
      expect(row).not.toHaveProperty('acceptance');
    }
    expect(getTemplate).not.toHaveBeenCalled();
    const full = await service.get(alice, metadata[0]!.skill_id);
    expect(full.steps.length).toBeGreaterThan(0);
    full.steps[0]!.description = 'changed';
    expect((await service.get(alice, full.skill_id)).steps[0]!.description).not.toBe('changed');
  });

  test.each(BUILTIN_WRITING_SKILLS)('maps $name into a bounded DAG with original acceptance rules', async (builtin) => {
    const { service } = setup();
    const snapshot = await service.snapshot(alice, { skill_id: builtin.skill_id, skill_revision: 1 });
    const plan = service.toPlan(snapshot, '按当前用户要求写作');
    expect(plan.goal).toBe('按当前用户要求写作');
    expect(plan.steps).toHaveLength(builtin.steps.length);
    expect(plan.steps.length).toBeLessThanOrEqual(5);
    expect(plan.constraints).toEqual(builtin.acceptance);
    expect(JSON.stringify(plan)).not.toContain('{{');
  });

  test('creates, updates and deletes a private skill with owner and space isolation', async () => {
    const { service } = setup();
    const created = await service.save(alice, definition());
    expect(created).toMatchObject({ revision: 1, builtin: false, enabled: true });
    await expect(service.get(bob, created.skill_id)).rejects.toMatchObject({ status: 404 });
    await expect(service.get(otherSpace, created.skill_id)).rejects.toMatchObject({ status: 404 });
    const updated = await service.save(alice, { ...definition(), name: '新版', expected_revision: 1 }, created.skill_id);
    expect(updated).toMatchObject({ name: '新版', revision: 2 });
    await expect(service.delete(bob, created.skill_id, 2)).rejects.toMatchObject({ status: 404 });
    await expect(service.delete(alice, created.skill_id, 1)).rejects.toMatchObject({ status: 409 });
    await service.delete(alice, created.skill_id, 2);
    await expect(service.get(alice, created.skill_id)).rejects.toMatchObject({ status: 404 });
  });

  test('rejects stale versions and permits only one concurrent update', async () => {
    const { service } = setup();
    const created = await service.save(alice, definition());
    const results = await Promise.allSettled([
      service.save(alice, { ...definition(), name: 'first', expected_revision: 1 }, created.skill_id),
      service.save(alice, { ...definition(), name: 'second', expected_revision: 1 }, created.skill_id),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await service.get(alice, created.skill_id)).revision).toBe(2);
    await expect(service.save(alice, definition(), created.skill_id)).rejects.toMatchObject({ status: 409 });
    await expect(service.snapshot(alice, { skill_id: created.skill_id, skill_revision: 1, skill_inputs: { audience: '读者' } }))
      .rejects.toMatchObject({ status: 409 });
  });

  test('builtin definitions are immutable while creating a personal copy is supported', async () => {
    const { service } = setup();
    await expect(service.save(alice, definition(), 'builtin-meeting-notes')).rejects.toMatchObject({ status: 403 });
    await expect(service.delete(alice, 'builtin-meeting-notes', 1)).rejects.toMatchObject({ status: 403 });
    const { skill_id: _id, revision: _revision, builtin: _builtin, ...copy } = await service.get(alice, 'builtin-meeting-notes');
    const personal = await service.save(alice, { ...copy, name: '个人纪要' });
    expect(personal.builtin).toBe(false);
    expect(personal.skill_id).not.toBe('builtin-meeting-notes');
  });

  test('keeps a selected skill and template snapshot after edit and deletion', async () => {
    const { service, getTemplate } = setup();
    const created = await service.save(alice, { ...definition(), template_id: 'private-template' });
    const snapshot = await service.snapshot(alice, { skill_id: created.skill_id, skill_revision: 1,
      skill_inputs: { audience: '后端工程师' } });
    getTemplate.mockResolvedValue({ ...template('private-template'), revision: 2, instructions: '新结构' });
    await service.save(alice, { ...definition(), expected_revision: 1, name: '新版本' }, created.skill_id);
    await service.delete(alice, created.skill_id, 2);
    const plan = service.toPlan(snapshot, '继续原任务');
    expect(snapshot.skill).toMatchObject({ name: '个人技术写作', revision: 1 });
    expect(snapshot.template).toMatchObject({ revision: 1, instructions: '使用小节' });
    expect(plan.steps[1]!.description).toContain('后端工程师');
  });

  test('an explicit template takes precedence over the skill default', async () => {
    const { service, getTemplate } = setup();
    const snapshot = await service.snapshot(alice, { skill_id: 'builtin-technical-article', template_id: 'explicit-template' });
    expect(snapshot.template?.template_id).toBe('explicit-template');
    expect(getTemplate).toHaveBeenCalledWith(alice, 'explicit-template');
  });

  test('disabled skills remain manageable and cannot be selected', async () => {
    const { service } = setup();
    const created = await service.save(alice, { ...definition(), enabled: false });
    expect((await service.list(alice)).find((skill) => skill.skill_id === created.skill_id)?.enabled).toBe(false);
    await expect(service.snapshot(alice, { skill_id: created.skill_id })).rejects.toMatchObject({ status: 409 });
    const updated = await service.save(alice, { ...definition(), expected_revision: 1 }, created.skill_id);
    expect(updated.enabled).toBe(false);
  });

  test.each([
    ['required input', {}], ['unknown input', { audience: '读者', extra: '未知' }],
    ['oversized input', { audience: 'a'.repeat(2001) }], ['nonstring input', { audience: 4 }],
  ])('validates %s before execution', async (_name, inputs) => {
    const { service } = setup();
    const created = await service.save(alice, definition());
    await expect(service.snapshot(alice, { skill_id: created.skill_id, skill_inputs: inputs as Record<string, string> }))
      .rejects.toMatchObject({ status: 400 });
  });

  test.each([
    ['unknown tool', (value: SaveWritingSkillInput) => { value.allowed_tools = ['run_shell']; }],
    ['unsupported capability', (value: SaveWritingSkillInput) => { (value.steps[0] as any).capability = 'shell'; }],
    ['cycle', (value: SaveWritingSkillInput) => { value.steps[0]!.depends_on = ['compose']; }],
    ['unknown dependency', (value: SaveWritingSkillInput) => { value.steps[1]!.depends_on = ['missing']; }],
    ['duplicate step', (value: SaveWritingSkillInput) => { value.steps[1]!.id = 'read'; }],
    ['unknown placeholder', (value: SaveWritingSkillInput) => { value.steps[0]!.description = '{{unknown}}'; }],
    ['duplicate parameter', (value: SaveWritingSkillInput) => { value.parameters.push({ ...value.parameters[0]! }); }],
    ['unsafe parameter name', (value: SaveWritingSkillInput) => { value.parameters[0]!.name = 'constructor'; }],
    ['empty acceptance', (value: SaveWritingSkillInput) => { value.acceptance = []; }],
    ['blank name', (value: SaveWritingSkillInput) => { value.name = ' '; }],
    ['executable field', (value: SaveWritingSkillInput) => { (value as any).script = 'shell'; }],
  ])('rejects %s in a saved definition', async (_name, change) => {
    const { service } = setup();
    const value = definition();
    change(value);
    await expect(service.save(alice, value)).rejects.toMatchObject({ status: 400 });
  });
});
