/**
 * @file Agent 请求校验。声明请求字段及校验规则，约束编辑器快照、引用资料和执行模式。
 */
import {
  Allow,
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsObject,
  IsInt,
  Min,
  IsString,
  MaxLength,
} from "class-validator";
import type {
  AgentMode,
  EditorSnapshot,
  ExecutionPlan,
  OutputTarget,
  ReferenceInput,
} from "./document-agent.types.js";
import type { KnowledgeScope } from "../common/types.js";

export class DocumentAgentDto {
  @IsString() @IsNotEmpty() @MaxLength(128) request_id!: string;
  @IsString() @IsNotEmpty() @MaxLength(128) conversation_id!: string;
  @IsIn(["ask", "plan", "agent"]) mode!: AgentMode;
  @IsIn(["current_document", "new_document"]) output_target!: OutputTarget;
  @IsString() @IsNotEmpty() @MaxLength(8000) query!: string;
  @IsBoolean() deep_thinking = false;
  @IsBoolean() allow_web = false;
  @Allow() editor_snapshot!: EditorSnapshot;
  @IsArray() @ArrayMaxSize(10) references: ReferenceInput[] = [];
  @IsOptional() @Allow() knowledge_scope?: KnowledgeScope;
  @IsOptional() @IsString() template_id?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(128) skill_id?: string;
  @IsOptional() @IsInt() @Min(1) skill_revision?: number;
  @IsOptional() @IsObject() skill_inputs?: Record<string, string>;
  @IsOptional() @Allow() confirmed_plan?: ExecutionPlan;
}
export class AgentFeedbackDto {
  @IsIn([
    "accepted",
    "rejected",
    "conflict",
    "created",
    "discarded",
    "helpful",
    "incorrect",
  ])
  action!: string;
  @IsOptional() @IsString() edit_id?: string;
  @IsOptional() @IsString() document_id?: string;
}
export class AgentRestoreDto {
  @IsObject() editor_json!: Record<string, unknown>;
}
