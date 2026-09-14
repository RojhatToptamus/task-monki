/** Shared preference inputs used by app settings and the Discourse domain. */
// Older values remain readable in saved conversations and drafts. New sends use CHAT or NONE.
export type DiscourseDefaultPolicy = 'CHAT' | 'NONE' | 'TEAM' | 'PANEL' | 'DIRECT';

export type BuiltInAgentProfileId = 'builtin.lead' | 'builtin.skeptic' | 'builtin.verifier';

/** Renderer-selected identity; core resolves provider details from the live catalog. */
export interface DiscourseAgentSelectionInput {
  agentProfileId: BuiltInAgentProfileId;
  runtimeId?: string;
  modelId?: string;
  reasoningEffort?: string;
}

/** Last-used composer preferences, not the settings of executed waves. */
export interface DiscourseDefaults {
  policy: DiscourseDefaultPolicy;
  agents: DiscourseAgentSelectionInput[];
  responderProfileIds: BuiltInAgentProfileId[];
}
