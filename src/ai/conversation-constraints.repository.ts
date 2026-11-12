import { DatabaseService } from '../database/database.service.js';
import { AgentExecutionError } from './agent-execution.js';

export interface ConversationConstraint {
  id: string;
  kind: 'goal' | 'constraint';
  text: string;
  quote: string;
  source_id: string;
}
export interface ConstraintSnapshot {
  revision: number;
  items: ConversationConstraint[];
}
export interface ConstraintScope {
  key: string;
  user_id: string;
  space_id: string;
  conversation_id: string;
  document_key: string;
}
const decode = <T>(value: unknown): T =>
  (typeof value === 'string' ? JSON.parse(value) : value) as T;

export class ConversationConstraintsRepository {
  private readonly states = new Map<string, ConstraintSnapshot & { expires: number; document: string }>();
  private readonly inputs = new Map<string, { hash: string; snapshot: ConstraintSnapshot; expires: number }>();

  constructor(private readonly database: DatabaseService) {}

  async read(scope: ConstraintScope): Promise<ConstraintSnapshot> {
    if (!this.database.memoryEnabled) {
      const state = this.states.get(scope.key);
      return state && state.expires > Date.now()
        ? structuredClone({ revision: state.revision, items: state.items })
        : { revision: 0, items: [] };
    }
    const [state] = await this.database.query<any>(
      'SELECT revision,items FROM conversation_constraint_states WHERE scope_key=? AND expires_at>UTC_TIMESTAMP(6)',
      [scope.key],
    );
    return state ? { revision: state.revision, items: decode(state.items) } : { revision: 0, items: [] };
  }

  async processed(scope: ConstraintScope, inputKey: string, hash: string): Promise<ConstraintSnapshot | undefined> {
    let receipt: { hash: string; snapshot: ConstraintSnapshot } | undefined;
    if (this.database.memoryEnabled) {
      const [row] = await this.database.query<any>(
        'SELECT content_hash,snapshot FROM conversation_constraint_inputs WHERE scope_key=? AND input_key=? AND expires_at>UTC_TIMESTAMP(6)',
        [scope.key, inputKey],
      );
      if (row) receipt = { hash: row.content_hash, snapshot: decode(row.snapshot) };
    } else {
      const row = this.inputs.get(`${scope.key}:${inputKey}`);
      if (row && row.expires > Date.now()) receipt = structuredClone(row);
    }
    if (receipt && receipt.hash !== hash)
      throw new AgentExecutionError('MEMORY_INPUT_CHANGED', '同一输入标识对应的用户内容已变化');
    return receipt?.snapshot;
  }

  async commit(scope: ConstraintScope, inputKey: string, hash: string,
    previous: ConstraintSnapshot, next: ConstraintSnapshot, expiresAt: Date): Promise<ConstraintSnapshot> {
    if (!this.database.memoryEnabled) {
      const duplicate = await this.processed(scope, inputKey, hash);
      if (duplicate) return duplicate;
      const state = this.states.get(scope.key);
      const revision = state && state.expires > Date.now() ? state.revision : 0;
      if (revision !== previous.revision) this.conflict();
      // No await between the version check and the two writes.
      this.states.set(scope.key, { ...structuredClone(next), expires: expiresAt.getTime(), document: scope.document_key });
      this.inputs.set(`${scope.key}:${inputKey}`, { hash, snapshot: structuredClone(next), expires: expiresAt.getTime() });
      return next;
    }
    return this.database.transaction(async (manager) => {
      await manager.query('DELETE FROM conversation_constraint_inputs WHERE expires_at<=UTC_TIMESTAMP(6)');
      await manager.query('DELETE FROM conversation_constraint_states WHERE expires_at<=UTC_TIMESTAMP(6)');
      await manager.query(
        `INSERT IGNORE INTO conversation_constraint_states
         (scope_key,user_id,space_id,conversation_id,document_key,revision,items,expires_at)
         VALUES (?,?,?,?,?,0,'[]',?)`,
        [scope.key, scope.user_id, scope.space_id, scope.conversation_id, scope.document_key, expiresAt],
      );
      const [state] = await manager.query(
        'SELECT revision FROM conversation_constraint_states WHERE scope_key=? FOR UPDATE', [scope.key],
      );
      const [duplicate] = await manager.query(
        'SELECT content_hash,snapshot FROM conversation_constraint_inputs WHERE scope_key=? AND input_key=?',
        [scope.key, inputKey],
      );
      if (duplicate) {
        if (duplicate.content_hash !== hash)
          throw new AgentExecutionError('MEMORY_INPUT_CHANGED', '同一输入标识对应的用户内容已变化');
        return decode<ConstraintSnapshot>(duplicate.snapshot);
      }
      if (state.revision !== previous.revision) this.conflict();
      await manager.query(
        'UPDATE conversation_constraint_states SET revision=?,items=?,expires_at=? WHERE scope_key=?',
        [next.revision, JSON.stringify(next.items), expiresAt, scope.key],
      );
      await manager.query(
        'INSERT INTO conversation_constraint_inputs (scope_key,input_key,content_hash,snapshot,expires_at) VALUES (?,?,?,?,?)',
        [scope.key, inputKey, hash, JSON.stringify(next), expiresAt],
      );
      return next;
    });
  }

  async deleteDocument(documentKey: string): Promise<void> {
    if (!this.database.memoryEnabled) {
      for (const [key, state] of this.states) {
        if (state.document !== documentKey) continue;
        this.states.delete(key);
        for (const input of this.inputs.keys()) if (input.startsWith(`${key}:`)) this.inputs.delete(input);
      }
      return;
    }
    await this.database.transaction(async (manager) => {
      await manager.query(`DELETE inputs FROM conversation_constraint_inputs inputs
        INNER JOIN conversation_constraint_states states ON inputs.scope_key=states.scope_key
        WHERE states.document_key=?`, [documentKey]);
      await manager.query('DELETE FROM conversation_constraint_states WHERE document_key=?', [documentKey]);
    });
  }

  private conflict(): never {
    throw new AgentExecutionError('MEMORY_VERSION_CONFLICT', '会话约束已被另一输入更新，请重试当前任务', true);
  }
}
