/**
 * @file 鉴权接口。处理登录、退出和当前身份查询，并限制开发专用登录入口。
 */
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
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param auth AuthService 依赖实例。
   * @param config 应用运行配置。
   */
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfig,
  ) {}

  /**
   * 校验登录输入并创建用户会话。
   *
   * @param request 当前业务请求。
   * @returns 整理后的状态与操作结果对象。
   */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() request: DemoLoginDto) {
    this.requireDevelopment();
    const result = await this.auth.login(request.email, request.password);
    if (!result) throw new HttpException('邮箱或密码错误。', HttpStatus.UNAUTHORIZED);
    return result;
  }

  /**
   * 撤销当前请求使用的登录会话。
   *
   * @param request 当前 Fastify HTTP 请求。
   * @returns 整理后的状态与操作结果对象。
   */
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Req() request: FastifyRequest) {
    const token = extractBearerToken(request.headers.authorization);
    if (token) await this.auth.revoke(token);
    return { status: 'logged_out' };
  }

  /**
   * 返回当前已鉴权用户的身份信息。
   *
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 用户访问身份。
   */
  @Get('me')
  me(@CurrentAccess() context: AccessContext) {
    return context;
  }

  /**
   * 限制开发专用入口仅在允许的环境开放。
   */
  private requireDevelopment(): void {
    if (this.config.appEnv === 'production') {
      throw new HttpException('Not found.', HttpStatus.NOT_FOUND);
    }
  }
}
