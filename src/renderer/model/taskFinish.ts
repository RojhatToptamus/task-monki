import type { Tone } from './viewTypes';

export interface FinishEvidenceWarning {
  title: string;
  detail: string;
}

export interface FinishEvidenceState {
  mode: 'clean' | 'override' | 'blocked';
  warnings: FinishEvidenceWarning[];
}

export interface FinishRequirement {
  label: string;
  detail: string;
  tone: Tone;
  unresolved: boolean;
}
