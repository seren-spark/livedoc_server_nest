/**
 * @file 文章生命周期。协调草稿版本、正式发布、撤回、资源清理和异步索引。
 */
import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
  Optional,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { EntityManager } from "typeorm";
import type { AccessContext } from "../common/types.js";
import { AppConfig } from "../config/app-config.js";
import { DocumentsService } from "../documents/documents.service.js";
import {
  DocumentsRepository,
  mapDocumentRow,
} from "../documents/documents.repository.js";
import {
  toIndexRequest,
  type DocumentRecord,
} from "../documents/document.types.js";
import { AssetsService } from "../documents/assets/assets.service.js";
import { IndexJobsService } from "../indexing/index-jobs.service.js";
import { VectorStoreService } from "../retrieval/vector-store.service.js";
import { AuthRepository } from "../auth/auth.repository.js";
import { ArticleRepository } from "./article.repository.js";
import {
  articleSummary,
  articleInKnowledge,
  referencedAssets,
  type ArticleDraft,
  type PublicArticle,
} from "./article.types.js";
import type { ArticleSaveDto } from "./article.dto.js";
import { ArticleInteractionsRepository } from './article-interactions.repository.js';

@Injectable()
export class ArticlesService {
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param repository ArticleRepository 依赖实例。
   * @param documents 需要筛选或处理的文档集合。
   * @param assets 当前文档关联的资源集合。
   * @param jobs 后台任务队列服务。
   * @param vectors VectorStoreService 依赖实例。
   * @param config 应用运行配置。
   * @param interactions ArticleInteractionsRepository 依赖实例（可选）。
   */
  constructor(
    private readonly repository: ArticleRepository,
    private readonly documents: DocumentsService,
    private readonly assets: AssetsService,
    private readonly jobs: IndexJobsService,
    private readonly vectors: VectorStoreService,
    private readonly config: AppConfig,
    @Optional() private readonly interactions?: ArticleInteractionsRepository,
  ) {}

  /**
   * 根据输入创建文章草稿并返回结果。
   *
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param requestedId requested 对应的唯一标识（可选）。
   * @returns 文章草稿记录。
   */
  async create(
    context: AccessContext,
    requestedId?: string,
  ): Promise<ArticleDraft> {
    const id = requestedId ?? randomUUID().replaceAll("-", "");
    const existing = await this.repository.get(id);
    if (existing) return this.repository.requireOwner(id, context);
    if (await this.documents.get(id))
      throw new ConflictException("Article ID already exists.");
    const now = new Date();
    const record: ArticleDraft = {
      article_id: id,
      space_id: context.space_id,
      owner_id: context.user_id,
      state: "draft",
      draft_version: 1,
      draft: {
        title: "",
        content: "",
        editor_content: null,
        summary: "",
        tags: [],
        cover_asset_id: null,
        asset_ids: [],
      },
      published_draft_version: null,
      published_metadata: null,
      published_at: null,
      last_published_at: null,
      created_at: now,
      updated_at: now,
    };
    // INSERT (rather than upsert) keeps concurrent creation from replacing another author's draft.
    if (this.repository.database.metadataEnabled) {
      try {
        await this.repository.database.query(
          `INSERT INTO article_drafts
          (article_id,space_id,owner_id,state,draft_version,draft,created_at,updated_at) VALUES (?,?,?,'draft',1,?,?,?)`,
          [
            id,
            context.space_id,
            context.user_id,
            JSON.stringify(record.draft),
            now,
            now,
          ],
        );
      } catch (error) {
        if ((error as { code?: string }).code !== "ER_DUP_ENTRY") throw error;
        return this.repository.requireOwner(id, context);
      }
    } else await this.repository.save(record);
    return record;
  }

  /**
   * 读取并返回当前用户有权编辑的文章。
   *
   * @param id 目标记录的唯一标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 时间对象列表；未找到或不可用时可能为空。
   */
  async own(id: string, context: AccessContext) {
    const article = await this.repository.requireOwner(id, context);
    const document = await this.documents.get(id);
    const included = articleInKnowledge(article);
    return {
      ...article,
      include_in_knowledge: included,
      index_status: included ? document?.index_status ?? null : null,
      index_error: included ? document?.index_error ?? null : null,
      latest_index_job_id: included ? document?.latest_index_job_id ?? null : null,
      document_version: document?.document_version ?? null,
      assets: (await this.assets.list({ doc_id: id })).map((a) => ({
        asset_id: a.asset_id,
        content_url: a.content_url,
        filename: a.filename,
      })),
    };
  }

