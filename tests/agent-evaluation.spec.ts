import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { checkAgentAnswer, parseAgentCases } from "../scripts/agent-evaluation-checks.js";

const cases = parseAgentCases(JSON.parse(readFileSync(new URL("../evals/agent-cases.json", import.meta.url), "utf8")));
const item = cases[0]!;
const citations = [
  { id: "a", title: "人员", kind: "document" as const, doc_id: "source0", source_content: item.sources[0]!.content },
  { id: "b", title: "窗口", kind: "document" as const, doc_id: "source1", source_content: item.sources[1]!.content },
];
const answer = "负责人为陈青 [a]\n回滚窗口为上线后48小时 [b]";
const check = (text: string, refs = citations) => checkAgentAnswer(item,
  { kind: "answer", answer: text, citation_ids: ["a", "b"] }, refs, ["source0", "source1"]);

describe("business evaluation gates", () => {
  test("accepts required facts bound to adopted original evidence", () => expect(check(answer).passed).toBe(true));
  test.each([
    "负责人为陈青\n回滚窗口为上线后48小时", // Keywords alone do not pass.
    "负责人为陈青 [b]\n回滚窗口为上线后48小时 [a]", // Wrong source.
    "负责人未知 [a]\n回滚窗口未知 [b]", // Citations alone do not pass.
  ])("rejects missing or incorrectly cited facts: %s", text => expect(check(text).passed).toBe(false));
  test("rejects unauthorized or non-supporting source content", () => {
    expect(check(answer, [{ ...citations[0]!, doc_id: "foreign" }, citations[1]!]).passed).toBe(false);
    expect(check(answer, [{ ...citations[0]!, source_content: "不包含负责人" }, citations[1]!]).passed).toBe(false);
  });
  test("rejects fabricated amounts even alongside correct missing information", () => {
    const missing = cases.find(value => value.id === "missing")!;
    const result = checkAgentAnswer(missing, { kind: "answer", citation_ids: [], answer: "林川，预算未审批，预算为100万元" }, [], []);
    expect(result.checks.find(value => value.name.startsWith("forbidden:"))?.passed).toBe(false);
  });
  test("dataset validates fact provenance, IDs and patterns before invoking models", () => {
    expect(cases.length).toBeGreaterThanOrEqual(5);
    expect(() => parseAgentCases([item, item, item])).toThrow("重复");
    expect(() => parseAgentCases(cases.map(value => value.id === item.id ? { ...value,
      facts: [{ answer_pattern: "负责人", evidence_pattern: "不存在的原文", source_index: 0 }] } : value))).toThrow("原文不存在");
  });
});
