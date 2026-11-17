/**
 * @file 模型路由。按角色、能力和上下文窗口挑选模型，维护降级与故障冷却状态。
 */
import { createHash } from 'node:crypto';
import type { AppConfig } from '../config/app-config.js';
import { AgentExecutionError } from './agent-execution.js';

export type ModelRole = 'main' | 'classifier' | 'plan' | 'critic' | 'researcher' | 'web_summary' | 'research_compressor' | 'writer' | 'coverage';
const researchFallback = { researcher: 'main', web_summary: 'plan', research_compressor: 'plan', writer: 'main', coverage: 'critic' } as const;
/**
 * 判断该角色是否应使用主写作模型。
 *
 * @param role 本次模型或 Worker 执行角色（可选）。
 * @returns 条件是否满足的判断结果。
 */
export const mainModelRole = (role?: ModelRole) => !role || ['main', 'researcher', 'writer'].includes(role);
export interface AgentModelOptions {
  role?: ModelRole;
  thinking?: boolean;
  thinkingBody?: Record<string, unknown>;
  json?: boolean;
  maxTokens?: number;
  toolChoice?: string;
  /** Internal deployment profile, never populated from an HTTP request. */
  profile?: string;
  requiredContextTokens?: number;
}
export interface AgentModelAttempt {
  profile?: string;
  model: string;
  provider: string;
  contextWindow: number;
}
interface ModelProfile extends AgentModelAttempt {
  id: string;
  baseUrl: string;
  apiKey: string;
  extraBody: Record<string, unknown>;
  thinkingMode: 'toggle' | 'always_on' | 'off';
  thinkingOnBody: Record<string, unknown>;
  thinkingOffBody: Record<string, unknown>;
  tools: boolean;
  json: boolean;
  timeoutSeconds: number;
}
interface CircuitState { failures: number; openUntil: number; probing: boolean }
const legacyRoles: ModelRole[] = ['main', 'classifier', 'plan', 'critic'];
const roles: ModelRole[] = [...legacyRoles, 'researcher', 'web_summary', 'research_compressor', 'writer', 'coverage'];
const controlledFields = new Set(['model', 'messages', 'tools', 'tool_choice', 'stream', 'max_tokens', 'response_format', 'headers', 'api_key']);
/**
 * 判断未知输入是否为非空且非数组的对象。
 *
 * @param value 待校验或转换的值。
 * @returns 条件是否满足的判断结果。
 */
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** OpenAI-compatible deployment routing. Circuit state is bounded by configured profiles and process-local. */
export class ModelRouter {
  private readonly profiles = new Map<string, ModelProfile>();
  private readonly routes = new Map<ModelRole, string[]>();
  private readonly circuits = new Map<string, CircuitState>();
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param config 应用运行配置。
   */
  constructor(private readonly config: AppConfig) {
    for (const [alias, raw] of Object.entries(config.llmModelProfiles)) {
      if (!/^[A-Za-z0-9_.-]{1,80}$/.test(alias) || !object(raw) || typeof raw.model !== 'string' || !raw.model.trim())
        throw new Error('LLM_MODEL_PROFILES requires named profiles with a model');
      const baseUrl = String(raw.base_url ?? config.llmBaseUrl).replace(/\/$/, '');
      const url = new URL(baseUrl);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        throw new Error('Model profile base_url must be an HTTP endpoint without embedded credentials');
      if (raw.api_key_env !== undefined && (typeof raw.api_key_env !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.api_key_env)))
        throw new Error('Model profile api_key_env must name an environment variable');
      for (const key of ['extra_body', 'thinking_on_body', 'thinking_off_body']) {
        if (raw[key] !== undefined && !object(raw[key])) throw new Error(`Model profile ${key} must be an object`);
        if (object(raw[key]) && Object.keys(raw[key]).some((field) => controlledFields.has(field)))
          throw new Error(`Model profile ${key} contains a reserved request field`);
      }
      const mode = raw.thinking ?? 'off';
      if (!['toggle', 'always_on', 'off'].includes(String(mode))) throw new Error('Model profile thinking must be toggle, always_on or off');
      if (mode !== 'off' && (!object(raw.thinking_on_body) || !Object.keys(raw.thinking_on_body).length))
        throw new Error('Thinking profiles require thinking_on_body');
      if (mode === 'toggle' && (!object(raw.thinking_off_body) || !Object.keys(raw.thinking_off_body).length))
        throw new Error('Toggle profiles require thinking_off_body');
      for (const key of ['tools', 'json']) if (raw[key] !== undefined && typeof raw[key] !== 'boolean')
        throw new Error(`Model profile ${key} must be boolean`);
      const contextWindow = Number(raw.context_window ?? config.llmContextWindow);
      const timeoutSeconds = Number(raw.timeout_seconds ?? config.llmTimeoutSeconds);
      if (!Number.isSafeInteger(contextWindow) || contextWindow < 1024 || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)
        throw new Error('Model profile context_window or timeout_seconds is invalid');
      this.profiles.set(alias, {
        id: alias, profile: alias, model: raw.model, provider: String(raw.provider ?? url.hostname), baseUrl,
        apiKey: raw.api_key_env ? process.env[String(raw.api_key_env)] ?? '' : config.llmApiKey,
        extraBody: raw.extra_body as Record<string, unknown> ?? {}, thinkingMode: mode as ModelProfile['thinkingMode'],
        thinkingOnBody: raw.thinking_on_body as Record<string, unknown> ?? {},
        thinkingOffBody: raw.thinking_off_body as Record<string, unknown> ?? {},
        contextWindow, timeoutSeconds, tools: raw.tools !== false, json: raw.json !== false,
      });
    }
    for (const [role, raw] of Object.entries(config.agentModelRoutes)) {
      if (!roles.includes(role as ModelRole) || !Array.isArray(raw) || !raw.length || raw.length > 16 ||
        raw.some((alias) => typeof alias !== 'string' || !this.profiles.has(alias)) || new Set(raw).size !== raw.length)
        throw new Error('AGENT_MODEL_ROUTES requires known roles and unique configured profile names');
      this.routes.set(role as ModelRole, raw as string[]);
    }
    if (this.profiles.size > 64) throw new Error('LLM_MODEL_PROFILES supports at most 64 profiles');
    if (!Number.isSafeInteger(config.llmCircuitFailureThreshold) || config.llmCircuitFailureThreshold < 1 ||
      !Number.isSafeInteger(config.llmCircuitCooldownMs) || config.llmCircuitCooldownMs < 1000 || config.llmCircuitCooldownMs > 300000)
      throw new Error('LLM circuit threshold or cooldown is invalid');
  }

  /**
   * 将旧版单模型设置转换为当前路由配置。
   *
   * @param role 本次模型或 Worker 执行角色。
   * @returns ModelProfile 类型的处理结果。
   */
  private legacy(role: ModelRole): ModelProfile {
    const model = role === 'classifier' ? this.config.agentClassifierModel : role === 'plan'
      ? this.config.agentPlanModel : role === 'critic' ? this.config.agentCriticModel : this.config.llmModel;
    return { id: `legacy:${role}`, model, provider: this.config.llmProvider, baseUrl: this.config.llmBaseUrl,
      apiKey: this.config.llmApiKey, extraBody: this.config.llmToolCallExtraBody,
      thinkingMode: this.config.thinkingSupported ? 'toggle' : 'off', thinkingOnBody: this.config.thinkingOnBody,
      thinkingOffBody: this.config.thinkingOffBody, tools: true, json: true,
      contextWindow: this.config.llmContextWindow, timeoutSeconds: this.config.llmTimeoutSeconds };
  }

  /**
   * 列出指定角色可使用的候选模型配置。
   *
   * @param role 本次模型或 Worker 执行角色。
   * @returns 整理后的结果列表。
   */
  private candidates(role: ModelRole): ModelProfile[] {
    const fallback = role in researchFallback ? researchFallback[role as keyof typeof researchFallback] : role;
    const names = this.routes.get(role) ?? this.routes.get(fallback) ?? this.routes.get('main');
    return names ? names.map((name) => this.profiles.get(name)!) : [this.legacy(fallback)];
  }

  /**
   * 判断模型是否已配置且不处于故障冷却期。
   *
   * @param profile 模型配置或文档记忆档案。
   * @returns 条件是否满足的判断结果。
   */
  private available(profile: ModelProfile): boolean {
    const circuit = this.circuits.get(profile.id);
    return !circuit || (circuit.openUntil <= Date.now() && !circuit.probing);
  }

  /**
   * 检查当前配置与已保存任务的运行条件是否兼容。
   *
   * @param profile 模型配置或文档记忆档案。
   * @param options 控制本次行为的可选配置。
   * @param toolsCount 本次提供给模型的工具数量。
   * @returns 条件是否满足的判断结果。
   */
  private compatible(profile: ModelProfile, options: AgentModelOptions, toolsCount: number): boolean {
    if ((toolsCount > 0 && !profile.tools) || (options.json && !profile.json)) return false;
    if (!profile.profile) return true;
    if (profile.contextWindow < (options.requiredContextTokens ?? 0)) return false;
    const thinking = options.thinking && mainModelRole(options.role);
    return thinking ? profile.thinkingMode !== 'off' : profile.thinkingMode !== 'always_on';
  }

  /**
   * 检查指定模型配置是否完整。
   *
   * @param role 本次模型或 Worker 执行角色。
   * @returns 条件是否满足的判断结果。
   */
  configured(role: ModelRole = 'main'): boolean {
    return this.candidates(role).some((profile) => Boolean(profile.apiKey));
  }

  /**
   * 返回当前配置的主要写作模型标识。
   *
   * @returns 整理后的文本或标识。
   */
  mainModel(): string {
    const candidates = this.candidates('main');
    return (candidates.find((profile) => profile.apiKey) ?? candidates[0])!.model;
  }
  /**
   * 判断所选模型是否具备可配置的思考能力。
   *
   * @returns 条件是否满足的判断结果。
   */
  thinkingSupported(): boolean {
    return this.candidates('main').some((profile) => Boolean(profile.apiKey) && profile.thinkingMode !== 'off');
  }

  /**
   * 按角色、能力与上下文大小选择可用模型。
   *
   * @param options 控制本次行为的可选配置。
   * @param toolsCount 本次提供给模型的工具数量。
   * @param excluded 本次应排除的条目集合。
   * @returns ModelProfile 类型的处理结果。
   */
  select(options: AgentModelOptions = {}, toolsCount = 0, excluded: string[] = []): ModelProfile {
    const candidates = options.profile
      ? [this.profiles.get(options.profile)].filter((profile): profile is ModelProfile => Boolean(profile))
      : this.candidates(options.role ?? 'main');
    const compatible = candidates.filter((profile) => !excluded.includes(profile.id) && this.compatible(profile, options, toolsCount));
    const configured = compatible.filter((profile) => Boolean(profile.apiKey));
    const selected = configured.find((profile) => this.available(profile));
    if (selected) return selected;
    if (configured.length) throw new AgentExecutionError('UPSTREAM_CIRCUIT_OPEN', '当前兼容模型正在冷却，请稍后重试', true);
    if (compatible.length) throw new AgentExecutionError('MODEL_NOT_CONFIGURED', '当前模型的凭证尚未配置');
    throw new AgentExecutionError('MODEL_CAPABILITY_UNSUPPORTED', '当前路由没有满足工具、JSON 或思考开关要求的模型');
  }

  /**
   * 读取默认主写作模型的配置。
   *
   * @returns ModelProfile 类型的处理结果。
   */
  defaultMain(): ModelProfile {
    const selected = this.candidates('main').find((profile) => profile.apiKey && this.available(profile));
    if (selected) return selected;
    return this.select();
  }

  /**
   * 选择用于能力验证的模型配置。
   *
   * @returns 整理后的文本或标识；未找到或不可用时可能为空。
   */
  verificationProfile(): string | undefined {
    const profiles = this.candidates('main');
    if (!profiles[0]?.profile) return undefined;
    const selected = profiles.find((profile) => profile.apiKey && profile.tools && profile.thinkingMode === 'toggle' && this.available(profile));
    if (!selected) throw new Error('THINKING_TOOL_UNSUPPORTED');
    return selected.profile;
  }

  /**
   * 在调用开始前检查模型冷却状态，并标记需要探测恢复的模型。
   *
   * @param profile 模型配置或文档记忆档案。
   */
  begin(profile: ModelProfile): void {
    if (!this.available(profile)) throw new AgentExecutionError('UPSTREAM_CIRCUIT_OPEN', '当前模型正在冷却，请稍后重试', true);
    const state = this.circuits.get(profile.id);
    if (state?.openUntil) state.probing = true;
  }

  /**
   * 记录本次模型调用成功，更新路由健康状态。
   *
   * @param profile 模型配置或文档记忆档案。
   */
  succeeded(profile: ModelProfile): void { this.circuits.delete(profile.id); }

  /**
   * 记录模型失败及冷却状态，供后续路由选择使用。
   *
   * @param profile 模型配置或文档记忆档案。
   * @param error 本次操作捕获的异常。
   */
  failed(profile: ModelProfile, error: unknown): void {
    const state = this.circuits.get(profile.id) ?? { failures: 0, openUntil: 0, probing: false };
    state.probing = false;
    if (!canFallbackModel(error)) {
      if (state.openUntil) this.circuits.set(profile.id, state);
      return;
    }
    state.failures++;
    if (state.openUntil || ['UPSTREAM_QUOTA', 'UPSTREAM_AUTH'].includes((error as AgentExecutionError).code) ||
      state.failures >= this.config.llmCircuitFailureThreshold)
      state.openUntil = Date.now() + this.config.llmCircuitCooldownMs;
    this.circuits.set(profile.id, state);
  }

  /**
   * 根据当前输入生成稳定指纹，用于识别配置或内容变化。
   *
   * @returns 整理后的文本或标识。
   */
  fingerprint(): string {
    return createHash('sha256').update(JSON.stringify({ routes: this.config.agentModelRoutes,
      profiles: [...this.profiles.values()], legacy: legacyRoles.map((role) => this.legacy(role)) })).digest('hex');
  }
}

