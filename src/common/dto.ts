import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type {
  FeedbackAction,
  RetrievalDomain,
  RetrievalMode,
  SourceType,
  Visibility,
  WriteIntent,
} from './types.js';

const VISIBILITIES = ['private', 'team', 'public'] as const;
const SOURCE_TYPES = ['article', 'draft', 'note', 'team_doc', 'public_article', 'current_document'] as const;
const WRITE_INTENTS = [
  'knowledge_qa',
  'knowledge_search',
  'continue_paragraph',
  'summarize_document',
  'format_selection',
  'fill_in_middle',
  'correct_text',
  'expand_text',
] as const;
const RETRIEVAL_DOMAINS = ['public', 'private', 'team', 'current_document'] as const;

export class KnowledgeScopeDto {
  @IsOptional()
  @IsBoolean()
  private = true;

  @IsOptional()
  @IsBoolean()
  team = true;

  @IsOptional()
  @IsBoolean()
  public = true;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  document_ids: string[] = [];
}

export class DocumentIndexDto {
  @IsString()
  doc_id!: string;

  @IsString()
  space_id!: string;

  @IsString()
  title!: string;

  @IsString()
  content!: string;

  @IsOptional()
  @IsIn(VISIBILITIES)
  visibility: Visibility = 'private';

  @IsOptional()
  @IsIn(SOURCE_TYPES)
  source_type: SourceType = 'article';

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags: string[] = [];

  @IsOptional()
  @IsString()
  team_id?: string | null;

  @IsOptional()
  @IsString()
  owner_id?: string | null;

  @IsOptional()
  @IsString()
  url?: string | null;

  @IsOptional()
  @IsInt()
  document_version = 1;
}

export class DocumentCreateDto {
  @IsOptional()
  @IsString()
  doc_id?: string;

  @IsString()
  title!: string;

  @IsString()
  content!: string;

  @IsOptional()
  @IsIn(VISIBILITIES)
  visibility: Visibility = 'private';

  @IsOptional()
  @IsIn(SOURCE_TYPES)
  source_type: SourceType = 'article';

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags: string[] = [];

  @IsOptional()
  @IsString()
  team_id?: string | null;

  @IsOptional()
  @IsString()
  url?: string | null;

  @IsOptional()
  @IsBoolean()
  index_now = true;
}

export class DocumentUpdateDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsIn(VISIBILITIES)
  visibility?: Visibility;

  @IsOptional()
  @IsIn(SOURCE_TYPES)
  source_type?: SourceType;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  team_id?: string | null;

  @IsOptional()
  @IsString()
  url?: string | null;
}

export class SearchDto {
  @IsString()
  query!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => KnowledgeScopeDto)
  scope: KnowledgeScopeDto = new KnowledgeScopeDto();

  @IsOptional()
  @IsInt()
  top_k = 5;

  @IsOptional()
  @IsIn(['dense', 'keyword', 'hybrid'])
  mode: RetrievalMode = 'hybrid';

  @IsOptional()
  @IsString()
  context = '';
}

export class EditorContextDto {
  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  cursor_before = '';

  @IsOptional()
  @IsString()
  cursor_after = '';

  @IsOptional()
  @IsString()
  selected_text = '';

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags: string[] = [];
}

export class CurrentDocumentDto {
  @IsOptional()
  @IsString()
  title = '未命名文档';

  @IsString()
  content!: string;
}

export class AiWriteDto {
  @IsOptional()
  @IsIn(WRITE_INTENTS)
  intent?: WriteIntent;

  @IsString()
  query!: string;

  @ValidateNested()
  @Type(() => EditorContextDto)
  current_context!: EditorContextDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => KnowledgeScopeDto)
  scope: KnowledgeScopeDto = new KnowledgeScopeDto();

  @IsOptional()
  @IsIn(RETRIEVAL_DOMAINS)
  retrieval_domain: RetrievalDomain = 'public';

  @IsOptional()
  @ValidateNested()
  @Type(() => CurrentDocumentDto)
  current_document?: CurrentDocumentDto;

  @IsOptional()
  @IsBoolean()
  stream = true;

  @IsOptional()
  @IsString()
  conversation_id?: string;
}

export class DemoLoginDto {
  @IsString()
  email!: string;

  @IsString()
  password!: string;
}

export class FeedbackDto {
  @IsString()
  @IsNotEmpty()
  trace_id!: string;

  @IsIn(['inserted', 'helpful', 'unhelpful', 'dismissed'])
  action!: FeedbackAction;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment = '';
}

export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  page_size = 20;
}

export class TraceQueryDto {
  @IsOptional()
  @IsString()
  window = '24h';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 50;
}
