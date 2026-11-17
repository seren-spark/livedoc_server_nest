/**
 * @file 工作空间接口。提供分类树、文档归类、回收站与写作模板的操作入口。
 */
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
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param workspace WorkspaceService 依赖实例。
   * @param documents 需要筛选或处理的文档集合。
   */
  constructor(
    private readonly workspace: WorkspaceService,
    private readonly documents: DocumentsService,
  ) {}
  /**
   * 读取当前用户的分类树及其版本信息。
   *
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的状态与操作结果对象。
   */
  @Get("categories/tree") tree(@CurrentAccess() c: AccessContext) {
    return this.workspace.tree(c);
  }
  /**
   * 根据输入创建分类与模板并返回结果。
   *
   * @param b 当前比较输入或 BM25 长度归一化系数。
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的状态与操作结果对象。
   */
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
  /**
   * 校验名称后更新分类。
   *
   * @param id 目标记录的唯一标识。
   * @param b 当前比较输入或 BM25 长度归一化系数。
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的状态与操作结果对象。
   */
  @Patch("categories/:id") rename(
    @Param("id") id: string,
    @Body() b: WorkspaceMutationDto,
    @CurrentAccess() c: AccessContext,
  ) {
    return this.workspace.rename(c, id, b.name ?? "", b.expected_tree_revision);
  }
  /**
   * 按提交的顺序调整同级分类。
   *
   * @param b 当前比较输入或 BM25 长度归一化系数。
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的状态与操作结果对象。
   */
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
  /**
   * 将文档归入指定分类。
   *
   * @param b 当前比较输入或 BM25 长度归一化系数。
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的状态与操作结果对象。
   */
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
  /**
   * 为历史文档补建分类归属。
   *
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的状态与操作结果对象。
   */
  @Post("categories/backfill") backfill(@CurrentAccess() c: AccessContext) {
    return this.workspace.backfill(c);
  }
  /**
   * 将分类移到目标父节点，检查循环和层级约束。
   *
   * @param id 目标记录的唯一标识。
   * @param b 当前比较输入或 BM25 长度归一化系数。
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的状态与操作结果对象。
   */
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
  /**
   * 合并两个分类，并迁移其子分类和文档。
   *
   * @param id 目标记录的唯一标识。
   * @param b 当前比较输入或 BM25 长度归一化系数。
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的状态与操作结果对象。
   */
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
  /**
   * 将分类及其相关文档移入回收站。
   *
   * @param id 目标记录的唯一标识。
   * @param b 当前比较输入或 BM25 长度归一化系数。
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的状态与操作结果对象。
   */
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
  /**
   * 读取当前用户回收站中的文档与分类。
   *
   * @param type 当前数据或节点类型。
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @returns 知识文档记录列表。
   */
  @Get("trash") trash(
    @Query("type") type: string,
    @CurrentAccess() c: AccessContext,
  ) {
    if (!["document", "category"].includes(type))
      throw new BadRequestException("Invalid trash type");
    return this.workspace.trash(c, type);
  }
  /**
   * 检查当前状态后恢复指定记录或任务。
   *
   * @param b 当前比较输入或 BM25 长度归一化系数。
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的状态与操作结果对象。
   */
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
  /**
   * 校验回收站输入和文档归属后，彻底清理选中的回收内容。
   *
   * @param b 当前比较输入或 BM25 长度归一化系数。
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的状态与操作结果对象。
   */
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
  /**
   * 读取回收操作所需的当前状态和版本。
   *
   * @param b 当前比较输入或 BM25 长度归一化系数。
   */
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
  /**
   * 读取当前用户可见的写作模板列表。
   *
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的结果列表。
   */
  @Get("note-templates") listTemplates(@CurrentAccess() c: AccessContext) {
    return this.workspace.listTemplates(c);
  }
  /**
   * 返回指定模板的内容与写作要求。
   *
   * @param id 目标记录的唯一标识。
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @returns import("E:/LiveDoc/livedoc_server_nest/src/workspace/workspace.types").NoteTemplate 类型的处理结果。
   */
  @Get("note-templates/:id") template(
    @Param("id") id: string,
    @CurrentAccess() c: AccessContext,
  ) {
    return this.workspace.getTemplate(c, id);
  }
  /**
   * 创建当前用户的写作模板。
   *
   * @param b 当前比较输入或 BM25 长度归一化系数。
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @returns import("E:/LiveDoc/livedoc_server_nest/src/workspace/workspace.types").NoteTemplate 类型的处理结果。
   */
  @Post("note-templates") createTemplate(
    @Body() b: TemplateMutationDto,
    @CurrentAccess() c: AccessContext,
  ) {
    return this.workspace.saveTemplate(c, b);
  }
  /**
   * 更新已有模板的内容和写作要求。
   *
   * @param id 目标记录的唯一标识。
   * @param b 当前比较输入或 BM25 长度归一化系数。
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @returns import("E:/LiveDoc/livedoc_server_nest/src/workspace/workspace.types").NoteTemplate 类型的处理结果。
   */
  @Patch("note-templates/:id") editTemplate(
    @Param("id") id: string,
    @Body() b: TemplateMutationDto,
    @CurrentAccess() c: AccessContext,
  ) {
    return this.workspace.saveTemplate(c, b, id, b.expected_revision);
  }
  /**
   * 删除当前用户有权管理的写作模板。
   *
   * @param id 目标记录的唯一标识。
   * @param c 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的状态与操作结果对象。
   */
  @Delete("note-templates/:id") deleteTemplate(
    @Param("id") id: string,
    @CurrentAccess() c: AccessContext,
  ) {
    return this.workspace.deleteTemplate(c, id);
  }
}
