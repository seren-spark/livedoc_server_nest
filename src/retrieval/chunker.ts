import { createHash } from "node:crypto";
import { codeRanges, OversizedCodeError } from "./code-boundaries.js";
import { parseMarkdown, protectedRanges, sentenceRanges, walkMarkdown, type MarkdownNode } from "./markdown-structure.js";

export interface Chunk {
  chunk_id: string; // 唯一ID，格式: {docId}_{index}_{sha256前10位}
  doc_id: string; // 所属文档ID
  chunk_index: number; // 在文档中的序号
  ordinal: number; // 排序值（目前等于 chunk_index）
  title: string; // 文档标题
  heading_path: string[]; // 标题层级路径，如 ["# 概述", "## 安装"]
  content: string; // chunk 的 Markdown 原文
  retrieval_content?: string; // 补充表头、代码围栏等上下文后的文本，不能用于计算原文 offset
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
  countTokens?: (text: string) => number;
}

type ResolvedChunkingOptions = {
  maxTokens: number;
  overlapTokens: number;
  countTokens: (text: string) => number;
};

type BlockType = "heading" | "paragraph" | "list" | "code" | "table" | "math" | "blockquote" | "other";

type Block = {
  type: BlockType;
  text: string;
  headingPath: string[];
  startOffset: number;
  endOffset: number;
  node: MarkdownNode;
  source: string;
  context: string[];
  intro?: string;
  retrievalText?: string;
  definitions: Map<string, string>;
  countTokens: (text: string) => number;
};

type PassageInput = Pick<Chunk, "title" | "heading_path" | "content" | "retrieval_content">;

export class UnsplittableMarkdownError extends Error {}

/** Reuse structure rules with the generation tokenizer; skip only indivisible oversized units. */
export function markdownCompressionUnits(
  content: string,
  budget: number,
  countTokens: (text: string) => number,
): Array<{ text: string; atomic: boolean }> {
  return parseMarkdownBlocks(content, countTokens).flatMap((block) => {
    try {
      if (block.intro && block.type !== "paragraph" && block.type !== "heading" &&
          countTokens(block.intro) <= budget / 4 && !block.context.includes(block.intro)) {
        block = { ...block, context: [...block.context, block.intro] };
      }
      const parts = block.type === "paragraph"
        ? packRanges(block, sentenceRanges(block.text, protectedRanges(block.node, block.startOffset)), budget)
        : splitOversizedBlock(block, budget);
      return parts.map((part) => ({ text: renderBlock(part).trim(), atomic:
        part.type !== "paragraph" || part.context.length > 0 || protectedRanges(part.node, part.startOffset)
          .some(([start, end]) => start < part.text.length && end > 0) }));
    } catch (error) {
      if (error instanceof UnsplittableMarkdownError) return [];
      throw error;
    }
  });
}

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
  const blocks = parseMarkdownBlocks(markdown, chunking.countTokens);
  const chunks: Chunk[] = [];
  let buffer: Block[] = []; //当前正在累积的 Block 文本

  /**
   * 把当前累积在 buffer 里的多个 Block，打包成一个 Chunk。buffer 是当前正在累积的块集合
   */
  const flush = () => {
    if (!buffer.length) return;
    chunks.push(buildChunk(docId, title, buffer, chunks.length, markdown));
    buffer = [];
  };
  for (const block of blocks) {
    //如果遇到标题且 buffer 里已有内容，说明开始新章节，先 flush。
    if (block.type === "heading" && startsNewSection(buffer, block)) flush();
    //计算当前 part 能用的内容预算
    const budget = contentTokenBudget(
      title,
      block.headingPath,
      chunking.maxTokens,
      chunking.countTokens,
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
      //最后把 part 加入 buffer
      buffer.push(part);
    }
  }

  flush();
  return chunks;
}

