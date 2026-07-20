import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  AgentAssignmentSnapshot,
  DiscourseAgentJobRecord,
  DiscourseParticipantRecord,
  DiscourseParticipantRevisionRecord,
  DiscourseResponseWaveRecord
} from '../../shared/discourse';
import { DISCOURSE_LIMITS } from '../../shared/discourse';
import { AgentTurnScheduler } from '../agent/AgentTurnScheduler';
import { createAgentSessionAccessEpoch } from '../agent/AgentRuntimeOwnership';
import type {
  AgentScopedTurnProvider,
  StartScopedAgentTurnInput
} from '../agent/AgentScopedTurnProvider';
import { AgentScopedMutationError } from '../agent/AgentScopedTurnProvider';
import { FileAgentRuntimeStore } from '../storage/FileAgentRuntimeStore';
import { FileDiscourseStore } from '../storage/FileDiscourseStore';
import { DiscourseRuntimeCoordinator } from './DiscourseRuntimeCoordinator';

describe('DiscourseRuntimeCoordinator', () => {
  it('runs and settles a scoped contribution without creating task-owned runtime state', async () => {
    const fixture = await coordinatorFixture();
    const prepared = await fixture.coordinator.prepareJob({
      conversationId: fixture.conversationId,
      waveId: fixture.waveId,
      jobId: fixture.jobId,
      executionContext: fixture.executionContext,
      prompt: 'Answer only from the immutable visible context.',
      clientOperationId: 'prepare-1'
    });
    expect(prepared.run).toMatchObject({
      owner: { kind: 'DISCOURSE', conversationId: fixture.conversationId },
      scope: { kind: 'DISCOURSE', waveId: fixture.waveId, jobId: fixture.jobId },
      status: 'QUEUED',
      delivery: 'NOT_SENT'
    });
    expect(prepared.run).not.toHaveProperty('taskId');
    expect(
      await fixture.coordinator.prepareJob({
        conversationId: fixture.conversationId,
        waveId: fixture.waveId,
        jobId: fixture.jobId,
        executionContext: fixture.executionContext,
        prompt: 'Answer only from the immutable visible context.',
        clientOperationId: 'prepare-1'
      })
    ).toEqual(prepared);

    const [leased] = await fixture.scheduler.leaseAvailable('lease');
    expect(leased).toMatchObject({ id: prepared.queueEntry.id, status: 'LEASED' });
    const running = await fixture.coordinator.dispatchLeasedJob(
      leased!.id,
      fixture.provider,
      'dispatch-1'
    );
    expect(running).toMatchObject({
      status: 'RUNNING',
      delivery: 'ACKNOWLEDGED',
      providerTurnId: 'provider-turn-1'
    });

    const terminal = await fixture.coordinator.ingestContribution({
      runId: running.id,
      providerTurnId: 'provider-turn-1',
      body: 'The owner-neutral runtime keeps task and discourse projections isolated.',
      freshnessAtCompletion: 'FRESH',
      clientOperationId: 'terminal-1',
      completedAt: '2026-07-13T00:10:00.000Z',
      providerTerminalSource: 'TEST_TERMINAL'
    });
    expect(terminal.kind).toBe('CURATED');
    if (terminal.kind !== 'CURATED') throw new Error('Expected a curated terminal.');
    const message = terminal.message;
    expect(message).toMatchObject({
      author: { kind: 'AGENT', stableParticipantId: 'participant-1' },
      waveId: fixture.waveId,
      jobId: fixture.jobId
    });
    const replay = await fixture.coordinator.ingestContribution({
        runId: running.id,
        providerTurnId: 'provider-turn-1',
        body: 'The owner-neutral runtime keeps task and discourse projections isolated.',
        freshnessAtCompletion: 'FRESH',
        clientOperationId: 'terminal-1',
        completedAt: '2026-07-13T00:10:00.000Z',
        providerTerminalSource: 'TEST_TERMINAL'
      });
    expect(replay).toEqual({ kind: 'CURATED', message });

    const discourse = await fixture.discourse.getConversation(fixture.conversationId);
    expect(discourse).toMatchObject({
      waves: [{ id: fixture.waveId, status: 'SETTLED', outcome: 'COMPLETE' }],
      jobs: [
        {
          id: fixture.jobId,
          status: 'COMPLETED',
          delivery: 'TERMINAL',
          result: { kind: 'CONTRIBUTION', outputMessageId: message.id }
        }
      ]
    });
    const runtime = await fixture.runtime.snapshot();
    expect(runtime).toMatchObject({
      sessions: [{ owner: { kind: 'DISCOURSE' }, status: 'IDLE' }],
      runs: [{ owner: { kind: 'DISCOURSE' }, status: 'COMPLETED', delivery: 'TERMINAL' }],
      queueEntries: [{ status: 'SETTLED' }]
    });
    expect(runtime.sessions.some((session) => session.owner.kind === 'TASK')).toBe(false);
  });

  it('ingests a runtime terminal that became durable before the curated message link', async () => {
    const fixture = await coordinatorFixture();
    const prepared = await fixture.coordinator.prepareJob({
      conversationId: fixture.conversationId,
      waveId: fixture.waveId,
      jobId: fixture.jobId,
      executionContext: fixture.executionContext,
      prompt: 'Recover this terminal.',
      clientOperationId: 'prepare-1'
    });
    const [leased] = await fixture.scheduler.leaseAvailable('lease');
    const running = await fixture.coordinator.dispatchLeasedJob(
      leased!.id,
      fixture.provider,
      'dispatch-1'
    );
    const output = await fixture.runtime.getArtifact(prepared.run.outputArtifactId);
    await fixture.runtime.updateArtifact({
      artifactId: output!.id,
      expectedRevision: output!.recordRevision,
      clientOperationId: 'provider-output-terminal',
      content: 'Recovered after the runtime terminal won the race.'
    });
    await fixture.runtime.updateRun(
      running.id,
      running.recordRevision,
      {
        status: 'COMPLETED',
        delivery: 'TERMINAL',
        providerTerminalSource: 'TEST_TERMINAL',
        endedAt: '2026-07-13T00:10:00.000Z',
        lastEventAt: '2026-07-13T00:10:00.000Z'
      },
      'provider-runtime-terminal'
    );

    const recovered = await fixture.coordinator.ingestContribution({
      runId: running.id,
      providerTurnId: 'provider-turn-1',
      body: 'Recovered after the runtime terminal won the race.',
      freshnessAtCompletion: 'FRESH',
      clientOperationId: 'terminal-recovery-1',
      completedAt: '2026-07-13T00:10:00.000Z',
      providerTerminalSource: 'TEST_TERMINAL'
    });
    expect(recovered.kind).toBe('CURATED');
    if (recovered.kind !== 'CURATED') throw new Error('Expected a curated terminal.');
    expect(recovered.message.body).toContain('Recovered after');
    expect((await fixture.discourse.getConversation(fixture.conversationId)).jobs[0]).toMatchObject({
      status: 'COMPLETED',
      result: { outputMessageId: recovered.message.id }
    });
  });

  it('accepts an authoritative started notification that wins the start-response race', async () => {
    const fixture = await coordinatorFixture();
    const prepared = await fixture.coordinator.prepareJob({
      conversationId: fixture.conversationId,
      waveId: fixture.waveId,
      jobId: fixture.jobId,
      executionContext: fixture.executionContext,
      prompt: 'Exercise the provider acknowledgement race.',
      clientOperationId: 'prepare-race'
    });
    const [leased] = await fixture.scheduler.leaseAvailable('lease-race');
    const provider: AgentScopedTurnProvider = {
      startScopedTurn: async (input) => {
        const session = (await fixture.runtime.getSession(input.session.id))!;
        await fixture.runtime.updateSession(
          session.id,
          session.recordRevision,
          {
            providerSessionId: 'provider-session-race',
            status: 'ACTIVE',
            materialized: true,
            lastAttachedAt: '2026-07-13T00:07:00.000Z'
          },
          'provider-started-session-race'
        );
        const run = (await fixture.runtime.getRun(input.run.id))!;
        await fixture.runtime.updateRun(
          run.id,
          run.recordRevision,
          {
            serverInstanceId: 'server-race',
            providerTurnId: 'provider-turn-race',
            status: 'RUNNING',
            delivery: 'ACKNOWLEDGED',
            lastEventAt: '2026-07-13T00:07:00.000Z'
          },
          'provider-started-run-race'
        );
        return {
          serverInstanceId: 'server-race',
          providerSessionId: 'provider-session-race',
          providerTurnId: 'provider-turn-race',
          startedAt: '2026-07-13T00:07:00.000Z'
        };
      }
    };

    await expect(
      fixture.coordinator.dispatchLeasedJob(leased!.id, provider, 'dispatch-race')
    ).resolves.toMatchObject({
      id: prepared.run.id,
      status: 'RUNNING',
      delivery: 'ACKNOWLEDGED',
      providerTurnId: 'provider-turn-race'
    });
    expect((await fixture.discourse.getConversation(fixture.conversationId)).jobs[0]).toMatchObject({
      status: 'RUNNING',
      delivery: 'ACKNOWLEDGED'
    });
  });

  it('cancels a queued wave without submitting a provider turn', async () => {
    const fixture = await coordinatorFixture();
    const prepared = await fixture.coordinator.prepareJob({
      conversationId: fixture.conversationId,
      waveId: fixture.waveId,
      jobId: fixture.jobId,
      executionContext: fixture.executionContext,
      prompt: 'This prompt must never reach the provider.',
      clientOperationId: 'prepare-cancel'
    });

    await expect(
      fixture.coordinator.cancelQueuedWave({
        conversationId: fixture.conversationId,
        waveId: fixture.waveId,
        clientOperationId: 'cancel-queued-wave',
        reason: 'Canceled before provider submission.'
      })
    ).resolves.toMatchObject({
      status: 'SETTLED',
      outcome: 'CANCELED',
      settlementReason: 'USER_CANCELED'
    });
    expect(fixture.provider.calls).toHaveLength(0);
    expect(await fixture.runtime.getRun(prepared.run.id)).toMatchObject({
      status: 'INTERRUPTED',
      delivery: 'NOT_DELIVERED'
    });
    expect((await fixture.runtime.snapshot()).queueEntries[0]).toMatchObject({
      status: 'CANCELED'
    });
    expect((await fixture.discourse.getConversation(fixture.conversationId)).jobs[0]).toMatchObject({
      status: 'CANCELED',
      delivery: 'NOT_SENT'
    });
  });

  it('settles stale context before provider delivery without starting a turn', async () => {
    const fixture = await coordinatorFixture();
    const prepared = await fixture.coordinator.prepareJob({
      conversationId: fixture.conversationId,
      waveId: fixture.waveId,
      jobId: fixture.jobId,
      executionContext: fixture.executionContext,
      prompt: 'This prompt must not run after context changes.',
      clientOperationId: 'prepare-stale'
    });
    const [leased] = await fixture.scheduler.leaseAvailable('lease-stale');

    await expect(
      fixture.coordinator.rejectLeasedJobForStaleContext(
        leased!.id,
        'reject-stale'
      )
    ).resolves.toMatchObject({
      status: 'CONTEXT_STALE',
      error: { code: 'CONTEXT_CHANGED' }
    });
    expect(fixture.provider.calls).toHaveLength(0);
    expect(await fixture.runtime.getRun(prepared.run.id)).toMatchObject({
      status: 'FAILED',
      delivery: 'NOT_DELIVERED'
    });
    expect(await fixture.discourse.getConversation(fixture.conversationId)).toMatchObject({
      waves: [{ status: 'SETTLED', outcome: 'STALE' }],
      jobs: [{ status: 'CONTEXT_STALE' }]
    });
  });

  it('recovers a crash after queued stop intent without replaying provider start', async () => {
    const fixture = await coordinatorFixture();
    const prepared = await fixture.coordinator.prepareJob({
      conversationId: fixture.conversationId,
      waveId: fixture.waveId,
      jobId: fixture.jobId,
      executionContext: fixture.executionContext,
      prompt: 'Recover cancellation only.',
      clientOperationId: 'prepare-cancel-recovery'
    });
    const aggregate = await fixture.discourse.getConversation(fixture.conversationId);
    const wave = aggregate.waves[0]!;
    const stoppedWave = await fixture.discourse.updateWave({
      conversationId: fixture.conversationId,
      expectedRevision: wave.recordRevision,
      clientOperationId: 'crash-cancel-wave-intent',
      wave: {
        ...wave,
        recordRevision: wave.recordRevision + 1,
        status: 'STOP_REQUESTED'
      }
    });
    const job = aggregate.jobs[0]!;
    await fixture.discourse.updateJob({
      conversationId: fixture.conversationId,
      expectedRevision: job.recordRevision,
      clientOperationId: 'crash-cancel-job-intent',
      job: {
        ...job,
        recordRevision: job.recordRevision + 1,
        status: 'CANCEL_REQUESTED'
      }
    });
    await fixture.runtime.updateRun(
      prepared.run.id,
      prepared.run.recordRevision,
      {
        status: 'INTERRUPTED',
        delivery: 'NOT_DELIVERED',
        terminalReason: 'Crash after runtime cancellation.',
        lastEventAt: '2026-07-13T00:08:00.000Z',
        endedAt: '2026-07-13T00:08:00.000Z'
      },
      'crash-cancel-runtime'
    );
    expect(stoppedWave.status).toBe('STOP_REQUESTED');

    expect(await fixture.coordinator.recoverConversation(fixture.conversationId)).toEqual({
      recoveredJobIds: [fixture.jobId],
      recoveryRequiredJobIds: [],
      tombstonedRunIds: []
    });
    expect(fixture.provider.calls).toHaveLength(0);
    expect(await fixture.discourse.getConversation(fixture.conversationId)).toMatchObject({
      waves: [{ status: 'SETTLED', outcome: 'CANCELED' }],
      jobs: [{ status: 'CANCELED' }]
    });
    expect((await fixture.runtime.snapshot()).queueEntries[0]).toMatchObject({
      status: 'CANCELED'
    });
  });

  it('persists stop intent before interruption and settles on the provider terminal', async () => {
    const fixture = await coordinatorFixture();
    await fixture.coordinator.prepareJob({
      conversationId: fixture.conversationId,
      waveId: fixture.waveId,
      jobId: fixture.jobId,
      executionContext: fixture.executionContext,
      prompt: 'Stop this active response safely.',
      clientOperationId: 'prepare-active-stop'
    });
    const [leased] = await fixture.scheduler.leaseAvailable('lease-active-stop');
    const running = await fixture.coordinator.dispatchLeasedJob(
      leased!.id,
      fixture.provider,
      'dispatch-active-stop'
    );

    await expect(
      fixture.coordinator.stopActiveWave(
        {
          conversationId: fixture.conversationId,
          waveId: fixture.waveId,
          clientOperationId: 'stop-active-wave',
          reason: 'User stopped the active response.'
        },
        fixture.provider
      )
    ).resolves.toMatchObject({ status: 'STOPPING' });
    expect(fixture.provider.interruptCalls).toEqual([running.id]);
    expect(await fixture.runtime.getRun(running.id)).toMatchObject({
      status: 'INTERRUPTING',
      interruptDelivery: 'ACKNOWLEDGED',
      stopRequestedAt: expect.any(String)
    });
    expect((await fixture.discourse.getConversation(fixture.conversationId)).jobs[0]).toMatchObject({
      status: 'CANCEL_REQUESTED',
      delivery: 'ACKNOWLEDGED'
    });
    await fixture.coordinator.stopActiveWave(
      {
        conversationId: fixture.conversationId,
        waveId: fixture.waveId,
        clientOperationId: 'stop-active-wave',
        reason: 'User stopped the active response.'
      },
      fixture.provider
    );
    expect(fixture.provider.interruptCalls).toEqual([running.id]);

    await fixture.coordinator.ingestFailure({
      runId: running.id,
      providerTurnId: 'provider-turn-1',
      clientOperationId: 'stopped-provider-terminal',
      completedAt: '2026-07-13T00:10:00.000Z',
      providerTerminalSource: 'TEST_INTERRUPTED',
      reason: 'Provider confirmed interruption.'
    });
    expect(await fixture.runtime.getRun(running.id)).toMatchObject({
      status: 'INTERRUPTED',
      delivery: 'TERMINAL',
      interruptDelivery: 'TERMINAL'
    });
    expect(await fixture.discourse.getConversation(fixture.conversationId)).toMatchObject({
      waves: [{ status: 'SETTLED', outcome: 'CANCELED' }],
      jobs: [{ status: 'CANCELED', delivery: 'TERMINAL' }]
    });
  });

  it('never retries an ambiguous active interruption automatically', async () => {
    const fixture = await coordinatorFixture();
    await fixture.coordinator.prepareJob({
      conversationId: fixture.conversationId,
      waveId: fixture.waveId,
      jobId: fixture.jobId,
      executionContext: fixture.executionContext,
      prompt: 'Keep ambiguous interruption visible.',
      clientOperationId: 'prepare-ambiguous-stop'
    });
    const [leased] = await fixture.scheduler.leaseAvailable('lease-ambiguous-stop');
    await fixture.coordinator.dispatchLeasedJob(
      leased!.id,
      fixture.provider,
      'dispatch-ambiguous-stop'
    );
    fixture.provider.ambiguousInterrupt = true;

    await expect(
      fixture.coordinator.stopActiveWave(
        {
          conversationId: fixture.conversationId,
          waveId: fixture.waveId,
          clientOperationId: 'ambiguous-active-stop',
          reason: 'User stopped the active response.'
        },
        fixture.provider
      )
    ).resolves.toMatchObject({ status: 'STOPPING' });
    expect(fixture.provider.interruptCalls).toHaveLength(1);
    expect((await fixture.runtime.snapshot()).runs[0]).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      interruptDelivery: 'AMBIGUOUS'
    });
    expect((await fixture.discourse.getConversation(fixture.conversationId)).jobs[0]).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      error: { code: 'DELIVERY_AMBIGUOUS' }
    });
    await expect(fixture.coordinator.stopActiveWave(
      {
        conversationId: fixture.conversationId,
        waveId: fixture.waveId,
        clientOperationId: 'ambiguous-active-stop-again',
        reason: 'User stopped the active response.'
      },
      fixture.provider
    )).resolves.toMatchObject({
      status: 'STOPPING'
    });
    await fixture.coordinator.recoverConversation(fixture.conversationId);
    expect(fixture.provider.interruptCalls).toHaveLength(1);
    expect((await fixture.runtime.snapshot()).queueEntries[0]).toMatchObject({
      status: 'LEASED'
    });
    expect((await fixture.discourse.getConversation(fixture.conversationId)).jobs[0]).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      delivery: 'ACKNOWLEDGED'
    });
    expect((await fixture.runtime.snapshot()).runs[0]).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      delivery: 'ACKNOWLEDGED',
      recoveryState: 'REQUIRES_USER_ACTION'
    });
    const recoveringAggregate = await fixture.discourse.getConversation(fixture.conversationId);
    await expect(fixture.coordinator.setConversationArchived({
      conversationId: fixture.conversationId,
      archived: true,
      expectedRevision: recoveringAggregate.conversation.recordRevision,
      clientOperationId: 'archive-after-ambiguous-stop'
    })).rejects.toThrow('safely settle the active response');

    await expect(fixture.coordinator.ingestFailure({
      runId: (await fixture.runtime.snapshot()).runs[0]!.id,
      providerTurnId: 'provider-turn-1',
      clientOperationId: 'late-after-recovery-stop',
      completedAt: '2026-07-13T00:10:00.000Z',
      providerTerminalSource: 'TEST_LATE_TERMINAL',
      reason: 'The provider eventually confirmed the interrupted turn ended.'
    })).resolves.toMatchObject({ kind: 'FAILED' });
    expect((await fixture.runtime.snapshot()).queueEntries[0]).toMatchObject({
      status: 'SETTLED'
    });
    expect((await fixture.discourse.getConversation(fixture.conversationId)).waves[0])
      .toMatchObject({ status: 'SETTLED', outcome: 'CANCELED' });
    expect((await fixture.discourse.listMessages({
      conversationId: fixture.conversationId,
      limit: 100
    })).messages).toHaveLength(1);
  });

  it('keeps a provably not-delivered interrupt recoverable until explicit local stop', async () => {
    const fixture = await coordinatorFixture();
    await fixture.coordinator.prepareJob({
      conversationId: fixture.conversationId,
      waveId: fixture.waveId,
      jobId: fixture.jobId,
      executionContext: fixture.executionContext,
      prompt: 'Exercise a rejected provider interruption.',
      clientOperationId: 'prepare-not-delivered-stop'
    });
    const [leased] = await fixture.scheduler.leaseAvailable('lease-not-delivered-stop');
    await fixture.coordinator.dispatchLeasedJob(
      leased!.id,
      fixture.provider,
      'dispatch-not-delivered-stop'
    );
    fixture.provider.notDeliveredInterrupt = true;

    await expect(fixture.coordinator.stopActiveWave({
      conversationId: fixture.conversationId,
      waveId: fixture.waveId,
      clientOperationId: 'not-delivered-stop',
      reason: 'User stopped the response.'
    }, fixture.provider)).resolves.toMatchObject({ status: 'STOPPING' });
    expect((await fixture.runtime.snapshot()).runs[0]).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      delivery: 'ACKNOWLEDGED',
      interruptDelivery: 'NOT_DELIVERED'
    });
    expect((await fixture.runtime.snapshot()).queueEntries[0]).toMatchObject({
      status: 'LEASED'
    });
    fixture.provider.notDeliveredInterrupt = false;

    await expect(fixture.coordinator.stopActiveWave({
      conversationId: fixture.conversationId,
      waveId: fixture.waveId,
      clientOperationId: 'not-delivered-stop-confirmed',
      reason: 'User retried stopping the provider turn.'
    }, fixture.provider)).resolves.toMatchObject({
      status: 'STOPPING'
    });
    expect(fixture.provider.interruptCalls).toHaveLength(2);
    expect((await fixture.runtime.snapshot()).queueEntries[0]).toMatchObject({
      status: 'LEASED'
    });
    await fixture.coordinator.ingestFailure({
      runId: (await fixture.runtime.snapshot()).runs[0]!.id,
      providerTurnId: 'provider-turn-1',
      clientOperationId: 'not-delivered-stop-terminal',
      completedAt: '2026-07-13T00:10:00.000Z',
      providerTerminalSource: 'TEST_INTERRUPTED',
      reason: 'Provider confirmed interruption.'
    });
    expect((await fixture.discourse.getConversation(fixture.conversationId)).waves[0])
      .toMatchObject({ status: 'SETTLED', outcome: 'CANCELED' });
    expect((await fixture.runtime.snapshot()).queueEntries[0]).toMatchObject({
      status: 'SETTLED'
    });
  });

  it('terminalizes an oversized answer as a retryable structured failure', async () => {
    const fixture = await coordinatorFixture();
    await fixture.coordinator.prepareJob({
      conversationId: fixture.conversationId,
      waveId: fixture.waveId,
      jobId: fixture.jobId,
      executionContext: fixture.executionContext,
      prompt: 'Return a bounded answer.',
      clientOperationId: 'prepare-oversized'
    });
    const [leased] = await fixture.scheduler.leaseAvailable('lease-oversized');
    const running = await fixture.coordinator.dispatchLeasedJob(
      leased!.id,
      fixture.provider,
      'dispatch-oversized'
    );

    await expect(fixture.coordinator.ingestContribution({
      runId: running.id,
      providerTurnId: running.providerTurnId!,
      body: 'x'.repeat(DISCOURSE_LIMITS.maxAgentContributionBytes + 1),
      freshnessAtCompletion: 'FRESH',
      clientOperationId: 'terminal-oversized',
      completedAt: '2026-07-13T00:10:00.000Z',
      providerTerminalSource: 'TEST_TERMINAL'
    })).resolves.toMatchObject({
      kind: 'INVALID_RESULT',
      job: { status: 'FAILED', delivery: 'TERMINAL' },
      error: { code: 'INVALID_RESULT', retryable: true }
    });
    expect(await fixture.runtime.getRun(running.id)).toMatchObject({
      status: 'COMPLETED',
      delivery: 'TERMINAL'
    });
    expect((await fixture.runtime.snapshot()).queueEntries[0]).toMatchObject({
      status: 'SETTLED'
    });
    expect(await fixture.discourse.getConversation(fixture.conversationId)).toMatchObject({
      waves: [{ status: 'SETTLED', outcome: 'NO_RESPONSE' }],
      jobs: [{ status: 'FAILED', error: { code: 'INVALID_RESULT' } }]
    });
  });

  it('preserves an empty completed response as a typed validation failure', async () => {
    const fixture = await coordinatorFixture();
    await fixture.coordinator.prepareJob({
      conversationId: fixture.conversationId,
      waveId: fixture.waveId,
      jobId: fixture.jobId,
      executionContext: fixture.executionContext,
      prompt: 'Return a visible answer.',
      clientOperationId: 'prepare-empty-output'
    });
    const [leased] = await fixture.scheduler.leaseAvailable('lease-empty-output');
    const running = await fixture.coordinator.dispatchLeasedJob(
      leased!.id,
      fixture.provider,
      'dispatch-empty-output'
    );
    await fixture.coordinator.ingestFailure({
      runId: running.id,
      providerTurnId: running.providerTurnId!,
      clientOperationId: 'terminal-empty-output',
      completedAt: '2026-07-13T00:10:00.000Z',
      providerTerminalSource: 'TEST_EMPTY_TERMINAL',
      reason: 'Provider completed without a response.',
      error: {
        code: 'OUTPUT_MISSING',
        message: 'The agent completed without a usable response.',
        category: 'VALIDATION',
        retryable: true
      }
    });
    expect((await fixture.discourse.getConversation(fixture.conversationId)).jobs[0])
      .toMatchObject({
        status: 'FAILED',
        error: { code: 'OUTPUT_MISSING', category: 'VALIDATION', retryable: true }
      });
  });

  it('allows archive and delete only after discourse runtime settlement', async () => {
    const fixture = await coordinatorFixture();
    let conversation = await fixture.discourse.getConversation(fixture.conversationId);
    await expect(
      fixture.coordinator.setConversationArchived({
        conversationId: fixture.conversationId,
        archived: true,
        expectedRevision: conversation.conversation.recordRevision,
        clientOperationId: 'archive-active-wave'
      })
    ).rejects.toThrow('safely settle the active response');

    await fixture.coordinator.cancelQueuedWave({
      conversationId: fixture.conversationId,
      waveId: fixture.waveId,
      clientOperationId: 'cancel-before-archive',
      reason: 'Canceled before archive.'
    });
    conversation = await fixture.discourse.getConversation(fixture.conversationId);
    const archived = await fixture.coordinator.setConversationArchived({
      conversationId: fixture.conversationId,
      archived: true,
      expectedRevision: conversation.conversation.recordRevision,
      clientOperationId: 'archive-settled-wave'
    });
    expect(archived.status).toBe('ARCHIVED');
    const tombstone = await fixture.coordinator.deleteConversation({
      conversationId: fixture.conversationId,
      expectedRevision: archived.recordRevision,
      clientOperationId: 'delete-settled-wave'
    });
    expect(tombstone.conversationId).toBe(fixture.conversationId);
    expect(await fixture.runtime.snapshot()).toMatchObject({
      sessions: [],
      runs: [],
      queueEntries: [],
      artifacts: []
    });
  });

  it('serializes preparation against deletion so no orphan run crosses a tombstone', async () => {
    const fixture = await coordinatorFixture();
    const conversation = await fixture.discourse.getConversation(fixture.conversationId);
    const preparing = fixture.coordinator.prepareJob({
      conversationId: fixture.conversationId,
      waveId: fixture.waveId,
      jobId: fixture.jobId,
      executionContext: fixture.executionContext,
      prompt: 'Prepare before a concurrent delete can publish.',
      clientOperationId: 'prepare-delete-race'
    });
    const deleting = fixture.coordinator.deleteConversation({
      conversationId: fixture.conversationId,
      expectedRevision: conversation.conversation.recordRevision,
      clientOperationId: 'delete-preparation-race'
    });

    await expect(preparing).resolves.toMatchObject({
      run: { scope: { kind: 'DISCOURSE', conversationId: fixture.conversationId } }
    });
    await expect(deleting).rejects.toThrow('safely settle the active response');
    expect(await fixture.discourse.getConversationTombstone(fixture.conversationId)).toBeUndefined();
    expect((await fixture.runtime.listRunsByOwner({
      kind: 'DISCOURSE',
      conversationId: fixture.conversationId,
      stableParticipantId: 'participant-1'
    }))).toHaveLength(1);
  });

  it('keeps a late terminal as runtime evidence after its conversation is deleted', async () => {
    const fixture = await coordinatorFixture();
    await fixture.coordinator.prepareJob({
      conversationId: fixture.conversationId,
      waveId: fixture.waveId,
      jobId: fixture.jobId,
      executionContext: fixture.executionContext,
      prompt: 'This output will arrive after deletion.',
      clientOperationId: 'prepare-1'
    });
    const [leased] = await fixture.scheduler.leaseAvailable('lease');
    const running = await fixture.coordinator.dispatchLeasedJob(
      leased!.id,
      fixture.provider,
      'dispatch-1'
    );
    const conversation = await fixture.discourse.getConversation(fixture.conversationId);
    const tombstone = await fixture.discourse.deleteConversation({
      conversationId: fixture.conversationId,
      expectedRevision: conversation.conversation.recordRevision,
      clientOperationId: 'delete-active-conversation'
    });

    const result = await fixture.coordinator.ingestContribution({
      runId: running.id,
      providerTurnId: 'provider-turn-1',
      body: 'Persisted only as terminal runtime output.',
      freshnessAtCompletion: 'UNKNOWN',
      clientOperationId: 'late-terminal-1',
      completedAt: '2026-07-13T00:10:00.000Z',
      providerTerminalSource: 'TEST_LATE_TERMINAL'
    });
    expect(result).toEqual({ kind: 'CONVERSATION_DELETED', tombstone });
    const runtime = await fixture.runtime.snapshot();
    expect(runtime).toMatchObject({
      runs: [{ status: 'COMPLETED', delivery: 'TERMINAL' }],
      queueEntries: [{ status: 'SETTLED' }]
    });
    expect(await fixture.runtime.readArtifact(runtime.runs[0]!.outputArtifactId)).toBe(
      'Persisted only as terminal runtime output.'
    );
    expect(await fixture.discourse.listConversations()).toEqual({ conversations: [] });
    await fixture.coordinator.recoverConversation(fixture.conversationId);
    expect(await fixture.runtime.snapshot()).toMatchObject({
      sessions: [],
      runs: [],
      queueEntries: [],
      artifacts: []
    });
  });

  it('recovers a terminal runtime record into the missing curated job/message link', async () => {
    const fixture = await coordinatorFixture();
    const prepared = await fixture.coordinator.prepareJob({
      conversationId: fixture.conversationId,
      waveId: fixture.waveId,
      jobId: fixture.jobId,
      executionContext: fixture.executionContext,
      prompt: 'Recover automatically from runtime evidence.',
      clientOperationId: 'prepare-1'
    });
    const [leased] = await fixture.scheduler.leaseAvailable('lease');
    const running = await fixture.coordinator.dispatchLeasedJob(
      leased!.id,
      fixture.provider,
      'dispatch-1'
    );
    const output = await fixture.runtime.getArtifact(prepared.run.outputArtifactId);
    await fixture.runtime.updateArtifact({
      artifactId: output!.id,
      expectedRevision: output!.recordRevision,
      clientOperationId: 'provider-output-terminal',
      content: 'Recovered by scanning the owner-bearing terminal run.'
    });
    await fixture.runtime.updateRun(
      running.id,
      running.recordRevision,
      {
        status: 'COMPLETED',
        delivery: 'TERMINAL',
        contextFreshnessAtCompletion: 'FRESH',
        providerTerminalSource: 'TEST_TERMINAL',
        endedAt: '2026-07-13T00:10:00.000Z',
        lastEventAt: '2026-07-13T00:10:00.000Z'
      },
      'provider-runtime-terminal'
    );

    expect(await fixture.coordinator.recoverConversation(fixture.conversationId)).toEqual({
      recoveredJobIds: [fixture.jobId],
      recoveryRequiredJobIds: [],
      tombstonedRunIds: []
    });
    expect(await fixture.discourse.getConversation(fixture.conversationId)).toMatchObject({
      waves: [{ status: 'SETTLED', outcome: 'COMPLETE' }],
      jobs: [{ status: 'COMPLETED', result: { kind: 'CONTRIBUTION' } }]
    });
  });

  it('settles the runtime lease when recovery finds a curated completed job', async () => {
    const fixture = await coordinatorFixture();
    const prepared = await fixture.coordinator.prepareJob({
      conversationId: fixture.conversationId,
      waveId: fixture.waveId,
      jobId: fixture.jobId,
      executionContext: fixture.executionContext,
      prompt: 'Recover after the curated terminal commit.',
      clientOperationId: 'prepare-curated-checkpoint'
    });
    const [leased] = await fixture.scheduler.leaseAvailable('lease-curated-checkpoint');
    const running = await fixture.coordinator.dispatchLeasedJob(
      leased!.id,
      fixture.provider,
      'dispatch-curated-checkpoint'
    );
    const completedAt = '2026-07-13T00:10:00.000Z';
    const output = await fixture.runtime.getArtifact(prepared.run.outputArtifactId);
    await fixture.runtime.updateArtifact({
      artifactId: output!.id,
      expectedRevision: output!.recordRevision,
      clientOperationId: 'curated-checkpoint-output',
      content: 'The curated answer was committed before runtime settlement.'
    });
    await fixture.runtime.updateRun(
      running.id,
      running.recordRevision,
      {
        status: 'COMPLETED',
        delivery: 'TERMINAL',
        contextFreshnessAtCompletion: 'FRESH',
        providerTerminalSource: 'TEST_TERMINAL',
        endedAt: completedAt,
        lastEventAt: completedAt
      },
      'curated-checkpoint-runtime-terminal'
    );
    const aggregate = await fixture.discourse.getConversation(fixture.conversationId);
    const job = aggregate.jobs[0]!;
    const message = await fixture.discourse.appendAgentMessage({
      conversationId: fixture.conversationId,
      body: 'The curated answer was committed before runtime settlement.',
      stableParticipantId: job.assignment.stableParticipantId,
      participantRevisionId: job.assignment.participantRevisionId,
      displayNameSnapshot: job.assignment.displayNameSnapshot,
      waveId: job.waveId,
      jobId: job.id,
      contextSnapshotId: job.contextSnapshotId,
      sourceMessageIds: job.visibleMessageIds,
      freshnessAtCompletion: 'FRESH',
      clientOperationId: 'curated-checkpoint-message'
    });
    await fixture.discourse.updateJob({
      conversationId: fixture.conversationId,
      expectedRevision: job.recordRevision,
      clientOperationId: 'curated-checkpoint-job-terminal',
      job: {
        ...job,
        recordRevision: job.recordRevision + 1,
        status: 'COMPLETED',
        delivery: 'TERMINAL',
        freshnessAtCompletion: 'FRESH',
        result: { kind: 'CONTRIBUTION', outputMessageId: message.id },
        finishedAt: completedAt
      }
    });

    expect((await fixture.runtime.snapshot()).queueEntries[0]).toMatchObject({
      status: 'LEASED'
    });
    expect(await fixture.coordinator.recoverConversation(fixture.conversationId)).toEqual({
      recoveredJobIds: [fixture.jobId],
      recoveryRequiredJobIds: [],
      tombstonedRunIds: []
    });
    expect(await fixture.runtime.getSession(running.sessionId)).toMatchObject({ status: 'IDLE' });
    expect((await fixture.runtime.snapshot()).queueEntries[0]).toMatchObject({
      status: 'SETTLED'
    });
    expect((await fixture.discourse.getConversation(fixture.conversationId)).waves[0]).toMatchObject({
      status: 'SETTLED',
      outcome: 'COMPLETE'
    });
  });

  it('recovers an empty provider terminal as the same structured failure as live ingestion', async () => {
    const fixture = await coordinatorFixture();
    await fixture.coordinator.prepareJob({
      conversationId: fixture.conversationId,
      waveId: fixture.waveId,
      jobId: fixture.jobId,
      executionContext: fixture.executionContext,
      prompt: 'Return a usable answer.',
      clientOperationId: 'prepare-empty-terminal'
    });
    const [leased] = await fixture.scheduler.leaseAvailable('lease-empty-terminal');
    const running = await fixture.coordinator.dispatchLeasedJob(
      leased!.id,
      fixture.provider,
      'dispatch-empty-terminal'
    );
    await fixture.runtime.updateRun(
      running.id,
      running.recordRevision,
      {
        status: 'COMPLETED',
        delivery: 'TERMINAL',
        contextFreshnessAtCompletion: 'FRESH',
        providerTerminalSource: 'TEST_TERMINAL',
        endedAt: '2026-07-13T00:10:00.000Z',
        lastEventAt: '2026-07-13T00:10:00.000Z'
      },
      'empty-runtime-terminal'
    );

    expect(await fixture.coordinator.recoverConversation(fixture.conversationId)).toEqual({
      recoveredJobIds: [fixture.jobId],
      recoveryRequiredJobIds: [],
      tombstonedRunIds: []
    });
    expect(await fixture.discourse.getConversation(fixture.conversationId)).toMatchObject({
      waves: [{ status: 'SETTLED', outcome: 'NO_RESPONSE' }],
      jobs: [{
        status: 'FAILED',
        delivery: 'TERMINAL',
        error: {
          code: 'OUTPUT_MISSING',
          message: 'The agent completed without a usable response.'
        }
      }]
    });
    expect((await fixture.runtime.snapshot()).queueEntries[0]).toMatchObject({
      status: 'SETTLED'
    });
  });

  it('quarantines every duplicate runtime claim and lets an explicit stop settle it locally', async () => {
    const fixture = await coordinatorFixture();
    const prepared = await fixture.coordinator.prepareJob({
      conversationId: fixture.conversationId,
      waveId: fixture.waveId,
      jobId: fixture.jobId,
      executionContext: fixture.executionContext,
      prompt: 'Never dispatch duplicate runtime claims.',
      clientOperationId: 'prepare-duplicate-runtime'
    });
    const duplicateRunId = 'duplicate-runtime-run';
    const duplicate = await fixture.runtime.createRun({
      id: duplicateRunId,
      owner: prepared.run.owner,
      scope: prepared.run.scope,
      sessionId: prepared.run.sessionId,
      sessionAccessEpoch: prepared.run.sessionAccessEpoch,
      purpose: prepared.run.purpose,
      generationKey: prepared.run.generationKey,
      clientOperationId: 'create-duplicate-runtime',
      requestedSettings: prepared.run.requestedSettings,
      promptArtifactId: 'duplicate-prompt',
      outputArtifactId: 'duplicate-output',
      diagnosticArtifactId: 'duplicate-diagnostic'
    });
    await Promise.all([
      fixture.runtime.createArtifact({
        id: duplicate.promptArtifactId,
        owner: duplicate.owner,
        runId: duplicate.id,
        kind: 'PROMPT',
        clientOperationId: 'duplicate-prompt-artifact',
        content: 'Never dispatch duplicate runtime claims.'
      }),
      fixture.runtime.createArtifact({
        id: duplicate.outputArtifactId,
        owner: duplicate.owner,
        runId: duplicate.id,
        kind: 'OUTPUT',
        clientOperationId: 'duplicate-output-artifact',
        content: ''
      }),
      fixture.runtime.createArtifact({
        id: duplicate.diagnosticArtifactId,
        owner: duplicate.owner,
        runId: duplicate.id,
        kind: 'DIAGNOSTIC',
        clientOperationId: 'duplicate-diagnostic-artifact',
        content: ''
      })
    ]);
    await fixture.runtime.enqueueRun(
      duplicate.id,
      'DISCOURSE_RESPONSE',
      'enqueue-duplicate-runtime'
    );

    expect(await fixture.coordinator.recoverConversation(fixture.conversationId)).toEqual({
      recoveredJobIds: [],
      recoveryRequiredJobIds: [fixture.jobId],
      tombstonedRunIds: []
    });
    const quarantined = await fixture.runtime.snapshot();
    expect(quarantined.runs).toHaveLength(2);
    expect(quarantined.runs.every((run) => run.status === 'RECOVERY_REQUIRED')).toBe(true);
    expect(quarantined.queueEntries.every((entry) => entry.status === 'CANCELED')).toBe(true);
    expect(await fixture.scheduler.leaseAvailable('lease-after-quarantine')).toEqual([]);
    expect(fixture.provider.calls).toHaveLength(0);

    await expect(fixture.coordinator.stopActiveWave({
      conversationId: fixture.conversationId,
      waveId: fixture.waveId,
      clientOperationId: 'stop-duplicate-recovery',
      reason: 'User stopped the inconsistent response.'
    }, fixture.provider)).resolves.toMatchObject({
      status: 'SETTLED',
      outcome: 'CANCELED'
    });
    const settled = await fixture.runtime.snapshot();
    expect(settled.runs.every((run) => run.status === 'INTERRUPTED')).toBe(true);
    expect(settled.runs.every((run) => run.recoveryState === 'NONE')).toBe(true);
    expect(fixture.provider.calls).toHaveLength(0);
  });

  it('retains capacity and interrupts an acknowledged turn when a stale runtime claim is quarantined', async () => {
    const fixture = await coordinatorFixture();
    const prepared = await fixture.coordinator.prepareJob({
      conversationId: fixture.conversationId,
      waveId: fixture.waveId,
      jobId: fixture.jobId,
      executionContext: fixture.executionContext,
      prompt: 'Fence stale attempts without losing the active provider turn.',
      clientOperationId: 'prepare-active-duplicate'
    });
    const [leased] = await fixture.scheduler.leaseAvailable('lease-active-duplicate');
    const running = await fixture.coordinator.dispatchLeasedJob(
      leased!.id,
      fixture.provider,
      'dispatch-active-duplicate'
    );
    if (prepared.run.scope.kind !== 'DISCOURSE') {
      throw new Error('Expected a Discourse runtime scope.');
    }
    const stale = await fixture.runtime.createRun({
      id: 'stale-active-duplicate',
      owner: prepared.run.owner,
      scope: { ...prepared.run.scope, attemptId: 'stale-attempt' },
      sessionId: prepared.run.sessionId,
      sessionAccessEpoch: prepared.run.sessionAccessEpoch,
      purpose: prepared.run.purpose,
      generationKey: 'stale-generation',
      clientOperationId: 'create-stale-active-duplicate',
      requestedSettings: prepared.run.requestedSettings,
      promptArtifactId: 'stale-active-prompt',
      outputArtifactId: 'stale-active-output',
      diagnosticArtifactId: 'stale-active-diagnostic'
    });
    await Promise.all([
      fixture.runtime.createArtifact({
        id: stale.promptArtifactId,
        owner: stale.owner,
        runId: stale.id,
        kind: 'PROMPT',
        clientOperationId: 'stale-active-prompt-artifact',
        content: 'Fence stale attempts without losing the active provider turn.'
      }),
      fixture.runtime.createArtifact({
        id: stale.outputArtifactId,
        owner: stale.owner,
        runId: stale.id,
        kind: 'OUTPUT',
        clientOperationId: 'stale-active-output-artifact',
        content: ''
      }),
      fixture.runtime.createArtifact({
        id: stale.diagnosticArtifactId,
        owner: stale.owner,
        runId: stale.id,
        kind: 'DIAGNOSTIC',
        clientOperationId: 'stale-active-diagnostic-artifact',
        content: ''
      })
    ]);
    await fixture.runtime.enqueueRun(
      stale.id,
      'DISCOURSE_RESPONSE',
      'enqueue-stale-active-duplicate'
    );

    await expect(fixture.coordinator.recoverConversation(fixture.conversationId))
      .resolves.toMatchObject({ recoveryRequiredJobIds: [fixture.jobId] });
    let snapshot = await fixture.runtime.snapshot();
    expect(snapshot.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: running.id, status: 'RECOVERY_REQUIRED', delivery: 'ACKNOWLEDGED' }),
      expect.objectContaining({ id: stale.id, status: 'RECOVERY_REQUIRED', delivery: 'NOT_DELIVERED' })
    ]));
    expect(snapshot.queueEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: running.id, status: 'LEASED' }),
      expect.objectContaining({ runId: stale.id, status: 'CANCELED' })
    ]));
    expect(await fixture.scheduler.leaseAvailable('lease-while-active-duplicate-fenced'))
      .toEqual([]);

    await expect(fixture.coordinator.stopActiveWave({
      conversationId: fixture.conversationId,
      waveId: fixture.waveId,
      clientOperationId: 'stop-active-duplicate',
      reason: 'User stopped the inconsistent response.'
    }, fixture.provider)).resolves.toMatchObject({ status: 'STOPPING' });
    snapshot = await fixture.runtime.snapshot();
    expect(fixture.provider.interruptCalls).toEqual([running.id]);
    expect(snapshot.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: running.id, status: 'INTERRUPTING', interruptDelivery: 'ACKNOWLEDGED' }),
      expect.objectContaining({ id: stale.id, status: 'INTERRUPTED', recoveryState: 'NONE' })
    ]));
    expect(snapshot.sessions.find((session) => session.id === running.sessionId))
      .toMatchObject({ status: 'ACTIVE' });
    expect(snapshot.queueEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: running.id, status: 'LEASED' }),
      expect.objectContaining({ runId: stale.id, status: 'CANCELED' })
    ]));

    await fixture.coordinator.ingestFailure({
      runId: running.id,
      providerTurnId: running.providerTurnId!,
      clientOperationId: 'active-duplicate-terminal',
      completedAt: '2026-07-13T00:10:00.000Z',
      providerTerminalSource: 'TEST_INTERRUPTED',
      reason: 'Provider confirmed interruption.'
    });
    snapshot = await fixture.runtime.snapshot();
    expect(snapshot.queueEntries.find((entry) => entry.runId === running.id))
      .toMatchObject({ status: 'SETTLED' });
    expect(snapshot.sessions.find((session) => session.id === running.sessionId))
      .toMatchObject({ status: 'IDLE' });
    expect((await fixture.discourse.getConversation(fixture.conversationId)).waves[0])
      .toMatchObject({ status: 'SETTLED', outcome: 'CANCELED' });
  });

  it('defers a natural terminal until a delivered duplicate claim also reaches terminal', async () => {
    const fixture = await coordinatorFixture();
    const { running, stale } = await prepareDeliveredDuplicate(fixture, 'natural-success');

    await expect(fixture.coordinator.recoverConversation(fixture.conversationId))
      .resolves.toMatchObject({ recoveryRequiredJobIds: [fixture.jobId] });
    await expect(fixture.coordinator.ingestContribution({
      runId: running.id,
      providerTurnId: running.providerTurnId!,
      body: 'Only the authoritative attempt may become the visible answer.',
      freshnessAtCompletion: 'FRESH',
      clientOperationId: 'natural-success-authoritative-terminal',
      completedAt: '2026-07-13T00:10:00.000Z',
      providerTerminalSource: 'TEST_TERMINAL'
    })).resolves.toMatchObject({ kind: 'IGNORED_TERMINAL' });
    expect((await fixture.discourse.listMessages({
      conversationId: fixture.conversationId,
      limit: 100
    })).messages).toHaveLength(1);
    expect((await fixture.runtime.snapshot()).queueEntries.find((entry) => entry.runId === stale.id))
      .toMatchObject({ status: 'LEASED' });

    await fixture.coordinator.ingestFailure({
      runId: stale.id,
      providerTurnId: stale.providerTurnId!,
      clientOperationId: 'natural-success-stale-terminal',
      completedAt: '2026-07-13T00:11:00.000Z',
      providerTerminalSource: 'TEST_TERMINAL',
      reason: 'The stale provider attempt also ended.'
    });
    const aggregate = await fixture.discourse.getConversation(fixture.conversationId);
    expect(aggregate).toMatchObject({
      waves: [{ status: 'SETTLED', outcome: 'COMPLETE' }],
      jobs: [{ status: 'COMPLETED', result: { kind: 'CONTRIBUTION' } }]
    });
    expect((await fixture.discourse.listMessages({
      conversationId: fixture.conversationId,
      limit: 100
    })).messages.at(-1)?.body).toBe(
      'Only the authoritative attempt may become the visible answer.'
    );
    expect((await fixture.runtime.snapshot()).queueEntries.every(
      (entry) => entry.status === 'SETTLED'
    )).toBe(true);
  });

  it('defers a natural failure until a delivered duplicate claim also reaches terminal', async () => {
    const fixture = await coordinatorFixture();
    const { running, stale } = await prepareDeliveredDuplicate(fixture, 'natural-failure');
    await fixture.coordinator.recoverConversation(fixture.conversationId);

    await fixture.coordinator.ingestFailure({
      runId: running.id,
      providerTurnId: running.providerTurnId!,
      clientOperationId: 'natural-failure-authoritative-terminal',
      completedAt: '2026-07-13T00:10:00.000Z',
      providerTerminalSource: 'TEST_TERMINAL',
      reason: 'The authoritative provider attempt failed.'
    });
    expect((await fixture.discourse.getConversation(fixture.conversationId)).jobs[0])
      .toMatchObject({ status: 'RECOVERY_REQUIRED' });

    await fixture.coordinator.ingestFailure({
      runId: stale.id,
      providerTurnId: stale.providerTurnId!,
      clientOperationId: 'natural-failure-stale-terminal',
      completedAt: '2026-07-13T00:11:00.000Z',
      providerTerminalSource: 'TEST_TERMINAL',
      reason: 'The stale provider attempt also failed.'
    });
    expect(await fixture.discourse.getConversation(fixture.conversationId)).toMatchObject({
      waves: [{ status: 'SETTLED', outcome: 'NO_RESPONSE' }],
      jobs: [{ status: 'FAILED' }]
    });
    expect((await fixture.runtime.snapshot()).queueEntries.every(
      (entry) => entry.status === 'SETTLED'
    )).toBe(true);
  });

  it('never quarantines a referenced runtime whose scope belongs to another job', async () => {
    const fixture = await coordinatorFixture();
    const owner = {
      kind: 'DISCOURSE' as const,
      conversationId: fixture.conversationId,
      stableParticipantId: 'foreign-participant'
    };
    const sessionId = 'foreign-job-session';
    const accessEpoch = createAgentSessionAccessEpoch({
      owner,
      sessionId,
      epoch: 1,
      runtimeId: 'codex',
      model: 'gpt-test',
      executionContext: fixture.executionContext,
      createdAt: '2026-07-13T00:02:00.000Z'
    });
    const session = await fixture.runtime.createSession({
      id: sessionId,
      owner,
      accessEpoch,
      executionContext: fixture.executionContext,
      clientOperationId: 'create-foreign-job-session',
      runtimeId: 'codex',
      role: 'PRIMARY',
      relationshipState: 'ROOT',
      status: 'NOT_MATERIALIZED',
      materialized: false,
      requestedSettings: {
        model: 'gpt-test',
        sandbox: 'READ_ONLY',
        approvalPolicy: 'NEVER',
        networkAccess: false
      }
    });
    const foreignRun = await fixture.runtime.createRun({
      id: 'foreign-job-run',
      owner,
      scope: {
        kind: 'DISCOURSE',
        conversationId: fixture.conversationId,
        waveId: fixture.waveId,
        jobId: 'foreign-job',
        contextSnapshotId: 'context-snapshot-1',
        attemptId: 'foreign-attempt'
      },
      sessionId: session.id,
      sessionAccessEpoch: session.accessEpoch.epoch,
      purpose: 'DISCOURSE_ANSWER',
      generationKey: 'foreign-generation',
      clientOperationId: 'create-foreign-job-run',
      requestedSettings: session.requestedSettings,
      promptArtifactId: 'foreign-job-prompt',
      outputArtifactId: 'foreign-job-output',
      diagnosticArtifactId: 'foreign-job-diagnostic'
    });
    await Promise.all([
      fixture.runtime.createArtifact({ id: foreignRun.promptArtifactId, owner, runId: foreignRun.id, kind: 'PROMPT', clientOperationId: 'foreign-prompt-artifact', content: 'Foreign job.' }),
      fixture.runtime.createArtifact({ id: foreignRun.outputArtifactId, owner, runId: foreignRun.id, kind: 'OUTPUT', clientOperationId: 'foreign-output-artifact', content: '' }),
      fixture.runtime.createArtifact({ id: foreignRun.diagnosticArtifactId, owner, runId: foreignRun.id, kind: 'DIAGNOSTIC', clientOperationId: 'foreign-diagnostic-artifact', content: '' })
    ]);
    const foreignEntry = await fixture.runtime.enqueueRun(
      foreignRun.id,
      'DISCOURSE_RESPONSE',
      'enqueue-foreign-job-run'
    );
    const aggregate = await fixture.discourse.getConversation(fixture.conversationId);
    const wave = aggregate.waves[0]!;
    await fixture.discourse.updateWave({
      conversationId: fixture.conversationId,
      expectedRevision: wave.recordRevision,
      clientOperationId: 'foreign-link-wave-snapshotting',
      wave: { ...wave, recordRevision: wave.recordRevision + 1, status: 'SNAPSHOTTING' }
    });
    const job = aggregate.jobs[0]!;
    await fixture.discourse.updateJob({
      conversationId: fixture.conversationId,
      expectedRevision: job.recordRevision,
      clientOperationId: 'link-job-to-foreign-scope',
      job: {
        ...job,
        recordRevision: job.recordRevision + 1,
        status: 'RESOLVING_CONTEXT',
        sessionId: session.id,
        executionProfileHash: session.accessEpoch.executionProfileHash,
        runId: foreignRun.id,
        promptArtifactId: foreignRun.promptArtifactId,
        outputArtifactId: foreignRun.outputArtifactId
      }
    });

    await expect(fixture.coordinator.recoverConversation(fixture.conversationId))
      .resolves.toMatchObject({ recoveryRequiredJobIds: [fixture.jobId] });
    expect(await fixture.runtime.getRun(foreignRun.id)).toMatchObject({
      status: 'QUEUED',
      delivery: 'NOT_SENT'
    });
    expect((await fixture.runtime.snapshot()).queueEntries.find(
      (entry) => entry.id === foreignEntry.id
    )).toMatchObject({ status: 'QUEUED' });
    expect((await fixture.discourse.getConversation(fixture.conversationId)).jobs[0])
      .toMatchObject({ status: 'RECOVERY_REQUIRED' });
  });

  it.each([
    { name: 'ambiguous', delivery: 'AMBIGUOUS' as const, interruptDelivery: undefined },
    { name: 'not-delivered interrupt', delivery: 'ACKNOWLEDGED' as const, interruptDelivery: 'NOT_DELIVERED' as const }
  ])('projects a partial $name runtime recovery before stopping it', async ({ name, delivery, interruptDelivery }) => {
    const fixture = await coordinatorFixture();
    await fixture.coordinator.prepareJob({
      conversationId: fixture.conversationId,
      waveId: fixture.waveId,
      jobId: fixture.jobId,
      executionContext: fixture.executionContext,
      prompt: 'Project the provider recovery checkpoint first.',
      clientOperationId: `prepare-partial-${name}`
    });
    const [leased] = await fixture.scheduler.leaseAvailable(`lease-partial-${name}`);
    const running = await fixture.coordinator.dispatchLeasedJob(
      leased!.id,
      fixture.provider,
      `dispatch-partial-${name}`
    );
    const recoveryBase = interruptDelivery
      ? await fixture.runtime.updateRun(
          running.id,
          running.recordRevision,
          {
            status: 'INTERRUPTING',
            interruptDelivery: 'SENDING',
            stopRequestedAt: '2026-07-13T00:08:00.000Z',
            lastEventAt: '2026-07-13T00:08:00.000Z'
          },
          `runtime-partial-${name}-intent`
        )
      : running;
    await fixture.runtime.updateRun(
      recoveryBase.id,
      recoveryBase.recordRevision,
      {
        status: 'RECOVERY_REQUIRED',
        delivery,
        ...(interruptDelivery ? {
          interruptDelivery
        } : {}),
        recoveryState: 'REQUIRES_USER_ACTION',
        terminalReason: `Partial ${name} recovery checkpoint.`,
        lastEventAt: '2026-07-13T00:08:00.000Z'
      },
      `runtime-partial-${name}`
    );

    await expect(fixture.coordinator.stopActiveWave({
      conversationId: fixture.conversationId,
      waveId: fixture.waveId,
      clientOperationId: `stop-partial-${name}`,
      reason: 'User stopped the recovering response.'
    }, fixture.provider)).resolves.toMatchObject({ status: 'STOPPING' });
    expect((await fixture.discourse.getConversation(fixture.conversationId)).jobs[0])
      .toMatchObject({
        status: interruptDelivery ? 'CANCEL_REQUESTED' : 'RECOVERY_REQUIRED'
      });
    expect(fixture.provider.interruptCalls).toHaveLength(interruptDelivery ? 1 : 0);
    expect((await fixture.runtime.snapshot()).queueEntries[0])
      .toMatchObject({ status: 'LEASED' });
  });

  it('projects incomplete terminal evidence into durable recovery state', async () => {
    const fixture = await coordinatorFixture();
    await fixture.coordinator.prepareJob({
      conversationId: fixture.conversationId,
      waveId: fixture.waveId,
      jobId: fixture.jobId,
      executionContext: fixture.executionContext,
      prompt: 'Do not hide an incomplete provider terminal.',
      clientOperationId: 'prepare-incomplete-terminal'
    });
    const [leased] = await fixture.scheduler.leaseAvailable('lease-incomplete-terminal');
    const running = await fixture.coordinator.dispatchLeasedJob(
      leased!.id,
      fixture.provider,
      'dispatch-incomplete-terminal'
    );
    await fixture.runtime.updateRun(
      running.id,
      running.recordRevision,
      {
        status: 'COMPLETED',
        delivery: 'TERMINAL',
        endedAt: '2026-07-13T00:10:00.000Z',
        lastEventAt: '2026-07-13T00:10:00.000Z'
      },
      'provider-incomplete-terminal'
    );

    expect(await fixture.coordinator.recoverConversation(fixture.conversationId)).toEqual({
      recoveredJobIds: [],
      recoveryRequiredJobIds: [fixture.jobId],
      tombstonedRunIds: []
    });
    expect(await fixture.discourse.getConversation(fixture.conversationId)).toMatchObject({
      waves: [{ status: 'RECOVERY_REQUIRED' }],
      jobs: [{
        status: 'RECOVERY_REQUIRED',
        delivery: 'ACKNOWLEDGED',
        error: {
          code: 'DELIVERY_AMBIGUOUS',
          message: 'The provider completed, but its durable terminal evidence is incomplete.'
        }
      }]
    });
  });

  it('recovers a provider failure terminal and settles its durable lease', async () => {
    const fixture = await coordinatorFixture();
    await fixture.coordinator.prepareJob({
      conversationId: fixture.conversationId,
      waveId: fixture.waveId,
      jobId: fixture.jobId,
      executionContext: fixture.executionContext,
      prompt: 'Recover a failed provider terminal.',
      clientOperationId: 'prepare-failure'
    });
    const [leased] = await fixture.scheduler.leaseAvailable('lease-failure');
    const running = await fixture.coordinator.dispatchLeasedJob(
      leased!.id,
      fixture.provider,
      'dispatch-failure'
    );
    await fixture.runtime.updateRun(
      running.id,
      running.recordRevision,
      {
        status: 'FAILED',
        delivery: 'TERMINAL',
        terminalReason: 'Provider rejected the scoped turn.',
        providerTerminalSource: 'TEST_FAILURE',
        lastEventAt: '2026-07-13T00:10:00.000Z',
        endedAt: '2026-07-13T00:10:00.000Z'
      },
      'provider-failure-terminal'
    );

    expect(await fixture.coordinator.recoverConversation(fixture.conversationId)).toEqual({
      recoveredJobIds: [fixture.jobId],
      recoveryRequiredJobIds: [],
      tombstonedRunIds: []
    });
    expect(await fixture.discourse.getConversation(fixture.conversationId)).toMatchObject({
      waves: [{ status: 'SETTLED' }],
      jobs: [
        {
          status: 'FAILED',
          delivery: 'TERMINAL',
          error: { message: 'Provider rejected the scoped turn.' }
        }
      ]
    });
    expect((await fixture.runtime.snapshot()).queueEntries[0]).toMatchObject({
      status: 'SETTLED'
    });
  });

  it('marks an unacknowledged durable start intent as ambiguous instead of replaying it', async () => {
    const fixture = await coordinatorFixture();
    const prepared = await fixture.coordinator.prepareJob({
      conversationId: fixture.conversationId,
      waveId: fixture.waveId,
      jobId: fixture.jobId,
      executionContext: fixture.executionContext,
      prompt: 'Do not replay an ambiguous start.',
      clientOperationId: 'prepare-1'
    });
    await fixture.scheduler.leaseAvailable('lease');
    await fixture.runtime.updateRun(
      prepared.run.id,
      prepared.run.recordRevision,
      {
        status: 'STARTING',
        delivery: 'SENDING',
        startedAt: '2026-07-13T00:07:00.000Z',
        lastEventAt: '2026-07-13T00:07:00.000Z'
      },
      'crash-after-start-intent'
    );

    expect(await fixture.coordinator.recoverConversation(fixture.conversationId)).toEqual({
      recoveredJobIds: [],
      recoveryRequiredJobIds: [fixture.jobId],
      tombstonedRunIds: []
    });
    expect(await fixture.runtime.getRun(prepared.run.id)).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      delivery: 'AMBIGUOUS'
    });
    expect(await fixture.discourse.getConversation(fixture.conversationId)).toMatchObject({
      waves: [{ status: 'RECOVERY_REQUIRED' }],
      jobs: [{ status: 'RECOVERY_REQUIRED', delivery: 'AMBIGUOUS' }]
    });
    expect(fixture.provider.calls).toHaveLength(0);
  });

  it('projects an existing runtime recovery checkpoint into durable job and wave state', async () => {
    const fixture = await coordinatorFixture();
    await fixture.coordinator.prepareJob({
      conversationId: fixture.conversationId,
      waveId: fixture.waveId,
      jobId: fixture.jobId,
      executionContext: fixture.executionContext,
      prompt: 'Preserve an ambiguous provider checkpoint.',
      clientOperationId: 'prepare-existing-recovery'
    });
    const [leased] = await fixture.scheduler.leaseAvailable('lease-existing-recovery');
    const running = await fixture.coordinator.dispatchLeasedJob(
      leased!.id,
      fixture.provider,
      'dispatch-existing-recovery'
    );
    await fixture.runtime.updateRun(
      running.id,
      running.recordRevision,
      {
        status: 'RECOVERY_REQUIRED',
        delivery: 'AMBIGUOUS',
        recoveryState: 'REQUIRES_USER_ACTION',
        terminalReason: 'Provider connection ended before terminal evidence arrived.',
        lastEventAt: '2026-07-13T00:09:00.000Z'
      },
      'runtime-existing-recovery'
    );

    expect(await fixture.coordinator.recoverConversation(fixture.conversationId)).toEqual({
      recoveredJobIds: [],
      recoveryRequiredJobIds: [fixture.jobId],
      tombstonedRunIds: []
    });
    expect(await fixture.discourse.getConversation(fixture.conversationId)).toMatchObject({
      waves: [{ status: 'RECOVERY_REQUIRED' }],
      jobs: [{
        status: 'RECOVERY_REQUIRED',
        delivery: 'ACKNOWLEDGED',
        error: {
          code: 'DELIVERY_AMBIGUOUS',
          message: 'Provider connection ended before terminal evidence arrived.'
        }
      }]
    });
  });
});

