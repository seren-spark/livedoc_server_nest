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
import { AuthRepository, type IdentityRow } from './auth.repository.js';

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
  private readonly repository: AuthRepository;

  constructor(
    private readonly config: AppConfig,
    private readonly database: DatabaseService,
  ) {
    this.repository = new AuthRepository(database);
  }

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
      await this.repository.createSession(hashToken(token), identity.user_id, expiresAt);
    } else {
      this.sessions.set(hashToken(token), { userId: identity.user_id, expiresAt });
    }
    return { token, user: identity };
  }

  async resolve(token: string): Promise<DemoIdentity | null> {
    const tokenHash = hashToken(token);
    if (this.database.metadataEnabled) {
      const row = await this.repository.findSession(tokenHash);
      if (!row || new Date(row.expires_at).getTime() <= Date.now()) {
        if (row) await this.repository.deleteSession(tokenHash);
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
      await this.repository.deleteSession(tokenHash);
    } else this.sessions.delete(tokenHash);
  }

  async publicName(userId: string): Promise<string> {
    return (await this.identityByUserId(userId))?.username ?? 'LiveDoc 用户';
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
      await this.repository.upsertUser({
        user_id: userId,
        username,
        email,
        password_hash: hashPassword(DEMO_PASSWORD),
        space_id: spaceId,
      });
      for (const teamId of teamIds) {
        await this.repository.addUserToTeam(userId, teamId);
      }
    }
  }

  private async identityByEmail(email: string): Promise<DemoIdentity | null> {
    if (!this.database.metadataEnabled) return this.users.get(email)?.identity ?? null;
    const row = await this.repository.findIdentityByEmail(email);
    return row ? this.identityWithTeams(row) : null;
  }

  private async identityByUserId(userId: string): Promise<DemoIdentity | null> {
    if (!this.database.metadataEnabled) {
      return [...this.users.values()].find((item) => item.identity.user_id === userId)?.identity ?? null;
    }
    const row = await this.repository.findIdentityByUserId(userId);
    return row ? this.identityWithTeams(row) : null;
  }

  private async identityWithTeams(row: IdentityRow): Promise<DemoIdentity> {
    return { ...row, team_ids: await this.repository.listTeamIds(row.user_id) };
  }

  private async passwordHash(email: string): Promise<string | null> {
    if (!this.database.metadataEnabled) return this.users.get(email)?.passwordHash ?? null;
    return this.repository.findPasswordHash(email);
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
