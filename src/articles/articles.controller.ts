/**
 * @file 文章接口。提供文章草稿、发布、撤回、索引重试及封面资源入口。
 */
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  StreamableFile,
  PayloadTooLargeException,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { CurrentAccess } from "../auth/access-context.decorator.js";
import { Public } from "../auth/public.decorator.js";
import type { AccessContext } from "../common/types.js";
import { AssetsService } from "../documents/assets/assets.service.js";
import { publicAsset } from "../documents/assets/asset.types.js";
import { requireMultipartFile } from "../uploads/multipart.js";
import {
  ArticleCreateDto,
  ArticleListDto,
  ArticleSaveDto,
  ArticlePublishDto,
  ArticleVersionDto,
} from "./article.dto.js";
import { ArticleRepository } from "./article.repository.js";
import { ArticlesService } from "./articles.service.js";

@Controller()
export class ArticlesController {
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param articles ArticlesService 依赖实例。
   * @param repository ArticleRepository 依赖实例。
   * @param assets 当前文档关联的资源集合。
   */
  constructor(
    private readonly articles: ArticlesService,
    private readonly repository: ArticleRepository,
    private readonly assets: AssetsService,
  ) {}
  /**
   * 根据输入创建文章草稿并返回结果。
   *
   * @param body 请求正文或待提交的数据。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 文章草稿记录。
   */
  @Post("articles")
  create(
    @Body() body: ArticleCreateDto,
    @CurrentAccess() context: AccessContext,
  ) {
    return this.articles.create(context, body.article_id);
  }
  /**
   * 查询当前用户拥有的记录或互动状态。
   *
   * @param query 用户问题或检索查询。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 当前页条目与符合条件的总数；未找到或不可用时可能为空。
   */
  @Get("articles/mine")
  async mine(
    @Query() query: ArticleListDto,
    @CurrentAccess() context: AccessContext,
  ) {
    const result = await this.repository.list(
      context,
      query.page,
      query.page_size,
      query.state,
    );
    return {
      ...result,
      items: await Promise.all(
        result.items.map((r) => this.articles.own(r.article_id, context)),
      ),
      page: query.page,
      page_size: query.page_size,
    };
  }
  /**
   * 按标识读取文章草稿。
   *
   * @param id 目标记录的唯一标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 时间对象列表；未找到或不可用时可能为空。
   */
  @Get("articles/:id")
  get(@Param("id") id: string, @CurrentAccess() context: AccessContext) {
    return this.articles.own(id, context);
  }
  /**
   * 保存文章草稿的当前数据。
   *
   * @param id 目标记录的唯一标识。
   * @param body 请求正文或待提交的数据。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 时间对象列表；未找到或不可用时可能为空。
   */
  @Patch("articles/:id")
  save(
    @Param("id") id: string,
    @Body() body: ArticleSaveDto,
    @CurrentAccess() context: AccessContext,
  ) {
    return this.articles.save(id, body, context);
  }
  /**
   * 校验当前候选或草稿后发布，并协调对应索引状态。
   *
   * @param id 目标记录的唯一标识。
   * @param body 请求正文或待提交的数据。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 时间对象列表；未找到或不可用时可能为空。
   */
  @Post("articles/:id/publish")
  publish(
    @Param("id") id: string,
    @Body() body: ArticlePublishDto,
    @CurrentAccess() context: AccessContext,
  ) {
    return this.articles.publish(id, body.expected_version, context, body.include_in_knowledge);
  }
  /**
   * 撤回已发布内容，并使相应检索入口失效。
   *
   * @param id 目标记录的唯一标识。
   * @param body 请求正文或待提交的数据。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 时间对象列表；未找到或不可用时可能为空。
   */
  @Post("articles/:id/withdraw")
  withdraw(
    @Param("id") id: string,
    @Body() body: ArticleVersionDto,
    @CurrentAccess() context: AccessContext,
  ) {
    return this.articles.withdraw(id, body.expected_version, context);
  }
  /**
   * 检查当前状态后重新提交失败的任务。
   *
   * @param id 目标记录的唯一标识。
   * @param body 请求正文或待提交的数据。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 时间对象列表；未找到或不可用时可能为空。
   */
  @Post("articles/:id/reindex")
  retry(
    @Param("id") id: string,
    @Body() body: ArticleVersionDto,
    @CurrentAccess() context: AccessContext,
  ) {
    return this.articles.retry(id, body.expected_version, context);
  }
  /**
   * 接收当前文章使用的图片并交给资源服务保存。
   *
   * @param id 目标记录的唯一标识。
   * @param request 当前 Fastify HTTP 请求。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 当前步骤的处理结果。
   */
  @Post("articles/:id/assets")
  async upload(
    @Param("id") id: string,
    @Req() request: FastifyRequest,
    @CurrentAccess() context: AccessContext,
  ) {
    await this.repository.requireOwner(id, context);
    const file = await requireMultipartFile(request);
    const data = await file.toBuffer();
    if (data.length > 10 * 1024 * 1024)
      throw new PayloadTooLargeException("Image exceeds the 10 MB limit.");
    return publicAsset(
      await this.assets.storeImage(
        data,
        file.filename,
        file.mimetype,
        context,
        { doc_id: id },
      ),
    );
  }
  /**
   * 读取已公开文章使用的图片内容并写入响应。
   *
   * @param id 目标记录的唯一标识。
   * @param assetId 图片资源标识。
   * @returns StreamableFile 类型的处理结果。
   */
  @Public()
  @Get("public/articles/:id/assets/:asset_id/content")
  async image(@Param("id") id: string, @Param("asset_id") assetId: string) {
    const asset = await this.articles.publicAsset(id, assetId);
    return new StreamableFile(await this.assets.open(asset), {
      type: asset.mime_type,
      disposition: `inline; filename="${encodeURIComponent(asset.filename)}"`,
      length: asset.byte_size,
    });
  }
}
