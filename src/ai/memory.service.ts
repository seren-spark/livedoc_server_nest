/**
 * @file 对话记忆。按文档和用户隔离问答历史，在预算内保留完整轮次。
 */
import { ConversationConstraintsService } from './conversation-constraints.service.js';
import { Injectable } from "@nestjs/common";
import { randomUUID, createHash } from "node:crypto";
import { getEncoding, type Tiktoken } from "js-tiktoken";
import type { AccessContext } from "../common/types.js";
import { AppConfig } from "../config/app-config.js";
import { DatabaseService } from "../database/database.service.js";
import {
  ConversationMemoryRepository,
  type ConversationTurnRow,
  type LegacyMessageRow,
} from "./conversation-memory.repository.js";

type ConversationTurn = ConversationTurnRow;
type LegacyMessage = LegacyMessageRow;

@Injectable()
export class ConversationMemoryService {
  private readonly turns = new Map<string, ConversationTurn[]>();
  private readonly legacyMessages = new Map<string, LegacyMessage[]>();
  private readonly tokenizer: Tiktoken;
  private readonly repository: ConversationMemoryRepository;

  /**
   * 初始化实例依赖与本地状态。
   *
   * @param config 应用运行配置。
   * @param database 共享数据库服务。
   * @param constraints ConversationConstraintsService 依赖实例（可选）。
   */
  constructor(
    private readonly config: AppConfig,
    private readonly database: DatabaseService,
    private readonly constraints?: ConversationConstraintsService,
  ) {
    this.repository = new ConversationMemoryRepository(database);
    this.tokenizer = getEncoding(
      this.config.tokenizerEncoding as Parameters<typeof getEncoding>[0],
    );
  }

  /**
   * 保存完整的一轮用户输入与助手回答。
   *
   * @param conversationId 当前会话标识。
   * @param userContent 本轮对话的用户消息正文。
   * @param assistantContent 本轮对话的助手回答正文。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param docId 知识文档标识（可选）。
   * @param sourceId source 对应的唯一标识（可选）。
   */
  async addTurn(
    conversationId: string,
    userContent: string,
    assistantContent: string,
    context: AccessContext,
    docId?: string,
    sourceId?: string,
  ): Promise<void> {
    const now = new Date();
    const turn: ConversationTurn = {
      turn_id: sourceId
        ? createHash("sha256")
            .update(`agent:${sourceId}`)
            .digest("hex")
            .slice(0, 32)
        : randomUUID().replaceAll("-", ""),
      user_content: userContent,
      assistant_content: assistantContent,
      created_at: now,
    };
    if (this.database.memoryEnabled) {
      await this.repository.addTurn({
        turnId: turn.turn_id,
        conversationId,
        userContent,
        assistantContent,
        context,
        docId,
        now,
        expiresAt: new Date(
          now.getTime() + this.config.memoryTtlDays * 86_400_000,
        ),
        maxTurns: this.config.memoryMaxTurns,
      });
      return;
    }
    const key = memoryKey(conversationId, context, docId);
    const previous = this.turns.get(key) ?? [];
    if (!previous.some((item) => item.turn_id === turn.turn_id))
      this.turns.set(
        key,
        [...previous, turn].slice(-this.config.memoryMaxTurns),
      );
  }

  /**
   * 读取最近对话，并在 Token 预算内拼接完整轮次。
   *
   * @param conversationId 当前会话标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param docId 知识文档标识（可选）。
   * @param tokenBudget 可用于当前内容的 Token 预算。
   * @returns 整理后的文本或标识。
   */
  async recentText(
    conversationId: string | undefined,
    context: AccessContext,
    docId?: string,
    tokenBudget = this.config.shortMemoryTokenBudget,
  ): Promise<string> {
    if (!conversationId) return "";
    let turns: ConversationTurn[] = [];
    if (this.database.memoryEnabled) {
      turns = await this.repository.recentTurns(
        conversationId,
        context,
        docId,
        this.config.memoryMaxTurns,
      );
    } else
      turns = this.turns.get(memoryKey(conversationId, context, docId)) ?? [];
    if (!turns.length) return docId?.startsWith('agent:') ? '' : this.legacyRecentText(conversationId, context, tokenBudget);
    return this.fitCompleteTurns(turns, tokenBudget);
  }

