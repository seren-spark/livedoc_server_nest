import { ForbiddenException, Inject, Injectable, NotFoundException, UnsupportedMediaTypeException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { AccessContext } from '../common/types.js';
import { DatabaseService } from '../database/database.service.js';
import { BLOB_STORAGE, type BlobStorage } from '../storage/blob-storage.js';
import type { DocumentAssetRecord } from './asset.types.js';

@Injectable()
export class AssetsService {
  private readonly records = new Map<string, DocumentAssetRecord>();

  constructor(
    private readonly database: DatabaseService,
    @Inject(BLOB_STORAGE) private readonly blobs: BlobStorage,
  ) {}

  async create(input: Omit<DocumentAssetRecord, 'asset_id' | 'content_url' | 'created_at'> & { asset_id?: string }): Promise<DocumentAssetRecord> {
    const asset: DocumentAssetRecord = {
      ...input,
      asset_id: input.asset_id ?? randomUUID().replaceAll('-', ''),
      content_url: '',
      created_at: new Date(),
    };
    asset.content_url = `/assets/${asset.asset_id}/content`;
    if (this.database.importJobsEnabled) {
      await this.database.query(
        `INSERT INTO document_assets
         (asset_id, space_id, owner_id, import_id, doc_id, kind, filename, mime_type,
          byte_size, sha256, storage_key, page_number, ordinal, width, height, ocr_text,
          description, analysis_status, analysis_error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [asset.asset_id, asset.space_id, asset.owner_id, asset.import_id, asset.doc_id,
          asset.kind, asset.filename, asset.mime_type, asset.byte_size, asset.sha256,
          asset.storage_key, asset.page_number, asset.ordinal, asset.width, asset.height,
          asset.ocr_text, asset.description, asset.analysis_status, asset.analysis_error,
          asset.created_at],
      );
    } else this.records.set(asset.asset_id, asset);
    return asset;
  }

  async storeImage(data: Buffer, filename: string, mimeType: string, context: AccessContext, parent: { import_id?: string; doc_id?: string }): Promise<DocumentAssetRecord> {
    const detected = detectImage(data, mimeType);
    const assetId = randomUUID().replaceAll('-', '');
    const parentKey = parent.import_id ? `imports/${parent.import_id}` : `documents/${parent.doc_id ?? 'drafts'}`;
    const storageKey = `spaces/${context.space_id}/${parentKey}/images/${assetId}${detected.extension}`;
    await this.blobs.put(storageKey, data);
    try {
      return await this.create({
        asset_id: assetId, space_id: context.space_id, owner_id: context.user_id,
        import_id: parent.import_id ?? null, doc_id: parent.doc_id ?? null,
        kind: 'editor_image', filename, mime_type: detected.mime,
        byte_size: data.byteLength, sha256: sha256(data), storage_key: storageKey,
        page_number: null, ordinal: null, width: null, height: null,
        ocr_text: '', description: '', analysis_status: 'pending', analysis_error: null,
      });
    } catch (error) {
      await this.blobs.delete(storageKey);
      throw error;
    }
  }

  async get(assetId: string): Promise<DocumentAssetRecord | null> {
    if (!this.database.importJobsEnabled) return this.records.get(assetId) ?? null;
    const rows = await this.database.query<Record<string, unknown>>('SELECT * FROM document_assets WHERE asset_id=?', [assetId]);
    return rows[0] ? mapAssetRow(rows[0]) : null;
  }

  async require(assetId: string): Promise<DocumentAssetRecord> {
    const asset = await this.get(assetId);
    if (!asset) throw new NotFoundException('Document asset not found.');
    return asset;
  }

  async list(filter: { import_id?: string; doc_id?: string }): Promise<DocumentAssetRecord[]> {
    if (!this.database.importJobsEnabled) {
      return [...this.records.values()].filter((item) =>
        (filter.import_id === undefined || item.import_id === filter.import_id) &&
        (filter.doc_id === undefined || item.doc_id === filter.doc_id));
    }
    const field = filter.import_id !== undefined ? 'import_id' : 'doc_id';
    const value = filter.import_id ?? filter.doc_id;
    const rows = await this.database.query<Record<string, unknown>>(
      `SELECT * FROM document_assets WHERE ${field}=? ORDER BY COALESCE(ordinal, 0), created_at`, [value]);
    return rows.map(mapAssetRow);
  }

  assertOwner(asset: DocumentAssetRecord, context: AccessContext): void {
    if (asset.space_id !== context.space_id || asset.owner_id !== context.user_id) {
      throw new ForbiddenException('Document asset access denied.');
    }
  }

  async link(assetIds: string[], docId: string, context: AccessContext): Promise<void> {
    for (const id of new Set(assetIds)) this.assertOwner(await this.require(id), context);
    if (!assetIds.length) return;
    if (this.database.importJobsEnabled) {
      await this.database.query(`UPDATE document_assets SET doc_id=? WHERE asset_id IN (${assetIds.map(() => '?').join(',')})`, [docId, ...assetIds]);
    } else {
      for (const id of assetIds) this.records.set(id, { ...(await this.require(id)), doc_id: docId });
    }
  }

  async updateAnalysis(assetId: string, values: Pick<DocumentAssetRecord, 'description' | 'analysis_status' | 'analysis_error'>): Promise<DocumentAssetRecord> {
    const current = await this.require(assetId);
    const next = { ...current, ...values };
    if (this.database.importJobsEnabled) {
      await this.database.query(
        'UPDATE document_assets SET description=?,analysis_status=?,analysis_error=? WHERE asset_id=?',
        [next.description, next.analysis_status, next.analysis_error, assetId],
      );
    } else this.records.set(assetId, next);
    return next;
  }

  async removeWhere(filter: { import_id?: string; doc_id?: string; kind?: string }): Promise<void> {
    const assets = (await this.list(filter)).filter((item) => !filter.kind || item.kind === filter.kind);
    await this.removeAssets(assets);
  }

  async reconcileDocument(docId: string, desiredIds: string[], context: AccessContext): Promise<void> {
    const desired = new Set(desiredIds);
    const stale = (await this.list({ doc_id: docId })).filter(
      (asset) => asset.kind !== 'source' && !desired.has(asset.asset_id),
    );
    for (const asset of stale) this.assertOwner(asset, context);
    await this.removeAssets(stale);
  }

  async reconcileImport(importId: string, desiredIds: string[], context: AccessContext): Promise<void> {
    const desired = new Set(desiredIds);
    const stale = (await this.list({ import_id: importId })).filter(
      (asset) => asset.kind !== 'source' && !desired.has(asset.asset_id),
    );
    for (const asset of stale) this.assertOwner(asset, context);
    await this.removeAssets(stale);
  }

  private async removeAssets(assets: DocumentAssetRecord[]): Promise<void> {
    for (const asset of assets) await this.blobs.delete(asset.storage_key);
    const ids = assets.map((item) => item.asset_id);
    if (!ids.length) return;
    if (this.database.importJobsEnabled) {
      await this.database.query(`DELETE FROM document_assets WHERE asset_id IN (${ids.map(() => '?').join(',')})`, ids);
    } else for (const id of ids) this.records.delete(id);
  }

  open(asset: DocumentAssetRecord) { return this.blobs.open(asset.storage_key); }
  read(asset: DocumentAssetRecord) { return this.blobs.read(asset.storage_key); }
}

export function sha256(data: Buffer): string { return createHash('sha256').update(data).digest('hex'); }

function detectImage(data: Buffer, declared: string): { mime: string; extension: string } {
  let detected: { mime: string; extension: string } | undefined;
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) detected = { mime: 'image/png', extension: '.png' };
  else if (data[0] === 0xff && data[1] === 0xd8 && data.at(-2) === 0xff && data.at(-1) === 0xd9) detected = { mime: 'image/jpeg', extension: '.jpg' };
  else if (data.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/u)) detected = { mime: 'image/gif', extension: '.gif' };
  else if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') detected = { mime: 'image/webp', extension: '.webp' };
  if (!detected) throw new UnsupportedMediaTypeException('Only valid PNG, JPEG, GIF, and WebP images are supported.');
  if (![detected.mime, detected.mime === 'image/jpeg' ? 'image/jpg' : detected.mime].includes(declared)) {
    throw new UnsupportedMediaTypeException('Image MIME type does not match its bytes.');
  }
  return detected;
}

export function mapAssetRow(row: Record<string, unknown>): DocumentAssetRecord {
  return {
    asset_id: String(row.asset_id), space_id: String(row.space_id), owner_id: String(row.owner_id),
    import_id: row.import_id == null ? null : String(row.import_id), doc_id: row.doc_id == null ? null : String(row.doc_id),
    kind: row.kind as DocumentAssetRecord['kind'], filename: String(row.filename), mime_type: String(row.mime_type),
    byte_size: Number(row.byte_size), sha256: String(row.sha256), storage_key: String(row.storage_key),
    content_url: `/assets/${String(row.asset_id)}/content`, page_number: row.page_number == null ? null : Number(row.page_number),
    ordinal: row.ordinal == null ? null : Number(row.ordinal), width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height), ocr_text: String(row.ocr_text ?? ''),
    description: String(row.description ?? ''), analysis_status: row.analysis_status as DocumentAssetRecord['analysis_status'],
    analysis_error: row.analysis_error == null ? null : String(row.analysis_error), created_at: new Date(row.created_at as string | Date),
  };
}
