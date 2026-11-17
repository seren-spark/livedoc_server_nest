/**
 * @file 检索观测模块。注册检索追踪、反馈存储与统计服务。
 */
import { Module } from '@nestjs/common';
import { ObservabilityService } from './observability.service.js';

@Module({ providers: [ObservabilityService], exports: [ObservabilityService] })
export class ObservabilityModule {}
