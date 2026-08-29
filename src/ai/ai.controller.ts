import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
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
    
    if (
      request.intent === 'summarize_document' &&
      !request.current_document?.content?.trim()
    ) {
      throw new BadRequestException(
        'summarize_document requires non-empty current_document.content',
      );
    }
    //创建 AbortController，监听客户端断开连接
    const abort = new AbortController();
    rawRequest.raw.once('aborted', () => abort.abort()); //  浏览器中止请求时传播取消。
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
    //声明响应媒体类型和 UTF-8 编码。
    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    // //  禁止代理缓存或转换增量事件。
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    //保持长连接直到 done/error/取消。
    reply.raw.setHeader('Connection', 'keep-alive');
    // reply.hijack() 会绕过 Fastify 正常的响应序列化流程
    // 因此 @fastify/cors 原本添加到 FastifyReply 上的 CORS 头不会被复制到实际的 SSE 原始响应中
    // 所以只手动镜像那些明确允许的请求来源（Origin）。
    //  真实源码还会把白名单 Origin 镜像到 raw CORS headers，见步骤 34.1。
    //  立即发出响应头，让浏览器开始读取流。
    const origin = rawRequest.headers.origin;
    if (origin && this.config.allowedOrigins.includes(origin)) {
      reply.raw.setHeader('Access-Control-Allow-Origin', origin);
      reply.raw.setHeader('Access-Control-Allow-Credentials', 'true');
      reply.raw.setHeader('Vary', 'Origin');
    }
    reply.raw.flushHeaders();
    //writer.stream 是 AsyncGenerator，逐条产出业务事件。
    for await (const message of this.writer.stream(request, context, abort.signal)) {
      if (abort.signal.aborted) break;
      ////  每个 writer message 被编码成一个 SSE frame
      reply.raw.write(`event: ${message.event}\ndata: ${JSON.stringify(message.data)}\n\n`);
    }
    if (!reply.raw.writableEnded) reply.raw.end();
  }
}
