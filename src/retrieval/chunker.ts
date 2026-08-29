import { createHash } from "node:crypto";
//mdast 类型，表示语法树根节点的子节点类型
import type { RootContent } from "mdast";
//将 Markdown 文本解析为 mdast（Markdown Abstract Syntax Tree） 语法树
import { fromMarkdown } from "mdast-util-from-markdown";
//mdast-util 层面的 GFM 扩展，将 micromark 解析出的 GFM token 转换为 mdast 节点
import { gfmFromMarkdown } from "mdast-util-gfm";
//micromark 层面的 GFM 扩展，让解析器识别表格、删除线、任务列表、自动链接等 GFM 语法
import { gfm } from "micromark-extension-gfm";

export interface Chunk {
  chunk_id: string; // 唯一ID，格式: {docId}_{index}_{sha256前10位}
  doc_id: string; // 所属文档ID
  chunk_index: number; // 在文档中的序号
  ordinal: number; // 排序值（目前等于 chunk_index）
  title: string; // 文档标题
  heading_path: string[]; // 标题层级路径，如 ["# 概述", "## 安装"]
  content: string; // chunk 的 Markdown 原文
  token_count: number; // token 估算数
  start_offset: number; // 在原文中的起始字符偏移
  end_offset: number; // 在原文中的结束字符偏移
  source_anchor: string; // 锚点标识，用于前端定位
}

// This is the complete embedding passage budget, including title and heading path.
export const MAX_CHUNK_TOKENS = 420; // 每个 chunk 最大 token 数
export const OVERLAP_TOKENS = 64; // chunk 之间重叠 token 数（防止语义断裂）
const MAX_PASSAGE_METADATA_TOKENS = 96; // title + heading_path 前缀的 token 预算

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

/**
 * 将 Markdown 文档解析为多个 chunk。
 * @param docId 文档ID
 * @param title 文档标题
 * @param markdown 文档Markdown文本
 * @param options chunk参数
 * @returns chunk数组
 */
export function chunkMarkdown(
  docId: string,
  title: string,
  markdown: string,
  options: ChunkingOptions = {},
): Chunk[] {
  const chunking = resolveChunkingOptions(options);
  //将 Markdown 解析为 AST，再提取为 Block 数组。这就是 GFM 解析发生的地方。
  const blocks = parseMarkdownBlocks(markdown);
  const chunks: Chunk[] = [];
  let buffer: Block[] = []; //当前正在累积的 Block 文本

  /**
   * flush 把 buffer 打包成一个 Chunk,buffer 是当前正在累积的块集合
   */
  const flush = () => {
    if (!buffer.length) return;
    chunks.push(buildChunk(docId, title, buffer, chunks.length));
    buffer = [];
  };

  for (const block of blocks) {
    //如果遇到标题且 buffer 里已有内容，说明开始新章节，先 flush。
    if (block.type === "heading" && startsNewSection(buffer, block)) flush();

    const budget = contentTokenBudget(
      title,
      block.headingPath,
      chunking.maxTokens,
    );
    for (const part of splitOversizedBlock(block, budget)) {
      //如果加入新块后超过总预算 → 先 flush 当前 buffer
      if (
        buffer.length &&
        exceedsPassageBudget(title, buffer, part, chunking.maxTokens)
      ) {
        const previous = buffer;
        flush();
        //当需要取 overlap 时，先检查上一个 chunk 是否有正文内容
        buffer = hasBodyContent(previous)
          ? //从上一个 chunk 尾部取重叠内容（最多 overlapTokens 个 token），保证语义连贯
            takeOverlap(previous, part.headingPath, chunking.overlapTokens)
          : [];
        //如果重叠内容太多导致新 chunk 超限，从头部逐步丢弃
        buffer = trimOverlapToFit(title, buffer, part, chunking.maxTokens);
      }
      //最后把 part 加入 buffe
      buffer.push(part);
    }
  }

  flush();
  return chunks;
}

/**
 * 解析并校验参数（maxTokens 至少 64，overlapTokens 在合理范围内）
 */
function resolveChunkingOptions(
  options: ChunkingOptions,
): ResolvedChunkingOptions {
  const maxTokens = Math.floor(options.maxTokens ?? MAX_CHUNK_TOKENS);
  const overlapTokens = Math.floor(options.overlapTokens ?? OVERLAP_TOKENS);
  if (maxTokens < 64) throw new Error("Chunk maxTokens must be at least 64");
  if (overlapTokens < 0 || overlapTokens >= maxTokens) {
    throw new Error(
      "Chunk overlapTokens must be non-negative and smaller than maxTokens",
    );
  }
  return { maxTokens, overlapTokens };
}

