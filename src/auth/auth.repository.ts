import { DatabaseService } from '../database/database.service.js';

export interface IdentityRow {
  user_id: string;
  username: string;
  email: string;
  space_id: string;
}

export class AuthRepository {
  constructor(private readonly database: DatabaseService) {}

  async createSession(tokenHash: string, userId: string, expiresAt: Date): Promise<void> {
    await this.database.query(
      `INSERT INTO demo_sessions (token_hash,user_id,expires_at,created_at)
       VALUES (?,?,?,UTC_TIMESTAMP(6))`,
      [tokenHash, userId, expiresAt],
    );
  }

  async findSession(tokenHash: string): Promise<{ user_id: string; expires_at: Date } | null> {
    const rows = await this.database.query<{ user_id: string; expires_at: Date }>(
      'SELECT user_id,expires_at FROM demo_sessions WHERE token_hash=?',
      [tokenHash],
    );
    return rows[0] ?? null;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.database.query('DELETE FROM demo_sessions WHERE token_hash=?', [tokenHash]);
  }

  async upsertUser(input: IdentityRow & { password_hash: string }): Promise<void> {
    await this.database.query(
      `INSERT INTO demo_users (user_id,username,email,password_hash,space_id,is_active)
       VALUES (?,?,?,?,?,TRUE)
       ON DUPLICATE KEY UPDATE
         username=VALUES(username),space_id=VALUES(space_id),is_active=TRUE`,
      [input.user_id, input.username, input.email, input.password_hash, input.space_id],
    );
  }

  async addUserToTeam(userId: string, teamId: string): Promise<void> {
    await this.database.query(
      'INSERT IGNORE INTO demo_user_teams (user_id,team_id) VALUES (?,?)',
      [userId, teamId],
    );
  }

  async findIdentityByEmail(email: string): Promise<IdentityRow | null> {
    return this.findIdentity('email', email);
  }

  async findIdentityByUserId(userId: string): Promise<IdentityRow | null> {
    return this.findIdentity('user_id', userId);
  }

  async listTeamIds(userId: string): Promise<string[]> {
    const rows = await this.database.query<{ team_id: string }>(
      'SELECT team_id FROM demo_user_teams WHERE user_id=?',
      [userId],
    );
    return rows.map((row) => row.team_id);
  }

  async findPasswordHash(email: string): Promise<string | null> {
    const rows = await this.database.query<{ password_hash: string }>(
      'SELECT password_hash FROM demo_users WHERE email=?',
      [email],
    );
    return rows[0]?.password_hash ?? null;
  }

  private async findIdentity(column: 'email' | 'user_id', value: string): Promise<IdentityRow | null> {
    const rows = await this.database.query<IdentityRow>(
      `SELECT user_id,username,email,space_id FROM demo_users
       WHERE ${column}=? AND is_active=TRUE`,
      [value],
    );
    return rows[0] ?? null;
  }
}
