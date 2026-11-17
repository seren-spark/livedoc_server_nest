/**
 * @file 检索观测接口。提供用户反馈、汇总指标和检索追踪查询入口。
 */
import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, Query, UnprocessableEntityException } from '@nestjs/common';
import { CurrentAccess } from '../auth/access-context.decorator.js';
import { FeedbackDto, TraceQueryDto } from '../common/dto.js';
import type { AccessContext } from '../common/types.js';
import { IndexJobsService } from '../indexing/index-jobs.service.js';
import { ObservabilityService } from './observability.service.js';

@Controller()
export class ObservabilityController {
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param observability ObservabilityService 依赖实例。
   * @param jobs 后台任务队列服务。
   */
  constructor(
    private readonly observability: ObservabilityService,
    private readonly jobs: IndexJobsService,
  ) {}

  /**
   * 记录当前用户对结果的采纳或质量反馈。
   *
   * @param request 当前业务请求。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的状态与操作结果对象。
   */
  @Post('ai/feedback')
  @HttpCode(HttpStatus.OK)
  async feedback(@Body() request: FeedbackDto, @CurrentAccess() context: AccessContext) {
    const recorded = await this.observability.recordFeedback(request.trace_id, request.action, context, request.comment);
    if (!recorded) throw new NotFoundException('Unknown or expired trace id.');
    return { status: 'recorded', trace_id: request.trace_id, action: request.action };
  }

  /**
   * 查询当前访问范围内的检索观测接口统计指标。
   *
   * @param window 统计时间窗口。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 时间对象。
   */
  @Get('metrics/rag')
  async metrics(@Query('window') window = '24h', @CurrentAccess() context: AccessContext) {
    try {
      return await this.observability.snapshot(context, window, await this.jobs.activeCount(context.space_id));
    } catch (error) {
      throw new UnprocessableEntityException(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * 按当前用户范围分页查询检索追踪。
   *
   * @param query 用户问题或检索查询。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 当前页条目与符合条件的总数；未找到或不可用时可能为空。
   */
  @Get('metrics/rag/traces')
  async traces(@Query() query: TraceQueryDto, @CurrentAccess() context: AccessContext) {
    try {
      return await this.observability.listTraces(context, query.window, query.limit);
    } catch (error) {
      throw new UnprocessableEntityException(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * 读取一条当前用户可访问的检索追踪。
   *
   * @param traceId 检索追踪标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns Record<string, unknown> 类型的处理结果。
   */
  @Get('metrics/rag/traces/:trace_id')
  async trace(@Param('trace_id') traceId: string, @CurrentAccess() context: AccessContext) {
    const trace = await this.observability.getTrace(traceId, context);
    if (!trace) throw new NotFoundException('Trace not found.');
    return trace;
  }
}
