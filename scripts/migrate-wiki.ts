import { createConnection } from "mysql2/promise";
import { AppConfig } from "../src/config/app-config.js";
import { CURRENT_SCHEMA_VERSION } from "../src/database/migration-version.js";
import {
  inspectSchemaContract,
  formatSchemaProblems,
} from "../src/database/schema-contract.js";
import { WIKI_SCHEMA } from "../src/database/wiki-schema.js";

// Additive, isolated migration: never invokes the application's older migrations.
const config = new AppConfig();
if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
const connection = await createConnection(config.databaseUrl);
try {
  const query = async <T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> => {
    const [rows] = await connection.query(sql, params);
    return rows as T[];
  };
  const versions = await query<{ version: string }>(
    "SELECT version FROM schema_migrations WHERE version IN (?,?)",
    ["2026101901_agent_user_settings", CURRENT_SCHEMA_VERSION],
  );
  if (!versions.length)
    throw new Error(
      "Required previous schema version is missing; migrate the existing application first",
    );
  const problems = await inspectSchemaContract(query);
  const unexpected = problems.filter(
    (problem) => problem.kind !== "version" && problem.table !== "wiki_pages",
  );
  if (unexpected.length)
    throw new Error(
      `Unrelated schema drift: ${formatSchemaProblems(unexpected)}`,
    );
  await connection.query(WIKI_SCHEMA);
  const after = (await inspectSchemaContract(query)).filter(
    (problem) => problem.kind !== "version",
  );
  if (after.length)
    throw new Error(`Schema validation failed: ${formatSchemaProblems(after)}`);
  await connection.execute(
    "INSERT IGNORE INTO schema_migrations(version,applied_at) VALUES(?,UTC_TIMESTAMP(6))",
    [CURRENT_SCHEMA_VERSION],
  );
  const final = await inspectSchemaContract(query);
  if (final.length) throw new Error(formatSchemaProblems(final));
  console.log(
    JSON.stringify({
      status: "ok",
      table: "wiki_pages",
      version: CURRENT_SCHEMA_VERSION,
      additive_only: true,
    }),
  );
} finally {
  await connection.end();
}
