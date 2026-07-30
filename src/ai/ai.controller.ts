import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CurrentAccess } from '../auth/access-context.decorator.js';
import { AiWriteDto } from '../common/dto.js';
import type { AccessContext } from '../common/types.js';
import { AiWriterService } from './ai-writer.service.js';

@Controller('ai')
export class AiController {
  constructor(private readonly writer: AiWriterService) {}

  @Post('write')
  @HttpCode(HttpStatus.OK)
  async write(
    @Body() request: AiWriteDto,
    @CurrentAccess() context: AccessContext,
    @Req() rawRequest: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const abort = new AbortController();
    rawRequest.raw.once('aborted', () => abort.abort());
    reply.raw.once('close', () => {
      if (!reply.raw.writableEnded) abort.abort();
    });
    if (!request.stream) {
      reply.send(await this.writer.complete(request, context, abort.signal));
      return;
    }
    reply.hijack();
    reply.raw.statusCode = 200;
    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.flushHeaders();
    for await (const message of this.writer.stream(request, context, abort.signal)) {
      if (abort.signal.aborted) break;
      reply.raw.write(`event: ${message.event}\ndata: ${JSON.stringify(message.data)}\n\n`);
    }
    if (!reply.raw.writableEnded) reply.raw.end();
  }
}