async function coordinatorFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-discourse-runtime-'));
  const runtime = new FileAgentRuntimeStore(path.join(root, 'runtime'));
  const discourse = new FileDiscourseStore(path.join(root, 'discourse'));
  const participant = participantSeed('conversation-1');
  const conversation = await discourse.createConversation({
    id: 'conversation-1',
    title: 'Scoped runtime test',
    defaultPolicy: 'DIRECT',
    participants: [participant.participant],
    participantRevisions: [participant.revision],
    clientOperationId: 'create-conversation',
    requestFingerprint: 'b'.repeat(64)
  });
  const trigger = await discourse.appendHumanMessage({
    conversationId: conversation.id,
    body: 'Explain the runtime boundary.',
    clientMessageId: 'trigger-message'
  });
  const aggregate = await discourse.getConversation(conversation.id);
  const assignment = assignmentFromRevision(participant.revision);
  const wave = directWave(trigger.id, trigger.contextRevisionId!, assignment);
  const job = directJob(trigger.id, assignment);
  const contextSnapshot = directContextSnapshot(wave, trigger.ordinal);
  await discourse.createWave({
    conversationId: conversation.id,
    expectedConversationRevision: aggregate.conversation.recordRevision,
    wave,
    jobs: [job],
    contextSnapshot,
    clientOperationId: wave.clientOperationId
  });
  const emptyWorkspace = path.join(root, 'empty-workspace');
  await fs.mkdir(emptyWorkspace, { mode: 0o700 });
  const executionContext = {
    attestation: { status: 'ATTESTED' as const },
    primaryCwd: emptyWorkspace,
    readRoots: [{ canonicalPath: emptyWorkspace, kind: 'EMPTY_MANAGED' as const }],
    managedAttachments: [],
    permissionProfileHash: 'd'.repeat(64),
    modelSettings: {
      model: 'gpt-test',
      modelProvider: 'openai',
      sandbox: 'READ_ONLY' as const,
      approvalPolicy: 'NEVER',
      networkAccess: false
    },
    externalTools: {
      network: false,
      webSearch: 'disabled' as const,
      mcpServers: false,
      apps: false,
      dynamicTools: false
    },
    clientOperationId: 'execution-context-1'
  };
  const provider = new TestScopedProvider();
  const coordinator = new DiscourseRuntimeCoordinator(
    discourse,
    runtime,
    () => '2026-07-13T00:05:00.000Z'
  );
  const scheduler = new AgentTurnScheduler(runtime, () => '2026-07-13T00:06:00.000Z');
  return {
    runtime,
    discourse,
    coordinator,
    scheduler,
    provider,
    executionContext,
    conversationId: conversation.id,
    waveId: wave.id,
    jobId: job.id
  };
}

