export const WRITING_PREFERENCES_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS writing_preference_states (
    space_id VARCHAR(128) NOT NULL,
    user_id VARCHAR(128) NOT NULL,
    revision INT NOT NULL,
    items JSON NOT NULL,
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (space_id,user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS writing_preference_inputs (
    space_id VARCHAR(128) NOT NULL,
    user_id VARCHAR(128) NOT NULL,
    input_key CHAR(64) NOT NULL,
    content_hash CHAR(64) NOT NULL,
    result JSON NOT NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (space_id,user_id,input_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
];
