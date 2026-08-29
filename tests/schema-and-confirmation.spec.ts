import { jest } from '@jest/globals';
import { CURRENT_SCHEMA_VERSION } from '../src/database/migration-version.js';
import {
  inspectSchemaContract,
  REQUIRED_SCHEMA_COLUMNS,
  REQUIRED_SCHEMA_INDEXES,
} from '../src/database/schema-contract.js';
import { DocumentImportsService, buildIndexContent } from '../src/document-imports/document-imports.service.js';

describe('database schema contract', () => {
  it('accepts the complete required table, column, index and version contract', async () => {
    const query = contractQuery();
    await expect(inspectSchemaContract(query)).resolves.toEqual([]);
  });

  it('reports code-critical schema drift even when the migration version exists', async () => {
    const query = contractQuery({
      omitColumn: ['index_jobs', 'request_payload'],
      omitIndex: ['index_jobs', 'ix_jobs_claim'],
    });
    const problems = await inspectSchemaContract(query);
    expect(problems).toEqual(expect.arrayContaining([
      { kind: 'column', table: 'index_jobs', name: 'request_payload' },
      { kind: 'index', table: 'index_jobs', name: 'ix_jobs_claim' },
    ]));
  });
});

describe('document import confirmation', () => {
  it('keeps all MySQL writes inside one transaction and propagates enqueue failure', async () => {
    const manager = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM document_imports')) return [importRow()];
        if (sql.includes('FROM document_assets')) return [];
        if (sql.includes('FROM knowledge_documents')) return [];
        if (sql.startsWith('INSERT INTO knowledge_documents')) return [];
        if (sql.includes('WHERE dedupe_key=')) return [];
        if (sql.includes('COALESCE(MAX(generation)')) return [{ generation: 0 }];
        if (sql.startsWith('INSERT INTO index_jobs')) throw new Error('forced enqueue failure');
        throw new Error(`Unexpected SQL in test: ${sql}`);
      }),
    };
    const transaction = jest.fn(async (callback: (value: typeof manager) => Promise<unknown>) => callback(manager));
    const database = {
      metadataEnabled: true,
      indexJobsEnabled: true,
      importJobsEnabled: true,
      source: { transaction },
      query: jest.fn(),
    };
    const documents = { require: jest.fn() };
    const indexJobs = { get: jest.fn() };
    const service = new DocumentImportsService(
      { indexJobMaxAttempts: 3, configFingerprint: 'test-fingerprint' } as never,
      database as never,
      {} as never,
      documents as never,
      indexJobs as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.confirm('import-1', {
      user_id: 'user-1',
      space_id: 'space-1',
      team_ids: [],
    })).rejects.toThrow('forced enqueue failure');
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(database.query).not.toHaveBeenCalled();
    expect(documents.require).not.toHaveBeenCalled();
    expect(indexJobs.get).not.toHaveBeenCalled();
  });

  it('builds image retrieval context without unsafe HTML concatenation', () => {
    const content = buildIndexContent('正文', [{
      asset_id: 'asset-1', space_id: 'space-1', owner_id: 'user-1', import_id: 'import-1',
      doc_id: null, kind: 'image', filename: 'image.png', mime_type: 'image/png',
      byte_size: 1, sha256: 'hash', storage_key: 'key', content_url: '/assets/asset-1/content',
      page_number: 2, ordinal: 1, width: null, height: null, ocr_text: '图中文字',
      description: '图像描述', analysis_status: 'ready', analysis_error: null, created_at: new Date(),
    }]);
    expect(content).toContain('## 图片可检索内容');
    expect(content).toContain('图片 1，第 2 页');
    expect(content).toContain('图中文字\n\n图像描述');
    expect(content).not.toContain('<img');
  });
});

function contractQuery(options: {
  omitColumn?: [string, string];
  omitIndex?: [string, string];
} = {}) {
  return async <T = Record<string, unknown>>(sql: string): Promise<T[]> => {
    if (sql.includes('FROM schema_migrations')) {
      return [{ version: CURRENT_SCHEMA_VERSION }] as T[];
    }
    if (sql.includes('information_schema.COLUMNS')) {
      return Object.entries(REQUIRED_SCHEMA_COLUMNS).flatMap(([table, columns]) =>
        columns
          .filter((column) => options.omitColumn?.[0] !== table || options.omitColumn[1] !== column)
          .map((column) => ({ table_name: table, column_name: column })),
      ) as T[];
    }
    if (sql.includes('information_schema.STATISTICS')) {
      return Object.entries(REQUIRED_SCHEMA_INDEXES).flatMap(([table, indexes]) =>
        indexes
          .filter((index) => options.omitIndex?.[0] !== table || options.omitIndex[1] !== index)
          .map((index) => ({ table_name: table, index_name: index })),
      ) as T[];
    }
    throw new Error(`Unexpected schema query: ${sql}`);
  };
}

function importRow() {
  const now = new Date();
  return {
    import_id: 'import-1', space_id: 'space-1', owner_id: 'user-1', visibility: 'public',
    team_id: null, tags: '[]', folder: null, title: 'Transactional import', filename: 'source.docx',
    mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    file_size: 1, sha256: 'hash', source_asset_id: 'source-1', status: 'review_ready', progress: 90,
    stage: 'review', parsed_content: 'transactional content', editor_content: null,
    parser_version: 'docling/test', error: null, document_id: null, latest_job_id: 'import-job-1',
    created_at: now, updated_at: now,
  };
}
