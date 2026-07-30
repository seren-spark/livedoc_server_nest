const pythonBase = process.env.PYTHON_API_BASE_URL ?? 'http://127.0.0.1:8000';
const nestBase = process.env.NEST_API_BASE_URL ?? 'http://127.0.0.1:8001';

interface LoginResponse { token: string }
interface ApiResult { status: number; body: any; text: string }

let failed = false;

async function request(base: string, path: string, init?: RequestInit): Promise<ApiResult> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: response.status, body, text };
}

async function login(base: string): Promise<LoginResponse> {
  const result = await request(base, '/dev/auth/login', jsonInit({
    email: 'alice@livedoc.local',
    password: 'Demo@123456',
  }));
  if (result.status !== 200) throw new Error(`Login failed for ${base}: ${result.status}`);
  return result.body as LoginResponse;
}

function jsonInit(body: unknown, token?: string, method = 'POST'): RequestInit {
  return {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  };
}

function auth(token: string): RequestInit {
  return { headers: { authorization: `Bearer ${token}` } };
}

function compare(name: string, python: unknown, nest: unknown): void {
  const same = JSON.stringify(python) === JSON.stringify(nest);
  console.log(JSON.stringify(same ? { check: name, same } : { check: name, same, python, nest }));
  failed ||= !same;
}

function compareStatus(name: string, python: ApiResult, nest: ApiResult): void {
  compare(name, python.status, nest.status);
}

const [pythonLogin, nestLogin] = await Promise.all([login(pythonBase), login(nestBase)]);

for (const path of ['/health', '/dev/auth/me', '/documents?page=1&page_size=20']) {
  const authenticated = path !== '/health';
  const [python, nest] = await Promise.all([
    request(pythonBase, path, authenticated ? auth(pythonLogin.token) : undefined),
    request(nestBase, path, authenticated ? auth(nestLogin.token) : undefined),
  ]);
  compareStatus(`${path}:status`, python, nest);
  compare(`${path}:keys`, objectKeys(python.body), objectKeys(nest.body));
  if (path === '/dev/auth/me') compare(`${path}:body`, python.body, nest.body);
}

const [pythonSeed, nestSeed] = await Promise.all([
  request(pythonBase, '/dev/seed', jsonInit({}, pythonLogin.token)),
  request(nestBase, '/dev/seed', jsonInit({}, nestLogin.token)),
]);
compareStatus('/dev/seed:status', pythonSeed, nestSeed);
compare('/dev/seed:documents', pythonSeed.body?.documents, nestSeed.body?.documents);

const searchBody = {
  query: 'RAG',
  scope: { private: true, team: true, public: true, document_ids: [] },
  top_k: 5,
  mode: 'hybrid',
  context: '',
};
const [pythonSearch, nestSearch] = await Promise.all([
  request(pythonBase, '/knowledge/search', jsonInit(searchBody, pythonLogin.token)),
  request(nestBase, '/knowledge/search', jsonInit(searchBody, nestLogin.token)),
]);
compareStatus('/knowledge/search:status', pythonSearch, nestSearch);
compare(
  '/knowledge/search:citations',
  normalizeNumbers(pythonSearch.body?.citations),
  normalizeNumbers(nestSearch.body?.citations),
);
compare(
  '/knowledge/search:trace-shape',
  stableTrace(pythonSearch.body?.trace),
  stableTrace(nestSearch.body?.trace),
);

const invalidSearch = { ...searchBody, query_variants: ['browser-bypass'] };
const [pythonInvalid, nestInvalid] = await Promise.all([
  request(pythonBase, '/knowledge/search', jsonInit(invalidSearch, pythonLogin.token)),
  request(nestBase, '/knowledge/search', jsonInit(invalidSearch, nestLogin.token)),
]);
compareStatus('/knowledge/search:unknown-field-status', pythonInvalid, nestInvalid);

const sseBody = {
  intent: 'knowledge_qa',
  query: '仅用于差分验证的无证据问题',
  retrieval_domain: 'current_document',
  stream: true,
  current_context: { title: '空文档' },
};
const [pythonSse, nestSse] = await Promise.all([
  request(pythonBase, '/ai/write', jsonInit(sseBody, pythonLogin.token)),
  request(nestBase, '/ai/write', jsonInit(sseBody, nestLogin.token)),
]);
compareStatus('/ai/write:sse-status', pythonSse, nestSse);
compare('/ai/write:sse-order', eventNames(pythonSse.text), eventNames(nestSse.text));

const docId = `contract_diff_${Date.now()}`;
const createBody = {
  doc_id: docId,
  title: 'Contract Diff',
  content: '权限属性变化必须触发索引版本更新。',
  visibility: 'private',
  index_now: false,
};
const [pythonCreate, nestCreate] = await Promise.all([
  request(pythonBase, '/documents', jsonInit(createBody, pythonLogin.token)),
  request(nestBase, '/documents', jsonInit(createBody, nestLogin.token)),
]);
compareStatus('/documents:create-status', pythonCreate, nestCreate);
compare('/documents:create-body', stableDocument(pythonCreate.body), stableDocument(nestCreate.body));

const [pythonUpdate, nestUpdate] = await Promise.all([
  request(pythonBase, `/documents/${docId}`, jsonInit({ visibility: 'public' }, pythonLogin.token, 'PATCH')),
  request(nestBase, `/documents/${docId}`, jsonInit({ visibility: 'public' }, nestLogin.token, 'PATCH')),
]);
compareStatus('/documents:update-status', pythonUpdate, nestUpdate);
compare('/documents:update-body', stableDocument(pythonUpdate.body), stableDocument(nestUpdate.body));

const [pythonDelete, nestDelete] = await Promise.all([
  request(pythonBase, `/documents/${docId}`, { ...auth(pythonLogin.token), method: 'DELETE' }),
  request(nestBase, `/documents/${docId}`, { ...auth(nestLogin.token), method: 'DELETE' }),
]);
compareStatus('/documents:delete-status', pythonDelete, nestDelete);
compare('/documents:delete-body', pythonDelete.body, nestDelete.body);

process.exitCode = failed ? 1 : 0;

function objectKeys(value: unknown): string[] {
  return value && typeof value === 'object' ? Object.keys(value).sort() : [typeof value];
}

function eventNames(value: string): string[] {
  return [...value.matchAll(/^event: (.+)$/gmu)].map((match) => match[1]!.trim());
}

function stableTrace(value: any): unknown {
  if (!value) return value;
  const {
    trace_id: _traceId,
    retrieval_ms: _retrievalMs,
    rerank_ms: _rerankMs,
    compression_ms: _compressionMs,
    preprocessing_ms: _preprocessingMs,
    total_ms: _totalMs,
    ...stable
  } = value;
  return stable;
}

function stableDocument(value: any): unknown {
  if (!value) return value;
  const { created_at: _createdAt, updated_at: _updatedAt, indexed_at: _indexedAt, ...stable } = value;
  return stable;
}

function normalizeNumbers(value: unknown): unknown {
  if (typeof value === 'number') return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
  if (Array.isArray(value)) return value.map(normalizeNumbers);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, normalizeNumbers(item)]),
    );
  }
  return value;
}
