import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { parse } from "dotenv";
import mysql from "mysql2/promise";

const env = parse(readFileSync(new URL("../.env", import.meta.url)));
const connectionUrl = process.env.GRAPH_TEST_DATABASE_URL ?? env.DATABASE_URL;
const connection = await mysql.createConnection(connectionUrl);
await connection.query(
  "CREATE DATABASE IF NOT EXISTS livedoc_langgraph_integration_test CHARACTER SET utf8mb4 COLLATE utf8mb4_bin",
);
await connection.end();
const url = new URL(connectionUrl);
url.pathname = "/livedoc_langgraph_integration_test";
const child = spawn(
  process.execPath,
  [
    "--max-old-space-size=768",
    "--experimental-vm-modules",
    "./node_modules/jest/bin/jest.js",
    "--runInBand",
    "--runTestsByPath",
    "tests/agent-graph.mysql.spec.ts",
    "--silent",
    ...process.argv.slice(2),
  ],
  {
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      NODE_ENV: "test",
      RAG_RUNTIME_MODE: "test",
      GRAPH_MYSQL_TEST: "true",
      METADATA_STORE: "mysql",
      MEMORY_STORE: "mysql",
      DATABASE_URL: url.toString(),
      LIVEDOC_RUN_MIGRATIONS: "true",
      AGENT_GRAPH_ENABLED: "true",
      LLM_API_KEY: "controlled-graph-test",
      VECTOR_STORE: "memory",
      EMBEDDING_PROVIDER: "hash",
      RERANK_PROVIDER: "lexical",
      AGENT_TOOL_SELECTION: "llm",
    },
  },
);
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
