import { CHECKPOINT_SCHEMA } from "../ai/graph/mysql-checkpoint-saver.js";
export const AGENT_GRAPH_COLUMNS: Record<string, string> = {
  graph_version: "VARCHAR(16) NULL",
  revision: "INT NOT NULL DEFAULT 0",
  stage: "VARCHAR(64) NOT NULL DEFAULT ''",
  execution_generation: "INT NOT NULL DEFAULT 0",
  lease_expires_at: "DATETIME(6) NULL",
  pause_requested: "BOOLEAN NOT NULL DEFAULT FALSE",
  last_seq: "INT NOT NULL DEFAULT 0",
  active_ms: "BIGINT NOT NULL DEFAULT 0",
  budget: "JSON NULL",
  control: "JSON NULL",
  resumable_until: "DATETIME(6) NULL",
  updated_at:
    "DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)",
};
export const AGENT_GRAPH_SCHEMA = [
  ...CHECKPOINT_SCHEMA,
  `CREATE TABLE IF NOT EXISTS agent_run_artifacts (
    run_id VARCHAR(64) NOT NULL, artifact_key VARCHAR(128) NOT NULL,
    payload JSON NOT NULL, created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY(run_id,artifact_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS agent_run_events (
    run_id VARCHAR(64) NOT NULL, seq INT NOT NULL, event VARCHAR(64) NOT NULL,
    payload JSON NOT NULL, created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY(run_id,seq)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS agent_model_reservations (
    reservation_id VARCHAR(64) PRIMARY KEY, run_id VARCHAR(64) NOT NULL,
    generation INT NOT NULL, estimated INT NOT NULL, settled BOOLEAN NOT NULL DEFAULT FALSE,
    prompt_tokens INT NULL, completion_tokens INT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), INDEX ix_model_run(run_id,settled)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];
