import { createHash } from 'node:crypto';

export interface Chunk {
  chunk_id: string;
  doc_id: string;
  chunk_index: number;
  title: string;
  heading_path: string[];
  content: string;
  token_count: number;
}

export const MAX_CHUNK_TOKENS = 500;
export const OVERLAP_TOKENS = 80;

type Block = { type: 'heading' | 'paragraph' | 'list' | 'code'; level?: number; text: string };

export function chunkMarkdown(docId: string, title: string, markdown: string): Chunk[] {
  const blocks = parseMarkdownBlocks(markdown);
  const chunks: Chunk[] = [];
  let buffer: string[] = [];
  let headingPath: string[] = [];
  for (const block of blocks) {
    if (block.type === 'heading' && block.level) {
      headingPath = updateHeadingPath(headingPath, block.level, block.text);
    }
    const merged = [...buffer, block.text].join('\n\n').trim();
    if (buffer.length && estimateTokens(merged) > MAX_CHUNK_TOKENS) {
      chunks.push(buildChunk(docId, title, headingPath, buffer, chunks.length));
      buffer = takeOverlap(buffer);
    }
    buffer.push(block.text);
  }
  if (buffer.length) chunks.push(buildChunk(docId, title, headingPath, buffer, chunks.length));
  return chunks;
}

function parseMarkdownBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let codeBlock: string[] = [];
  let inCode = false;
  const flush = () => {
    const text = paragraph.join('\n').trim();
    if (text) blocks.push({ type: 'paragraph', text });
    paragraph = [];
  };
  for (const line of markdown.split(/\r?\n/)) {
    if (line.trimStart().startsWith('```')) {
      if (inCode) {
        codeBlock.push(line);
        blocks.push({ type: 'code', text: codeBlock.join('\n') });
        codeBlock = [];
        inCode = false;
      } else {
        flush();
        codeBlock.push(line);
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBlock.push(line);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: 'heading', level: heading[1]!.length, text: heading[2]!.trim() });
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      flush();
      blocks.push({ type: 'list', text: line.trim() });
      continue;
    }
    if (!line.trim()) flush();
    else paragraph.push(line);
  }
  flush();
  if (codeBlock.length) blocks.push({ type: 'code', text: codeBlock.join('\n') });
  return blocks;
}

function updateHeadingPath(path: string[], level: number, text: string): string[] {
  return [...path.slice(0, level - 1), text];
}

function buildChunk(docId: string, title: string, headingPath: string[], blocks: string[], index: number): Chunk {
  const content = blocks.join('\n\n').trim();
  const digest = createHash('sha256').update(content).digest('hex').slice(0, 10);
  return {
    chunk_id: `${docId}_${index}_${digest}`,
    doc_id: docId,
    chunk_index: index,
    title,
    heading_path: [...headingPath],
    content,
    token_count: estimateTokens(content),
  };
}

function takeOverlap(blocks: string[]): string[] {
  const result: string[] = [];
  let tokens = 0;
  for (const block of [...blocks].reverse()) {
    result.push(block);
    tokens += estimateTokens(block);
    if (tokens >= OVERLAP_TOKENS) break;
  }
  return result.reverse();
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.floor(text.length / 2));
}
