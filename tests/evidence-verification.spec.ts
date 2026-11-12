import { describe, expect, jest, test } from "@jest/globals";
import { AgentExecutionError } from "../src/ai/agent-execution.js";
import {
  EvidenceVerificationService,
  type VerificationInput,
  type VerificationReport,
} from "../src/ai/evidence-verification.service.js";
import type { AgentMessage } from "../src/ai/document-agent.types.js";
import { request } from "./fixtures/agent-request.js";

function input(): VerificationInput {
  return {
    candidate: { kind: "answer", answer: "负责人为陈青。[a]", citation_ids: ["a"] },
    candidate_version: 0,
    request: request("ask"),
    citations: [{ id: "a", kind: "document", title: "项目资料", doc_id: "d", version: 1 }],
    evidence: [["a", "项目负责人为陈青。"]],
    step_evidence: { research: ["a"], unrelated: [] },
  };
}

function supported(): VerificationReport {
  return {
    candidate_version: 0,
    passed: true,
    claims: [{ id: "c", location: { field: "answer", start: 0, end: 10 },
      text: "负责人为陈青。[a]", citation_ids: ["a"], step_ids: ["research"],
      status: "supported", reason: "原文明确记录负责人。" }],
    recovery: { action: "none", claim_ids: [], step_ids: [], instruction: "" },
  };
}

function unsupported(): VerificationReport {
  const report = supported();
  report.passed = false;
  report.claims[0]!.status = "unsupported";
  report.claims[0]!.reason = "负责人信息与原文不一致。";
  report.recovery = { action: "repair", claim_ids: ["c"], step_ids: ["research"], instruction: "依据原文修正负责人。" };
  return report;
}

function response(value: unknown) {
  return jest.fn<any>().mockResolvedValue({ role: "assistant", content: JSON.stringify(value) });
}

