import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  createHash,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { AppConfig } from '../config/app-config.js';
import { DatabaseService } from '../database/database.service.js';
import type { AccessContext } from '../common/types.js';

const DEMO_PASSWORD = 'Demo@123456';
const DEMO_USERS = [
  ['user_alice', 'Alice', 'alice@livedoc.local', 'space_a', ['team_alpha']],
  ['user_bob', 'Bob', 'bob@livedoc.local', 'space_a', ['team_alpha']],
  ['user_carol', 'Carol', 'carol@livedoc.local', 'space_a', ['team_beta']],
] as const;

export interface DemoIdentity extends AccessContext {
  username: string;
  email: string;
}

interface MemoryUser {
  identity: DemoIdentity;
  passwordHash: string;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly users = new Map<string, MemoryUser>();
  private readonly sessions = new Map<string, { userId: string; expiresAt: Date }>();

  constructor(
    private readonly config: AppConfig,
    private readonly database: DatabaseService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.database.metadataEnabled) await this.seedMysql();
    else this.seedMemory();
  }

  async login(email: string, password: string): Promise<{ token: string; user: DemoIdentity } | null> {
    const identity = await this.identityByEmail(email.trim().toLowerCase());
    if (!identity) return null;
    const stored = await this.passwordHash(identity.email);
    if (!stored || !verifyPassword(password, stored)) return null;
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    if (this.database.metadataEnabled) {
      await this.database.query(
        `INSERT INTO demo_sessions (token_hash, user_id, expires_at, created_at)
         VALUES (?, ?, ?, UTC_TIMESTAMP(6))`,
        [hashToken(token), identity.user_id, expiresAt],
      );
    } else {
      this.sessions.set(hashToken(token), { userId: identity.user_id, expiresAt });
    }
    return { token, user: identity };
  }

  async resolve(token: string): Promise<DemoIdentity | null> {
    const tokenHash = hashToken(token);
    if (this.database.metadataEnabled) {
      const rows = await this.database.query<{ user_id: string; expires_at: Date }>(
        'SELECT user_id, expires_at FROM demo_sessions WHERE token_hash = ?',
        [tokenHash],
      );
      const row = rows[0];
      if (!row || new Date(row.expires_at).getTime() <= Date.now()) {
        if (row) await this.database.query('DELETE FROM demo_sessions WHERE token_hash = ?', [tokenHash]);
        return null;
      }
      return this.identityByUserId(row.user_id);
    }
    const session = this.sessions.get(tokenHash);
    if (!session || session.expiresAt.getTime() <= Date.now()) {
      this.sessions.delete(tokenHash);
      return null;
    }
    return this.identityByUserId(session.userId);
  }

  async revoke(token: string): Promise<void> {
    const tokenHash = hashToken(token);
    if (this.database.metadataEnabled) {
      await this.database.query('DELETE FROM demo_sessions WHERE token_hash = ?', [tokenHash]);
    } else this.sessions.delete(tokenHash);
  }

  private seedMemory(): void {
    for (const [userId, username, email, spaceId, teamIds] of DEMO_USERS) {
      this.users.set(email, {
        identity: {
          user_id: userId,
          username,
          email,
          space_id: spaceId,
          team_ids: [...teamIds],
        },
        passwordHash: hashPassword(DEMO_PASSWORD),
      });
    }
  }

  private async seedMysql(): Promise<void> {
    for (const [userId, username, email, spaceId, teamIds] of DEMO_USERS) {
      await this.database.query(
        `INSERT INTO demo_users
          (user_id, username, email, password_hash, space_id, is_active)
         VALUES (?, ?, ?, ?, ?, TRUE)
         ON DUPLICATE KEY UPDATE username = VALUES(username), space_id = VALUES(space_id), is_active = TRUE`,
        [userId, username, email, hashPassword(DEMO_PASSWORD), spaceId],
      );
      for (const teamId of teamIds) {
        await this.database.query(
          'INSERT IGNORE INTO demo_user_teams (user_id, team_id) VALUES (?, ?)',
          [userId, teamId],
        );
      }
    }
  }

  private async identityByEmail(email: string): Promise<DemoIdentity | null> {
    if (!this.database.metadataEnabled) return this.users.get(email)?.identity ?? null;
    const rows = await this.database.query<{
      user_id: string;
      username: string;
      email: string;
      space_id: string;
    }>('SELECT user_id, username, email, space_id FROM demo_users WHERE email = ? AND is_active = TRUE', [email]);
    const row = rows[0];
    return row ? this.identityWithTeams(row) : null;
  }

  private async identityByUserId(userId: string): Promise<DemoIdentity | null> {
    if (!this.database.metadataEnabled) {
      return [...this.users.values()].find((item) => item.identity.user_id === userId)?.identity ?? null;
    }
    const rows = await this.database.query<{
      user_id: string;
      username: string;
      email: string;
      space_id: string;
    }>('SELECT user_id, username, email, space_id FROM demo_users WHERE user_id = ? AND is_active = TRUE', [userId]);
    const row = rows[0];
    return row ? this.identityWithTeams(row) : null;
  }

  private async identityWithTeams(row: {
    user_id: string;
    username: string;
    email: string;
    space_id: string;
  }): Promise<DemoIdentity> {
    const teams = await this.database.query<{ team_id: string }>(
      'SELECT team_id FROM demo_user_teams WHERE user_id = ?',
      [row.user_id],
    );
    return { ...row, team_ids: teams.map((item) => item.team_id) };
  }

  private async passwordHash(email: string): Promise<string | null> {
    if (!this.database.metadataEnabled) return this.users.get(email)?.passwordHash ?? null;
    const rows = await this.database.query<{ password_hash: string }>(
      'SELECT password_hash FROM demo_users WHERE email = ?',
      [email],
    );
    return rows[0]?.password_hash ?? null;
  }
}

export function extractBearerToken(authorization?: string): string | null {
  if (!authorization?.toLowerCase().startsWith('bearer ')) return null;
  return authorization.slice(7).trim() || null;
}

export function hashPassword(password: string): string {
  const iterations = 240_000;
  const salt = randomBytes(16);
  const digest = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  return `${iterations}$${salt.toString('hex')}$${digest.toString('hex')}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  try {
    const [iterationsText, saltHex, digestHex] = encoded.split('$');
    if (!iterationsText || !saltHex || !digestHex) return false;
    const expected = Buffer.from(digestHex, 'hex');
    const actual = pbkdf2Sync(password, Buffer.from(saltHex, 'hex'), Number(iterationsText), expected.length, 'sha256');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
