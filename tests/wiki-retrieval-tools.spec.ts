import { describe, expect, jest, test } from "@jest/globals";
import { AppConfig } from "../src/config/app-config.js";
import { DocumentAgentToolsService } from "../src/ai/document-agent-tools.service.js";
import { emptyUsage, type WorkerInput, type WorkerState } from "../src/ai/agent-runtime.types.js";
import type { WikiCoverageResult, WikiEvidence } from "../src/wiki/wiki.types.js";
import { request } from "./fixtures/agent-request.js";

function harness(verdict: WikiCoverageResult) {
  const pages: WikiEvidence[] = ["recall", "rerank"].map(id => ({
    proof: { wiki_id: id, revision: 1 }, title: id, markdown: `fact [${id}]`,
    citations: [{ id, kind: "document", doc_id: id, version: 1, title: id, source_content: `proof ${id}` }],
  }));
  const wiki = { search: jest.fn<any>().mockResolvedValue(pages),
    coverage: jest.fn<any>().mockResolvedValue(verdict), validateProofs: jest.fn<any>().mockResolvedValue(undefined) };
  const raw = { citations: [{ citation_id: "original", title: "extra", doc_id: "extra", document_version: 1,
    content: "additional proof", source_content: "additional proof" }], trace: {} };
  const retrieval = { searchWithTrace: jest.fn<any>().mockResolvedValue(raw) };
  const config = new AppConfig();
  const tools = new DocumentAgentToolsService(config, {} as any, {} as any, retrieval as any,
    {} as any, {} as any, { tools: new Map() } as any, {} as any, wiki as any);
  const scope = { private: true, public: false, team: false, document_ids: ["recall", "rerank", "extra"] };
  const input: WorkerInput = { task_id: "task", role: "primary", base: {}, dependencies: {}, environment: {
    run_id: "run", request: { ...request("ask"), query: "查询召回与重排规则", knowledge_scope: scope },
    context: { user_id: "owner", space_id: "space", team_ids: [] }, personal: {} as any,
    signal: new AbortController().signal, budget: emptyUsage(), emit: () => undefined,
    knowledge_snapshot: { scope, fingerprint: "snapshot" },
  } };
  const state: WorkerState = { citations: new Map(), evidence: new Map(), observations: [], readRegions: new Set(),
    selectionRead: false, wikiReads: [], wikiChecks: [], wikiFallbacks: [] };
  const execute = () => tools.execute(input, state, "search_knowledge_base", { query: "召回与重排" }, "call") as Promise<any[]>;
  return { pages, wiki, raw, retrieval, config, input, state, execute };
}

describe("Wiki union and supplemental original retrieval", () => {
  test("joint full coverage uses both pages with a single coverage check and no original lookup", async () => {
    const h = harness({ coverage: "full", missing: [] });
    const rows = await h.execute();
    expect(h.wiki.coverage).toHaveBeenCalledTimes(1);
    expect(h.wiki.coverage.mock.calls[0]![2]).toBe(h.pages);
    expect(rows.map(row => row.wiki_id)).toEqual(["recall", "rerank"]);
    expect(h.state.wikiReads).toEqual(h.pages.map(page => page.proof));
    expect(h.state.wikiChecks).toEqual([{ wiki_id: "recall", wiki_ids: ["recall", "rerank"],
      query: "召回与重排", coverage: "full", missing: [] }]);
    expect(h.retrieval.searchWithTrace).not.toHaveBeenCalled();
  });

  test("partial coverage preserves both pages, supplements the missing requirement and retains original scope", async () => {
    const h = harness({ coverage: "partial", missing: ["重排并列时的顺序"] });
    const rows = await h.execute();
    expect(rows.map(row => row.citation_id)).toEqual(["recall", "rerank", "kb-original"]);
    expect(h.retrieval.searchWithTrace.mock.calls[0]![0]).toMatchObject({
      query: "召回与重排\n待补充的信息：重排并列时的顺序", scope: h.input.environment.request.knowledge_scope,
    });
    expect(h.state.wikiReads).toHaveLength(2);
    expect(h.state.citations.size).toBe(3);
    expect(rows[0].missing).toEqual(["重排并列时的顺序"]);
  });

  test("an unresolved gap is not silently declared full when original retrieval returns no evidence", async () => {
    const h = harness({ coverage: "partial", missing: ["unknown rule"] });
    h.raw.citations = [];
    const rows = await h.execute();
    expect(rows.every(row => row.knowledge_layer === "wiki")).toBe(true);
    expect(rows[0]).toMatchObject({ wiki_coverage: "partial", missing: ["unknown rule"] });
  });

  test("a page withdrawn while retrieving originals is dropped before any Wiki evidence is adopted", async () => {
    const h = harness({ coverage: "partial", missing: ["extra"] });
    h.wiki.validateProofs.mockRejectedValue(new Error("withdrawn"));
    expect((await h.execute()).map(row => row.citation_id)).toEqual(["kb-original"]);
    expect(h.state.wikiReads).toEqual([]);
    expect([...h.state.citations.keys()]).toEqual(["kb-original"]);
    expect(h.state.wikiFallbacks).toEqual(["unavailable"]);
  });

  test("combined context overflow drops Wiki without recording unread proofs", async () => {
    const h = harness({ coverage: "partial", missing: ["extra"] });
    Object.defineProperty(h.config, "llmContextWindow", { value: 2048 });
    h.pages[0]!.markdown = "long context ".repeat(2000);
    expect((await h.execute()).map(row => row.citation_id)).toEqual(["kb-original"]);
    expect(h.state.wikiReads).toEqual([]);
    expect(h.state.wikiFallbacks).toEqual(["context_budget"]);
  });

  test.each(["none", "unavailable"] as const)("%s keeps normal original retrieval", async coverage => {
    const h = harness({ coverage, missing: [] });
    expect((await h.execute()).map(row => row.citation_id)).toEqual(["kb-original"]);
    expect((h.retrieval.searchWithTrace.mock.calls[0]![0] as any).query).toBe("召回与重排");
    expect(h.state.wikiReads).toEqual([]);
  });
});
