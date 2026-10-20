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
  constructor(private readonly interactions: ArticleInteractionsService) {}
  @Get("articles/favorites")
  favorites(
    @Query() query: PaginationQueryDto,
    @CurrentAccess() context: AccessContext,
  ) {
    return this.interactions.favorites(context, query.page, query.page_size);
  }
  @Get("articles/:id/interactions")
  mine(@Param("id") id: string, @CurrentAccess() context: AccessContext) {
    return this.interactions.mine(id, context);
  }
  @Public()
  @Get("public/articles/:id/comments")
  comments(@Param("id") id: string, @Query() query: PaginationQueryDto) {
    return this.interactions.comments(id, query.page, query.page_size);
  }
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
  @Delete("articles/:id/comments/:comment_id")
  deleteComment(
    @Param("id") id: string,
    @Param("comment_id") commentId: string,
    @CurrentAccess() context: AccessContext,
  ) {
    return this.interactions.removeComment(id, commentId, context);
  }
  @Put("articles/:id/like")
  @HttpCode(200)
  like(@Param("id") id: string, @CurrentAccess() context: AccessContext) {
    return this.interactions.react(id, context, "like", true);
  }
  @Delete("articles/:id/like")
  unlike(@Param("id") id: string, @CurrentAccess() context: AccessContext) {
    return this.interactions.react(id, context, "like", false);
  }
  @Put("articles/:id/favorite")
  @HttpCode(200)
  favorite(@Param("id") id: string, @CurrentAccess() context: AccessContext) {
    return this.interactions.react(id, context, "favorite", true);
  }
  @Delete("articles/:id/favorite")
  unfavorite(@Param("id") id: string, @CurrentAccess() context: AccessContext) {
    return this.interactions.react(id, context, "favorite", false);
  }
}
