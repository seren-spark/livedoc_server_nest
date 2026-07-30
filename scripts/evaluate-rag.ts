import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readJsonLines(path: string): unknown[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line) as unknown;
      } catch (error) {
        throw new Error(`${path}:${index + 1} is invalid JSON: ${String(error)}`);
      }
    });
}

const baselineRoot = resolve(argument('--baseline-root') ?? '../livedoc_server');
const corpusPath = resolve(baselineRoot, 'evals/rag_corpus.jsonl');
const casesPath = resolve(baselineRoot, 'evals/rag_cases.jsonl');
if (!existsSync(corpusPath) || !existsSync(casesPath)) {
  throw new Error(`Evaluation assets are missing under ${baselineRoot}/evals`);
}
const corpus = readJsonLines(corpusPath);
const cases = readJsonLines(casesPath);
if (corpus.length !== 18 || cases.length !== 60) {
  throw new Error(`Expected 18 corpus documents and 60 cases, got ${corpus.length} and ${cases.length}`);
}
if (process.argv.includes('--validate-only')) {
  console.log(JSON.stringify({ status: 'valid', corpus_documents: corpus.length, cases: cases.length }));
  process.exit(0);
}

throw new Error(
  'Real evaluation is intentionally gated. Configure MySQL, Qdrant, Transformers.js BGE models and LLM, then use contract-diff.ts and the baseline evaluator.',
);
