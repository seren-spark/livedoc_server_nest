import { jest } from "@jest/globals";
import supertest from "supertest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { bootstrap } from "../src/main.js";
import { ArticleRepository } from "../src/articles/article.repository.js";
import { ArticlesService } from "../src/articles/articles.service.js";
import { IndexWorkerService } from "../src/indexing/index-worker.service.js";
import { RetrievalService } from "../src/retrieval/retrieval.service.js";
import { VectorStoreService } from "../src/retrieval/vector-store.service.js";
import { IndexJobsService } from "../src/indexing/index-jobs.service.js";
import type { ArticleContent } from "../src/articles/article.types.js";

describe("article publication lifecycle", () => {
  let app: NestFastifyApplication;
  let api: ReturnType<typeof supertest>;
  let alice: string;
  let bob: string;
  const body = (
    title = "文章标题",
    content = "# 发布正文\n\n这是一段完整的文章内容。",
  ): ArticleContent => ({
    title,
    content,
    editor_content: null,
    summary: "",
    tags: ["写作"],
    cover_asset_id: null,
    asset_ids: [],
  });
  const headers = (token = alice) => ({ Authorization: `Bearer ${token}` });
  const context = {
    user_id: "user_alice",
    space_id: "space_a",
    team_ids: ["team_alpha"],
  };
  const create = async () =>
    (await api.post("/articles").set(headers()).send({}).expect(201)).body;
  const save = async (id: string, version: number, draft = body()) =>
    (
      await api
        .patch(`/articles/${id}`)
        .set(headers())
        .send({ ...draft, expected_version: version })
        .expect(200)
    ).body;
  const publish = async (id: string, version: number) =>
    (
      await api
        .post(`/articles/${id}/publish`)
        .set(headers())
        .send({ expected_version: version })
        .expect(201)
    ).body;
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

  test("drafts are owner scoped and never public; stale writes cannot replace content", async () => {
    await api.post("/articles").send({}).expect(401);
    const draft = await create();
    const id = draft.article_id;
    await api.get(`/articles/${id}`).expect(401);
    await api.get(`/articles/${id}`).set(headers(bob)).expect(403);
    await api
      .patch(`/articles/${id}`)
      .set(headers(bob))
      .send({ ...body(), expected_version: 1 })
      .expect(403);
    await api
      .post(`/articles/${id}/publish`)
      .set(headers(bob))
      .send({ expected_version: 1 })
      .expect(403);
    await api.get(`/public/articles/${id}`).expect(404);
    await save(id, 1);
    await api
      .patch(`/articles/${id}`)
      .set(headers())
      .send({ ...body("stale"), expected_version: 1 })
      .expect(409);
    expect(
      (await api.get(`/articles/${id}`).set(headers())).body.draft.title,
    ).toBe("文章标题");
    expect(
      (
        await api.get("/articles/mine?state=draft").set(headers())
      ).body.items.some((r: { article_id: string }) => r.article_id === id),
    ).toBe(true);
  });

  test("publish is idempotent; saved changes do not alter public snapshots or RAG; withdrawal preserves the URL", async () => {
    const draft = await create();
    const id = draft.article_id;
    const saved = await save(id, 1);
    const first = await publish(id, saved.draft_version);
    const duplicate = await publish(id, saved.draft_version);
    expect(duplicate.document_version).toBe(first.document_version);
    expect(duplicate.latest_index_job_id).toBe(first.latest_index_job_id);
    const oldPublic = (await api.get(`/public/articles/${id}`).expect(200))
      .body;
    expect(oldPublic.summary).toContain("发布正文");
    expect(oldPublic).not.toHaveProperty("draft");
    expect(oldPublic.url).toBe(`/post/${id}`);
    const changed = await save(
      id,
      saved.draft_version,
      body("新版标题", "# 新的正文\n\n稍后发布。"),
    );
    expect((await api.get(`/public/articles/${id}`)).body.title).toBe(
      "文章标题",
    );
    const repository = app.get(ArticleRepository);
    const hit = {
      pointId: "old",
      score: 1,
      payload: { doc_id: id, document_version: first.document_version },
    };
    expect(await repository.filterHits([hit])).toHaveLength(1);
    const updated = await publish(id, changed.draft_version);
    expect(updated.document_version).toBe(first.document_version + 1);
    expect(await repository.filterHits([hit])).toHaveLength(0);
    expect((await api.get(`/public/articles/${id}`)).body.title).toBe(
      "新版标题",
    );
    expect((await api.get(`/public/articles/${id}`)).body.published_at).toBe(
      oldPublic.published_at,
    );
    await api
      .patch(`/documents/${id}`)
      .set(headers())
      .send({ title: "bypass" })
      .expect(403);
    await api.delete(`/documents/${id}`).set(headers()).expect(403);
    await api.post(`/documents/${id}/reindex`).set(headers()).expect(403);
    expect(
      (await api.get("/documents").set(headers())).body.items.some(
        (r: { doc_id: string }) => r.doc_id === id,
      ),
    ).toBe(false);
    const withdrawn = (
      await api
        .post(`/articles/${id}/withdraw`)
        .set(headers())
        .send({ expected_version: changed.draft_version })
        .expect(201)
    ).body;
    expect(withdrawn.draft.title).toBe("新版标题");
    await api.get(`/public/articles/${id}`).expect(404);
    expect(
      (await api.get("/public/articles")).body.items.some(
        (r: { doc_id: string }) => r.doc_id === id,
      ),
    ).toBe(false);
    expect(
      await repository.filterHits([
        {
          ...hit,
          payload: {
            ...hit.payload,
            document_version: updated.document_version,
          },
        },
      ]),
    ).toHaveLength(0);
    await publish(id, withdrawn.draft_version);
    expect((await api.get(`/public/articles/${id}`).expect(200)).body.url).toBe(
      `/post/${id}`,
    );
  });

  test("only published image references are anonymous; old images survive draft changes", async () => {
    const { article_id: id } = await create();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3xQAAAAASUVORK5CYII=",
      "base64",
    );
    const upload = async () =>
      (
        await api
          .post(`/articles/${id}/assets`)
          .set(headers())
          .attach("file", png, {
            filename: "cover.png",
            contentType: "image/png",
          })
          .expect(201)
      ).body;
    const image = await upload();
    const extra = await upload();
    const url = `/public/articles/${id}/assets/${image.asset_id}/content`;
    await api.get(url).expect(404);
    const content = {
      ...body(),
      content: `# 图文\n\n![图](/assets/${image.asset_id}/content)`,
      cover_asset_id: image.asset_id,
      asset_ids: [image.asset_id],
    };
    const saved = await save(id, 1, content);
    await publish(id, saved.draft_version);
    await api.get(url).expect(200).expect("Content-Type", "image/png");
    await api.post('/documents').set(headers()).send({ title: '不能迁移文章图片', content: '资料', asset_ids: [image.asset_id], index_now: false }).expect(403);
    await api.get(url).expect(200);
    await api
      .get(`/public/articles/${id}/assets/${extra.asset_id}/content`)
      .expect(404);
    await api
      .get(`/assets/${extra.asset_id}/content`)
      .set(headers(bob))
      .expect(403);
    const changed = await save(id, saved.draft_version, body());
    await api.get(url).expect(200);
    await publish(id, changed.draft_version);
    await api.get(url).expect(404);
    await api
      .get(`/assets/${image.asset_id}/content`)
      .set(headers())
      .expect(404);
    const replacement = {
      ...content,
      content: `# 图文\n\n![图](/assets/${extra.asset_id}/content)`,
      cover_asset_id: extra.asset_id,
      asset_ids: [extra.asset_id],
    };
    const third = await save(id, changed.draft_version, replacement);
    await publish(id, third.draft_version);
    await api
      .post(`/articles/${id}/withdraw`)
      .set(headers())
      .send({ expected_version: third.draft_version })
      .expect(201);
    await api.get(url).expect(404);
  });

  test("validates publication, metadata and image ownership", async () => {
    const { article_id: id } = await create();
    await api
      .post(`/articles/${id}/publish`)
      .set(headers())
      .send({ expected_version: 1 })
      .expect(422);
    await api
      .patch(`/articles/${id}`)
      .set(headers())
      .send({ ...body("x".repeat(121)), expected_version: 1 })
      .expect(422);
    await api
      .patch(`/articles/${id}`)
      .set(headers())
      .send({ ...body(), tags: ["x".repeat(21)], expected_version: 1 })
      .expect(422);
    await api
      .patch(`/articles/${id}`)
      .set(headers())
      .send({
        ...body(),
        tags: ["1", "2", "3", "4", "5", "6"],
        expected_version: 1,
      })
      .expect(422);
    await api
      .patch(`/articles/${id}`)
      .set(headers())
      .send({ ...body(), owner_id: "user_bob", expected_version: 1 })
      .expect(422);
  });

  test("indexing a withdrawn in-flight publication cannot activate its vectors", async () => {
    const { article_id: id } = await create();
    const saved = await save(id, 1);
    const published = await publish(id, saved.draft_version);
    const jobs = app.get(IndexJobsService);
    // Isolate the target job from other lifecycle tests' queued publications.
    for (const other of app.get(ArticleRepository).records.keys())
      if (other !== id) await jobs.cancelDocument(other);
    const retrieval = app.get(RetrievalService);
    const vectors = app.get(VectorStoreService);
    const indexing = jest
      .spyOn(retrieval, "indexDocument")
      .mockImplementationOnce(async () => {
        await app
          .get(ArticlesService)
          .withdraw(id, saved.draft_version, context);
        return 1;
      });
    const activation = jest.spyOn(vectors, "activateDocumentVersion");
    await app.get(IndexWorkerService).runOnce("article-test-worker");
    expect(indexing).toHaveBeenCalled();
    expect(activation).not.toHaveBeenCalledWith(id, published.document_version);
    await api.get(`/public/articles/${id}`).expect(404);
    indexing.mockRestore();
    activation.mockRestore();
  });
});
