import { ConflictException } from '@nestjs/common';
import type { AccessContext } from '../common/types.js';
import { DatabaseService } from '../database/database.service.js';
import type { PreferenceReceipt, PreferenceState } from './writing-preferences.types.js';

const scopeKey = (context: AccessContext) => JSON.stringify([context.space_id, context.user_id]);
const decode = <T>(value: unknown): T => (typeof value === 'string' ? JSON.parse(value) : value) as T;

export class WritingPreferencesRepository {
  private readonly states = new Map<string, PreferenceState>();
  private readonly inputs = new Map<string, { hash: string; receipt: PreferenceReceipt }>();

  constructor(private readonly database: DatabaseService) {}

  async read(context: AccessContext): Promise<PreferenceState> {
    if (!this.database.memoryEnabled) return structuredClone(this.states.get(scopeKey(context)) ?? { revision: 0, items: [] });
    const [row] = await this.database.query<{ revision: number; items: unknown }>(
      'SELECT revision,items FROM writing_preference_states WHERE space_id=? AND user_id=?',
      [context.space_id, context.user_id],
    );
    return row ? { revision: Number(row.revision), items: decode(row.items) } : { revision: 0, items: [] };
  }

  async processed(context: AccessContext, inputKey: string, hash: string): Promise<PreferenceReceipt | undefined> {
    if (!this.database.memoryEnabled) {
      const stored = this.inputs.get(`${scopeKey(context)}:${inputKey}`);
      if (stored) this.sameInput(stored.hash, hash);
      return stored ? structuredClone(stored.receipt) : undefined;
    }
    const [row] = await this.database.query<{ content_hash: string; result: unknown }>(
      'SELECT content_hash,result FROM writing_preference_inputs WHERE space_id=? AND user_id=? AND input_key=?',
      [context.space_id, context.user_id, inputKey],
    );
    if (!row) return undefined;
    this.sameInput(row.content_hash, hash);
    return decode(row.result);
  }

  async commit(context: AccessContext, inputKey: string, hash: string, previousRevision: number,
    result: PreferenceReceipt): Promise<PreferenceReceipt> {
    if (!this.database.memoryEnabled) {
      const key = scopeKey(context);
      const duplicate = this.inputs.get(`${key}:${inputKey}`);
      if (duplicate) {
        this.sameInput(duplicate.hash, hash);
        return structuredClone(duplicate.receipt);
      }
      if ((this.states.get(key)?.revision ?? 0) !== previousRevision) this.conflict();
      // The version comparison and both writes run without an intervening await.
      this.states.set(key, structuredClone(result.state));
      this.inputs.set(`${key}:${inputKey}`, { hash, receipt: structuredClone(result) });
      return structuredClone(result);
    }
    return this.database.transaction(async (manager) => {
      await manager.query(
        "INSERT IGNORE INTO writing_preference_states(space_id,user_id,revision,items) VALUES(?,?,0,'[]')",
        [context.space_id, context.user_id],
      );
      const [state] = await manager.query(
        'SELECT revision FROM writing_preference_states WHERE space_id=? AND user_id=? FOR UPDATE',
        [context.space_id, context.user_id],
      );
      const [duplicate] = await manager.query(
        'SELECT content_hash,result FROM writing_preference_inputs WHERE space_id=? AND user_id=? AND input_key=?',
        [context.space_id, context.user_id, inputKey],
      );
      if (duplicate) {
        this.sameInput(duplicate.content_hash, hash);
        return decode<PreferenceReceipt>(duplicate.result);
      }
      if (Number(state.revision) !== previousRevision) this.conflict();
      await manager.query(
        'UPDATE writing_preference_states SET revision=?,items=? WHERE space_id=? AND user_id=?',
        [result.state.revision, JSON.stringify(result.state.items), context.space_id, context.user_id],
      );
      await manager.query(
        'INSERT INTO writing_preference_inputs(space_id,user_id,input_key,content_hash,result) VALUES(?,?,?,?,?)',
        [context.space_id, context.user_id, inputKey, hash, JSON.stringify(result)],
      );
      return structuredClone(result);
    });
  }

  private sameInput(previous: string, next: string) {
    if (previous !== next) throw new ConflictException({ code: 'PREFERENCE_INPUT_CHANGED', message: '同一输入标识对应的偏好内容已变化' });
  }

  private conflict(): never {
    throw new ConflictException({ code: 'PREFERENCE_VERSION_CONFLICT', message: '写作偏好已被其他输入更新，请重新加载' });
  }
}
