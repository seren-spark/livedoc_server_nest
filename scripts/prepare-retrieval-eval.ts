import 'reflect-metadata';
import { readFileSync, writeFileSync } from 'node:fs';
import { AppConfig } from '../src/config/app-config.js';
import { EmbeddingService } from '../src/inference/embedding.service.js';
import { InferenceWorkerService } from '../src/inference/inference-worker.service.js';
import { prepareEmbeddingChunks } from '../src/retrieval/embedding-chunks.js';
import { fingerprint, validateAssets, validateRetrievalLabels, type Json } from '../src/evaluation/rag-evaluation.js';

const readLines = (path: string): Json[] => readFileSync(path, 'utf8').replace(/^\uFEFF/u, '').trim().split(/\r?\n/u).map(line => JSON.parse(line));
const corpus = readLines('evals/rag_corpus.jsonl'), cases = readLines('evals/rag_cases.jsonl');
for (const doc of corpus) {
  const content = readFileSync(`evals/corpus/${doc.doc_id}.md`, 'utf8');
  if (!process.argv.includes('--write') && doc.content !== content) throw new Error(`原文已变更但尚未更新冻结语料：${doc.doc_id}`);
  doc.content = content;
}
validateAssets(corpus, cases);
const config = new AppConfig();
if (config.runtimeMode !== 'real' || config.embeddingProvider !== 'transformers') throw new Error('冻结分块必须使用真实生产 tokenizer');
const worker = new InferenceWorkerService(config), embeddings = new EmbeddingService(config, worker);
try {
  const chunks: Json[] = [];
  for (const doc of corpus) {
    const prepared = await prepareEmbeddingChunks(doc.doc_id, doc.title, doc.content, config, embeddings);
    chunks.push(...prepared.chunks.map((chunk, i) => ({ ...chunk, passage: prepared.passages[i] })));
  }
  const normalize = (value: string) => value.normalize('NFKC').replace(/\s/gu, '').toLowerCase();
  const annotated = cases.map(c => {
    if (!c.annotation_version || !Array.isArray(c.evidence_groups)) throw new Error(`缺少逐题证据标注：${c.case_id}`);
    const labels = new Map<string, number>();
    for (const group of c.evidence_groups) {
      let matched = false;
      for (const alternative of group.alternatives) {
        const source = chunks.filter(chunk => chunk.doc_id === alternative.doc_id);
        if (!alternative.quotes.every((quote: string) => source.some(chunk => normalize(chunk.content).includes(normalize(quote))))) continue;
        for (const chunk of source.filter(chunk => alternative.quotes.some((quote: string) => normalize(chunk.content).includes(normalize(quote))))) {
          labels.set(chunk.chunk_id, 1); matched = true;
        }
      }
      if (!matched) throw new Error(`必要证据无法由完整 Chunk 覆盖：${c.case_id}/${group.id}`);
    }
    return { ...c, chunk_qrels: [...labels].map(([chunk_id, score]) => ({ chunk_id, score })) };
  });
  const corpusIdentity = corpus.map(d => ({ doc_id: d.doc_id, title: d.title, content: d.content, visibility: d.visibility ?? 'private',
    source_type: d.source_type ?? 'article', team_id: d.team_id ?? null, tags: d.tags ?? [] }));
  const manifest = { schema_version: 1, dataset_version: 'retrieval-v2-longform', annotation_status: 'synthetic_curated',
    corpus_sha256: fingerprint(corpusIdentity), dataset_sha256: fingerprint(annotated),
    chunking: { max_tokens: config.chunkMaxTokens, overlap_tokens: config.chunkOverlapTokens, embedding_model: config.embeddingModel },
    chunks, limitation: '合成长文用于检索回归，仍需真实业务题集校准；候选不足 20 的权限范围单独保留实际候选数量。' };
  validateRetrievalLabels(corpus, annotated, manifest);
  if (process.argv.includes('--write')) {
    writeFileSync('evals/rag_corpus.jsonl', corpus.map(d => JSON.stringify(d)).join('\n') + '\n');
    writeFileSync('evals/rag_cases.jsonl', annotated.map(c => JSON.stringify(c)).join('\n') + '\n');
    writeFileSync('evals/rag_chunks.json', JSON.stringify(manifest, null, 2) + '\n');
  } else {
    const frozen = JSON.parse(readFileSync('evals/rag_chunks.json', 'utf8'));
    if (fingerprint(frozen) !== fingerprint(manifest)) throw new Error('分块或标注变化，核对后显式 --write 更新版本');
  }
  console.log(JSON.stringify({ documents: corpus.length, questions: annotated.length, chunks: chunks.length,
    labeled_questions: annotated.filter(c => c.chunk_qrels.length).length, dataset_sha256: manifest.dataset_sha256 }, null, 2));
} finally { await worker.onModuleDestroy(); }
