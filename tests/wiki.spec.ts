import { describe, expect, jest, test } from "@jest/globals";
import { AppConfig } from "../src/config/app-config.js";
import { WikiRepository } from "../src/wiki/wiki.repository.js";
import { WikiService, wikiHash } from "../src/wiki/wiki.service.js";
import { isTimeSensitive, type WikiPage } from "../src/wiki/wiki.types.js";
import {
  canAccess,
  buildPermissionFilter,
} from "../src/retrieval/vector-store.service.js";

const owner = { user_id: "owner", space_id: "space", team_ids: [] };
function harness() {
  const repository = new WikiRepository({ metadataEnabled: false } as any);
  const document = {
    doc_id: "doc",
    title: "source",
    content: "alpha proof",
    document_version: 1,
    visibility: "private",
    owner_id: owner.user_id,
    space_id: owner.space_id,
  };
  const docs = {
    getAccessible: jest.fn<any>().mockImplementation(async () => document),
    knowledgeFingerprint: jest.fn<any>().mockResolvedValue("scope-v1"),
  };
  const retrieval = {
    searchWikiWithTrace: jest.fn<any>().mockResolvedValue({ citations: [] }),
    indexDocument: jest.fn<any>().mockResolvedValue(1),
  };
  const llm = { agentTurn: jest.fn<any>() };
  const store = { deleteDocument: jest.fn<any>().mockResolvedValue(undefined) };
  const service = new WikiService(
    new AppConfig(),
    repository,
    docs as any,
    retrieval as any,
    store as any,
    llm as any,
  );
  const citation = {
    id: "c",
    kind: "document" as const,
    doc_id: "doc",
    version: 1,
    title: "source",
    source_content: "alpha proof",
  };
  const page = (): WikiPage => ({
    wiki_id: "wiki_1",
    space_id: owner.space_id,
    owner_id: owner.user_id,
    revision: 1,
    origin_run_id: "r",
    status: "published",
    created_at: new Date(),
    updated_at: new Date(),
    payload: {
      title: "topic",
      markdown: "stable compiled fact [c]",
      question: "topic",
      knowledge_snapshot: {
        scope: { private: true, public: true, team: true, document_ids: ["doc"] },
        fingerprint: "scope-v1",
      },
      parents: [],
      review: { passed: true, issues: [] },
      usage: { model_requests: 2, prompt_tokens: 0, completion_tokens: 0 },
      sources: [
        {
          citation_id: "c",
          doc_id: "doc",
          version: 1,
          title: "source",
          start_offset: 0,
          end_offset: 11,
          excerpt_hash: wikiHash("alpha proof"),
        },
      ],
    },
  });
  return {
    repository,
    service,
    document,
    docs,
    retrieval,
    llm,
    store,
    citation,
    page,
  };
}

