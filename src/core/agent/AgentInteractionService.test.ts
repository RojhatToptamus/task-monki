import { describe, expect, it, vi } from 'vitest';
import type {
  AgentSessionRecord,
  InteractionRequestRecord,
  RunRecord
} from '../../shared/contracts';
import { AppEventBus } from '../runner/AppEventBus';
import type { FileTaskStore } from '../storage/FileTaskStore';
import type { AgentProviderAdapter } from './AgentProviderAdapter';
import { AgentInteractionService } from './AgentInteractionService';

describe('AgentInteractionService permission decisions', () => {
  it('always permits the safe decline path without consulting attachment storage', async () => {
    const run = runFixture();
    const session = sessionFixture();
    let interaction = interactionFixture('/tmp/unavailable-attachment.txt');
    interaction = { ...interaction, allowedActions: ['DECLINE'] };
    const store = {
      getInteractionRequest: vi.fn().mockImplementation(async () => interaction),
      getRun: vi.fn().mockResolvedValue(run),
      getAgentSession: vi.fn().mockResolvedValue(session),
      transitionInteractionRequest: vi.fn().mockImplementation(async (
        _id: string,
        _status: string,
        update: Partial<InteractionRequestRecord>
      ) => {
        interaction = { ...interaction, ...update } as InteractionRequestRecord;
        return interaction;
      })
    } as unknown as FileTaskStore;
    const adapter = {
      respondToInteraction: vi.fn().mockResolvedValue(undefined)
    } as unknown as AgentProviderAdapter;
    const service = new AgentInteractionService(store, new AppEventBus(), adapter);

    await expect(
      service.respond({
        taskId: run.taskId,
        runId: run.id,
        interactionRequestId: interaction.id,
        decision: {
          interactionType: 'PERMISSION_APPROVAL',
          action: 'DECLINE'
        }
      })
    ).resolves.toMatchObject({ status: 'RESPONDING' });

    expect(adapter.respondToInteraction).toHaveBeenCalledOnce();
  });
});

function interactionFixture(deliveryPath: string): InteractionRequestRecord {
  return {
    id: 'interaction-one',
    serverInstanceId: 'server-one',
    providerRequestId: 1,
    taskId: 'task-one',
    iterationId: 'iteration-one',
    runId: 'run-one',
    sessionId: 'session-one',
    type: 'PERMISSION_APPROVAL',
    request: {
      startedAtMs: 1,
      cwd: '/tmp/worktree',
      permissions: { fileSystem: { read: [deliveryPath] } }
    },
    allowedActions: ['GRANT_TURN', 'DECLINE'],
    policyWarnings: [],
    status: 'PENDING',
    requestedAt: '2026-07-10T00:00:00.000Z'
  } as unknown as InteractionRequestRecord;
}

function runFixture(): RunRecord {
  return {
    id: 'run-one',
    taskId: 'task-one',
    iterationId: 'iteration-one',
    worktreeId: 'worktree-one',
    sessionId: 'session-one',
    serverInstanceId: 'server-one',
    mode: 'IMPLEMENTATION',
    origin: 'TASK_MONKI',
    status: 'AWAITING_APPROVAL',
    recoveryState: 'NONE',
    requestedSettings: {},
    promptArtifactId: 'prompt-one',
    outputArtifactId: 'output-one',
    diagnosticArtifactId: 'diagnostic-one',
    startedAt: '2026-07-10T00:00:00.000Z',
    eventCount: 0
  };
}

function sessionFixture(): AgentSessionRecord {
  return {
    id: 'session-one',
    provider: 'codex',
    providerSessionId: 'thread-one',
    taskId: 'task-one',
    iterationId: 'iteration-one',
    worktreeId: 'worktree-one',
    worktreePath: '/tmp/worktree',
    role: 'PRIMARY',
    status: 'ACTIVE',
    materialized: true,
    requestedSettings: {},
    startedAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z'
  } as unknown as AgentSessionRecord;
}
