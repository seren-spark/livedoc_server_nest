import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { getEncoding, type Tiktoken } from 'js-tiktoken';
import type { AccessContext } from '../common/types.js';
import { AppConfig } from '../config/app-config.js';
import { DatabaseService } from '../database/database.service.js';
import {
  ConversationMemoryRepository,
  type ConversationTurnRow,
  type LegacyMessageRow,
} from './conversation-memory.repository.js';

type ConversationTurn = ConversationTurnRow;
type LegacyMessage = LegacyMessageRow;

@Injectable()
export class ConversationMemoryService {
  private readonly turns = new Map<string, ConversationTurn[]>();
  private readonly legacyMessages = new Map<string, LegacyMessage[]>();
  private readonly tokenizer: Tiktoken;
  private readonly repository: ConversationMemoryRepository;

  constructor(
    private readonly config: AppConfig,
    private readonly database: DatabaseService,
  ) {
    this.repository = new ConversationMemoryRepository(database);
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
      await this.repository.addTurn({
        turnId: turn.turn_id,
        conversationId,
        userContent,
        assistantContent,
        context,
        docId,
        now,
        expiresAt: new Date(now.getTime() + this.config.memoryTtlDays * 86_400_000),
        maxTurns: this.config.memoryMaxTurns,
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
      turns = await this.repository.recentTurns(
        conversationId,
        context,
        docId,
        this.config.memoryMaxTurns,
      );
    } else turns = this.turns.get(memoryKey(conversationId, context, docId)) ?? [];
    if (!turns.length) return this.legacyRecentText(conversationId, context);
    return this.fitCompleteTurns(turns);
  }

  async deleteDocument(docId: string): Promise<void> {
    if (this.database.memoryEnabled) {
      await this.repository.deleteDocument(docId);
      return;
    }
    for (const key of this.turns.keys()) if (key.endsWith(`:${docId}`)) this.turns.delete(key);
  }

  /** Compatibility for older callers; new generation code must use addTurn. */
  async add(conversationId: string, role: string, content: string, context: AccessContext): Promise<void> {
    const now = new Date();
    if (this.database.memoryEnabled) {
      await this.repository.addLegacyMessage({
        messageId: randomUUID().replaceAll('-', ''),
        conversationId,
        context,
        role,
        content,
        now,
        expiresAt: new Date(now.getTime() + this.config.memoryTtlDays * 86_400_000),
      });
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
      items = await this.repository.recentLegacyMessages(
        conversationId,
        context,
        this.config.memoryMaxMessages,
      );
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
