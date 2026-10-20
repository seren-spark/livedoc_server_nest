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
  published_metadata: Pick<
    ArticleContent,
    "summary" | "cover_asset_id" | "asset_ids"
  > | null;
  published_at: Date | null;
  last_published_at: Date | null;
  created_at: Date;
  updated_at: Date;
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
