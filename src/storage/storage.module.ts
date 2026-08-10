import { Global, Module } from '@nestjs/common';
import { BLOB_STORAGE, LocalBlobStorage } from './blob-storage.js';

@Global()
@Module({
  providers: [LocalBlobStorage, { provide: BLOB_STORAGE, useExisting: LocalBlobStorage }],
  exports: [BLOB_STORAGE],
})
export class StorageModule {}
