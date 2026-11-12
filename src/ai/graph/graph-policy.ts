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

export function supportedPolicy(policy: any): boolean {
  return isDeepStrictEqual(policy, V2_POLICY) || isDeepStrictEqual(policy, RESEARCH_POLICY);
}

export function graphFingerprint(base: string, version: string, policy: unknown): string {
  if (version === 'v1') return base;
  const canonical = isDeepStrictEqual(policy, V2_POLICY) ? V2_POLICY : isDeepStrictEqual(policy, RESEARCH_POLICY) ? RESEARCH_POLICY : policy;
  return createHash('sha256').update(JSON.stringify({ base, version, policy: canonical })).digest('hex').slice(0, 16);
}
