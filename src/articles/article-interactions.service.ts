/**
 * @file 文章互动。校验文章可见性与用户身份，处理点赞、收藏、评论和回复。
 */
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { EntityManager } from "typeorm";
import type { AccessContext } from "../common/types.js";
import { AuthService } from "../auth/auth.service.js";
import { DocumentsService } from "../documents/documents.service.js";
import { ArticleRepository } from "./article.repository.js";
import { ArticlesService } from "./articles.service.js";
import {
  ArticleInteractionsRepository,
  type ArticleComment,
  type ReactionKind,
} from "./article-interactions.repository.js";

@Injectable()
export class ArticleInteractionsService {
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param repository ArticleInteractionsRepository 依赖实例。
   * @param drafts ArticleRepository 依赖实例。
   * @param documents 需要筛选或处理的文档集合。
   * @param articles ArticlesService 依赖实例。
   * @param auth AuthService 依赖实例。
   */
  constructor(
    private readonly repository: ArticleInteractionsRepository,
    private readonly drafts: ArticleRepository,
    private readonly documents: DocumentsService,
    private readonly articles: ArticlesService,
    private readonly auth: AuthService,
  ) {}

  /**
   * 查询当前用户拥有的记录或互动状态。
   *
   * @param id 目标记录的唯一标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的状态与操作结果对象。
   */
  async mine(id: string, context: AccessContext) {
    await this.documents.getPublicArticle(id);
    return {
      ...(await this.repository.stats(id)),
      ...(await this.repository.mine(id, context.user_id)),
    };
  }
  /**
   * 新增或取消当前用户的点赞、收藏状态。
   *
   * @param id 目标记录的唯一标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param kind 当前结果或来源的分类。
   * @param active 是否启用或激活当前记录。
   * @returns 整理后的状态与操作结果对象。
   */
  async react(
    id: string,
    context: AccessContext,
    kind: ReactionKind,
    active: boolean,
  ) {
    await this.write(id, (manager) =>
      this.repository.react(id, context.user_id, kind, active, manager),
    );
    return this.mine(id, context);
  }
  /**
   * 分页读取文章下的顶层评论。
   *
   * @param id 目标记录的唯一标识。
   * @param page 当前页码或页面记录。
   * @param size 本次批量处理或页面读取的数量。
   * @returns 当前页条目与符合条件的总数；未找到或不可用时可能为空。
   */
  async comments(id: string, page: number, size: number) {
    await this.documents.getPublicArticle(id);
    const result = await this.repository.listComments(id, page, size);
    return {
      ...result,
      items: await Promise.all(result.items.map((c) => this.withAuthor(c))),
      comment_count: (await this.repository.stats(id)).comment_count,
      page,
      page_size: size,
    };
  }
  /**
   * 分页读取指定评论下的回复。
   *
   * @param id 目标记录的唯一标识。
   * @param commentId 评论或回复标识。
   * @param page 当前页码或页面记录。
   * @param size 本次批量处理或页面读取的数量。
   * @returns 当前页条目与符合条件的总数；未找到或不可用时可能为空。
   */
  async replies(id: string, commentId: string, page: number, size: number) {
    await this.documents.getPublicArticle(id);
    const parent = await this.repository.comment(commentId);
    if (!parent || parent.article_id !== id || parent.parent_comment_id)
      throw new NotFoundException("Comment thread not found.");
    const result = await this.repository.listComments(
      id,
      page,
      size,
      commentId,
    );
    return {
      ...result,
      items: await Promise.all(result.items.map((c) => this.withAuthor(c))),
      page,
      page_size: size,
    };
  }
  /**
   * 校验评论目标后保存评论或回复。
   *
   * @param id 目标记录的唯一标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param content 待处理的正文内容。
   * @param requestedId requested 对应的唯一标识（可选）。
   * @param parentId parent 对应的唯一标识。
   * @returns 时间对象；未找到或不可用时可能为空。
   */
  async addComment(
    id: string,
    context: AccessContext,
    content: string,
    requestedId?: string,
    parentId: string | null = null,
  ) {
    const text = content.trim();
    if (!text)
      throw new UnprocessableEntityException("Comment cannot be empty.");
    const commentId = requestedId ?? randomUUID().replaceAll("-", "");
    let result: ArticleComment | null = null;
    await this.write(id, async (manager) => {
      const existing = await this.repository.comment(commentId, manager);
      if (existing) {
        if (
          existing.article_id !== id ||
          existing.user_id !== context.user_id ||
          existing.content !== text ||
          existing.parent_comment_id !== parentId ||
          existing.deleted_at
        )
          throw new ConflictException("Comment ID already exists.");
        result = existing;
        return;
      }
      if (parentId) {
        const parent = await this.repository.comment(parentId, manager);
        if (!parent || parent.article_id !== id || parent.deleted_at)
          throw new NotFoundException("Comment not found or deleted.");
        if (parent.parent_comment_id)
          throw new UnprocessableEntityException(
            "Reply to the top-level comment.",
          );
      }
      result = {
        comment_id: commentId,
        article_id: id,
        user_id: context.user_id,
        content: text,
        created_at: new Date(),
        parent_comment_id: parentId,
        deleted_at: null,
      };
      await this.repository.addComment(result, manager);
    });
    return this.withAuthor(result!);
  }
  /**
   * 校验评论归属后移除评论及相应关联数据。
   *
   * @param id 目标记录的唯一标识。
   * @param commentId 评论或回复标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的状态与操作结果对象。
   */
  async removeComment(id: string, commentId: string, context: AccessContext) {
    await this.write(id, async (manager) => {
      const comment = await this.repository.comment(commentId, manager);
      if (!comment || comment.article_id !== id)
        throw new NotFoundException("Comment not found.");
      if (comment.user_id !== context.user_id)
        throw new ForbiddenException("Only the comment author may delete it.");
      await this.repository.removeComment(commentId, manager);
    });
    return { status: "deleted", comment_id: commentId };
  }
  /**
   * 分页读取当前用户收藏的文章。
   *
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param page 当前页码或页面记录。
   * @param size 本次批量处理或页面读取的数量。
   * @returns 当前页条目与符合条件的总数。
   */
  async favorites(context: AccessContext, page: number, size: number) {
    let result;
    if (this.repository.database.metadataEnabled)
      result = await this.repository.favorites(context.user_id, page, size);
    else {
      const reactions = [...this.repository.reactions.values()]
        .filter((r) => r.user_id === context.user_id && r.kind === "favorite")
        .sort(
          (a, b) =>
            b.created_at.getTime() - a.created_at.getTime() ||
            b.article_id.localeCompare(a.article_id),
        );
      const visible = [];
      for (const reaction of reactions) {
        try {
          visible.push(
            await this.documents.getPublicArticle(reaction.article_id),
          );
        } catch (error) {
          if (!(error instanceof NotFoundException)) throw error;
        }
      }
      result = {
        items: visible.slice((page - 1) * size, page * size),
        total: visible.length,
      };
    }
    return {
      ...result,
      items: await Promise.all(
        result.items.map((record) => this.articles.publicRecord(record)),
      ),
      page,
      page_size: size,
    };
  }
  /**
   * 为评论记录补充可展示的作者信息。
   *
   * @param comment 用户提交的评论或反馈说明。
   * @returns 时间对象；未找到或不可用时可能为空。
   */
  private async withAuthor(comment: ArticleComment) {
    return {
      ...comment,
      deleted: Boolean(comment.deleted_at),
      reply_count: comment.parent_comment_id
        ? 0
        : await this.repository.replyCount(comment.comment_id),
      author_name: await this.auth.publicName(comment.user_id),
    };
  }
  /**
   * 锁定文章发布状态后执行互动写入，避免对已撤回内容继续操作。
   *
   * @param id 目标记录的唯一标识。
   * @param work 当前数据库事务执行器。
   * @returns T 类型的处理结果。
   */
  private async write<T>(
    id: string,
    work: (manager?: EntityManager) => Promise<T>,
  ): Promise<T> {
    if (this.repository.database.metadataEnabled)
      return this.repository.database.transaction(async (manager) => {
        const draft = await this.drafts.get(id, manager, true);
        const rows = await manager.query(
          `SELECT doc_id FROM knowledge_documents WHERE doc_id=? AND visibility='public'
        AND source_type IN ('article','public_article') FOR UPDATE`,
          [id],
        );
        if (!rows.length || (draft && draft.state !== "published"))
          throw new NotFoundException("Public article not found.");
        return work(manager);
      });
    return this.drafts.serial(id, async () => {
      await this.documents.getPublicArticle(id);
      return work();
    });
  }
}