  /**
   * 保存文章草稿的当前数据。
   *
   * @param id 目标记录的唯一标识。
   * @param request 当前业务请求。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 时间对象列表；未找到或不可用时可能为空。
   */
  async save(id: string, request: ArticleSaveDto, context: AccessContext) {
    await this.repository.requireOwner(id, context);
    const draft = {
      title: request.title,
      content: request.content,
      editor_content: request.editor_content ?? null,
      summary: request.summary,
      tags: [...new Set(request.tags.map((t) => t.trim()).filter(Boolean))],
      cover_asset_id: request.cover_asset_id ?? null,
      asset_ids: request.asset_ids,
    };
    draft.asset_ids = referencedAssets(draft);
    let previousAssets: string[] = [];
    await this.write(id, context, async (article, manager) => {
      this.assertVersion(article, request.expected_version);
      for (const assetId of draft.asset_ids) {
        const asset = await this.assets.require(assetId);
        this.assets.assertOwner(asset, context);
        if (asset.doc_id !== id || asset.kind === "source")
          throw new UnprocessableEntityException(
            "Image belongs to another document.",
          );
      }
      previousAssets = [
        ...article.draft.asset_ids,
        ...(article.published_metadata?.asset_ids ?? []),
      ];
      if (JSON.stringify(article.draft) === JSON.stringify(draft)) return;
      article.draft = draft;
      article.draft_version += 1;
      article.updated_at = new Date();
      await this.repository.save(article, manager);
    });
    await this.cleanup(id, previousAssets, context);
    return this.own(id, context);
  }

  /**
   * 校验当前候选或草稿后发布，并协调对应索引状态。
   *
   * @param id 目标记录的唯一标识。
   * @param expectedVersion 调用方期望操作的内容版本。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param includeInKnowledge 发布后是否将文章纳入知识库检索（可选）。
   * @returns 时间对象列表；未找到或不可用时可能为空。
   */
  async publish(id: string, expectedVersion: number, context: AccessContext, includeInKnowledge?: boolean) {
    let previousAssets: string[] = [];
    await this.write(id, context, async (article, manager) => {
      this.assertVersion(article, expectedVersion);
      const previousChoice = articleInKnowledge(article);
      const included = includeInKnowledge ?? previousChoice;
      if (
        article.state === "published" &&
        article.published_draft_version === article.draft_version &&
        previousChoice === included
      )
        return;
      if (!article.draft.title.trim() || !article.draft.content.trim())
        throw new UnprocessableEntityException(
          "Title and content are required to publish.",
        );
      const before = await this.snapshot(id, manager);
      if (article.published_metadata && previousChoice !== included) article.draft_version += 1;
      previousAssets = [
        ...article.draft.asset_ids,
        ...(article.published_metadata?.asset_ids ?? []),
      ];
      const now = new Date();
      const doc: DocumentRecord = {
        doc_id: id,
        space_id: article.space_id,
        owner_id: article.owner_id,
        title: article.draft.title.trim(),
        content: article.draft.content,
        editor_content: article.draft.editor_content,
        tags: article.draft.tags,
        visibility: "public",
        source_type: "public_article",
        team_id: null,
        source_import_id: null,
        url: `/post/${id}`,
        document_version: (before?.document_version ?? 0) + 1,
        index_status: "pending",
        active_index_version: null,
        latest_index_job_id: null,
        chunk_count: 0,
        indexed_at: null,
        index_error: null,
        created_at: before?.created_at ?? now,
        updated_at: now,
      };
      article.state = "published";
      article.published_draft_version = article.draft_version;
      article.published_metadata = {
        include_in_knowledge: included,
        summary: article.draft.summary.trim() || articleSummary(doc.content),
        cover_asset_id: article.draft.cover_asset_id,
        asset_ids: referencedAssets(article.draft),
      };
      article.published_at ??= now;
      article.last_published_at = now;
      article.updated_at = now;
      if (manager)
        await new DocumentsRepository(this.repository.database).saveSnapshot(
          doc,
          manager,
        );
      if (included) {
        const job = await this.jobs.enqueue(toIndexRequest(doc), context, false, manager);
        doc.index_status = "queued";
        doc.latest_index_job_id = job.job_id;
      } else if (before) await this.cancelJobs(id, manager);
      await this.repository.save(article, manager);
      if (manager)
        await new DocumentsRepository(this.repository.database).saveSnapshot(
          doc,
          manager,
        );
      else {
        this.documents.setArticleSnapshot(doc);
        this.repository.publishedVersions.set(id, doc.document_version);
      }
    });
    await this.cleanup(id, previousAssets, context);
    // Correctness is enforced against MySQL at retrieval time even if Qdrant is temporarily unavailable.
    const result = await this.own(id, context);
    if (result.document_version)
      await this.vectors
        .deactivateVersionsBefore(id, result.document_version)
        .catch(() => undefined);
    return result;
  }

