/**
 * @file Worker 执行协议。定义 Worker 输入输出、共享预算、取消信号和运行环境。
 */
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
import type { TaskContextEvent, TaskEvidence } from './task-evidence.js';
import type { ResearchBrief, ResearchNote, ResearchProgress, WebSourceSnapshot } from './research-writing.js';

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
/**
 * 创建本次执行的初始资源用量计数。
 *
 * @returns 模型和工具调用用量。
 */
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
  features?: { verification?: boolean; skills?: boolean; preferences?: boolean; context?: boolean; research_writing?: boolean };
  research_brief?: ResearchBrief;
  task_evidence?: () => TaskEvidence[];
  context_events?: TaskContextEvent[];
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
  web_snapshots?: Map<string, WebSourceSnapshot>;
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
  research_notes?: ResearchNote[];
  research_progress?: ResearchProgress;
  web_snapshots?: Array<[string, WebSourceSnapshot]>;
  result: AgentResult;
  handoff?: WorkerHandoff;
  citations: AgentCitation[];
  evidence: Array<[string, string]>;
  observations: WorkerState["observations"];
  read_region_ids: string[];
  selection_read: boolean;
  usage: AgentUsage;
  wiki_reads?: WikiProof[];
  context_events?: TaskContextEvent[];
}

// Cancellation detaches the caller; non-cancelable work may still settle later.
/**
 * 在取消时结束调用方等待；无法取消的底层工作仍可能自行结束。
 *
 * @param work 需要在受控上下文中执行的异步操作。
 * @param signal 取消信号，用于中止请求和后台处理。
 * @returns T 类型的处理结果。
 */
export function withAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    /**
     * 响应取消信号，中止当前等待或操作。
     */
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("任务已停止"));
    };
    /**
     * 清理已结束或过期操作留下的资源。
     */
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
