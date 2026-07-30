import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Worker } from 'node:worker_threads';
import { AppConfig } from '../config/app-config.js';

@Injectable()
export class InferenceWorkerService implements OnModuleDestroy {
  private worker?: Worker;
  private sequence = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();

  constructor(private readonly config: AppConfig) {}

  async embed(texts: string[]): Promise<number[][]> {
    return this.request('embed', { texts });
  }

  async rerank(query: string, passages: string[]): Promise<number[]> {
    return this.request('rerank', { query, passages });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.terminate();
  }

  private request<T>(type: string, payload: unknown): Promise<T> {
    this.ensureWorker();
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ id, type, payload });
    });
  }

  private ensureWorker(): void {
    if (this.worker) return;
    const workerFile = import.meta.url.endsWith('.ts') ? './inference.worker.ts' : './inference.worker.js';
    this.worker = new Worker(new URL(workerFile, import.meta.url), {
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
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    });
    this.worker.on('error', (error) => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.worker = undefined;
    });
  }
}