describe("wiki provenance and retrieval boundaries", () => {
  async function comparisonHarness(relation: "duplicate" | "supplement" | "independent" | "conflict") {
    const h = harness();
    const previous = await h.repository.insert(h.page());
    const lookup = jest.spyOn(h.service, "search").mockResolvedValue([{
      proof: { wiki_id: previous.wiki_id, revision: previous.revision },
      title: previous.payload.title, markdown: previous.payload.markdown, citations: [h.citation],
    }]);
    const answer = "new wording of supported knowledge [n]";
    const origin = await h.service.origin({ kind: "answer", answer, citation_ids: ["n"] },
      [{ ...h.citation, id: "n" }], "stable knowledge", owner, []);
    const comparison = { wiki_id: previous.wiki_id, revision: previous.revision, relation };
    const compiled = {
      title: "same topic", markdown: relation === "supplement"
        ? "new supported detail [n]" : answer,
      citation_ids: ["n"], comparison,
    };
    const review = { passed: true, issues: [] as string[],
      quality: { reusable: true, complete: true, substantive: true }, comparison };
    h.llm.agentTurn.mockImplementation(async (_messages: unknown, _tools: unknown, _signal: unknown, options: any) => ({
      message: { content: JSON.stringify(options.role === "plan" ? compiled : review) },
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    }));
    const run = { run_id: "new-run", request_id: "new-run", user_id: owner.user_id,
      space_id: owner.space_id, conversation_id: "new-run", mode: "ask", status: "completed",
      payload: { wiki_origin: origin },
    } as any;
    return { ...h, previous, lookup, answer, origin, compiled, review, run };
  }

  test("two independent duplicate decisions skip insertion, record usage, and feedback can withdraw the reused page", async () => {
    const h = await comparisonHarness("duplicate");
    const states: any[] = [];
    h.service.enqueueCapture(h.run, h.answer, owner, [], async state => { states.push(state); });
    await h.service.waitForCaptures();
    const state = states.at(-1);
    expect(state).toMatchObject({ status: "skipped", reason: "semantic_duplicate", wiki_id: "wiki_1", revision: 1,
      usage: { model_requests: 2, prompt_tokens: 22, completion_tokens: 14 } });
    expect(await h.repository.list(owner)).toHaveLength(1);
    expect(h.retrieval.indexDocument).not.toHaveBeenCalled();
    await h.service.answerFeedback({ ...h.run, payload: { wiki_capture: state } }, owner, "incorrect");
    expect((await h.repository.get("wiki_1", owner))?.status).toBe("archived");
  });

  test("a verified supplement creates a new immutable topic version with rebound citations and preserved provenance", async () => {
    const h = await comparisonHarness("supplement");
    const result = await h.service.candidate(h.run, h.answer, owner, new AbortController().signal);
    expect(result.reused).toBe(false);
    const stored = (await h.repository.get(result.wiki_id, owner))!;
    expect(stored.payload.supersedes).toEqual({ wiki_id: "wiki_1", revision: 1 });
    expect(stored.payload.topic_id).toBe("wiki_1");
    expect(stored.payload.parents).toEqual([{ wiki_id: "wiki_1", revision: 1 }]);
    expect(stored.payload.sources.map(source => source.citation_id)).toEqual(["n"]);
    expect(stored.payload.markdown).toBe("stable compiled fact [n]\n\nnew supported detail [n]");
    const reviewInput = JSON.parse((h.llm.agentTurn.mock.calls[1]![0] as any[])[1].content);
    expect(reviewInput.candidate.markdown).toBe(stored.payload.markdown);
    const planInput = JSON.parse((h.llm.agentTurn.mock.calls[0]![0] as any[])[1].content);
    expect(planInput.previous_knowledge.markdown).toContain("[n]");
    expect(planInput.previous_knowledge.markdown).not.toContain("[c]");
    expect((await h.repository.get("wiki_1", owner))?.payload.markdown).toBe(h.previous.payload.markdown);
    await h.service.publish(result.wiki_id, result.revision, owner, new AbortController().signal);
    h.lookup.mockRestore();
    h.retrieval.searchWikiWithTrace.mockImplementation(async (input: any, _context: any, authorize: any) => {
      expect(input.scope.document_ids).toEqual([]);
      const hits = await authorize([{ pointId: "p", score: 1, payload: { doc_id: result.wiki_id, document_version: 1 } }]);
      return { citations: hits.map((hit: any) => ({ doc_id: hit.payload.doc_id, document_version: 1 })) };
    });
    const scope = { private: true, public: false, team: false, document_ids: ["doc"] };
    expect((await h.service.search("stable", scope, owner, new AbortController().signal))[0]?.proof.wiki_id).toBe(result.wiki_id);
    await h.service.remove(result.wiki_id, owner);
    h.retrieval.searchWikiWithTrace.mockImplementation(async (input: any, _context: any, authorize: any) => {
      expect(input.scope.document_ids).toEqual([]);
      const hits = await authorize(["wiki_1", result.wiki_id].map(id => ({ pointId: id, score: 1,
        payload: { doc_id: id, document_version: 1 } })));
      expect(hits.map((hit: any) => hit.payload.doc_id)).toEqual(["wiki_1"]);
      return { citations: [] };
    });
    await h.service.search("stable", scope, owner, new AbortController().signal);
  });

  test("an oversized supplement is rejected instead of truncating preserved old knowledge", async () => {
    const h = await comparisonHarness("supplement");
    h.compiled.markdown = `${"x".repeat(5980)} [n]`;
    await expect(h.service.candidate(h.run, h.answer, owner, new AbortController().signal)).rejects.toThrow("Wiki 候选格式或来源无效");
    expect(h.llm.agentTurn).toHaveBeenCalledTimes(1);
    expect(await h.repository.list(owner)).toHaveLength(1);
    expect((await h.repository.get("wiki_1", owner))?.payload.markdown).toBe(h.previous.payload.markdown);
  });

  test.each(["missing", "disagreed", "forged", "poor_quality"])("%s comparison cannot silently discard or replace new knowledge", async mode => {
    const h = await comparisonHarness("supplement");
    if (mode === "missing") delete (h.review as any).comparison;
    if (mode === "disagreed") h.review.comparison = { ...h.review.comparison, relation: "independent" };
    if (mode === "forged") h.compiled.comparison.wiki_id = "another-users-wiki";
    if (mode === "poor_quality") h.review.quality.complete = false;
    await expect(h.service.candidate(h.run, h.answer, owner, new AbortController().signal)).rejects.toThrow();
    expect(await h.repository.list(owner)).toHaveLength(1);
    expect((await h.repository.get("wiki_1", owner))?.status).toBe("published");
  });

  test("an independent topic is stored without inheriting a merely similar page", async () => {
    const h = await comparisonHarness("independent");
    const result = await h.service.candidate(h.run, h.answer, owner, new AbortController().signal);
    const stored = (await h.repository.get(result.wiki_id, owner))!;
    expect(stored.payload.parents).toEqual([]);
    expect(stored.payload.supersedes).toBeUndefined();
  });

  test("confirmed conflict is recorded without publishing or replacing existing knowledge", async () => {
    const h = await comparisonHarness("conflict");
    const states: any[] = [];
    h.service.enqueueCapture(h.run, h.answer, owner, [], async state => { states.push(state); });
    await h.service.waitForCaptures();
    expect(states.at(-1)).toEqual({ status: "skipped", reason: "knowledge_conflict" });
    expect(await h.repository.list(owner)).toHaveLength(1);
    expect(h.retrieval.indexDocument).not.toHaveBeenCalled();
    expect((await h.repository.get("wiki_1", owner))?.payload.conflicted_by_run).toBe("new-run");
    h.lookup.mockRestore();
    expect(await h.service.search("stable", { private: true, public: false, team: false, document_ids: ["doc"] },
      owner, new AbortController().signal)).toEqual([]);
    expect((await h.service.get("wiki_1", owner)).markdown).toBeUndefined();
  });

  test("feedback using an earlier page snapshot preserves a concurrently recorded conflict", async () => {
    const h = harness();
    const stale = await h.repository.insert(h.page());
    expect(await h.repository.annotate(stale, "conflicted_by_run", "conflict-run")).toBe(true);
    expect(await h.repository.annotate(stale, "user_feedback", "helpful")).toBe(true);
    const current = await h.repository.get("wiki_1", owner);
    expect(current?.payload.conflicted_by_run).toBe("conflict-run");
    expect(current?.payload.user_feedback).toBe("helpful");
    expect(await h.repository.annotate({ ...stale, owner_id: "foreign" }, "conflicted_by_run", "forged")).toBe(false);
    await expect(h.service.validateProofs([{ wiki_id: "wiki_1", revision: 1 }], owner)).rejects.toThrow("已使用的 Wiki");
  });

  test("a newly supplied source is not discarded merely because the answer is semantically duplicate", async () => {
    const h = await comparisonHarness("duplicate");
    h.run.payload.wiki_origin.sources[0].doc_id = "another-source";
    const result = await h.service.candidate(h.run, h.answer, owner, new AbortController().signal);
    expect(result.reused).toBe(false);
    expect((await h.repository.get(result.wiki_id, owner))?.payload.sources[0]?.doc_id).toBe("another-source");
  });

  test("withdrawal during comparison blocks a late semantic merge", async () => {
    const h = await comparisonHarness("supplement");
    const regular = h.llm.agentTurn.getMockImplementation()!;
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.llm.agentTurn.mockImplementation(async (...args: any[]) => { enter(); await gate; return regular(...args); });
    const pending = h.service.candidate(h.run, h.answer, owner, new AbortController().signal);
    const rejected = expect(pending).rejects.toThrow("Wiki 不存在");
    await entered;
    await h.service.remove("wiki_1", owner);
    release();
    await rejected;
    expect(await h.repository.list(owner)).toEqual([]);
  });

  test("changed knowledge range is excluded before reranking, including legacy pages without a snapshot", async () => {
    const h = harness();
    const page = h.page();
    await h.repository.insert(page);
    const hit = { pointId: "p", score: 1, payload: { doc_id: page.wiki_id, document_version: 1 } };
    const admitted: number[] = [];
    h.retrieval.searchWikiWithTrace.mockImplementation(async (_input: any, _owner: any, authorize: any) => {
      const hits = await authorize([hit]);
      admitted.push(hits.length);
      return { citations: hits.length ? [{ doc_id: page.wiki_id, document_version: 1 }] : [] };
    });
    const scope = { private: true, public: false, team: false, document_ids: ["doc"] };
    expect(await h.service.search("concept", scope, owner, new AbortController().signal)).toHaveLength(1);
    h.docs.knowledgeFingerprint.mockResolvedValue("scope-v2");
    expect(await h.service.search("concept", scope, owner, new AbortController().signal)).toEqual([]);
    expect(admitted).toEqual([1, 0]);
    await expect(h.service.validateProofs([{ wiki_id: page.wiki_id, revision: 1 }], owner)).rejects.toThrow("知识范围已变化");
    const legacy = { ...h.page(), wiki_id: "legacy", origin_run_id: "legacy" };
    delete legacy.payload.knowledge_snapshot;
    await h.repository.insert(legacy);
    await expect(h.service.validateProofs([{ wiki_id: "legacy", revision: 1 }], owner)).rejects.toThrow("知识范围已变化");
  });

  test("a new compiled answer retains direct and transitive Wiki versions", async () => {
    const h = harness();
    await h.repository.insert(h.page());
    const b = { ...h.page(), wiki_id: "wiki_b", origin_run_id: "b" };
    b.payload.parents = [{ wiki_id: "wiki_1", revision: 1 }];
    await h.repository.insert(b);
    const origin = await h.service.origin(
      { kind: "answer", answer: "new fact [c]", citation_ids: ["c"] },
      [h.citation], "concept", owner, [{ wiki_id: "wiki_b", revision: 1 }],
    );
    expect(origin?.parents).toEqual([
      { wiki_id: "wiki_1", revision: 1 }, { wiki_id: "wiki_b", revision: 1 },
    ]);
    expect(origin?.knowledge_snapshot?.fingerprint).toBe("scope-v1");
  });

  test("final release checks the actual request range as well as the original Wiki range", async () => {
    const h = harness();
    const page = await h.repository.insert(h.page());
    h.docs.knowledgeFingerprint.mockImplementation(async (scope: any) => scope.document_ids.length ? "scope-v1" : "scope-v2");
    const proof = [{ wiki_id: page.wiki_id, revision: 1 }];
    await h.service.validateProofs(proof, owner);
    await expect(h.service.validateProofs(proof, owner, {
      scope: { private: true, public: false, team: false, document_ids: [] }, fingerprint: "scope-v1",
    })).rejects.toThrow("知识范围已变化");
  });

  test("rejection withdraws transitive dependents beyond 100 pages and leaves independent/foreign pages intact", async () => {
    const h = harness();
    const a = h.page();
    await h.repository.insert(a);
    for (const [id, parents] of [
      ["b", [{ wiki_id: "wiki_1", revision: 1 }]],
      ["c", [{ wiki_id: "wiki_1", revision: 1 }, { wiki_id: "b", revision: 1 }]],
      ["independent", []],
    ] as const) {
      const page = { ...h.page(), wiki_id: id, origin_run_id: id };
      page.payload.parents = [...parents];
      await h.repository.insert(page);
    }
    const foreign = { ...h.page(), wiki_id: "foreign", origin_run_id: "foreign", owner_id: "other" };
    foreign.payload.parents = [{ wiki_id: "wiki_1", revision: 1 }];
    await h.repository.insert(foreign);
    for (let i = 0; i < 105; i++) await h.repository.insert({
      ...h.page(), wiki_id: `filler-${i}`, origin_run_id: `filler-${i}`,
      updated_at: new Date(Date.now() + i + 1),
    });
    h.store.deleteDocument.mockRejectedValue(new Error("vector cleanup unavailable"));
    await h.service.answerFeedback({ run_id: "r", payload: { wiki_reads: [] } } as any, owner, "incorrect");
    for (const id of ["wiki_1", "b", "c"])
      expect((await h.repository.get(id, owner))?.status).toBe("archived");
    expect((await h.repository.get("c", owner))?.payload.invalidated_by).toEqual([{ wiki_id: "wiki_1", revision: 1 }]);
    expect((await h.repository.get("independent", owner))?.status).toBe("published");
    expect((await h.repository.get("foreign", { ...owner, user_id: "other" }))?.status).toBe("published");
    expect(h.store.deleteDocument).toHaveBeenCalledTimes(3);
  });

  test("a withdrawn ancestor blocks final release even before dependent metadata is updated", async () => {
    const h = harness();
    const a = await h.repository.insert(h.page());
    const b = { ...h.page(), wiki_id: "b", origin_run_id: "b" };
    b.payload.parents = [{ wiki_id: a.wiki_id, revision: 1 }];
    await h.repository.insert(b);
    await h.repository.transition(a, ["published"], "archived");
    expect((await h.repository.get("b", owner))?.status).toBe("published");
    await expect(h.service.validateProofs([{ wiki_id: "b", revision: 1 }], owner)).rejects.toThrow("Wiki 不存在");
    const view = await h.service.get("b", owner);
    expect(view.markdown).toBeUndefined();
  });

  test("withdrawal during indexing cannot be undone by a late index response", async () => {
    const h = harness();
    await h.repository.insert(h.page());
    const b = { ...h.page(), wiki_id: "b", origin_run_id: "b", status: "draft" as const };
    b.payload.parents = [{ wiki_id: "wiki_1", revision: 1 }];
    await h.repository.insert(b);
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.retrieval.indexDocument.mockImplementation(async () => { enter(); await gate; return 1; });
    const publishing = h.service.publish("b", 1, owner, new AbortController().signal);
    const rejected = expect(publishing).rejects.toThrow("Wiki 不存在");
    await entered;
    await h.service.answerFeedback({ run_id: "r", payload: {} } as any, owner, "incorrect");
    release();
    await rejected;
    expect((await h.repository.get("b", owner))?.status).toBe("archived");
  });

  test("retrieval and exact capture deduplication discover older pages outside the management window", async () => {
    const h = harness();
    const origin = await h.service.origin({ kind: "answer", answer: "fact [c]", citation_ids: ["c"] },
      [h.citation], "topic", owner, []);
    const old = h.page();
    old.payload.capture_hash = (h.service as any).captureHash(origin);
    await h.repository.insert(old);
    for (let i = 0; i < 105; i++) await h.repository.insert({ ...h.page(),
      wiki_id: `new-${i}`, origin_run_id: `new-${i}`, updated_at: new Date(Date.now() + 1000 + i) });
    expect((await h.repository.list(owner)).some(page => page.wiki_id === old.wiki_id)).toBe(false);
    h.retrieval.searchWikiWithTrace.mockImplementation(async (input: any, _owner: any, authorize: any) => {
      expect(input.scope.document_ids).toEqual([]);
      const hits = await authorize([{ pointId: "old", score: 1,
        payload: { doc_id: old.wiki_id, document_version: 1 } }]);
      return { citations: hits.map((hit: any) => ({ doc_id: hit.payload.doc_id, document_version: 1 })) };
    });
    expect((await h.service.search("topic", { private: true, public: false, team: false, document_ids: [] },
      owner, new AbortController().signal)).map(page => page.proof.wiki_id)).toEqual([old.wiki_id]);
    const states: any[] = [];
    h.service.enqueueCapture({ run_id: "new-run", status: "completed", payload: { wiki_origin: origin } } as any,
      "fact [c]", owner, [], async state => { states.push(state); });
    await h.service.waitForCaptures();
    expect(states).toEqual([{ status: "skipped", reason: "already_compiled", wiki_id: old.wiki_id }]);
    expect(h.llm.agentTurn).not.toHaveBeenCalled();
  });

  test("candidate authorization excludes foreign pages and valid superseded versions without a list scan", async () => {
    const h = harness();
    const old = await h.repository.insert(h.page());
    const next = { ...h.page(), wiki_id: "next", origin_run_id: "next" };
    next.payload.supersedes = { wiki_id: old.wiki_id, revision: 1 };
    next.payload.parents = [{ wiki_id: old.wiki_id, revision: 1 }];
    await h.repository.insert(next);
    const foreign = { ...h.page(), wiki_id: "foreign", origin_run_id: "foreign", owner_id: "foreign" };
    await h.repository.insert(foreign);
    const list = jest.spyOn(h.repository, "list");
    const admitted: string[][] = [];
    h.retrieval.searchWikiWithTrace.mockImplementation(async (_input: any, _owner: any, authorize: any) => {
      // The successor need not be in the vector candidates to suppress its old version.
      const hits = await authorize([old, foreign].map(page => ({ pointId: page.wiki_id, score: 1,
        payload: { doc_id: page.wiki_id, document_version: page.revision } })));
      admitted.push(hits.map((hit: any) => hit.payload.doc_id));
      return { citations: hits.map((hit: any) => ({ doc_id: hit.payload.doc_id, document_version: 1 })) };
    });
    const search = () => h.service.search("topic", { private: true, public: false, team: false, document_ids: [] }, owner, new AbortController().signal);
    expect(await search()).toEqual([]);
    await h.repository.transition(next, ["published"], "failed");
    expect(await search()).toHaveLength(1);
    expect(admitted).toEqual([[], [old.wiki_id]]);
    expect(list).not.toHaveBeenCalled();
  });

  test("multiple pages bind overlapping historical citation labels to their actual source coordinates", async () => {
    const h = harness();
    const a = await h.repository.insert(h.page());
    const b = { ...h.page(), wiki_id: "b", origin_run_id: "b" };
    b.payload.sources[0]!.doc_id = "other";
    await h.repository.insert(b);
    h.docs.getAccessible.mockImplementation(async (id: string) => ({ ...h.document, doc_id: id }));
    h.retrieval.searchWikiWithTrace.mockImplementation(async (_input: any, _owner: any, authorize: any) => {
      const hits = await authorize([a, b].map(page => ({ pointId: page.wiki_id, score: 1,
        payload: { doc_id: page.wiki_id, document_version: 1 } })));
      return { citations: hits.map((hit: any) => ({ doc_id: hit.payload.doc_id, document_version: 1 })) };
    });
    const pages = await h.service.search("topic", { private: true, public: false, team: false, document_ids: [] },
      owner, new AbortController().signal);
    expect(pages).toHaveLength(2);
    const ids = pages.map(page => page.citations[0]!.id);
    expect(new Set(ids).size).toBe(2);
    pages.forEach((page, index) => expect(page.markdown).toContain(`[${ids[index]}]`));
    expect(pages.map(page => page.citations[0]!.doc_id)).toEqual(["doc", "other"]);
  });

  test("coverage assesses the union in one call and retains concrete missing requirements", async () => {
    const h = harness();
    h.llm.agentTurn.mockResolvedValue({ message: { content: '{"coverage":"partial","missing":["重排的并列规则"]}' }, usage: {} });
    const pages = ["recall", "rerank"].map(id => ({ proof: { wiki_id: id, revision: 1 }, title: id, markdown: id, citations: [] }));
    expect(await h.service.coverage("explain both", "search hint", pages, new AbortController().signal, []))
      .toEqual({ coverage: "partial", missing: ["重排的并列规则"] });
    expect(h.llm.agentTurn).toHaveBeenCalledTimes(1);
    const input = JSON.parse((h.llm.agentTurn.mock.calls[0]![0] as any)[1].content);
    expect(input.knowledge.pages.map((page: any) => page.wiki_id)).toEqual(["recall", "rerank"]);
  });

  test.each([
    ['{"coverage":"full","missing":[]}', "full"],
    ['{"coverage":"partial","missing":["limitation"]}', "partial"],
    ['{"coverage":"none","missing":[]}', "none"],
    ['{"coverage":"full","missing":["limitation"]}', "partial"],
    ['{"coverage":"full"}', "unavailable"],
    ['{"coverage":"unknown","missing":[]}', "unavailable"],
    ['{"coverage":"partial","missing":[]}', "unavailable"],
    ['{"coverage":"partial","missing":[1]}', "unavailable"],
  ])(
    "coverage %s is checked and counted separately from execution rounds",
    async (json, expected) => {
      const h = harness();
      h.llm.agentTurn.mockResolvedValue({
        message: { content: json },
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      });
      const usage = {
        model_requests: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
      };
      const verdict = await h.service.coverage(
          "question",
          "query",
          [{
            proof: { wiki_id: "wiki", revision: 1 },
            title: "fact",
            markdown: "fact",
            citations: [],
          }],
          new AbortController().signal,
          [usage, usage],
        );
      expect(verdict.coverage).toBe(expected);
      expect(verdict.missing).toEqual(expected === "partial" ? ["limitation"] : []);
      if (expected === "unavailable") expect(verdict.reason).toBe("invalid_response");
      expect(usage).toEqual({
        model_requests: 1,
        prompt_tokens: 11,
        completion_tokens: 7,
      });
    },
  );
  test("automatic captures serialize per owner and suppress duplicate in-flight runs", async () => {
    const h = harness();
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let compilations = 0;
    h.llm.agentTurn.mockImplementation(
      async (
        _messages: unknown,
        _tools: unknown,
        _signal: unknown,
        options: any,
      ) => {
        if (options.role === "plan") {
          compilations++;
          if (compilations === 1) {
            enter();
            await gate;
          }
          return {
            message: {
              content:
                '{"title":"fact","markdown":"fact [c]","citation_ids":["c"]}',
            },
            usage: {},
          };
        }
        return {
          message: {
            content:
              '{"passed":true,"issues":[],"quality":{"reusable":true,"complete":true,"substantive":true},"coverage":"full","missing":[]}',
          },
          usage: {},
        };
      },
    );
    const states: string[] = [];
    for (const runId of ["first", "first", "second"]) {
      const answer = `${runId} fact [c]`;
      const origin = await h.service.origin(
        { kind: "answer", answer, citation_ids: ["c"] },
        [h.citation],
        "fact",
        owner,
        [],
      );
      h.service.enqueueCapture(
        {
          run_id: runId,
          request_id: runId,
          user_id: owner.user_id,
          space_id: owner.space_id,
          conversation_id: runId,
          mode: "ask",
          status: "completed",
          payload: { wiki_origin: origin },
        },
        answer,
        owner,
        [],
        async (state) => {
          states.push(`${runId}:${state.status}`);
        },
      );
    }
    await entered;
    expect(compilations).toBe(1);
    release();
    await h.service.waitForCaptures();
    expect(compilations).toBe(2);
    expect(states).toEqual([
      "first:running",
      "first:published",
      "second:running",
      "second:published",
    ]);
  });

  test("shutdown aborts compilation and cannot publish a late model response", async () => {
    const h = harness();
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let release!: (value: any) => void;
    const gate = new Promise<any>((resolve) => {
      release = resolve;
    });
    h.llm.agentTurn.mockImplementation(async () => {
      enter();
      return gate;
    });
    const answer = "fact [c]";
    const origin = await h.service.origin(
      { kind: "answer", answer, citation_ids: ["c"] },
      [h.citation],
      "fact",
      owner,
      [],
    );
    const states: string[] = [];
    h.service.enqueueCapture(
      {
        run_id: "shutdown",
        request_id: "shutdown",
        user_id: owner.user_id,
        space_id: owner.space_id,
        conversation_id: "shutdown",
        mode: "ask",
        status: "completed",
        payload: { wiki_origin: origin },
      },
      answer,
      owner,
      [],
      async (state) => {
        states.push(state.status);
      },
    );
    await entered;
    await h.service.onModuleDestroy();
    release({
      message: {
        content: '{"title":"fact","markdown":"fact [c]","citation_ids":["c"]}',
      },
      usage: {},
    });
    await Promise.resolve();
    expect(states).toEqual(["running", "failed"]);
    expect(await h.repository.list(owner)).toEqual([]);
    expect(h.retrieval.indexDocument).not.toHaveBeenCalled();
  });

  test.each(["doc", "another"])("new facts from %s alongside reused Wiki still allow automatic compilation", async (docId) => {
    const h = harness();
    await h.repository.insert(h.page());
    h.docs.getAccessible.mockImplementation(async (id: string) => ({
      ...h.document,
      doc_id: id,
    }));
    const answer = "additional fact [d]";
    const proofs = [{ wiki_id: "wiki_1", revision: 1 }];
    const origin = await h.service.origin(
      { kind: "answer", answer, citation_ids: ["d"] },
      [{ ...h.citation, id: "d", doc_id: docId }],
      "additional fact",
      owner,
      proofs,
    );
    h.llm.agentTurn.mockImplementation(
      async (
        _messages: unknown,
        _tools: unknown,
        _signal: unknown,
        options: any,
      ) => ({
        message: {
          content:
            options.role === "plan"
              ? '{"title":"new fact","markdown":"new fact [d]","citation_ids":["d"]}'
              : '{"passed":true,"issues":[],"quality":{"reusable":true,"complete":true,"substantive":true},"coverage":"full","missing":[]}',
        },
        usage: {},
      }),
    );
    const states: string[] = [];
    h.service.enqueueCapture(
      {
        run_id: "new-evidence",
        request_id: "new-evidence",
        user_id: owner.user_id,
        space_id: owner.space_id,
        conversation_id: "new-evidence",
        mode: "ask",
        status: "completed",
        payload: { wiki_origin: origin },
      },
      answer,
      owner,
      proofs,
      async (state) => {
        states.push(state.status);
      },
    );
    await h.service.waitForCaptures();
    expect(states).toEqual(["running", "published"]);
    expect(h.llm.agentTurn).toHaveBeenCalledTimes(2);
  });

  test("only stable answers with fully backed persistent document sources are eligible", async () => {
    const h = harness();
    const result = {
      kind: "answer" as const,
      answer: "fact [c]",
      citation_ids: ["c"],
    };
    const origin = await h.service.origin(
      result,
      [h.citation],
      "stable concept",
      owner,
      [],
    );
    expect(origin).toMatchObject({
      answer_hash: wikiHash(result.answer),
      sources: [
        {
          excerpt_hash: wikiHash("alpha proof"),
          start_offset: 0,
          end_offset: 11,
        },
      ],
    });
    expect(JSON.stringify(origin)).not.toContain("alpha proof");
    expect(
      await h.service.origin(
        result,
        [{ ...h.citation, kind: "web" }],
        "concept",
        owner,
        [],
      ),
    ).toBeUndefined();
    expect(
      await h.service.origin(result, [h.citation], "查询最新价格", owner, []),
    ).toBeUndefined();
    expect(
      await h.service.origin(
        result,
        [{ ...h.citation, source_content: "invented" }],
        "concept",
        owner,
        [],
      ),
    ).toBeUndefined();
  });

  test("wiki source contributors survive compilation of an answer with fewer citation markers", async () => {
    const h = harness();
    await h.repository.insert(h.page());
    h.docs.getAccessible.mockImplementation(async (id: string) =>
      id === "doc" ? h.document : { ...h.document, doc_id: "other" },
    );
    const origin = await h.service.origin(
      { kind: "answer", answer: "fact [other]", citation_ids: ["other"] },
      [{ ...h.citation, id: "other", doc_id: "other" }],
      "concept",
      owner,
      [{ wiki_id: "wiki_1", revision: 1 }],
    );
    expect(origin!.sources.map((source) => source.doc_id)).toEqual([
      "other",
      "doc",
    ]);
  });

  test("an unreadable source or scope mismatch is filtered before any derived text reaches reranking", async () => {
    const h = harness();
    await h.repository.insert(h.page());
    const hit = {
      pointId: "point",
      score: 1,
      payload: {
        doc_id: "wiki_1",
        document_version: 1,
        content: "private compiled text",
      },
    };
    h.retrieval.searchWikiWithTrace.mockImplementation(
      async (_args: any, _context: any, authorize: any) => {
        expect(await authorize([hit])).toEqual([]);
        return { citations: [], trace: {} };
      },
    );
    expect(
      await h.service.search(
        "stable",
        { private: false, public: true, team: false, document_ids: [] },
        owner,
        new AbortController().signal,
      ),
    ).toEqual([]);
    expect(
      await h.service.search(
        "stable",
        {
          private: true,
          public: false,
          team: false,
          document_ids: ["unselected"],
        },
        owner,
        new AbortController().signal,
      ),
    ).toEqual([]);
    h.document.content = "wrong proof";
    expect(
      await h.service.search(
        "stable",
        { private: true, public: false, team: false, document_ids: [] },
        owner,
        new AbortController().signal,
      ),
    ).toEqual([]);
  });

  test("an archived wiki invalidates a read proof even if source documents remain readable", async () => {
    const h = harness();
    const page = await h.repository.insert(h.page());
    await h.service.validateProofs(
      [{ wiki_id: page.wiki_id, revision: 1 }],
      owner,
    );
    await h.repository.transition(page, ["published"], "archived");
    await expect(
      h.service.validateProofs([{ wiki_id: page.wiki_id, revision: 1 }], owner),
    ).rejects.toThrow("Wiki 不存在");
  });

  test("memory insertion and publication claims are atomic and scoped to owners", async () => {
    const h = harness();
    const [a, b] = await Promise.all([
      h.repository.insert(h.page()),
      h.repository.insert({ ...h.page(), wiki_id: "different" }),
    ]);
    expect(a.wiki_id).toBe(b.wiki_id);
    const claimed = await Promise.all([
      h.repository.transition(a, ["published"], "indexing"),
      h.repository.transition(a, ["published"], "indexing"),
    ]);
    expect(claimed).toEqual([true, false]);
    expect(
      await h.repository.get(a.wiki_id, { ...owner, user_id: "foreign" }),
    ).toBeUndefined();
  });

  test("raw vector filters exclude generated wiki chunks and wiki retrieval explicitly selects them", () => {
    const scope = {
      private: true,
      public: false,
      team: false,
      document_ids: [],
    };
    const payload = {
      visibility: "private",
      space_id: owner.space_id,
      owner_id: owner.user_id,
      is_active: true,
      knowledge_layer: "wiki",
    };
    expect(canAccess(payload, owner, scope)).toBe(false);
    expect(canAccess(payload, owner, scope, true)).toBe(true);
    expect(buildPermissionFilter(owner, scope).must_not).toContainEqual({
      key: "knowledge_layer",
      match: { value: "wiki" },
    });
    expect(buildPermissionFilter(owner, scope, true).must).toContainEqual({
      key: "knowledge_layer",
      match: { value: "wiki" },
    });
  });

  test.each(["latest policy", "最新资料", "现行政策", "价格", "重新检索原文"])(
    "time-sensitive queries require source verification: %s",
    (query) => {
      expect(isTimeSensitive(query)).toBe(true);
    },
  );
});
