/**
 * @file 文章存储。维护草稿与发布快照，串行处理同一文章的写入和索引版本切换。
 */
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
import { articleInKnowledge } from "./article.types.js";
import { ArticleInteractionsRepository } from './article-interactions.repository.js';

@Injectable()
export class ArticleRepository {
  readonly records = new Map<string, ArticleDraft>();
  readonly publishedVersions = new Map<string, number>();
  private readonly memoryWrites = new Map<string, Promise<unknown>>();
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param database 共享数据库服务。
   */
  constructor(readonly database: DatabaseService) {}

  /**
   * 按标识读取文章草稿。
   *
   * @param id 目标记录的唯一标识。
   * @param manager 当前数据库事务执行器（可选）。
   * @param lock 是否在当前事务中锁定读取到的记录。
   * @returns 文章草稿记录；未找到或不可用时可能为空。
   */
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
  /**
   * 读取记录并确认当前用户是所有者。
   *
   * @param id 目标记录的唯一标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param manager 当前数据库事务执行器（可选）。
   * @param lock 是否在当前事务中锁定读取到的记录。
   * @returns 文章草稿记录。
   */
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
  /**
   * 保存文章草稿的当前数据。
   *
   * @param record 待处理的业务记录。
   * @param manager 当前数据库事务执行器（可选）。
   */
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
  /**
   * 按查询条件读取文章草稿列表。
   *
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param page 当前页码或页面记录。
   * @param size 本次批量处理或页面读取的数量。
   * @param state 当前业务或插件状态（可选）。
   * @returns 当前页条目与符合条件的总数。
   */
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
  /**
   * 过滤不满足当前文章状态与权限要求的检索命中。
   *
   * @param hits 向量库或关键词召回得到的候选命中。
   * @returns 检索候选命中列表。
   */
  async filterHits(hits: SearchHit[]): Promise<SearchHit[]> {
    const ids = [...new Set(hits.map((h) => String(h.payload.doc_id)))];
    if (!ids.length) return hits;
    const states = new Map<string, { state: string; version: number; included: boolean }>();
    if (this.database.metadataEnabled) {
      const rows = await this.database.query<{
        article_id: string;
        state: string;
        document_version: number;
        included: string;
      }>(
        `SELECT a.article_id,a.state,d.document_version,
         COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.published_metadata,'$.include_in_knowledge')),'true') AS included
         FROM article_drafts a LEFT JOIN knowledge_documents d ON d.doc_id=a.article_id
         WHERE a.article_id IN (${ids.map(() => "?").join(",")})`,
        ids,
      );
      rows.forEach((r) =>
        states.set(r.article_id, {
          state: r.state,
          version: Number(r.document_version),
          included: r.included !== 'false',
        }),
      );
    } else
      ids.forEach((id) => {
        const r = this.records.get(id);
        if (r)
          states.set(id, {
            state: r.state,
            version: this.publishedVersions.get(id) ?? 0,
            included: articleInKnowledge(r),
          });
      });
    return hits.filter((hit) => {
      const r = states.get(String(hit.payload.doc_id));
      return (
        !r ||
        (r.state === "published" && r.included &&
          r.version === Number(hit.payload.document_version))
      );
    });
  }
  /**
   * 检查当前记录是否满足后续使用的有效性条件。
   *
   * @param id 目标记录的唯一标识。
   * @param version 本次操作对应的内容版本。
   * @returns 条件是否满足的判断结果。
   */
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
  /**
   * 按业务标识串行执行写入，避免内存路径中的并发状态覆盖。
   *
   * @param id 目标记录的唯一标识。
   * @param work 需要在受控上下文中执行的异步操作。
   * @returns T 类型的处理结果。
   */
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
  /**
   * 校验当前版本后切换生效的发布或索引状态。
   *
   * @param id 目标记录的唯一标识。
   * @param version 本次操作对应的内容版本。
   * @param activate 写入后是否立即激活该版本的索引。
   * @returns 条件是否满足的判断结果。
   */
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
            article.state !== "published" || !articleInKnowledge(article) ||
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
/**
 * 将数据库行映射为文章草稿与发布记录。
 *
 * @param row 数据库查询返回的一行数据。
 * @returns 文章草稿记录。
 */
function mapArticle(row: Record<string, unknown>): ArticleDraft {
  /**
   * 解析输入文件或存储字段，转换为文章草稿使用的数据。
   *
   * @param value 待校验或转换的值。
   * @returns 本次操作整理后的结果。
   */
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
