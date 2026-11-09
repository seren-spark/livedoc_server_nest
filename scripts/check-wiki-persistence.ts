// Real MySQL repository check with a new synthetic row only; no model/index calls.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AppConfig } from "../src/config/app-config.js";
import { DatabaseService } from "../src/database/database.service.js";
import { WikiRepository } from "../src/wiki/wiki.repository.js";
import { AgentAuditService } from "../src/ai/agent-audit.service.js";
import type { WikiPage } from "../src/wiki/wiki.types.js";
const config = new AppConfig();
assert.equal(config.metadataStore, "mysql", "This check requires real MySQL");
assert.notEqual(process.env.LIVEDOC_RUN_MIGRATIONS, "true");
let db = new DatabaseService(config);
const id = `wiki_persistence_${randomUUID().replaceAll("-", "")}`;
const context = {
  user_id: "wiki_persistence_fixture",
  space_id: id,
  team_ids: [],
};
const now = new Date();
const page: WikiPage = {
  wiki_id: id,
  space_id: context.space_id,
  owner_id: context.user_id,
  origin_run_id: randomUUID(),
  revision: 1,
  status: "draft",
  payload: {
    title: "Synthetic repository check",
    markdown: "Synthetic only",
    question: "Synthetic only",
    sources: [],
    review: { passed: true, issues: [] },
    usage: { model_requests: 0, prompt_tokens: 0, completion_tokens: 0 },
  },
  created_at: now,
  updated_at: now,
};
try {
  await db.onModuleInit();
  let repo = new WikiRepository(db);
  await repo.insert(page);
  assert.equal(
    (await repo.insert({ ...page, wiki_id: id + "_duplicate" })).wiki_id,
    id,
  );
  assert.equal(await repo.get(id, { ...context, user_id: "other" }), undefined);
  assert.equal(await repo.transition(page, ["draft"], "indexing"), true);
  assert.equal(await repo.transition(page, ["draft"], "indexing"), false);
  await db.onModuleDestroy();
  db = new DatabaseService(config);
  await db.onModuleInit();
  repo = new WikiRepository(db);
  const loaded = await repo.get(id, context);
  assert(loaded);
  assert.equal(loaded?.status, "indexing");
  assert.equal(loaded.payload.title, page.payload.title);
  assert.equal(loaded.updated_at instanceof Date, true);
  assert.equal(
    await repo.transition(loaded, ["indexing"], "failed", "synthetic check"),
    true,
  );
  assert.equal((await repo.get(id, context))?.payload.error, "synthetic check");
  assert.equal(await repo.transition(loaded, ["failed"], "archived"), true);
  assert.equal((await repo.list(context)).length, 0);
  const audit = new AgentAuditService(db);
  await audit.begin({
    run_id: page.origin_run_id,
    request_id: page.origin_run_id,
    user_id: context.user_id,
    space_id: context.space_id,
    conversation_id: id,
    mode: "ask",
    status: "completed",
    payload: {
      marker: "synthetic",
      usage: { model_requests: 7 },
      feedback: { preserved: true },
    },
  });
  await audit.recordWikiCapture(page.origin_run_id, context, {
    status: "published",
    wiki_id: id,
    usage: { model_requests: 2, prompt_tokens: 10, completion_tokens: 5 },
  });
  await audit.recordAnswerFeedback(page.origin_run_id, context, "incorrect");
  const freshAudit = await new AgentAuditService(db).get(
    page.origin_run_id,
    context,
  );
  assert.equal(freshAudit.status, "completed");
  assert.equal(freshAudit.payload.wiki_capture.status, "published");
  assert.equal(freshAudit.payload.usage.model_requests, 7);
  assert.equal(freshAudit.payload.feedback.preserved, true);
  assert.equal(freshAudit.payload.feedback.answer, "incorrect");
  console.log(
    JSON.stringify({
      real_mysql: true,
      synthetic_only: true,
      unique_run: "passed",
      owner_isolation: "passed",
      compare_and_swap: "passed",
      reconnection_persistence: "passed",
      archive: "passed",
      background_audit_patch: "passed",
      answer_feedback_patch: "passed",
    }),
  );
} finally {
  if (db.source.isInitialized) {
    await db.query(
      "DELETE FROM wiki_pages WHERE wiki_id=? AND space_id=? AND owner_id=?",
      [id, context.space_id, context.user_id],
    );
    await db.query(
      "DELETE FROM agent_runs WHERE run_id=? AND user_id=? AND space_id=?",
      [page.origin_run_id, context.user_id, context.space_id],
    );
    await db.onModuleDestroy();
    console.log(JSON.stringify({ synthetic_cleanup: "deleted" }));
  }
}
