import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AccessContext } from '../common/types.js';
import { AssetsService, sha256 } from '../documents/assets/assets.service.js';
import { BLOB_STORAGE, type BlobStorage } from '../storage/blob-storage.js';
import { DoclingParserService } from './docling-parser.service.js';
import { DocumentImportsService } from './document-imports.service.js';
import type { ImportJobRecord } from './document-import.types.js';
import { VisionService } from './vision.service.js';
import { AppConfig } from '../config/app-config.js';

@Injectable()
export class ImportWorkerService {
  constructor(
    private readonly imports: DocumentImportsService,
    private readonly assets: AssetsService,
    private readonly parser: DoclingParserService,
    private readonly vision: VisionService,
    private readonly config: AppConfig,
    @Inject(BLOB_STORAGE) private readonly blobs: BlobStorage,
  ) {}

  async runOnce(workerId: string): Promise<ImportJobRecord | null> {
    const job = await this.imports.claimNext(workerId);
    if (!job) return null;
    const heartbeat = setInterval(
      () => void this.imports.heartbeat(job),
      Math.max(1_000, Math.floor((job.lease_expires_at!.getTime() - Date.now()) / 3)),
    );
    try {
      if (job.config_fingerprint !== this.config.configFingerprint) {
        throw new Error(
          `Import worker configuration fingerprint mismatch: job=${job.config_fingerprint} worker=${this.config.configFingerprint}`,
        );
      }
      await this.process(job);
      await this.imports.succeed(job);
    } catch (error) {
      const record = await this.imports.get(job.import_id);
      if (record?.status !== 'canceled') {
        await this.imports.fail(job, error instanceof Error ? error.message : String(error));
      }
    } finally {
      clearInterval(heartbeat);
    }
    return job;
  }

  private async process(job: ImportJobRecord): Promise<void> {
    const record = await this.imports.require(job.import_id);
    const source = await this.assets.require(record.source_asset_id);
    await this.assets.removeWhere({ import_id: record.import_id, kind: 'image' });
    await this.imports.patch(record.import_id, { progress: 25, stage: '识别版面与正文' });
    const parsed = await this.blobs.materialize(source.storage_key, (path) => this.parser.parse(path, record.filename));
    await this.ensureActive(job);
    const context: AccessContext = { user_id: record.owner_id, space_id: record.space_id, team_ids: record.team_id ? [record.team_id] : [] };
    let markdown = parsed.markdown;
    for (let index = 0; index < parsed.images.length; index += 1) {
      await this.ensureActive(job);
      const image = parsed.images[index]!;
      await this.imports.patch(record.import_id, {
        progress: 45 + Math.round(((index + 1) / Math.max(1, parsed.images.length)) * 45),
        stage: `保存并分析图片 ${index + 1}/${parsed.images.length}`,
      });
      const data = Buffer.from(image.data_base64, 'base64');
      const assetId = randomUUID().replaceAll('-', '');
      const storageKey = `spaces/${record.space_id}/imports/${record.import_id}/images/${assetId}.png`;
      await this.blobs.put(storageKey, data);
      const vision = await this.vision.describe(data, image.mime_type);
      const errors = [image.ocr_error, vision.error].filter(Boolean).join('; ') || null;
      let asset: Awaited<ReturnType<AssetsService['create']>>;
      try {
        asset = await this.assets.create({
          asset_id: assetId, space_id: context.space_id, owner_id: context.user_id,
          import_id: record.import_id, doc_id: null, kind: 'image', filename: image.filename,
          mime_type: image.mime_type, byte_size: data.byteLength, sha256: sha256(data), storage_key: storageKey,
          page_number: image.page_number, ordinal: image.ordinal, width: image.width, height: image.height,
          ocr_text: image.ocr_text, description: vision.description,
          analysis_status: vision.description ? 'ready' : this.vision.configured ? 'failed' : 'skipped',
          analysis_error: errors,
        });
      } catch (error) {
        await this.blobs.delete(storageKey);
        throw error;
      }
      markdown = markdown.replace(`asset://pending/${image.ordinal}`, `asset://${asset.asset_id}`);
    }
    await this.ensureActive(job);
    await this.imports.patch(record.import_id, {
      title: record.title || parsed.title, parsed_content: markdown, parser_version: parsed.parser_version,
      status: 'review_ready', progress: 100, stage: '等待预览确认', error: null,
    });
  }

  private async ensureActive(job: ImportJobRecord): Promise<void> {
    const record = await this.imports.require(job.import_id);
    if (record.status === 'canceled') throw new Error('Import canceled');
    if (!(await this.imports.ownsLease(job))) throw new Error('Import worker lease lost');
  }
}