  /**
   * 撤回已发布内容，并使相应检索入口失效。
   *
   * @param id 目标记录的唯一标识。
   * @param expectedVersion 调用方期望操作的内容版本。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 时间对象列表；未找到或不可用时可能为空。
   */
  async withdraw(id: string, expectedVersion: number, context: AccessContext) {
    await this.write(id, context, async (article, manager) => {
      this.assertVersion(article, expectedVersion);
      if (article.state !== "published") return;
      const doc = await this.snapshot(id, manager);
      article.state = "withdrawn";
      article.draft_version += 1;
      article.updated_at = new Date();
      if (doc) {
        doc.visibility = "private";
        doc.document_version += 1;
        doc.active_index_version = null;
        doc.index_status = "pending";
        doc.latest_index_job_id = null;
        doc.updated_at = new Date();
        if (manager)
          await new DocumentsRepository(this.repository.database).saveSnapshot(
            doc,
            manager,
          );
        else {
          this.documents.setArticleSnapshot(doc);
          this.repository.publishedVersions.set(id, doc.document_version);
        }
      }
      await this.cancelJobs(id, manager);
      await this.repository.save(article, manager);
    });
    const result = await this.own(id, context);
    if (result.state === "withdrawn" && result.document_version)
      await this.vectors
        .deactivateVersionsBefore(id, result.document_version + 1)
        .catch(() => undefined);
    return result;
  }

  /**
   * 检查当前状态后重新提交失败的任务。
   *
   * @param id 目标记录的唯一标识。
   * @param expectedVersion 调用方期望操作的内容版本。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 时间对象列表；未找到或不可用时可能为空。
   */
  async retry(id: string, expectedVersion: number, context: AccessContext) {
    await this.write(id, context, async (article, manager) => {
      this.assertVersion(article, expectedVersion);
      if (article.state !== "published")
        throw new ConflictException("Publish this article before indexing it.");
      if (!articleInKnowledge(article))
        throw new ConflictException("This article is not included in the knowledge base. Enable it when publishing first.");
      const doc = await this.snapshot(id, manager);
      if (!doc) throw new NotFoundException();
      const job = await this.jobs.enqueue(
        toIndexRequest(doc),
        context,
        true,
        manager,
      );
      doc.latest_index_job_id = job.job_id;
      doc.index_status = "queued";
      if (manager)
        await new DocumentsRepository(this.repository.database).saveSnapshot(
          doc,
          manager,
        );
      else this.documents.setArticleSnapshot(doc);
    });
    return this.own(id, context);
  }

  /**
   * 读取文章正式发布快照，排除未发布草稿内容。
   *
   * @param record 当前知识文档记录。
   * @returns PublicArticle 类型的处理结果。
   */
  async publicRecord(record: DocumentRecord): Promise<PublicArticle> {
    const article = await this.repository.get(record.doc_id);
    if (article && article.state !== "published")
      throw new NotFoundException("Public article not found.");
    const metadata = article?.published_metadata;
    const identity =
      record.owner_id && this.repository.database.metadataEnabled
        ? await new AuthRepository(
            this.repository.database,
          ).findIdentityByUserId(record.owner_id)
        : null;
    return {
      ...record,
      ...(this.interactions ? await this.interactions.stats(record.doc_id) : { like_count: 0, favorite_count: 0, comment_count: 0 }),
      assets: [],
      summary: metadata?.summary ?? articleSummary(record.content),
      author_name: identity?.username ?? record.owner_id ?? "LiveDoc",
      cover_asset_id: metadata?.cover_asset_id ?? null,
      cover_url: metadata?.cover_asset_id
        ? `/public/articles/${record.doc_id}/assets/${metadata.cover_asset_id}/content`
        : null,
      published_at: article?.published_at ?? record.created_at,
      last_published_at: article?.last_published_at ?? record.created_at,
    };
  }