  /**
   * 删除指定文档对应的数据及关联记录。
   *
   * @param docId 知识文档标识。
   */
  async deleteDocument(docId: string): Promise<void> {
    await this.constraints?.deleteDocument(docId);
    if (this.database.memoryEnabled) {
      await this.repository.deleteDocument(docId);
      return;
    }
    for (const key of this.turns.keys())
      if (key.endsWith(`:${docId}`)) this.turns.delete(key);
  }

  /**
   * 兼容旧调用方的单条消息写入入口，新写作流程使用完整轮次写入。
   *
   *  Compatibility for older callers; new generation code must use addTurn.
   *
   * @param conversationId 当前会话标识。
   * @param role 本次模型或 Worker 执行角色。
   * @param content 待处理的正文内容。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   */
  async add(
    conversationId: string,
    role: string,
    content: string,
    context: AccessContext,
  ): Promise<void> {
    const now = new Date();
    if (this.database.memoryEnabled) {
      await this.repository.addLegacyMessage({
        messageId: randomUUID().replaceAll("-", ""),
        conversationId,
        context,
        role,
        content,
        now,
        expiresAt: new Date(
          now.getTime() + this.config.memoryTtlDays * 86_400_000,
        ),
      });
      return;
    }
    const key = legacyMemoryKey(conversationId, context);
    this.legacyMessages.set(
      key,
      [
        ...(this.legacyMessages.get(key) ?? []),
        { role, content, created_at: now },
      ].slice(-this.config.memoryMaxMessages),
    );
  }

  /**
   * 仅保留预算可容纳的完整问答轮次，避免留下半轮对话。
   *
   * @param turns turns 参数（ConversationTurn[]）。
   * @param tokenBudget 可用于当前内容的 Token 预算。
   * @returns 整理后的文本或标识。
   */
  private fitCompleteTurns(turns: ConversationTurn[], tokenBudget: number): string {
    const selected: string[] = [];
    let used = 0;
    for (const turn of [...turns].reverse()) {
      const text = `user: ${turn.user_content}\nassistant: ${turn.assistant_content}`;
      const count = this.tokenizer.encode(text).length;
      if (used + count > tokenBudget) continue;
      selected.unshift(text);
      used += count;
    }
    return selected.join("\n");
  }

  /**
   * 从旧版消息记录生成兼容的历史上下文。
   *
   * @param conversationId 当前会话标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param tokenBudget 可用于当前内容的 Token 预算。
   * @returns 整理后的文本或标识。
   */
  private async legacyRecentText(
    conversationId: string,
    context: AccessContext,
    tokenBudget: number,
  ): Promise<string> {
    let items: LegacyMessage[];
    if (this.database.memoryEnabled) {
      items = await this.repository.recentLegacyMessages(
        conversationId,
        context,
        this.config.memoryMaxMessages,
      );
    } else
      items =
        this.legacyMessages.get(legacyMemoryKey(conversationId, context)) ?? [];
    const selected: string[] = [];
    let used = 0;
    for (const item of [...items].reverse()) {
      const text = `${item.role}: ${item.content}`;
      const tokens = this.tokenizer.encode(text).length;
      if (used + tokens > tokenBudget) continue;
      selected.unshift(text);
      used += tokens;
    }
    return selected.join('\n');
  }
}

/**
 * 生成包含用户与文档身份的对话记忆键。
 *
 * @param conversationId 当前会话标识。
 * @param context 当前用户、空间与团队身份，用于权限校验。
 * @param docId 知识文档标识（可选）。
 * @returns 整理后的文本或标识。
 */
export function memoryKey(
  conversationId: string,
  context: AccessContext,
  docId?: string,
): string {
  return `${conversationId}:${context.user_id}:${context.space_id}:${docId ?? ""}`;
}

/**
 * 生成兼容旧版对话存储的键。
 *
 * @param conversationId 当前会话标识。
 * @param context 当前用户、空间与团队身份，用于权限校验。
 * @returns 整理后的文本或标识。
 */
function legacyMemoryKey(
  conversationId: string,
  context: AccessContext,
): string {
  return `${conversationId}:${context.user_id}:${context.space_id}`;
}
