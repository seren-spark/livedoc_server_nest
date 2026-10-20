import {
  Global,
  Injectable,
  Module,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import type { EntityManager } from "typeorm";
import { DatabaseService } from "../database/database.service.js";
import type { AccessContext } from "../common/types.js";
import type { SearchHit } from "../retrieval/vector-store.service.js";
import type { ArticleDraft, ArticleState } from "./article.types.js";
import { ArticleInteractionsRepository } from './article-interactions.repository.js';

@Injectable()
export class ArticleRepository {
  readonly records = new Map<string, ArticleDraft>();
  readonly publishedVersions = new Map<string, number>();
  private readonly memoryWrites = new Map<string, Promise<unknown>>();
  constructor(readonly database: DatabaseService) {}

  async get(
    id: string,
    manager?: EntityManager,
    lock = false,
  ): Promise<ArticleDraft | null> {
    if (!this.database.metadataEnabled) return this.records.get(id) ?? null;
    const rows = (await (manager ?? this.database).query(
      `SELECT * FROM article_drafts WHERE article_id=?${lock ? " FOR UPDATE" : ""}`,
      [id],
    )) as Record<string, unknown>[];
    return rows[0] ? mapArticle(rows[0]) : null;
  }
  async requireOwner(
    id: string,
    context: AccessContext,
    manager?: EntityManager,
    lock = false,
  ): Promise<ArticleDraft> {
    const record = await this.get(id, manager, lock);
    if (!record) throw new NotFoundException("Article draft not found.");
    if (
      record.owner_id !== context.user_id ||
      record.space_id !== context.space_id
    )
      throw new ForbiddenException("Article belongs to another author.");
    return record;
  }
  async save(record: ArticleDraft, manager?: EntityManager): Promise<void> {
    if (!this.database.metadataEnabled) {
      this.records.set(record.article_id, structuredClone(record));
      return;
    }
    await (manager ?? this.database).query(
      `INSERT INTO article_drafts
      (article_id,space_id,owner_id,state,draft_version,draft,published_draft_version,published_metadata,published_at,last_published_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE state=VALUES(state),draft_version=VALUES(draft_version),
      draft=VALUES(draft),published_draft_version=VALUES(published_draft_version),published_metadata=VALUES(published_metadata),
      published_at=VALUES(published_at),last_published_at=VALUES(last_published_at),updated_at=VALUES(updated_at)`,
      [
        record.article_id,
        record.space_id,
        record.owner_id,
        record.state,
        record.draft_version,
        JSON.stringify(record.draft),
        record.published_draft_version,
        record.published_metadata
          ? JSON.stringify(record.published_metadata)
          : null,
        record.published_at,
        record.last_published_at,
        record.created_at,
        record.updated_at,
      ],
    );
  }
  async list(
    context: AccessContext,
    page: number,
    size: number,
    state?: ArticleState,
  ) {
    if (!this.database.metadataEnabled) {
      const items = [...this.records.values()]
        .filter(
          (r) =>
            r.owner_id === context.user_id &&
            r.space_id === context.space_id &&
            (!state || r.state === state),
        )
        .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime());
      return {
        items: items.slice((page - 1) * size, page * size),
        total: items.length,
      };
    }
    const where = `space_id=? AND owner_id=?${state ? " AND state=?" : ""}`;
    const params = [
      context.space_id,
      context.user_id,
      ...(state ? [state] : []),
    ];
    const count = await this.database.query<{ total: number }>(
      `SELECT COUNT(*) total FROM article_drafts WHERE ${where}`,
      params,
    );
    const rows = await this.database.query(
      `SELECT * FROM article_drafts WHERE ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      [...params, size, (page - 1) * size],
    );
    return { items: rows.map(mapArticle), total: Number(count[0]?.total ?? 0) };
  }
  async filterHits(hits: SearchHit[]): Promise<SearchHit[]> {
    const ids = [...new Set(hits.map((h) => String(h.payload.doc_id)))];
    if (!ids.length) return hits;
    const states = new Map<string, { state: string; version: number }>();
    if (this.database.metadataEnabled) {
      const rows = await this.database.query<{
        article_id: string;
        state: string;
        document_version: number;
      }>(
        `SELECT a.article_id,a.state,d.document_version FROM article_drafts a LEFT JOIN knowledge_documents d ON d.doc_id=a.article_id
         WHERE a.article_id IN (${ids.map(() => "?").join(",")})`,
        ids,
      );
      rows.forEach((r) =>
        states.set(r.article_id, {
          state: r.state,
          version: Number(r.document_version),
        }),
      );
    } else
      ids.forEach((id) => {
        const r = this.records.get(id);
        if (r)
          states.set(id, {
            state: r.state,
            version: this.publishedVersions.get(id) ?? 0,
          });
      });
    return hits.filter((hit) => {
      const r = states.get(String(hit.payload.doc_id));
      return (
        !r ||
        (r.state === "published" &&
          r.version === Number(hit.payload.document_version))
      );
    });
  }
  async eligible(id: string, version: number): Promise<boolean> {
    return (
      (
        await this.filterHits([
          {
            pointId: "",
            score: 0,
            payload: { doc_id: id, document_version: version },
          },
        ])
      ).length > 0
    );
  }
  async serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const next = (this.memoryWrites.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(work);
    this.memoryWrites.set(id, next);
    try {
      return await next;
    } finally {
      if (this.memoryWrites.get(id) === next) this.memoryWrites.delete(id);
    }
  }
  async activateCurrent(
    id: string,
    version: number,
    activate: () => Promise<void>,
  ): Promise<boolean> {
    if (this.database.metadataEnabled)
      return this.database.transaction(async (manager) => {
        const article = await this.get(id, manager, true);
        if (article) {
          const rows = await manager.query(
            "SELECT document_version FROM knowledge_documents WHERE doc_id=?",
            [id],
          );
          if (
            article.state !== "published" ||
            Number(rows[0]?.document_version) !== version
          )
            return false;
        }
        await activate();
        return true;
      });
    return this.serial(id, async () => {
      if (!(await this.eligible(id, version))) return false;
      await activate();
      return true;
    });
  }
}
function mapArticle(row: Record<string, unknown>): ArticleDraft {
  const parse = (value: unknown) =>
    typeof value === "string" ? JSON.parse(value) : value;
  return {
    ...row,
    draft: parse(row.draft),
    published_metadata: parse(row.published_metadata),
    draft_version: Number(row.draft_version),
    published_draft_version:
      row.published_draft_version == null
        ? null
        : Number(row.published_draft_version),
    published_at: row.published_at
      ? new Date(row.published_at as string)
      : null,
    last_published_at: row.last_published_at
      ? new Date(row.last_published_at as string)
      : null,
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
  } as ArticleDraft;
}
@Global()
@Module({ providers: [ArticleRepository, ArticleInteractionsRepository], exports: [ArticleRepository, ArticleInteractionsRepository] })
export class ArticleStorageModule {}
