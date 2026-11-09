import "dotenv/config";
import { DataSource } from "typeorm";
import mysql from "mysql2/promise";
import { MySqlCheckpointSaver } from "../src/ai/graph/mysql-checkpoint-saver.js";
import type { DatabaseService } from "../src/database/database.service.js";

// Only this dedicated test database is created/cleared; never the configured business database.
const testDatabase = "livedoc_langgraph_test";
const url = new URL(
  process.env.GRAPH_TEST_DATABASE_URL ?? process.env.DATABASE_URL!,
);
url.pathname = "/" + testDatabase;
let source: DataSource;
export default {
  checkpointerName: "LiveDoc MySQL",
  async beforeAll() {
    const connection = await mysql.createConnection(
      process.env.GRAPH_TEST_DATABASE_URL ?? process.env.DATABASE_URL!,
    );
    await connection.query(
      "CREATE DATABASE IF NOT EXISTS livedoc_langgraph_test CHARACTER SET utf8mb4 COLLATE utf8mb4_bin",
    );
    await connection.end();
    source = new DataSource({
      type: "mysql",
      url: url.toString(),
      synchronize: false,
    });
    await source.initialize();
  },
  async createCheckpointer() {
    const db = {
      query: (sql: string, params?: unknown[]) => source.query(sql, params),
      transaction: <T>(work: Parameters<DatabaseService["transaction"]>[0]) =>
        source.transaction(work) as Promise<T>,
    } as DatabaseService;
    const saver = new MySqlCheckpointSaver(db);
    await saver.setup();
    await source.query("DELETE FROM agent_graph_writes");
    await source.query("DELETE FROM agent_graph_checkpoints");
    return saver;
  },
  async afterAll() {
    await source?.destroy();
  },
};
