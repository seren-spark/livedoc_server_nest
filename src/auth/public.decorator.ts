/**
 * @file 公开接口标记。为无需登录的控制器方法写入鉴权豁免元数据。
 */
import { SetMetadata } from '@nestjs/common';
import { PUBLIC_ROUTE } from './auth.guard.js';

/**
 * 标记当前接口允许跳过全局登录校验。
 *
 * @returns 当前步骤的处理结果。
 */
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);