async function createSiblingRuntimeRun(
  fixture: Awaited<ReturnType<typeof coordinatorFixture>>,
  prepared: Awaited<ReturnType<DiscourseRuntimeCoordinator['prepareJob']>>,
  input: {
    id: string;
    scope: Extract<typeof prepared.run.scope, { kind: 'DISCOURSE' }>;
    generationKey: string;
  }
) {
  const run = await fixture.runtime.createRun({
    id: input.id,
    owner: prepared.run.owner,
    scope: input.scope,
    sessionId: prepared.run.sessionId,
    sessionAccessEpoch: prepared.run.sessionAccessEpoch,
    purpose: prepared.run.purpose,
    generationKey: input.generationKey,
    clientOperationId: `create-${input.id}`,
    requestedSettings: prepared.run.requestedSettings,
    promptArtifactId: `${input.id}-prompt`,
    outputArtifactId: `${input.id}-output`,
    diagnosticArtifactId: `${input.id}-diagnostic`
  });
  await Promise.all([
    fixture.runtime.createArtifact({
      id: run.promptArtifactId,
      owner: run.owner,
      runId: run.id,
      kind: 'PROMPT',
      clientOperationId: `${input.id}-prompt-artifact`,
      content: 'Sibling runtime prompt.'
    }),
    fixture.runtime.createArtifact({
      id: run.outputArtifactId,
      owner: run.owner,
      runId: run.id,
      kind: 'OUTPUT',
      clientOperationId: `${input.id}-output-artifact`,
      content: ''
    }),
    fixture.runtime.createArtifact({
      id: run.diagnosticArtifactId,
      owner: run.owner,
      runId: run.id,
      kind: 'DIAGNOSTIC',
      clientOperationId: `${input.id}-diagnostic-artifact`,
      content: ''
    })
  ]);
  const queueEntry = await fixture.runtime.enqueueRun(
    run.id,
    'DISCOURSE_RESPONSE',
    `enqueue-${input.id}`
  );
  return { run, queueEntry };
}

