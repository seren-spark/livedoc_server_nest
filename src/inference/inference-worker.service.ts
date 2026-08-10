import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Worker } from 'node:worker_threads';
import { AppConfig } from '../config/app-config.js';

@Injectable()
export class InferenceWorkerService implements OnModuleDestroy {
  private worker?: Worker;
  private sequence = 0;
  private closing = false;
  private readonly pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }
  >();

  constructor(private readonly config: AppConfig) {}

  async embed(texts: string[]): Promise<number[][]> {
    return this.request('embed', { texts });
  }

  async countEmbeddingTokens(texts: string[]): Promise<number[]> {
    return this.request('count_embedding_tokens', { texts });
  }

  async rerank(query: string, passages: string[]): Promise<number[]> {
    return this.request('rerank', { query, passages });
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    this.rejectPending(new Error('Inference worker is shutting down'));
    await this.worker?.terminate();
    this.worker = undefined;
  }

  private request<T>(type: string, payload: unknown): Promise<T> {
    if (this.pending.size >= this.config.inferenceMaxPending) {
      return Promise.reject(new Error('Inference queue is full; retry later'));
    }
    this.ensureWorker();
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Inference request timed out after ${this.config.inferenceRequestTimeoutSeconds}s`));
      }, this.config.inferenceRequestTimeoutSeconds * 1000);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.worker!.postMessage({ id, type, payload });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private ensureWorker(): void {
    if (this.worker) return;
    const runningTypeScript = import.meta.url.endsWith('.ts');
    const workerFile = runningTypeScript ? './inference.worker.ts' : './inference.worker.js';
    const workerEntry = runningTypeScript
      ? typescriptWorkerEntry(new URL(workerFile, import.meta.url))
      : new URL(workerFile, import.meta.url);
    this.worker = new Worker(workerEntry, {
      workerData: {
        embeddingModel: this.config.embeddingModel,
        rerankModel: this.config.rerankModel,
        dtype: this.config.modelDtype,
        cacheDir: this.config.modelCacheDir,
      },
    });
    this.worker.on('message', (message: { id: number; result?: any; error?: string }) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    });
    this.worker.on('error', (error) => {
      this.rejectPending(error);
      this.worker = undefined;
    });
    this.worker.on('exit', (code) => {
      if (!this.closing) this.rejectPending(new Error(`Inference worker exited with code ${code}`));
      this.worker = undefined;
    });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function typescriptWorkerEntry(target: URL): URL {
  const tsxApi = new URL('../../node_modules/tsx/dist/esm/api/index.mjs', import.meta.url);
  const bootstrap = [
    `import { register } from ${JSON.stringify(tsxApi.href)};`,
    'register();',
    `await import(${JSON.stringify(target.href)});`,
  ].join('\n');
  return new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`);
}
