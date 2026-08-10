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

  constructor(config: AppConfig) {
    if (config.storageProvider !== 'local') {
      throw new Error(`Unsupported STORAGE_PROVIDER=${config.storageProvider}`);
    }
    this.root = resolve(config.projectRoot, config.storageLocalRoot);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const target = this.path(key);
    await fs.mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, data, { flag: 'wx' });
    await fs.rename(temporary, target);
  }

  async putStream(key: string, data: Readable, maxBytes: number): Promise<{ byteSize: number; sha256: string }> {
    const target = this.path(key);
    await fs.mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    const hash = createHash('sha256');
    let byteSize = 0;
    const meter = new Transform({
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

  async open(key: string): Promise<Readable> {
    return createReadStream(this.path(key));
  }

  read(key: string): Promise<Buffer> {
    return fs.readFile(this.path(key));
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.path(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.path(key));
      return true;
    } catch {
      return false;
    }
  }

  materialize<T>(key: string, action: (path: string) => Promise<T>): Promise<T> {
    return action(this.path(key));
  }

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
