/**
 * @file Markdown 结构解析。统一 AST 遍历、受保护范围与句子边界，供分块和压缩复用。
 */
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mathFromMarkdown } from "mdast-util-math";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";

/** Keep AST positions: generated context must never become a source offset. */
export interface MarkdownNode {
  type: string;
  children?: MarkdownNode[];
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
  depth?: number;
  lang?: string | null;
  meta?: string | null;
  value?: string;
  identifier?: string;
}

/**
 * 将 Markdown 转为统一 AST，支持后续结构分析。
 *
 * @param markdown 待解析或写入的 Markdown 原文。
 * @returns MarkdownNode 类型的处理结果。
 */
export function parseMarkdown(markdown: string): MarkdownNode {
  return fromMarkdown(markdown, {
    extensions: [gfm(), math()],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  });
}

/**
 * 递归遍历 Markdown AST，并把节点交给调用方处理。
 *
 * @param node 当前语法树或编辑器节点。
 * @param visit 访问当前语法树节点的回调。
 */
export function walkMarkdown(node: MarkdownNode, visit: (node: MarkdownNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walkMarkdown(child, visit);
}

const INLINE_ATOMS = new Set([
  "inlineMath", "inlineCode", "link", "linkReference", "image", "imageReference",
  "footnoteReference", "html",
]);

/**
 * 收集链接、代码等不能在内部随意切断的原文区间。
 *
 * @param node 当前语法树或编辑器节点。
 * @param offset 从原文或分页数据的哪个位置开始读取。
 * @returns 整理后的结果列表。
 */
export function protectedRanges(node: MarkdownNode, offset: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  /**
   * 递归收集不可在内部切断的 Markdown 内联节点范围。
   *
   * @param child 当前节点的子节点。
   */
  const visit = (child: MarkdownNode) => {
    if (INLINE_ATOMS.has(child.type)) {
      const start = child.position?.start.offset;
      const end = child.position?.end.offset;
      if (start !== undefined && end !== undefined) ranges.push([start - offset, end - offset]);
      return;
    }
    for (const nested of child.children ?? []) visit(nested);
  };
  visit(node);
  return ranges;
}

/**
 * 生成避开受保护区间的句子范围，作为安全切块边界。
 *
 * @param text 待处理的文本。
 * @param protectedSpans 不允许从内部切断的原文区间。
 * @returns 整理后的结果列表。
 */
export function sentenceRanges(
  text: string,
  protectedSpans: Array<[number, number]> = [],
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let start = 0;
  let spanIndex = 0;
  for (let index = 0; index < text.length; index += 1) {
    while (spanIndex < protectedSpans.length && protectedSpans[spanIndex]![1] <= index) spanIndex++;
    const span = protectedSpans[spanIndex];
    if (span && index >= span[0] && index < span[1]) {
      index = span[1] - 1;
      continue;
    }
    const char = text[index]!;
    if (!"。！？；!?;\n".includes(char) && !(char === "." && /\s|^$/u.test(text[index + 1] ?? ""))) continue;
    let end = index + 1;
    while (end < text.length && /\s/u.test(text[end]!)) end++;
    ranges.push([start, end]);
    start = end;
    index = end - 1;
  }
  if (start < text.length) ranges.push([start, text.length]);
  return ranges.length ? ranges : [[0, text.length]];
}

