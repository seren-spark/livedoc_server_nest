import { Module } from '@nestjs/common';
import { ObservabilityService } from './observability.service.js';

@Module({ providers: [ObservabilityService], exports: [ObservabilityService] })
export class ObservabilityModule {}
