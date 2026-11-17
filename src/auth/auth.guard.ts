/**
 * @file 请求鉴权守卫。解析会话凭证并挂载访问上下文，对公开接口应用豁免规则。
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService, extractBearerToken } from './auth.service.js';

export const PUBLIC_ROUTE = 'public_route';

@Injectable()
export class AuthGuard implements CanActivate {
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param auth AuthService 依赖实例。
   * @param reflector 执行候选自检的回调。
   */
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  /**
   * 检查接口是否公开；需要鉴权时解析凭证并写入访问上下文。
   *
   * @param context 当前操作的上下文。
   * @returns 条件是否满足的判断结果。
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [context.getHandler(), context.getClass()])) {
      return true;
    }
    const request = context.switchToHttp().getRequest<{
      headers: { authorization?: string };
      accessContext?: unknown;
    }>();
    const token = extractBearerToken(request.headers.authorization);
    const identity = token ? await this.auth.resolve(token) : null;
    if (!identity) throw new UnauthorizedException('A valid demo session is required.');
    request.accessContext = {
      user_id: identity.user_id,
      space_id: identity.space_id,
      team_ids: identity.team_ids,
    };
    return true;
  }
}
