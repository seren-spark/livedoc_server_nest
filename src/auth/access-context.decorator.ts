import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AccessContext } from '../common/types.js';

export const CurrentAccess = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AccessContext =>
    context.switchToHttp().getRequest<{ accessContext: AccessContext }>().accessContext,
);
