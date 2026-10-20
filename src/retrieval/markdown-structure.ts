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

export function parseMarkdown(markdown: string): MarkdownNode {
  return fromMarkdown(markdown, {
    extensions: [gfm(), math()],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  });
}

export function walkMarkdown(node: MarkdownNode, visit: (node: MarkdownNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walkMarkdown(child, visit);
}

const INLINE_ATOMS = new Set([
  "inlineMath", "inlineCode", "link", "linkReference", "image", "imageReference",
  "footnoteReference", "html",
]);

export function protectedRanges(node: MarkdownNode, offset: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
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

