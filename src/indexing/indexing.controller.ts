/**
 * @file 索引任务接口。提供文档索引提交与任务进度查询入口。
 */
import { Body, Controller, ForbiddenException, Get, HttpCode, HttpStatus, NotFoundException, Param, Post } from '@nestjs/common';
import { CurrentAccess } from '../auth/access-context.decorator.js';
import { DocumentCreateDto, DocumentIndexDto, DocumentUpdateDto } from '../common/dto.js';
import type { AccessContext } from '../common/types.js';
import { DocumentsService } from '../documents/documents.service.js';
import { toIndexRequest } from '../documents/document.types.js';
import { VectorStoreService } from '../retrieval/vector-store.service.js';
import { jobResponse } from './index-job.types.js';
import { IndexJobsService } from './index-jobs.service.js';

@Controller()
export class IndexingController {
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param jobs 后台任务队列服务。
   * @param documents 需要筛选或处理的文档集合。
   * @param store VectorStoreService 依赖实例。
   */
  constructor(
    private readonly jobs: IndexJobsService,
    private readonly documents: DocumentsService,
    private readonly store: VectorStoreService,
  ) {}

  /**
   * 检查文档归属与版本后提交异步索引任务。
   *
   * @param request 当前业务请求。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 时间对象；未找到或不可用时可能为空。
   */
  @Post('documents/index')
  @HttpCode(HttpStatus.ACCEPTED)
  async index(@Body() request: DocumentIndexDto, @CurrentAccess() context: AccessContext) {
    if (request.space_id !== context.space_id) throw new ForbiddenException('Cannot index document into another space.');
    this.documents.assertTeamTarget(request.visibility, request.team_id, context);
    let record = await this.documents.get(request.doc_id);
    if (!record) {
      record = await this.documents.create(
        Object.assign(new DocumentCreateDto(), {
          doc_id: request.doc_id,
          title: request.title,
          content: request.content,
          visibility: request.visibility,
          source_type: request.source_type,
          tags: request.tags,
          team_id: request.team_id,
          url: request.url,
          index_now: true,
        }),
        context,
      );
    } else {
      await this.documents.getWritable(record.doc_id, context);
      const previousVisibility = record.visibility;
      const previousTeam = record.team_id;
      record = await this.documents.update(
        record.doc_id,
        Object.assign(new DocumentUpdateDto(), {
          title: request.title,
          content: request.content,
          visibility: request.visibility,
          source_type: request.source_type,
          tags: request.tags,
          team_id: request.team_id,
          url: request.url,
        }),
        context,
      );
      if (record.visibility !== previousVisibility || record.team_id !== previousTeam) await this.store.deactivateDocument(record.doc_id);
    }
    const job = await this.jobs.enqueue(toIndexRequest(record), context);
    await this.documents.markQueued(record.doc_id, job.job_id);
    return jobResponse(job);
  }

  /**
   * 读取指定索引任务，并检查当前用户的访问权限。
   *
   * @param jobId 后台任务标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 时间对象；未找到或不可用时可能为空。
   */
  @Get('index-jobs/:job_id')
  async getJob(@Param('job_id') jobId: string, @CurrentAccess() context: AccessContext) {
    const job = await this.jobs.get(jobId);
    if (!job) throw new NotFoundException('Index job not found.');
    const record = await this.documents.get(job.doc_id);
    if (record) this.documents.assertAccess(record, context);
    else if (job.space_id !== context.space_id || job.requested_by !== context.user_id) throw new ForbiddenException('Index job access denied.');
    return jobResponse(job);
  }
}
