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
  referencedAssets,
  type ArticleDraft,
  type PublicArticle,
} from "./article.types.js";
import type { ArticleSaveDto } from "./article.dto.js";
import { ArticleInteractionsRepository } from './article-interactions.repository.js';

@Injectable()
export class ArticlesService {
  constructor(
    private readonly repository: ArticleRepository,
    private readonly documents: DocumentsService,
    private readonly assets: AssetsService,
    private readonly jobs: IndexJobsService,
    private readonly vectors: VectorStoreService,
    private readonly config: AppConfig,
    @Optional() private readonly interactions?: ArticleInteractionsRepository,
  ) {}

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

  async own(id: string, context: AccessContext) {
    const article = await this.repository.requireOwner(id, context);
    const document = await this.documents.get(id);
    return {
      ...article,
      index_status: document?.index_status ?? null,
      index_error: document?.index_error ?? null,
      latest_index_job_id: document?.latest_index_job_id ?? null,
      document_version: document?.document_version ?? null,
      assets: (await this.assets.list({ doc_id: id })).map((a) => ({
        asset_id: a.asset_id,
        content_url: a.content_url,
        filename: a.filename,
      })),
    };
  }

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

  async publish(id: string, expectedVersion: number, context: AccessContext) {
    let previousAssets: string[] = [];
    await this.write(id, context, async (article, manager) => {
      this.assertVersion(article, expectedVersion);
      if (
        article.state === "published" &&
        article.published_draft_version === article.draft_version
      )
        return;
      if (!article.draft.title.trim() || !article.draft.content.trim())
        throw new UnprocessableEntityException(
          "Title and content are required to publish.",
        );
      const before = await this.snapshot(id, manager);
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
      const job = await this.jobs.enqueue(
        toIndexRequest(doc),
        context,
        false,
        manager,
      );
      doc.index_status = "queued";
      doc.latest_index_job_id = job.job_id;
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
      if (manager)
        await manager.query(
          `UPDATE index_jobs SET status='canceled',dedupe_key=NULL,worker_id=NULL,lease_expires_at=NULL,
        finished_at=?,updated_at=? WHERE doc_id=? AND status IN ('queued','running','retry_wait')`,
          [new Date(), new Date(), id],
        );
      else await this.jobs.cancelDocument(id);
      await this.repository.save(article, manager);
    });
    const result = await this.own(id, context);
    if (result.state === "withdrawn" && result.document_version)
      await this.vectors
        .deactivateVersionsBefore(id, result.document_version + 1)
        .catch(() => undefined);
    return result;
  }

  async retry(id: string, expectedVersion: number, context: AccessContext) {
    await this.write(id, context, async (article, manager) => {
      this.assertVersion(article, expectedVersion);
      if (article.state !== "published")
        throw new ConflictException("Publish this article before indexing it.");
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

  private assertVersion(article: ArticleDraft, version: number) {
    if (article.draft_version !== version)
      throw new ConflictException({
        code: "ARTICLE_VERSION_CONFLICT",
        message: "Article changed in another session. Reload before saving.",
        current_version: article.draft_version,
      });
  }
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
  private async snapshot(id: string, manager?: EntityManager) {
    if (!manager) return this.documents.get(id);
    const rows = await manager.query(
      "SELECT * FROM knowledge_documents WHERE doc_id=? FOR UPDATE",
      [id],
    );
    return rows[0] ? mapDocumentRow(rows[0]) : null;
  }
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
