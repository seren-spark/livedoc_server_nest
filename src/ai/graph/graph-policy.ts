/**
 * @file 图任务配置策略。记录运行所用配置与指纹，判断恢复时策略是否兼容。
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const V2_POLICY = Object.freeze({
  version: 'agent-v2-policy-1',
  verification: true,
  correction_limit: 1,
  skills: true,
  preferences: true,
  context: true,
});

export const RESEARCH_POLICY = Object.freeze({ ...V2_POLICY, version: 'agent-v2-research-1',
  research_writing: true, search_limit: 3, research_turn_limit: 8, prompt_version: 'research-writing-1' });

/**
 * 判断保存的任务策略是否属于当前代码支持的协议。
 *
 * @param policy 任务执行采用的策略快照。
 * @returns 条件是否满足的判断结果。
 */
export function supportedPolicy(policy: any): boolean {
  return isDeepStrictEqual(policy, V2_POLICY) || isDeepStrictEqual(policy, RESEARCH_POLICY);
}

/**
 * 结合配置、图版本与策略生成恢复兼容性指纹。
 *
 * @param base 子任务继承的基础上下文。
 * @param version 本次操作对应的内容版本。
 * @param policy 任务执行采用的策略快照。
 * @returns 整理后的文本或标识。
 */
export function graphFingerprint(base: string, version: string, policy: unknown): string {
  if (version === 'v1') return base;
  const canonical = isDeepStrictEqual(policy, V2_POLICY) ? V2_POLICY : isDeepStrictEqual(policy, RESEARCH_POLICY) ? RESEARCH_POLICY : policy;
  return createHash('sha256').update(JSON.stringify({ base, version, policy: canonical })).digest('hex').slice(0, 16);
}
