import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import supertest from "supertest";

process.env.LIVEDOC_SKIP_AUTO_START = "true";
const { bootstrap } = await import("../src/main.js");
const app = await bootstrap();
const { DatabaseService } = await import("../src/database/database.service.js");
const { VectorStoreService } = await import(
  "../src/retrieval/vector-store.service.js"
);
const { IndexJobsService } = await import(
  "../src/indexing/index-jobs.service.js"
);
await app.getHttpAdapter().getInstance().ready();
const database = app.get(DatabaseService);
assert(database.metadataEnabled, "Interaction validation requires real MySQL");
const api = supertest(app.getHttpServer());
const cleanupArg = process.argv
  .find((arg) => arg.startsWith("--cleanup="))
  ?.slice("--cleanup=".length);
const id =
  cleanupArg ?? "interaction_check_" + randomUUID().replaceAll("-", "");
assert(
  /^interaction_check_[a-f0-9]{32}$/.test(id),
  "Only this validation workflow's fixture IDs may be used",
);
const keepData = process.argv.includes("--keep-data");
const report = { article_id: id, checks: [] as string[], completed_at: "" };
const check = (name: string) => {
  report.checks.push(name);
  console.log("PASS " + name);
};
async function cleanup() {
  const rows = await database.query<{ owner_id: string; draft: unknown }>(
    "SELECT owner_id,draft FROM article_drafts WHERE article_id=?",
    [id],
  );
  if (!rows.length) return;
  const draft =
    typeof rows[0]!.draft === "string"
      ? JSON.parse(rows[0]!.draft)
      : (rows[0]!.draft as { title: string });
  assert(
    rows[0]!.owner_id === "user_alice" && draft.title.startsWith("互动验收："),
    "Refusing to remove a non-validation article",
  );
  await app.get(IndexJobsService).cancelDocument(id);
  await app.get(VectorStoreService).deleteDocument(id);
  await database.transaction(async (manager) => {
    await manager.query("DELETE FROM article_comments WHERE article_id=?", [
      id,
    ]);
    await manager.query("DELETE FROM article_reactions WHERE article_id=?", [
      id,
    ]);
    await manager.query("DELETE FROM index_jobs WHERE doc_id=?", [id]);
    await manager.query("DELETE FROM knowledge_documents WHERE doc_id=?", [id]);
    await manager.query("DELETE FROM article_drafts WHERE article_id=?", [id]);
  });
}
try {
  if (cleanupArg) {
    await cleanup();
    console.log("Removed validation fixture " + id);
  } else {
    const login = async (email: string) =>
      (
        await api
          .post("/dev/auth/login")
          .send({
            email,
            password: process.env.RAG_EVAL_PASSWORD ?? "Demo@123456",
          })
          .expect(200)
      ).body.token as string;
    const alice = {
      Authorization: "Bearer " + (await login("alice@livedoc.local")),
    };
    const bob = {
      Authorization: "Bearer " + (await login("bob@livedoc.local")),
    };
    await api.post("/articles").set(alice).send({ article_id: id }).expect(201);
    const saved = (
      await api
        .patch("/articles/" + id)
        .set(alice)
        .send({
          title: "互动验收：评论、点赞与收藏",
          content:
            "# 文章互动\n\n这篇临时文章用于验证评论、点赞与收藏。每一次互动都存入数据库，刷新页面后仍然保留。",
          expected_version: 1,
        })
        .expect(200)
    ).body;
    await api
      .post("/articles/" + id + "/publish")
      .set(alice)
      .send({ expected_version: saved.draft_version })
      .expect(201);
    await api
      .put("/articles/" + id + "/like")
      .set(alice)
      .expect(200);
    await api
      .put("/articles/" + id + "/like")
      .set(alice)
      .expect(200);
    await api
      .put("/articles/" + id + "/favorite")
      .set(alice)
      .expect(200);
    let mine = (
      await api
        .get("/articles/" + id + "/interactions")
        .set(alice)
        .expect(200)
    ).body;
    assert(
      mine.liked &&
        mine.favorited &&
        mine.like_count === 1 &&
        mine.favorite_count === 1,
    );
    check("MySQL 点赞/收藏持久化与重复操作去重");
    assert(
      (
        await api.get("/articles/favorites").set(alice).expect(200)
      ).body.items.some((r: { doc_id: string }) => r.doc_id === id),
    );
    assert(
      !(
        await api.get("/articles/favorites").set(bob).expect(200)
      ).body.items.some((r: { doc_id: string }) => r.doc_id === id),
    );
    check("收藏列表关联查询与账号隔离");
    const commentId = randomUUID().replaceAll("-", "");
    const payload = {
      content: "评论已真实保存，可以在浏览器中查看。",
      comment_id: commentId,
    };
    await api
      .post("/articles/" + id + "/comments")
      .set(alice)
      .send(payload)
      .expect(201);
    await api
      .post("/articles/" + id + "/comments")
      .set(alice)
      .send(payload)
      .expect(201);
    const comments = (
      await api.get("/public/articles/" + id + "/comments").expect(200)
    ).body;
    assert.equal(comments.total, 1);
    assert.equal(comments.items[0].author_name, "Alice");
    await api
      .delete("/articles/" + id + "/comments/" + commentId)
      .set(bob)
      .expect(403);
    const publicArticle = (await api.get("/public/articles/" + id).expect(200))
      .body;
    assert.equal(publicArticle.comment_count, 1);
    check("评论持久化、匿名阅读、真实作者与删除权限");
    const replyPayload = {
      content: "回复也已真实保存，按评论分组展示。",
      comment_id: randomUUID().replaceAll("-", ""),
      parent_comment_id: commentId,
    };
    await api
      .post(`/articles/${id}/comments`)
      .set(bob)
      .send(replyPayload)
      .expect(201);
    await api
      .post(`/articles/${id}/comments`)
      .set(bob)
      .send(replyPayload)
      .expect(201);
    await api
      .post(`/articles/${id}/comments`)
      .set(alice)
      .send({ content: "感谢交流！", parent_comment_id: commentId })
      .expect(201);
    const threads = (
      await api.get(`/public/articles/${id}/comments`).expect(200)
    ).body;
    assert.equal(threads.total, 1);
    assert.equal(threads.comment_count, 3);
    assert.equal(threads.items[0].reply_count, 2);
    const replies = (
      await api
        .get(`/public/articles/${id}/comments/${commentId}/replies?page_size=1`)
        .expect(200)
    ).body;
    assert.equal(replies.total, 2);
    assert.equal(replies.items[0].author_name, "Bob");
    assert.equal(
      (
        await api
          .get(
            `/public/articles/${id}/comments/${commentId}/replies?page_size=1&page=2`,
          )
          .expect(200)
      ).body.items[0].content,
      "感谢交流！",
    );
    await api
      .delete(`/articles/${id}/comments/${replyPayload.comment_id}`)
      .set(alice)
      .expect(403);
    check("MySQL 回复关联、幂等重试、匿名分页与回复删除权限");
    await api
      .delete("/articles/" + id + "/like")
      .set(alice)
      .expect(200);
    await api
      .delete("/articles/" + id + "/favorite")
      .set(alice)
      .expect(200);
    mine = (
      await api
        .get("/articles/" + id + "/interactions")
        .set(alice)
        .expect(200)
    ).body;
    assert(
      !mine.liked &&
        !mine.favorited &&
        mine.like_count === 0 &&
        mine.favorite_count === 0,
    );
    check("取消点赞与取消收藏");
    await api
      .put("/articles/" + id + "/like")
      .set(alice)
      .expect(200);
    await api
      .put("/articles/" + id + "/favorite")
      .set(alice)
      .expect(200);
    const withdrawn = (
      await api
        .post("/articles/" + id + "/withdraw")
        .set(alice)
        .send({ expected_version: saved.draft_version })
        .expect(201)
    ).body;
    await api.get("/public/articles/" + id + "/comments").expect(404);
    await api
      .get(`/public/articles/${id}/comments/${commentId}/replies`)
      .expect(404);
    assert(
      !(
        await api.get("/articles/favorites").set(alice).expect(200)
      ).body.items.some((r: { doc_id: string }) => r.doc_id === id),
    );
    await api
      .post("/articles/" + id + "/publish")
      .set(alice)
      .send({ expected_version: withdrawn.draft_version })
      .expect(201);
    mine = (
      await api
        .get("/articles/" + id + "/interactions")
        .set(alice)
        .expect(200)
    ).body;
    assert(mine.liked && mine.favorited && mine.comment_count === 3);
    check("撤回隐藏互动，重新发布保留记录");
    if (!keepData) {
      await api
        .delete(`/articles/${id}/comments/${commentId}`)
        .set(alice)
        .expect(200);
      const remaining = (
        await api.get(`/public/articles/${id}/comments`).expect(200)
      ).body;
      assert.equal(remaining.items[0].deleted, true);
      assert.equal(remaining.items[0].content, "");
      assert.equal(remaining.comment_count, 2);
      assert.equal(
        (
          await api
            .get(`/public/articles/${id}/comments/${commentId}/replies`)
            .expect(200)
        ).body.total,
        2,
      );
      check("删除原评论保留回复，正文清空且计数正确");
    }
    report.completed_at = new Date().toISOString();
    await mkdir("data/validation", { recursive: true });
    await writeFile(
      "data/validation/article-interactions-latest.json",
      JSON.stringify(report, null, 2),
    );
    console.log("Article fixture: " + id);
  }
} finally {
  try {
    if (!keepData && !cleanupArg) await cleanup();
  } finally {
    await app.close();
  }
}
