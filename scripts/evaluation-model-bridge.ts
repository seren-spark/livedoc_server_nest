import 'reflect-metadata';
import { createServer } from 'node:http';
import { AppConfig } from '../src/config/app-config.js';
import { InferenceWorkerService } from '../src/inference/inference-worker.service.js';
import { EmbeddingService } from '../src/inference/embedding.service.js';
import { prepareEmbeddingChunks } from '../src/retrieval/embedding-chunks.js';

// Temporary localhost adapter for official EvalScope API models. Real provider keys stay here.
const config = new AppConfig();
if (config.runtimeMode !== 'real' || config.embeddingProvider !== 'transformers' || config.rerankProvider !== 'bge')
  throw new Error('框架评测要求真实 Embedding 和 BGE 模型');
const token = process.env.LIVEDOC_EVAL_BRIDGE_TOKEN;
if (!token || token.length < 32) throw new Error('缺少本次评测的临时认证令牌');
const worker = new InferenceWorkerService(config), embeddings = new EmbeddingService(config, worker);
const calls = { embeddings: 0, rerank: 0, judge: 0 };
const server = createServer(async (request, reply) => {
  const send = (status: number, value: unknown) => { reply.writeHead(status, { 'Content-Type': 'application/json' }); reply.end(JSON.stringify(value)); };
  if (request.headers.authorization !== `Bearer ${token}`) { send(401, { error: 'unauthorized' }); return; }
  try {
    if (request.url === '/metadata') {
      send(200, { embedding_model: config.embeddingModel, rerank_model: config.rerankModel,
        judge_model: config.agentCriticModel, dimensions: config.embeddingDim, config_fingerprint: config.configFingerprint, calls }); return;
    }
    if (request.method !== 'POST') { send(405, { error: 'POST required' }); return; }
    let bytes = 0; const parts: Buffer[] = [];
    for await (const part of request) { bytes += part.length; if (bytes > 8 * 1024 * 1024) throw new Error('请求过大'); parts.push(part); }
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (request.url === '/prepare-corpus') {
      if (!Array.isArray(body.documents)) throw new Error('缺少语料');
      const result = [];
      for (const doc of body.documents) {
        if (typeof doc.doc_id !== 'string' || typeof doc.title !== 'string' || typeof doc.content !== 'string') throw new Error('语料参数无效');
        const prepared = await prepareEmbeddingChunks(doc.doc_id, doc.title, doc.content, config, embeddings);
        result.push(...prepared.chunks.map((chunk, i) => ({ ...chunk, passage: prepared.passages[i] })));
      }
      send(200, { chunks: result }); return;
    }
    if (request.url === '/v1/embeddings') {
      const input = typeof body.input === 'string' ? [body.input] : body.input;
      if (!Array.isArray(input) || !input.length || input.length > 128 || input.some(x => typeof x !== 'string')) throw new Error('Embedding input 无效');
      const vectors = await embeddings.embedBatch(input); calls.embeddings++;
      const tokenCount = (await embeddings.countTokens(input)).reduce((sum, count) => sum + count, 0);
      send(200, { object: 'list', model: config.embeddingModel, data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })), usage: { prompt_tokens: tokenCount, total_tokens: tokenCount } }); return;
    }
    if (request.url === '/v1/rerank') {
      if (typeof body.query !== 'string' || !Array.isArray(body.documents) || body.documents.some((d: unknown) => typeof d !== 'string')) throw new Error('重排参数无效');
      const scores = await worker.rerank(body.query, body.documents); calls.rerank++;
      send(200, { results: scores.map((relevance_score, index) => ({ index, relevance_score })) }); return;
    }
    if (request.url === '/v1/chat/completions') {
      if (!config.llmApiKey || !Array.isArray(body.messages)) throw new Error('核验模型未配置或请求无效');
      const upstream = await fetch(`${config.llmBaseUrl}/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${config.llmApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, ...config.llmToolCallExtraBody, ...config.thinkingOffBody,
          model: config.agentCriticModel, stream: false, max_tokens: Math.min(Number(body.max_tokens ?? body.max_completion_tokens ?? 4096), 8192), max_completion_tokens: undefined }),
        signal: AbortSignal.timeout(60000),
      });
      calls.judge++;
      if (!upstream.ok) { await upstream.body?.cancel(); send(upstream.status, { error: { message: '核验模型请求失败', type: 'upstream_error' } }); return; }
      const result = await upstream.json() as any;
      for (const choice of result.choices ?? []) if (choice.message) delete choice.message.reasoning_content;
      send(200, result); return;
    }
    send(404, { error: 'unknown endpoint' });
  } catch { send(500, { error: { message: '评测模型调用失败，请检查参数和模型配置', type: 'evaluation_error' } }); }
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') process.stdout.write(`LIVEDOC_EVAL_BRIDGE=${JSON.stringify({ port: address.port })}\n`);
});
async function close() { server.close(); await worker.onModuleDestroy(); process.exit(0); }
process.on('SIGTERM', () => void close());
process.on('SIGINT', () => void close());
// The runner closes stdin in its finally block, including on Windows, to release the worker.
process.stdin.resume(); process.stdin.on('end', () => void close());
