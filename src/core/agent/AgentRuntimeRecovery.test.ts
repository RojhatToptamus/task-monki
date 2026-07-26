import { describe, expect, it } from 'vitest';
import type { TaskSnapshot } from '../../shared/contracts';
import { agentServersRequiringLossRecovery } from './AgentRuntimeRecovery';

describe('agentServersRequiringLossRecovery', () => {
  it('treats waiting runs and pending interactions as ownership even after a server is terminal', () => {
    const snapshot = {
      agentServers: [
        { id: 'approval-server', runtimeId: 'opencode', status: 'EXITED' },
        { id: 'input-server', runtimeId: 'opencode', status: 'LOST' },
        { id: 'interaction-server', runtimeId: 'opencode', status: 'FAILED' },
        { id: 'idle-terminal', runtimeId: 'opencode', status: 'EXITED' },
        { id: 'other-runtime', runtimeId: 'codex', status: 'RUNNING' }
      ],
      runs: [
        {
          id: 'approval-run',
          serverInstanceId: 'approval-server',
          status: 'AWAITING_APPROVAL'
        },
        {
          id: 'input-run',
          serverInstanceId: 'input-server',
          status: 'AWAITING_USER_INPUT'
        }
      ],
      interactionRequests: [
        {
          id: 'interaction',
          serverInstanceId: 'interaction-server',
          status: 'PENDING'
        }
      ]
    } as unknown as TaskSnapshot;

    expect(
      agentServersRequiringLossRecovery(snapshot, 'opencode').map(
        (server) => server.id
      )
    ).toEqual([
      'approval-server',
      'input-server',
      'interaction-server'
    ]);
  });
});
