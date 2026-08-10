import { createHash } from "node:crypto";
import type { RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

export interface Chunk {
  chunk_id: string;
  doc_id: string;
  chunk_index: number;
  ordinal: number;
  title: string;
  heading_path: string[];
  content: string;
  token_count: number;
  start_offset: number;
  end_offset: number;
  source_anchor: string;
}

// This is the complete embedding passage budget, including title and heading path.
export const MAX_CHUNK_TOKENS = 420;
export const OVERLAP_TOKENS = 64;
const MAX_PASSAGE_METADATA_TOKENS = 96;

export interface ChunkingOptions {
  maxTokens?: number;
  overlapTokens?: number;
}

type ResolvedChunkingOptions = {
  maxTokens: number;
  overlapTokens: number;
};

type BlockType = "heading" | "paragraph" | "list" | "code" | "table" | "other";

type Block = {
  type: BlockType;
  text: string;
  headingPath: string[];
  startOffset: number;
  endOffset: number;
};

type PassageInput = Pick<Chunk, "title" | "heading_path" | "content">;

export function chunkMarkdown(
  docId: string,
  title: string,
  markdown: string,
  options: ChunkingOptions = {},
): Chunk[] {
  const chunking = resolveChunkingOptions(options);
  const blocks = parseMarkdownBlocks(markdown);
  const chunks: Chunk[] = [];
  let buffer: Block[] = [];

  const flush = () => {
    if (!buffer.length) return;
    chunks.push(buildChunk(docId, title, buffer, chunks.length));
    buffer = [];
  };

  for (const block of blocks) {
    if (block.type === "heading" && startsNewSection(buffer, block)) flush();

    const budget = contentTokenBudget(title, block.headingPath, chunking.maxTokens);
    for (const part of splitOversizedBlock(block, budget)) {
      if (
        buffer.length &&
        exceedsPassageBudget(title, buffer, part, chunking.maxTokens)
      ) {
        const previous = buffer;
        flush();
        buffer = hasBodyContent(previous)
          ? takeOverlap(previous, part.headingPath, chunking.overlapTokens)
          : [];
        buffer = trimOverlapToFit(title, buffer, part, chunking.maxTokens);
      }
      buffer.push(part);
    }
  }

  flush();
  return chunks;
}

function resolveChunkingOptions(options: ChunkingOptions): ResolvedChunkingOptions {
  const maxTokens = Math.floor(options.maxTokens ?? MAX_CHUNK_TOKENS);
  const overlapTokens = Math.floor(options.overlapTokens ?? OVERLAP_TOKENS);
  if (maxTokens < 64) throw new Error("Chunk maxTokens must be at least 64");
  if (overlapTokens < 0 || overlapTokens >= maxTokens) {
    throw new Error("Chunk overlapTokens must be non-negative and smaller than maxTokens");
  }
  return { maxTokens, overlapTokens };
}

export function buildChunkPassage(chunk: PassageInput): string {
  return `${buildPassagePrefix(chunk.title, chunk.heading_path)}\n${chunk.content}`;
}

function parseMarkdownBlocks(markdown: string): Block[] {
  const root = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const blocks: Block[] = [];
  let headingPath: string[] = [];

  for (const node of root.children) {
    const startOffset = node.position?.start.offset;
    const endOffset = node.position?.end.offset;
    if (startOffset === undefined || endOffset === undefined) continue;

    const text = markdown.slice(startOffset, endOffset);
    if (!text.trim()) continue;

    const type = blockType(node);
    if (node.type === "heading") {
      headingPath = updateHeadingPath(
        headingPath,
        node.depth,
        extractNodeText(node).trim(),
      );
    }
    blocks.push({
      type,
      text,
      headingPath: [...headingPath],
      startOffset,
      endOffset,
    });
  }
  return blocks;
}

function blockType(node: RootContent): BlockType {
  if (node.type === "heading") return "heading";
  if (node.type === "paragraph") return "paragraph";
  if (node.type === "list") return "list";
  if (node.type === "code") return "code";
  if ((node as { type: string }).type === "table") return "table";
  return "other";
}

function extractNodeText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const record = node as {
    value?: unknown;
    alt?: unknown;
    children?: unknown[];
  };
  if (typeof record.value === "string") return record.value;
  if (typeof record.alt === "string") return record.alt;
  return (record.children ?? []).map(extractNodeText).join("");
}

