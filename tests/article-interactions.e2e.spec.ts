import supertest from "supertest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { bootstrap } from "../src/main.js";

describe("article comments, likes and favorites", () => {
  let app: NestFastifyApplication;
  let api: ReturnType<typeof supertest>;
  let alice: string;
  let bob: string;
  const auth = (token = alice) => ({ Authorization: `Bearer ${token}` });
  const article = async (visibility = "public") =>
    (
      await api
        .post("/documents")
        .set(auth())
        .send({
          title: "互动文章",
          content: "正文",
          visibility,
          source_type: "public_article",
          index_now: false,
        })
        .expect(201)
    ).body.doc_id as string;
  beforeAll(async () => {
    app = await bootstrap();
    await app.getHttpAdapter().getInstance().ready();
    api = supertest(app.getHttpServer());
    alice = (
      await api
        .post("/dev/auth/login")
        .send({ email: "alice@livedoc.local", password: "Demo@123456" })
    ).body.token;
    bob = (
      await api
        .post("/dev/auth/login")
        .send({ email: "bob@livedoc.local", password: "Demo@123456" })
    ).body.token;
  }, 30000);
  afterAll(async () => {
    await app.close();
  });

  test("permanent deletion removes interactions before the document ID can be reused", async () => {
    const id = await article();
    await api.put(`/articles/${id}/like`).set(auth()).expect(200);
    await api.put(`/articles/${id}/favorite`).set(auth()).expect(200);
    await api
      .post(`/articles/${id}/comments`)
      .set(auth())
      .send({ content: "旧文章的评论" })
      .expect(201);
    await api.delete(`/documents/${id}`).set(auth()).expect(200);
    await api
      .post("/documents")
      .set(auth())
      .send({
        doc_id: id,
        title: "新文章",
        content: "正文",
        visibility: "public",
        source_type: "public_article",
        index_now: false,
      })
      .expect(201);
    expect(
      (await api.get(`/articles/${id}/interactions`).set(auth())).body,
    ).toMatchObject({
      liked: false,
      favorited: false,
      like_count: 0,
      favorite_count: 0,
      comment_count: 0,
    });
  });

  test("reading is public, writes require login, private documents reject interactions", async () => {
    const id = await article();
    const privateId = await article("private");
    await api.get(`/public/articles/${id}/comments`).expect(200);
    await api.get(`/articles/${id}/interactions`).expect(401);
    await api.put(`/articles/${id}/like`).expect(401);
    await api.put(`/articles/${id}/favorite`).expect(401);
    await api
      .post(`/articles/${id}/comments`)
      .send({ content: "hello" })
      .expect(401);
    await api.get(`/public/articles/${privateId}/comments`).expect(404);
    await api.put(`/articles/${privateId}/like`).set(auth()).expect(404);
    await api.put(`/articles/${privateId}/favorite`).set(auth()).expect(404);
    await api
      .post(`/articles/${privateId}/comments`)
      .set(auth())
      .send({ content: "hidden" })
      .expect(404);
    await api.get("/articles/favorites").expect(401);
  });
  test("duplicate/concurrent likes count once per account; unlike is idempotent", async () => {
    const id = await article();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        api.put(`/articles/${id}/like`).set(auth()),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(
      (await api.get(`/articles/${id}/interactions`).set(auth())).body,
    ).toMatchObject({ liked: true, like_count: 1, favorited: false });
    expect(
      (await api.get(`/articles/${id}/interactions`).set(auth(bob))).body.liked,
    ).toBe(false);
    await api.put(`/articles/${id}/like`).set(auth(bob)).expect(200);
    expect((await api.get(`/public/articles/${id}`)).body.like_count).toBe(2);
    await api.delete(`/articles/${id}/like`).set(auth()).expect(200);
    await api.delete(`/articles/${id}/like`).set(auth()).expect(200);
    expect(
      (await api.get(`/articles/${id}/interactions`).set(auth())).body,
    ).toMatchObject({ liked: false, like_count: 1 });
  });
  test("favorites are persistent, account scoped, paginated and removable", async () => {
    const first = await article();
    const second = await article();
    await api.put(`/articles/${first}/favorite`).set(auth()).expect(200);
    await api.put(`/articles/${first}/favorite`).set(auth()).expect(200);
    await api.put(`/articles/${second}/favorite`).set(auth()).expect(200);
    const page1 = (
      await api.get("/articles/favorites?page_size=1").set(auth()).expect(200)
    ).body;
    const page2 = (
      await api
        .get("/articles/favorites?page=2&page_size=1")
        .set(auth())
        .expect(200)
    ).body;
    expect(page1.total).toBe(2);
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0].doc_id).not.toBe(page2.items[0].doc_id);
    expect(
      (await api.get("/articles/favorites").set(auth(bob))).body.total,
    ).toBe(0);
    expect(
      (await api.get(`/public/articles/${first}`)).body.favorite_count,
    ).toBe(1);
    await api.delete(`/articles/${first}/favorite`).set(auth()).expect(200);
    expect((await api.get("/articles/favorites").set(auth())).body.total).toBe(
      1,
    );
  });
  test("comments validate text, preserve plain text, dedupe retries, paginate and restrict deletion", async () => {
    const id = await article();
    await api
      .post(`/articles/${id}/comments`)
      .set(auth())
      .send({ content: "   " })
      .expect(422);
    await api
      .post(`/articles/${id}/comments`)
      .set(auth())
      .send({ content: "x".repeat(1001) })
      .expect(422);
    await api
      .post(`/articles/${id}/comments`)
      .set(auth())
      .send({ content: "x", user_id: "user_bob" })
      .expect(422);
    const payload = {
      content: "  <script>alert(1)</script>\n真实评论  ",
      comment_id: "retry_comment_123456",
    };
    const first = (
      await api
        .post(`/articles/${id}/comments`)
        .set(auth())
        .send(payload)
        .expect(201)
    ).body;
    expect(first).toMatchObject({
      author_name: "Alice",
      user_id: "user_alice",
      content: payload.content.trim(),
    });
    expect(first).not.toHaveProperty("email");
    await api
      .post(`/articles/${id}/comments`)
      .set(auth())
      .send(payload)
      .expect(201);
    await api
      .post(`/articles/${id}/comments`)
      .set(auth(bob))
      .send(payload)
      .expect(409);
    await api
      .post(`/articles/${id}/comments`)
      .set(auth(bob))
      .send({ content: "Bob 的评论" })
      .expect(201);
    const list = (
      await api.get(`/public/articles/${id}/comments?page_size=1`).expect(200)
    ).body;
    expect(list.total).toBe(2);
    expect(list.items).toHaveLength(1);
    expect((await api.get(`/public/articles/${id}`)).body.comment_count).toBe(
      2,
    );
    await api
      .delete(`/articles/${id}/comments/${first.comment_id}`)
      .set(auth(bob))
      .expect(403);
    const other = await article();
    await api
      .delete(`/articles/${other}/comments/${first.comment_id}`)
      .set(auth())
      .expect(404);
    await api
      .delete(`/articles/${id}/comments/${first.comment_id}`)
      .set(auth())
      .expect(200);
    expect((await api.get(`/public/articles/${id}/comments`)).body.total).toBe(
      1,
    );
  });
  test("replies stay in their article thread, dedupe retries and paginate chronologically", async () => {
    const id = await article();
    const other = await article();
    const parent = (
      await api
        .post(`/articles/${id}/comments`)
        .set(auth())
        .send({ content: "讨论" })
        .expect(201)
    ).body;
    const payload = {
      content: "Bob 的回复",
      parent_comment_id: parent.comment_id,
      comment_id: "reply_retry_12345678",
    };
    await api.post(`/articles/${id}/comments`).send(payload).expect(401);
    await api
      .post(`/articles/${other}/comments`)
      .set(auth(bob))
      .send(payload)
      .expect(404);
    const reply = (
      await api
        .post(`/articles/${id}/comments`)
        .set(auth(bob))
        .send(payload)
        .expect(201)
    ).body;
    expect(reply).toMatchObject({
      parent_comment_id: parent.comment_id,
      author_name: "Bob",
    });
    await api
      .post(`/articles/${id}/comments`)
      .set(auth(bob))
      .send(payload)
      .expect(201);
    await api
      .post(`/articles/${id}/comments`)
      .set(auth(bob))
      .send({ ...payload, parent_comment_id: undefined })
      .expect(409);
    await api
      .post(`/articles/${id}/comments`)
      .set(auth())
      .send({ content: "嵌套", parent_comment_id: reply.comment_id })
      .expect(422);
    await api
      .post(`/articles/${id}/comments`)
      .set(auth())
      .send({ content: "第二条回复", parent_comment_id: parent.comment_id })
      .expect(201);
    const roots = (await api.get(`/public/articles/${id}/comments`).expect(200))
      .body;
    expect(roots).toMatchObject({ total: 1, comment_count: 3 });
    expect(roots.items[0].reply_count).toBe(2);
    const first = (
      await api
        .get(
          `/public/articles/${id}/comments/${parent.comment_id}/replies?page_size=1`,
        )
        .expect(200)
    ).body;
    const second = (
      await api
        .get(
          `/public/articles/${id}/comments/${parent.comment_id}/replies?page_size=1&page=2`,
        )
        .expect(200)
    ).body;
    expect(first.total).toBe(2);
    expect(first.items[0].content).toBe("Bob 的回复");
    expect(second.items[0].content).toBe("第二条回复");
    await api
      .get(`/public/articles/${other}/comments/${parent.comment_id}/replies`)
      .expect(404);
    await api
      .delete(`/articles/${id}/comments/${reply.comment_id}`)
      .set(auth())
      .expect(403);
  });
  test("deleting a parent preserves others' replies and deleting the last reply removes the empty thread", async () => {
    const id = await article();
    const parent = (
      await api
        .post(`/articles/${id}/comments`)
        .set(auth())
        .send({ content: "原评论" })
        .expect(201)
    ).body;
    const reply = (
      await api
        .post(`/articles/${id}/comments`)
        .set(auth(bob))
        .send({ content: "保留的回复", parent_comment_id: parent.comment_id })
        .expect(201)
    ).body;
    await api
      .delete(`/articles/${id}/comments/${parent.comment_id}`)
      .set(auth())
      .expect(200);
    const roots = (await api.get(`/public/articles/${id}/comments`).expect(200))
      .body;
    expect(roots).toMatchObject({ total: 1, comment_count: 1 });
    expect(roots.items[0]).toMatchObject({
      content: "",
      deleted: true,
      reply_count: 1,
    });
    expect(
      (
        await api.get(
          `/public/articles/${id}/comments/${parent.comment_id}/replies`,
        )
      ).body.items[0].content,
    ).toBe("保留的回复");
    await api
      .post(`/articles/${id}/comments`)
      .set(auth(bob))
      .send({
        content: "不能回复已删除评论",
        parent_comment_id: parent.comment_id,
      })
      .expect(404);
    await api
      .delete(`/articles/${id}/comments/${reply.comment_id}`)
      .set(auth(bob))
      .expect(200);
    expect(
      (await api.get(`/public/articles/${id}/comments`)).body,
    ).toMatchObject({ total: 0, comment_count: 0 });
  });
  test("withdrawal hides all interactions; republishing preserves them", async () => {
    const created = (
      await api.post("/articles").set(auth()).send({}).expect(201)
    ).body;
    const id = created.article_id;
    await api
      .post(`/articles/${id}/comments`)
      .set(auth())
      .send({ content: "尚未发布" })
      .expect(404);
    const saved = (
      await api
        .patch(`/articles/${id}`)
        .set(auth())
        .send({ title: "可撤回", content: "公开正文", expected_version: 1 })
        .expect(200)
    ).body;
    await api
      .post(`/articles/${id}/publish`)
      .set(auth())
      .send({ expected_version: saved.draft_version })
      .expect(201);
    await api.put(`/articles/${id}/like`).set(auth()).expect(200);
    await api.put(`/articles/${id}/favorite`).set(auth()).expect(200);
    const preservedComment = (
      await api
        .post(`/articles/${id}/comments`)
        .set(auth())
        .send({ content: "保留这条评论" })
        .expect(201)
    ).body;
    await api
      .post(`/articles/${id}/comments`)
      .set(auth(bob))
      .send({
        content: "保留回复",
        parent_comment_id: preservedComment.comment_id,
      })
      .expect(201);
    const withdrawn = (
      await api
        .post(`/articles/${id}/withdraw`)
        .set(auth())
        .send({ expected_version: saved.draft_version })
        .expect(201)
    ).body;
    await api.get(`/public/articles/${id}/comments`).expect(404);
    await api
      .get(
        `/public/articles/${id}/comments/${preservedComment.comment_id}/replies`,
      )
      .expect(404);
    await api.get(`/articles/${id}/interactions`).set(auth()).expect(404);
    await api.put(`/articles/${id}/like`).set(auth()).expect(404);
    await api
      .post(`/articles/${id}/comments`)
      .set(auth())
      .send({ content: "不应写入" })
      .expect(404);
    expect(
      (await api.get("/articles/favorites").set(auth())).body.items.some(
        (r: { doc_id: string }) => r.doc_id === id,
      ),
    ).toBe(false);
    await api
      .post(`/articles/${id}/publish`)
      .set(auth())
      .send({ expected_version: withdrawn.draft_version })
      .expect(201);
    expect(
      (await api.get(`/articles/${id}/interactions`).set(auth())).body,
    ).toMatchObject({
      liked: true,
      favorited: true,
      like_count: 1,
      favorite_count: 1,
      comment_count: 2,
    });
    expect(
      (await api.get(`/public/articles/${id}/comments`)).body.items[0].content,
    ).toBe("保留这条评论");
  });
});
