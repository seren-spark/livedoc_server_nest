/**
 * @file Wiki 知识协议。定义知识页面、来源证据、编译状态和时效性判断。
 */
import type { AgentCitation } from "../ai/document-agent.types.js";
import type { KnowledgeScope } from "../common/types.js";

export interface WikiKnowledgeSnapshot {
  scope: KnowledgeScope;
  fingerprint: string;
}

export interface WikiSource {
  citation_id: string;
  doc_id: string;
  version: number;
  title: string;
  start_offset: number;
  end_offset: number;
  excerpt_hash: string;
  source_anchor?: string;
}
export interface WikiOrigin {
  answer_hash: string;
  capture_answer_hash?: string;
  question: string;
  sources: WikiSource[];
  knowledge_snapshot?: WikiKnowledgeSnapshot;
  parents?: WikiProof[];
}
export interface WikiProof {
  wiki_id: string;
  revision: number;
}
export interface WikiComparison extends WikiProof {
  relation: "duplicate" | "supplement" | "independent" | "conflict";
}
export interface WikiPage {
  wiki_id: string;
  space_id: string;
  owner_id: string;
  origin_run_id: string;
  revision: number;
  status: "draft" | "indexing" | "published" | "failed" | "archived";
  payload: {
    title: string;
    markdown: string;
    question: string;
    sources: WikiSource[];
    knowledge_snapshot?: WikiKnowledgeSnapshot;
    parents?: WikiProof[];
    invalidated_by?: WikiProof[];
    topic_id?: string;
    supersedes?: WikiProof;
    conflicted_by_run?: string;
    review: {
      passed: boolean;
      issues: string[];
      quality?: { reusable: boolean; complete: boolean; substantive: boolean };
      comparison?: WikiComparison;
    };
    user_feedback?: "helpful" | "incorrect";
    usage: {
      model_requests: number;
      prompt_tokens: number;
      completion_tokens: number;
    };
    error?: string;
    capture_hash?: string;
  };
  created_at: Date;
  updated_at: Date;
}
export interface WikiEvidence {
  proof: WikiProof;
  title: string;
  markdown: string;
  citations: AgentCitation[];
}
export interface WikiCaptureState {
  status: "running" | "published" | "skipped" | "failed";
  reason?:
    | "already_compiled"
    | "wiki_reused"
    | "semantic_duplicate"
    | "knowledge_conflict"
    | "capture_failed"
    | "quality_rejected"
    | "user_rejected";
  wiki_id?: string;
  revision?: number;
  error_code?: string;
  error_detail?: string;
  usage?: WikiPage["payload"]["usage"];
}
export type WikiCoverage = "full" | "partial" | "none" | "unavailable";
export interface WikiCoverageResult {
  coverage: WikiCoverage;
  missing: string[];
  reason?: "invalid_response" | "judge_unavailable";
}
export type WikiSourceStatus = "valid" | "stale" | "unavailable";
/**
 * 识别来源内容是否包含需要关注时效性的表达。
 *
 * @param query 用户问题或检索查询。
 * @returns 条件是否满足的判断结果。
 */
export function isTimeSensitive(query: string) {
  return /最新|实时|现行|今天|今日|现在|目前|当前价格|价格|报价|售价|政策|截至|最近|刚刚|时效|原文核实|重新检索|不使用\s*wiki|\b(?:latest|current|today|real-time|prices?|pricing|polic(?:y|ies))\b/i.test(
    query,
  );
}
