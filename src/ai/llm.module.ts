/**
 * @file 模型调用模块。导出共享 LLM 服务，供写作、摘要和知识编译调用。
 */
import { Module } from '@nestjs/common';
import { LlmService } from './llm.service.js';

@Module({ providers: [LlmService], exports: [LlmService] })
export class LlmModule {}
