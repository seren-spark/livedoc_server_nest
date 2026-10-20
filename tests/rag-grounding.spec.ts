import { describe, expect, test } from '@jest/globals';
import { originalQuote, validateGrounding, validateQuality } from '../scripts/judge-rag-evaluation.js';

describe('optional answer grounding', () => {
  test('visible Markdown quotes map to exact original source spans without accepting invented words', () => {
    const answer = '如果 **Recall@5 下降超过3个百分点**，阻止发布。';
    const quote = originalQuote(answer, '如果 Recall@5 下降超过3个百分点，阻止发布');
    expect(quote).toBe('如果 **Recall@5 下降超过3个百分点**，阻止发布');
    expect(answer.includes(quote!)).toBe(true);
    expect(originalQuote(answer, '如果 Recall@5 下降超过5个百分点')).toBeUndefined();
    expect(originalQuote('计算 x ** y', '计算 x  y')).toBeUndefined();
  });
  test('semantic fact coverage is separate from faithfulness and missing facts cannot disappear', () => {
    const reference = { expected_behavior: 'answer', required_facts: [{ id: 'a', text: '租约900秒' }, { id: 'b', text: '重试3次' }] };
    const answer = '租约900秒。重试三次。';
    const value = { grounded: false, unsupported: ['重试三次'], note: '本次上下文缺少重试依据', behavior: 'answer', reference_consistent: true,
      facts: [{ id: 'a', status: 'covered', answer_quote: '租约900秒' }, { id: 'b', status: 'covered', answer_quote: '重试三次' }] };
    expect(validateQuality(value, answer, reference)).toMatchObject({ fact_coverage: 1, correctness: 'correct', grounded: false });
    expect(() => validateQuality({ ...value, facts: value.facts.slice(0, 1) }, answer, reference)).toThrow();
    expect(() => validateQuality({ ...value, facts: [value.facts[0], { ...value.facts[1], answer_quote: '不存在' }] }, answer, reference)).toThrow();
    expect(validateQuality({ ...value, facts: [value.facts[0], { id: 'b', status: 'missing', answer_quote: '' }] }, answer, reference).fact_coverage).toBe(.5);
    expect(validateQuality({ ...value, facts: [value.facts[0], { ...value.facts[1], status: 'contradicted' }] }, answer, reference).correctness).toBe('incorrect');
  });
  test('requires a consistent verdict and actual quoted answer text', () => {
    expect(validateGrounding({ grounded: true, unsupported: [], note: '有依据' }, '规划后执行').grounded).toBe(true);
    expect(validateGrounding({ grounded: false, unsupported: ['自动保存正文'], note: '材料没有说自动保存' }, '系统会自动保存正文').grounded).toBe(false);
    expect(() => validateGrounding({ grounded: true, unsupported: ['自动保存正文'], note: '' }, '自动保存正文')).toThrow();
    expect(() => validateGrounding({ grounded: false, unsupported: ['不存在的断言'], note: '' }, '实际答案')).toThrow();
    expect(() => validateGrounding({ grounded: 'true', unsupported: [], note: '' }, '实际答案')).toThrow();
  });
});
