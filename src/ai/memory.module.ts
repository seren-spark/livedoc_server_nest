import { Module } from '@nestjs/common';
import { ConversationMemoryService } from './memory.service.js';

@Module({
  providers: [ConversationMemoryService],
  exports: [ConversationMemoryService],
})
export class MemoryModule {}
