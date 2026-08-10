process.env.LIVEDOC_SKIP_AUTO_START = 'true';

const { bootstrap } = await import('../src/main.js');
const { DocumentsController } = await import(
  '../src/documents/documents.controller.js'
);
const { DocumentsService } = await import(
  '../src/documents/documents.service.js'
);
const { IndexJobsService } = await import(
  '../src/indexing/index-jobs.service.js'
);
const { IndexWorkerService } = await import(
  '../src/indexing/index-worker.service.js'
);

const app = await bootstrap();
const controller = app.get(DocumentsController);
const documents = app.get(DocumentsService);
const jobs = app.get(IndexJobsService);
const worker = app.get(IndexWorkerService);
const context = {
  user_id: 'user_alice',
  space_id: 'space_a',
  team_ids: ['team_alpha'],
};

try {
  const seeded = await controller.seed(context);
  const jobIds = seeded.documents
    .map((document) => document.job_id)
    .filter((jobId): jobId is string => Boolean(jobId));

  if (jobIds.length > 0) {
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      const states = await Promise.all(jobIds.map((jobId) => jobs.get(jobId)));
      if (
        states.every((job) =>
          job && ['succeeded', 'failed', 'canceled', 'superseded'].includes(job.status),
        )
      ) {
        break;
      }
      const result = await worker.runOnce(`demo-seed-${process.pid}`);
      if (!result) await delay(300);
    }
  }

  const result = await Promise.all(
    seeded.documents.map(async (item) => {
      const record = await documents.require(item.doc_id);
      return {
        doc_id: record.doc_id,
        title: record.title,
        visibility: record.visibility,
        document_version: record.document_version,
        active_index_version: record.active_index_version,
        index_status: record.index_status,
        chunk_count: record.chunk_count,
        seed_action: item.action,
      };
    }),
  );
  const failed = result.filter(
    (document) =>
      document.index_status !== 'ready' ||
      document.active_index_version !== document.document_version,
  );
  console.log(JSON.stringify({ account: 'alice@livedoc.local', documents: result }, null, 2));
  if (failed.length > 0) {
    throw new Error(
      `Demo seed did not finish indexing: ${failed.map((item) => item.doc_id).join(', ')}`,
    );
  }
} finally {
  await app.close();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
