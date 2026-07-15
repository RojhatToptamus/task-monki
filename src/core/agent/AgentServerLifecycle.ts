import type { AgentServerStatus } from '../../shared/agent';

const ALLOWED_SERVER_TRANSITIONS: Record<
  AgentServerStatus,
  readonly AgentServerStatus[]
> = {
  STARTING: ['READY', 'RUNNING', 'FAILED', 'EXITED', 'LOST'],
  READY: ['RUNNING', 'DEGRADED', 'STOPPING', 'EXITED', 'FAILED', 'LOST'],
  RUNNING: ['READY', 'DEGRADED', 'STOPPING', 'EXITED', 'FAILED', 'LOST'],
  DEGRADED: ['READY', 'RUNNING', 'STOPPING', 'EXITED', 'FAILED', 'LOST'],
  STOPPING: ['EXITED', 'FAILED', 'LOST'],
  EXITED: [],
  FAILED: [],
  LOST: []
};

export function validateAgentServerTransition(
  current: AgentServerStatus,
  next: AgentServerStatus | undefined
): void {
  if (!next || next === current) return;
  if (!ALLOWED_SERVER_TRANSITIONS[current].includes(next)) {
    throw new Error(`Invalid agent server transition: ${current} -> ${next}`);
  }
}

export function isTerminalAgentServerStatus(status: AgentServerStatus): boolean {
  return status === 'FAILED' || status === 'EXITED' || status === 'LOST';
}
