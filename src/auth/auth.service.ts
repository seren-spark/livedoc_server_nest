/**
 * @file 身份与会话。校验登录凭证，签发和撤销会话，并解析用户所在空间与团队。
 */
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

  /**
   * 初始化实例依赖与本地状态。
   *
   * @param config 应用运行配置。
   * @param database 共享数据库服务。
   */
  constructor(
    private readonly config: AppConfig,
    private readonly database: DatabaseService,
  ) {
    this.repository = new AuthRepository(database);
  }

  /**
   * 在 NestJS 模块启动时初始化所需资源。
   */
  async onModuleInit(): Promise<void> {
    if (this.database.metadataEnabled) await this.seedMysql();
    else this.seedMemory();
  }

  /**
   * 校验登录输入并创建用户会话。
   *
   * @param email 登录邮箱。
   * @param password 用户输入的登录密码。
   * @returns 整理后的状态与操作结果对象；未找到或不可用时可能为空。
   */
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

  /**
   * 根据当前凭证解析有效会话与用户访问身份。
   *
   * @param token 登录令牌或当前匹配的词项。
   * @returns DemoIdentity 类型的处理结果；未找到或不可用时可能为空。
   */
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

  /**
   * 撤销指定会话令牌，使后续请求无法继续使用。
   *
   * @param token 登录令牌或当前匹配的词项。
   */
  async revoke(token: string): Promise<void> {
    const tokenHash = hashToken(token);
    if (this.database.metadataEnabled) {
      await this.repository.deleteSession(tokenHash);
    } else this.sessions.delete(tokenHash);
  }

  /**
   * 读取适合公开展示的用户名称。
   *
   * @param userId 当前用户标识。
   * @returns 整理后的文本或标识。
   */
  async publicName(userId: string): Promise<string> {
    return (await this.identityByUserId(userId))?.username ?? 'LiveDoc 用户';
  }

  /**
   * 为内存运行路径初始化演示用户与团队信息。
   */
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

  /**
   * 向 MySQL 初始化本地演示所需的身份数据。
   */
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

  /**
   * 按邮箱从当前存储路径读取身份。
   *
   * @param email 登录邮箱。
   * @returns DemoIdentity 类型的处理结果；未找到或不可用时可能为空。
   */
  private async identityByEmail(email: string): Promise<DemoIdentity | null> {
    if (!this.database.metadataEnabled) return this.users.get(email)?.identity ?? null;
    const row = await this.repository.findIdentityByEmail(email);
    return row ? this.identityWithTeams(row) : null;
  }

  /**
   * 按用户标识从当前存储路径读取身份。
   *
   * @param userId 当前用户标识。
   * @returns DemoIdentity 类型的处理结果；未找到或不可用时可能为空。
   */
  async identityByUserId(userId: string): Promise<DemoIdentity | null> {
    if (!this.database.metadataEnabled) {
      return [...this.users.values()].find((item) => item.identity.user_id === userId)?.identity ?? null;
    }
    const row = await this.repository.findIdentityByUserId(userId);
    return row ? this.identityWithTeams(row) : null;
  }

  /**
   * 将用户身份与所属团队组合为访问上下文。
   *
   * @param row 数据库查询返回的一行数据。
   * @returns DemoIdentity 类型的处理结果。
   */
  private async identityWithTeams(row: IdentityRow): Promise<DemoIdentity> {
    return { ...row, team_ids: await this.repository.listTeamIds(row.user_id) };
  }

  /**
   * 读取指定身份对应的密码摘要。
   *
   * @param email 登录邮箱。
   * @returns 整理后的文本或标识；未找到或不可用时可能为空。
   */
  private async passwordHash(email: string): Promise<string | null> {
    if (!this.database.metadataEnabled) return this.users.get(email)?.passwordHash ?? null;
    return this.repository.findPasswordHash(email);
  }
}

/**
 * 从 Authorization 请求头提取 Bearer 令牌。
 *
 * @param authorization 请求携带的身份认证头（可选）。
 * @returns 整理后的文本或标识；未找到或不可用时可能为空。
 */
export function extractBearerToken(authorization?: string): string | null {
  if (!authorization?.toLowerCase().startsWith('bearer ')) return null;
  return authorization.slice(7).trim() || null;
}

/**
 * 为密码生成包含盐值的安全摘要。
 *
 * @param password 用户输入的登录密码。
 * @returns 整理后的文本或标识。
 */
export function hashPassword(password: string): string {
  const iterations = 240_000;
  const salt = randomBytes(16);
  const digest = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  return `${iterations}$${salt.toString('hex')}$${digest.toString('hex')}`;
}

/**
 * 使用保存的盐值校验输入密码。
 *
 * @param password 用户输入的登录密码。
 * @param encoded 编码后的字符串或字节内容。
 * @returns 条件是否满足的判断结果。
 */
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

/**
 * 对会话令牌生成存储摘要，避免明文持久化。
 *
 * @param token 登录令牌或当前匹配的词项。
 * @returns 整理后的文本或标识。
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
