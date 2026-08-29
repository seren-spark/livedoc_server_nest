import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { CurrentAccess } from '../auth/access-context.decorator.js';
import { DocumentMemoryUpdateDto } from '../common/dto.js';
import type { AccessContext } from '../common/types.js';
import { DocumentMemoryJobsService } from './document-memory-jobs.service.js';
import { DocumentMemoryService } from './document-memory.service.js';
import type { DocumentRecord } from './document.types.js';
import { DocumentsService } from './documents.service.js';

@Controller('documents/:doc_id/memory')
export class DocumentMemoryController {
  constructor(
    private readonly documents: DocumentsService,
    private readonly profiles: DocumentMemoryService,
    private readonly jobs: DocumentMemoryJobsService,
  ) {}

  @Get()
  async get(@Param('doc_id') docId: string, @CurrentAccess() context: AccessContext) {
    const document = await this.documents.getAccessible(docId, context);
    return this.response(document, await this.profiles.get(docId));
  }

  @Patch()
  async update(
    @Param('doc_id') docId: string,
    @Body() input: DocumentMemoryUpdateDto,
    @CurrentAccess() context: AccessContext,
  ) {
    const document = await this.documents.getWritable(docId, context);
    return this.response(document, await this.profiles.updateByUser(document, input));
  }

  @Post('refresh')
  @HttpCode(HttpStatus.ACCEPTED)
  async refresh(@Param('doc_id') docId: string, @CurrentAccess() context: AccessContext) {
    const document = await this.documents.getWritable(docId, context);
    const job = await this.jobs.enqueue(document, context, true);
    return {
      memory: this.response(document, await this.profiles.get(docId)),
      job: job && {
        job_id: job.job_id,
        document_version: job.document_version,
        status: job.status,
        attempts: job.attempts,
      },
    };
  }

  private response(
    document: DocumentRecord,
    profile: Awaited<ReturnType<DocumentMemoryService['get']>>,
  ) {
    return profile ?? {
      doc_id: document.doc_id,
      space_id: document.space_id,
      source_document_version: 0,
      memory_version: 0,
      status: 'pending',
      glossary: [],
      style_tags: [],
      global_settings: [],
      suppressed_keys: [],
      source_chunk_hashes: [],
      last_error: null,
      created_at: null,
      updated_at: null,
    };
  }
}
