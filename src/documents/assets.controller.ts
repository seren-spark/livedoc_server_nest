import { Controller, Get, Param, PayloadTooLargeException, Post, Req, StreamableFile } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CurrentAccess } from '../auth/access-context.decorator.js';
import type { AccessContext } from '../common/types.js';
import { multipartField, requireMultipartFile } from '../uploads/multipart.js';
import { publicAsset } from './asset.types.js';
import { AssetsService } from './assets.service.js';
import { DocumentsService } from './documents.service.js';
import { DocumentImportsService } from '../document-imports/document-imports.service.js';
import { VisionService } from '../document-imports/vision.service.js';

@Controller()
export class AssetsController {
  constructor(
    private readonly assets: AssetsService,
    private readonly documents: DocumentsService,
    private readonly imports: DocumentImportsService,
    private readonly vision: VisionService,
  ) {}

  @Post('assets')
  async upload(@Req() request: FastifyRequest, @CurrentAccess() context: AccessContext) {
    const file = await requireMultipartFile(request);
    const data = await file.toBuffer();
    const importId = multipartField(file, 'import_id');
    const docId = multipartField(file, 'doc_id');
    if (data.byteLength > 10 * 1024 * 1024) throw new PayloadTooLargeException('Image exceeds the 10 MB limit.');
    if (importId) {
      const imported = await this.imports.require(importId);
      this.imports.assertOwner(imported, context);
    }
    if (docId) await this.documents.getWritable(docId, context);
    const record = await this.assets.storeImage(data, file.filename, file.mimetype, context, {
      import_id: importId,
      doc_id: docId,
    });
    return publicAsset(record);
  }

  @Get('assets/:asset_id/content')
  async content(@Param('asset_id') assetId: string, @CurrentAccess() context: AccessContext) {
    const asset = await this.assets.require(assetId);
    if (asset.doc_id) await this.documents.getAccessible(asset.doc_id, context);
    else this.assets.assertOwner(asset, context);
    return new StreamableFile(await this.assets.open(asset), {
      type: asset.mime_type,
      disposition: `inline; filename="${encodeURIComponent(asset.filename)}"`,
      length: asset.byte_size,
    });
  }

  @Post('assets/:asset_id/retry')
  async retryDescription(@Param('asset_id') assetId: string, @CurrentAccess() context: AccessContext) {
    const asset = await this.assets.require(assetId);
    this.assets.assertOwner(asset, context);
    const result = await this.vision.describe(await this.assets.read(asset), asset.mime_type);
    return publicAsset(await this.assets.updateAnalysis(asset.asset_id, {
      description: result.description,
      analysis_status: result.description ? 'ready' : this.vision.configured ? 'failed' : 'skipped',
      analysis_error: result.error,
    }));
  }
}
