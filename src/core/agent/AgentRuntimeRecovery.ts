import type {
  AgentRunStatus,
  AgentServerInstance,
  InteractionRequestStatus
} from '../../shared/agent';

const ACTIVE_OWNERSHIP_STATUSES: readonly AgentRunStatus[] = [
  'QUEUED',
  'STARTING',
  'RUNNING',
  'AWAITING_APPROVAL',
  'AWAITING_USER_INPUT',
  'INTERRUPTING',
  'RECOVERY_REQUIRED'
];

const NONTERMINAL_SERVER_STATUSES = [
  'STARTING',
  'READY',
  'RUNNING',
  'DEGRADED',
  'STOPPING'
] as const;

export function agentServersOwnedByPreviousApplication(
  snapshot: { agentServers: AgentServerInstance[] },
  runtimeId?: string
) {
  return snapshot.agentServers.filter(
    (server) =>
      (runtimeId === undefined || server.runtimeId === runtimeId) &&
      NONTERMINAL_SERVER_STATUSES.includes(
        server.status as (typeof NONTERMINAL_SERVER_STATUSES)[number]
      )
  );
}

export function agentServersRequiringLossRecovery(
  snapshot: {
    agentServers: AgentServerInstance[];
    runs: Array<{ status: AgentRunStatus; serverInstanceId?: string }>;
    interactionRequests: Array<{
      status: InteractionRequestStatus;
      serverInstanceId: string;
    }>;
  },
  runtimeId: string
) {
  const serversWithActiveOwnership = new Set([
    ...snapshot.runs
      .filter((run) => ACTIVE_OWNERSHIP_STATUSES.includes(run.status))
      .map((run) => run.serverInstanceId),
    ...snapshot.interactionRequests
      .filter((request) => ['PENDING', 'RESPONDING'].includes(request.status))
      .map((request) => request.serverInstanceId)
  ]);
  const serversOwnedByPreviousApplication = new Set(
    agentServersOwnedByPreviousApplication(snapshot, runtimeId).map(
      (server) => server.id
    )
  );
  return snapshot.agentServers.filter(
    (server) =>
      server.runtimeId === runtimeId &&
      (serversOwnedByPreviousApplication.has(server.id) ||
        serversWithActiveOwnership.has(server.id))
  );
}
