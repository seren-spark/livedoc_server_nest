export const WRITING_SKILLS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS writing_skills (
    skill_id VARCHAR(128) PRIMARY KEY,
    owner_id VARCHAR(128) NOT NULL,
    space_id VARCHAR(128) NOT NULL,
    revision INT NOT NULL,
    definition JSON NOT NULL,
    updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    INDEX ix_writing_skills_owner (owner_id,space_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
];
