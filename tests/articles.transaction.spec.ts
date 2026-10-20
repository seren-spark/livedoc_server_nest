import { jest } from "@jest/globals";
import { ArticlesService } from "../src/articles/articles.service.js";
import { ArticleRepository } from "../src/articles/article.repository.js";
import { IndexJobsService } from "../src/indexing/index-jobs.service.js";

test("publication rolls back its public snapshot and draft state when transactional enqueue fails", async () => {
  const now = new Date();
  const row = {
    article_id: "transaction-article",
    owner_id: "alice",
    space_id: "space",
    state: "draft",
    draft_version: 2,
    draft: {
      title: "文章",
      content: "正文",
      editor_content: null,
      summary: "",
      tags: [],
      cover_asset_id: null,
      asset_ids: [],
    },
    published_metadata: null,
    published_draft_version: null,
    published_at: null,
    last_published_at: null,
    created_at: now,
    updated_at: now,
  };
  const statements: string[] = [];
  let committed = false;
  const manager = {
    query: jest.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes("FROM article_drafts")) return [row];
      if (sql.includes("FROM knowledge_documents")) return [];
      if (sql.startsWith("INSERT INTO knowledge_documents")) return [];
      if (sql.includes("WHERE dedupe_key=")) return [];
      if (sql.includes("COALESCE(MAX(generation)")) return [{ generation: 0 }];
      if (sql.startsWith("INSERT INTO index_jobs"))
        throw new Error("forced enqueue failure");
      throw new Error("Unexpected SQL");
    }),
  };
  const database = {
    metadataEnabled: true,
    indexJobsEnabled: true,
    query: jest.fn(),
    transaction: jest.fn(async (work: (m: typeof manager) => Promise<void>) => {
      await work(manager);
      committed = true;
    }),
  };
  const config = { indexJobMaxAttempts: 3, configFingerprint: "test" };
  const repository = new ArticleRepository(database as never);
  const jobs = new IndexJobsService(config as never, database as never);
  const service = new ArticlesService(
    repository,
    {} as never,
    {} as never,
    jobs,
    {} as never,
    config as never,
  );
  await expect(
    service.publish(row.article_id, 2, {
      user_id: "alice",
      space_id: "space",
      team_ids: [],
    }),
  ).rejects.toThrow("forced enqueue failure");
  expect(database.transaction).toHaveBeenCalledTimes(1);
  expect(database.query).not.toHaveBeenCalled();
  expect(committed).toBe(false);
  expect(
    statements.some((sql) => sql.startsWith("INSERT INTO knowledge_documents")),
  ).toBe(true);
  expect(
    statements.some((sql) => sql.startsWith("INSERT INTO article_drafts")),
  ).toBe(false);
});
