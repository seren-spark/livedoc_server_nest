import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { QdrantClient } from '@qdrant/js-client-rest';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { AppConfig } from '../src/config/app-config.js';
import { CURRENT_SCHEMA_VERSION } from '../src/database/migration-version.js';
import { formatSchemaProblems, inspectSchemaContract } from '../src/database/schema-contract.js';
import { InferenceWorkerService } from '../src/inference/inference-worker.service.js';

type Probe = { name: string; ok: boolean; detail: string; fix?: string };
type OpenAiProbeBody = {
  choices?: Array<{ message?: {
    content?: string;
    tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
  } }>;
  error?: { message?: string };
};

const config = new AppConfig();
const probes: Probe[] = [];
const live = process.argv.includes('--live');

function add(name: string, ok: boolean, detail: string, fix?: string) {
  probes.push({ name, ok, detail, ...(!ok && fix ? { fix } : {}) });
}

function fixFor(name: string) {
  return `${name} 请修改 ${config.envFile}；配置完成后运行 npm run config:check:live。`;
}

async function probeMySql() {
  if (!config.databaseUrl) return add('mysql', false, 'DATABASE_URL 为空', fixFor('DATABASE_URL'));
  let connection: mysql.Connection | undefined;
  try {
    connection = await mysql.createConnection(config.databaseUrl);
    await connection.query('SELECT 1 AS ok');
    const schemaProblems = await inspectSchemaContract(async <T = Record<string, unknown>>(
      sql: string,
      params: unknown[] = [],
    ) => {
      const [rows] = await connection!.query<RowDataPacket[]>(sql, params);
      return rows as T[];
    });
    if (schemaProblems.length) {
      return add(
        'mysql',
        false,
        `schema contract failed: ${formatSchemaProblems(schemaProblems)}`,
        `${fixFor('MySQL migration')} Run npm run db:migrate, then rerun the live check.`,
      );
    }
    const [tables] = await connection.query<RowDataPacket[]>('SHOW TABLES');
    const required = ['schema_migrations', 'knowledge_documents', 'index_jobs', 'document_imports', 'rag_traces'];
    const names = new Set(tables.map((row) => String(Object.values(row)[0])));
    const missing = required.filter((table) => !names.has(table));
    if (missing.length) {
      return add(
        'mysql',
        false,
        `SELECT 1 成功，但缺少表：${missing.join(', ')}`,
        `${fixFor('MySQL migration')} 启动 Nest API 运行 migration，或确认 DATABASE_URL 指向 LiveDoc Nest 数据库。`,
      );
    }
    const [versions] = await connection.query<RowDataPacket[]>(
      'SELECT version FROM schema_migrations WHERE version=?',
      [CURRENT_SCHEMA_VERSION],
    );
    if (!versions.length) {
      return add(
        'mysql',
        false,
        `migration 版本不是 ${CURRENT_SCHEMA_VERSION}`,
        `${fixFor('MySQL migration')} 启动 API 让版本化 migration 完成。`,
      );
    }
    add('mysql', true, `SELECT 1 成功；migration=${CURRENT_SCHEMA_VERSION}；tables=${tables.length}`);
  } catch (error) {
    add('mysql', false, String(error), `${fixFor('MySQL')} 启动 MySQL 并确认 DATABASE_URL 可从本机 TCP 访问。`);
  } finally {
    await connection?.end().catch(() => undefined);
  }
}

async function probeQdrant() {
  const client = new QdrantClient({
    url: config.qdrantUrl,
    ...(config.qdrantApiKey ? { apiKey: config.qdrantApiKey } : {}),
    checkCompatibility: false,
  });
  try {
    const info = await client.getCollection(config.qdrantCollection);
    const dense = (info.config as any)?.params?.vectors?.dense;
    const sparse = (info.config as any)?.params?.sparse_vectors?.sparse;
    const size = Number(dense?.size ?? 0);
    if (size !== config.embeddingDim) {
      return add(
        'qdrant',
        false,
        `dense 维度为 ${size}，期望 ${config.embeddingDim}`,
        `${fixFor('Qdrant')} 新建/重建 collection ${config.qdrantCollection}，dense size 必须为 ${config.embeddingDim}。`,
      );
    }
    if (sparse?.modifier !== 'idf') {
      return add(
        'qdrant',
        false,
        `sparse modifier 为 ${String(sparse?.modifier ?? 'missing')}，必须是 idf`,
        `${fixFor('Qdrant')} collection sparse modifier 使用 idf。`,
      );
    }
    add('qdrant', true, `collection ${config.qdrantCollection} dense=${size} sparse=idf`);
  } catch (error) {
    add('qdrant', false, String(error), `${fixFor('Qdrant')} 启动 Qdrant，并确认 URL/API Key/collection 可访问。`);
  }
}

