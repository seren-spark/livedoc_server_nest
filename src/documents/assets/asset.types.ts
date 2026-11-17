/**
 * @file 文档资源协议。定义图片资源元数据，并裁剪对外公开的资源信息。
 */
export type AssetAnalysisStatus = 'pending' | 'ready' | 'skipped' | 'failed';

export interface DocumentAssetRecord {
  asset_id: string;
  space_id: string;
  owner_id: string;
  import_id: string | null;
  doc_id: string | null;
  kind: 'source' | 'image' | 'editor_image';
  filename: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
  storage_key: string;
  content_url: string;
  page_number: number | null;
  ordinal: number | null;
  width: number | null;
  height: number | null;
  ocr_text: string;
  description: string;
  analysis_status: AssetAnalysisStatus;
  analysis_error: string | null;
  created_at: Date;
}

export type PublicDocumentAsset = Omit<DocumentAssetRecord, 'storage_key'>;

/**
 * 裁剪内部存储字段，生成可向客户端返回的资源信息。
 *
 * @param asset 需要处理的图片资源记录。
 * @returns PublicDocumentAsset 类型的处理结果。
 */
export function publicAsset(asset: DocumentAssetRecord): PublicDocumentAsset {
  const { storage_key: _storageKey, ...record } = asset;
  return record;
}
