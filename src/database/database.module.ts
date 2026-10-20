import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service.js';
import { DocumentCatalog } from './document-catalog.js';

@Global()
@Module({
  providers: [DatabaseService,DocumentCatalog],
  exports: [DatabaseService,DocumentCatalog],
})
export class DatabaseModule {}
