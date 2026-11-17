/**
 * @file 文档导入接口。接收上传文件，提供解析状态、草稿修改、重试和确认入口。
 */
import { BadRequestException, ConflictException, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Req, UnsupportedMediaTypeException, Body } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CurrentAccess } from '../auth/access-context.decorator.js';
import { DocumentImportDraftDto } from '../common/dto.js';
import type { AccessContext, Visibility } from '../common/types.js';
import { publicAsset } from '../documents/assets/asset.types.js';
import { AssetsService } from '../documents/assets/assets.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { jobResponse } from '../indexing/index-job.types.js';
import { multipartField, requireMultipartFile } from '../uploads/multipart.js';
import { DocumentImportsService, safeFilename } from './document-imports.service.js';

@Controller()
export class DocumentImportsController {
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param imports DocumentImportsService 依赖实例。
   * @param assets 当前文档关联的资源集合。
   * @param documents 需要筛选或处理的文档集合。
   */
  constructor(
    private readonly imports: DocumentImportsService,
    private readonly assets: AssetsService,
    private readonly documents: DocumentsService,
  ) {}

  /**
   * 接收上传文件及归属信息，创建导入记录和解析任务。
   *
   * @param request 当前 Fastify HTTP 请求。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 文档导入记录。
   */
  @Post('document-imports')
  @HttpCode(HttpStatus.ACCEPTED)
  async upload(@Req() request: FastifyRequest, @CurrentAccess() context: AccessContext) {
    const file = await requireMultipartFile(request);
    const filename = safeFilename(file.filename);
    const extension = filename.toLowerCase().endsWith('.pdf') ? '.pdf' : filename.toLowerCase().endsWith('.docx') ? '.docx' : '';
    if (!extension) throw new UnsupportedMediaTypeException('Only PDF and DOCX imports are supported.');
    const expectedMime = extension === '.pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (![expectedMime, 'application/octet-stream'].includes(file.mimetype)) throw new UnsupportedMediaTypeException('File MIME type does not match its extension.');
    const visibility = (multipartField(file, 'visibility') ?? 'private') as Visibility;
    if (!['private','team','public'].includes(visibility)) throw new BadRequestException('Unsupported visibility.');
    const teamId = multipartField(file, 'team_id') ?? null;
    this.documents.assertTeamTarget(visibility, teamId, context);
    const tags = parseTags(multipartField(file, 'tags'));
    const folder = multipartField(file, 'folder') ?? null;
    if (folder && !tags.includes(folder)) tags.unshift(folder);
    return this.imports.createUpload({ data: file.file, filename, mime_type: expectedMime,
      title: multipartField(file, 'title')?.trim().slice(0,512) || filename.replace(/\.(pdf|docx)$/iu,''),
      visibility, team_id: teamId, tags, folder, context });
  }

  /**
   * 按标识读取文档导入记录。
   *
   * @param importId 文档导入记录标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 文档导入记录。
   */
  @Get('document-imports/:import_id')
  async get(@Param('import_id') importId: string, @CurrentAccess() context: AccessContext) {
    const record = await this.imports.require(importId); this.imports.assertOwner(record, context);
    if(record.document_id) await this.documents.getAccessible(record.document_id,context);
    return record;
  }

  /**
   * 根据请求更新文档导入记录。
   *
   * @param importId 文档导入记录标识。
   * @param request 当前业务请求。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 文档导入记录。
   */
  @Patch('document-imports/:import_id')
  async update(@Param('import_id') importId: string, @Body() request: DocumentImportDraftDto, @CurrentAccess() context: AccessContext) {
    const record = await this.imports.require(importId); this.imports.assertOwner(record, context);
    for (const id of request.asset_ids ?? []) this.assets.assertOwner(await this.assets.require(id), context);
    const saved = await this.imports.saveDraft(importId, request);
    if (request.asset_ids) await this.assets.reconcileImport(importId, request.asset_ids, context);
    return this.imports.require(saved.import_id);
  }

  /**
   * 检查当前状态后重新提交失败的任务。
   *
   * @param importId 文档导入记录标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 文档导入记录。
   */
  @Post('document-imports/:import_id/retry')
  async retry(@Param('import_id') importId: string, @CurrentAccess() context: AccessContext) {
    const record = await this.imports.require(importId); this.imports.assertOwner(record, context);
    return this.imports.retry(importId, context);
  }

  /**
   * 确认导入草稿，创建或关联正式文档并安排后续索引。
   *
   * @param importId 文档导入记录标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 时间对象列表；未找到或不可用时可能为空。
   */
  @Post('document-imports/:import_id/confirm')
  @HttpCode(HttpStatus.ACCEPTED)
  async confirm(@Param('import_id') importId: string, @CurrentAccess() context: AccessContext) {
    const result = await this.imports.confirm(importId, context);
    return {
      document: { ...result.document, assets: result.assets.map(publicAsset) },
      index_job: jobResponse(result.job),
    };
  }

  /**
   * 检查导入归属后删除草稿及其临时资源。
   *
   * @param importId 文档导入记录标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @returns 整理后的状态与操作结果对象。
   */
  @Delete('document-imports/:import_id')
  async delete(@Param('import_id') importId: string, @CurrentAccess() context: AccessContext) {
    const record = await this.imports.require(importId); this.imports.assertOwner(record, context);
    if (record.status === 'confirmed') throw new ConflictException('Delete the confirmed knowledge document instead.');
    await this.imports.remove(importId); return { status: 'deleted', import_id: importId };
  }

}
/**
 * 解析标签字段，转换为业务使用的字符串数组。
 *
 * @param raw 尚未规范化或压缩的原始数据（可选）。
 * @returns 整理后的字符串列表。
 */
function parseTags(raw?: string): string[] { if(!raw)return []; try{const value=JSON.parse(raw) as unknown;if(!Array.isArray(value)||!value.every((x)=>typeof x==='string'))throw new Error();return value;}catch{throw new BadRequestException('tags must be a JSON string array.');} }
