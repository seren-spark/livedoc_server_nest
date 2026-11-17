/**
 * @file 会话约束存储。持久化会话写作约束与已处理输入，防止重复应用同一轮修改。
 */
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
/**
 * 解析持久化的 JSON 数据，恢复业务结构。
 *
 * @param value 待校验或转换的值。
 * @returns T 类型的处理结果。
 */
const decode = <T>(value: unknown): T =>
  (typeof value === 'string' ? JSON.parse(value) : value) as T;

export class ConversationConstraintsRepository {
  private readonly states = new Map<string, ConstraintSnapshot & { expires: number; document: string }>();
  private readonly inputs = new Map<string, { hash: string; snapshot: ConstraintSnapshot; expires: number }>();

  /**
   * 初始化实例依赖与本地状态。
   *
   * @param database 共享数据库服务。
   */
  constructor(private readonly database: DatabaseService) {}

  /**
   * 读取当前作用范围内的会话约束。
   *
   * @param scope 本次检索或操作允许覆盖的范围。
   * @returns ConstraintSnapshot 类型的处理结果。
   */
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

  /**
   * 查询输入是否已处理，并校验其内容摘要。
   *
   * @param scope 本次检索或操作允许覆盖的范围。
   * @param inputKey inputKey 参数（string）。
   * @param hash 待核对的内容摘要。
   * @returns ConstraintSnapshot 类型的处理结果；未找到或不可用时可能为空。
   */
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

  /**
   * 校验当前版本后提交新状态与输入处理记录。
   *
   * @param scope 本次检索或操作允许覆盖的范围。
   * @param inputKey inputKey 参数（string）。
   * @param hash 待核对的内容摘要。
   * @param previous 更新前的状态。
   * @param next 准备写入的下一状态。
   * @param expiresAt 会话或记录的失效时间。
   * @returns ConstraintSnapshot 类型的处理结果。
   */
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

  /**
   * 删除指定文档对应的数据及关联记录。
   *
   * @param documentKey documentKey 参数（string）。
   */
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

  /**
   * 构造版本冲突错误，让调用方重新加载最新状态。
   */
  private conflict(): never {
    throw new AgentExecutionError('MEMORY_VERSION_CONFLICT', '会话约束已被另一输入更新，请重试当前任务', true);
  }
}