  /**
   * 校验图片属于有效公开文章后，返回公开可读的资源。
   *
   * @param id 目标记录的唯一标识。
   * @param assetId 图片资源标识。
   * @returns 当前步骤的处理结果。
   */
  async publicAsset(id: string, assetId: string) {
    const doc = await this.documents.getPublicArticle(id);
    const article = await this.repository.get(id);
    const references =
      article?.published_metadata?.asset_ids ??
      referencedAssets({
        title: doc.title,
        content: doc.content,
        editor_content: doc.editor_content,
        summary: "",
        tags: doc.tags,
        cover_asset_id: null,
        asset_ids: [],
      });
    const asset = await this.assets.require(assetId);
    if (
      !references.includes(assetId) ||
      asset.doc_id !== id ||
      asset.kind === "source"
    )
      throw new NotFoundException("Public image not found.");
    return asset;
  }

  /**
   * 检查请求携带的期望版本，避免覆盖其他更新。
   *
   * @param article 当前文章草稿或发布记录。
   * @param version 本次操作对应的内容版本。
   */
  private assertVersion(article: ArticleDraft, version: number) {
    if (article.draft_version !== version)
      throw new ConflictException({
        code: "ARTICLE_VERSION_CONFLICT",
        message: "Article changed in another session. Reload before saving.",
        current_version: article.draft_version,
      });
  }
  /**
   * 取消与当前内容版本相关的后台任务。
   *
   * @param id 目标记录的唯一标识。
   * @param manager 当前数据库事务执行器（可选）。
   */
  private async cancelJobs(id: string, manager?: EntityManager) {
    if (manager) await manager.query(
      `UPDATE index_jobs SET status='canceled',dedupe_key=NULL,worker_id=NULL,lease_expires_at=NULL,
       finished_at=?,updated_at=? WHERE doc_id=? AND status IN ('queued','running','retry_wait')`,
      [new Date(), new Date(), id],
    );
    else await this.jobs.cancelDocument(id);
  }
  /**
   * 清理已结束或过期操作留下的资源。
   *
   * @param id 目标记录的唯一标识。
   * @param candidates 待筛选的候选集合。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   */
  private async cleanup(
    id: string,
    candidates: string[],
    context: AccessContext,
  ) {
    if (!candidates.length) return;
    // Recheck both references under the publication lock. Never delete a newly uploaded,
    // not-yet-saved image: another editor request may still be attaching it.
    try {
      await this.write(id, context, async (article) => {
        const keep = new Set([
          ...article.draft.asset_ids,
          ...(article.published_metadata?.asset_ids ?? []),
        ]);
        await this.assets.removeIds(
          [...new Set(candidates)].filter((assetId) => !keep.has(assetId)),
          context,
        );
      });
    } catch (error) {
      console.warn(
        "Article asset cleanup deferred:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  /**
   * 读取文章对应的知识文档快照；事务路径中同时锁定该记录。
   *
   * @param id 目标记录的唯一标识。
   * @param manager 当前数据库事务执行器（可选）。
   * @returns 知识文档记录；未找到或不可用时可能为空。
   */
  private async snapshot(id: string, manager?: EntityManager) {
    if (!manager) return this.documents.get(id);
    const rows = await manager.query(
      "SELECT * FROM knowledge_documents WHERE doc_id=? FOR UPDATE",
      [id],
    );
    return rows[0] ? mapDocumentRow(rows[0]) : null;
  }
  /**
   * 在事务或按文章串行的内存写入中校验归属，执行一次文章状态变更。
   *
   * @param id 目标记录的唯一标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param work 当前数据库事务执行器。
   */
  private async write(
    id: string,
    context: AccessContext,
    work: (article: ArticleDraft, manager?: EntityManager) => Promise<void>,
  ) {
    if (this.repository.database.metadataEnabled)
      return this.repository.database.transaction(async (manager) => {
        const article = await this.repository.requireOwner(
          id,
          context,
          manager,
          true,
        );
        await work(article, manager);
      });
    return this.repository.serial(id, async () => {
      const article = structuredClone(
        await this.repository.requireOwner(id, context),
      );
      await work(article);
    });
  }
}
