import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
config({ path: resolve(root, process.env.ENV_FILE || '.env'), quiet: true });
const database = new URL(process.env.DATABASE_URL);
if (database.protocol !== 'mysql:') throw new Error('DATABASE_URL must use MySQL');
const name = decodeURIComponent(database.pathname.slice(1));
if (!name) throw new Error('Database name is missing');
const directory = resolve(root, 'data/backups');
await mkdir(directory, { recursive: true });
const destination = resolve(directory, `livedoc-${new Date().toISOString().replace(/[:.]/g, '-')}.sql`);
const partial = `${destination}.partial`;
const child = spawn(process.env.MYSQLDUMP_PATH || 'mysqldump', [
  '--single-transaction', '--quick', '--skip-lock-tables', '--no-tablespaces',
  '--column-statistics=0', '--default-character-set=utf8mb4',
  `--host=${database.hostname}`, `--port=${database.port || 3306}`,
  `--user=${decodeURIComponent(database.username)}`, `--result-file=${partial}`, name,
], {
  env: { ...process.env, MYSQL_PWD: decodeURIComponent(database.password) },
  stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
});
let error = '';
child.stderr.on('data', chunk => { error += chunk.toString(); });
const code = await new Promise((resolveExit, reject) => {
  child.once('error', reject);
  child.once('exit', resolveExit);
});
if (code !== 0) throw new Error(`Database backup failed (${code}): ${error}`);
await rename(partial, destination);
const hash = createHash('sha256');
for await (const chunk of createReadStream(destination)) hash.update(chunk);
const summary = { file: destination, database: name, host: database.hostname, sha256: hash.digest('hex') };
await writeFile(`${destination}.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
