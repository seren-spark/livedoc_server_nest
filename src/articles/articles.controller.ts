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
  ArticleVersionDto,
} from "./article.dto.js";
import { ArticleRepository } from "./article.repository.js";
import { ArticlesService } from "./articles.service.js";

@Controller()
export class ArticlesController {
  constructor(
    private readonly articles: ArticlesService,
    private readonly repository: ArticleRepository,
    private readonly assets: AssetsService,
  ) {}
  @Post("articles")
  create(
    @Body() body: ArticleCreateDto,
    @CurrentAccess() context: AccessContext,
  ) {
    return this.articles.create(context, body.article_id);
  }
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
  @Get("articles/:id")
  get(@Param("id") id: string, @CurrentAccess() context: AccessContext) {
    return this.articles.own(id, context);
  }
  @Patch("articles/:id")
  save(
    @Param("id") id: string,
    @Body() body: ArticleSaveDto,
    @CurrentAccess() context: AccessContext,
  ) {
    return this.articles.save(id, body, context);
  }
  @Post("articles/:id/publish")
  publish(
    @Param("id") id: string,
    @Body() body: ArticleVersionDto,
    @CurrentAccess() context: AccessContext,
  ) {
    return this.articles.publish(id, body.expected_version, context);
  }
  @Post("articles/:id/withdraw")
  withdraw(
    @Param("id") id: string,
    @Body() body: ArticleVersionDto,
    @CurrentAccess() context: AccessContext,
  ) {
    return this.articles.withdraw(id, body.expected_version, context);
  }
  @Post("articles/:id/reindex")
  retry(
    @Param("id") id: string,
    @Body() body: ArticleVersionDto,
    @CurrentAccess() context: AccessContext,
  ) {
    return this.articles.retry(id, body.expected_version, context);
  }
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
