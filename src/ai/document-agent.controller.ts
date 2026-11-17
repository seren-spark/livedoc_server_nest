/**
 * @file 文档 Agent 接口。提供能力查询、设置、SSE 执行、候选恢复和反馈入口。
 */
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
import { DocumentAgentDto, AgentFeedbackDto, AgentRestoreDto } from "./document-agent.dto.js";
import { DocumentAgentService } from "./document-agent.service.js";
import { AgentAuditService } from "./agent-audit.service.js";
import { AgentSettingsDto, AgentSettingsService } from './agent-settings.service.js';
@Controller("ai")
export class DocumentAgentController {
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param agent DocumentAgentService 依赖实例。
   * @param audit AgentAuditService 依赖实例。
   * @param config 应用运行配置。
   * @param settings AgentSettingsService 依赖实例。
   */
  constructor(
    private readonly agent: DocumentAgentService,
    private readonly audit: AgentAuditService,
    private readonly config: AppConfig,
    private readonly settings: AgentSettingsService,
  ) {}
  /**
   * 返回前端需要的 Agent 功能开关与能力配置。
   *
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的状态与操作结果对象。
   */
  @Get("agent/capabilities") capabilities(@CurrentAccess() context: AccessContext) {
    return this.agent.capabilities(context);
  }
  /**
   * 查询当前用户可展示的 Agent 设置，隐藏敏感凭据。
   *
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的状态与操作结果对象；未找到或不可用时可能为空。
   */
  @Get('agent/settings') getSettings(@CurrentAccess() context: AccessContext) {
    return this.settings.get(context);
  }
  /**
   * 查询当前访问范围内的文档 Agent 接口统计指标。
   *
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param window 统计时间窗口。
   * @returns 时间对象列表；未找到或不可用时可能为空。
   */
  @Get('agent/metrics') metrics(@CurrentAccess() context: AccessContext, @Query('window') window = '24h') {
    return this.audit.metrics(context, window);
  }
  /**
   * 校验并更新当前用户的 Agent 运行设置。
   *
   * @param input 本次操作的输入数据。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param request 当前 Fastify HTTP 请求。
   * @param reply 用于写回 HTTP 或 SSE 数据的响应对象。
   * @returns 整理后的状态与操作结果对象；未找到或不可用时可能为空。
   */
  @Post('agent/settings/validate') async configure(@Body() input: AgentSettingsDto, @CurrentAccess() context: AccessContext, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const abort = new AbortController();
    /**
     * 在响应尚未正常结束时取消模型与工具工作。
     */
    const cancel = () => { if (!reply.raw.writableEnded) abort.abort(); };
    reply.raw.once('close', cancel);
    try { return await this.settings.validateAndSave(context, input, abort.signal); }
    finally { reply.raw.off('close', cancel); }
  }
  /**
   * 启动任务并把 Agent 事件写入 SSE 响应；连接关闭时取消执行。
   *
   * @param input 包含写作需求、编辑器快照和参考资料的 Agent 请求。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param request 当前 Fastify HTTP 请求。
   * @param reply 用于写回 HTTP 或 SSE 数据的响应对象。
   */
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
    /**
     * 将一条 Agent 事件编码为 SSE 消息写入响应流。
     *
     * @param event 需要处理的事件。
     * @returns 条件是否满足的判断结果。
     */
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
  /**
   * 记录当前用户对结果的采纳或质量反馈。
   *
   * @param id 目标记录的唯一标识。
   * @param input 本次操作的输入数据。
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的状态与操作结果对象；未找到或不可用时可能为空。
   */
  @Post("agent/:id/feedback") feedback(
    @Param("id") id: string,
    @Body() input: AgentFeedbackDto,
    @CurrentAccess() c: AccessContext,
  ) {
    return this.agent.feedback(id, c, input);
  }
  /**
   * 查询普通 Agent 任务及其已保存候选。
   *
   * @param id 目标记录的唯一标识。
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @returns 时间对象；未找到或不可用时可能为空。
   */
  @Get("agent/:id") run(
    @Param("id") id: string,
    @CurrentAccess() c: AccessContext,
  ) {
    return this.agent.getRun(id, c);
  }
  /**
   * 使用当前编辑器 JSON 校验历史候选是否仍可恢复。
   *
   * @param id 目标记录的唯一标识。
   * @param input 本次操作的输入数据。
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @returns import("E:/LiveDoc/livedoc_server_nest/src/ai/agent-audit.service").AgentRunRecord 类型的处理结果。
   */
  @Post("agent/:id/restore") restore(
    @Param("id") id: string,
    @Body() input: AgentRestoreDto,
    @CurrentAccess() c: AccessContext,
  ) {
    return this.agent.restore(id, c, input.editor_json);
  }
  /**
   * 查询本次运行的工具调用记录。
   *
   * @param id 目标记录的唯一标识。
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的结果列表。
   */
  @Get("tool-audits") calls(
    @Query("run_id") id: string,
    @CurrentAccess() c: AccessContext,
  ) {
    return this.audit.list(id, c);
  }
}
