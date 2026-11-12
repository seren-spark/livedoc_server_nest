import type { AgentMessage } from './document-agent.types.js';

export interface PreferenceItem {
  id: string;
  text: string;
  status: 'confirmed' | 'pending' | 'rejected';
  source: { kind: 'user_input' | 'manual'; input_id: string; quote: string };
  conflicts_with: string[];
  created_at: string;
  updated_at: string;
}

export interface PreferenceState {
  revision: number;
  items: PreferenceItem[];
}

export interface PreferenceSnapshot {
  revision: number;
  items: Array<{ id: string; text: string }>;
}

export interface PreparedPreferences {
  state: PreferenceState;
  snapshot: PreferenceSnapshot;
  saved_ids: string[];
  candidate_ids: string[];
  replayed: boolean;
}

export interface PreferenceMutation {
  request_id: string;
  expected_revision: number;
  action: 'save' | 'confirm' | 'reject' | 'update' | 'delete';
  id?: string;
  text?: string;
  replace_ids?: string[];
}

export type PreferenceTurn = (messages: AgentMessage[]) => Promise<AgentMessage>;

export interface PreferenceReceipt {
  state: PreferenceState;
  saved_ids: string[];
  candidate_ids: string[];
}
