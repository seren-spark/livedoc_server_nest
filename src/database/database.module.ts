/**
 * @file 数据库模块。注册并导出共享数据库连接服务。
 */
import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service.js';
import { DocumentCatalog } from './document-catalog.js';

@Global()
@Module({
  providers: [DatabaseService,DocumentCatalog],
  exports: [DatabaseService,DocumentCatalog],
})
export class DatabaseModule {}
