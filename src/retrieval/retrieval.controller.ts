/**
 * @file 知识检索接口。校验请求身份与检索参数，返回引用证据和检索追踪。
 */
import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { CurrentAccess } from '../auth/access-context.decorator.js';
import { SearchDto } from '../common/dto.js';
import type { AccessContext } from '../common/types.js';
import { normalizeQueryVariants } from '../ai/agent-tools.service.js';
import { LlmService } from '../ai/llm.service.js';
import { AppConfig } from '../config/app-config.js';
import { RetrievalService } from './retrieval.service.js';

@Controller('knowledge')
export class RetrievalController {
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param config 应用运行配置。
   * @param retrieval 共享知识检索服务。
   * @param llm 共享模型调用服务。
   */
  constructor(
    private readonly config: AppConfig,
    private readonly retrieval: RetrievalService,
    private readonly llm: LlmService,
  ) {}

  /**
   * 准备查询变体，再以当前访问身份执行检索并返回引用与追踪。
   *
   * @param request 包含查询文本、检索范围与返回数量的请求。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 引用证据与本次检索追踪。
   */
  @Post('search')
  @HttpCode(HttpStatus.OK)
  async search(@Body() request: SearchDto, @CurrentAccess() context: AccessContext) {
    const preprocessingStarted = performance.now();
    let queryVariants = [request.query];
    let expansionSource: 'original' | 'llm' | 'fallback' = 'original';
    if (request.expand_query !== false && this.config.queryExpansionEnabled && this.llm.isConfigured) {
      try {
        queryVariants = normalizeQueryVariants(
          request.query,
          await this.llm.expandQueries(request.query, request.context, this.config.queryExpansionMaxVariants),
          true,
          this.config.queryExpansionMaxVariants,
        );
        expansionSource = queryVariants.length > 1 ? 'llm' : 'fallback';
      } catch {
        expansionSource = 'fallback';
      }
    }
    const searchResult = await this.retrieval.searchWithTrace(
      request,
      context,
      queryVariants,
      expansionSource,
      performance.now() - preprocessingStarted,
    );
    return { query: request.query, ...searchResult };
  }
}
