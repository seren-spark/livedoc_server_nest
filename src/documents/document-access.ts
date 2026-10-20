import type { DocumentRecord } from "./document.types.js";
import type { AccessContext } from "../common/types.js";
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
