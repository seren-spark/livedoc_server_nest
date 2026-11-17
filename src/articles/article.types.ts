/**
 * @file 文章数据协议。定义草稿、发布快照和列表摘要，并提取文章引用的资源。
 */
import type { DocumentRecord } from "../documents/document.types.js";

export type ArticleState = "draft" | "published" | "withdrawn";
export interface ArticleContent {
  title: string;
  content: string;
  editor_content: Record<string, unknown> | null;
  summary: string;
  tags: string[];
  cover_asset_id: string | null;
  asset_ids: string[];
}
export interface ArticleDraft {
  article_id: string;
  space_id: string;
  owner_id: string;
  state: ArticleState;
  draft_version: number;
  draft: ArticleContent;
  published_draft_version: number | null;
  published_metadata: (Pick<
    ArticleContent,
    "summary" | "cover_asset_id" | "asset_ids"
  > & { include_in_knowledge?: boolean }) | null;
  published_at: Date | null;
  last_published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
/**
 * 判断文章当前是否应作为知识库可检索内容。
 *
 * @param article 当前文章草稿或发布记录。
 * @returns 条件是否满足的判断结果。
 */
export function articleInKnowledge(article: ArticleDraft): boolean {
  // Existing publications were indexed before this choice was introduced.
  return article.published_metadata != null && article.published_metadata.include_in_knowledge !== false;
}
export interface PublicArticle extends DocumentRecord {
  like_count: number;
  favorite_count: number;
  comment_count: number;
  summary: string;
  cover_asset_id: string | null;
  cover_url: string | null;
  author_name: string;
  published_at: Date;
  last_published_at: Date;
}
/**
 * 裁剪文章正文等大字段，生成列表摘要。
 *
 * @param content 待处理的正文内容。
 * @returns 整理后的文本或标识。
 */
export function articleSummary(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/[#>*_`~\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
/**
 * 收集正文和封面实际引用的资源标识。
 *
 * @param content 待处理的正文内容。
 * @returns 整理后的字符串列表。
 */
export function referencedAssets(content: ArticleContent): string[] {
  const ids = new Set<string>();
  for (const match of JSON.stringify([
    content.content,
    content.editor_content,
  ]).matchAll(/\/assets\/([a-zA-Z0-9_-]+)\/content/g))
    ids.add(match[1]!);
  if (content.cover_asset_id) ids.add(content.cover_asset_id);
  return [...ids];
}
