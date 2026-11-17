/**
 * @file 访问上下文装饰器。从已鉴权的请求中提取用户、空间和团队信息。
 */
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AccessContext } from '../common/types.js';

export const CurrentAccess = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AccessContext =>
    context.switchToHttp().getRequest<{ accessContext: AccessContext }>().accessContext,
);
