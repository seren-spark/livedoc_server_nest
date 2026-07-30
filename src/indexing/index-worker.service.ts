import { Injectable } from '@nestjs/common';
import type { IndexJobRecord } from './index-job.types.js';
import { IndexJobsService } from './index-jobs.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { RetrievalService } from '../retrieval/retrieval.service.js';
import { VectorStoreService } from '../retrieval/vector-store.service.js';

@Injectable()
export class IndexWorkerService {
  constructor(
    private readonly jobs: IndexJobsService,
    private readonly documents: DocumentsService,
    private readonly retrieval: RetrievalService,
    private readonly store: VectorStoreService,
  ) {}

  async runOnce(workerId: string): Promise<IndexJobRecord | null> {
    const job = await this.jobs.claimNext(workerId);
    if (!job) return null;
    try {
      const current = await this.documents.get(job.doc_id);
      if (!current) {
        await this.store.deleteDocumentVersion(job.doc_id, job.document_version);
        return this.jobs.supersede(job.job_id);
      }
      if (current.document_version !== job.document_version) return this.jobs.supersede(job.job_id);
      await this.documents.markIndexing(job.doc_id);
      const chunkCount = await this.retrieval.indexDocument(job.request_payload, false);
      const latest = await this.documents.get(job.doc_id);
      if (!latest || latest.document_version !== job.document_version) {
        await this.store.deleteDocumentVersion(job.doc_id, job.document_version);
        return this.jobs.supersede(job.job_id);
      }
      await this.store.activateDocumentVersion(job.doc_id, job.document_version);
      await this.documents.markReady(job.doc_id, chunkCount, job.document_version);
      return this.jobs.succeed(job.job_id);
    } catch (error) {
      const updated = await this.jobs.fail(job.job_id, error instanceof Error ? error.message : String(error));
      const current = await this.documents.get(job.doc_id);
      if (current?.document_version === job.document_version) {
        if (updated.status === 'failed') await this.documents.markFailed(job.doc_id, updated.error ?? 'Indexing failed');
        else if (updated.status === 'retry_wait') await this.documents.markQueued(job.doc_id, job.job_id);
      }
      return updated;
    }
  }
}
