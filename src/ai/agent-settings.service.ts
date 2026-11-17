/**
 * @file 个人 Agent 设置。校验并加密保存个人模型与联网配置，生成单次任务使用的运行设置。
 */
import { BadRequestException, ConflictException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import type { AccessContext } from '../common/types.js';
import { AppConfig } from '../config/app-config.js';
import { DatabaseService } from '../database/database.service.js';
import { LlmService } from './llm.service.js';
import type { FunctionTool } from './document-agent.types.js';
import { validatePublicUrl } from './public-web-fetch.js';

export const THINKING_PRESETS = {
  qwen: { on: { enable_thinking: true }, off: { enable_thinking: false } },
  reasoning_effort: { on: { reasoning_effort: 'medium' }, off: { reasoning_effort: 'none' } },
};
export class AgentSettingsDto {
  @IsIn(['web', 'thinking']) feature!: 'web' | 'thinking';
  @IsBoolean() enabled!: boolean;
  @IsInt() @Min(0) expected_revision!: number;
  @IsOptional() @IsString() @MaxLength(512) api_key?: string;
  @IsOptional() @IsIn(['qwen', 'reasoning_effort']) preset?: keyof typeof THINKING_PRESETS;
}
type Setting = { enabled: boolean; checked_at?: string; secret?: string; preset?: keyof typeof THINKING_PRESETS; fingerprint?: string };
type Stored = { revision: number; payload: { web?: Setting; thinking?: Setting } };
/**
 * 生成当前用户在空间内的配置归属标识。
 *
 * @param c 当前用户、空间与团队身份，用于权限校验。
 * @returns 整理后的文本或标识。
 */
const owner = (c: AccessContext) => JSON.stringify([c.space_id, c.user_id]);
export const PERSONAL_WEB_TOOLS: FunctionTool[] = [{ type: 'function', function: {
  name: 'personal_tavily_search', description: '联网搜索最新信息，返回网页来源和正文摘要。',
  parameters: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 1000 } }, required: ['query'], additionalProperties: false },
} }, { type: 'function', function: {
  name: 'personal_tavily_extract', description: '读取指定公网网页正文。',
  parameters: { type: 'object', properties: { url: { type: 'string', maxLength: 2048 } }, required: ['url'], additionalProperties: false },
} }];

