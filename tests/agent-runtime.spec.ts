import { describe, expect, jest, test } from "@jest/globals";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import { AppConfig } from "../src/config/app-config.js";
import { AgentRuntimeService } from "../src/ai/agent-runtime.service.js";
import { DocumentAgentToolsService } from "../src/ai/document-agent-tools.service.js";
import {
  emptyUsage,
  type WorkerInput,
  type WorkerOutput,
} from "../src/ai/agent-runtime.types.js";
import { request } from "./fixtures/agent-request.js";
import { handoffArguments } from "./fixtures/worker-handoff.js";

function call(name: string, args: unknown, step = true) {
  if (name === "finish_answer" && step) args = handoffArguments(args);
  return {
    message: {
      role: "assistant" as const,
      content: null,
      tool_calls: [
        {
          id: "same-provider-id",
          type: "function" as const,
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  };
}
function harness(wiki?: any) {
  const config = new AppConfig();
  const llm = {
    agentTurn: jest.fn<any>(),
    webSearchConfigured: true,
    searchWeb: jest.fn<any>(),
  };
  const documents = { getAccessible: jest.fn<any>() };
  const retrieval = { searchWithTrace: jest.fn<any>() };
  const workspace = { tree: jest.fn<any>() };
  const mcp = { tools: new Map<string, any>(), call: jest.fn<any>() };
  const audit = { tool: jest.fn<any>().mockResolvedValue(undefined) };
  const tools = new DocumentAgentToolsService(
    config,
    documents as any,
    {} as any,
    retrieval as any,
    workspace as any,
    llm as any,
    mcp as any,
    {} as any,
    wiki,
  );
  const runtime = new AgentRuntimeService(
    config,
    llm as any,
    tools,
    workspace as any,
    audit as any,
  );
  const events: any[] = [];
  const input: WorkerInput = {
    task_id: "task-a",
    role: "reader",
    step: {
      id: "a",
      description: "读取资料",
      capability: "read",
      depends_on: [],
    },
    base: { query: "read" },
    dependencies: {},
    environment: {
      run_id: "run",
      request: request("ask"),
      context: { user_id: "alice", space_id: "space", team_ids: [] },
      personal: {
        thinking_supported: false,
        thinking: undefined,
        web_key: undefined,
        deployment_web: true,
      },
      signal: new AbortController().signal,
      budget: emptyUsage(),
      emit: (event, data) => events.push({ event, ...data }),
    },
  };
  return {
    config,
    llm,
    documents,
    retrieval,
    mcp,
    audit,
    tools,
    runtime,
    input,
    events,
  };
}
const outputs = (messages: any[]) =>
  messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));

describe("isolated document agent runtime", () => {
  test("retrieved documents can be paged, but unseen IDs and changed versions cannot be read", async () => {
    const h = harness();
    h.input.role = "researcher";
    h.input.step!.capability = "search";
    h.input.environment.request.knowledge_scope = { private: true, public: false, team: false, document_ids: [] };
    const state: import("../src/ai/agent-runtime.types.js").WorkerState = {
      citations: new Map(), evidence: new Map(), observations: [], readRegions: new Set(), selectionRead: false,
      wikiReads: [], wikiChecks: [], wikiFallbacks: [],
    };
    await expect(h.tools.execute(h.input, state, "read_knowledge_document", { doc_id: "unseen" }, "0"))
      .rejects.toThrow(ForbiddenException);
    expect(h.documents.getAccessible).not.toHaveBeenCalled();
    h.retrieval.searchWithTrace.mockResolvedValue({ citations: [
      { citation_id: "chunk", doc_id: "source", title: "Source", document_version: 1, content: "fact" },
    ] });
    const found: any = await h.tools.execute(h.input, state, "search_knowledge_base", { query: "fact" }, "1");
    expect(found[0]).toMatchObject({ doc_id: "source", title: "Source" });
    h.documents.getAccessible.mockResolvedValue({ doc_id: "source", title: "Source", document_version: 1, content: "fact\nexception" });
    const page: any = await h.tools.execute(h.input, state, "read_knowledge_document", { doc_id: "source", limit: 5 }, "2");
    const next: any = await h.tools.execute(h.input, state, "read_knowledge_document", { doc_id: "source", offset: page.next_offset }, "3");
    expect(page.content + next.content).toBe("fact\nexception");
    expect(page.citation_id).not.toBe(next.citation_id);
    expect(state.citations.get(next.citation_id)?.source_content).toBe("exception");
    h.documents.getAccessible.mockResolvedValue({ document_version: 2 });
    await expect(h.tools.execute(h.input, state, "read_knowledge_document", { doc_id: "source" }, "4"))
      .rejects.toThrow(ConflictException);
    h.documents.getAccessible.mockRejectedValue(new ForbiddenException("revoked"));
    await expect(h.tools.execute(h.input, state, "read_knowledge_document", { doc_id: "source" }, "5"))
      .rejects.toThrow(ForbiddenException);
  });

  test("large blocks page through the runtime and count as read only after every segment", async () => {
    const h = harness();
    h.input.role = "primary";
    h.input.step = undefined;
    const body = "正文内容。".repeat(2600);
    h.input.environment.request.editor_snapshot.regions[0]!.markdown = body;
    h.llm.agentTurn.mockImplementation(async (messages: any[], _tools: any[], _signal: any, options: any) => {
      if (options?.role === "plan") return { message: { role: "assistant", content: '{"summary":"已读取的正文片段"}' }, usage: {} };
      const pages = outputs(messages);
      const last = pages.at(-1);
      if (!last || last.next_content_offset !== null)
        return call("read_current_document", { region_ids: ["b0"], content_offset: last?.next_content_offset ?? 0, content_limit: 6000 });
      return call("finish_answer", { answer: "done", citation_ids: pages.map(page => page.citation_id) }, false);
    });
    const result = await h.runtime.runWorker(h.input);
    expect(result.read_region_ids).toEqual(["b0"]);
    expect(result.observations.map(item => item.content).join("")).toBe(body);
    const pages = outputs(h.llm.agentTurn.mock.calls.at(-1)![0] as any[]);
    expect(pages.slice(0, -1).every(page => page.partial && !page.read_region_ids.length)).toBe(true);
    expect(pages.at(-1).partial).toBe(false);
  });

  test("reading the last page alone does not authorize an edit to an unread large block", async () => {
    const h = harness();
    h.input.role = "primary";
    h.input.step = undefined;
    h.input.environment.request.mode = "agent";
    h.input.environment.request.editor_snapshot.regions[0]!.markdown = "x ".repeat(12000);
    h.llm.agentTurn.mockImplementation(async (messages: any[]) => outputs(messages).length
      ? call("propose_document_edits", { edits: [{ id: "bad", operation: "replace", target: { kind: "block_range", first_region_id: "b0" },
        content_markdown: "new", explanation: "rewrite", citation_ids: [] }] })
      : call("read_current_document", { region_ids: ["b0"], content_offset: 23000 }));
    await expect(h.runtime.runWorker(h.input)).rejects.toThrow("必须先读取");
  });

  test("uses its allocated last turn for handoff before the shared budget is exhausted", async () => {
    const h = harness();
    h.input.environment.step_turn_limit = 2;
    h.input.environment.request.references = [{ id: "note", title: "note", kind: "text", content: "proof" }];
    h.llm.agentTurn.mockImplementation(async (messages: any[], tools: any[]) => {
      const reads = outputs(messages);
      if (!reads.length) return call("read_reference", { reference_id: "note" });
      expect(tools.map(tool => tool.function.name).sort()).toEqual(["finish_answer", "request_clarification"]);
      expect(messages.at(-1).content).toContain("最后一轮");
      return call("finish_answer", { answer: "proof", citation_ids: [reads[0].citation_id] });
    });
    const result = await h.runtime.runWorker(h.input);
    expect(result.handoff?.coverage).toBe("complete");
    expect(result.usage.execution_turns).toBe(2);
    expect(h.llm.agentTurn.mock.calls.at(-1)![3]).toMatchObject({ toolChoice: "finish_answer" });
  });
  test("selected knowledge scope exposes search without query keywords and respects role permissions", () => {
    const h = harness();
    h.input.step = undefined;
    h.input.role = "primary";
    h.input.environment.request.query = "查询 Birch 项目的回滚条件";
    expect(h.tools.allowedTools(h.input).some(tool => tool.function.name === "search_knowledge_base")).toBe(false);
    h.input.environment.request.knowledge_scope = { private: true, public: false, team: false, document_ids: [] };
    expect(h.tools.allowedTools(h.input).some(tool => tool.function.name === "search_knowledge_base")).toBe(true);
    h.input.role = "reader";
    expect(h.tools.allowedTools(h.input).some(tool => tool.function.name === "search_knowledge_base")).toBe(false);
  });
  test.each(["missing", "invented"])("rejects %s handoff with a single bounded repair", async kind => {
    const h = harness();
    const response = call("finish_answer", { answer: "unsupported", citation_ids: [] });
    const args = JSON.parse(response.message.tool_calls[0]!.function.arguments);
    if (kind === "missing") delete args.handoff;
    else args.handoff = { findings: [{ statement: "fake fact", evidence_ids: ["invented"] }], missing: [], conflicts: [] };
    response.message.tool_calls[0]!.function.arguments = JSON.stringify(args);
    h.llm.agentTurn.mockResolvedValue(response);
    await expect(h.runtime.runWorker(h.input)).rejects.toThrow("修复失败");
    expect(h.llm.agentTurn).toHaveBeenCalledTimes(2);
    expect(h.audit.tool.mock.calls.filter(args => args[4] === "error")).toHaveLength(2);
    expect(h.audit.tool.mock.calls.some(args => args[4] === "success")).toBe(false);
  });

  function wikiSearch(wiki: any) {
    const h = harness(wiki);
    h.input.role = "researcher";
    h.input.step!.capability = "search";
    h.input.environment.request.knowledge_scope = {
      private: true, public: false, team: false, document_ids: ["doc"],
    };
    h.retrieval.searchWithTrace.mockResolvedValue({ citations: [{
      citation_id: "raw", doc_id: "doc", document_version: 1,
      title: "source", content: "original evidence", source_content: "original evidence",
    }] });
    h.llm.agentTurn.mockImplementation(async (messages: any[]) =>
      outputs(messages).length
        ? call("finish_answer", { answer: "original evidence", citation_ids: ["kb-raw"] })
        : call("search_knowledge_base", { query: "knowledge", original_only: true }),
    );
    return h;
  }

  test.each([
    new Error("private provider diagnostic"),
    new ConflictException("Wiki changed after retrieval"),
    new ForbiddenException("Wiki source access revoked"),
  ])("Wiki failure %s falls back within the same tool call and scope", async (failure) => {
    const wiki = { search: jest.fn<any>().mockRejectedValue(failure) };
    const h = wikiSearch(wiki);
    const result = await h.runtime.runWorker(h.input);
    expect(wiki.search).toHaveBeenCalledTimes(1);
    expect(h.retrieval.searchWithTrace).toHaveBeenCalledTimes(1);
    expect(h.retrieval.searchWithTrace.mock.calls[0]![0])
      .toMatchObject({ scope: h.input.environment.request.knowledge_scope });
    expect(h.retrieval.searchWithTrace.mock.calls[0]![1])
      .toEqual(h.input.environment.context);
    expect(result.citations.map(c => c.id)).toEqual(["kb-raw"]);
    expect(result.wiki_reads).toEqual([]);
    expect(result.usage.execution_turns).toBe(2);
    const audit = h.audit.tool.mock.calls.find((args: any[]) =>
      args[2] === "search_knowledge_base" && args[4] === "success");
    expect(audit?.[5]).toMatchObject({ wiki_fallback: ["unavailable"] });
    expect(JSON.stringify(h.audit.tool.mock.calls)).not.toContain("private provider diagnostic");
  });

  test.each(["search", "coverage"])("Wiki %s timeout reserves original retrieval and discards late results", async (stage) => {
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    let release!: (value: any) => void;
    const gate = new Promise<any>(resolve => { release = resolve; });
    const page = {
      proof: { wiki_id: "late-wiki", revision: 1 }, title: "late knowledge",
      markdown: "late knowledge", citations: [],
    };
    const wiki = {
      search: jest.fn<any>().mockImplementation(async () => {
        if (stage === "search") { enter(); return gate; }
        return [page];
      }),
      coverage: jest.fn<any>().mockImplementation(async () => { enter(); return gate; }),
    };
    const h = wikiSearch(wiki);
    const deadline = new AbortController();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const timer = jest.spyOn(AbortSignal, "timeout").mockImplementation(ms =>
      ms === 15000 ? deadline.signal : timeout(ms));
    try {
      const pending = h.runtime.runWorker(h.input);
      await entered;
      expect(h.retrieval.searchWithTrace).not.toHaveBeenCalled();
      deadline.abort(new DOMException("Wiki stage timed out", "TimeoutError"));
      const result = await pending;
      release(stage === "search" ? [page] : "full");
      await Promise.resolve();
      expect(h.input.environment.signal.aborted).toBe(false);
      expect(wiki.search.mock.calls[0]![3]).toMatchObject({ aborted: true });
      expect(h.retrieval.searchWithTrace).toHaveBeenCalledTimes(1);
      expect(result.citations.map(c => c.id)).toEqual(["kb-raw"]);
      expect(result.wiki_reads).toEqual([]);
      expect(h.audit.tool.mock.calls.some((args: any[]) =>
        args[4] === "success" && args[5].wiki_fallback?.[0] === "timeout")).toBe(true);
    } finally { timer.mockRestore(); }
  });

  test("cancelling a blocked Wiki query does not start original retrieval or another model call", async () => {
    let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    let release!: (value: any) => void;
    const gate = new Promise<any>(resolve => { release = resolve; });
    const wiki = { search: jest.fn<any>().mockImplementation(async () => { enter(); return gate; }) };
    const h = wikiSearch(wiki);
    const stop = new AbortController();
    h.input.environment.signal = stop.signal;
    const pending = h.runtime.runWorker(h.input);
    const rejected = expect(pending).rejects.toThrow("user stopped");
    await entered;
    stop.abort(new Error("user stopped"));
    await rejected;
    release([]);
    await Promise.resolve();
    expect(h.retrieval.searchWithTrace).not.toHaveBeenCalled();
    expect(h.llm.agentTurn).toHaveBeenCalledTimes(1);
    expect(h.events.some(event => event.event === "tool_result" && event.status === "success")).toBe(false);
  });

  test("Wiki fallback cannot hide a failure of original retrieval", async () => {
    const h = wikiSearch({ search: jest.fn<any>().mockRejectedValue(new Error("Wiki unavailable")) });
    h.retrieval.searchWithTrace.mockRejectedValue(new Error("original retrieval unavailable"));
    h.llm.agentTurn.mockResolvedValue(call("search_knowledge_base", { query: "knowledge" }));
    await expect(h.runtime.runWorker(h.input)).rejects.toThrow("original retrieval unavailable");
    expect(h.events.some(event => event.event === "tool_result" && event.status === "success")).toBe(false);
  });

  test("reader cannot acquire search, proposal or MCP tools through expansion or repair", async () => {
    const h = harness();
    h.input.environment.request.allow_web = true;
    h.input.environment.request.knowledge_scope = {
      private: true,
      public: false,
      team: false,
      document_ids: [],
    };
    h.mcp.tools.set("mcp__unknown__search", {
      research: false,
      schema: {
        type: "function",
        function: {
          name: "mcp__unknown__search",
          parameters: { type: "object" },
        },
      },
    });
    for (const all of [false, true]) {
      const names = h.tools
        .allowedTools(h.input, all)
        .map((t) => t.function.name);
      expect(names).not.toContain("search_knowledge_base");
      expect(names).not.toContain("search_web");
      expect(names).not.toContain("propose_document_edits");
      expect(names).not.toContain("mcp__unknown__search");
    }
    h.llm.agentTurn.mockResolvedValue(
      call("search_knowledge_base", { query: "forbidden" }),
    );
    await expect(h.runtime.runWorker(h.input)).rejects.toThrow(
      "工具未加载或当前模式无权限",
    );
    expect(h.retrieval.searchWithTrace).not.toHaveBeenCalled();
    expect(h.input.environment.budget.tool_calls).toBe(0);
  });

  test("researcher receives only explicitly declared MCP research tools and request grants", () => {
    const h = harness();
    h.input.role = "researcher";
    h.input.step!.capability = "search";
    h.input.environment.request.allow_web = true;
    for (const [name, research] of [
      ["mcp__known__fetch", true],
      ["mcp__unknown__admin", false],
    ] as const)
      h.mcp.tools.set(name, {
        research,
        schema: { type: "function", function: { name } },
      });
    expect(
      h.tools.allowedTools(h.input, true).map((t) => t.function.name),
    ).toContain("mcp__known__fetch");
    expect(
      h.tools.allowedTools(h.input, true).map((t) => t.function.name),
    ).not.toContain("mcp__unknown__admin");
    h.input.environment.request.allow_web = false;
    expect(
      h.tools
        .allowedTools(h.input, true)
        .some((t) => t.function.name.startsWith("mcp__")),
    ).toBe(false);
    expect(
      h.tools
        .allowedTools(h.input, true)
        .some((t) => t.function.name === "search_web"),
    ).toBe(false);
  });

  test("unrelated workers cannot cite another worker; declared dependencies deliver actual evidence", async () => {
    const h = harness();
    h.input.environment.request.references = [
      { id: "note", kind: "text", title: "note", content: "private proof" },
    ];
    h.llm.agentTurn.mockImplementation(async (messages: any[]) =>
      outputs(messages).length
        ? call("finish_answer", {
            answer: "supported",
            citation_ids: [outputs(messages)[0].citation_id],
          })
        : call("read_reference", { reference_id: "note" }),
    );
    const a = await h.runtime.runWorker(h.input);
    const citationId =
      a.result.kind === "answer" ? a.result.citation_ids[0] : "";
    h.llm.agentTurn.mockResolvedValue(
      call("finish_answer", { answer: "stolen", citation_ids: [citationId] }),
    );
    await expect(
      h.runtime.runWorker({
        ...h.input,
        task_id: "unrelated",
        step: { ...h.input.step!, id: "b" },
      }),
    ).rejects.toThrow("未知资料");
    h.llm.agentTurn.mockImplementation(async (messages: any[]) => {
      const payload = JSON.parse(messages[1].content);
      expect(payload.step_results).toEqual({
        a: expect.stringContaining("supported"),
      });
      expect(payload.dependency_evidence[0].content).toBe("private proof");
      expect(payload.dependency_handoffs.a).toMatchObject({
        coverage: "complete", findings: [{ statement: "supported", evidence_ids: [citationId] }],
        missing: [], conflicts: [],
      });
      return call("finish_answer", {
        answer: "derived",
        citation_ids: [citationId],
      });
    });
    const b = await h.runtime.runWorker({
      ...h.input,
      task_id: "dependent",
      step: { ...h.input.step!, id: "b", depends_on: ["a"] },
      dependencies: { a },
    });
    expect(b.citations.map((c) => c.id)).toContain(citationId);
    await expect(
      h.runtime.runWorker({ ...h.input, dependencies: { a } }),
    ).rejects.toThrow("未声明");
  });

  test("current-document read proofs are not inherited by the primary candidate producer", async () => {
    const h = harness();
    h.llm.agentTurn.mockImplementation(async (messages: any[]) =>
      outputs(messages).length
        ? call("finish_answer", {
            answer: "read",
            citation_ids: [outputs(messages)[0].citation_id],
          })
        : call("read_current_document", { region_ids: ["b0"] }),
    );
    const read = await h.runtime.runWorker(h.input);
    const primary: WorkerInput = {
      ...h.input,
      role: "primary",
      step: undefined,
      dependencies: { a: read },
      environment: { ...h.input.environment, request: request() },
    };
    const edit = {
      edits: [
        {
          id: "e",
          operation: "replace",
          target: { kind: "block_range", first_region_id: "b0" },
          content_markdown: "changed",
          explanation: "rewrite",
          citation_ids: [],
        },
      ],
    };
    h.llm.agentTurn.mockResolvedValue(call("propose_document_edits", edit));
    await expect(h.runtime.runWorker(primary)).rejects.toThrow("先读取");
    h.llm.agentTurn.mockImplementation(async (messages: any[]) =>
      outputs(messages).length
        ? call("propose_document_edits", edit)
        : call("read_current_document", { region_ids: ["b0"] }),
    );
    expect((await h.runtime.runWorker(primary)).result.kind).toBe("edits");
  });

  test("multiple observations retain original source and each compressed passage", async () => {
    const h = harness();
    h.input.role = "researcher";
    h.input.step!.capability = "search";
    h.input.environment.request.knowledge_scope = {
      private: true,
      public: false,
      team: false,
      document_ids: [],
    };
    h.retrieval.searchWithTrace.mockImplementation(
      async (args: any, context: any) => {
        expect(context.user_id).toBe("alice");
        expect(args.scope.document_ids).toEqual([]);
        return {
          citations: [
            {
              citation_id: "doc:1:chunk",
              doc_id: "doc",
              document_version: 1,
              title: "source",
              content: args.query,
              source_content: "alpha beta original",
            },
          ],
        };
      },
    );
    h.llm.agentTurn.mockImplementation(async (messages: any[]) => {
      const count = outputs(messages).length;
      return count < 2
        ? call("search_knowledge_base", {
            query: count ? "beta excerpt" : "alpha excerpt",
          })
        : call("finish_answer", {
            answer: "both",
            citation_ids: ["kb-doc:1:chunk"],
          });
    });
    const result = await h.runtime.runWorker(h.input);
    expect(result.citations[0]!.source_content).toBe("alpha beta original");
    expect(result.observations.map((o) => o.content)).toEqual([
      "alpha excerpt",
      "beta excerpt",
    ]);
    expect(result.usage).toMatchObject({
      model_requests: 3,
      execution_turns: 3,
      tool_calls: 3,
      prompt_tokens: 9,
      completion_tokens: 6,
    });
  });

  test("native web model usage is counted and unused sources are not delivered", async () => {
    const h = harness();
    h.input.role = "researcher";
    h.input.step!.capability = "search";
    h.input.environment.request.allow_web = true;
    h.llm.searchWeb.mockResolvedValue({
      summary: "a synthetic fact",
      sources: [
        { title: "source", url: "https://example.com", content: "proof" },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    h.llm.agentTurn.mockImplementation(async (messages: any[]) =>
      outputs(messages).length
        ? call("finish_answer", {
            answer: "No source adopted",
            citation_ids: [],
          })
        : call("search_web", { query: "synthetic question" }),
    );
    const result = await h.runtime.runWorker(h.input);
    expect(result.usage).toMatchObject({
      execution_turns: 2,
      model_requests: 3,
      tool_calls: 2,
      prompt_tokens: 16,
      completion_tokens: 9,
    });
    expect(h.input.environment.budget).toMatchObject({ ...result.usage });
    expect(h.input.environment.budget.reserved_tokens).toBe(0);
    expect(result.citations).toEqual([]);
    expect(result.evidence).toEqual([]);
    expect(result.observations).toEqual([]);
  });

  test("shared execution budget is reserved before parallel model requests", async () => {
    const h = harness();
    Object.defineProperty(h.config, "agentMaxToolCalls", { value: 2 });
    h.llm.agentTurn.mockResolvedValue(
      call("finish_answer", { answer: "ok", citation_ids: [] }),
    );
    const settled = await Promise.allSettled(
      ["a", "b", "c"].map((id) =>
        h.runtime.runWorker({
          ...h.input,
          task_id: id,
          step: { ...h.input.step!, id },
        }),
      ),
    );
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(h.llm.agentTurn).toHaveBeenCalledTimes(2);
    expect(h.input.environment.budget.execution_turns).toBe(2);
    expect(
      new Set(
        h.events.filter((e) => e.event === "tool_start").map((e) => e.call_id),
      ).size,
    ).toBe(2);
    expect(
      h.audit.tool.mock.calls.every(
        (args: any[]) => args[1] !== "same-provider-id",
      ),
    ).toBe(true);
  });

  test("one worker cannot exceed four execution turns", async () => {
    const h = harness();
    h.llm.agentTurn.mockResolvedValue(
      call("read_current_document", { region_ids: ["b0"] }),
    );
    await expect(h.runtime.runWorker(h.input)).rejects.toThrow("工具调用上限");
    expect(h.llm.agentTurn).toHaveBeenCalledTimes(4);
  });

  test("the final worker turn submits findings instead of spending its remaining turn on another read", async () => {
    const h = harness();
    h.llm.agentTurn.mockImplementation(async (_messages: any[], tools: any[]) =>
      tools.some(tool => tool.function.name === "read_current_document")
        ? call("read_current_document", { region_ids: ["b0"] })
        : call("finish_answer", { answer: "已读取 first，其余信息未记录", citation_ids: [] }));
    const result = await h.runtime.runWorker(h.input);
    expect(result.result).toMatchObject({ kind: "answer", answer: "已读取 first，其余信息未记录" });
    expect(h.llm.agentTurn).toHaveBeenCalledTimes(4);
    expect((h.llm.agentTurn.mock.calls[3]![1] as any[]).map((tool: any) => tool.function.name))
      .not.toContain("read_current_document");
  });

  test("a supervised worker cannot consume turns reserved for finalization or raise the global ceiling", async () => {
    const h = harness();
    h.input.environment.execution_limit = 1;
    h.llm.agentTurn.mockResolvedValue(
      call("read_current_document", { region_ids: ["b0"] }),
    );
    await expect(h.runtime.runWorker(h.input)).rejects.toThrow("工具调用上限");
    expect(h.llm.agentTurn).toHaveBeenCalledTimes(1);
    expect(h.input.environment.budget.execution_turns).toBe(1);
    const limited = harness();
    Object.defineProperty(limited.config, "agentMaxToolCalls", { value: 1 });
    limited.input.environment.execution_limit = 100;
    limited.llm.agentTurn.mockResolvedValue(
      call("read_current_document", { region_ids: ["b0"] }),
    );
    await expect(limited.runtime.runWorker(limited.input)).rejects.toThrow(
      "工具调用上限",
    );
    expect(limited.llm.agentTurn).toHaveBeenCalledTimes(1);
  });

  test("failed dependencies cannot become model context", async () => {
    const h = harness();
    const dependency = {
      result: { kind: "clarification", question: "missing", choices: [] },
    } as unknown as WorkerOutput;
    h.input.step!.depends_on = ["a"];
    h.input.dependencies = { a: dependency };
    await expect(h.runtime.runWorker(h.input)).rejects.toThrow("没有成功回答");
    expect(h.llm.agentTurn).not.toHaveBeenCalled();
  });
});
