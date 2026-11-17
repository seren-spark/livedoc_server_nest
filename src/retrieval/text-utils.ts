/**
 * @file 检索数值工具。提供哈希分词、余弦相似度和耗时等共用计算。
 */
import { Jieba } from "@node-rs/jieba";
import { dict } from "@node-rs/jieba/dict.js";

const HASH_TOKEN_PATTERN = /[A-Za-z0-9_#+.-]+|[\u4e00-\u9fff]/gu;
const KEYWORD_TOKEN_PATTERN = /^(?:[A-Za-z0-9_#+.-]+|[\u4e00-\u9fff]+)$/u;
const jieba = Jieba.withDict(dict) as unknown as {
  cutForSearch?: (value: string, hmm?: boolean) => string[];
  cut: (value: string, hmm: boolean) => string[];
};

/**
 * 将文本转为小写并拆分为英文词项或中文单字，供哈希编码路径使用。
 *
 * @param text 待处理的文本。
 * @returns 整理后的字符串列表。
 */
export function tokenizeHash(text: string): string[] {
  return text.toLowerCase().match(HASH_TOKEN_PATTERN) ?? [text.slice(0, 64)];
}
/**
 * 对文本进行关键词分词
 * @param text 输入的文本
 * @returns 关键词数组
 */
export function tokenizeKeyword(text: string): string[] {
  // ① 结巴分词
  const raw = jieba.cutForSearch?.(text, true) ?? jieba.cut(text, true);
  // ② 后处理
  return raw
    .map((item) => item.trim().toLowerCase()) // 去空格 + 转小写
    .filter((item) => KEYWORD_TOKEN_PATTERN.test(item)); // 过滤无效 token
}

/**
 * 计算两个向量的余弦相似度。
 *
 * @param left 比较或计算中的左侧输入。
 * @param right 比较或计算中的右侧输入。
 * @returns 计算得到的数值。
 */
export function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

/**
 * 按指定位数四舍五入，统一指标展示精度。
 *
 * @param value 待校验或转换的值。
 * @param digits 结果保留的小数位数。
 * @returns 计算得到的数值。
 */
export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * 计算从起始时刻到现在的耗时，单位为毫秒。
 *
 * @param started 当前操作的起始计时点。
 * @returns 计算得到的数值。
 */
export function elapsedMs(started: number): number {
  return round(performance.now() - started, 2);
}
