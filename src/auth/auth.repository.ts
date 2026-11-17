/**
 * @file 鉴权数据存储。读写登录会话、用户身份、密码摘要和团队成员关系。
 */
import { DatabaseService } from '../database/database.service.js';

export interface IdentityRow {
  user_id: string;
  username: string;
  email: string;
  space_id: string;
}

export class AuthRepository {
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param database 共享数据库服务。
   */
  constructor(private readonly database: DatabaseService) {}

  /**
   * 保存新登录会话及其过期时间。
   *
   * @param tokenHash 词项对应的稳定哈希索引。
   * @param userId 当前用户标识。
   * @param expiresAt 会话或记录的失效时间。
   */
  async createSession(tokenHash: string, userId: string, expiresAt: Date): Promise<void> {
    await this.database.query(
      `INSERT INTO demo_sessions (token_hash,user_id,expires_at,created_at)
       VALUES (?,?,?,UTC_TIMESTAMP(6))`,
      [tokenHash, userId, expiresAt],
    );
  }

  /**
   * 按令牌摘要查询仍有效的登录会话。
   *
   * @param tokenHash 词项对应的稳定哈希索引。
   * @returns 时间对象；未找到或不可用时可能为空。
   */
  async findSession(tokenHash: string): Promise<{ user_id: string; expires_at: Date } | null> {
    const rows = await this.database.query<{ user_id: string; expires_at: Date }>(
      'SELECT user_id,expires_at FROM demo_sessions WHERE token_hash=?',
      [tokenHash],
    );
    return rows[0] ?? null;
  }

  /**
   * 删除指定令牌对应的会话。
   *
   * @param tokenHash 词项对应的稳定哈希索引。
   */
  async deleteSession(tokenHash: string): Promise<void> {
    await this.database.query('DELETE FROM demo_sessions WHERE token_hash=?', [tokenHash]);
  }

  /**
   * 创建用户或更新已有用户的身份信息。
   *
   * @param input 本次操作的输入数据。
   */
  async upsertUser(input: IdentityRow & { password_hash: string }): Promise<void> {
    await this.database.query(
      `INSERT INTO demo_users (user_id,username,email,password_hash,space_id,is_active)
       VALUES (?,?,?,?,?,TRUE)
       ON DUPLICATE KEY UPDATE
         username=VALUES(username),space_id=VALUES(space_id),is_active=TRUE`,
      [input.user_id, input.username, input.email, input.password_hash, input.space_id],
    );
  }

  /**
   * 保存用户与团队的成员关系。
   *
   * @param userId 当前用户标识。
   * @param teamId team 对应的唯一标识。
   */
  async addUserToTeam(userId: string, teamId: string): Promise<void> {
    await this.database.query(
      'INSERT IGNORE INTO demo_user_teams (user_id,team_id) VALUES (?,?)',
      [userId, teamId],
    );
  }

  /**
   * 按邮箱读取用户身份。
   *
   * @param email 登录邮箱。
   * @returns IdentityRow 类型的处理结果；未找到或不可用时可能为空。
   */
  async findIdentityByEmail(email: string): Promise<IdentityRow | null> {
    return this.findIdentity('email', email);
  }

  /**
   * 按用户标识读取身份信息。
   *
   * @param userId 当前用户标识。
   * @returns IdentityRow 类型的处理结果；未找到或不可用时可能为空。
   */
  async findIdentityByUserId(userId: string): Promise<IdentityRow | null> {
    return this.findIdentity('user_id', userId);
  }

  /**
   * 读取用户所属团队的标识列表。
   *
   * @param userId 当前用户标识。
   * @returns 整理后的字符串列表。
   */
  async listTeamIds(userId: string): Promise<string[]> {
    const rows = await this.database.query<{ team_id: string }>(
      'SELECT team_id FROM demo_user_teams WHERE user_id=?',
      [userId],
    );
    return rows.map((row) => row.team_id);
  }

  /**
   * 读取用于密码校验的已保存摘要。
   *
   * @param email 登录邮箱。
   * @returns 整理后的文本或标识；未找到或不可用时可能为空。
   */
  async findPasswordHash(email: string): Promise<string | null> {
    const rows = await this.database.query<{ password_hash: string }>(
      'SELECT password_hash FROM demo_users WHERE email=?',
      [email],
    );
    return rows[0]?.password_hash ?? null;
  }

  /**
   * 查询并整理完整用户身份。
   *
   * @param column 数据库列名或目标列。
   * @param value 待校验或转换的值。
   * @returns IdentityRow 类型的处理结果；未找到或不可用时可能为空。
   */
  private async findIdentity(column: 'email' | 'user_id', value: string): Promise<IdentityRow | null> {
    const rows = await this.database.query<IdentityRow>(
      `SELECT user_id,username,email,space_id FROM demo_users
       WHERE ${column}=? AND is_active=TRUE`,
      [value],
    );
    return rows[0] ?? null;
  }
}
