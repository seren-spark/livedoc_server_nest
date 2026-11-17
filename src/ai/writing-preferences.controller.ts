/**
 * @file 写作偏好接口。提供个人写作偏好的查询和修改入口。
 */
import { Body, Controller, Get, Post } from '@nestjs/common';
import { Allow } from 'class-validator';
import { CurrentAccess } from '../auth/access-context.decorator.js';
import type { AccessContext } from '../common/types.js';
import { WritingPreferencesService } from './writing-preferences.service.js';
import type { PreferenceMutation } from './writing-preferences.types.js';

export class PreferenceMutationDto implements PreferenceMutation {
  @Allow() request_id!: string;
  @Allow() expected_revision!: number;
  @Allow() action!: PreferenceMutation['action'];
  @Allow() id?: string;
  @Allow() text?: string;
  @Allow() replace_ids?: string[];
}

@Controller('ai/agent/preferences')
export class WritingPreferencesController {
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param preferences WritingPreferencesService 依赖实例。
   */
  constructor(private readonly preferences: WritingPreferencesService) {}

  /**
   * 按标识读取写作偏好。
   *
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 写作偏好当前状态。
   */
  @Get() get(@CurrentAccess() context: AccessContext) {
    return this.preferences.get(context);
  }

  /**
   * 将当前用户的偏好修改请求交给偏好服务处理。
   *
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param input 本次操作的输入数据。
   * @returns 写作偏好当前状态。
   */
  @Post() mutate(@CurrentAccess() context: AccessContext, @Body() input: PreferenceMutationDto) {
    return this.preferences.mutate(context, input);
  }
}