/**
 * 解析并校验参数（maxTokens 至少 64，overlapTokens 在合理范围内）
 * @param options chunk参数
 * @return {maxTokens, overlapTokens}
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
  return { maxTokens, overlapTokens, countTokens: options.countTokens ?? estimateTokens };
}

export function buildChunkPassage(chunk: PassageInput): string {
  return `${buildPassagePrefix(chunk.title, chunk.heading_path)}\n${chunk.retrieval_content ?? chunk.content}`;
}

/**
 * 将 Markdown 解析为 AST, 再提取为 Block 数组。这就是 GFM 解析发生的地方。
 */
function parseMarkdownBlocks(markdown: string, countTokens = estimateTokens): Block[] {
  //fromMarkdown:将 Markdown 文本解析为 mdast 语法树（一个 Root 节点）
  const root = parseMarkdown(markdown);
  const definitions = new Map<string, string>();
  walkMarkdown(root, (node) => {
    if (node.type !== "definition" && node.type !== "footnoteDefinition") return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.identifier && start !== undefined && end !== undefined) {
      definitions.set(`${node.type}:${node.identifier}`, markdown.slice(start, end));
    }
  });
  const blocks: Block[] = [];
  //栈式结构，记录当前所在的标题层级
  let headingPath: string[] = [];
  //遍历 AST 根节点的每个直接子节点（每个都是一个顶层块元素）
  for (const node of root.children ?? []) {
    if (node.type === "definition" || node.type === "footnoteDefinition") continue;
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
        node.depth!,
        //递归提取节点中的所有文本。优先取 value（文本节点、代码节点），其次取 alt（图片），否则递归处理 children。用于提取标题文本。
        extractNodeText(node).trim(),
      );
    }
    //每个节点包装为 Block 对象，headingPath 做浅拷贝
    // {
    //   type: "paragraph",
    //   text: "一个热点 key 过期时，大量请求可能同时访问数据库。",
    //   headingPath: ["Redis 缓存实践", "缓存击穿"],
    //   startOffset: 120,
    //   endOffset: 160
    // }
    blocks.push({
      type,
      text,
      headingPath: [...headingPath],
      startOffset,
      endOffset,
      node,
      source: markdown,
      context: [],
      definitions,
      countTokens,
    });
  }
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]!;
    const previous = blocks[index - 1];
    const next = blocks[index + 1];
    if (previous?.type === "paragraph" && samePath(previous.headingPath, block.headingPath) &&
        countTokens(previous.text) <= 64) block.intro = previous.text;
    if (block.type === "math" || isImageBlock(block)) {
      if (block.intro) block.context.push(block.intro);
      if (next?.type === "paragraph" && samePath(next.headingPath, block.headingPath) &&
          countTokens(next.text) <= 64) block.context.push(next.text);
    }
  }
  return blocks;
}
/**
 * 将 mdast 节点类型映射为 BlockType
 */