function updateHeadingPath(path: string[], level: number, text: string): string[] {
  return [...path.slice(0, level - 1), text];
}

function buildPassagePrefix(title: string, headingPath: string[]): string {
  const titleBudget = Math.floor(MAX_PASSAGE_METADATA_TOKENS / 3);
  const compactTitle = truncateToTokenBudget(title, titleBudget);
  const base = `title: ${compactTitle}\npath: `;
  const pathBudget = Math.max(
    1,
    MAX_PASSAGE_METADATA_TOKENS - estimateTokens(base),
  );
  const compactPath = compactHeadingPath(headingPath, pathBudget);
  return `title: ${compactTitle}\npath: ${compactPath}`;
}

function compactHeadingPath(path: string[], budget: number): string {
  const selected: string[] = [];
  for (const heading of [...path].reverse()) {
    const candidate = [heading, ...selected].join(" > ");
    if (estimateTokens(candidate) <= budget) {
      selected.unshift(heading);
      continue;
    }
    if (!selected.length) selected.push(truncateToTokenBudget(heading, budget));
    break;
  }
  return selected.join(" > ");
}

function truncateToTokenBudget(text: string, budget: number): string {
  if (budget <= 0) return "";
  if (estimateTokens(text) <= budget) return text;
  let low = 1;
  let high = text.length;
  let best = 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (estimateTokens(text.slice(0, middle)) <= budget) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return text.slice(0, best);
}

function startsNewSection(buffer: Block[], nextHeading: Block): boolean {
  if (!buffer.length) return false;
  if (hasBodyContent(buffer)) return true;
  const previousPath = buffer.at(-1)?.headingPath ?? [];
  return !isPathPrefix(previousPath, nextHeading.headingPath);
}

function isPathPrefix(prefix: string[], path: string[]): boolean {
  return (
    prefix.length < path.length &&
    prefix.every((heading, index) => heading === path[index])
  );
}

function buildChunk(
  docId: string,
  title: string,
  blocks: Block[],
  index: number,
): Chunk {
  const contentBlocks = blocks.filter((block) => block.text.trim());
  const rawContent = joinBlocksRaw(contentBlocks);
  const leadingWhitespace = rawContent.length - rawContent.trimStart().length;
  const trailingWhitespace = rawContent.length - rawContent.trimEnd().length;
  const content = rawContent.trim();
  const headingPath = chunkHeadingPath(blocks);
  const digest = createHash("sha256")
    .update(content)
    .digest("hex")
    .slice(0, 10);
  const chunkId = `${docId}_${index}_${digest}`;

  return {
    chunk_id: chunkId,
    doc_id: docId,
    chunk_index: index,
    ordinal: index,
    title,
    heading_path: [...headingPath],
    content,
    token_count: estimateTokens(content),
    start_offset:
      Math.min(...contentBlocks.map((block) => block.startOffset)) +
      leadingWhitespace,
    end_offset:
      Math.max(...contentBlocks.map((block) => block.endOffset)) -
      trailingWhitespace,
    source_anchor: `chunk-${chunkId}`,
  };
}

function exceedsPassageBudget(
  title: string,
  blocks: Block[],
  next: Block,
  maxTokens: number,
): boolean {
  const allBlocks = [...blocks, next];
  return (
    estimateTokens(
      buildChunkPassage({
        title,
        heading_path: chunkHeadingPath(allBlocks),
        content: joinBlocks(allBlocks),
      }),
    ) > maxTokens
  );
}

function contentTokenBudget(
  title: string,
  headingPath: string[],
  maxTokens: number,
): number {
  const prefixTokens = estimateTokens(
    buildChunkPassage({ title, heading_path: headingPath, content: "" }),
  );
  return Math.max(1, maxTokens - prefixTokens);
}

function splitOversizedBlock(block: Block, budget: number): Block[] {
  if (estimateTokens(block.text) <= budget) return [block];
  const units =
    block.type === "code" || block.type === "list" || block.type === "table"
      ? lineRanges(block.text)
      : sentenceRanges(block.text);
  const parts: Block[] = [];
  let pendingStart: number | null = null;
  let pendingEnd = 0;

  const flushPending = () => {
    if (pendingStart === null) return;
    parts.push(sliceBlock(block, pendingStart, pendingEnd));
    pendingStart = null;
  };

  for (const [start, end] of units) {
    const unit = block.text.slice(start, end);
    if (estimateTokens(unit) > budget) {
      flushPending();
      parts.push(...hardSplitBlock(block, start, end, budget));
      continue;
    }
    const candidateStart = pendingStart ?? start;
    const candidate = block.text.slice(candidateStart, end);
    if (pendingStart !== null && estimateTokens(candidate) > budget) {
      flushPending();
      pendingStart = start;
    } else if (pendingStart === null) {
      pendingStart = start;
    }
    pendingEnd = end;
  }
  flushPending();
  return parts;
}

function sentenceRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (!"。！？；.!?;\n".includes(char)) continue;
    let end = index + 1;
    while (end < text.length && /\s/u.test(text[end]!)) end += 1;
    ranges.push([start, end]);
    start = end;
    index = end - 1;
  }
  if (start < text.length) ranges.push([start, text.length]);
  return ranges.length ? ranges : [[0, text.length]];
}

function lineRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n") continue;
    ranges.push([start, index + 1]);
    start = index + 1;
  }
  if (start < text.length) ranges.push([start, text.length]);
  return ranges.length ? ranges : [[0, text.length]];
}

function hardSplitBlock(
  block: Block,
  start: number,
  end: number,
  budget: number,
): Block[] {
  const parts: Block[] = [];
  let cursor = start;
  while (cursor < end) {
    let low = cursor + 1;
    let high = end;
    let best = low;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (estimateTokens(block.text.slice(cursor, middle)) <= budget) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    parts.push(sliceBlock(block, cursor, best));
    cursor = best;
  }
  return parts;
}

function sliceBlock(block: Block, start: number, end: number): Block {
  return {
    ...block,
    text: block.text.slice(start, end),
    startOffset: block.startOffset + start,
    endOffset: block.startOffset + end,
  };
}

function takeOverlap(
  blocks: Block[],
  nextHeadingPath: string[],
  overlapTokens: number,
): Block[] {
  if (overlapTokens <= 0) return [];
  const result: Block[] = [];
  let remaining = overlapTokens;

  for (const block of [...blocks].reverse()) {
    if (block.type === "heading" || !samePath(block.headingPath, nextHeadingPath)) {
      continue;
    }
    const tokens = estimateTokens(block.text);
    if (tokens <= remaining) {
      result.push(block);
      remaining -= tokens;
    } else {
      result.push(tailBlock(block, remaining));
      remaining = 0;
    }
    if (remaining <= 0) break;
  }
  return result.reverse();
}

function tailBlock(block: Block, budget: number): Block {
  let low = 0;
  let high = block.text.length - 1;
  let best = high;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (estimateTokens(block.text.slice(middle)) <= budget) {
      best = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return sliceBlock(block, best, block.text.length);
}

function trimOverlapToFit(
  title: string,
  overlap: Block[],
  next: Block,
  maxTokens: number,
): Block[] {
  const result = [...overlap];
  while (
    result.length &&
    exceedsPassageBudget(title, result, next, maxTokens)
  ) {
    result.shift();
  }
  return result;
}

function samePath(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  );
}

function joinBlocks(blocks: Block[]): string {
  return joinBlocksRaw(blocks).trim();
}

function joinBlocksRaw(blocks: Block[]): string {
  const nonEmpty = blocks.filter((block) => block.text.trim());
  return nonEmpty.reduce((result, block, index) => {
    if (index === 0) return block.text;
    const previous = nonEmpty[index - 1]!;
    const separator = previous.endOffset === block.startOffset ? "" : "\n\n";
    return `${result}${separator}${block.text}`;
  }, "");
}

function chunkHeadingPath(blocks: Block[]): string[] {
  const body = [...blocks].reverse().find((block) => block.type !== "heading");
  return [...((body ?? blocks.at(-1))?.headingPath ?? [])];
}

function hasBodyContent(blocks: Block[]): boolean {
  return blocks.some((block) => block.type !== "heading");
}

export function estimateTokens(text: string): number {
  const cjk =
    text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu)?.length ?? 0;
  const latin = text.match(/[A-Za-z0-9_]+/gu) ?? [];
  const latinTokens = latin.reduce(
    (total, word) => total + Math.max(1, Math.ceil(word.length / 4)),
    0,
  );
  const other = text
    .replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu, "")
    .replace(/[A-Za-z0-9_]+/gu, "")
    .replace(/\s/gu, "").length;
  return Math.max(1, cjk + latinTokens + Math.ceil(other / 2));
}
