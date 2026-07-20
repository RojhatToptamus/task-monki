import { describe, expect, it, vi } from 'vitest';
import type {
  AgentSessionRecord,
  InteractionRequestRecord,
  RunRecord
} from '../../shared/contracts';
import { AppEventBus } from '../runner/AppEventBus';
import type { FileTaskStore } from '../storage/FileTaskStore';
import {
  AgentMutationAmbiguousError,
  type AgentRuntimeAdapter
} from './AgentRuntimeAdapter';
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
    } as unknown as AgentRuntimeAdapter;
    const service = new AgentInteractionService(
      store,
      new AppEventBus(),
      (runtimeId) => {
        expect(runtimeId).toBe('codex');
        return adapter;
      }
    );

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

  it('restores a retryable interaction when delivery definitively fails before acknowledgement', async () => {
    const run = runFixture();
    const session = sessionFixture();
    let interaction = interactionFixture('/tmp/worktree/file.txt');
    interaction = { ...interaction, allowedActions: ['DECLINE'] };
    const transitionInteractionRequest = vi.fn().mockImplementation(async (
      _id: string,
      _status: string,
      update: Partial<InteractionRequestRecord>
    ) => {
      interaction = { ...interaction, ...update } as InteractionRequestRecord;
      return interaction;
    });
    const store = {
      getInteractionRequest: vi.fn().mockImplementation(async () => interaction),
      getRun: vi.fn().mockResolvedValue(run),
      getAgentSession: vi.fn().mockResolvedValue(session),
      transitionInteractionRequest
    } as unknown as FileTaskStore;
    const adapter = {
      respondToInteraction: vi.fn().mockRejectedValue(new Error('connection not opened'))
    } as unknown as AgentRuntimeAdapter;
    const service = new AgentInteractionService(store, new AppEventBus(), () => adapter);

    await expect(
      service.respond({
        taskId: run.taskId,
        runId: run.id,
        interactionRequestId: interaction.id,
        decision: { interactionType: 'PERMISSION_APPROVAL', action: 'DECLINE' }
      })
    ).rejects.toThrow('connection not opened');

    expect(interaction.status).toBe('PENDING');
    expect(interaction.decision).toBeUndefined();
    expect(transitionInteractionRequest).toHaveBeenLastCalledWith(
      interaction.id,
      'RESPONDING',
      expect.objectContaining({ status: 'PENDING' })
    );
  });

  it('moves ambiguous interaction delivery into recovery instead of allowing a duplicate reply', async () => {
    const run = runFixture();
    const session = sessionFixture();
    let interaction = interactionFixture('/tmp/worktree/file.txt');
    interaction = { ...interaction, allowedActions: ['DECLINE'] };
    const appendRunEventIfStatus = vi.fn().mockResolvedValue(true);
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
      }),
      appendRunEventIfStatus
    } as unknown as FileTaskStore;
    const adapter = {
      respondToInteraction: vi.fn().mockRejectedValue(
        new AgentMutationAmbiguousError(
          'permission/reply',
          'reply may have reached the runtime'
        )
      )
    } as unknown as AgentRuntimeAdapter;
    const updates: string[] = [];
    const events = new AppEventBus();
    events.on((event) => updates.push(event.type));
    const service = new AgentInteractionService(store, events, () => adapter);

    await expect(
      service.respond({
        taskId: run.taskId,
        runId: run.id,
        interactionRequestId: interaction.id,
        decision: { interactionType: 'PERMISSION_APPROVAL', action: 'DECLINE' }
      })
    ).rejects.toThrow('reply may have reached the runtime');

    expect(interaction.status).toBe('STALE');
    expect(appendRunEventIfStatus).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'AGENT_MUTATION_AMBIGUOUS', runId: run.id }),
      expect.arrayContaining(['AWAITING_APPROVAL', 'AWAITING_USER_INPUT'])
    );
    expect(updates).toContain('run.activity');
  });

  it('preserves a terminal run when it wins an ambiguous interaction response race', async () => {
    const run = runFixture();
    const session = sessionFixture();
    let interaction = {
      ...interactionFixture('/tmp/worktree/file.txt'),
      allowedActions: ['DECLINE'] as const
    };
    const appendRunEventIfStatus = vi.fn().mockImplementation(
      async (_event: unknown, allowedStatuses: readonly RunRecord['status'][]) =>
        allowedStatuses.includes(run.status)
    );
    const store = {
      getInteractionRequest: vi.fn().mockImplementation(async () => interaction),
      getRun: vi.fn().mockResolvedValue(run),
      getAgentSession: vi.fn().mockResolvedValue(session),
      transitionInteractionRequest: vi.fn().mockImplementation(async (
        _id: string,
        _status: string,
        update: Partial<InteractionRequestRecord>
      ) => {
        interaction = { ...interaction, ...update } as typeof interaction;
        return interaction;
      }),
      appendRunEventIfStatus
    } as unknown as FileTaskStore;
    const adapter = {
      respondToInteraction: vi.fn().mockImplementation(async () => {
        run.status = 'COMPLETED';
        throw new AgentMutationAmbiguousError(
          'permission/reply',
          'reply may have reached the runtime'
        );
      })
    } as unknown as AgentRuntimeAdapter;
    const emitted: string[] = [];
    const events = new AppEventBus();
    events.on((event) => emitted.push(event.type));
    const service = new AgentInteractionService(store, events, () => adapter);

    await expect(
      service.respond({
        taskId: run.taskId,
        runId: run.id,
        interactionRequestId: interaction.id,
        decision: { interactionType: 'PERMISSION_APPROVAL', action: 'DECLINE' }
      })
    ).rejects.toThrow('reply may have reached the runtime');

    expect(run.status).toBe('COMPLETED');
    expect(interaction.status).toBe('STALE');
    expect(appendRunEventIfStatus).toHaveBeenCalledOnce();
    expect(emitted).not.toContain('run.activity');
  });

  it('never sends a positive decision after the run has started interrupting', async () => {
    const run = { ...runFixture(), status: 'INTERRUPTING' as const };
    const session = sessionFixture();
    const interaction = interactionFixture('/tmp/worktree/file.txt');
    const transitionInteractionRequest = vi.fn();
    const store = {
      getInteractionRequest: vi.fn().mockResolvedValue(interaction),
      getRun: vi.fn().mockResolvedValue(run),
      getAgentSession: vi.fn().mockResolvedValue(session),
      transitionInteractionRequest
    } as unknown as FileTaskStore;
    const adapter = {
      respondToInteraction: vi.fn().mockResolvedValue(undefined)
    } as unknown as AgentRuntimeAdapter;
    const service = new AgentInteractionService(store, new AppEventBus(), () => adapter);

    await expect(
      service.respond({
        taskId: run.taskId,
        runId: run.id,
        interactionRequestId: interaction.id,
        decision: {
          interactionType: 'PERMISSION_APPROVAL',
          action: 'GRANT_TURN',
          permissions: { fileSystem: { read: ['/tmp/worktree/file.txt'] } }
        }
      })
    ).rejects.toThrow('cannot resume');

    expect(transitionInteractionRequest).not.toHaveBeenCalled();
    expect(adapter.respondToInteraction).not.toHaveBeenCalled();
  });

  it('never sends a positive decision from a partial record whose session is not awaiting', async () => {
    const run = runFixture();
    const session = sessionFixture();
    const interaction = interactionFixture('/tmp/worktree/file.txt');
    const transitionInteractionRequest = vi.fn();
    const store = {
      getInteractionRequest: vi.fn().mockResolvedValue(interaction),
      getRun: vi.fn().mockResolvedValue(run),
      getAgentSession: vi.fn().mockResolvedValue(session),
      transitionInteractionRequest
    } as unknown as FileTaskStore;
    const adapter = {
      respondToInteraction: vi.fn().mockResolvedValue(undefined)
    } as unknown as AgentRuntimeAdapter;
    const service = new AgentInteractionService(store, new AppEventBus(), () => adapter);

    await expect(
      service.respond({
        taskId: run.taskId,
        runId: run.id,
        interactionRequestId: interaction.id,
        decision: {
          interactionType: 'PERMISSION_APPROVAL',
          action: 'GRANT_TURN',
          permissions: { fileSystem: { read: ['/tmp/worktree/file.txt'] } }
        }
      })
    ).rejects.toThrow('run/session awaiting state is AWAITING_APPROVAL/ACTIVE');

    expect(transitionInteractionRequest).not.toHaveBeenCalled();
    expect(adapter.respondToInteraction).not.toHaveBeenCalled();
  });
});

function interactionFixture(deliveryPath: string): InteractionRequestRecord {
  return {
    id: 'interaction-one',
    runtimeId: 'codex',
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
    runtimeId: 'codex',
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
    runtimeId: 'codex',
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
