import { DatabaseService } from '../../database/database.service.js';
import type {
  DocumentMemoryProfile,
  GlobalSettingMemoryItem,
  GlossaryMemoryItem,
  StyleMemoryItem,
} from './document-memory.types.js';

const PROFILE_COLUMNS = `doc_id,space_id,source_document_version,status,glossary,
  style_tags,global_settings,source_chunk_hashes,last_error,created_at,updated_at`;

export class DocumentMemoryRepository {
  constructor(private readonly database: DatabaseService) {}

  async findByDocumentId(docId: string): Promise<DocumentMemoryProfile | null> {
    const rows = await this.database.query<Record<string, unknown>>(
      `SELECT ${PROFILE_COLUMNS} FROM document_memory_profiles WHERE doc_id=?`,
      [docId],
    );
    return rows[0] ? mapProfile(rows[0]) : null;
  }

  async save(profile: DocumentMemoryProfile): Promise<void> {
    await this.database.query(
      `INSERT INTO document_memory_profiles
        (${PROFILE_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
        source_document_version=VALUES(source_document_version),
        status=VALUES(status),glossary=VALUES(glossary),
        style_tags=VALUES(style_tags),global_settings=VALUES(global_settings),
        source_chunk_hashes=VALUES(source_chunk_hashes),
        last_error=VALUES(last_error),updated_at=VALUES(updated_at)`,
      [
        profile.doc_id,
        profile.space_id,
        profile.source_document_version,
        profile.status,
        JSON.stringify(profile.glossary),
        JSON.stringify(profile.style_tags),
        JSON.stringify(profile.global_settings),
        JSON.stringify(profile.source_chunk_hashes),
        profile.last_error,
        profile.created_at,
        profile.updated_at,
      ],
    );
  }

  async delete(docId: string): Promise<void> {
    await this.database.query('DELETE FROM document_memory_profiles WHERE doc_id=?', [docId]);
  }
}

function mapProfile(row: Record<string, unknown>): DocumentMemoryProfile {
  return {
    doc_id: String(row.doc_id),
    space_id: String(row.space_id),
    source_document_version: Number(row.source_document_version),
    status: row.status as DocumentMemoryProfile['status'],
    glossary: parseAutomaticItems<GlossaryMemoryItem>(row.glossary),
    style_tags: parseAutomaticItems<StyleMemoryItem>(row.style_tags),
    global_settings: parseAutomaticItems<GlobalSettingMemoryItem>(row.global_settings),
    source_chunk_hashes: parseArray<string>(row.source_chunk_hashes),
    last_error: row.last_error == null ? null : String(row.last_error),
    created_at: new Date(row.created_at as string | Date),
    updated_at: new Date(row.updated_at as string | Date),
  };
}

function parseArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function parseAutomaticItems<T>(value: unknown): T[] {
  return parseArray<Record<string, unknown>>(value)
    .filter((item) => item.origin !== 'user')
    .map(({ origin: _origin, pinned: _pinned, ...item }) => item as T);
}