async function prepareDeliveredDuplicate(
  fixture: Awaited<ReturnType<typeof coordinatorFixture>>,
  id: string
) {
  const prepared = await fixture.coordinator.prepareJob({
    conversationId: fixture.conversationId,
    waveId: fixture.waveId,
    jobId: fixture.jobId,
    executionContext: fixture.executionContext,
    prompt: 'Keep duplicate terminal projection fenced.',
    clientOperationId: `prepare-${id}`
  });
  const [leased] = await fixture.scheduler.leaseAvailable(`lease-${id}`);
  const running = await fixture.coordinator.dispatchLeasedJob(
    leased!.id,
    fixture.provider,
    `dispatch-${id}`
  );
  if (prepared.run.scope.kind !== 'DISCOURSE') throw new Error('Expected Discourse scope.');
  const sibling = await createSiblingRuntimeRun(fixture, prepared, {
    id: `${id}-stale`,
    scope: { ...prepared.run.scope, attemptId: `${id}-stale-attempt` },
    generationKey: `${id}-stale-generation`
  });
  const siblingLease = await fixture.runtime.leaseQueueEntry(
    sibling.queueEntry.id,
    sibling.queueEntry.recordRevision,
    `lease-${id}-stale`
  );
  let stale = await fixture.runtime.updateRun(
    sibling.run.id,
    sibling.run.recordRevision,
    {
      status: 'STARTING',
      delivery: 'SENDING',
      startedAt: '2026-07-13T00:07:00.000Z',
      lastEventAt: '2026-07-13T00:07:00.000Z'
    },
    `start-${id}-stale`
  );
  stale = await fixture.runtime.updateRun(
    stale.id,
    stale.recordRevision,
    {
      status: 'RUNNING',
      delivery: 'ACKNOWLEDGED',
      providerTurnId: `${id}-stale-provider-turn`,
      serverInstanceId: 'server-1',
      lastEventAt: '2026-07-13T00:07:00.000Z'
    },
    `ack-${id}-stale`
  );
  void siblingLease;
  return { running, stale };
}

