/**
 * @file Agent 候选恢复。利用内容摘要和区域锚点，将历史候选重新定位到当前编辑器快照。
 */
import { ConflictException } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { AgentResult, EditorSnapshot } from "./document-agent.types.js";

/**
 * 对文档区域内容生成摘要，恢复时据此识别原始目标。
 *
 * @param node 当前语法树或编辑器节点。
 * @returns 整理后的文本或标识。
 */
export const agentRegionHash = (node: unknown) =>
  createHash("sha256").update(JSON.stringify(node)).digest("hex");

/**
 * 只重新定位内容未变且匹配唯一的目标区域，冲突时要求重新生成。
 *
 *  Rebase only unchanged, unambiguous targets. Store hashes, never the original editor body.
 *
 * @param delivery 已经校验的任务交付及其证据。
 * @param feedback 用户对当前回答或候选的评价。
 * @param editorJson 当前编辑器文档的 JSON 内容。
 * @returns 目标已重新定位的历史候选；原文冲突或定位不唯一时抛出异常。
 */
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
  /**
   * 根据已保存的锚点信息查找当前内容中的目标位置。
   *
   * @param ids 本次操作涉及的记录标识集合。
   * @returns 整理后的字符串列表。
   */
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
