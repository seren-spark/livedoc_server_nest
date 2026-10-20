export type AgentMode = "ask" | "plan" | "agent";
export type OutputTarget = "current_document" | "new_document";
export type DocumentIdentity =
  | { kind: "knowledge"; doc_id: string; persisted_version: number }
  | { kind: "article"; article_id: string; draft_version: number }
  | { kind: "import"; import_id: string }
  | { kind: "unsaved"; local_id: string };
export interface SnapshotRegion {
  id: string;
  type: string;
  heading_path: string[];
  text: string;
  markdown: string;
  original_json: Record<string, any>;
}
export interface EditorSnapshot {
  identity: DocumentIdentity;
  title: string;
  json: Record<string, any>;
  revision: number;
  hash: string;
  regions: SnapshotRegion[];
  selection: { text: string; inline: boolean; region_ids: string[];cursor_before?:string;cursor_after?:string };
}
export interface ReferenceInput {
  id: string;
  kind: "document" | "import" | "text";
  title: string;
  doc_id?: string;
  import_id?: string;
  content?: string;
}
export interface ExecutionPlan {
  goal: string;
  outline: string[];
  constraints: string[];
  steps: Array<{
    id: string;
    description: string;
    depends_on: string[];
    capability: "read" | "search" | "compose";
  }>;
}
export interface DocumentEdit {
  id: string;
  operation: "insert_before" | "insert_after" | "replace" | "delete";
  target: {
    kind: "block_range" | "selection" | "cursor";
    first_region_id?: string;
    last_region_id?: string;
  };
  content_markdown?: string;
  explanation: string;
  citation_ids: string[];
}
export interface AgentCitation {
  snippet?: string;
  source_content?: string;
  reference_id?: string;
  snapshot_hash?: string;
  evidence_kind?: "source" | "search_summary" | "tool_output";
  start_offset?: number;
  end_offset?: number;
  source_anchor?: string;
  id: string;
  title: string;
  kind: "document" | "import" | "text" | "web" | "current_document";
  doc_id?: string;
  import_id?: string;
  url?: string;
  version?: number;
}
export type AgentResult =
  | { kind: "answer"; answer: string; citation_ids: string[] }
  | { kind: "plan"; plan: ExecutionPlan }
  | { kind: "clarification"; question: string; choices: string[] }
  | { kind: "edits"; edits: DocumentEdit[] }
  | {
      kind: "document";
      document_id: string;
      title: string;
      markdown: string;
      citation_ids: string[];
      category_id?: string;
    };
export interface AgentEvent {
  event: string;
  data: { run_id: string; seq: number; [key: string]: any };
}
export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}
export interface FunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}