export function buildChunkPassage(chunk: PassageInput): string {
  return `${buildPassagePrefix(chunk.title, chunk.heading_path)}\n${chunk.content}`;
}

/**
 * 将 Markdown 解析为 AST，再提取为 Block 数组。这就是 GFM 解析发生的地方。
 */
function parseMarkdownBlocks(markdown: string): Block[] {
  //fromMarkdown:将 Markdown 文本解析为 mdast 语法树（一个 Root 节点）
  const root = fromMarkdown(markdown, {
    // 告诉 micromark 解析器启用 GFM 扩展，能识别表格、删除线、任务列表、自动链接、脚注等。
    extensions: [gfm()],
    // 将 micromark 层产出的 GFM token 转为 mdast AST 节点（如 table、tableRow、tableCell、delete 等）
    mdastExtensions: [gfmFromMarkdown()],
  });
  const blocks: Block[] = [];
  //栈式结构，记录当前所在的标题层级
  let headingPath: string[] = [];
  //遍历 AST 根节点的每个直接子节点（每个都是一个顶层块元素）
  for (const node of root.children) {
    // position 是 mdast 提供的源码位置信息。
    const startOffset = node.position?.start.offset;
    const endOffset = node.position?.end.offset;
    if (startOffset === undefined || endOffset === undefined) continue;
    //从原文中按偏移量截取该节点的原始 Markdown 文本（而不是 AST 转回的文本），这样能保留原始格式
    const text = markdown.slice(startOffset, endOffset);
    if (!text.trim()) continue;
    //判断节点类型
    const type = blockType(node);
    if (node.type === "heading") {
      //更新 headingPath：比如遇到 ## 安装（depth=2），就把 path 截断到 level 1，再追加当前标题文本
      headingPath = updateHeadingPath(
        headingPath,
        node.depth,
        //递归提取节点中的所有文本。优先取 value（文本节点、代码节点），其次取 alt（图片），否则递归处理 children。用于提取标题文本。
        extractNodeText(node).trim(),
      );
    }
    //每个节点包装为 Block 对象，headingPath 做浅拷贝
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
/**
 * 将 mdast 节点类型映射为 BlockType
 */
function blockType(node: RootContent): BlockType {
  if (node.type === "heading") return "heading";
  if (node.type === "paragraph") return "paragraph";
  if (node.type === "list") return "list";
  if (node.type === "code") return "code";
  if ((node as { type: string }).type === "table") return "table";
  return "other";
}
/**
 * 递归提取节点中的所有文本。优先取 value（文本节点、代码节点），其次取 alt（图片），否则递归处理 children。用于提取标题文本。
 */
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
/**
 * 更新 headingPath：比如遇到 ## 安装（depth=2），就把 path 截断到 level 1，再追加当前标题文本
 */
function updateHeadingPath(
  path: string[],
  level: number,
  text: string,
): string[] {
  return [...path.slice(0, level - 1), text];
}
/**
 * 构建 passage 前缀，包含标题和路径。
 *
 * title: 文档标题
 *
 *  path: # 概述 > ## 安装 > ### Linux
 *
 * [chunk 正文内容]
 */
function buildPassagePrefix(title: string, headingPath: string[]): string {
  //总元数据预算 96 token，title 先占 1/3，即 32 token。
  const titleBudget = Math.floor(MAX_PASSAGE_METADATA_TOKENS / 3);
  //用二分查找把 title 截断到 32 token 以内。
  const compactTitle = truncateToTokenBudget(title, titleBudget);
  //"title: xxx\npath: "
  const base = `title: ${compactTitle}\npath: `;
  //剩下的预算全部给 path
  const pathBudget = Math.max(
    1,
    MAX_PASSAGE_METADATA_TOKENS - estimateTokens(base),
  );
  //把标题路径压缩到剩余预算内
  const compactPath = compactHeadingPath(headingPath, pathBudget);
  //返回最终前缀字符串
  return `title: ${compactTitle}\npath: ${compactPath}`;
}

function compactHeadingPath(path: string[], budget: number): string {
  const selected: string[] = [];
  //把路径反转，从最深层标题开始遍历。这样即使路径很长，也能优先保留最近的上下文
  for (const heading of [...path].reverse()) {
    const candidate = [heading, ...selected].join(" > ");
    //把当前 heading 插到 selected 最前面，模拟最终 path 字符串
    if (estimateTokens(candidate) <= budget) {
      selected.unshift(heading);
      continue;
    }
    //如果连最深层的一个标题都塞不下，就直接截断这个标题本身，然后停止。
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

/**
 * @param buffer 块缓冲区
 * @param nextHeading 下一个Block
 *
 * 判断当前块是否是一个新的章节。
 *
 * 如果前一个块有内容，则返回 false。
 *
 * 如果前一个块没有内容，则判断当前块的标题路径是否是前一个块的标题路径的前缀。
 */
function startsNewSection(buffer: Block[], nextHeading: Block): boolean {
  if (!buffer.length) return false;
  if (hasBodyContent(buffer)) return true;
  const previousPath = buffer.at(-1)?.headingPath ?? [];
  return !isPathPrefix(previousPath, nextHeading.headingPath);
}

/**
 * 判断路径是否是另一个路径的前缀。
 */
function isPathPrefix(prefix: string[], path: string[]): boolean {
  return (
    //prefix 必须比 path 短（严格前缀，不能相等）
    prefix.length < path.length &&
    //prefix 的每个元素都必须和 path 对应位置相同
    prefix.every((heading, index) => heading === path[index])
  );
}

/**
 * @description 块缓冲区转为 chunk
 * @param docId 文档ID
 * @param title 文档标题
 * @param blocks 块缓冲区
 * @param index chunk索引
 */
function buildChunk(
  docId: string,
  title: string,
  blocks: Block[],
  index: number,
): Chunk {
  const contentBlocks = blocks.filter((block) => block.text.trim());
  //把多个 block 的 text 拼接成一个完整的 Markdown 字符串
  const rawContent = joinBlocksRaw(contentBlocks);
  //原始拼接结果开头有多少空白字符
  const leadingWhitespace = rawContent.length - rawContent.trimStart().length;
  //结尾有多少空白字符
  const trailingWhitespace = rawContent.length - rawContent.trimEnd().length;
  //trim 后的干净内容
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
/**
 * 计算当前标题路径下内容可用的 token 预算（总预算减去前缀开销）
 * 然后如果单个块超大就拆分
 */
function contentTokenBudget(
  title: string,
  headingPath: string[],
  maxTokens: number,
): number {
  //调用 estimateTokens 估算title 和 heading_path 前缀占多少 token
  const prefixTokens = estimateTokens(
    buildChunkPassage({ title, heading_path: headingPath, content: "" }),
  );
  return Math.max(1, maxTokens - prefixTokens);
}

/**
 * 把一个超过 token 预算的 Block 拆成多个不超过预算的小 Block
 * 同时尽量保持语义/结构完整
 */
function splitOversizedBlock(block: Block, budget: number): Block[] {
  //如果块本身不超限，直接返回。
  if (estimateTokens(block.text) <= budget) return [block];

  //代码块 / 列表 / 表格 → 按行拆分 |   段落块 → 按句子拆分
  const units =
    block.type === "code" || block.type === "list" || block.type === "table"
      ? lineRanges(block.text)
      : sentenceRanges(block.text);
  const parts: Block[] = [];
  //当前正在累积的连续 unit 区间的起止位置
  let pendingStart: number | null = null;
  let pendingEnd = 0;

  //把当前 pending 区间从原 block 中切出来，生成一个新 Block 加入 parts，然后重置 pending
  const flushPending = () => {
    if (pendingStart === null) return;
    parts.push(sliceBlock(block, pendingStart, pendingEnd));
    pendingStart = null;
  };

  for (const [start, end] of units) {
    const unit = block.text.slice(start, end);
    //如果当前 unit 本身就比 budget 还大（比如一行非常长的代码、一个超长的句子），先 flush 掉之前 pending 的内容，然后对当前 unit 做强制二分截断。
    if (estimateTokens(unit) > budget) {
      flushPending();
      parts.push(...hardSplitBlock(block, start, end, budget));
      continue;
    }

    const candidateStart = pendingStart ?? start;
    const candidate = block.text.slice(candidateStart, end);
    //判断合并后是否超预算
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
  //从 blocks 末尾开始倒序取
  for (const block of [...blocks].reverse()) {
    if (
      block.type === "heading" ||
      !samePath(block.headingPath, nextHeadingPath)
    ) {
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
  //最后 reverse 回正序
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

/**  从 blocks 中找到最后一个非 heading 类型的 block，取其 headingPath。如果全是 heading，就取最后一个 block 的 headingPath。*/
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
