import { describe, expect, test } from "@jest/globals";
import { validateWorkerHandoff, workerHandoffInput } from "../src/ai/agent-handoff.js";

const finding = { statement: "负责人为陈青", evidence_ids: ["read"] };
const observed = [{ citation_id: "read", content: "陈青负责" }];
const complete = { findings: [finding], missing: [], conflicts: [] };

describe("structured worker handoff boundary", () => {
  test.each([
    [complete, "complete"],
    [{ ...complete, missing: ["预算金额缺失"] }, "partial"],
    [{ findings: [], missing: ["资料不可用"], conflicts: [] }, "insufficient"],
    [{ ...complete, conflicts: [{ description: "负责人存在冲突", evidence_ids: ["read"] }] }, "conflicted"],
  ])("derives coverage from bounded fields: %j", (input, coverage) => {
    const value = validateWorkerHandoff(input, ["read"], observed);
    expect(value.coverage).toBe(coverage);
    expect(validateWorkerHandoff(workerHandoffInput(value), ["read"], observed)).toEqual(value);
  });

  test.each([
    undefined, { findings: [], missing: [], conflicts: [] },
    { ...complete, coverage: "complete" }, { ...complete, missing: ["  "] },
    { ...complete, findings: [{ ...finding, statement: "x".repeat(501) }] },
    { ...complete, findings: [{ ...finding, evidence_ids: ["invented"] }] },
    { ...complete, conflicts: [{ description: "冲突", evidence_ids: ["invented"] }] },
  ])("rejects malformed, empty or invented delivery: %j", input => {
    expect(() => validateWorkerHandoff(input, ["read"], observed)).toThrow();
  });

  test("requires both adoption and actual observed content", () => {
    expect(() => validateWorkerHandoff(complete, [], observed)).toThrow("已采用");
    expect(() => validateWorkerHandoff(complete, ["read"], [])).toThrow("实际读取");
    expect(() => validateWorkerHandoff(complete, ["read"], [{ citation_id: "read", content: "  " }])).toThrow();
    expect(() => workerHandoffInput(undefined)).toThrow("缺少结构化交付");
  });
});
