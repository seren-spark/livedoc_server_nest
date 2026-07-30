import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AppConfig } from '../config/app-config.js';
import { DemoLoginDto } from '../common/dto.js';
import type { AccessContext } from '../common/types.js';
import { CurrentAccess } from './access-context.decorator.js';
import { AuthService, extractBearerToken } from './auth.service.js';
import { Public } from './public.decorator.js';

@Controller('dev/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfig,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() request: DemoLoginDto) {
    this.requireDevelopment();
    const result = await this.auth.login(request.email, request.password);
    if (!result) throw new HttpException('邮箱或密码错误。', HttpStatus.UNAUTHORIZED);
    return result;
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Req() request: FastifyRequest) {
    const token = extractBearerToken(request.headers.authorization);
    if (token) await this.auth.revoke(token);
    return { status: 'logged_out' };
  }

  @Get('me')
  me(@CurrentAccess() context: AccessContext) {
    return context;
  }

  private requireDevelopment(): void {
    if (this.config.appEnv === 'production') {
      throw new HttpException('Not found.', HttpStatus.NOT_FOUND);
    }
  }
}
