import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const base = 'http://127.0.0.1:8001';
const health = await (await fetch(base + '/health')).json();
assert.equal(health.runtime_mode, 'real');
const loginResponse = await fetch(base + '/dev/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'bob@livedoc.local', password: 'Demo@123456' }) });
assert(loginResponse.ok);
const { token } = await loginResponse.json();
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
try {
  const node = { type: 'paragraph', content: [] };
  const response = await fetch(base + '/ai/agent', { method: 'POST', headers, signal: AbortSignal.timeout(300000), body: JSON.stringify({
    request_id: randomUUID(), conversation_id: randomUUID(), mode: 'agent', output_target: 'new_document',
    query: '写一篇约600字的RAG评测入门文章，说明检索与生成的主要指标、常见误区和实践步骤。面向后端工程师，仅基于通用概念，不联网，不检索外部资料。',
    deep_thinking: false, allow_web: false, references: [],
    editor_snapshot: { identity: { kind: 'unsaved', local_id: randomUUID() }, title: '', json: { type: 'doc', content: [node] }, revision: 0, hash: 'format-check', selection: { text: '', inline: true, region_ids: ['b0'] }, regions: [{ id: 'b0', type: 'paragraph', heading_path: [], text: '', markdown: '', original_json: node }] },
  }) });
  assert(response.ok, `HTTP ${response.status}`);
  const transcript = await response.text();
  const frames = transcript.split('\n\n').filter(frame => frame.startsWith('event:')).map(frame => ({ event: frame.split('\n')[0].slice(7), data: JSON.parse(frame.split('\ndata: ')[1]) }));
  const result = frames.find(frame => frame.event === 'result')?.data.result;
  assert(result, frames.find(frame => frame.event === 'error')?.data.message || 'No complete result');
  assert.equal(result.kind, 'document');
  assert.match(result.markdown, /\|[ :\-|]+\|/);
  assert.match(result.markdown, /==[^=\n]+==/);
  assert.match(result.markdown, /\*\*[^*]+\*\*/);
  const file = fileURLToPath(new URL('../../docs/agent-format-model-sample.md', import.meta.url));
  await writeFile(file, result.markdown);
  console.log(JSON.stringify({ model: health.llm_model, source: 'real', table: true, highlight: true, emphasis: true, file, toolCalls: frames.filter(frame => frame.event === 'tool_start').length }));
} finally { await fetch(base + '/dev/auth/logout', { method: 'POST', headers }); }
