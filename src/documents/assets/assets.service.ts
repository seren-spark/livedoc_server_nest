/**
 * @file 文档资源管理。校验与存储图片，检查归属权限并回收正文不再引用的资源。
 */
import { ForbiddenException, Inject, Injectable, NotFoundException, UnsupportedMediaTypeException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { AccessContext } from '../../common/types.js';
import { DatabaseService } from '../../database/database.service.js';
import { BLOB_STORAGE, type BlobStorage } from '../../storage/blob-storage.js';
import type { DocumentAssetRecord } from './asset.types.js';
import { AssetsRepository } from './assets.repository.js';

@Injectable()
export class AssetsService {
  private readonly records = new Map<string, DocumentAssetRecord>();
  private readonly repository: AssetsRepository;

  /**
   * 初始化实例依赖与本地状态。
   *
   * @param database 共享数据库服务。
   * @param blobs 已读取或创建的文件 Blob 集合。
   */
  constructor(
    private readonly database: DatabaseService,
    @Inject(BLOB_STORAGE) private readonly blobs: BlobStorage,
  ) {
    this.repository = new AssetsRepository(database);
  }

  /**
   * 根据输入创建图片资源并返回结果。
   *
   * @param input 本次操作的输入数据。
   * @returns DocumentAssetRecord 类型的处理结果。
   */
  async create(input: Omit<DocumentAssetRecord, 'asset_id' | 'content_url' | 'created_at'> & { asset_id?: string }): Promise<DocumentAssetRecord> {
    const asset: DocumentAssetRecord = {
      ...input,
      asset_id: input.asset_id ?? randomUUID().replaceAll('-', ''),
      content_url: '',
      created_at: new Date(),
    };
    asset.content_url = `/assets/${asset.asset_id}/content`;
    if (this.database.importJobsEnabled) {
      await this.repository.insert(asset);
    } else this.records.set(asset.asset_id, asset);
    return asset;
  }

  /**
   * 校验图片格式后保存文件内容及资源元数据。
   *
   * @param data 当前事件或操作携带的数据。
   * @param filename 上传文件的原始名称。
   * @param mimeType 文件内容的媒体类型。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   * @param parent 目标父节点或父分类。
   * @returns DocumentAssetRecord 类型的处理结果。
   */
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

  /**
   * 按标识读取图片资源。
   *
   * @param assetId 图片资源标识。
   * @returns DocumentAssetRecord 类型的处理结果；未找到或不可用时可能为空。
   */
  async get(assetId: string): Promise<DocumentAssetRecord | null> {
    if (!this.database.importJobsEnabled) return this.records.get(assetId) ?? null;
    return this.repository.findById(assetId);
  }

  /**
   * 读取必需的图片资源，不存在时抛出错误。
   *
   * @param assetId 图片资源标识。
   * @returns DocumentAssetRecord 类型的处理结果。
   */
  async require(assetId: string): Promise<DocumentAssetRecord> {
    const asset = await this.get(assetId);
    if (!asset) throw new NotFoundException('Document asset not found.');
    return asset;
  }

  /**
   * 按查询条件读取图片资源列表。
   *
   * @param filter filter 参数（{ import_id?: string; doc_id?: string }）。
   * @returns 整理后的结果列表。
   */
  async list(filter: { import_id?: string; doc_id?: string }): Promise<DocumentAssetRecord[]> {
    if (!this.database.importJobsEnabled) {
      return [...this.records.values()].filter((item) =>
        (filter.import_id === undefined || item.import_id === filter.import_id) &&
        (filter.doc_id === undefined || item.doc_id === filter.doc_id));
    }
    return this.repository.list(filter);
  }

  /**
   * 确认资源或导入记录属于当前用户与空间。
   *
   * @param asset 需要处理的图片资源记录。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   */
  assertOwner(asset: DocumentAssetRecord, context: AccessContext): void {
    if (asset.space_id !== context.space_id || asset.owner_id !== context.user_id) {
      throw new ForbiddenException('Document asset access denied.');
    }
  }

  /**
   * 将图片资源绑定到指定文档或导入记录。
   *
   * @param assetIds asset 对应的标识集合。
   * @param docId 知识文档标识。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   */
  async link(assetIds: string[], docId: string, context: AccessContext): Promise<void> {
    for (const id of new Set(assetIds)) {
      const asset = await this.require(id);
      this.assertOwner(asset, context);
      if (asset.doc_id && asset.doc_id !== docId) throw new ForbiddenException('Asset already belongs to another document.');
    }
    if (!assetIds.length) return;
    if (this.database.importJobsEnabled) {
      await this.repository.link(assetIds, docId);
    } else {
      for (const id of assetIds) this.records.set(id, { ...(await this.require(id)), doc_id: docId });
    }
  }

  /**
   * 更新图片描述、分析状态和失败原因。
   *
   * @param assetId 图片资源标识。
   * @param values 待转换或去重的值集合。
   * @returns DocumentAssetRecord 类型的处理结果。
   */
  async updateAnalysis(assetId: string, values: Pick<DocumentAssetRecord, 'description' | 'analysis_status' | 'analysis_error'>): Promise<DocumentAssetRecord> {
    const current = await this.require(assetId);
    const next = { ...current, ...values };
    if (this.database.importJobsEnabled) {
      await this.repository.updateAnalysis(assetId, next);
    } else this.records.set(assetId, next);
    return next;
  }

  /**
   * 按条件选出并清理资源记录与实际文件。
   *
   * @param filter filter 参数（{ import_id?: string; doc_id?: string; kind?: string }）。
   */
  async removeWhere(filter: { import_id?: string; doc_id?: string; kind?: string }): Promise<void> {
    const assets = (await this.list(filter)).filter((item) => !filter.kind || item.kind === filter.kind);
    await this.removeAssets(assets);
  }

  /**
   * 比对文档仍引用的资源，更新关联并清理已移除图片。
   *
   * @param docId 知识文档标识。
   * @param desiredIds desired 对应的标识集合。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   */
  async reconcileDocument(docId: string, desiredIds: string[], context: AccessContext): Promise<void> {
    const desired = new Set(desiredIds);
    const stale = (await this.list({ doc_id: docId })).filter(
      (asset) => asset.kind !== 'source' && !desired.has(asset.asset_id),
    );
    for (const asset of stale) this.assertOwner(asset, context);
    await this.removeAssets(stale);
  }

  /**
   * 按资源标识清理指定图片。
   *
   * @param ids 本次操作涉及的记录标识集合。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   */
  async removeIds(ids: string[], context: AccessContext): Promise<void> {
    const assets = [];
    for (const id of ids) {
      const asset = await this.get(id);
      if (!asset) continue;
      this.assertOwner(asset, context);
      assets.push(asset);
    }
    await this.removeAssets(assets);
  }

  /**
   * 比对导入草稿资源引用，清理不再使用的图片。
   *
   * @param importId 文档导入记录标识。
   * @param desiredIds desired 对应的标识集合。
   * @param context 当前用户、空间与团队身份，用于权限校验。
   */
  async reconcileImport(importId: string, desiredIds: string[], context: AccessContext): Promise<void> {
    const desired = new Set(desiredIds);
    const stale = (await this.list({ import_id: importId })).filter(
      (asset) => asset.kind !== 'source' && !desired.has(asset.asset_id),
    );
    for (const asset of stale) this.assertOwner(asset, context);
    await this.removeAssets(stale);
  }

  /**
   * 删除资源元数据及其对应的存储文件。
   *
   * @param assets 当前文档关联的资源集合。
   */
  private async removeAssets(assets: DocumentAssetRecord[]): Promise<void> {
    for (const asset of assets) await this.blobs.delete(asset.storage_key);
    const ids = assets.map((item) => item.asset_id);
    if (!ids.length) return;
    if (this.database.importJobsEnabled) {
      await this.repository.delete(ids);
    } else for (const id of ids) this.records.delete(id);
  }

  /**
   * 打开指定资源的内容读取流。
   *
   * @param asset 需要处理的图片资源记录。
   * @returns import("stream").Readable 类型的处理结果。
   */
  open(asset: DocumentAssetRecord) { return this.blobs.open(asset.storage_key); }
  /**
   * 把指定资源的实际文件读入内存。
   *
   * @param asset 需要处理的图片资源记录。
   * @returns 文件字节内容。
   */
  read(asset: DocumentAssetRecord) { return this.blobs.read(asset.storage_key); }
}

/**
 * 计算内容的 SHA-256 摘要。
 *
 * @param data 当前事件或操作携带的数据。
 * @returns 整理后的文本或标识。
 */
export function sha256(data: Buffer): string { return createHash('sha256').update(data).digest('hex'); }

/**
 * 根据文件内容识别图片类型，避免只依赖扩展名。
 *
 * @param data 当前事件或操作携带的数据。
 * @param declared 输入中声明的目标或来源。
 * @returns 整理后的状态与操作结果对象。
 */
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
