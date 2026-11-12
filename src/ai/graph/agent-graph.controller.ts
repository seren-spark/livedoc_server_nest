import {
  Body,
  Controller,
  Get,
  Post,
  Param,
  Query,
  Req,
  Res,
  HttpCode,
} from "@nestjs/common";
import {
  IsString,
  IsNotEmpty,
  MaxLength,
  IsInt,
  Min,
  IsOptional,
  IsIn,
  Allow,
} from "class-validator";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AppConfig } from "../../config/app-config.js";
import { CurrentAccess } from "../../auth/access-context.decorator.js";
import type { AccessContext } from "../../common/types.js";
import { DocumentAgentDto } from "../document-agent.dto.js";
import { AgentGraphService } from "./agent-graph.service.js";
import { GRAPH_TERMINAL } from "./agent-run.repository.js";
import { setTimeout as delay } from "node:timers/promises";

export class GraphControlDto {
  @IsString() @IsNotEmpty() @MaxLength(128) request_id!: string;
  @IsInt() @Min(0) expected_revision!: number;
  @IsOptional()
  @IsIn(["continue", "approve_plan", "revise_plan", "answer"])
  action?: "continue" | "approve_plan" | "revise_plan" | "answer";
  @IsOptional() @IsString() @MaxLength(256) interrupt_id?: string;
  @IsOptional() @Allow() plan?: unknown;
  @IsOptional() @IsString() @MaxLength(4000) text?: string;
}

@Controller("ai/agent/runs")
export class AgentGraphController {
  constructor(
    private readonly service: AgentGraphService,
    private readonly config: AppConfig,
  ) {}
  @Post() @HttpCode(202) create(
    @Body() input: DocumentAgentDto,
    @CurrentAccess() c: AccessContext,
  ) {
    return this.service.create(input, c);
  }
  @Get() list(
    @CurrentAccess() c: AccessContext,
    @Query("conversation_id") conversation?: string,
    @Query("document_key") key?: string,
  ) {
    return this.service.list(c, conversation, key);
  }
  @Get(":id") get(@Param("id") id: string, @CurrentAccess() c: AccessContext) {
    return this.service.get(id, c);
  }
  @Get(':id/research') research(@Param('id') id: string, @CurrentAccess() c: AccessContext,
    @Query('question_id') question?: string, @Query('offset') offset?: string, @Query('limit') limit?: string) {
    return this.service.research(id, c, question, Number(offset ?? 0), Number(limit ?? 10));
  }
  @Post(":id/pause") @HttpCode(200) pause(
    @Param("id") id: string,
    @Body() input: GraphControlDto,
    @CurrentAccess() c: AccessContext,
  ) {
    return this.service.command(id, c, input, "pause");
  }
  @Post(":id/resume") @HttpCode(200) resume(
    @Param("id") id: string,
    @Body() input: GraphControlDto,
    @CurrentAccess() c: AccessContext,
  ) {
    return this.service.command(id, c, input, "resume");
  }
  @Post(":id/stop") @HttpCode(200) stop(
    @Param("id") id: string,
    @Body() input: GraphControlDto,
    @CurrentAccess() c: AccessContext,
  ) {
    return this.service.command(id, c, input, "stop");
  }
  @Get(":id/events") async events(
    @Param("id") id: string,
    @CurrentAccess() c: AccessContext,
    @Query("after_seq") after: string | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    let last = Number(after ?? 0);
    if (!Number.isSafeInteger(last) || last < 0) last = 0;
    await this.service.repository.get(id, c);
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
    let closed = false,
      ticks = 0;
    reply.raw.once("close", () => {
      closed = true;
    });
    try {
      while (!closed) {
        const run = await this.service.repository.get(id, c);
        const batch = await this.service.repository.events(id, last);
        if (
          batch.some((event) =>
            ["plan", "waiting_input", "step", "reflection", 'research_brief', 'research_progress', 'research_section', 'research_coverage'].includes(
              event.event,
            ),
          )
        )
          await this.service.authorizeProgress(id, c);
        for (const event of batch) {
          if (closed) break;
          reply.raw.write(
            `id: ${event.data.seq}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`,
          );
          last = event.data.seq;
        }
        if (batch.length === 200) continue;
        if (
          [
            ...GRAPH_TERMINAL,
            "paused",
            "waiting_input",
            "interrupted",
          ].includes(run.status) &&
          last >= run.last_seq
        )
          break;
        if (++ticks % 20 === 0) reply.raw.write(": heartbeat\n\n");
        await delay(500);
      }
    } finally {
      if (!reply.raw.writableEnded) reply.raw.end();
    }
  }
}
