import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { hostname } from 'node:os';
import { AppModule } from './app.module.js';
import { AppConfig } from './config/app-config.js';
import { IndexWorkerService } from './indexing/index-worker.service.js';

const app = await NestFactory.createApplicationContext(AppModule);
const config = app.get(AppConfig);
config.validateRuntime();
const worker = app.get(IndexWorkerService);
const workerId = `${hostname()}-${process.pid}`;
let closing = false;
const stop = () => {
  closing = true;
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

while (!closing) {
  const job = await worker.runOnce(workerId);
  if (!job) await new Promise((resolve) => setTimeout(resolve, config.indexWorkerPollSeconds * 1000));
}
await app.close();
