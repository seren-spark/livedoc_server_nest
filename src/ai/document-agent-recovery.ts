import { ConflictException } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { AgentResult, EditorSnapshot } from "./document-agent.types.js";

export const agentRegionHash = (node: unknown) =>
  createHash("sha256").update(JSON.stringify(node)).digest("hex");

/** Rebase only unchanged, unambiguous targets. Store hashes, never the original editor body. */
export function rebaseAgentDelivery<T extends {
  result: AgentResult;
  selection: EditorSnapshot["selection"];
  region_fingerprints?: Array<{ id: string; hash: string }>;
}>(delivery: T, feedback: Record<string, string>, editorJson: Record<string, any>): T {
  if (delivery.result.kind !== "edits") return delivery;
  const original = delivery.region_fingerprints;
  if (!original || editorJson.type !== "doc" || !Array.isArray(editorJson.content))
    throw new ConflictException("正文已变化，请重新生成修改建议");
  const current = editorJson.content.map(agentRegionHash);
  const locate = (ids: string[]) => {
    const from = original.findIndex(region => region.id === ids[0]);
    const to = original.findIndex(region => region.id === ids.at(-1));
    if (from < 0 || to < from) throw new ConflictException("原目标无法恢复，请重新生成修改建议");
    const hashes = original.slice(from, to + 1).map(region => region.hash);
    const matches = current.flatMap((_: string, index: number) =>
      hashes.every((hash, offset) => current[index + offset] === hash) ? [index] : []);
    if (matches.length !== 1)
      throw new ConflictException("修改目标已变化或位置不唯一，请重新生成修改建议");
    return hashes.map((_, offset) => `b${matches[0]! + offset}`);
  };
  const copy = structuredClone(delivery);
  if (copy.result.kind !== "edits") return copy;
  const pending = copy.result.edits.filter(edit => !["accepted", "rejected"].includes(feedback[edit.id] ?? ""));
  for (const edit of pending) {
    if (edit.target.kind !== "block_range") continue;
    const ids = locate([edit.target.first_region_id!, edit.target.last_region_id ?? edit.target.first_region_id!]);
    edit.target.first_region_id = ids[0];
    edit.target.last_region_id = ids.at(-1);
  }
  if (pending.some(edit => edit.target.kind !== "block_range"))
    copy.selection.region_ids = locate(delivery.selection.region_ids);
  return copy;
}