class TestScopedProvider implements AgentScopedTurnProvider {
  calls: StartScopedAgentTurnInput[] = [];
  interruptCalls: string[] = [];
  ambiguousInterrupt = false;
  notDeliveredInterrupt = false;

  async startScopedTurn(input: StartScopedAgentTurnInput) {
    this.calls.push(input);
    expect(input.run.owner.kind).toBe('DISCOURSE');
    expect(input.executionContext.modelSettings.sandbox).toBe('READ_ONLY');
    expect(input.executionContext.externalTools.network).toBe(false);
    return {
      serverInstanceId: 'server-1',
      providerSessionId: 'provider-session-1',
      providerTurnId: 'provider-turn-1',
      startedAt: '2026-07-13T00:07:00.000Z'
    };
  }

  async interruptScopedTurn(
    input: Pick<StartScopedAgentTurnInput, 'session' | 'run'>
  ) {
    this.interruptCalls.push(input.run.id);
    if (this.ambiguousInterrupt) {
      throw new AgentScopedMutationError(
        'AMBIGUOUS',
        'Provider interrupt response was lost.'
      );
    }
    if (this.notDeliveredInterrupt) {
      throw new AgentScopedMutationError(
        'NOT_DELIVERED',
        'Provider rejected the interrupt before delivery.'
      );
    }
  }
}

