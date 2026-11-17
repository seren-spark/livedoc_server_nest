/**
 * @file 文档访问规则。按空间、所有者、公开状态和团队成员关系判定读取权限。
 */
import type { DocumentRecord } from "./document.types.js";
import type { AccessContext } from "../common/types.js";
/**
 * 根据空间、公开状态、所有者和团队成员身份检查文档读取权限。
 *
 * @param record 当前知识文档记录。
 * @param context 当前用户、空间与团队身份，用于权限校验。
 * @returns 条件是否满足的判断结果。
 */
export function canAccessDocument(
  record: DocumentRecord,
  context: AccessContext,
): boolean {
  if (record.deleted_at) return false;
  if (record.visibility === "public") return true;
  if (record.space_id !== context.space_id) return false;
  if (record.visibility === "private")
    return record.owner_id === context.user_id;
  return Boolean(record.team_id && context.team_ids.includes(record.team_id));
}
