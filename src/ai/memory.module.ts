/**
 * @file 对话记忆模块。注册对话历史及会话约束服务，供 AI 写作复用。
 */
import { ConversationConstraintsService } from './conversation-constraints.service.js';
import { Module } from '@nestjs/common';
import { ConversationMemoryService } from './memory.service.js';
import { WritingPreferencesService } from './writing-preferences.service.js';

@Module({
  providers: [ConversationMemoryService, ConversationConstraintsService, WritingPreferencesService],
  exports: [ConversationMemoryService, ConversationConstraintsService, WritingPreferencesService],
})
export class MemoryModule {}
