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
  constructor(
    private readonly wiki: WikiService,
    private readonly audit: AgentAuditService,
  ) {}
  @Get() list(@CurrentAccess() context: AccessContext) {
    return this.wiki.list(context);
  }
  @Get(":id") get(
    @Param("id") id: string,
    @CurrentAccess() context: AccessContext,
  ) {
    return this.wiki.get(id, context);
  }
  @Post("candidates") async candidate(
    @Body() input: WikiCandidateDto,
    @CurrentAccess() context: AccessContext,
    @Req() _request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const abort = new AbortController();
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
  @Post(":id/publish") async publish(
    @Param("id") id: string,
    @Body() input: WikiPublishDto,
    @CurrentAccess() context: AccessContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const abort = new AbortController();
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
  @Delete(":id") remove(
    @Param("id") id: string,
    @CurrentAccess() context: AccessContext,
  ) {
    return this.wiki.remove(id, context);
  }
}
