/**
 * @file 会话约束表结构。声明会话约束快照和输入去重记录需要的数据库表。
 */
export const CONVERSATION_CONSTRAINTS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS conversation_constraint_states (
    scope_key CHAR(64) PRIMARY KEY, user_id VARCHAR(128) NOT NULL,
    space_id VARCHAR(128) NOT NULL, conversation_id VARCHAR(128) NOT NULL,
    document_key VARCHAR(256) NOT NULL, revision INT NOT NULL,
    items JSON NOT NULL, expires_at DATETIME(6) NOT NULL,
    INDEX ix_constraint_document (document_key), INDEX ix_constraint_expiry (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS conversation_constraint_inputs (
    scope_key CHAR(64) NOT NULL, input_key CHAR(64) NOT NULL,
    content_hash CHAR(64) NOT NULL, snapshot JSON NOT NULL,
    expires_at DATETIME(6) NOT NULL, PRIMARY KEY (scope_key,input_key),
    INDEX ix_constraint_input_expiry (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
];

// Older Agent turns can be attributed only when their source run identifies the document.
export const CONVERSATION_TURN_SCOPE_BACKFILL = `
  UPDATE conversation_turns turns JOIN agent_runs runs
    ON turns.turn_id=LEFT(SHA2(CONCAT('agent:',runs.run_id),256),32)
    AND BINARY turns.user_id=BINARY runs.user_id
    AND BINARY turns.space_id=BINARY runs.space_id
    AND BINARY turns.conversation_id=BINARY runs.conversation_id
  SET turns.doc_id=CONCAT('agent:',SHA2(CONCAT(
    JSON_UNQUOTE(JSON_EXTRACT(runs.payload,'$.identity.kind')), ':',
    CASE JSON_UNQUOTE(JSON_EXTRACT(runs.payload,'$.identity.kind'))
      WHEN 'article' THEN JSON_UNQUOTE(JSON_EXTRACT(runs.payload,'$.identity.article_id'))
      WHEN 'import' THEN JSON_UNQUOTE(JSON_EXTRACT(runs.payload,'$.identity.import_id'))
      WHEN 'unsaved' THEN JSON_UNQUOTE(JSON_EXTRACT(runs.payload,'$.identity.local_id'))
    END),256))
  WHERE turns.doc_id IS NULL
    AND JSON_UNQUOTE(JSON_EXTRACT(runs.payload,'$.identity.kind')) IN ('article','import','unsaved')`;
