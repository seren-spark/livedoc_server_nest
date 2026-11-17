/**
 * @file Wiki 知识接口。提供知识列表、候选编译、发布和删除入口。
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import { IsInt, IsNotEmpty, IsString, MaxLength, Min } from "class-validator";
import type { FastifyReply, FastifyRequest } from "fastify";
import { CurrentAccess } from "../auth/access-context.decorator.js";
import type { AccessContext } from "../common/types.js";
import { AgentAuditService } from "../ai/agent-audit.service.js";
import { WikiService } from "./wiki.service.js";

class WikiCandidateDto {
  @IsString() @IsNotEmpty() @MaxLength(64) run_id!: string;
  @IsString() @IsNotEmpty() @MaxLength(12000) answer!: string;
}
class WikiPublishDto {
  @IsInt() @Min(1) revision!: number;
}

@Controller("ai/wiki")
export class WikiController {
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param wiki WikiService 依赖实例。
   * @param audit AgentAuditService 依赖实例。
   */
  constructor(
    private readonly wiki: WikiService,
    private readonly audit: AgentAuditService,
  ) {}
  /**
   * 按查询条件读取Wiki 知识页列表。
   *
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns Agent 引用来源列表；未找到或不可用时可能为空。
   */
  @Get() list(@CurrentAccess() context: AccessContext) {
    return this.wiki.list(context);
  }
  /**
   * 按标识读取Wiki 知识页。
   *
   * @param id 目标记录的唯一标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns Agent 引用来源列表；未找到或不可用时可能为空。
   */
  @Get(":id") get(
    @Param("id") id: string,
    @CurrentAccess() context: AccessContext,
  ) {
    return this.wiki.get(id, context);
  }
  /**
   * 基于原文和回答生成知识候选，校验引用与来源关系。
   *
   * @param input 本次操作的输入数据。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param _request 当前 Fastify HTTP 请求。
   * @param reply 用于写回 HTTP 或 SSE 数据的响应对象。
   * @returns Agent 引用来源列表；未找到或不可用时可能为空。
   */
  @Post("candidates") async candidate(
    @Body() input: WikiCandidateDto,
    @CurrentAccess() context: AccessContext,
    @Req() _request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const abort = new AbortController();
    /**
     * 响应客户端断开，取消当前知识编译或发布请求。
     */
    const cancel = () => {
      if (!reply.raw.writableEnded) abort.abort();
    };
    reply.raw.once("close", cancel);
    try {
      return await this.wiki.candidate(
        await this.audit.get(input.run_id, context),
        input.answer,
        context,
        abort.signal,
      );
    } finally {
      reply.raw.off("close", cancel);
    }
  }
  /**
   * 校验当前候选或草稿后发布，并协调对应索引状态。
   *
   * @param id 目标记录的唯一标识。
   * @param input 本次操作的输入数据。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param reply 用于写回 HTTP 或 SSE 数据的响应对象。
   * @returns Agent 引用来源列表；未找到或不可用时可能为空。
   */
  @Post(":id/publish") async publish(
    @Param("id") id: string,
    @Body() input: WikiPublishDto,
    @CurrentAccess() context: AccessContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const abort = new AbortController();
    /**
     * 响应客户端断开，取消当前知识编译或发布请求。
     */
    const cancel = () => {
      if (!reply.raw.writableEnded) abort.abort();
    };
    reply.raw.once("close", cancel);
    try {
      return await this.wiki.publish(id, input.revision, context, abort.signal);
    } finally {
      reply.raw.off("close", cancel);
    }
  }
  /**
   * 检查当前状态后移除指定Wiki 知识页。
   *
   * @param id 目标记录的唯一标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的状态与操作结果对象。
   */
  @Delete(":id") remove(
    @Param("id") id: string,
    @CurrentAccess() context: AccessContext,
  ) {
    return this.wiki.remove(id, context);
  }
}
