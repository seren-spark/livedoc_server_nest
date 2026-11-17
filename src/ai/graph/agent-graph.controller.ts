/**
 * @file 图任务接口。提供持久化 Agent 任务的创建、事件读取、暂停、继续和停止入口。
 */
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
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param service AgentGraphService 依赖实例。
   * @param config 应用运行配置。
   */
  constructor(
    private readonly service: AgentGraphService,
    private readonly config: AppConfig,
  ) {}
  /**
   * 根据输入创建图任务并返回结果。
   *
   * @param input 包含写作需求、编辑器快照和参考资料的 Agent 请求。
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @returns 模型和工具调用用量。
   */
  @Post() @HttpCode(202) create(
    @Body() input: DocumentAgentDto,
    @CurrentAccess() c: AccessContext,
  ) {
    return this.service.create(input, c);
  }
  /**
   * 按查询条件读取图任务列表。
   *
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @param conversation 用于筛选任务的会话标识（可选）。
   * @param key 查询或存储使用的键（可选）。
   * @returns 模型和工具调用用量列表。
   */
  @Get() list(
    @CurrentAccess() c: AccessContext,
    @Query("conversation_id") conversation?: string,
    @Query("document_key") key?: string,
  ) {
    return this.service.list(c, conversation, key);
  }
  /**
   * 按标识读取图任务。
   *
   * @param id 目标记录的唯一标识。
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @returns 模型和工具调用用量。
   */
  @Get(":id") get(@Param("id") id: string, @CurrentAccess() c: AccessContext) {
    return this.service.get(id, c);
  }
  /**
   * 读取指定任务的研究资料明细，并应用分页参数。
   *
   * @param id 目标记录的唯一标识。
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @param question 需要回答或继续检索的问题（可选）。
   * @param offset 从原文或分页数据的哪个位置开始读取（可选）。
   * @param limit 本次读取或处理的数量上限（可选）。
   * @returns 整理后的状态与操作结果对象；未找到或不可用时可能为空。
   */
  @Get(':id/research') research(@Param('id') id: string, @CurrentAccess() c: AccessContext,
    @Query('question_id') question?: string, @Query('offset') offset?: string, @Query('limit') limit?: string) {
    return this.service.research(id, c, question, Number(offset ?? 0), Number(limit ?? 10));
  }
  /**
   * 向指定图任务提交暂停命令。
   *
   * @param id 目标记录的唯一标识。
   * @param input 本次操作的输入数据。
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @returns 模型和工具调用用量。
   */
  @Post(":id/pause") @HttpCode(200) pause(
    @Param("id") id: string,
    @Body() input: GraphControlDto,
    @CurrentAccess() c: AccessContext,
  ) {
    return this.service.command(id, c, input, "pause");
  }
  /**
   * 携带确认或补充输入继续原图任务。
   *
   * @param id 目标记录的唯一标识。
   * @param input 本次操作的输入数据。
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @returns 模型和工具调用用量。
   */
  @Post(":id/resume") @HttpCode(200) resume(
    @Param("id") id: string,
    @Body() input: GraphControlDto,
    @CurrentAccess() c: AccessContext,
  ) {
    return this.service.command(id, c, input, "resume");
  }
  /**
   * 向指定图任务提交停止命令。
   *
   * @param id 目标记录的唯一标识。
   * @param input 本次操作的输入数据。
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @returns 模型和工具调用用量。
   */
  @Post(":id/stop") @HttpCode(200) stop(
    @Param("id") id: string,
    @Body() input: GraphControlDto,
    @CurrentAccess() c: AccessContext,
  ) {
    return this.service.command(id, c, input, "stop");
  }
  /**
   * 读取指定游标之后的任务事件。
   *
   * @param id 目标记录的唯一标识。
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @param after 本次变更后的内容或状态。
   * @param request 当前 Fastify HTTP 请求。
   * @param reply 用于写回 HTTP 或 SSE 数据的响应对象。
   */
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
