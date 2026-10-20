import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from "class-validator";
import { PaginationQueryDto } from "../common/dto.js";
import type { ArticleState } from "./article.types.js";

export class ArticleCreateDto {
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9_-]{16,64}$/)
  article_id?: string;
}
export class ArticleVersionDto {
  @IsInt()
  @Min(1)
  expected_version!: number;
}
export class ArticleSaveDto extends ArticleVersionDto {
  @IsString()
  @MaxLength(120)
  title!: string;
  @IsString()
  @MaxLength(2_000_000)
  content!: string;
  @IsOptional()
  @IsObject()
  editor_content?: Record<string, unknown> | null;
  @IsString()
  @MaxLength(300)
  summary = "";
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @MaxLength(20, { each: true })
  tags: string[] = [];
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cover_asset_id?: string | null;
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  asset_ids: string[] = [];
}
export class ArticleListDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(["draft", "published", "withdrawn"])
  state?: ArticleState;
}
