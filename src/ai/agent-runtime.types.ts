import type { AccessContext } from "../common/types.js";
import type { DocumentAgentDto } from "./document-agent.dto.js";
import type {
  AgentCitation,
  AgentMessage,
  AgentResult,
  ExecutionPlan,
} from "./document-agent.types.js";
import type { AgentSettingsService } from "./agent-settings.service.js";
import type {
  WikiProof,
  WikiCoverageResult,
  WikiKnowledgeSnapshot,
} from "../wiki/wiki.types.js";
import type { AgentSpan } from "./agent-execution.js";
import type { WorkerHandoff } from "./agent-handoff.js";

export type WorkerRole = "primary" | "reader" | "researcher";
export interface AgentUsage {
  execution_turns: number;
  model_requests: number;
  tool_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  charged_tokens?: number;
  reserved_tokens?: number;
  estimated_requests?: number;
}
export const emptyUsage = (): AgentUsage => ({
  execution_turns: 0,
  model_requests: 0,
  tool_calls: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
});

export interface WorkerEnvironment {
  run_id: string;
  request: DocumentAgentDto;
  context: AccessContext;
  personal: Awaited<ReturnType<AgentSettingsService["runtime"]>>;
  signal: AbortSignal;
  budget: AgentUsage;
  ledger?: {
    reserve: (
      prompt: number,
      maxOutput: number,
      limits: { tokens: number; requests: number },
      finalReserve: number,
    ) => Promise<
      (actual?: {
        prompt_tokens?: number;
        completion_tokens?: number;
      }) => Promise<void>
    >;
    increment: (
      counter: "execution_turns" | "tool_calls",
      limit: number,
    ) => Promise<void>;
  };
  researchManaged?: boolean;
  traces?: AgentSpan[];
  parent_span_id?: string;
  task_id?: string;
  agent_role?: string;
  model_turn?: (
    messages: AgentMessage[],
    signal: AbortSignal,
  ) => Promise<AgentMessage>;
  knowledge_snapshot?: WikiKnowledgeSnapshot | null;
  /** May lower the shared execution ceiling while reserving root finalization. */
  execution_limit?: number;
  /** Supervisor's per-worker share, including the final handoff turn. */
  step_turn_limit?: number;
  emit: (event: string, data: Record<string, any>) => void;
}
export interface WorkerState {
  citations: Map<string, AgentCitation>;
  evidence: Map<string, string>;
  observations: Array<{ citation_id: string; content: string }>;
  readRegions: Set<string>;
  regionReadRanges?: Map<string, Array<[number, number]>>;
  selectionRead: boolean;
  wikiReads: WikiProof[];
  wikiChecks: Array<
    WikiCoverageResult & { wiki_id: string; wiki_ids: string[]; query: string }
  >;
  wikiFallbacks: Array<"unavailable" | "timeout" | "context_budget">;
}
export interface WorkerInput {
  task_id: string;
  role: WorkerRole;
  environment: WorkerEnvironment;
  base: Record<string, any>;
  step?: ExecutionPlan["steps"][number];
  dependencies: Record<string, WorkerOutput>;
  usage?: AgentUsage;
}
export interface WorkerOutput {
  result: AgentResult;
  handoff?: WorkerHandoff;
  citations: AgentCitation[];
  evidence: Array<[string, string]>;
  observations: WorkerState["observations"];
  read_region_ids: string[];
  selection_read: boolean;
  usage: AgentUsage;
  wiki_reads?: WikiProof[];
}

// Cancellation detaches the caller; non-cancelable work may still settle later.
export function withAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("任务已停止"));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