function blockType(node: MarkdownNode): BlockType {
  if (node.type === "heading") return "heading";
  if (node.type === "paragraph") return "paragraph";
  if (node.type === "list") return "list";
  if (node.type === "code") return "code";
  if ((node as { type: string }).type === "table") return "table";
  if (node.type === "math") return "math";
  if (node.type === "blockquote") return "blockquote";
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

function truncateToTokenBudget(text: string, budget: number, countTokens = estimateTokens): string {
  if (budget <= 0) return "";
  if (countTokens(text) <= budget) return text;
  let low = 1;
  let high = text.length;
  let best = 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (countTokens(text.slice(0, middle)) <= budget) {
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
  markdown: string,
): Chunk {
  const contentBlocks = blocks.filter((block) => block.text.trim());
  //把多个 block 的 text 拼接成一个完整的 Markdown 字符串
  const start = Math.min(...contentBlocks.map((block) => block.startOffset));
  const end = Math.max(...contentBlocks.map((block) => block.endOffset));
  const rawContent = markdown.slice(start, end);
  //原始拼接结果开头有多少空白字符
  const leadingWhitespace = rawContent.length - rawContent.trimStart().length;
  //结尾有多少空白字符
  const trailingWhitespace = rawContent.length - rawContent.trimEnd().length;
  //trim 后的干净内容
  const content = rawContent.trim();
  const retrievalContent = joinBlocks(blocks);
  const headingPath = chunkHeadingPath(blocks);
  const digest = createHash("sha256")
    .update(retrievalContent)
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
    ...(retrievalContent !== content ? { retrieval_content: retrievalContent } : {}),
    token_count: blocks[0]!.countTokens(retrievalContent),
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
    next.countTokens(
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
  countTokens: (text: string) => number,
): number {
  //调用 estimateTokens 估算title 和 heading_path 前缀占多少 token
  const prefixTokens = countTokens(
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
  if (block.countTokens(renderBlock(block)) <= budget) return [block];
  if ((block.type === "math" || isImageBlock(block)) && block.context.length) {
    // Nearby prose is optional; never reject a fitting formula because of copied context.
    const context = [...block.context];
    while (context.length && block.countTokens(renderBlock({ ...block, context })) > budget) context.pop();
    block = { ...block, context };
    if (block.countTokens(renderBlock(block)) <= budget) return [block];
  }
  if (block.type === "math" || block.node.type === "html") {
    throw new UnsplittableMarkdownError(`Atomic ${block.node.type} at offset ${block.startOffset} exceeds the chunk budget; shorten it or increase CHUNK_MAX_TOKENS`);
  }
  if (block.intro && block.countTokens(block.intro) <= budget / 4 && !block.context.includes(block.intro)) {
    block = { ...block, context: [...block.context, block.intro] };
  }
  if (block.type === "code") return splitCode(block, budget);
  if (block.type === "table") return splitTable(block, budget);
  if (block.type === "list") return splitList(block, budget);
  if (block.type === "blockquote") {
    const last = block.node.children?.at(-1);
    const attribution = last?.type === "paragraph" ? extractNodeText(last).trim() : "";
    const context = [...block.context, "引用片段："];
    if (/^(?:来源|出处|作者|source)\s*[:：]/iu.test(attribution) && block.countTokens(attribution) <= budget / 4) {
      context.push(attribution);
    }
    return (block.node.children ?? []).flatMap((child) =>
      splitOversizedBlock(childBlock(block, child, context), budget));
  }
  const units = sentenceRanges(block.text, protectedRanges(block.node, block.startOffset));
  return packRanges(block, units, budget);
}

function packRanges(
  block: Block,
  units: Array<[number, number]>,
  budget: number,
  decorate: (part: Block) => Block = (part) => part,
  oversized: (start: number, end: number) => Block[] = (start, end) => hardSplitBlock(block, start, end, budget),
): Block[] {
  const parts: Block[] = [];
  //当前正在累积的连续 unit 区间的起止位置
  let pendingStart: number | null = null;
  let pendingEnd = 0;

  //把当前 pending 区间从原 block 中切出来，生成一个新 Block 加入 parts，然后重置 pending
  const flushPending = () => {
    if (pendingStart === null) return;
    parts.push(decorate(sliceBlock(block, pendingStart, pendingEnd)));
    pendingStart = null;
  };

  for (const [start, end] of units) {
    const unit = decorate(sliceBlock(block, start, end));
    //超长单元交给对应的结构拆分规则；普通文本才会进入字符回退。
    if (block.countTokens(renderBlock(unit)) > budget) {
      flushPending();
      parts.push(...oversized(start, end));
      continue;
    }

    const candidateStart = pendingStart ?? start;
    const candidate = decorate(sliceBlock(block, candidateStart, end));
    //判断合并后是否超预算
    if (pendingStart !== null && block.countTokens(renderBlock(candidate)) > budget) {
      flushPending();
      pendingStart = start;
    } else if (pendingStart === null) {
      pendingStart = start;
    }
    pendingEnd = end;
  }
  flushPending();
  //parts = [小 Block 1, 小 Block 2, 小 Block 3]
  return parts;
}

function childBlock(block: Block, node: MarkdownNode, context = block.context): Block {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) throw new Error("Markdown node has no source position");
  return { ...block, node, type: blockType(node), text: block.source.slice(start, end),
    startOffset: start, endOffset: end, context, intro: undefined, retrievalText: undefined };
}

function nodeRanges(block: Block, nodes: MarkdownNode[]): Array<[number, number]> {
  return nodes.map((node) => [node.position!.start.offset! - block.startOffset,
    node.position!.end.offset! - block.startOffset]);
}

function splitTable(block: Block, budget: number): Block[] {
  const rows = block.node.children ?? [];
  const data = rows.slice(1);
  if (!data.length) throw new UnsplittableMarkdownError("Table header exceeds the chunk budget");
  const header = block.text.slice(0, data[0]!.position!.start.offset! - block.startOffset).trimEnd();
  const decorate = (part: Block): Block => ({ ...part, retrievalText:
    part.startOffset === block.startOffset ? part.text : `${header}\n${part.text}` });
  const ranges = nodeRanges(block, data);
  ranges[0]![0] = 0; // The first source fragment retains the original header.
  return packRanges(block, ranges, budget, decorate, (start, end) => {
    const row = data.find((node) => node.position!.end.offset! === block.startOffset + end)!;
    const rowNumber = data.indexOf(row) + 1;
    const keyColumn = extractNodeText(rows[0]!.children?.[0]);
    const keyValue = extractNodeText(row.children?.[0]);
    const rowKey = block.countTokens(keyValue) <= budget / 4 ? `；${keyColumn}：${keyValue}` : "";
    return (row.children ?? []).flatMap((cell, index) => {
      const column = extractNodeText(rows[0]!.children?.[index]) || `列 ${index + 1}`;
      const field = childBlock(block, cell, [...block.context, `表格第 ${rowNumber} 行${rowKey}；字段：${column}`]);
      // A very wide/long row becomes labelled fields; preserve inline atoms in each field.
      return splitOversizedBlock({ ...field, type: "paragraph" }, budget);
    });
  });
}

function splitList(block: Block, budget: number): Block[] {
  const items = block.node.children ?? [];
  return packRanges(block, nodeRanges(block, items), budget, (part) => part, (start, end) => {
    const item = items.find((node) => node.position!.end.offset! === block.startOffset + end)!;
    const lead = item.children?.[0];
    const leadEnd = lead?.position?.end.offset ?? item.position!.end.offset!;
    const label = truncateToTokenBudget(block.source.slice(item.position!.start.offset!, leadEnd)
      .replace(/\s+/gu, " "), Math.min(32, Math.floor(budget / 4)), block.countTokens);
    const context = [...block.context, `上级列表项：${label}`];
    return (item.children ?? []).flatMap((child) => splitOversizedBlock(childBlock(block, child, context), budget));
  });
}

function splitCode(block: Block, budget: number): Block[] {
  const language = block.node.lang ?? "";
  if (["mermaid", "plantuml", "dot", "graphviz"].includes(language.toLowerCase())) {
    throw new UnsplittableMarkdownError(`Diagram at offset ${block.startOffset} exceeds the chunk budget; split it into complete diagrams`);
  }
  const opening = block.text.match(/^[ \t]{0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/u);
  const bodyStart = opening?.[0].length ?? 0;
  const closing = opening ? block.text.match(/(?:^|\n)[ \t]*([`~]{3,})[ \t]*$/u) : null;
  const bodyEnd = closing && closing.index! >= bodyStart ? closing.index! : block.text.length;
  const body = block.text.slice(bodyStart, bodyEnd);
  const runs = [...body.matchAll(/`+/gu)].map((match) => match[0].length);
  const fence = "`".repeat(Math.max(3, ...runs.map((length) => length + 1)));
  const info = [language, block.node.meta ?? ""].filter(Boolean).join(" ");
  const decorate = (start: number, end: number, owner?: string): Block => {
    const part = sliceBlock(block, bodyStart + start, bodyStart + end);
    const label = owner ? `；所属函数：${truncateToTokenBudget(owner, 24)}` : "";
    return { ...part, retrievalText: `代码片段（原代码块的一部分）${label}\n${fence}${info}\n${part.text.trimEnd()}\n${fence}` };
  };
  let ranges;
  try {
    ranges = codeRanges(body, language,
      (start, end, owner) => block.countTokens(renderBlock(decorate(start, end, owner))) <= budget);
  } catch (error) {
    if (error instanceof OversizedCodeError) throw new UnsplittableMarkdownError(error.message);
    throw error;
  }
  return ranges.map(({ start, end, owner }) => decorate(start, end, owner));
}

function renderBlock(block: Block): string {
  const references = new Set<string>();
  walkMarkdown(block.node, (node) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined || start < block.startOffset || end > block.endOffset) return;
    const type = node.type === "footnoteReference" ? "footnoteDefinition"
      : node.type === "linkReference" || node.type === "imageReference" ? "definition" : undefined;
    const definition = type && block.definitions.get(`${type}:${node.identifier}`);
    if (definition) references.add(definition);
  });
  return [...block.context, block.retrievalText ?? block.text, ...references].filter(Boolean).join("\n\n");
}

function isImageBlock(block: Block): boolean {
  return block.node.type === "paragraph" && Boolean(block.node.children?.some((node) =>
    node.type === "image" || node.type === "imageReference")) &&
    block.node.children!.every((node) => ["image", "imageReference"].includes(node.type) ||
      (node.type === "text" && !node.value?.trim()));
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
      if (block.countTokens(renderBlock(sliceBlock(block, cursor, middle))) <= budget) {
        best = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    const spans = protectedRanges(block.node, block.startOffset);
    const atom = spans.find(([left, right]) => left < best && right > best);
    if (atom) best = atom[0] > cursor ? atom[0] : atom[1];
    if (best < end && /[\uDC00-\uDFFF]/u.test(block.text[best]!)) best--;
    const part = sliceBlock(block, cursor, best);
    if (best <= cursor || block.countTokens(renderBlock(part)) > budget) {
      throw new UnsplittableMarkdownError(`Protected Markdown content at offset ${block.startOffset + cursor} exceeds the chunk budget`);
    }
    parts.push(part);
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

/**
 * 从上一个 chunk 的末尾开始，取最多 overlapTokens 个 token 的 block
 *  @params blocks 上一个 chunk 的所有 block
 *  @params nextHeadingPath 下一个 chunk 所在章节的 headingPath
 *  @params overlapTokens 最多允许重叠多少 token
 */
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
    // Structured content carries its own context; never copy a partial code/table/formula.
    if (block.type !== "paragraph" || block.context.length || block.retrievalText) break;
    const tokens = block.countTokens(renderBlock(block));
    if (tokens <= remaining) {
      result.push(block);
      remaining -= tokens;
    } else {
      const tail = tailBlock(block, remaining);
      if (tail) result.push(tail);
      remaining = 0;
    }
    if (remaining <= 0) break;
  }
  //最后 reverse 回正序
  return result.reverse();
}

function tailBlock(block: Block, budget: number): Block | undefined {
  let tail: Block | undefined;
  for (const [start] of sentenceRanges(block.text, protectedRanges(block.node, block.startOffset)).reverse()) {
    const candidate = sliceBlock(block, start, block.text.length);
    if (block.countTokens(renderBlock(candidate)) > budget) break;
    tail = candidate;
  }
  return tail;
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
    const text = renderBlock(block);
    if (index === 0) return text;
    const previous = nonEmpty[index - 1]!;
    const separator = previous.endOffset === block.startOffset && renderBlock(previous) === previous.text && text === block.text ? "" : "\n\n";
    return `${result}${separator}${text}`;
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