describe("evidence verification boundary", () => {
  test("uses an injected single-attempt budgeted model turn and binds exact candidate version", async () => {
    const turn = response(supported());
    const report = await new EvidenceVerificationService().verify(input(), turn);
    expect(report).toEqual(supported());
    expect(turn).toHaveBeenCalledTimes(1);
    expect(turn.mock.calls[0]![1]).toMatchObject({ role: "critic", json: true, maxAttempts: 1, trace_name: "evidence_verification" });
    const messages = turn.mock.calls[0]![0] as AgentMessage[];
    const payload = JSON.parse(messages[1]!.content!);
    expect(payload.purpose).toBe("evidence_verification");
    expect(payload.segments).toEqual([{ location: { field: "answer", start: 0, end: 10 }, text: "负责人为陈青。[a]" }]);
    expect(payload.evidence[0].id).toBe("a");
  });

  test("accepts a grounded recovery action without considering candidate accepted", async () => {
    const report = await new EvidenceVerificationService().verify(input(), response(unsupported()));
    expect(report.passed).toBe(false);
    expect(report.recovery.action).toBe("repair");
  });

  test.each([
    ["candidate version", (report: VerificationReport) => { report.candidate_version = 1; }],
    ["invented citation", (report: VerificationReport) => { report.claims[0]!.citation_ids = ["invented"]; }],
    ["invented step", (report: VerificationReport) => { report.claims[0]!.step_ids = ["invented"]; }],
    ["unrelated step", (report: VerificationReport) => { report.claims[0]!.step_ids = ["unrelated"]; }],
    ["invalid position", (report: VerificationReport) => { report.claims[0]!.location.end = 6; }],
    ["wrong field", (report: VerificationReport) => { report.claims[0]!.location.field = "markdown"; }],
    ["missing evidence", (report: VerificationReport) => { report.claims[0]!.citation_ids = []; }],
    ["conflict without two sources", (report: VerificationReport) => { report.claims[0]!.status = "conflicted"; }],
    ["duplicate claim", (report: VerificationReport) => { report.claims.push(structuredClone(report.claims[0]!)); }],
    ["empty claims with citations", (report: VerificationReport) => { report.claims = []; }],
    ["inconsistent passed", (report: VerificationReport) => { report.passed = false; }],
  ])("rejects %s as recoverable verification unavailability", async (_name, mutate) => {
    const report = supported();
    mutate(report);
    await expect(new EvidenceVerificationService().verify(input(), response(report)))
      .rejects.toMatchObject({ code: "VERIFICATION_UNAVAILABLE", retryable: true });
  });

  test("requires coverage of every paragraph instead of one cited substring", async () => {
    const value = input();
    if (value.candidate.kind === "answer") value.candidate.answer += "\n\n预算为200万元。";
    await expect(new EvidenceVerificationService().verify(value, response(supported())))
      .rejects.toMatchObject({ code: "VERIFICATION_UNAVAILABLE" });
  });

  test("turns an available but unadopted citation into a repairable unsupported claim", async () => {
    const value = input();
    if (value.candidate.kind === "answer") value.candidate.citation_ids = [];
    const report = await new EvidenceVerificationService().verify(value, response(supported()));
    expect(report.passed).toBe(false);
    expect(report.claims[0]!.status).toBe("unsupported");
    expect(report.recovery).toMatchObject({ action: "repair", claim_ids: ["c"] });
  });

  test("requires a citation marker in the same paragraph rather than only in the report", async () => {
    const value = input();
    if (value.candidate.kind === "answer") value.candidate.answer = "负责人为陈青。";
    const verdict = supported();
    verdict.claims[0]!.text = "负责人为陈青。";
    verdict.claims[0]!.location.end = 7;
    const report = await new EvidenceVerificationService().verify(value, response(verdict));
    expect(report.passed).toBe(false);
    expect(report.recovery.action).toBe("repair");
  });

  test("does not require inline markers in selection edit content", async () => {
    const value = input();
    value.request = request("agent");
    value.candidate = { kind: "edits", edits: [{ id: "e", operation: "replace", target: { kind: "selection" },
      content_markdown: "负责人为陈青。", citation_ids: [], explanation: "保持原意" }] };
    value.citations[0]!.kind = "current_document";
    const verdict = supported();
    verdict.claims[0]!.text = "负责人为陈青。";
    verdict.claims[0]!.location = { field: "edit", edit_id: "e", start: 0, end: 7 };
    expect((await new EvidenceVerificationService().verify(value, response(verdict))).passed).toBe(true);
  });

  test("keeps code and tables intact while requiring their adopted, observed sources", async () => {
    const value = input();
    const paragraph = "以下代码将窗口设置为48小时。[a]";
    const code = "```ts\nconst windowHours = 48;\n\nconsole.log(windowHours);\n```";
    const table = "| 字段 | 值 |\n| --- | --- |\n| 回滚窗口 | 48小时 |";
    const markdown = `# 技术文章\n\n---\n\n${paragraph}\n\n${code}\n\n${table}`;
    value.candidate = { kind: "document", document_id: "article", title: "技术文章", markdown, citation_ids: ["a"] };
    value.evidence = [["a", `窗口设置为48小时。\n\n${code}\n\n${table}`]];
    const verdict = supported();
    verdict.claims = [paragraph, code, table].map((text, index) => ({
      ...supported().claims[0]!, id: `c${index}`, text,
      location: { field: "markdown", start: markdown.indexOf(text), end: markdown.indexOf(text) + text.length },
    }));
    const turn = response(verdict);
    expect((await new EvidenceVerificationService().verify(value, turn)).passed).toBe(true);
    expect(value.candidate.markdown).toBe(markdown);
    const messages = turn.mock.calls[0]![0] as AgentMessage[];
    const segments = JSON.parse(messages[1]!.content!).segments;
    expect(segments.map((segment: { text: string }) => segment.text)).toEqual([paragraph, code, table]);
    expect(segments[1].inline_citation_required).toBe(false);
    expect(segments[2].inline_citation_required).toBe(false);
  });

  test("pure Markdown structure can pass without a model call", async () => {
    const value = input();
    value.candidate = { kind: "document", document_id: "outline", title: "结构",
      markdown: "# 技术文章\n\n## 1. 代码示例\n\n---\n\n## 参考资料", citation_ids: ["a"] };
    const turn = response(supported());
    expect((await new EvidenceVerificationService().verify(value, turn)).passed).toBe(true);
    expect(turn).not.toHaveBeenCalled();
  });

  test("a factual heading remains in verification coverage", async () => {
    const value = input();
    const markdown = "# 回滚窗口为72小时";
    value.candidate = { kind: "document", document_id: "factual", title: "窗口", markdown, citation_ids: ["a"] };
    value.evidence = [["a", "回滚窗口为48小时。"]];
    await expect(new EvidenceVerificationService().verify(value, response({ ...supported(), claims: [] })))
      .rejects.toMatchObject({ code: "VERIFICATION_UNAVAILABLE" });
    const verdict = unsupported();
    verdict.claims[0]!.text = markdown;
    verdict.claims[0]!.location = { field: "markdown", start: 0, end: markdown.length };
    const report = await new EvidenceVerificationService().verify(value, response(verdict));
    expect(report.passed).toBe(false);
    expect(report.claims[0]!.status).toBe("unsupported");
  });

  test.each([
    "```ts\nconst windowHours = 48;\n```",
    "| 窗口 | 时长 |\n| --- | --- |\n| 回滚 | 48小时 |",
  ])("protected blocks still require adopted and observed citations", async (markdown) => {
    const value = input();
    value.candidate = { kind: "document", document_id: "protected", title: "代码与表格", markdown, citation_ids: [] };
    const verdict = supported();
    verdict.claims[0]!.text = markdown;
    verdict.claims[0]!.location = { field: "markdown", start: 0, end: markdown.length };
    expect((await new EvidenceVerificationService().verify(value, response(verdict))).passed).toBe(false);
    verdict.claims[0]!.citation_ids = ["not-observed"];
    await expect(new EvidenceVerificationService().verify(value, response(verdict)))
      .rejects.toMatchObject({ code: "VERIFICATION_UNAVAILABLE" });
  });

  test("does not let an omitted citation bypass a selected knowledge scope", async () => {
    const value = input();
    value.candidate = { kind: "answer", answer: "预算为200万元。", citation_ids: [] };
    value.request.knowledge_scope = { private: true, team: false, public: false, document_ids: [] };
    value.citations = [];
    value.evidence = [];
    await expect(new EvidenceVerificationService().verify(value, response({ ...supported(), claims: [] })))
      .rejects.toMatchObject({ code: "VERIFICATION_UNAVAILABLE" });
    const unknown = {
      candidate_version: 0,
      claims: [{ id: "missing", location: { field: "answer", start: 0, end: 9 }, text: "预算为200万元。",
        citation_ids: [], step_ids: [], status: "unknown", reason: "资料未记录预算。" }],
      recovery: { action: "clarify", claim_ids: ["missing"], step_ids: [], instruction: "请补充预算依据。", question: "预算来源是什么？" },
    };
    expect((await new EvidenceVerificationService().verify(value, response(unknown))).passed).toBe(false);
  });

  test("allows empty claims when no content requires evidence", async () => {
    const value = input();
    value.candidate = { kind: "answer", answer: "以下是文章结构建议。", citation_ids: [] };
    value.evidence = [];
    value.citations = [];
    const turn = response({ ...supported(), claims: [] });
    const report = await new EvidenceVerificationService().verify(value, turn);
    expect(report.passed).toBe(true);
    expect(turn).not.toHaveBeenCalled();
  });

  test("plans and clarification results do not consume a verification request", async () => {
    const value = input();
    const turn = response(supported());
    value.candidate = { kind: "clarification", question: "请补充资料", choices: [] };
    expect((await new EvidenceVerificationService().verify(value, turn)).passed).toBe(true);
    value.candidate = { kind: "plan", plan: { goal: "写作", outline: [], constraints: [], steps: [] } };
    expect((await new EvidenceVerificationService().verify(value, turn)).passed).toBe(true);
    expect(turn).not.toHaveBeenCalled();
  });

  test("requires actual observation content and candidate citation membership", async () => {
    const value = input();
    value.evidence = [["invented", "资料"]];
    await expect(new EvidenceVerificationService().verify(value, response(supported())))
      .rejects.toMatchObject({ code: "VERIFICATION_UNAVAILABLE" });
    value.evidence = input().evidence;
    value.citations = [];
    await expect(new EvidenceVerificationService().verify(value, response(supported())))
      .rejects.toMatchObject({ code: "VERIFICATION_UNAVAILABLE" });
  });

  test("requires recovery to include every failed claim and affected steps only", async () => {
    const report = unsupported();
    report.recovery.step_ids = ["unrelated"];
    await expect(new EvidenceVerificationService().verify(input(), response(report)))
      .rejects.toMatchObject({ code: "VERIFICATION_UNAVAILABLE" });
    report.recovery.step_ids = ["research"];
    report.recovery.claim_ids = [];
    await expect(new EvidenceVerificationService().verify(input(), response(report)))
      .rejects.toMatchObject({ code: "VERIFICATION_UNAVAILABLE" });
  });

  test("preserves budget and cancellation errors without retrying", async () => {
    const budget = new AgentExecutionError("AGENT_BUDGET_EXCEEDED", "额度不足");
    const turn = jest.fn<any>().mockRejectedValue(budget);
    await expect(new EvidenceVerificationService().verify(input(), turn)).rejects.toBe(budget);
    expect(turn).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    const cancelled = new Error("cancelled");
    controller.abort(cancelled);
    await expect(new EvidenceVerificationService().verify({ ...input(), signal: controller.signal }, turn)).rejects.toBe(cancelled);
    expect(turn).toHaveBeenCalledTimes(1);
  });

  test("malformed JSON and unavailable model requests are recoverable", async () => {
    for (const turn of [response({ candidate_version: 0 }), jest.fn<any>().mockRejectedValue(new Error("offline"))]) {
      await expect(new EvidenceVerificationService().verify(input(), turn))
        .rejects.toMatchObject({ code: "VERIFICATION_UNAVAILABLE", retryable: true });
    }
  });
});

