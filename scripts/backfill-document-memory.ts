import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module.js';
import { AppConfig } from '../src/config/app-config.js';
import { DatabaseService } from '../src/database/database.service.js';
import { DocumentMemoryJobsService } from '../src/documents/document-memory-jobs.service.js';
import { DocumentsService } from '../src/documents/documents.service.js';

const batchArg = process.argv.find((value) => value.startsWith('--batch-size='));
const batchSize = Math.max(1, Math.min(500, Number(batchArg?.split('=')[1] ?? 20)));
const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
try {
  const config = app.get(AppConfig);
  config.validateRuntime();
  const database = app.get(DatabaseService);
  if (!database.memoryEnabled || !database.metadataEnabled) {
    throw new Error('memory:backfill requires MySQL metadata and memory stores');
  }
  const rows = await database.query<{ doc_id: string }>(
    `SELECT d.doc_id FROM knowledge_documents d
     LEFT JOIN document_memory_profiles m ON m.doc_id=d.doc_id
     WHERE m.doc_id IS NULL OR m.source_document_version<>d.document_version
     ORDER BY d.updated_at ASC LIMIT ?`,
    [batchSize],
  );
  const documents = app.get(DocumentsService);
  const jobs = app.get(DocumentMemoryJobsService);
  for (const row of rows) {
    const document = await documents.require(String(row.doc_id));
    await jobs.enqueue(document, {
      user_id: document.owner_id ?? 'memory_backfill',
      space_id: document.space_id,
      team_ids: document.team_id ? [document.team_id] : [],
    });
  }
  console.log(JSON.stringify({ queued: rows.length, batch_size: batchSize }));
} finally {
  await app.close();
}
