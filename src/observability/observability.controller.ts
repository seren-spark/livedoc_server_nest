import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, Query, UnprocessableEntityException } from '@nestjs/common';
import { CurrentAccess } from '../auth/access-context.decorator.js';
import { FeedbackDto, TraceQueryDto } from '../common/dto.js';
import type { AccessContext } from '../common/types.js';
import { IndexJobsService } from '../indexing/index-jobs.service.js';
import { ObservabilityService } from './observability.service.js';

@Controller()
export class ObservabilityController {
  constructor(
    private readonly observability: ObservabilityService,
    private readonly jobs: IndexJobsService,
  ) {}

  @Post('ai/feedback')
  @HttpCode(HttpStatus.OK)
  async feedback(@Body() request: FeedbackDto, @CurrentAccess() context: AccessContext) {
    const recorded = await this.observability.recordFeedback(request.trace_id, request.action, context, request.comment);
    if (!recorded) throw new NotFoundException('Unknown or expired trace id.');
    return { status: 'recorded', trace_id: request.trace_id, action: request.action };
  }

  @Get('metrics/rag')
  async metrics(@Query('window') window = '24h', @CurrentAccess() context: AccessContext) {
    try {
      return await this.observability.snapshot(context, window, await this.jobs.activeCount(context.space_id));
    } catch (error) {
      throw new UnprocessableEntityException(error instanceof Error ? error.message : String(error));
    }
  }

  @Get('metrics/rag/traces')
  async traces(@Query() query: TraceQueryDto, @CurrentAccess() context: AccessContext) {
    try {
      return await this.observability.listTraces(context, query.window, query.limit);
    } catch (error) {
      throw new UnprocessableEntityException(error instanceof Error ? error.message : String(error));
    }
  }

  @Get('metrics/rag/traces/:trace_id')
  async trace(@Param('trace_id') traceId: string, @CurrentAccess() context: AccessContext) {
    const trace = await this.observability.getTrace(traceId, context);
    if (!trace) throw new NotFoundException('Trace not found.');
    return trace;
  }
}
