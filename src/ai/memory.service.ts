import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { getEncoding, type Tiktoken } from 'js-tiktoken';
import type { AccessContext } from '../common/types.js';
import { AppConfig } from '../config/app-config.js';
import { DatabaseService } from '../database/database.service.js';

interface ConversationTurn {
  turn_id: string;
  user_content: string;
  assistant_content: string;
  created_at: Date;
}

interface LegacyMessage {
  role: string;
  content: string;
  created_at: Date;
}

@Injectable()
export class ConversationMemoryService {
  private readonly turns = new Map<string, ConversationTurn[]>();
  private readonly legacyMessages = new Map<string, LegacyMessage[]>();
  private readonly tokenizer: Tiktoken;

  constructor(
    private readonly config: AppConfig,
    private readonly database: DatabaseService,
  ) {
    this.tokenizer = getEncoding(
      this.config.tokenizerEncoding as Parameters<typeof getEncoding>[0],
    );
  }

  async addTurn(
    conversationId: string,
    userContent: string,
    assistantContent: string,
    context: AccessContext,
    docId?: string,
  ): Promise<void> {
    const now = new Date();
    const turn: ConversationTurn = {
      turn_id: randomUUID().replaceAll('-', ''),
      user_content: userContent,
      assistant_content: assistantContent,
      created_at: now,
    };
    if (this.database.memoryEnabled) {
      await this.database.source.transaction(async (manager) => {
        await manager.query('DELETE FROM conversation_turns WHERE expires_at <= UTC_TIMESTAMP(6)');
        await manager.query(
          `INSERT INTO conversation_turns
            (turn_id,conversation_id,user_id,space_id,doc_id,user_content,
             assistant_content,created_at,expires_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [turn.turn_id, conversationId, context.user_id, context.space_id, docId ?? null,
            userContent, assistantContent, now,
            new Date(now.getTime() + this.config.memoryTtlDays * 86_400_000)],
        );
        const rows = (await manager.query(
          `SELECT turn_id FROM conversation_turns
           WHERE conversation_id=? AND user_id=? AND space_id=? AND ${docId ? 'doc_id=?' : 'doc_id IS NULL'}
           ORDER BY created_at DESC`,
          [conversationId, context.user_id, context.space_id, ...(docId ? [docId] : [])],
        )) as Array<{ turn_id: string }>;
        const stale = rows.slice(this.config.memoryMaxTurns).map((row) => row.turn_id);
        if (stale.length) {
          await manager.query(
            `DELETE FROM conversation_turns WHERE turn_id IN (${stale.map(() => '?').join(',')})`,
            stale,
          );
        }
      });
      return;
    }
    const key = memoryKey(conversationId, context, docId);
    this.turns.set(key, [...(this.turns.get(key) ?? []), turn].slice(-this.config.memoryMaxTurns));
  }

  async recentText(
    conversationId: string | undefined,
    context: AccessContext,
    docId?: string,
  ): Promise<string> {
    if (!conversationId) return '';
    let turns: ConversationTurn[] = [];
    if (this.database.memoryEnabled) {
      const rows = await this.database.query<ConversationTurn>(
        `SELECT turn_id,user_content,assistant_content,created_at FROM conversation_turns
         WHERE conversation_id=? AND user_id=? AND space_id=? AND ${docId ? 'doc_id=?' : 'doc_id IS NULL'}
           AND expires_at>UTC_TIMESTAMP(6)
         ORDER BY created_at DESC LIMIT ?`,
        [conversationId, context.user_id, context.space_id,
          ...(docId ? [docId] : []), this.config.memoryMaxTurns],
      );
      turns = rows.reverse().map((row) => ({ ...row, created_at: new Date(row.created_at) }));
    } else turns = this.turns.get(memoryKey(conversationId, context, docId)) ?? [];
    if (!turns.length) return this.legacyRecentText(conversationId, context);
    return this.fitCompleteTurns(turns);
  }

  async deleteDocument(docId: string): Promise<void> {
    if (this.database.memoryEnabled) {
      await this.database.query('DELETE FROM conversation_turns WHERE doc_id=?', [docId]);
      return;
    }
    for (const key of this.turns.keys()) if (key.endsWith(`:${docId}`)) this.turns.delete(key);
  }

  /** Compatibility for older callers; new generation code must use addTurn. */
  async add(conversationId: string, role: string, content: string, context: AccessContext): Promise<void> {
    const now = new Date();
    if (this.database.memoryEnabled) {
      await this.database.query(
        `INSERT INTO conversation_messages
          (message_id,conversation_id,user_id,space_id,role,content,created_at,expires_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [randomUUID().replaceAll('-', ''), conversationId, context.user_id, context.space_id,
          role, content, now, new Date(now.getTime() + this.config.memoryTtlDays * 86_400_000)],
      );
      return;
    }
    const key = legacyMemoryKey(conversationId, context);
    this.legacyMessages.set(
      key,
      [...(this.legacyMessages.get(key) ?? []), { role, content, created_at: now }]
        .slice(-this.config.memoryMaxMessages),
    );
  }

  private fitCompleteTurns(turns: ConversationTurn[]): string {
    const selected: string[] = [];
    let used = 0;
    for (const turn of [...turns].reverse()) {
      const text = `user: ${turn.user_content}\nassistant: ${turn.assistant_content}`;
      const count = this.tokenizer.encode(text).length;
      if (used + count > this.config.shortMemoryTokenBudget) continue;
      selected.unshift(text);
      used += count;
    }
    return selected.join('\n');
  }

  private async legacyRecentText(conversationId: string, context: AccessContext): Promise<string> {
    let items: LegacyMessage[];
    if (this.database.memoryEnabled) {
      const rows = await this.database.query<LegacyMessage>(
        `SELECT role,content,created_at FROM conversation_messages
         WHERE conversation_id=? AND user_id=? AND space_id=? AND expires_at>UTC_TIMESTAMP(6)
         ORDER BY created_at DESC LIMIT ?`,
        [conversationId, context.user_id, context.space_id, this.config.memoryMaxMessages],
      );
      items = rows.reverse();
    } else items = this.legacyMessages.get(legacyMemoryKey(conversationId, context)) ?? [];
    return items.map((item) => `${item.role}: ${item.content}`).join('\n');
  }
}

export function memoryKey(conversationId: string, context: AccessContext, docId?: string): string {
  return `${conversationId}:${context.user_id}:${context.space_id}:${docId ?? ''}`;
}

function legacyMemoryKey(conversationId: string, context: AccessContext): string {
  return `${conversationId}:${context.user_id}:${context.space_id}`;
}
