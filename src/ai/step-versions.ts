/**
 * @file 计划步骤版本。计算步骤指纹和产物标识，识别计划变更后可复用与需重做的步骤。
 */
import { createHash } from "node:crypto";
import type { ExecutionPlan } from "./document-agent.types.js";

type Step = ExecutionPlan["steps"][number];

export interface StepOutputVersion {
  artifact_key: string;
  version: number;
  input_fingerprint: string;
}

export type StepOutputs = Record<string, string | StepOutputVersion>;

/**
 * 按计划顺序返回已变化步骤及其所有传递依赖方。
 *
 *  Return the affected steps and their transitive dependents in plan order.
 *
 * @param steps 执行计划中的步骤集合。
 * @param seedIds seed 对应的标识集合。
 * @returns 整理后的字符串列表。
 */
export function dependencyClosure(steps: Step[], seedIds: readonly string[]): string[] {
  const known = new Set(steps.map((step) => step.id));
  if (seedIds.some((id) => !known.has(id)))
    throw new Error("重规划引用了未知步骤");
  const affected = new Set(seedIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) {
      if (!affected.has(step.id) && step.depends_on.some((id) => affected.has(id))) {
        affected.add(step.id);
        changed = true;
      }
    }
  }
  return steps.filter((step) => affected.has(step.id)).map((step) => step.id);
}

/**
 * 只复用当前步骤版本及其依赖仍有效的产物。
 *
 *  Select only current references whose dependencies are also currently available.
 *
 * @param steps 执行计划中的步骤集合。
 * @param outputs 已经完成的步骤输出。
 * @param invalidated 已经因计划变化而失效的步骤标记。
 * @param contextFingerprint 任务上下文或配置的稳定指纹（可选）。
 * @returns Record<string, string> 类型的处理结果。
 */
export function activeStepOutputs(
  steps: Step[],
  outputs: StepOutputs,
  invalidated: readonly string[] = [],
  contextFingerprint?: string,
): Record<string, string> {
  const invalid = new Set(invalidated);
  const selected = new Map<string, string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) {
      if (selected.has(step.id) || invalid.has(step.id) || !Object.hasOwn(outputs, step.id))
        continue;
      const value = outputs[step.id];
      const key = typeof value === "string" ? value : value?.artifact_key;
      if (key && step.depends_on.every((id) => selected.has(id))) {
        if (contextFingerprint !== undefined && typeof value !== "string" &&
          value?.input_fingerprint !== stepFingerprint(step, Object.fromEntries(selected), contextFingerprint))
          continue;
        selected.set(step.id, key);
        changed = true;
      }
    }
  }
  return Object.fromEntries(selected);
}

/**
 * 根据步骤定义与依赖生成版本指纹。
 *
 * @param step 当前计划步骤。
 * @param dependencyRefs 步骤依赖所引用的有效产物版本。
 * @param contextFingerprint 任务上下文或配置的稳定指纹。
 * @returns 整理后的文本或标识。
 */
export function stepFingerprint(
  step: Step,
  dependencyRefs: StepOutputs,
  contextFingerprint = "",
): string {
  const dependencies = [...step.depends_on].sort().map((id) => {
    const reference = Object.hasOwn(dependencyRefs, id) ? dependencyRefs[id] : undefined;
    if (!reference) throw new Error("步骤依赖缺少有效产物");
    return [id, typeof reference === "string" ? reference : {
      artifact_key: reference.artifact_key,
      version: reference.version,
      input_fingerprint: reference.input_fingerprint,
    }];
  });
  return createHash("sha256").update(JSON.stringify({
    id: step.id,
    capability: step.capability,
    description: step.description,
    dependencies,
    context: contextFingerprint,
  })).digest("hex");
}

/**
 * 生成同时包含步骤与版本的产物标识。
 *
 * @param stepId step 对应的唯一标识。
 * @param version 本次操作对应的内容版本。
 * @returns 整理后的文本或标识。
 */
export function stepArtifactKey(stepId: string, version: number): string {
  if (!stepId || !Number.isSafeInteger(version) || version < 1)
    throw new Error("步骤产物版本无效");
  return `step:${encodeURIComponent(stepId)}:v${version}`;
}
