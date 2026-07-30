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
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

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