function participantSeed(conversationId: string): {
  participant: DiscourseParticipantRecord;
  revision: DiscourseParticipantRevisionRecord;
} {
  return {
    participant: {
      id: 'participant-1',
      conversationId,
      agentProfileId: 'builtin.lead',
      currentRevisionId: 'participant-revision-1',
      enabled: true,
      recordRevision: 1,
      createdAt: '2026-07-13T00:00:00.000Z'
    },
    revision: {
      id: 'participant-revision-1',
      conversationId,
      stableParticipantId: 'participant-1',
      agentProfileId: 'builtin.lead',
      profileRevision: 1,
      displayNameSnapshot: 'Lead',
      runtimeId: 'codex',
      model: 'gpt-test',
      modelProvider: 'openai',
      configuredRole: 'LEAD',
      roleContractVersion: 1,
      roleContractHash: 'a'.repeat(64),
      revision: 1,
      createdAt: '2026-07-13T00:00:00.000Z'
    }
  };
}

function assignmentFromRevision(
  revision: DiscourseParticipantRevisionRecord
): AgentAssignmentSnapshot {
  return {
    stableParticipantId: revision.stableParticipantId,
    participantRevisionId: revision.id,
    agentProfileId: revision.agentProfileId,
    profileRevision: revision.profileRevision,
    displayNameSnapshot: revision.displayNameSnapshot,
    runtimeId: revision.runtimeId,
    model: revision.model,
    modelProvider: revision.modelProvider,
    configuredRole: revision.configuredRole,
    roleContractVersion: revision.roleContractVersion,
    roleContractHash: revision.roleContractHash,
    assignmentRole: 'PRIMARY',
    required: true
  };
}

