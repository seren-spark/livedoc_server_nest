/**
 * @file 存储模块。向导入与资源服务提供统一文件存储实例。
 */
import { Global, Module } from '@nestjs/common';
import { BLOB_STORAGE, LocalBlobStorage } from './blob-storage.js';

@Global()
@Module({
  providers: [LocalBlobStorage, { provide: BLOB_STORAGE, useExisting: LocalBlobStorage }],
  exports: [BLOB_STORAGE],
})
export class StorageModule {}
