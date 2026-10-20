import { randomUUID } from 'node:crypto';

const base = 'http://127.0.0.1:8001';
async function json(path, options) {
  const response = await fetch(base + path, options);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}
const health = await json('/health');
if (health.runtime_mode !== 'real' || health.metadata_store !== 'mysql') throw new Error('Expected real MySQL runtime');
console.log(JSON.stringify({ health: health.status, runtime: health.runtime_mode, model: health.llm_model, metadata: health.metadata_store }));
const login = await json('/dev/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'alice@livedoc.local', password: 'Demo@123456' }) });
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}`, Origin: 'http://127.0.0.1:5178' };
try {
  for (const query of ['今天天气怎么样', '请把当前段落中拼写错误的 LievDoc 改为 LiveDoc，其他内容保持不变。']) {
    const text = 'LievDoc 是一个文档工作台。';
    const node = { type: 'paragraph', content: [{ type: 'text', text }] };
    const snapshot = { identity: { kind: 'unsaved', local_id: 'runtime-smoke' }, title: '运行验证', json: { type: 'doc', content: [node] }, revision: 0, hash: 'runtime-smoke', selection: { text: '', inline: true, region_ids: ['b0'] }, regions: [{ id: 'b0', type: 'paragraph', text, markdown: text, heading_path: [], original_json: node }] };
    const response = await fetch(base + '/ai/agent', { method: 'POST', headers, signal: AbortSignal.timeout(120000), body: JSON.stringify({ request_id: randomUUID(), conversation_id: randomUUID(), mode: 'agent', output_target: 'current_document', query, deep_thinking: false, allow_web: false, editor_snapshot: snapshot, references: [] }) });
    if (!response.ok) throw new Error(`Agent: HTTP ${response.status}`);
    const transcript = await response.text();
    const frames = transcript.split('\n\n').filter(frame => frame.startsWith('event:')).map(frame => ({ event: frame.split('\n')[0].slice(7), data: JSON.parse(frame.split('\ndata: ')[1]) }));
    const result = frames.find(frame => frame.event === 'result')?.data.result;
    if (!result) throw new Error(frames.find(frame => frame.event === 'error')?.data.message || 'No complete agent result');
    if (query === '今天天气怎么样' && !['answer', 'clarification'].includes(result.kind)) throw new Error('Weather question must not edit the document');
    if (query !== '今天天气怎么样' && (result.kind !== 'edits' || !result.edits.some(edit => edit.content_markdown?.includes('LiveDoc')))) throw new Error('Expected an actual correction suggestion');
    console.log(JSON.stringify({ query, result, state: frames.find(frame => frame.event === 'done')?.data.status, cors: response.headers.get('access-control-allow-origin') }));
  }
} finally {
  await fetch(base + '/dev/auth/logout', { method: 'POST', headers });
}
