import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CurrentAccess } from '../auth/access-context.decorator.js';
import { AiWriteDto } from '../common/dto.js';
import type { AccessContext } from '../common/types.js';
import { AppConfig } from '../config/app-config.js';
import { AiWriterService } from './ai-writer.service.js';

@Controller('ai')
export class AiController {
  constructor(
    private readonly writer: AiWriterService,
    private readonly config: AppConfig,
  ) {}

  @Post('write')
  @HttpCode(HttpStatus.OK)
  async write(
    @Body() request: AiWriteDto, //请求体：query、retrieval_domain、current_context 等
    @CurrentAccess() context: AccessContext,  // 权限上下文：space_id、team_id、owner_id
    @Req() rawRequest: FastifyRequest, // 原始请求（用于监听客户端断开）
    @Res() reply: FastifyReply, // 原始响应（用于 SSE 流式输出）
  ): Promise<void> {
    //创建 AbortController，监听客户端断开连接
    const abort = new AbortController();
    rawRequest.raw.once('aborted', () => abort.abort()); //// 请求被取消
    reply.raw.once('close', () => {
      if (!reply.raw.writableEnded) abort.abort();// 响应流关闭但未结束 → 客户端断开
    });
    //非流式模式（一次性返回）
    if (!request.stream) {
      reply.send(await this.writer.complete(request, context, abort.signal));
      return;
    }

    //流式模式（SSE）
    reply.hijack();
    reply.raw.statusCode = 200;
    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    // reply.hijack() bypasses Fastify's normal response serialization, so
    // headers added by @fastify/cors to FastifyReply are not copied to the
    // raw SSE response. Mirror only an explicitly allowed request origin.
    const origin = rawRequest.headers.origin;
    if (origin && this.config.allowedOrigins.includes(origin)) {
      reply.raw.setHeader('Access-Control-Allow-Origin', origin);
      reply.raw.setHeader('Access-Control-Allow-Credentials', 'true');
      reply.raw.setHeader('Vary', 'Origin');
    }
    reply.raw.flushHeaders();
    for await (const message of this.writer.stream(request, context, abort.signal)) {
      if (abort.signal.aborted) break;
      reply.raw.write(`event: ${message.event}\ndata: ${JSON.stringify(message.data)}\n\n`);
    }
    if (!reply.raw.writableEnded) reply.raw.end();
  }
}
