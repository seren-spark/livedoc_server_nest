export type Visibility = 'private' | 'team' | 'public';
export type SourceType =
  | 'article'
  | 'draft'
  | 'note'
  | 'team_doc'
  | 'public_article'
  | 'current_document';
export type WriteIntent =
  | 'knowledge_qa'
  | 'knowledge_search'
  | 'continue_paragraph'
  | 'summarize_document'
  | 'format_selection'
  | 'fill_in_middle'
  | 'correct_text'
  | 'expand_text';
export type RetrievalMode = 'dense' | 'keyword' | 'hybrid';
export type RetrievalDomain = 'public' | 'private' | 'team' | 'current_document';
export type IndexStatus = 'pending' | 'queued' | 'indexing' | 'ready' | 'failed';
export type IndexJobStatus =
  | 'queued'
  | 'running'
  | 'retry_wait'
  | 'succeeded'
  | 'failed'
  | 'superseded'
  | 'canceled';
export type FeedbackAction = 'inserted' | 'helpful' | 'unhelpful' | 'dismissed';

export interface AccessContext {
  user_id: string;
  space_id: string;
  team_ids: string[];
}

export interface KnowledgeScope {
  private: boolean;
  team: boolean;
  public: boolean;
  document_ids: string[];
}

export interface Citation {
  index: number;
  doc_id: string;
  chunk_id: string;
  title: string;
  content: string;
  source_type: SourceType;
  visibility: Visibility;
  score: number;
  dense_score?: number | null;
  keyword_score?: number | null;
  rerank_score?: number | null;
  url?: string | null;
  heading_path: string[];
  chunk_index?: number | null;
  space_id: string;
  team_id?: string | null;
  document_version: number;
  start_offset?: number | null;
  end_offset?: number | null;
}

export interface RetrievalTrace {
  trace_id: string;
  mode: RetrievalMode;
  rewritten_query: string;
  query_variants: string[];
  expansion_source: 'llm' | 'tool_call' | 'original' | 'fallback';
  expansion_enabled: boolean;
  dense_candidates: number;
  keyword_candidates: number;
  fused_candidates: number;
  reranked_candidates: number;
  deduped_candidates: number;
  returned_citations: number;
  retrieval_ms: number;
  rerank_ms: number;
  compression_ms: number;
  preprocessing_ms: number;
  total_ms: number;
}

export interface AgentToolCall {
  name:
    | 'knowledge_search'
    | 'summarize_document'
    | 'continue_paragraph'
    | 'format_selection'
    | 'fill_in_middle'
    | 'correct_text'
    | 'expand_text';
  arguments: Record<string, unknown>;
  reason: string;
  source: 'llm_function_call' | 'rule_fallback' | 'request_intent';
  confidence: number;
  selection_ms: number;
}
