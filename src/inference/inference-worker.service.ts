/**
 * @file 推理线程桥接。将分词、Embedding 和重排请求发送到 Worker Thread，避免阻塞 API 线程。
 */
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

  /**
   * 初始化实例依赖与本地状态。
   *
   * @param config 应用运行配置。
   */
  constructor(private readonly config: AppConfig) {}

  /**
   * 向 worker 线程发送 embed 任务
   * @param texts The texts to embed.
   * @returns The embeddings for each text.
   */
  async embed(texts: string[]): Promise<number[][]> {
    return this.request('embed', { texts });
  }

  /**
   * 使用 Embedding 模型分词器计算输入长度。
   *
   * @param texts 需要批量处理的文本列表。
   * @returns 计算得到的数值向量或评分列表。
   */
  async countEmbeddingTokens(texts: string[]): Promise<number[]> {
    return this.request('count_embedding_tokens', { texts });
  }
  /**
   * 向 worker 线程发送 rerank 任务
   * @param query 用户查询
   * @param passages 候选文档列表
   * @returns The rerank scores for each passage
   */
  async rerank(query: string, passages: string[]): Promise<number[]> {
    return this.request('rerank', { query, passages });
  }

  /**
   * 在模块关闭时停止后台工作并释放连接与资源。
   */
  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    this.rejectPending(new Error('Inference worker is shutting down'));
    await this.worker?.terminate();
    this.worker = undefined;
  }

  /**
   * 检查推理队列容量，发送带序号的线程消息，并等待结果或超时。
   *
   * @param type 当前数据或节点类型。
   * @param payload 需要传递或持久化的业务数据。
   * @returns T 类型的处理结果。
   */
  private request<T>(type: string, payload: unknown): Promise<T> {
    if (this.pending.size >= this.config.inferenceMaxPending) {
      return Promise.reject(new Error('Inference queue is full; retry later'));
    }
    // 确保 worker 线程已启动
    this.ensureWorker();
    // 生成唯一请求 ID
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Inference request timed out after ${this.config.inferenceRequestTimeoutSeconds}s`));
      }, this.config.inferenceRequestTimeoutSeconds * 1000);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        // 发送请求
        this.worker!.postMessage({ id, type, payload });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * 在首次需要推理时创建 Worker，并注册消息与退出处理。
   */
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

  /**
   * 拒绝尚未结束的推理请求，避免线程退出后请求一直等待。
   *
   * @param error 本次操作捕获的异常。
   */
  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

/**
 * 生成能够加载 TypeScript 推理入口的 Worker 启动代码。
 *
 * @param target 本次操作或定位的目标。
 * @returns URL 类型的处理结果。
 */
function typescriptWorkerEntry(target: URL): URL {
  const tsxApi = new URL('../../node_modules/tsx/dist/esm/api/index.mjs', import.meta.url);
  const bootstrap = [
    `import { register } from ${JSON.stringify(tsxApi.href)};`,
    'register();',
    `await import(${JSON.stringify(target.href)});`,
  ].join('\n');
  return new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`);
}
