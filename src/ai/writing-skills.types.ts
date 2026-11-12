import type { ExecutionPlan } from './document-agent.types.js';
import type { NoteTemplate } from '../workspace/workspace.types.js';

export interface SkillParameter {
  name: string;
  label: string;
  required: boolean;
}

export interface WritingSkillDefinition {
  workflow?: 'standard' | 'research_writing';
  name: string;
  description: string;
  parameters: SkillParameter[];
  steps: ExecutionPlan['steps'];
  allowed_tools: string[];
  acceptance: string[];
  template_id?: string;
  enabled: boolean;
}

export interface WritingSkill extends WritingSkillDefinition {
  skill_id: string;
  revision: number;
  builtin: boolean;
}

export type SkillMetadata = Pick<WritingSkill,
  'skill_id' | 'revision' | 'builtin' | 'name' | 'description' | 'parameters' | 'enabled'>;

export interface WritingSkillSnapshot {
  skill: WritingSkill;
  inputs: Record<string, string>;
  template?: NoteTemplate;
}

export interface SkillSelection {
  skill_id: string;
  skill_revision?: number;
  skill_inputs?: Record<string, string>;
  template_id?: string;
}

export type SaveWritingSkillInput = Omit<WritingSkillDefinition, 'enabled'> & {
  enabled?: boolean;
  expected_revision?: number;
};
