import { describe, expect, test } from '@jest/globals';
import { graphFingerprint, V2_POLICY } from '../src/ai/graph/graph-policy.js';

describe('persisted graph policy compatibility', () => {
  test('v1 retains its existing base fingerprint', () => {
    expect(graphFingerprint('original', 'v1', undefined)).toBe('original');
  });

  test('v2 binds the saved policy and underlying configuration independently', () => {
    const fingerprint = graphFingerprint('original', 'v2', V2_POLICY);
    expect(graphFingerprint('original', 'v2', { ...V2_POLICY })).toBe(fingerprint);
    expect(graphFingerprint('changed', 'v2', V2_POLICY)).not.toBe(fingerprint);
    expect(graphFingerprint('original', 'v2', { ...V2_POLICY, correction_limit: 2 })).not.toBe(fingerprint);
  });
});
