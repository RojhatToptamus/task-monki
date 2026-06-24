import type { AgentCapability, AgentProviderCapabilities } from '../../../shared/agent';

const stable = (detail?: string): AgentCapability => ({ maturity: 'stable', detail });
const experimental = (detail?: string): AgentCapability => ({
  maturity: 'experimental',
  detail
});
const unsupported = (detail?: string): AgentCapability => ({
  maturity: 'unsupported',
  detail
});

export function codexCapabilities(): AgentProviderCapabilities {
  return {
    provider: 'codex',
    modelCatalog: stable('Discovered through model/list.'),
    reasoningEffort: stable('Supported efforts are supplied by each model catalog entry.'),
    persistentSessions: stable('Backed by App Server threads.'),
    sessionResume: stable('Resumes persisted threads; active work is not recreated after process loss.'),
    sessionFork: stable('Forks stored thread history into a new thread.'),
    activeTurnSteering: stable('Adds input to the currently active regular turn.'),
    turnInterruption: stable('Interrupts the active turn while preserving its thread.'),
    truePause: unsupported('Codex has no resumable model-generation pause primitive.'),
    interactiveApprovals: stable('Command, file, permission, and MCP requests use server requests.'),
    userInputRequests: experimental('The current request-user-input schema is marked experimental.'),
    goals: stable('One persisted goal is available per materialized thread.'),
    plans: stable('turn/plan/updated provides provider-reported plan state.'),
    review: stable('review/start supports inline or detached review work.'),
    subagents: stable('Current protocol exposes parent IDs and collaboration activity.'),
    backgroundTerminals: experimental('List, terminate, and cleanup methods require experimental API access.'),
    dynamicTools: experimental('Client-registered dynamic tools require experimental API access.')
  };
}