describe("evidence repair boundaries", () => {
  test("repairs with supplied evidence and preserves output kind", async () => {
    const revised = { kind: "answer", answer: "资料记载负责人是陈青。", citation_ids: ["a"] };
    const turn = response(revised);
    expect(await new EvidenceVerificationService().repair(input(), unsupported(), turn)).toEqual(revised);
    const messages = turn.mock.calls[0]![0] as AgentMessage[];
    expect(JSON.parse(messages[1]!.content!).purpose).toBe("evidence_repair");
    expect(turn.mock.calls[0]![1]).toMatchObject({ role: "main", maxAttempts: 1 });
  });

  test("requires the exact failed candidate version and a real change", async () => {
    const report = unsupported();
    report.candidate_version = 4;
    const turn = response(input().candidate);
    await expect(new EvidenceVerificationService().repair(input(), report, turn)).rejects.toMatchObject({ code: "VERIFICATION_UNAVAILABLE" });
    expect(turn).not.toHaveBeenCalled();
    await expect(new EvidenceVerificationService().repair(input(), unsupported(), turn)).rejects.toMatchObject({ code: "VERIFICATION_UNAVAILABLE" });
  });

  test.each(["id", "operation", "target", "count"]) ("preserves edit %s", async (field) => {
    const value = input();
    value.request = request("agent");
    value.candidate = { kind: "edits", edits: [{ id: "edit-1", operation: "replace", target: { kind: "selection" },
      content_markdown: "first changed", explanation: "修订", citation_ids: ["a"] }] };
    const revised = structuredClone(value.candidate);
    revised.edits[0]!.content_markdown = "first corrected";
    if (field === "id") revised.edits[0]!.id = "another";
    if (field === "operation") revised.edits[0]!.operation = "insert_after";
    if (field === "target") revised.edits[0]!.target = { kind: "cursor" };
    if (field === "count") revised.edits.push({ ...revised.edits[0]!, id: "new" });
    await expect(new EvidenceVerificationService().repair(value, unsupported(), response(revised)))
      .rejects.toMatchObject({ code: "VERIFICATION_UNAVAILABLE" });
  });

  test("repairs an existing selection while retaining its identity and exact target", async () => {
    const value = input();
    value.request = request("agent");
    value.candidate = { kind: "edits", edits: [{ id: "edit-1", operation: "replace", target: { kind: "selection" },
      content_markdown: "first changed", explanation: "修订", citation_ids: ["a"] }] };
    const revised = structuredClone(value.candidate);
    revised.edits[0]!.content_markdown = "first corrected";
    expect(await new EvidenceVerificationService().repair(value, unsupported(), response(revised))).toEqual(revised);
  });

  test("does not change the destination document", async () => {
    const value = input();
    value.request = request("agent");
    value.request.output_target = "new_document";
    value.candidate = { kind: "document", document_id: "original", title: "标题", markdown: "原始候选", citation_ids: ["a"] };
    await expect(new EvidenceVerificationService().repair(value, unsupported(), response({ ...value.candidate, document_id: "new", markdown: "修订候选" })))
      .rejects.toMatchObject({ code: "VERIFICATION_UNAVAILABLE" });
  });
});
