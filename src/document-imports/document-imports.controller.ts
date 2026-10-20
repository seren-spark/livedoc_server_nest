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
  constructor(
    private readonly imports: DocumentImportsService,
    private readonly assets: AssetsService,
    private readonly documents: DocumentsService,
  ) {}

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

  @Get('document-imports/:import_id')
  async get(@Param('import_id') importId: string, @CurrentAccess() context: AccessContext) {
    const record = await this.imports.require(importId); this.imports.assertOwner(record, context);
    if(record.document_id) await this.documents.getAccessible(record.document_id,context);
    return record;
  }

  @Patch('document-imports/:import_id')
  async update(@Param('import_id') importId: string, @Body() request: DocumentImportDraftDto, @CurrentAccess() context: AccessContext) {
    const record = await this.imports.require(importId); this.imports.assertOwner(record, context);
    for (const id of request.asset_ids ?? []) this.assets.assertOwner(await this.assets.require(id), context);
    const saved = await this.imports.saveDraft(importId, request);
    if (request.asset_ids) await this.assets.reconcileImport(importId, request.asset_ids, context);
    return this.imports.require(saved.import_id);
  }

  @Post('document-imports/:import_id/retry')
  async retry(@Param('import_id') importId: string, @CurrentAccess() context: AccessContext) {
    const record = await this.imports.require(importId); this.imports.assertOwner(record, context);
    return this.imports.retry(importId, context);
  }

  @Post('document-imports/:import_id/confirm')
  @HttpCode(HttpStatus.ACCEPTED)
  async confirm(@Param('import_id') importId: string, @CurrentAccess() context: AccessContext) {
    const result = await this.imports.confirm(importId, context);
    return {
      document: { ...result.document, assets: result.assets.map(publicAsset) },
      index_job: jobResponse(result.job),
    };
  }

  @Delete('document-imports/:import_id')
  async delete(@Param('import_id') importId: string, @CurrentAccess() context: AccessContext) {
    const record = await this.imports.require(importId); this.imports.assertOwner(record, context);
    if (record.status === 'confirmed') throw new ConflictException('Delete the confirmed knowledge document instead.');
    await this.imports.remove(importId); return { status: 'deleted', import_id: importId };
  }

}
function parseTags(raw?: string): string[] { if(!raw)return []; try{const value=JSON.parse(raw) as unknown;if(!Array.isArray(value)||!value.every((x)=>typeof x==='string'))throw new Error();return value;}catch{throw new BadRequestException('tags must be a JSON string array.');} }
