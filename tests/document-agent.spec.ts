import { describe, expect, test } from "@jest/globals";
import { isPublicAddress, htmlToMarkdown } from "../src/ai/public-web-fetch.js";
import {
  validateAgentRequest,
  validateAgentResult,
  validatePlan,
  selectAgentCitations,
} from "../src/ai/document-agent.validation.js";
import { ruleRoute } from "../src/ai/document-agent.service.js";
import { request } from "./fixtures/agent-request.js";
describe("agent permissions and execution contracts", () => {
  test("publishes only adopted citations, preserving declared order and edit unions", () => {
    const available = new Map(['a', 'b', 'c'].map((id) => [id, { id, title: id, kind: 'text' as const }]));
    expect(selectAgentCitations({ kind: 'answer', answer: 'fact [b]', citation_ids: ['b', 'b', 'a'] }, available)
      .map((c) => c.id)).toEqual(['b', 'a']);
    expect(selectAgentCitations({ kind: 'document', document_id: 'd', title: 'd', markdown: 'fact', citation_ids: ['c'] }, available)
      .map((c) => c.id)).toEqual(['c']);
    const edit = { id: 'e', operation: 'delete' as const, target: { kind: 'selection' as const }, explanation: 'remove', citation_ids: ['a'] };
    expect(selectAgentCitations({ kind: 'edits', edits: [edit, { ...edit, id: 'f', citation_ids: ['b', 'a'] }] }, available)
      .map((c) => c.id)).toEqual(['a', 'b']);
    expect(selectAgentCitations({ kind: 'clarification', question: 'which?', choices: [] }, available)).toEqual([]);
    expect(() => selectAgentCitations({ kind: 'answer', answer: 'x', citation_ids: ['unknown'] }, available)).toThrow('未知资料');
  });
  test("rejects identical replacements while allowing a real formatting change", () => {
    const input = request();
    const candidate = {
      kind: "edits",
      edits: [
        {
          id: "noop",
          operation: "replace",
          target: { kind: "block_range", first_region_id: "b0" },
          content_markdown: "  first\r\n",
          explanation: "rewrite",
          citation_ids: [],
        },
      ],
    };
    expect(() => validateAgentResult(candidate, input, new Set())).toThrow(
      "没有实际修改",
    );
    candidate.edits[0]!.content_markdown = "**first**";
    expect(() =>
      validateAgentResult(candidate, input, new Set()),
    ).not.toThrow();
  });
  test("technical code is data, while active unsafe links and HTML are rejected", () => {
    const input = request();
    input.output_target = "new_document";
    const candidate = {
      kind: "document",
      title: "技术说明",
      markdown:
        "```ts\nconst payload = { data: 1 };\n```\n\n```html\n<script>example()</script>\n```",
      citation_ids: [],
    };
    expect(() =>
      validateAgentResult(candidate, input, new Set()),
    ).not.toThrow();
    candidate.markdown = "[unsafe](javascript:alert(1))";
    expect(() => validateAgentResult(candidate, input, new Set())).toThrow();
    candidate.markdown = '<img src="https://example.com/x">';
    expect(() => validateAgentResult(candidate, input, new Set())).toThrow();
  });
  test("confirmed plan wins; rules classify task semantics instead of length", () => {
    const r = request();
    expect(ruleRoute(r)?.strategy).toBe("react");
    r.query = "先检索，然后对比，再生成整篇文稿";
    expect(ruleRoute(r)?.strategy).toBe("plan_execute");
    r.confirmed_plan = {
      goal: "x",
      outline: [],
      constraints: [],
      steps: [
        { id: "s", description: "read", depends_on: [], capability: "read" },
      ],
    };
    expect(ruleRoute(r)?.source).toBe("confirmed_plan");
  });
  test("checks snapshots and cyclic or unknown plan dependencies", () => {
    const r = request();
    expect(() => validateAgentRequest(r)).not.toThrow();
    r.editor_snapshot.regions[0]!.original_json = { type: "heading" };
    expect(() => validateAgentRequest(r)).toThrow();
    expect(() =>
      validatePlan({
        goal: "x",
        outline: [],
        constraints: [],
        steps: [
          { id: "s", description: "x", capability: "read", depends_on: ["s"] },
        ],
      }),
    ).toThrow();
  });
  test("Ask and Plan cannot emit document changes; citations and ranges are checked", () => {
    const result = {
      kind: "edits",
      edits: [
        {
          id: "a",
          operation: "replace",
          target: { kind: "block_range", first_region_id: "b0" },
          content_markdown: "new",
          explanation: "x",
          citation_ids: [],
        },
      ],
    };
    expect(() =>
      validateAgentResult(result, request("ask"), new Set()),
    ).toThrow();
    expect(() =>
      validateAgentResult(result, request("plan"), new Set()),
    ).toThrow();
    expect(() =>
      validateAgentResult(result, request(), new Set()),
    ).not.toThrow();
    result.edits.push({ ...result.edits[0]!, id: "b" });
    expect(() => validateAgentResult(result, request(), new Set())).toThrow();
  });
  test("blocks URL schemes, new image assets and nonexistent citations", () => {
    const r = request();
    r.output_target = "new_document";
    const base = {
      kind: "document",
      title: "x",
      markdown: "good",
      citation_ids: ["unknown"],
    };
    expect(() => validateAgentResult(base, r, new Set())).toThrow();
    base.citation_ids = [];
    base.markdown = "![image](https://example.com/x)";
    expect(() => validateAgentResult(base, r, new Set())).toThrow();
  });
});
describe("public fetch address guard", () => {
  test.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:192.168.1.1",
    "::ffff:c0a8:101",
    "2002:7f00:1::",
    "2001:db8::1",
  ])("rejects %s", (address) => expect(isPublicAddress(address)).toBe(false));
  test.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
    "allows %s",
    (address) => expect(isPublicAddress(address)).toBe(true),
  );
  test("converts text headings without scripts", () =>
    expect(
      htmlToMarkdown("<script>alert(1)</script><h2>Title</h2><p>A &amp; B</p>"),
    ).toBe("## Title\n\nA & B"));
});
