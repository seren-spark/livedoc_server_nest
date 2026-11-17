/**
 * @file 对话历史存储。保存和读取完整问答轮次，并兼容旧版消息记录。
 */
import type { AccessContext } from "../common/types.js";
import { DatabaseService } from "../database/database.service.js";

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
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param database 共享数据库服务。
   */
  constructor(private readonly database: DatabaseService) {}

  /**
   * 保存完整的一轮用户输入与助手回答。
   *
   * @param input 当前用户、空间与团队身份，用于权限校验。
   */
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
      await manager.query(
        "DELETE FROM conversation_turns WHERE expires_at<=UTC_TIMESTAMP(6)",
      );
      await manager.query(
        `INSERT INTO conversation_turns
          (turn_id,conversation_id,user_id,space_id,doc_id,user_content,
           assistant_content,created_at,expires_at)
         VALUES (?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE turn_id=turn_id`,
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
           AND ${input.docId ? "doc_id=?" : "doc_id IS NULL"}
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

  /**
   * 读取最近的完整问答轮次，保持原有对话顺序。
   *
   * @param conversationId 当前会话标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param docId 知识文档标识。
   * @param limit 本次读取或处理的数量上限。
   * @returns 整理后的结果列表。
   */
  async recentTurns(
    conversationId: string,
    context: AccessContext,
    docId: string | undefined,
    limit: number,
  ): Promise<ConversationTurnRow[]> {
    const rows = await this.database.query<ConversationTurnRow>(
      `SELECT turn_id,user_content,assistant_content,created_at FROM conversation_turns
       WHERE conversation_id=? AND user_id=? AND space_id=?
         AND ${docId ? "doc_id=?" : "doc_id IS NULL"}
         AND expires_at>UTC_TIMESTAMP(6)
       ORDER BY created_at DESC LIMIT ?`,
      [
        conversationId,
        context.user_id,
        context.space_id,
        ...(docId ? [docId] : []),
        limit,
      ],
    );
    return rows
      .reverse()
      .map((row) => ({ ...row, created_at: new Date(row.created_at) }));
  }

  /**
   * 删除指定文档对应的数据及关联记录。
   *
   * @param docId 知识文档标识。
   */
  async deleteDocument(docId: string): Promise<void> {
    await this.database.query("DELETE FROM conversation_turns WHERE doc_id=?", [
      docId,
    ]);
  }

  /**
   * 按旧版消息格式保存一条对话记录。
   *
   * @param input 当前用户、空间与团队身份，用于权限校验。
   */
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

  /**
   * 读取旧版格式的最近消息，供兼容路径使用。
   *
   * @param conversationId 当前会话标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param limit 本次读取或处理的数量上限。
   * @returns 整理后的结果列表。
   */
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

/**
 * 生成与参数数量匹配的 SQL 占位符。
 *
 * @param values 待转换或去重的值集合。
 * @returns 整理后的文本或标识。
 */
function placeholders(values: unknown[]): string {
  return values.map(() => "?").join(",");
}
