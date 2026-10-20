import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import supertest from "supertest";

process.env.LIVEDOC_SKIP_AUTO_START = "true";
const { bootstrap } = await import("../src/main.js");
const app = await bootstrap();
const { DatabaseService } = await import("../src/database/database.service.js");
const { IndexWorkerService } = await import(
  "../src/indexing/index-worker.service.js"
);
const { VectorStoreService } = await import(
  "../src/retrieval/vector-store.service.js"
);
const { AssetsService } = await import(
  "../src/documents/assets/assets.service.js"
);
await app.getHttpAdapter().getInstance().ready();
const api = supertest(app.getHttpServer());
const database = app.get(DatabaseService);
assert(database.metadataEnabled, "This validation requires real MySQL");
const id = "article_check_" + randomUUID().replaceAll("-", "");
const marker = "文章验收标识 " + randomUUID().slice(0, 8);
const report = { article_id: id, checks: [] as string[], completed_at: "" };
const check = (name: string) => {
  report.checks.push(name);
  console.log("PASS " + name);
};
try {
  const token = (
    await api
      .post("/dev/auth/login")
      .send({
        email: "alice@livedoc.local",
        password: process.env.RAG_EVAL_PASSWORD ?? "Demo@123456",
      })
      .expect(200)
  ).body.token;
  const auth = { Authorization: "Bearer " + String(token) };
  await api.post("/articles").set(auth).send({ article_id: id }).expect(201);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3xQAAAAASUVORK5CYII=",
    "base64",
  );
  const image = (
    await api
      .post("/articles/" + id + "/assets")
      .set(auth)
      .attach("file", png, {
        filename: "article-check.png",
        contentType: "image/png",
      })
      .expect(201)
  ).body;
  const draft = {
    title: marker,
    content:
      "# " +
      marker +
      "\n\n文章验收中的秘密颜色是蓝绿色。\n\n![图](/assets/" +
      image.asset_id +
      "/content)",
    editor_content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "文章验收中的秘密颜色是蓝绿色。" }],
        },
        {
          type: "image",
          attrs: {
            src: "/assets/" + image.asset_id + "/content",
            alt: "验收图片",
          },
        },
      ],
    },
    summary: "文章生命周期真实验收",
    tags: ["验收"],
    cover_asset_id: image.asset_id,
    asset_ids: [image.asset_id],
  };
  const saved = (
    await api
      .patch("/articles/" + id)
      .set(auth)
      .send({ ...draft, expected_version: 1 })
      .expect(200)
  ).body;
  await api.get("/public/articles/" + id).expect(404);
  assert.equal(
    (await api.get("/articles/" + id).set(auth)).body.draft.content,
    draft.content,
  );
  check("MySQL 草稿持久化及匿名隔离");
  const published = (
    await api
      .post("/articles/" + id + "/publish")
      .set(auth)
      .send({ expected_version: saved.draft_version })
      .expect(201)
  ).body;
  const publicRecord = (await api.get("/public/articles/" + id).expect(200))
    .body;
  assert.equal(publicRecord.title, marker);
  await api
    .get("/public/articles/" + id + "/assets/" + image.asset_id + "/content")
    .expect(200);
  assert(
    (
      await api.get("/public/articles?page_size=100").expect(200)
    ).body.items.some((r: { doc_id: string }) => r.doc_id === id),
  );
  check("事务发布、首页展示与匿名图文阅读");
  const index = async (jobId: string) => {
    const job = await app
      .get(IndexWorkerService)
      .runOnce("article-validation", jobId);
    assert.equal(
      job?.status,
      "succeeded",
      "Real index worker failed: " + String(job?.error),
    );
  };
  await index(published.latest_index_job_id);
  const search = async () =>
    (
      await api
        .post("/knowledge/search")
        .set(auth)
        .send({
          query: marker + " 秘密颜色",
          scope: {
            public: true,
            private: false,
            team: false,
            document_ids: [id],
          },
          top_k: 10,
          mode: "hybrid",
        })
        .expect(200)
    ).body.citations;
  const hits = await search();
  assert(
    hits.some(
      (h: { doc_id: string; url: string }) =>
        h.doc_id === id && h.url === "/post/" + id,
    ),
  );
  check("真实 BGE / Qdrant 索引、检索与公开引用链接");
  const changed = (
    await api
      .patch("/articles/" + id)
      .set(auth)
      .send({
        ...draft,
        title: marker + " 更新",
        content: draft.content.replace("蓝绿色", "琥珀色"),
        expected_version: saved.draft_version,
      })
      .expect(200)
  ).body;
  assert.equal((await api.get("/public/articles/" + id)).body.title, marker);
  check("保存修改保留上一版公开内容");
  const updated = (
    await api
      .post("/articles/" + id + "/publish")
      .set(auth)
      .send({ expected_version: changed.draft_version })
      .expect(201)
  ).body;
  assert.equal(
    (await api.get("/public/articles/" + id)).body.published_at,
    publicRecord.published_at,
  );
  await index(updated.latest_index_job_id);
  assert(
    (await api.get("/public/articles/" + id)).body.content.includes("琥珀色"),
  );
  check("更新发布与重新索引");
  const withdrawn = (
    await api
      .post("/articles/" + id + "/withdraw")
      .set(auth)
      .send({ expected_version: changed.draft_version })
      .expect(201)
  ).body;
  await api.get("/public/articles/" + id).expect(404);
  await api
    .get("/public/articles/" + id + "/assets/" + image.asset_id + "/content")
    .expect(404);
  assert(!(await search()).some((h: { doc_id: string }) => h.doc_id === id));
  check("撤回关闭详情、图片与 RAG");
  const republished = (
    await api
      .post("/articles/" + id + "/publish")
      .set(auth)
      .send({ expected_version: withdrawn.draft_version })
      .expect(201)
  ).body;
  await api.get("/public/articles/" + id).expect(200);
  await index(republished.latest_index_job_id);
  check("相同链接再次发布");
  report.completed_at = new Date().toISOString();
  await mkdir("data/validation", { recursive: true });
  await writeFile(
    "data/validation/articles-latest.json",
    JSON.stringify(report, null, 2),
  );
} finally {
  // Only remove the uniquely named fixture created by this invocation.
  await app.get(VectorStoreService).deleteDocument(id);
  await app.get(AssetsService).removeWhere({ doc_id: id });
  await database.transaction(async (manager) => {
    await manager.query("DELETE FROM index_jobs WHERE doc_id=?", [id]);
    await manager.query("DELETE FROM knowledge_documents WHERE doc_id=?", [id]);
    await manager.query("DELETE FROM article_drafts WHERE article_id=?", [id]);
  });
  await app.close();
}
