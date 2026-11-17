/**
 * @file 文章互动接口。暴露点赞、收藏、评论和回复相关 HTTP 入口。
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { IsOptional, IsString, Matches, MaxLength } from "class-validator";
import { CurrentAccess } from "../auth/access-context.decorator.js";
import { Public } from "../auth/public.decorator.js";
import type { AccessContext } from "../common/types.js";
import { PaginationQueryDto } from "../common/dto.js";
import { ArticleInteractionsService } from "./article-interactions.service.js";

class CommentCreateDto {
  @IsString()
  @MaxLength(1000)
  content!: string;
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9_-]{16,64}$/)
  comment_id?: string;
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9_-]{16,64}$/)
  parent_comment_id?: string;
}
@Controller()
export class ArticleInteractionsController {
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param interactions ArticleInteractionsService 依赖实例。
   */
  constructor(private readonly interactions: ArticleInteractionsService) {}
  /**
   * 分页读取当前用户收藏的文章。
   *
   * @param query 用户问题或检索查询。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 当前页条目与符合条件的总数。
   */
  @Get("articles/favorites")
  favorites(
    @Query() query: PaginationQueryDto,
    @CurrentAccess() context: AccessContext,
  ) {
    return this.interactions.favorites(context, query.page, query.page_size);
  }
  /**
   * 查询当前用户拥有的记录或互动状态。
   *
   * @param id 目标记录的唯一标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的状态与操作结果对象。
   */
  @Get("articles/:id/interactions")
  mine(@Param("id") id: string, @CurrentAccess() context: AccessContext) {
    return this.interactions.mine(id, context);
  }
  /**
   * 分页读取文章下的顶层评论。
   *
   * @param id 目标记录的唯一标识。
   * @param query 用户问题或检索查询。
   * @returns 当前页条目与符合条件的总数；未找到或不可用时可能为空。
   */
  @Public()
  @Get("public/articles/:id/comments")
  comments(@Param("id") id: string, @Query() query: PaginationQueryDto) {
    return this.interactions.comments(id, query.page, query.page_size);
  }
  /**
   * 读取或创建本次请求指定的文章评论。
   *
   * @param id 目标记录的唯一标识。
   * @param body 请求正文或待提交的数据。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 时间对象；未找到或不可用时可能为空。
   */
  @Post("articles/:id/comments")
  comment(
    @Param("id") id: string,
    @Body() body: CommentCreateDto,
    @CurrentAccess() context: AccessContext,
  ) {
    return this.interactions.addComment(
      id,
      context,
      body.content,
      body.comment_id,
      body.parent_comment_id,
    );
  }
  /**
   * 分页读取指定评论下的回复。
   *
   * @param id 目标记录的唯一标识。
   * @param commentId 评论或回复标识。
   * @param query 用户问题或检索查询。
   * @returns 当前页条目与符合条件的总数；未找到或不可用时可能为空。
   */
  @Public()
  @Get("public/articles/:id/comments/:comment_id/replies")
  replies(
    @Param("id") id: string,
    @Param("comment_id") commentId: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.interactions.replies(
      id,
      commentId,
      query.page,
      query.page_size,
    );
  }
  /**
   * 检查用户权限后删除指定评论。
   *
   * @param id 目标记录的唯一标识。
   * @param commentId 评论或回复标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的状态与操作结果对象。
   */
  @Delete("articles/:id/comments/:comment_id")
  deleteComment(
    @Param("id") id: string,
    @Param("comment_id") commentId: string,
    @CurrentAccess() context: AccessContext,
  ) {
    return this.interactions.removeComment(id, commentId, context);
  }
  /**
   * 为当前用户添加文章点赞。
   *
   * @param id 目标记录的唯一标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的状态与操作结果对象。
   */
  @Put("articles/:id/like")
  @HttpCode(200)
  like(@Param("id") id: string, @CurrentAccess() context: AccessContext) {
    return this.interactions.react(id, context, "like", true);
  }
  /**
   * 取消当前用户对文章的点赞。
   *
   * @param id 目标记录的唯一标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的状态与操作结果对象。
   */
  @Delete("articles/:id/like")
  unlike(@Param("id") id: string, @CurrentAccess() context: AccessContext) {
    return this.interactions.react(id, context, "like", false);
  }
  /**
   * 将文章加入当前用户的收藏。
   *
   * @param id 目标记录的唯一标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的状态与操作结果对象。
   */
  @Put("articles/:id/favorite")
  @HttpCode(200)
  favorite(@Param("id") id: string, @CurrentAccess() context: AccessContext) {
    return this.interactions.react(id, context, "favorite", true);
  }
  /**
   * 取消当前用户对文章的收藏。
   *
   * @param id 目标记录的唯一标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的状态与操作结果对象。
   */
  @Delete("articles/:id/favorite")
  unfavorite(@Param("id") id: string, @CurrentAccess() context: AccessContext) {
    return this.interactions.react(id, context, "favorite", false);
  }
}