function directWave(
  triggerMessageId: string,
  contextRevisionId: string,
  assignment: AgentAssignmentSnapshot
): DiscourseResponseWaveRecord {
  return {
    id: 'wave-1',
    conversationId: 'conversation-1',
    triggerMessageId,
    policy: 'DIRECT',
    policyVersion: 1,
    assignments: [assignment],
    sourceMessageIds: [triggerMessageId],
    plannedContextRevisionId: contextRevisionId,
    contextSnapshotId: 'context-snapshot-1',
    attempt: 1,
    recordRevision: 1,
    status: 'PLANNED',
    phase: 'ANSWER',
    clientOperationId: 'wave-plan-1',
    requestFingerprint: 'b'.repeat(64),
    dispatchGate: {
      status: 'READY',
      previewFingerprint: 'preview-1',
      confirmedAtRevision: 1
    },
    createdAt: '2026-07-13T00:01:00.000Z'
  };
}

function directContextSnapshot(
  wave: DiscourseResponseWaveRecord,
  triggerOrdinal: number
): import('../../shared/discourse').ContextSnapshotRecord {
  return {
    id: wave.contextSnapshotId!,
    conversationId: wave.conversationId,
    waveId: wave.id,
    contextRevisionId: wave.plannedContextRevisionId,
    recordRevision: 1,
    status: 'READY',
    sources: [],
    transcriptOrdinals: [triggerOrdinal],
    attachmentIds: [],
    permissionProfileHash: 'd'.repeat(64),
    budget: {
      inputBytes: 128,
      estimatedInputTokens: 32,
      reservedOutputTokens: 16_000,
      sourceCount: 0
    },
    exclusions: [],
    contextSchemaVersion: 1,
    promptPolicyVersion: 1,
    createdAt: '2026-07-13T00:01:00.000Z',
    resolvedAt: '2026-07-13T00:01:00.000Z'
  };
}

function directJob(
  triggerMessageId: string,
  assignment: AgentAssignmentSnapshot
): DiscourseAgentJobRecord {
  return {
    id: 'job-1',
    conversationId: 'conversation-1',
    waveId: 'wave-1',
    assignment,
    role: 'ANSWER',
    phase: 1,
    targetMessageIds: [],
    visibleMessageIds: [triggerMessageId],
    contextSnapshotId: 'context-snapshot-1',
    attemptId: 'attempt-1',
    generationKey: 'generation-1',
    recordRevision: 1,
    status: 'QUEUED',
    delivery: 'NOT_SENT',
    createdAt: '2026-07-13T00:01:00.000Z'
  };
}