@Injectable()
export class AgentSettingsService {
  private readonly memory = new Map<string, Stored>();
  private readonly validating = new Set<string>();
  private readonly lastValidation = new Map<string, number>();
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param db 共享数据库服务。
   * @param config 应用运行配置。
   * @param llm 共享模型调用服务。
   */
  constructor(private readonly db: DatabaseService, private readonly config: AppConfig, private readonly llm: LlmService) {}
  /**
   * 根据当前输入生成稳定指纹，用于识别配置或内容变化。
   *
   * @returns 整理后的文本或标识。
   */
  private fingerprint() {
    return this.llm.configurationFingerprint();
  }
  /**
   * 从运行配置取得用于个人敏感设置加解密的密钥。
   *
   * @returns 文件字节内容。
   */
  private encryptionKey() {
    const key = Buffer.from(this.config.agentSettingsEncryptionKey, 'base64');
    if (key.length !== 32) throw new ServiceUnavailableException('服务端尚未配置个人密钥加密，请联系管理员');
    return key;
  }
  /**
   * 加密敏感配置，并保存解密所需的元数据。
   *
   * @param text 待处理的文本。
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的文本或标识。
   */
  private encrypt(text: string, c: AccessContext) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
    cipher.setAAD(Buffer.from(owner(c)));
    const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  }
  /**
   * 解密已保存的敏感配置，供后端运行时使用。
   *
   * @param text 待处理的文本。
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的文本或标识。
   */
  private decrypt(text: string, c: AccessContext) {
    try {
      const raw = Buffer.from(text, 'base64'), cipher = createDecipheriv('aes-256-gcm', this.encryptionKey(), raw.subarray(0, 12));
      cipher.setAAD(Buffer.from(owner(c))); cipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([cipher.update(raw.subarray(28)), cipher.final()]).toString('utf8');
    } catch { throw new ServiceUnavailableException('已保存的搜索密钥无法读取，请重新填写并验证'); }
  }
  /**
   * 读取当前作用范围内的个人 Agent 配置。
   *
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @returns Stored 类型的处理结果。
   */
  private async read(c: AccessContext): Promise<Stored> {
    if (!this.db.metadataEnabled) return structuredClone(this.memory.get(owner(c)) ?? { revision: 0, payload: {} });
    const [row] = await this.db.query<Stored>('SELECT revision,payload FROM agent_user_settings WHERE space_id=? AND user_id=?', [c.space_id, c.user_id]);
    return row ? { revision: Number(row.revision), payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload } : { revision: 0, payload: {} };
  }
  /**
   * 比较期望修订号后保存个人配置，并递增修订版本。
   *
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @param next 准备写入的下一状态。
   */
  private async save(c: AccessContext, next: Stored) {
    if (!this.db.metadataEnabled) {
      if ((this.memory.get(owner(c))?.revision ?? 0) !== next.revision) throw new ConflictException('配置已变更，请重新加载');
      this.memory.set(owner(c), { ...next, revision: next.revision + 1 }); return;
    }
    await this.db.transaction(async manager => {
      await manager.query('INSERT IGNORE INTO agent_user_settings(space_id,user_id,revision,payload) VALUES(?,?,0,?)', [c.space_id, c.user_id, '{}']);
      const [row] = await manager.query('SELECT revision FROM agent_user_settings WHERE space_id=? AND user_id=? FOR UPDATE', [c.space_id, c.user_id]);
      if (Number(row.revision) !== next.revision) throw new ConflictException('配置已变更，请重新加载');
      await manager.query('UPDATE agent_user_settings SET revision=revision+1,payload=? WHERE space_id=? AND user_id=?', [JSON.stringify(next.payload), c.space_id, c.user_id]);
    });
  }
  /**
   * 返回个人设置的可展示状态和验证结果，不返回明文密钥。
   *
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的状态与操作结果对象；未找到或不可用时可能为空。
   */
  async get(c: AccessContext) {
    const s = await this.read(c), t = s.payload.thinking, w = s.payload.web;
    const thinkingValid = Boolean(t?.checked_at && t.fingerprint === this.fingerprint());
    return { revision: s.revision, model: this.llm.mainModel,
      web: { configured: Boolean(w), enabled: w ? w.enabled : this.config.mcpEnabled || this.llm.webSearchConfigured, verified: Boolean(w?.checked_at && w.secret), has_key: Boolean(w?.secret), checked_at: w?.checked_at },
      thinking: { configured: Boolean(t), enabled: t ? t.enabled : this.llm.thinkingSupported, verified: thinkingValid,
        preset: t?.preset ?? 'qwen', checked_at: t?.checked_at, needs_revalidation: Boolean(t?.checked_at && !thinkingValid) } };
  }
  /**
   * 合并部署设置和个人设置，生成本次 Agent 可用的能力配置。
   *
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的状态与操作结果对象；未找到或不可用时可能为空。
   */
  async runtime(c: AccessContext) {
    const s = await this.read(c), w = s.payload.web, t = s.payload.thinking;
    const thinking = t?.enabled && t.checked_at && t.fingerprint === this.fingerprint() && t.preset ? THINKING_PRESETS[t.preset] : undefined;
    return { thinking_supported: t ? Boolean(thinking) : this.llm.thinkingSupported,
      thinking, web_key: w?.enabled && w.checked_at && w.secret ? this.decrypt(w.secret, c) : undefined,
      deployment_web: w ? w.enabled : true };
  }
  /**
   * 验证个人设置及模型能力后，按期望版本保存配置。
   *
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @param input 本次操作的输入数据。
   * @param external 取消信号，用于中止请求和后台处理（可选）。
   * @returns 整理后的状态与操作结果对象；未找到或不可用时可能为空。
   */
  async validateAndSave(c: AccessContext, input: AgentSettingsDto, external?: AbortSignal) {
    const id = owner(c);
    if (this.validating.has(id)) throw new HttpException('配置验证正在进行，请稍候', 429);
    const s = await this.read(c);
    if (s.revision !== input.expected_revision) throw new ConflictException('配置已变更，请重新加载');
    if (input.enabled && Date.now() - (this.lastValidation.get(id) ?? 0) < 5000) throw new HttpException('请稍后再试', 429);
    this.validating.add(id);
    try {
      if (!input.enabled) { s.payload[input.feature] = { enabled: false }; }
      else {
        this.lastValidation.set(id, Date.now());
        const signal = AbortSignal.any([AbortSignal.timeout(60000), ...(external ? [external] : [])]);
        const checked_at = new Date().toISOString();
        if (input.feature === 'web') {
          const key = input.api_key?.trim() || (s.payload.web?.secret ? this.decrypt(s.payload.web.secret, c) : '');
          if (!key || /\s/.test(key)) throw new BadRequestException('请填写有效的 Tavily API Key');
          const secret = this.encrypt(key, c);
          await this.tavily('search', key, { query: 'Tavily documentation', max_results: 1, search_depth: 'basic', include_answer: false }, signal);
          s.payload.web = { enabled: true, checked_at, secret };
        } else {
          const preset = input.preset ?? 'qwen';
          await this.llm.verifyThinking(THINKING_PRESETS[preset].on, THINKING_PRESETS[preset].off, signal);
          s.payload.thinking = { enabled: true, checked_at, preset, fingerprint: this.fingerprint() };
        }
        signal.throwIfAborted();
      }
      await this.save(c, s);
      return { ...(await this.get(c)), message: input.enabled ? '验证通过，配置已保存' : '个人配置已清除，此能力已停用' };
    } catch (e) {
      if (e instanceof HttpException) throw e;
      const message = e instanceof Error ? e.message : '';
      if (message.includes('THINKING_UNCONFIRMED')) throw new BadRequestException('模型未返回可验证的思考信号，暂不能确认支持该配置；请尝试其他适配方式');
      if (message.includes('THINKING_OFF_UNCONFIRMED')) throw new BadRequestException('模型未按配置关闭思考，当前适配方式无法可靠控制开关');
      if (message.includes('THINKING_TOOL_UNSUPPORTED')) throw new BadRequestException('该配置未通过 Agent 工具调用验证，请尝试其他适配方式');
      const status = message.match(/(?:LLM request failed: |模型服务请求失败（)(\d+)/)?.[1];
      throw new BadRequestException(status ? `模型服务拒绝该配置（${status}），请检查当前模型是否支持此适配方式` : '验证未完成：连接超时或服务不可用，请稍后重试；原有配置未更改');
    } finally { this.validating.delete(id); }
  }
  /**
   * 调用配置的 Tavily 搜索服务并规范化搜索结果。
   *
   * @param endpoint 需要请求的接口地址。
   * @param key 查询或存储使用的键。
   * @param body 请求正文或待提交的数据。
   * @param signal 取消信号，用于中止请求和后台处理。
   * @returns any 类型的处理结果。
   */
  private async tavily(endpoint: 'search' | 'extract', key: string, body: object, signal: AbortSignal) {
    const response = await fetch(`https://api.tavily.com/${endpoint}`, { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new BadRequestException(response.status === 401 || response.status === 403 ? 'Tavily 密钥无效或没有访问权限' : [429, 432, 433].includes(response.status) ? 'Tavily 额度不足或请求受限，请检查账户后重试' : `Tavily 服务暂不可用（${response.status}）`);
    }
    const data = await response.json() as any;
    if (!Array.isArray(data.results) || (endpoint === 'search' && data.results.length === 0)) throw new BadRequestException('搜索服务未返回有效结果，验证未通过');
    return data;
  }
  /**
   * 按当前联网配置执行指定网页搜索或读取工具。
   *
   * @param name 目标名称。
   * @param args 当前工具调用的参数。
   * @param key 查询或存储使用的键。
   * @param signal 取消信号，用于中止请求和后台处理。
   * @param fullContent 尚未裁剪的完整正文。
   * @returns any 类型的处理结果。
   */
  async webCall(name: string, args: Record<string, any>, key: string, signal: AbortSignal, fullContent = false) {
    if (name === 'personal_tavily_extract') await validatePublicUrl(args.url);
    const data = await this.tavily(name === 'personal_tavily_search' ? 'search' : 'extract', key,
      name === 'personal_tavily_search' ? { query: args.query, max_results: 5, search_depth: 'basic', include_answer: false, ...(fullContent ? { include_raw_content: true } : {}) } : { urls: [args.url], extract_depth: 'basic' }, signal);
    return data.results.slice(0, 5).map((r: any) => ({ title: String(r.title ?? r.url).slice(0, 300), url: String(r.url),
      content: String(r.content ?? r.raw_content ?? '').slice(0, 5000),
      ...(fullContent && String(r.raw_content ?? (name === 'personal_tavily_extract' ? r.content : '') ?? '').trim()
        ? { raw_content: String(r.raw_content ?? r.content) } : {}),
    }));
  }
}
