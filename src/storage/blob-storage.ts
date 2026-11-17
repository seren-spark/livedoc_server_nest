/**
 * @file 文件内容存储。封装本地文件与流的保存、读取、删除和临时落盘操作。
 */
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/app-config.js';

export interface BlobStorage {
  put(key: string, data: Buffer): Promise<void>;
  putStream(key: string, data: Readable, maxBytes: number): Promise<{ byteSize: number; sha256: string }>;
  open(key: string): Promise<Readable>;
  read(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  materialize<T>(key: string, action: (path: string) => Promise<T>): Promise<T>;
}

export const BLOB_STORAGE = Symbol('BLOB_STORAGE');

@Injectable()
export class LocalBlobStorage implements BlobStorage {
  private readonly root: string;

  /**
   * 初始化实例依赖与本地状态。
   *
   * @param config 应用运行配置。
   */
  constructor(config: AppConfig) {
    if (config.storageProvider !== 'local') {
      throw new Error(`Unsupported STORAGE_PROVIDER=${config.storageProvider}`);
    }
    this.root = resolve(config.projectRoot, config.storageLocalRoot);
  }

  /**
   * 先写临时文件再重命名，避免读到尚未写完的内容。
   *
   * @param key 查询或存储使用的键。
   * @param data 当前事件或操作携带的数据。
   */
  async put(key: string, data: Buffer): Promise<void> {
    const target = this.path(key);
    await fs.mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, data, { flag: 'wx' });
    await fs.rename(temporary, target);
  }

  /**
   * 以流方式写入文件，并记录实际接收的内容信息。
   *
   * @param key 查询或存储使用的键。
   * @param data 当前事件或操作携带的数据。
   * @param maxBytes maxBytes 对应的数量或范围限制。
   * @returns 整理后的状态与操作结果对象。
   */
  async putStream(key: string, data: Readable, maxBytes: number): Promise<{ byteSize: number; sha256: string }> {
    const target = this.path(key);
    await fs.mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    const hash = createHash('sha256');
    let byteSize = 0;
    const meter = new Transform({
      /**
       * 转发上传分片，同时累计文件大小与摘要，超限时终止写入。
       *
       * @param chunk 当前索引分块。
       * @param _encoding 回调签名保留的参数，当前实现不使用。
       * @param callback 条件满足后执行的回调。
       */
      transform(chunk: Buffer, _encoding, callback) {
        byteSize += chunk.byteLength;
        if (byteSize > maxBytes) {
          callback(new Error(`Upload exceeds ${maxBytes} bytes`));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(data, meter, createWriteStream(temporary, { flags: 'wx' }));
      if (!byteSize) throw new Error('Uploaded file is empty');
      await fs.rename(temporary, target);
      return { byteSize, sha256: hash.digest('hex') };
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  }

  /**
   * 打开存储文件的读取流。
   *
   * @param key 查询或存储使用的键。
   * @returns Readable 类型的处理结果。
   */
  async open(key: string): Promise<Readable> {
    return createReadStream(this.path(key));
  }

  /**
   * 读取存储文件的完整字节内容。
   *
   * @param key 查询或存储使用的键。
   * @returns 文件字节内容。
   */
  read(key: string): Promise<Buffer> {
    return fs.readFile(this.path(key));
  }

  /**
   * 删除指定存储键对应的文件。
   *
   * @param key 查询或存储使用的键。
   */
  async delete(key: string): Promise<void> {
    await fs.rm(this.path(key), { force: true });
  }

  /**
   * 判断对应存储键的文件是否存在。
   *
   * @param key 查询或存储使用的键。
   * @returns 条件是否满足的判断结果。
   */
  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.path(key));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 将存储内容落为解析器可以读取的本地文件。
   *
   * @param key 查询或存储使用的键。
   * @param action 本次请求执行的操作类型。
   * @returns T 类型的处理结果。
   */
  materialize<T>(key: string, action: (path: string) => Promise<T>): Promise<T> {
    return action(this.path(key));
  }

  /**
   * 规范化存储键并检查路径边界，生成存储根目录内的绝对路径。
   *
   * @param key 查询或存储使用的键。
   * @returns 整理后的文本或标识。
   */
  private path(key: string): string {
    const normalized = key.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '');
    if (!normalized || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error('Invalid storage key');
    }
    const target = resolve(this.root, normalized);
    if (target !== this.root && !target.startsWith(`${this.root}${sep}`)) {
      throw new Error('Storage key escapes configured root');
    }
    return target;
  }
}
