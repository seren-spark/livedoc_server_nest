import { ConflictException } from '@nestjs/common';
import type { DocumentMemoryUpdateDto } from '../src/common/dto.js';
import type { AccessContext } from '../src/common/types.js';
import { ConversationMemoryService } from '../src/ai/memory.service.js';
import { AppConfig } from '../src/config/app-config.js';
import type { DocumentRecord } from '../src/documents/document.types.js';
import { DocumentMemoryService } from '../src/documents/document-memory.service.js';
import { DocumentMemoryJobsService } from '../src/documents/document-memory-jobs.service.js';

const alice: AccessContext = {
  user_id: 'alice',
  space_id: 'space-a',
  team_ids: [],
};

function memoryConfig(overrides: Record<string, unknown> = {}): AppConfig {
  const config = new AppConfig();
  Object.assign(config as unknown as Record<string, unknown>, {
    memoryMaxTurns: 6,
    shortMemoryTokenBudget: 4000,
    documentMemoryEnabled: true,
    documentMemoryTokenBudget: 500,
    documentMemoryMinConfidence: 0.7,
    ...overrides,
  });
  return config;
}

function inMemoryDatabase() {
  return { memoryEnabled: false } as never;
}

function document(version = 1): DocumentRecord {
  const now = new Date('2026-08-24T00:00:00.000Z');
  return {
    doc_id: 'doc-1',
    space_id: 'space-a',
    title: 'LiveDoc 设计',
    content: '# 约定\n\nLiveDoc 使用双层记忆。',
    visibility: 'private',
    source_type: 'draft',
    tags: [],
    team_id: null,
    owner_id: 'alice',
    url: null,
    editor_content: null,
    source_import_id: null,
    document_version: version,
    index_status: 'pending',
    active_index_version: null,
    latest_index_job_id: null,
    chunk_count: 0,
    indexed_at: null,
    index_error: null,
    created_at: now,
    updated_at: now,
  };
}

describe('ConversationMemoryService', () => {
  test('keeps six complete turns and isolates by user, space, and document', async () => {
    const memory = new ConversationMemoryService(memoryConfig(), inMemoryDatabase());
    for (let index = 1; index <= 7; index += 1) {
      await memory.addTurn('conversation-1', `question-${index}`, `answer-${index}`, alice, 'doc-1');
    }

    const recent = await memory.recentText('conversation-1', alice, 'doc-1');
    expect(recent).not.toContain('question-1');
    expect(recent).toContain('question-2\nassistant: answer-2');
    expect(recent).toContain('question-7\nassistant: answer-7');
    expect(recent.match(/^user:/gmu)).toHaveLength(6);

    expect(await memory.recentText('conversation-1', alice, 'doc-2')).toBe('');
    expect(await memory.recentText('conversation-1', { ...alice, user_id: 'bob' }, 'doc-1')).toBe('');
    expect(await memory.recentText('conversation-1', { ...alice, space_id: 'space-b' }, 'doc-1')).toBe('');
  });

  test('never splits a question/answer pair when the injection budget is reached', async () => {
    const memory = new ConversationMemoryService(
      memoryConfig({ shortMemoryTokenBudget: 18 }),
      inMemoryDatabase(),
    );
    await memory.addTurn('budget', 'short question', 'short answer', alice, 'doc-1');
    await memory.addTurn('budget', 'very long '.repeat(40), 'very long answer '.repeat(40), alice, 'doc-1');

    const recent = await memory.recentText('budget', alice, 'doc-1');
    expect(recent).toBe('user: short question\nassistant: short answer');
  });
});

