export const WIKI_SCHEMA = `CREATE TABLE IF NOT EXISTS wiki_pages (
  wiki_id VARCHAR(64) PRIMARY KEY,
  space_id VARCHAR(128) NOT NULL, owner_id VARCHAR(128) NOT NULL,
  origin_run_id VARCHAR(64) NOT NULL, revision INT NOT NULL DEFAULT 1,
  status VARCHAR(32) NOT NULL, payload JSON NOT NULL,
  created_at DATETIME(6) NOT NULL, updated_at DATETIME(6) NOT NULL,
  UNIQUE KEY ux_wiki_origin(space_id,owner_id,origin_run_id),
  INDEX ix_wiki_owner(space_id,owner_id,status,updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
