import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { hostname } from 'node:os';
import { AppModule } from './app.module.js';
import { AppConfig } from './config/app-config.js';
import { DocumentImportsService } from './document-imports/document-imports.service.js';
import { ImportWorkerService } from './document-imports/import-worker.service.js';

const app = await NestFactory.createApplicationContext(AppModule);
const config = app.get(AppConfig);
config.validateRuntime();
const worker = app.get(ImportWorkerService);
const imports = app.get(DocumentImportsService);
const workerId = `${hostname()}-import-${process.pid}`;
let closing = false;
const stop = () => { closing = true; };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
let nextCleanup = 0;

while (!closing) {
  if (Date.now() >= nextCleanup) {
    await imports.cleanupExpired();
    nextCleanup = Date.now() + 3600_000;
  }
  const job = await worker.runOnce(workerId);
  if (!job) await new Promise((resolve) => setTimeout(resolve, config.importWorkerPollSeconds * 1000));
}
await app.close();