describe('DocumentMemoryService', () => {
  test('filters low confidence, preserves user locks, and suppresses deleted semantic keys', async () => {
    const service = new DocumentMemoryService(memoryConfig(), inMemoryDatabase());
    const source = document(1);
    const evidence = new Map([
      ['hash-1', { hash: 'hash-1', anchor: '约定', snippet: 'LiveDoc 使用双层记忆。' }],
    ]);

    const extracted = await service.applyExtraction({
      document: source,
      currentHashes: ['hash-1'],
      fullExtraction: true,
      evidenceByHash: evidence,
      extracted: {
        glossary: [
          { term: '双层记忆', definition: '短期会话记忆与长期文档记忆。', confidence: 0.95, evidence_hashes: ['hash-1'] },
          { term: '猜测项', definition: '不可靠。', confidence: 0.4, evidence_hashes: ['hash-1'] },
        ],
        style_tags: [{ label: '技术说明', instruction: '使用准确、简洁的中文。', confidence: 0.88, evidence_hashes: ['hash-1'] }],
        global_settings: [{ key: '产品名', value: '统一写作 LiveDoc。', confidence: 0.92, evidence_hashes: ['hash-1'] }],
      },
    });
    expect(extracted.glossary.map((item) => item.term)).toEqual(['双层记忆']);

    const edited = await service.updateByUser(source, {
      expected_memory_version: extracted.memory_version,
      glossary: [{ id: extracted.glossary[0]!.id, term: '双层记忆', definition: '最近六轮 + 文档长期设定。', aliases: [] }],
      style_tags: extracted.style_tags.map((item) => ({ id: item.id, label: item.label, instruction: item.instruction })),
      global_settings: [],
    } as DocumentMemoryUpdateDto);
    expect(edited.glossary[0]).toMatchObject({ origin: 'user', pinned: true, confidence: 1 });
    expect(edited.style_tags[0]).toMatchObject({ origin: 'auto', pinned: false });
    expect(edited.suppressed_keys).toContain('setting:产品名');

    const refreshed = await service.applyExtraction({
      document: document(2),
      currentHashes: ['hash-1'],
      fullExtraction: true,
      evidenceByHash: evidence,
      extracted: {
        glossary: [{ term: '双层记忆', definition: '模型试图覆盖。', confidence: 0.99, evidence_hashes: ['hash-1'] }],
        style_tags: [],
        global_settings: [{ key: '产品名', value: '模型试图恢复。', confidence: 0.99, evidence_hashes: ['hash-1'] }],
      },
    });
    expect(refreshed.glossary[0]!.definition).toBe('最近六轮 + 文档长期设定。');
    expect(refreshed.global_settings).toEqual([]);
    expect(await service.promptText('doc-1', 1, '双层记忆是什么')).toBe('');
    expect(await service.promptText('doc-1', 2, '双层记忆是什么')).toContain('最近六轮 + 文档长期设定。');
  });

  test('rejects stale memory edits with an optimistic-lock conflict', async () => {
    const service = new DocumentMemoryService(memoryConfig(), inMemoryDatabase());
    const source = document();
    await service.markPending(source);
    await expect(service.updateByUser(source, {
      expected_memory_version: 9,
      glossary: [],
      style_tags: [],
      global_settings: [],
    } as DocumentMemoryUpdateDto)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('DocumentMemoryJobsService', () => {
  test('deduplicates jobs and supersedes stale version or extraction mode', async () => {
    const config = memoryConfig({ documentMemoryMaxAttempts: 3 });
    const profiles = new DocumentMemoryService(config, inMemoryDatabase());
    const jobs = new DocumentMemoryJobsService(config, inMemoryDatabase(), profiles);

    const incremental = await jobs.enqueue(document(1), alice, false);
    expect((await jobs.enqueue(document(1), alice, false))?.job_id).toBe(incremental?.job_id);

    const full = await jobs.enqueue(document(1), alice, true);
    expect(full?.job_id).not.toBe(incremental?.job_id);
    const claimedFull = await jobs.claimNext('worker-1');
    expect(claimedFull).toMatchObject({ job_id: full?.job_id, force_full: true, attempts: 1 });
    expect(await jobs.isActive(claimedFull!)).toBe(true);

    const latest = await jobs.enqueue(document(2), alice, false);
    expect(await jobs.isActive(claimedFull!)).toBe(false);
    const claimedLatest = await jobs.claimNext('worker-2');
    expect(claimedLatest).toMatchObject({ job_id: latest?.job_id, document_version: 2 });
    expect(await jobs.fail({ ...claimedLatest!, attempts: 3 }, 'terminal failure')).toBe(true);
  });
});
