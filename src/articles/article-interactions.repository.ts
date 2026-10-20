import { Injectable } from "@nestjs/common";
import type { EntityManager } from "typeorm";
import { DatabaseService } from "../database/database.service.js";
import { mapDocumentRow } from "../documents/documents.repository.js";

export type ReactionKind = "like" | "favorite";
export interface ArticleStats {
  like_count: number;
  favorite_count: number;
  comment_count: number;
}
export interface ArticleComment {
  comment_id: string;
  article_id: string;
  user_id: string;
  content: string;
  created_at: Date;
  parent_comment_id: string | null;
  deleted_at: Date | null;
}
@Injectable()
export class ArticleInteractionsRepository {
  readonly comments = new Map<string, ArticleComment>();
  readonly reactions = new Map<
    string,
    {
      article_id: string;
      user_id: string;
      kind: ReactionKind;
      created_at: Date;
    }
  >();
  constructor(readonly database: DatabaseService) {}

  async stats(id: string): Promise<ArticleStats> {
    if (!this.database.metadataEnabled) {
      const reactions = [...this.reactions.values()].filter(
        (r) => r.article_id === id,
      );
      return {
        like_count: reactions.filter((r) => r.kind === "like").length,
        favorite_count: reactions.filter((r) => r.kind === "favorite").length,
        comment_count: [...this.comments.values()].filter(
          (c) => c.article_id === id && !c.deleted_at,
        ).length,
      };
    }
    const reactions = await this.database.query<{
      like_count: number;
      favorite_count: number;
    }>(
      `SELECT SUM(kind='like') like_count,SUM(kind='favorite') favorite_count FROM article_reactions WHERE article_id=?`,
      [id],
    );
    const comments = await this.database.query<{ total: number }>(
      "SELECT COUNT(*) total FROM article_comments WHERE article_id=? AND deleted_at IS NULL",
      [id],
    );
    return {
      like_count: Number(reactions[0]?.like_count ?? 0),
      favorite_count: Number(reactions[0]?.favorite_count ?? 0),
      comment_count: Number(comments[0]?.total ?? 0),
    };
  }
  async mine(id: string, userId: string) {
    const rows = this.database.metadataEnabled
      ? await this.database.query<{ kind: string }>(
          "SELECT kind FROM article_reactions WHERE article_id=? AND user_id=?",
          [id, userId],
        )
      : [...this.reactions.values()].filter(
          (r) => r.article_id === id && r.user_id === userId,
        );
    return {
      user_id: userId,
      liked: rows.some((r) => r.kind === "like"),
      favorited: rows.some((r) => r.kind === "favorite"),
    };
  }
  async react(
    id: string,
    userId: string,
    kind: ReactionKind,
    active: boolean,
    manager?: EntityManager,
  ) {
    if (this.database.metadataEnabled) {
      if (active)
        await (manager ?? this.database).query(
          "INSERT IGNORE INTO article_reactions (article_id,user_id,kind,created_at) VALUES (?,?,?,?)",
          [id, userId, kind, new Date()],
        );
      else
        await (manager ?? this.database).query(
          "DELETE FROM article_reactions WHERE article_id=? AND user_id=? AND kind=?",
          [id, userId, kind],
        );
    } else {
      const key = JSON.stringify([id, userId, kind]);
      if (active && !this.reactions.has(key))
        this.reactions.set(key, {
          article_id: id,
          user_id: userId,
          kind,
          created_at: new Date(),
        });
      if (!active) this.reactions.delete(key);
    }
  }
  async comment(
    id: string,
    manager?: EntityManager,
  ): Promise<ArticleComment | null> {
    if (!this.database.metadataEnabled) return this.comments.get(id) ?? null;
    const rows = (await (manager ?? this.database).query(
      "SELECT * FROM article_comments WHERE comment_id=?",
      [id],
    )) as ArticleComment[];
    return rows[0]
      ? { ...rows[0], created_at: new Date(rows[0].created_at) }
      : null;
  }
  async addComment(comment: ArticleComment, manager?: EntityManager) {
    if (this.database.metadataEnabled)
      await (manager ?? this.database).query(
        "INSERT INTO article_comments (comment_id,article_id,user_id,content,created_at,parent_comment_id) VALUES (?,?,?,?,?,?)",
        [
          comment.comment_id,
          comment.article_id,
          comment.user_id,
          comment.content,
          comment.created_at,
          comment.parent_comment_id,
        ],
      );
    else this.comments.set(comment.comment_id, comment);
  }
  async removeComment(id: string, manager?: EntityManager) {
    if (this.database.metadataEnabled)
      await (manager ?? this.database).query(
        "UPDATE article_comments SET content='',deleted_at=? WHERE comment_id=?",
        [new Date(), id],
      );
    else {
      const comment = this.comments.get(id);
      if (comment)
        this.comments.set(id, {
          ...comment,
          content: "",
          deleted_at: new Date(),
        });
    }
  }
  async deleteForArticle(id: string, manager?: EntityManager) {
    if (this.database.metadataEnabled) {
      await (manager ?? this.database).query(
        "DELETE FROM article_comments WHERE article_id=?",
        [id],
      );
      await (manager ?? this.database).query(
        "DELETE FROM article_reactions WHERE article_id=?",
        [id],
      );
    } else {
      for (const [key, comment] of this.comments)
        if (comment.article_id === id) this.comments.delete(key);
      for (const [key, reaction] of this.reactions)
        if (reaction.article_id === id) this.reactions.delete(key);
    }
  }
  async replyCount(id: string) {
    if (!this.database.metadataEnabled)
      return [...this.comments.values()].filter(
        (c) => c.parent_comment_id === id && !c.deleted_at,
      ).length;
    const rows = await this.database.query<{ total: number }>(
      "SELECT COUNT(*) total FROM article_comments WHERE parent_comment_id=? AND deleted_at IS NULL",
      [id],
    );
    return Number(rows[0]?.total ?? 0);
  }
  async listComments(
    id: string,
    page: number,
    size: number,
    parentId: string | null = null,
  ) {
    if (!this.database.metadataEnabled) {
      const comments = [...this.comments.values()]
        .filter(
          (c) =>
            c.article_id === id &&
            c.parent_comment_id === parentId &&
            (!c.deleted_at ||
              (parentId === null &&
                [...this.comments.values()].some(
                  (r) => r.parent_comment_id === c.comment_id && !r.deleted_at,
                ))),
        )
        .sort(
          (a, b) =>
            (parentId ? 1 : -1) *
            (a.created_at.getTime() - b.created_at.getTime() ||
              a.comment_id.localeCompare(b.comment_id)),
        );
      return {
        items: comments.slice((page - 1) * size, page * size),
        total: comments.length,
      };
    }
    const where = parentId
      ? "c.article_id=? AND c.parent_comment_id=? AND c.deleted_at IS NULL"
      : "c.article_id=? AND c.parent_comment_id IS NULL AND (c.deleted_at IS NULL OR EXISTS (SELECT 1 FROM article_comments r WHERE r.parent_comment_id=c.comment_id AND r.deleted_at IS NULL))";
    const params = parentId ? [id, parentId] : [id];
    const count = await this.database.query<{ total: number }>(
      `SELECT COUNT(*) total FROM article_comments c WHERE ${where}`,
      params,
    );
    const order = parentId ? "ASC" : "DESC";
    const rows = await this.database.query<ArticleComment>(
      `SELECT c.* FROM article_comments c WHERE ${where} ORDER BY c.created_at ${order},c.comment_id ${order} LIMIT ? OFFSET ?`,
      [...params, size, (page - 1) * size],
    );
    return {
      items: rows.map((r) => ({ ...r, created_at: new Date(r.created_at) })),
      total: Number(count[0]?.total ?? 0),
    };
  }
  async favorites(userId: string, page: number, size: number) {
    const where = `r.user_id=? AND r.kind='favorite' AND d.visibility='public' AND d.source_type IN ('article','public_article')
      AND NOT EXISTS (SELECT 1 FROM article_drafts a WHERE a.article_id=d.doc_id AND a.state<>'published')`;
    const count = await this.database.query<{ total: number }>(
      `SELECT COUNT(*) total FROM article_reactions r JOIN knowledge_documents d ON d.doc_id=r.article_id WHERE ${where}`,
      [userId],
    );
    const rows = await this.database.query(
      `SELECT d.* FROM article_reactions r JOIN knowledge_documents d ON d.doc_id=r.article_id
      WHERE ${where} ORDER BY r.created_at DESC,r.article_id DESC LIMIT ? OFFSET ?`,
      [userId, size, (page - 1) * size],
    );
    return {
      items: rows.map(mapDocumentRow),
      total: Number(count[0]?.total ?? 0),
    };
  }
}
