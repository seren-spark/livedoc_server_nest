import {
  Allow,
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
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
  @IsOptional() @Allow() confirmed_plan?: ExecutionPlan;
}
export class AgentFeedbackDto {
  @IsIn(["accepted", "rejected", "conflict", "created", "discarded"])
  action!: string;
  @IsOptional() @IsString() edit_id?: string;
  @IsOptional() @IsString() document_id?: string;
}
