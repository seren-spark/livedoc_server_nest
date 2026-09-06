import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { hostname } from 'node:os';
import { AppModule } from './app.module.js';
import { AppConfig } from './config/app-config.js';
import { IndexWorkerService } from './indexing/index-worker.service.js';
import { DocumentMemoryWorkerService } from './documents/document-memory/document-memory-worker.service.js';

const app = await NestFactory.createApplicationContext(AppModule);
const config = app.get(AppConfig);
config.validateRuntime();
//从 NestJS 容器里拿到 IndexWorkerService 。
const worker = app.get(IndexWorkerService);
const memoryWorker = app.get(DocumentMemoryWorkerService);
// workerId 由主机名 + 进程 ID 组成，唯一标识这个 Worker 实例。
const workerId = `${hostname()}-${process.pid}`;
let closing = false;
const stop = () => {
  closing = true;
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
// 无限循环 ，不断调用 worker.runOnce(workerId) 。
while (!closing) {
  const [indexJob, memoryJob] = await Promise.all([
    worker.runOnce(workerId),
    memoryWorker.runOnce(`${workerId}-memory`),
  ]);
  if (!indexJob && !memoryJob)
    await new Promise((resolve) => setTimeout(resolve, config.indexWorkerPollSeconds * 1000));
}
await app.close();
