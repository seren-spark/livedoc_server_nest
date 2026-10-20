import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { CurrentAccess } from "../auth/access-context.decorator.js";
import type { AccessContext } from "../common/types.js";
import { AppConfig } from "../config/app-config.js";
import { DocumentAgentDto, AgentFeedbackDto } from "./document-agent.dto.js";
import { DocumentAgentService } from "./document-agent.service.js";
import { AgentAuditService } from "./agent-audit.service.js";
import { AgentSettingsDto, AgentSettingsService } from './agent-settings.service.js';
@Controller("ai")
export class DocumentAgentController {
  constructor(
    private readonly agent: DocumentAgentService,
    private readonly audit: AgentAuditService,
    private readonly config: AppConfig,
    private readonly settings: AgentSettingsService,
  ) {}
  @Get("agent/capabilities") capabilities(@CurrentAccess() context: AccessContext) {
    return this.agent.capabilities(context);
  }
  @Get('agent/settings') getSettings(@CurrentAccess() context: AccessContext) {
    return this.settings.get(context);
  }
  @Post('agent/settings/validate') async configure(@Body() input: AgentSettingsDto, @CurrentAccess() context: AccessContext, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const abort = new AbortController();
    const cancel = () => { if (!reply.raw.writableEnded) abort.abort(); };
    reply.raw.once('close', cancel);
    try { return await this.settings.validateAndSave(context, input, abort.signal); }
    finally { reply.raw.off('close', cancel); }
  }
  @Post("agent") async execute(
    @Body() input: DocumentAgentDto,
    @CurrentAccess() context: AccessContext,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const abort = new AbortController();
    request.raw.once("aborted", () => abort.abort());
    reply.raw.once("close", () => {
      if (!reply.raw.writableEnded) abort.abort();
    });
    const generator = this.agent.run(input, context, abort.signal);
    const first = await generator.next();
    reply.hijack();
    reply.raw.statusCode = 200;
    reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    const origin = request.headers.origin;
    if (origin && this.config.allowedOrigins.includes(origin)) {
      reply.raw.setHeader("Access-Control-Allow-Origin", origin);
      reply.raw.setHeader("Access-Control-Allow-Credentials", "true");
      reply.raw.setHeader("Vary", "Origin");
    }
    reply.raw.flushHeaders();
    const send = (event: { event: string; data: unknown }) =>
      reply.raw.write(
        `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`,
      );
    try {
      if (!first.done) send(first.value);
      for await (const event of generator) {
        if (abort.signal.aborted) break;
        send(event);
      }
    } finally {
      await generator.return(undefined);
      if (!reply.raw.writableEnded) reply.raw.end();
    }
  }
  @Post("agent/:id/feedback") feedback(
    @Param("id") id: string,
    @Body() input: AgentFeedbackDto,
    @CurrentAccess() c: AccessContext,
  ) {
    return this.agent.feedback(id, c, input);
  }
  @Get("agent/:id") run(
    @Param("id") id: string,
    @CurrentAccess() c: AccessContext,
  ) {
    return this.audit.get(id, c);
  }
  @Get("tool-audits") calls(
    @Query("run_id") id: string,
    @CurrentAccess() c: AccessContext,
  ) {
    return this.audit.list(id, c);
  }
}
