import { DatabaseService } from '../../database/database.service.js';
import type { DocumentAssetRecord } from './asset.types.js';

const ASSET_COLUMNS = `asset_id,space_id,owner_id,import_id,doc_id,kind,filename,mime_type,
  byte_size,sha256,storage_key,page_number,ordinal,width,height,ocr_text,description,
  analysis_status,analysis_error,created_at`;

export class AssetsRepository {
  constructor(private readonly database: DatabaseService) {}

  async insert(asset: DocumentAssetRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO document_assets
       (${ASSET_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        asset.asset_id,
        asset.space_id,
        asset.owner_id,
        asset.import_id,
        asset.doc_id,
        asset.kind,
        asset.filename,
        asset.mime_type,
        asset.byte_size,
        asset.sha256,
        asset.storage_key,
        asset.page_number,
        asset.ordinal,
        asset.width,
        asset.height,
        asset.ocr_text,
        asset.description,
        asset.analysis_status,
        asset.analysis_error,
        asset.created_at,
      ],
    );
  }

  async findById(assetId: string): Promise<DocumentAssetRecord | null> {
    const rows = await this.database.query<Record<string, unknown>>(
      `SELECT ${ASSET_COLUMNS} FROM document_assets WHERE asset_id=?`,
      [assetId],
    );
    return rows[0] ? mapAssetRow(rows[0]) : null;
  }

  async list(filter: { import_id?: string; doc_id?: string }): Promise<DocumentAssetRecord[]> {
    const field = filter.import_id !== undefined ? 'import_id' : 'doc_id';
    const value = filter.import_id ?? filter.doc_id;
    const rows = await this.database.query<Record<string, unknown>>(
      `SELECT ${ASSET_COLUMNS} FROM document_assets
       WHERE ${field}=? ORDER BY COALESCE(ordinal,0),created_at`,
      [value],
    );
    return rows.map(mapAssetRow);
  }

  async link(assetIds: string[], docId: string): Promise<void> {
    await this.database.query(
      `UPDATE document_assets SET doc_id=? WHERE asset_id IN (${placeholders(assetIds)})`,
      [docId, ...assetIds],
    );
  }

  async updateAnalysis(
    assetId: string,
    values: Pick<DocumentAssetRecord, 'description' | 'analysis_status' | 'analysis_error'>,
  ): Promise<void> {
    await this.database.query(
      'UPDATE document_assets SET description=?,analysis_status=?,analysis_error=? WHERE asset_id=?',
      [values.description, values.analysis_status, values.analysis_error, assetId],
    );
  }

  async delete(assetIds: string[]): Promise<void> {
    await this.database.query(
      `DELETE FROM document_assets WHERE asset_id IN (${placeholders(assetIds)})`,
      assetIds,
    );
  }
}

function placeholders(values: unknown[]): string {
  return values.map(() => '?').join(',');
}

export function mapAssetRow(row: Record<string, unknown>): DocumentAssetRecord {
  return {
    asset_id: String(row.asset_id),
    space_id: String(row.space_id),
    owner_id: String(row.owner_id),
    import_id: row.import_id == null ? null : String(row.import_id),
    doc_id: row.doc_id == null ? null : String(row.doc_id),
    kind: row.kind as DocumentAssetRecord['kind'],
    filename: String(row.filename),
    mime_type: String(row.mime_type),
    byte_size: Number(row.byte_size),
    sha256: String(row.sha256),
    storage_key: String(row.storage_key),
    content_url: `/assets/${String(row.asset_id)}/content`,
    page_number: row.page_number == null ? null : Number(row.page_number),
    ordinal: row.ordinal == null ? null : Number(row.ordinal),
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    ocr_text: String(row.ocr_text ?? ''),
    description: String(row.description ?? ''),
    analysis_status: row.analysis_status as DocumentAssetRecord['analysis_status'],
    analysis_error: row.analysis_error == null ? null : String(row.analysis_error),
    created_at: new Date(row.created_at as string | Date),
  };
}
