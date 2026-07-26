import type { RunRecord, TaskSnapshot } from '../../shared/contracts';

const ACTIVE_OWNERSHIP_STATUSES: readonly RunRecord['status'][] = [
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
  snapshot: TaskSnapshot,
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
  snapshot: TaskSnapshot,
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