async function probeModels() {
  const worker = new InferenceWorkerService(config);
  try {
    const vector = (await worker.embed(['LiveDoc 真实 BGE embedding 探针']))[0] ?? [];
    const nonZero = vector.some((value) => Math.abs(Number(value)) > 1e-8);
    add(
      'bge-embedding',
      vector.length === config.embeddingDim && nonZero,
      `输出维度=${vector.length}，非零=${nonZero}`,
      `${fixFor('BGE embedding')} 当前模型 ${config.embeddingModel} 的输出维度必须和 EMBEDDING_DIM=${config.embeddingDim} 一致。`,
    );
    const tokenCounts = await worker.countEmbeddingTokens([
      'LiveDoc BGE tokenizer 真实预算探针。'.repeat(32),
    ]);
    const tokenCount = tokenCounts[0] ?? 0;
    add(
      'bge-tokenizer',
      Number.isInteger(tokenCount) && tokenCount > 0,
      `真实 tokenizer 输出=${tokenCount} tokens；Chunk 上限=${config.chunkMaxTokens}`,
      `${fixFor('BGE tokenizer')} 检查 ${config.embeddingModel} tokenizer 文件是否完整。`,
    );
    const scores = await worker.rerank('知识库检索', ['这是与知识库检索相关的片段', '完全无关的天气片段']);
    const valid = scores.length === 2 && scores.every((value) => Number.isFinite(value));
    add('bge-reranker', valid, `scores=${scores.map((value) => Number(value).toFixed(4)).join(',')}`, `${fixFor('BGE reranker')} 安装模型依赖并允许下载 ${config.rerankModel}。`);
  } catch (error) {
    add('bge-models', false, String(error), `${fixFor('BGE models')} 检查 MODEL_CACHE_DIR、网络和 Transformers.js 模型缓存。`);
  } finally {
    await worker.onModuleDestroy();
  }
}

async function probeDocling() {
  const script = resolve(config.projectRoot, config.doclingScript);
  if (!existsSync(script)) return add('docling', false, `脚本不存在：${script}`, `${fixFor('DOCLING_SCRIPT')} 保持为 scripts/docling_parse.py。`);
  await new Promise<void>((done) => {
    const child = spawn(config.doclingPython, [script, '--probe'], {
      cwd: config.projectRoot,
      windowsHide: true,
      env: {
        ...process.env,
        OPENBLAS_NUM_THREADS: String(config.doclingNumThreads),
        OMP_NUM_THREADS: String(config.doclingNumThreads),
        MKL_NUM_THREADS: String(config.doclingNumThreads),
        NUMEXPR_NUM_THREADS: String(config.doclingNumThreads),
      },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    const timeout = setTimeout(() => {
      child.kill();
      add('docling', false, '探针超时', `${fixFor('Docling')} 安装 requirements-docling.txt，并确认 DOCLING_PYTHON 指向对应 Python。`);
      done();
    }, 120_000);
    child.on('error', (error) => {
      clearTimeout(timeout);
      add('docling', false, String(error), `${fixFor('Docling')} 安装 requirements-docling.txt，并确认 DOCLING_PYTHON 路径。`);
      done();
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      add('docling', code === 0, output.trim() || `exit=${code}`, `${fixFor('Docling')} 安装 requirements-docling.txt，并确认 RapidOCR 可导入。`);
      done();
    });
  });
}

async function probeOpenAi() {
  if (!config.llmApiKey) return add('openai', false, 'LLM_API_KEY 为空', `${fixFor('LLM_API_KEY')} 填入 OpenAI-compatible API Key；不要提交到 git。`);
  try {
    const response = await fetch(`${config.llmBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.llmApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...config.llmToolCallExtraBody,
        model: config.llmModel,
        messages: [{ role: 'user', content: 'Call the probe tool.' }],
        tools: [{
          type: 'function',
          function: {
            name: 'livedoc_config_probe',
            description: 'Validate that Function Call is available.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
        }],
        tool_choice: 'required',
        max_tokens: 32,
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(config.llmTimeoutSeconds * 1000),
    });
    const body = await response.json().catch(() => ({})) as OpenAiProbeBody;
    const toolCall = body.choices?.[0]?.message?.tool_calls?.[0]?.function;
    const functionCallOk = response.ok && toolCall?.name === 'livedoc_config_probe';
    const detail = response.ok
      ? `status=${response.status}, function_call=${JSON.stringify(toolCall?.name ?? '')}`
      : `status=${response.status}, error=${body.error?.message ?? 'request failed'}`;
    add('openai', functionCallOk, detail, `${fixFor('OpenAI')} 确认模型名 ${config.llmModel} 对账户可用，且 Key 有余额/权限。`);
  } catch (error) {
    add('openai', false, String(error), `${fixFor('OpenAI')} 检查网络、LLM_BASE_URL、LLM_MODEL 和 API Key。`);
  }
}

console.log(JSON.stringify({ ...config.summary(), live }, null, 2));
const invalid = config.realMisconfigurations();
if (invalid.length) {
  for (const item of invalid) add('config', false, `${item} 未配置或不合法`, fixFor(item));
}
if (live) {
  // Model and Docling probes are intentionally sequential. Running ONNX and
  // OpenBLAS initialization together creates an artificial local memory spike
  // and can make a healthy real configuration fail with `bad allocation`.
  await probeMySql();
  await probeQdrant();
  await probeModels();
  await probeDocling();
  await probeOpenAi();
}
if (!live) {
  console.log('Static configuration check complete. Use npm run config:check:live for real dependency probes.');
}
console.log(JSON.stringify({ probes }, null, 2));
if (invalid.length || probes.some((probe) => !probe.ok)) process.exitCode = 1;