/**
 * 判断失败类型是否适合切换备用模型。
 *
 * @param error 本次操作捕获的异常。
 * @returns 条件是否满足的判断结果。
 */
export function canFallbackModel(error: unknown): boolean {
  return error instanceof AgentExecutionError && ['UPSTREAM_QUOTA', 'UPSTREAM_AUTH', 'UPSTREAM_RATE_LIMIT',
    'UPSTREAM_HTTP_ERROR', 'UPSTREAM_TIMEOUT', 'UPSTREAM_NETWORK', 'UPSTREAM_CIRCUIT_OPEN'].includes(error.code);
}

/**
 * 将模型 HTTP 状态转换为统一失败类别。
 *
 * @param response 上游服务或 HTTP 接口返回的响应。
 * @param prefix 需要匹配或补入的前缀。
 * @returns AgentExecutionError 类型的处理结果。
 */
export async function modelHttpFailure(response: Response, prefix = '模型服务请求失败'): Promise<AgentExecutionError> {
  let providerCode = '';
  try {
    if (typeof response.json === 'function') {
      const data = await response.json() as any;
      const value = data?.error?.code ?? data?.code ?? '';
      if (typeof value === 'string') providerCode = value;
    }
  } catch { /* Unstructured provider error bodies are intentionally discarded. */ }
  await response.body?.cancel().catch(() => undefined);
  const status = response.status;
  let code = status === 429 ? 'UPSTREAM_RATE_LIMIT' : 'UPSTREAM_HTTP_ERROR';
  let retryable = [429, 502, 503, 504].includes(status);
  if (/arrearage|quota|insufficient|payment|freetier/i.test(providerCode)) { code = 'UPSTREAM_QUOTA'; retryable = false; }
  else if ([401, 403].includes(status)) { code = 'UPSTREAM_AUTH'; retryable = false; }
  else if ([400, 422].includes(status)) { code = 'UPSTREAM_PARAMETER'; retryable = false; }
  return new AgentExecutionError(code, `${prefix}（${status}）`, retryable);
}
