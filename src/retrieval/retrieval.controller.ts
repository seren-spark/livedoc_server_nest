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
  constructor(
    private readonly config: AppConfig,
    private readonly retrieval: RetrievalService,
    private readonly llm: LlmService,
  ) {}

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
