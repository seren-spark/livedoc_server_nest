import { AppConfig } from '../src/config/app-config.js';
import { DatabaseService } from '../src/database/database.service.js';

process.env.LIVEDOC_RUN_MIGRATIONS = 'true';

const config = new AppConfig();
config.validateRuntime();

const database = new DatabaseService(config);

try {
  await database.onModuleInit();
  console.log(JSON.stringify({
    status: 'ok',
    database_url_configured: Boolean(config.databaseUrl),
    env_file: config.envFile,
  }, null, 2));
} finally {
  await database.onModuleDestroy();
}
