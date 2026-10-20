import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  BadRequestException,
} from "@nestjs/common";
import {
  Allow,
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from "class-validator";
import { CurrentAccess } from "../auth/access-context.decorator.js";
import type { AccessContext } from "../common/types.js";
import { WorkspaceService } from "./workspace.service.js";
import { DocumentsService } from "../documents/documents.service.js";

export class WorkspaceMutationDto {
  @IsInt() @Min(0) expected_tree_revision!: number;
  @IsOptional() @IsString() @MaxLength(100) name?: string;
  @IsOptional() @IsString() parent_id?: string | null;
  @IsOptional() @IsString() target_id?: string;
  @IsOptional() @IsString() position_id?: string;
  @IsOptional() @IsBoolean() after = false;
  @IsOptional() @IsString() category_id?: string | null;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  ids: string[] = [];
  @IsOptional() @IsBoolean() include_documents = false;
  @IsOptional() @IsString() type = "document";
  @IsOptional() @Allow() names: Record<string, string> = {};
}
export class TemplateMutationDto {
  @IsOptional() @IsString() @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsString() @MaxLength(100000) markdown?: string;
  @IsOptional() @IsString() @MaxLength(8000) instructions?: string;
  @IsOptional() @IsInt() @Min(1) expected_revision?: number;
}
@Controller()
export class WorkspaceController {
  constructor(
    private readonly workspace: WorkspaceService,
    private readonly documents: DocumentsService,
  ) {}
  @Get("categories/tree") tree(@CurrentAccess() c: AccessContext) {
    return this.workspace.tree(c);
  }
  @Post("categories") create(
    @Body() b: WorkspaceMutationDto,
    @CurrentAccess() c: AccessContext,
  ) {
    return this.workspace.create(
      c,
      b.name ?? "",
      b.parent_id ?? null,
      b.expected_tree_revision,
    );
  }
  @Patch("categories/:id") rename(
    @Param("id") id: string,
    @Body() b: WorkspaceMutationDto,
    @CurrentAccess() c: AccessContext,
  ) {
    return this.workspace.rename(c, id, b.name ?? "", b.expected_tree_revision);
  }
  @Post("categories/reorder") reorder(
    @Body() b: WorkspaceMutationDto,
    @CurrentAccess() c: AccessContext,
  ) {
    return this.workspace.reorder(
      c,
      b.parent_id ?? null,
      b.ids,
      b.expected_tree_revision,
    );
  }
  @Post("categories/assign") assign(
    @Body() b: WorkspaceMutationDto,
    @CurrentAccess() c: AccessContext,
  ) {
    return this.workspace.assign(
      c,
      b.ids,
      b.category_id ?? null,
      b.expected_tree_revision,
    );
  }
  @Post("categories/backfill") backfill(@CurrentAccess() c: AccessContext) {
    return this.workspace.backfill(c);
  }
  @Post("categories/:id/move") move(
    @Param("id") id: string,
    @Body() b: WorkspaceMutationDto,
    @CurrentAccess() c: AccessContext,
  ) {
    return this.workspace.move(
      c,
      id,
      b.parent_id ?? null,
      b.expected_tree_revision,
      b.position_id ? { id: b.position_id, after: b.after } : undefined,
    );
  }
  @Post("categories/:id/merge") merge(
    @Param("id") id: string,
    @Body() b: WorkspaceMutationDto,
    @CurrentAccess() c: AccessContext,
  ) {
    return this.workspace.merge(
      c,
      id,
      b.target_id ?? "",
      b.expected_tree_revision,
    );
  }
  @Post("categories/:id/trash") trashCategory(
    @Param("id") id: string,
    @Body() b: WorkspaceMutationDto,
    @CurrentAccess() c: AccessContext,
  ) {
    return this.workspace.trashCategory(
      c,
      id,
      b.include_documents,
      b.expected_tree_revision,
    );
  }
  @Get("trash") trash(
    @Query("type") type: string,
    @CurrentAccess() c: AccessContext,
  ) {
    if (!["document", "category"].includes(type))
      throw new BadRequestException("Invalid trash type");
    return this.workspace.trash(c, type);
  }
  @Post("trash/restore") restore(
    @Body() b: WorkspaceMutationDto,
    @CurrentAccess() c: AccessContext,
  ) {
    this.checkTrash(b);
    return this.workspace.restore(
      c,
      b.type,
      b.ids,
      b.include_documents,
      b.names,
      b.expected_tree_revision,
    );
  }
  @Post("trash/purge") async purge(
    @Body() b: WorkspaceMutationDto,
    @CurrentAccess() c: AccessContext,
  ) {
    this.checkTrash(b);
    if (b.type === "category")
      return this.workspace.purgeCategories(c, b.ids, b.expected_tree_revision);
    const owned = await this.documents.ownedPrivate(c);
    if (b.ids.some((id) => !owned.some((d) => d.doc_id === id && d.deleted_at)))
      throw new BadRequestException("只能彻底删除自己的回收文档");
    return this.workspace.purgeDocuments(c, b.ids, b.expected_tree_revision);
  }
  private checkTrash(b: WorkspaceMutationDto) {
    if (
      !["document", "category"].includes(b.type) ||
      !b.ids.length ||
      new Set(b.ids).size !== b.ids.length ||
      Object.values(b.names).some(
        (n) => typeof n !== "string" || !n.trim() || n.length > 100,
      )
    )
      throw new BadRequestException("回收操作参数无效");
  }
  @Get("note-templates") listTemplates(@CurrentAccess() c: AccessContext) {
    return this.workspace.listTemplates(c);
  }
  @Get("note-templates/:id") template(
    @Param("id") id: string,
    @CurrentAccess() c: AccessContext,
  ) {
    return this.workspace.getTemplate(c, id);
  }
  @Post("note-templates") createTemplate(
    @Body() b: TemplateMutationDto,
    @CurrentAccess() c: AccessContext,
  ) {
    return this.workspace.saveTemplate(c, b);
  }
  @Patch("note-templates/:id") editTemplate(
    @Param("id") id: string,
    @Body() b: TemplateMutationDto,
    @CurrentAccess() c: AccessContext,
  ) {
    return this.workspace.saveTemplate(c, b, id, b.expected_revision);
  }
  @Delete("note-templates/:id") deleteTemplate(
    @Param("id") id: string,
    @CurrentAccess() c: AccessContext,
  ) {
    return this.workspace.deleteTemplate(c, id);
  }
}
