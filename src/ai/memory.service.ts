import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AccessContext } from '../common/types.js';
import { AppConfig } from '../config/app-config.js';
import { DatabaseService } from '../database/database.service.js';

interface Message {
  role: string;
  content: string;
  created_at: Date;
}

@Injectable()
export class ConversationMemoryService {
  private readonly messages = new Map<string, Message[]>();

  constructor(
    private readonly config: AppConfig,
    private readonly database: DatabaseService,
  ) {}

  async add(conversationId: string, role: string, content: string, context: AccessContext): Promise<void> {
    const now = new Date();
    if (this.database.memoryEnabled) {
      await this.database.query('DELETE FROM conversation_messages WHERE expires_at <= UTC_TIMESTAMP(6)');
      await this.database.query(
        `INSERT INTO conversation_messages
          (message_id,conversation_id,user_id,space_id,role,content,created_at,expires_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          randomUUID().replaceAll('-', ''),
          conversationId,
          context.user_id,
          context.space_id,
          role,
          content,
          now,
          new Date(now.getTime() + this.config.memoryTtlDays * 24 * 60 * 60 * 1000),
        ],
      );
      return;
    }
    const key = memoryKey(conversationId, context);
    const items = [...(this.messages.get(key) ?? []), { role, content, created_at: now }];
    this.messages.set(key, items.slice(-this.config.memoryMaxMessages));
  }

  async recentText(conversationId: string | undefined, context: AccessContext): Promise<string> {
    if (!conversationId) return '';
    let items: Message[];
    if (this.database.memoryEnabled) {
      const rows = await this.database.query<{ role: string; content: string; created_at: Date }>(
        `SELECT role,content,created_at FROM conversation_messages
         WHERE conversation_id=? AND user_id=? AND space_id=? AND expires_at>UTC_TIMESTAMP(6)
         ORDER BY created_at DESC LIMIT ?`,
        [conversationId, context.user_id, context.space_id, this.config.memoryMaxMessages],
      );
      items = rows.reverse().map((row) => ({ ...row, created_at: new Date(row.created_at) }));
    } else items = this.messages.get(memoryKey(conversationId, context)) ?? [];
    return items.map((item) => `${item.role}: ${item.content}`).join('\n');
  }
}

export function memoryKey(conversationId: string, context: AccessContext): string {
  return `${conversationId}:${context.user_id}:${context.space_id}`;
}
