/**
 * @file 写作技能接口。提供写作技能的列表、详情、创建、更新和删除入口。
 */
import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { Allow } from 'class-validator';
import { CurrentAccess } from '../auth/access-context.decorator.js';
import type { AccessContext } from '../common/types.js';
import { WritingSkillsService } from './writing-skills.service.js';
import type { SaveWritingSkillInput, SkillParameter } from './writing-skills.types.js';
import type { ExecutionPlan } from './document-agent.types.js';

export class SaveWritingSkillDto implements SaveWritingSkillInput {
  @Allow() name!: string;
  @Allow() description!: string;
  @Allow() parameters!: SkillParameter[];
  @Allow() steps!: ExecutionPlan['steps'];
  @Allow() allowed_tools!: string[];
  @Allow() acceptance!: string[];
  @Allow() template_id?: string;
  @Allow() enabled?: boolean;
  @Allow() expected_revision?: number;
}

class DeleteWritingSkillDto {
  @Allow() expected_revision!: number;
}

@Controller('ai/skills')
export class WritingSkillsController {
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param skills WritingSkillsService 依赖实例。
   */
  constructor(private readonly skills: WritingSkillsService) {}

  /**
   * 按查询条件读取写作技能列表。
   *
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的结果列表。
   */
  @Get() list(@CurrentAccess() context: AccessContext) {
    return this.skills.list(context);
  }

  /**
   * 按标识读取写作技能。
   *
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param id 目标记录的唯一标识。
   * @returns import("E:/LiveDoc/livedoc_server_nest/src/ai/writing-skills.types").WritingSkill 类型的处理结果。
   */
  @Get(':id') get(@CurrentAccess() context: AccessContext, @Param('id') id: string) {
    return this.skills.get(context, id);
  }

  /**
   * 根据输入创建写作技能并返回结果。
   *
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param input 本次操作的输入数据。
   * @returns import("E:/LiveDoc/livedoc_server_nest/src/ai/writing-skills.types").WritingSkill 类型的处理结果。
   */
  @Post() create(@CurrentAccess() context: AccessContext, @Body() input: SaveWritingSkillDto) {
    return this.skills.save(context, input);
  }

  /**
   * 根据请求更新写作技能。
   *
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param id 目标记录的唯一标识。
   * @param input 本次操作的输入数据。
   * @returns import("E:/LiveDoc/livedoc_server_nest/src/ai/writing-skills.types").WritingSkill 类型的处理结果。
   */
  @Patch(':id') update(@CurrentAccess() context: AccessContext, @Param('id') id: string, @Body() input: SaveWritingSkillDto) {
    return this.skills.save(context, input, id);
  }

  /**
   * 检查当前状态后移除指定写作技能。
   *
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param id 目标记录的唯一标识。
   * @param input 本次操作的输入数据。
   * @returns 整理后的状态与操作结果对象。
   */
  @Delete(':id') async remove(@CurrentAccess() context: AccessContext, @Param('id') id: string, @Body() input: DeleteWritingSkillDto) {
    await this.skills.delete(context, id, input.expected_revision);
    return { deleted: true };
  }
}
