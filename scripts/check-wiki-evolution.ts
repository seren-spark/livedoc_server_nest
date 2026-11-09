// Real MySQL verification; reads/writes only newly created private synthetic fixtures.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AppConfig } from "../src/config/app-config.js";
import { DatabaseService } from "../src/database/database.service.js";
import { DocumentsService } from "../src/documents/documents.service.js";
import { WikiRepository } from "../src/wiki/wiki.repository.js";
import { WikiService, wikiHash } from "../src/wiki/wiki.service.js";
import type { WikiPage } from "../src/wiki/wiki.types.js";

const config = new AppConfig();
assert.equal(config.metadataStore, "mysql");
assert.notEqual(process.env.LIVEDOC_RUN_MIGRATIONS, "true");
const db = new DatabaseService(config);
const marker = `wiki_evo_${randomUUID().replaceAll("-", "")}`;
const context = { user_id: marker, space_id: marker, team_ids: [`${marker}_team`] };
const foreign = { ...context, user_id: `${marker}_other`, team_ids: [`${marker}_other_team`] };
const scope = { private: true, public: false, team: true, document_ids: [] as string[] };
const documentIds: string[] = [], wikiIds: string[] = [];
try {
  await db.onModuleInit();
  const documents = new DocumentsService(db);
  const create = async (owner = context, team = false) => {
    const record = await documents.create({
      title: "Synthetic Wiki scope check", content: "Synthetic proof only", source_type: "note",
      tags: [], asset_ids: [],
      visibility: team ? "team" : "private", team_id: team ? owner.team_ids[0]! : undefined, index_now: false,
    }, owner);
    documentIds.push(record.doc_id);
    return record;
  };
  const a = await create();
  await create(context, true);
  const initial = await documents.knowledgeFingerprint(scope, context);
  await create(foreign);
  await create(foreign, true);
  assert.equal(await documents.knowledgeFingerprint(scope, context), initial);
  const selected = { ...scope, document_ids: [a.doc_id] };
  const selectedBefore = await documents.knowledgeFingerprint(selected, context);
  await create();
  assert.notEqual(await documents.knowledgeFingerprint(scope, context), initial);
  assert.equal(await documents.knowledgeFingerprint(selected, context), selectedBefore);
  const updated = await documents.update(a.doc_id, { expected_version: 1, content: "Updated synthetic proof" }, context);
  assert.notEqual(await documents.knowledgeFingerprint(selected, context), selectedBefore);
  const repository = new WikiRepository(db);
  const deleted: string[] = [];
  const searched: string[][] = [];
  const searchIds: string[] = [];
  const service = new WikiService(config, repository, documents, {
    searchWikiWithTrace: async (input: any, _owner: any, authorize: any) => {
      assert.deepEqual(input.scope.document_ids, []);
      const hits = await authorize(searchIds.map(id => ({ pointId: id, score: 1, payload: { doc_id: id, document_version: 1 } })));
      searched.push(hits.map((hit: any) => hit.payload.doc_id));
      return { citations: hits.map((hit: any) => ({ doc_id: hit.payload.doc_id, document_version: 1 })) };
    },
  } as any,
    { deleteDocument: async (id: string) => { deleted.push(id); } } as any, {} as any);
  const snapshot = await service.knowledgeSnapshot(selected, context);
  const now = new Date();
  const page = (id: string, parents: Array<{ wiki_id: string; revision: number }> = []): WikiPage => ({
    wiki_id: id, space_id: context.space_id, owner_id: context.user_id, origin_run_id: randomUUID(),
    revision: 1, status: "published", created_at: now, updated_at: now,
    payload: {
      title: "Synthetic Wiki dependency", question: "Synthetic only", markdown: "Updated synthetic proof [c]",
      sources: [{ citation_id: "c", doc_id: a.doc_id, title: a.title, version: updated.document_version,
        start_offset: 0, end_offset: updated.content.length, excerpt_hash: wikiHash(updated.content) }],
      parents, knowledge_snapshot: snapshot, review: { passed: true, issues: [] },
      usage: { model_requests: 0, prompt_tokens: 0, completion_tokens: 0 },
    },
  });
  const root = `${marker}_a`, child = `${marker}_b`, grandchild = `${marker}_c`, independent = `${marker}_d`, outsider = `${marker}_f`;
  const proof = { wiki_id: root, revision: 1 };
  for (const value of [page(root), page(child, [proof]), page(grandchild, [proof, { wiki_id: child, revision: 1 }]),
    page(independent), { ...page(outsider, [proof]), owner_id: foreign.user_id }]) {
    if (value.wiki_id === child || value.wiki_id === grandchild) {
      value.payload.topic_id = root;
      value.payload.supersedes = { wiki_id: value.wiki_id === child ? root : child, revision: 1 };
    }
    wikiIds.push(value.wiki_id);
    await repository.insert(value);
    searchIds.push(value.wiki_id);
  }
  const rootPage = (await repository.get(root, context))!;
  rootPage.payload.capture_hash = marker;
  await repository.transition(rootPage, ["published"], "published");
  for (let index = 0; index < 101; index++) {
    const filler = { ...page(`${marker}_filler_${index}`), status: "draft" as const,
      updated_at: new Date(Date.now() + index + 1000) };
    wikiIds.push(filler.wiki_id);
    await repository.insert(filler);
  }
  assert.equal((await repository.list(context)).some(page => page.wiki_id === root), false);
  // New repository reads JSON as MySQL stored it, including normalized key order.
  const fresh = new WikiRepository(db);
  assert.equal((await fresh.byCaptureHash(marker, context))?.wiki_id, root);
  assert.equal(await fresh.byCaptureHash(marker, foreign), undefined);
  assert.deepEqual((await fresh.successors([proof], context)).map(page => page.wiki_id), [child]);
  assert.deepEqual(await fresh.successors([{ ...proof, revision: 2 }], context), []);
  assert.deepEqual((await fresh.dependents([proof], context)).map(row => row.wiki_id).sort(), [child, grandchild].sort());
  assert.equal((await fresh.dependents([{ wiki_id: root, revision: 2 }], context)).length, 0);
  assert.equal((await fresh.get(grandchild, context))?.payload.topic_id, root);
  assert.deepEqual((await fresh.get(grandchild, context))?.payload.supersedes, { wiki_id: child, revision: 1 });
  const discovered = await service.search("synthetic", selected, context, new AbortController().signal);
  assert.deepEqual(searched[0]!.sort(), [grandchild, independent].sort());
  assert.equal(discovered.length, 2);
  await service.validateProofs([{ wiki_id: grandchild, revision: 1 }], context);
  await service.answerFeedback({ run_id: "not-a-fixture-run", payload: { wiki_reads: [proof] } } as any, context, "incorrect");
  for (const id of [root, child, grandchild]) assert.equal((await fresh.get(id, context))?.status, "archived");
  assert.equal((await fresh.get(independent, context))?.status, "published");
  assert.equal((await fresh.get(outsider, foreign))?.status, "published");
  assert.deepEqual(deleted.sort(), [root, child, grandchild].sort());
  const stale = (await fresh.get(independent, context))!;
  assert.equal(await fresh.annotate(stale, "conflicted_by_run", "synthetic-conflict"), true);
  assert.equal(await fresh.annotate(stale, "user_feedback", "helpful"), true);
  const annotated = (await new WikiRepository(db).get(independent, context))!;
  assert.equal(annotated.payload.conflicted_by_run, "synthetic-conflict");
  assert.equal(annotated.payload.user_feedback, "helpful");
  console.log(JSON.stringify({ real_mysql: true, synthetic_only: true, authorized_scope_fingerprint: "passed",
    selected_range_isolation: "passed", document_update: "passed", json_parent_lookup: "passed",
    version_match: "passed", persistent_cascade: "passed", independent_and_owner_isolation: "passed" }));
  console.log(JSON.stringify({ immutable_topic_metadata: "passed", latest_topic_selection: "passed", concurrent_annotation: "passed" }));
  console.log(JSON.stringify({ discovery_beyond_100: "passed", exact_dedupe_beyond_100: "passed", batched_owner_lookup: "passed" }));
} finally {
  if (db.source.isInitialized) {
    for (const id of wikiIds) await db.query("DELETE FROM wiki_pages WHERE wiki_id=? AND space_id=?", [id, marker]);
    for (const id of documentIds) await db.query("DELETE FROM knowledge_documents WHERE doc_id=? AND space_id=?", [id, marker]);
    await db.onModuleDestroy();
    console.log(JSON.stringify({ synthetic_cleanup: "deleted", documents: documentIds.length, wiki_pages: wikiIds.length }));
  }
}
