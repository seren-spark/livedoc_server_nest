import type { AccessContext } from '../common/types.js';
import { DatabaseService } from '../database/database.service.js';

export interface ConversationTurnRow {
  turn_id: string;
  user_content: string;
  assistant_content: string;
  created_at: Date;
}

export interface LegacyMessageRow {
  role: string;
  content: string;
  created_at: Date;
}

export class ConversationMemoryRepository {
  constructor(private readonly database: DatabaseService) {}

  async addTurn(input: {
    turnId: string;
    conversationId: string;
    userContent: string;
    assistantContent: string;
    context: AccessContext;
    docId?: string;
    now: Date;
    expiresAt: Date;
    maxTurns: number;
  }): Promise<void> {
    await this.database.transaction(async (manager) => {
      await manager.query('DELETE FROM conversation_turns WHERE expires_at<=UTC_TIMESTAMP(6)');
      await manager.query(
        `INSERT INTO conversation_turns
          (turn_id,conversation_id,user_id,space_id,doc_id,user_content,
           assistant_content,created_at,expires_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          input.turnId,
          input.conversationId,
          input.context.user_id,
          input.context.space_id,
          input.docId ?? null,
          input.userContent,
          input.assistantContent,
          input.now,
          input.expiresAt,
        ],
      );
      const rows = (await manager.query(
        `SELECT turn_id FROM conversation_turns
         WHERE conversation_id=? AND user_id=? AND space_id=?
           AND ${input.docId ? 'doc_id=?' : 'doc_id IS NULL'}
         ORDER BY created_at DESC`,
        [
          input.conversationId,
          input.context.user_id,
          input.context.space_id,
          ...(input.docId ? [input.docId] : []),
        ],
      )) as Array<{ turn_id: string }>;
      const stale = rows.slice(input.maxTurns).map((row) => row.turn_id);
      if (stale.length) {
        await manager.query(
          `DELETE FROM conversation_turns WHERE turn_id IN (${placeholders(stale)})`,
          stale,
        );
      }
    });
  }

  async recentTurns(
    conversationId: string,
    context: AccessContext,
    docId: string | undefined,
    limit: number,
  ): Promise<ConversationTurnRow[]> {
    const rows = await this.database.query<ConversationTurnRow>(
      `SELECT turn_id,user_content,assistant_content,created_at FROM conversation_turns
       WHERE conversation_id=? AND user_id=? AND space_id=?
         AND ${docId ? 'doc_id=?' : 'doc_id IS NULL'}
         AND expires_at>UTC_TIMESTAMP(6)
       ORDER BY created_at DESC LIMIT ?`,
      [conversationId, context.user_id, context.space_id, ...(docId ? [docId] : []), limit],
    );
    return rows.reverse().map((row) => ({ ...row, created_at: new Date(row.created_at) }));
  }

  async deleteDocument(docId: string): Promise<void> {
    await this.database.query('DELETE FROM conversation_turns WHERE doc_id=?', [docId]);
  }

  async addLegacyMessage(input: {
    messageId: string;
    conversationId: string;
    context: AccessContext;
    role: string;
    content: string;
    now: Date;
    expiresAt: Date;
  }): Promise<void> {
    await this.database.query(
      `INSERT INTO conversation_messages
        (message_id,conversation_id,user_id,space_id,role,content,created_at,expires_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        input.messageId,
        input.conversationId,
        input.context.user_id,
        input.context.space_id,
        input.role,
        input.content,
        input.now,
        input.expiresAt,
      ],
    );
  }

  async recentLegacyMessages(
    conversationId: string,
    context: AccessContext,
    limit: number,
  ): Promise<LegacyMessageRow[]> {
    const rows = await this.database.query<LegacyMessageRow>(
      `SELECT role,content,created_at FROM conversation_messages
       WHERE conversation_id=? AND user_id=? AND space_id=?
         AND expires_at>UTC_TIMESTAMP(6)
       ORDER BY created_at DESC LIMIT ?`,
      [conversationId, context.user_id, context.space_id, limit],
    );
    return rows.reverse();
  }
}

function placeholders(values: unknown[]): string {
  return values.map(() => '?').join(',');
}
