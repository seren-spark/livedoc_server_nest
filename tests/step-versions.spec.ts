import { describe, expect, test } from "@jest/globals";
import { activeStepOutputs, dependencyClosure, stepArtifactKey, stepFingerprint } from "../src/ai/step-versions.js";
import type { ExecutionPlan } from "../src/ai/document-agent.types.js";

const steps: ExecutionPlan["steps"] = [
  { id: "read", capability: "read", description: "读取资料", depends_on: [] },
  { id: "research", capability: "search", description: "研究资料", depends_on: ["read"] },
  { id: "other", capability: "read", description: "独立读取", depends_on: [] },
  { id: "compose", capability: "compose", description: "汇总", depends_on: ["research", "other"] },
];
const outputs = { read: "step:read:v1", research: "step:research:v1", other: "step:other:v1", compose: "step:compose:v1" };

describe("versioned step output selection", () => {
  test("invalidates only the selected step and its transitive dependents", () => {
    expect(dependencyClosure(steps, ["read"])).toEqual(["read", "research", "compose"]);
    expect(dependencyClosure(steps, ["research"])).toEqual(["research", "compose"]);
    expect(dependencyClosure(steps, [])).toEqual([]);
    expect(() => dependencyClosure(steps, ["missing"])).toThrow("未知步骤");
  });

  test("selects active references while excluding outputs with unavailable dependencies", () => {
    expect(activeStepOutputs(steps, outputs, ["read"])).toEqual({ other: "step:other:v1" });
    expect(activeStepOutputs(steps, outputs, dependencyClosure(steps, ["research"])))
      .toEqual({ read: "step:read:v1", other: "step:other:v1" });
    expect(outputs.compose).toBe("step:compose:v1");
  });

  test("accepts versioned and legacy references and non-topological plan order", () => {
    const versioned = { ...outputs, read: { artifact_key: "step:read:v2", version: 2, input_fingerprint: "changed" } };
    expect(activeStepOutputs([...steps].reverse(), versioned)).toEqual({ ...outputs, read: "step:read:v2" });
    expect(activeStepOutputs(steps, { compose: "old", unknown: "unknown" })).toEqual({});
  });

  test("keeps downstream invalidation until each replacement succeeds", () => {
    const invalidated = dependencyClosure(steps, ["read"]).filter((id) => id !== "read");
    expect(activeStepOutputs(steps, { ...outputs, read: "step:read:v2" }, invalidated))
      .toEqual({ read: "step:read:v2", other: "step:other:v1" });
  });

  test("validates versioned outputs against the current context and step definition", () => {
    const versioned = Object.fromEntries(steps.map((step) => [step.id, {
      artifact_key: outputs[step.id as keyof typeof outputs], version: 1,
      input_fingerprint: stepFingerprint(step, outputs, "base:1"),
    }]));
    expect(activeStepOutputs(steps, versioned, [], "base:1")).toEqual(outputs);
    expect(activeStepOutputs(steps, versioned, [], "base:2")).toEqual({});
    const changed = steps.map((step) => step.id === "read" ? { ...step, description: "读取修订资料" } : step);
    expect(activeStepOutputs(changed, versioned, [], "base:1")).toEqual({ other: outputs.other });
  });

  test("a new upstream artifact invalidates downstream input fingerprints", () => {
    const versioned = Object.fromEntries(steps.map((step) => [step.id, {
      artifact_key: outputs[step.id as keyof typeof outputs], version: 1,
      input_fingerprint: stepFingerprint(step, outputs, "base:1"),
    }]));
    versioned.read = { ...versioned.read!, artifact_key: "step:read:v2", version: 2 };
    expect(activeStepOutputs(steps, versioned, [], "base:1"))
      .toEqual({ read: "step:read:v2", other: outputs.other });
    expect(activeStepOutputs(steps, outputs, [], "base:2")).toEqual(outputs);
  });

  test("fingerprints only relevant dependency versions and canonicalizes ordering", () => {
    const compose = steps[3]!;
    const original = stepFingerprint(compose, outputs, "context-v1");
    expect(stepFingerprint({ ...compose, depends_on: [...compose.depends_on].reverse() }, { ...outputs, read: "irrelevant" }, "context-v1")).toBe(original);
    expect(stepFingerprint(compose, { ...outputs, research: "step:research:v2" }, "context-v1")).not.toBe(original);
    expect(stepFingerprint(compose, outputs, "context-v2")).not.toBe(original);
    expect(stepFingerprint({ ...compose, description: "重新汇总" }, outputs, "context-v1")).not.toBe(original);
    expect(() => stepFingerprint(compose, {})).toThrow("依赖缺少");
  });

  test("artifact keys distinguish step identities and require positive versions", () => {
    expect(stepArtifactKey("read", 2)).toBe("step:read:v2");
    expect(stepArtifactKey("read:v1", 2)).toBe("step:read%3Av1:v2");
    for (const version of [0, -1, 0.5, NaN]) expect(() => stepArtifactKey("read", version)).toThrow();
  });
});
