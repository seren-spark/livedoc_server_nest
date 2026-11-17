/**
 * @file 知识文档接口。提供文档查询与修改入口，并协调资源、索引和演示数据。
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { CurrentAccess } from "../auth/access-context.decorator.js";
import {
  DocumentCreateDto,
  DocumentUpdateDto,
  PaginationQueryDto,
} from "../common/dto.js";
import type { AccessContext } from "../common/types.js";
import { AppConfig } from "../config/app-config.js";
import { Public } from "../auth/public.decorator.js";
import { IndexJobsService } from "../indexing/index-jobs.service.js";
import { jobResponse } from "../indexing/index-job.types.js";
import { VectorStoreService } from "../retrieval/vector-store.service.js";
import { DEMO_DOCUMENTS, isDemoDocumentVisibleTo } from "./demo-data.js";
import { DocumentsService } from "./documents.service.js";
import { toIndexRequest } from "./document.types.js";
import { AssetsService } from "./assets/assets.service.js";
import { publicAsset } from "./assets/asset.types.js";
import { DocumentMemoryJobsService } from "./document-memory/document-memory-jobs.service.js";
import { DocumentMemoryService } from "./document-memory/document-memory.service.js";
import { ConversationMemoryService } from "../ai/memory.service.js";
import { ArticlesService } from '../articles/articles.service.js';
import { WorkspaceService } from '../workspace/workspace.service.js';

@Controller()
export class DocumentsController {
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param config 应用运行配置。
   * @param documents 需要筛选或处理的文档集合。
   * @param jobs 后台任务队列服务。
   * @param store VectorStoreService 依赖实例。
   * @param assets 当前文档关联的资源集合。
   * @param memoryJobs DocumentMemoryJobsService 依赖实例。
   * @param documentMemory DocumentMemoryService 依赖实例。
   * @param conversationMemory ConversationMemoryService 依赖实例。
   * @param articles ArticlesService 依赖实例。
   * @param workspace WorkspaceService 依赖实例。
   */
  constructor(
    private readonly config: AppConfig,
    private readonly documents: DocumentsService,
    private readonly jobs: IndexJobsService,
    private readonly store: VectorStoreService,
    private readonly assets: AssetsService,
    private readonly memoryJobs: DocumentMemoryJobsService,
    private readonly documentMemory: DocumentMemoryService,
    private readonly conversationMemory: ConversationMemoryService,
    private readonly articles: ArticlesService,
    private readonly workspace: WorkspaceService,
  ) {}

  // 创建知识文档：保存正文 + 按需发起异步索引任务
  // ① 调 Service.create 把正文与权限写入 MySQL（或内存退路），此时 document_version=1、index_status=pending
  // ② index_now=false 时仅保存为"待索引"，返回 201 Created，不进入索引队列
  // ③ index_now=true（默认）时调 jobs.enqueue 把任务推入 index_jobs 队列，去重 key 为 doc_id:version
  // ④ 调 markQueued 把文档 index_status 从 pending 改为 queued，并记录 latest_index_job_id
  // ⑤ 返回 202 Accepted 表示请求已受理，但向量索引尚未完成，前端应继续轮询状态变化
  /**
   * 根据输入创建知识文档并返回结果。
   *
   * @param request 当前业务请求。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param reply 用于写回 HTTP 或 SSE 数据的响应对象。
   * @returns 时间对象列表；未找到或不可用时可能为空。
   */
  @Post("documents")
  async create(
    @Body() request: DocumentCreateDto,
    // 认证层注入 user_id、space_id、team_ids，而不是相信客户端自报。
    @CurrentAccess() context: AccessContext,
    //允许设置 201/202，同时仍由 Nest 序列化返回对象。
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    // 先保存正文与权限字段，得到 version=1、status=pending 的记录。
    const record = await this.documents.create(request, context);
    //创建一条"文档记忆"任务,形成该文档的"记忆档案"。
    await this.queueDocumentMemory(record, context);
    // 把前端白名单中的资产关联到服务端生成的 doc_id。
    await this.assets.link(request.asset_ids ?? [], record.doc_id, context);
    // 调用方明确要求不索引时走同步保存分支。
    if (!request.index_now) {
      // 201 表示只创建了知识文档。
      reply.status(HttpStatus.CREATED);
      // 返回文档及其公开资产，不创建 IndexJob。
      return this.withAssets(record);
    }
    // 把当前 version 的文档固化成 Worker 可独立消费的任务快照。
    const job = await this.jobs.enqueue(toIndexRequest(record), context);
    // 记录 queued 状态和 latest_index_job_id。
    await this.documents.markQueued(record.doc_id, job.job_id);
    // 202 表示索引任务已接收，但尚未完成。
    reply.status(HttpStatus.ACCEPTED);
    // 重新读取 markQueued 后的最新文档，再附加资产返回。
    return this.withAssets(await this.documents.require(record.doc_id));
  }

  /**
   * 按查询条件读取知识文档列表。
   *
   * @param query 用户问题或检索查询。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 当前页条目与符合条件的总数；未找到或不可用时可能为空。
   */
  @Get("documents")
  async list(
    @Query() query: PaginationQueryDto,
    @CurrentAccess() context: AccessContext,
  ) {
    const result = await this.documents.list(
      context,
      query.page,
      query.page_size,
      {
        q: query.q,
        category_id: query.category_id,
        visibility: query.visibility,
        source_type: query.source_type,
        tag: query.tag,
        team_id: query.team_id,
        index_status: query.index_status,
      },
    );
    return {
      ...result,
      items: await Promise.all(
        result.items.map((record) => this.withAssets(record)),
      ),
      page: query.page,
      page_size: query.page_size,
    };
  }

  /**
   * 分页读取已发布且公开可见的文章。
   *
   * @param query 用户问题或检索查询。
   * @returns 当前页条目与符合条件的总数。
   */
  @Public()
  @Get("public/articles")
  async listPublicArticles(@Query() query: PaginationQueryDto) {
    const result = await this.documents.listPublicArticles(
      query.page,
      query.page_size,
      { q: query.q },
    );
    return {
      ...result,
      items: await Promise.all(
        result.items.map((record) => this.articles.publicRecord(record)),
      ),
      page: query.page,
      page_size: query.page_size,
    };
  }

  /**
   * 读取指定文章的公开发布内容。
   *
   * @param docId 知识文档标识。
   * @returns import("E:/LiveDoc/livedoc_server_nest/src/articles/article.types").PublicArticle 类型的处理结果。
   */
  @Public()
  @Get("public/articles/:doc_id")
  async getPublicArticle(@Param("doc_id") docId: string) {
    return this.articles.publicRecord(await this.documents.getPublicArticle(docId));
  }

  /**
   * 按标识读取知识文档。
   *
   * @param docId 知识文档标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 时间对象列表；未找到或不可用时可能为空。
   */
  @Get("documents/:doc_id")
  async get(
    @Param("doc_id") docId: string,
    @CurrentAccess() context: AccessContext,
  ) {
    return this.withAssets(await this.documents.getAccessible(docId, context));
  }

  // 更新文档：只更新正文，不自动入队索引任务
  // ① 先 getAccessible 校验当前用户对该文档的写权限
  // ② Service.update 内部会判断 title/content/visibility/source_type/tags/team_id/url 是否变化，
  //    任一变化都会让 document_version +1 并把 index_status 重置为 pending
  // ③ 若 visibility 或 team_id 变化（即访问范围改变），需要 deactivateDocument 让旧索引立即失活，
  //    避免基于旧权限的向量数据被新权限的用户读到；其他字段变化不会主动重建索引
  // ④ 要重建索引必须由前端单独调 POST /documents/:doc_id/reindex
  /**
   * 根据请求更新知识文档。
   *
   * @param docId 知识文档标识。
   * @param request 当前业务请求。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 时间对象列表；未找到或不可用时可能为空。
   */
  @Patch("documents/:doc_id")
  async update(
    @Param("doc_id") docId: string,
    @Body() request: DocumentUpdateDto,
    @CurrentAccess() context: AccessContext,
  ) {
    const before = await this.documents.getWritable(docId, context);
    const updated = await this.documents.update(docId, request, context);
    if (before.content !== updated.content)
      await this.queueDocumentMemory(updated, context);
    if (request.asset_ids) {
      await this.assets.link(request.asset_ids, docId, context);
      await this.assets.reconcileDocument(docId, request.asset_ids, context);
    }
    if (
      before.visibility !== updated.visibility ||
      before.team_id !== updated.team_id
    )
      await this.store.deactivateDocument(docId);
    return this.withAssets(updated);
  }

  /**
   * 私有文档移入回收站；其他可写文档则清理任务、向量和资源后删除。
   *
   * @param docId 知识文档标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的状态与操作结果对象。
   */
  @Delete("documents/:doc_id")
  async delete(
    @Param("doc_id") docId: string,
    @CurrentAccess() context: AccessContext,
  ) {
    const record=await this.documents.get(docId);
    if (record?.visibility==='private') return {status:'trashed',doc_id:docId,...await this.workspace.trashDocumentById(context,docId)};
    await this.documents.getWritable(docId, context);
    await this.jobs.cancelDocument(docId);
    await this.store.deleteDocument(docId);
    await this.assets.removeWhere({ doc_id: docId });
    await this.memoryJobs.cancelDocument(docId);
    await this.conversationMemory.deleteDocument(docId);
    await this.documentMemory.deleteDocument(docId);
    await this.memoryJobs.deleteDocument(docId);
    await this.documents.delete(docId, context);
    return { status: "deleted", doc_id: docId };
  }

  // 重建索引：手动触发对当前正文版本的异步索引任务
  // ① getAccessible 校验写权限，并取出当前 document_version
  // ② enqueue 第三个参数 true 表示 _force，但当前 enqueue 实现里该参数下划线前缀表示未使用，
  //    实际仍走 activeFor 去重逻辑：同 doc 同 version 若已有活跃任务则直接返回旧任务
  // ③ markQueued 把 index_status 改为 queued，让前端轮询能反映"再次排队"状态
  // ④ @HttpCode 固定返回 202 Accepted，返回体是 jobResponse 而非文档对象，便于前端展示 job_id
  /**
   * 重建索引：手动触发对当前正文版本的异步索引任务
   *
   * @param docId 知识文档标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 时间对象；未找到或不可用时可能为空。
   */
  @Post("documents/:doc_id/reindex")
  @HttpCode(HttpStatus.ACCEPTED)
  async reindex(
    @Param("doc_id") docId: string,
    @CurrentAccess() context: AccessContext,
  ) {
    const record = await this.documents.getWritable(docId, context);
    const assets = await this.assets.list({ doc_id: docId });
    const job = await this.jobs.enqueue(
      {
        ...toIndexRequest(record),
        content: buildIndexContent(record.content, assets),
      },
      context,
      true,
    );
    await this.documents.markQueued(record.doc_id, job.job_id);
    return jobResponse(job);
  }

  /**
   * 写入本地演示使用的知识文档。
   *
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的状态与操作结果对象；未找到或不可用时可能为空。
   */
  @Post("dev/seed")
  @HttpCode(HttpStatus.OK)
  async seed(@CurrentAccess() context: AccessContext) {
    if (this.config.appEnv === "production")
      throw new HttpException("Not found.", HttpStatus.NOT_FOUND);
    const seeded: Array<{
      doc_id: string;
      title: string;
      action: "created" | "updated" | "unchanged";
      index_status: string;
      job_id: string | null;
    }> = [];
    for (const document of DEMO_DOCUMENTS) {
      if (!isDemoDocumentVisibleTo(document, context)) continue;
      let record = await this.documents.get(document.doc_id);
      let action: "created" | "updated" | "unchanged" = "unchanged";
      if (!record) {
        const seedContext: AccessContext = {
          user_id: document.owner_id ?? context.user_id,
          space_id: document.space_id,
          team_ids: document.team_id ? [document.team_id] : [],
        };
        record = await this.documents.create(
          Object.assign(new DocumentCreateDto(), {
            doc_id: document.doc_id,
            title: document.title,
            content: document.content,
            visibility: document.visibility,
            source_type: document.source_type,
            tags: document.tags,
            team_id: document.team_id,
            url: document.url,
            index_now: false,
          }),
          seedContext,
        );
        action = "created";
      } else if (demoDocumentChanged(record, document)) {
        const seedContext: AccessContext = {
          user_id: record.owner_id ?? context.user_id,
          space_id: record.space_id,
          team_ids: record.team_id ? [record.team_id] : [],
        };
        record = await this.documents.update(
          record.doc_id,
          Object.assign(new DocumentUpdateDto(), {
            expected_version: record.document_version,
            title: document.title,
            content: document.content,
            visibility: document.visibility,
            source_type: document.source_type,
            tags: document.tags,
            team_id: document.team_id,
            url: document.url,
          }),
          seedContext,
        );
        action = "updated";
      }
      if (action !== "unchanged")
        await this.queueDocumentMemory(record, context);
      let jobId: string | null = null;
      if (
        action !== "unchanged" ||
        record.index_status !== "ready" ||
        record.active_index_version !== record.document_version
      ) {
        const job = await this.jobs.enqueue(
          toIndexRequest(record),
          context,
          true,
        );
        await this.documents.markQueued(record.doc_id, job.job_id);
        jobId = job.job_id;
      }
      seeded.push({
        doc_id: record.doc_id,
        title: record.title,
        action,
        index_status: jobId ? "queued" : record.index_status,
        job_id: jobId,
      });
    }
    return { status: "seeded", documents: seeded };
  }

  /**
   * 为业务记录补充已关联的图片资源信息。
   *
   * @param record 待处理的业务记录。
   * @returns 时间对象列表；未找到或不可用时可能为空。
   */
  private async withAssets(
    record: Awaited<ReturnType<DocumentsService["require"]>>,
  ) {
    return {
      ...record,
      assets: (await this.assets.list({ doc_id: record.doc_id })).map(
        publicAsset,
      ),
    };
  }

  /**
   * 队列文档记忆提取
   * @param record 文档记录
   * @param context 访问上下文
   */
  private async queueDocumentMemory(
    record: Awaited<ReturnType<DocumentsService["require"]>>,
    context: AccessContext,
  ): Promise<void> {
    if (!this.config.documentMemoryEnabled || !record.content.trim()) return;
    try {
      //把文档记录写入 document_memory_jobs 表，按 doc_id:document_version 去重，旧版本任务标记为 superseded
      await this.memoryJobs.enqueue(record, context);
    } catch (error) {
      await this.documentMemory.markPending(record);
      await this.documentMemory.markFailed(
        record.doc_id,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

/**
 * 判断演示文档内容或元数据是否已经变化。
 *
 * @param record 待处理的业务记录。
 * @param document 当前知识文档记录。
 * @returns 条件是否满足的判断结果。
 */
function demoDocumentChanged(
  record: Awaited<ReturnType<DocumentsService["require"]>>,
  document: (typeof DEMO_DOCUMENTS)[number],
): boolean {
  return (
    record.title !== document.title ||
    record.content !== document.content ||
    record.visibility !== document.visibility ||
    record.source_type !== document.source_type ||
    JSON.stringify(record.tags) !== JSON.stringify(document.tags) ||
    record.team_id !== document.team_id ||
    record.url !== document.url
  );
}

/**
 * 合并正文与图片说明，构造实际用于知识检索的索引文本。
 *
 * @param content 待处理的正文内容。
 * @param assets 当前文档关联的资源集合。
 * @returns 整理后的文本或标识。
 */
function buildIndexContent(
  content: string,
  assets: Awaited<ReturnType<AssetsService["list"]>>,
): string {
  const sections = assets
    .filter(
      (asset) =>
        asset.kind !== "source" && (asset.ocr_text || asset.description),
    )
    .map((asset) => {
      const page = asset.page_number ? `（第 ${asset.page_number} 页）` : "";
      return `### 图片 ${asset.ordinal ?? ""}${page}\n\n${[asset.ocr_text, asset.description].filter(Boolean).join("\n\n")}`;
    });
  return sections.length
    ? `${content.trim()}\n\n## 图片可检索内容\n\n${sections.join("\n\n")}`
    : content;
}
