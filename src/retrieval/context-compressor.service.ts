import { Injectable } from "@nestjs/common";
import { getEncoding, type Tiktoken } from "js-tiktoken";
import type { Citation } from "../common/types.js";
import { AppConfig } from "../config/app-config.js";
import { tokenizeKeyword } from "./text-utils.js";

@Injectable()
export class ContextCompressorService {
  private readonly tokenizer: Tiktoken;

  constructor(private readonly config: AppConfig) {
    this.tokenizer = getEncoding(
      this.config.tokenizerEncoding as Parameters<typeof getEncoding>[0],
    );
  }

  /**
   * 压缩上下文，保留相关句子
   * @param citations 原始 Citation 数组
   * @param query 查询字符串
   * @returns 压缩后的 Citation 数组
   */
  compress(citations: Citation[], query: string): Citation[] {
    //存放压缩后的 Citation
    const result: Citation[] = [];
    let remaining = this.config.contextTokenBudget; // 总 token 预算（如 2048）
    for (const citation of citations) {
      if (remaining <= 0) break; // 预算用完，停止
      // 从当前 citation 中提取相关句子
      const content = this.extractRelevant(
        citation.content,
        query,
        Math.min(this.config.contextPerCitationTokens, remaining), // 单个 citation 的 token 上限
      );
      if (!content) continue; // 没提取到内容，跳过
      result.push({ ...citation, content }); // 用压缩后的 content 替换原 content
      remaining -= this.count(content); // 扣除已用 token
    }
    return result;
  }

  /**
   * 压缩上下文，保留相关句子
   * @param content 原始内容
   * @param query 查询字符串
   * @param tokenBudget 预算 token 数
   * @returns 压缩后的内容
   */
  extractRelevant(content: string, query: string, tokenBudget: number): string {
    // ① 把 content 按句号/问号/感叹号分成句子数组
    const sentences = splitSentences(content);
    if (!sentences.length || tokenBudget <= 0) return "";
    // ② 提取 query 关键词
    const queryTerms = new Set(tokenizeKeyword(query));
    // ③ 对每个句子打分
    const candidates = sentences.map((text, index) => ({
      text,
      index,
      score: sentenceScore(text, queryTerms, index),
    }));
    // ④ 按分数降序排序（分数相同按原文顺序）
    candidates.sort((a, b) => b.score - a.score || a.index - b.index);
    // ⑤ 贪心选择（在 token 预算内）
    const selected: typeof candidates = [];
    let used = 0;
    for (const candidate of candidates) {
      const count = this.count(candidate.text); // 当前句子的 token 数
      const separator = selected.length ? 1 : 0; // 分隔符 " … " 占 1 token
      // 特殊情况：第一个句子就超预算，截断
      if (!selected.length && count > tokenBudget) {
        return this.truncate(candidate.text, tokenBudget);
      }
      // 能放下就加入
      if (used + count + separator <= tokenBudget) {
        selected.push(candidate);
        used += count + separator;
      }
      if (used >= tokenBudget) break;
    }
    // ⑥ 按原文顺序拼接（保持可读性）
    return selected
      .sort((a, b) => a.index - b.index)
      .map((item) => item.text)
      .join(" … ");
  }

  count(text: string): number {
    return this.tokenizer.encode(text).length;
  }

  truncate(text: string, budget: number): string {
    if (budget <= 0) return "";
    const tokens = this.tokenizer.encode(text);
    return tokens.length <= budget
      ? text
      : this.tokenizer.decode(tokens.slice(0, budget)).trimEnd();
  }
}

export function splitSentences(content: string): string[] {
  const normalized = content.trim().replace(/[ \t]+/g, " ");
  return (
    normalized
      .match(/[^。！？!?；;\n]+[。！？!?；;]?/gu)
      ?.map((item) => item.trim())
      .filter(Boolean) ?? []
  );
}
/**
 * 计算句子的得分
 * 
 * 得分 = query覆盖率 × 0.8 + 句子覆盖率 × 0.2 + 位置权重 × 0.05
 * @param sentence 输入的句子
 * @param queryTerms 查询关键词的 Set
 * @param index 句子在原文本中的索引
 * @returns 句子的得分
 */
function sentenceScore(
  sentence: string,
  queryTerms: Set<string>,
  index: number,
): number {
  // ① 对句子进行关键词分词
  const terms = tokenizeKeyword(sentence); 
  if (!terms.length) return 0;
  const unique = new Set(terms); // 去重
  // 句子和 query 的共同关键词数量
  const overlapCount = [...queryTerms].filter((term) =>
    unique.has(term),
  ).length;
  // query 覆盖率：共同词数 / query 总词数
  const overlap = overlapCount / Math.max(queryTerms.size, 1);
  // 句子覆盖率：共同词数 / 句子总词数
  const coverage = overlapCount / unique.size;
  // 综合得分：
  // - 80% 权重：query 覆盖率（句子命中了多少 query 关键词）
  // - 20% 权重：句子覆盖率（句子的关键词有多少被 query 命中）
  // - 5% 权重：位置权重（越靠前越重要）
  return overlap * 0.8 + coverage * 0.2 + (1 / (index + 1)) * 0.05;
}
