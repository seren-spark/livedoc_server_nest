import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { CurrentAccess } from '../auth/access-context.decorator.js';
import { DocumentCreateDto, DocumentUpdateDto, PaginationQueryDto } from '../common/dto.js';
import type { AccessContext } from '../common/types.js';
import { AppConfig } from '../config/app-config.js';
import { IndexJobsService } from '../indexing/index-jobs.service.js';
import { jobResponse } from '../indexing/index-job.types.js';
import { RetrievalService } from '../retrieval/retrieval.service.js';
import { VectorStoreService } from '../retrieval/vector-store.service.js';
import { DEMO_DOCUMENTS } from './demo-data.js';
import { DocumentsService } from './documents.service.js';
import { toIndexRequest } from './document.types.js';

@Controller()
export class DocumentsController {
  constructor(
    private readonly config: AppConfig,
    private readonly documents: DocumentsService,
    private readonly jobs: IndexJobsService,
    private readonly retrieval: RetrievalService,
    private readonly store: VectorStoreService,
  ) {}

  @Post('documents')
  async create(
    @Body() request: DocumentCreateDto,
    @CurrentAccess() context: AccessContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const record = await this.documents.create(request, context);
    if (!request.index_now) {
      reply.status(HttpStatus.CREATED);
      return record;
    }
    const job = await this.jobs.enqueue(toIndexRequest(record), context);
    await this.documents.markQueued(record.doc_id, job.job_id);
    reply.status(HttpStatus.ACCEPTED);
    return this.documents.require(record.doc_id);
  }

  @Get('documents')
  async list(@Query() query: PaginationQueryDto, @CurrentAccess() context: AccessContext) {
    const result = await this.documents.list(context, query.page, query.page_size);
    return { ...result, page: query.page, page_size: query.page_size };
  }

  @Get('documents/:doc_id')
  get(@Param('doc_id') docId: string, @CurrentAccess() context: AccessContext) {
    return this.documents.getAccessible(docId, context);
  }

  @Patch('documents/:doc_id')
  async update(@Param('doc_id') docId: string, @Body() request: DocumentUpdateDto, @CurrentAccess() context: AccessContext) {
    const before = await this.documents.getAccessible(docId, context);
    const updated = await this.documents.update(docId, request, context);
    if (before.visibility !== updated.visibility || before.team_id !== updated.team_id) await this.store.deactivateDocument(docId);
    return updated;
  }

  @Delete('documents/:doc_id')
  async delete(@Param('doc_id') docId: string, @CurrentAccess() context: AccessContext) {
    await this.documents.getAccessible(docId, context);
    await this.jobs.cancelDocument(docId);
    await this.store.deleteDocument(docId);
    await this.documents.delete(docId, context);
    return { status: 'deleted', doc_id: docId };
  }

  @Post('documents/:doc_id/reindex')
  @HttpCode(HttpStatus.ACCEPTED)
  async reindex(@Param('doc_id') docId: string, @CurrentAccess() context: AccessContext) {
    const record = await this.documents.getAccessible(docId, context);
    const job = await this.jobs.enqueue(toIndexRequest(record), context, true);
    await this.documents.markQueued(record.doc_id, job.job_id);
    return jobResponse(job);
  }

  @Post('dev/seed')
  @HttpCode(HttpStatus.OK)
  async seed(@CurrentAccess() context: AccessContext) {
    if (this.config.appEnv === 'production') throw new HttpException('Not found.', HttpStatus.NOT_FOUND);
    const indexed: Array<{ doc_id: string; chunk_count: number }> = [];
    for (const document of DEMO_DOCUMENTS) {
      if (![context.space_id, 'public'].includes(document.space_id)) continue;
      let record = await this.documents.get(document.doc_id);
      if (!record) {
        const seedContext: AccessContext = {
          user_id: document.owner_id ?? context.user_id,
          space_id: document.space_id,
          team_ids: document.team_id ? [document.team_id] : [],
        };
        record = await this.documents.create(
          Object.assign(new DocumentCreateDto(), {
            doc_id: document.doc_id,
            title: document.title,
            content: document.content,
            visibility: document.visibility,
            source_type: document.source_type,
            tags: document.tags,
            team_id: document.team_id,
            url: document.url,
            index_now: false,
          }),
          seedContext,
        );
      }
      await this.documents.markIndexing(record.doc_id);
      const chunkCount = await this.retrieval.indexDocument(toIndexRequest(record));
      await this.documents.markReady(record.doc_id, chunkCount, record.document_version);
      indexed.push({ doc_id: record.doc_id, chunk_count: chunkCount });
    }
    return { status: 'seeded', documents: indexed };
  }
}
