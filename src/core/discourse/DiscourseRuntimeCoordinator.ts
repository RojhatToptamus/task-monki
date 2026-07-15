import crypto from 'node:crypto';
import type {
  AgentExecutionContext,
  AgentRuntimePurpose,
  AgentRuntimeRunRecord,
  AgentRuntimeSessionRecord,
  AgentSchedulerQueueEntry
} from '../../shared/agentRuntime';
import type {
  DiscourseAgentJobRecord,
  DiscourseConcernRecord,
  DiscourseConversationTombstoneRecord,
  DiscourseMessageFreshness,
  DiscourseMessageRecord,
  DiscourseResponseWaveRecord,
  StructuredDiscourseError
} from '../../shared/discourse';
import { DISCOURSE_LIMITS } from '../../shared/discourse';
import { createAgentSessionAccessEpoch, assertDiscourseExecutionContext } from '../agent/AgentRuntimeOwnership';
import type { AgentRuntimeStore } from '../agent/AgentRuntimeStore';
import {
  AgentScopedMutationError,
  type AgentScopedTurnProvider,
  type StartedScopedAgentTurn
} from '../agent/AgentScopedTurnProvider';
import {
  deriveDiscourseWaveAggregate,
  isEligibleDiscourseConcern
} from './DiscourseState';
import {
  parseDiscourseCorrection,
  parseDiscourseReview
} from './DiscourseStructuredOutput';
import type { DiscourseStore } from './DiscourseStore';

export interface PrepareDiscourseJobInput {
  conversationId: string;
  waveId: string;
  jobId: string;
  executionContext: AgentExecutionContext;
  prompt: string;
  clientOperationId: string;
}

export interface PreparedDiscourseJob {
  session: AgentRuntimeSessionRecord;
  run: AgentRuntimeRunRecord;
  queueEntry: AgentSchedulerQueueEntry;
  job: DiscourseAgentJobRecord;
}

export interface IngestDiscourseContributionInput {
  runId: string;
  providerTurnId: string;
  body: string;
  freshnessAtCompletion: DiscourseMessageFreshness;
  clientOperationId: string;
  completedAt: string;
  providerTerminalSource: string;
}

export interface IngestDiscourseFailureInput {
  runId: string;
  providerTurnId: string;
  clientOperationId: string;
  completedAt: string;
  providerTerminalSource: string;
  reason: string;
}

export type DiscourseTerminalIngestionResult =
  | { kind: 'CURATED'; message: DiscourseMessageRecord }
  | { kind: 'INVALID_RESULT'; job: DiscourseAgentJobRecord; error: StructuredDiscourseError }
  | { kind: 'IGNORED_TERMINAL'; job: DiscourseAgentJobRecord }
  | { kind: 'CONVERSATION_DELETED'; tombstone: DiscourseConversationTombstoneRecord };

export type DiscourseReviewIngestionResult =
  | { kind: 'REVIEW'; job: DiscourseAgentJobRecord; concerns: DiscourseConcernRecord[] }
  | { kind: 'INVALID_RESULT'; job: DiscourseAgentJobRecord; error: StructuredDiscourseError }
  | { kind: 'IGNORED_TERMINAL'; job: DiscourseAgentJobRecord }
  | { kind: 'CONVERSATION_DELETED'; tombstone: DiscourseConversationTombstoneRecord };

export type DiscourseCorrectionIngestionResult =
  | DiscourseTerminalIngestionResult
  | { kind: 'CORRECTION'; job: DiscourseAgentJobRecord }
  | { kind: 'INVALID_RESULT'; job: DiscourseAgentJobRecord; error: StructuredDiscourseError };

export interface DiscourseRuntimeRecoveryResult {
  recoveredJobIds: string[];
  recoveryRequiredJobIds: string[];
  tombstonedRunIds: string[];
}

export interface CancelQueuedDiscourseWaveInput {
  conversationId: string;
  waveId: string;
  clientOperationId: string;
  reason: string;
}

export interface StopActiveDiscourseWaveInput {
  conversationId: string;
  waveId: string;
  clientOperationId: string;
  reason: string;
}

/**
 * Cross-store saga owner. Runtime terminal evidence is always durable before a
 * curated message/job transition, and every operation is retryable by stable
 * run/job identity.
 */
export class DiscourseRuntimeCoordinator {
  private readonly conversationMutations = new Map<string, Promise<unknown>>();

  constructor(
    private readonly discourse: DiscourseStore,
    private readonly runtime: AgentRuntimeStore,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  prepareJob(input: PrepareDiscourseJobInput): Promise<PreparedDiscourseJob> {
    return this.withConversationMutation(input.conversationId, () =>
      this.prepareJobUnlocked(input)
    );
  }

  async cumulativeWaveOutputBytes(
    conversationId: string,
    waveId: string
  ): Promise<number> {
    const snapshot = await this.runtime.snapshot();
    const outputs = await Promise.all(
      snapshot.runs.flatMap((run) =>
        run.scope.kind === 'DISCOURSE' &&
        run.scope.conversationId === conversationId &&
        run.scope.waveId === waveId &&
        run.status === 'COMPLETED'
          ? [this.runtime.readArtifact(run.outputArtifactId)]
          : []
      )
    );
    return outputs.reduce(
      (total, output) => total + Buffer.byteLength(output, 'utf8'),
      0
    );
  }

  reconcileWave(
    conversationId: string,
    waveId: string,
    clientOperationId: string
  ): Promise<DiscourseResponseWaveRecord> {
    return this.withConversationMutation(conversationId, async () => {
      await this.reconcileWaveFromChildren(conversationId, waveId, clientOperationId);
      return requireWave(
        (await this.discourse.getConversation(conversationId)).waves,
        waveId
      );
    });
  }

  private async prepareJobUnlocked(
    input: PrepareDiscourseJobInput
  ): Promise<PreparedDiscourseJob> {
    assertDiscourseExecutionContext(input.executionContext);
    const aggregate = await this.discourse.getConversation(input.conversationId);
    if (aggregate.conversation.status !== 'OPEN') {
      throw new Error('Archived discourse conversations cannot prepare agent work.');
    }
    const job = requireJob(aggregate.jobs, input.jobId, input.waveId);
    let wave = requireWave(aggregate.waves, input.waveId);
    if (job.status !== 'QUEUED' && job.status !== 'RESOLVING_CONTEXT') {
      throw new Error(`Discourse job ${job.id} cannot be prepared from ${job.status}.`);
    }
    if (!job.contextSnapshotId) {
      throw new Error('A discourse job requires an immutable context snapshot before preparation.');
    }
    const contextSnapshot = aggregate.contextSnapshots.find(
      (candidate) => candidate.id === job.contextSnapshotId
    );
    if (
      !contextSnapshot ||
      contextSnapshot.waveId !== wave.id ||
      !['READY', 'PARTIAL'].includes(contextSnapshot.status)
    ) {
      throw new Error('A discourse job requires a ready persisted context snapshot.');
    }
    if (wave.contextSnapshotId !== job.contextSnapshotId) {
      throw new Error('Discourse job context snapshot does not match its wave.');
    }
    if (wave.dispatchGate.status !== 'READY') {
      throw new Error('Discourse wave requires preview reconfirmation before preparation.');
    }
    if (wave.status === 'PLANNED') {
      wave = await this.discourse.updateWave({
        conversationId: input.conversationId,
        wave: {
          ...wave,
          recordRevision: wave.recordRevision + 1,
          status: 'SNAPSHOTTING'
        },
        expectedRevision: wave.recordRevision,
        clientOperationId: `${input.clientOperationId}:wave-snapshotting`
      });
    }

    const owner = {
      kind: 'DISCOURSE' as const,
      conversationId: input.conversationId,
      stableParticipantId: job.assignment.stableParticipantId
    };
    const sessionId = deterministicId('discourse-session', input.clientOperationId);
    const runId = deterministicId('discourse-run', input.clientOperationId);
    const promptArtifactId = deterministicId('runtime-prompt', runId);
    const outputArtifactId = deterministicId('runtime-output', runId);
    const diagnosticArtifactId = deterministicId('runtime-diagnostic', runId);
    const model = job.assignment.model;
    const session = await this.runtime.createSession({
      id: sessionId,
      owner,
      accessEpoch: createAgentSessionAccessEpoch({
        owner,
        sessionId,
        epoch: 1,
        providerId: job.assignment.providerId,
        model,
        executionContext: input.executionContext,
        createdAt: job.createdAt
      }),
      executionContext: input.executionContext,
      clientOperationId: `${input.clientOperationId}:session`,
      provider: job.assignment.providerId,
      role: 'PRIMARY',
      relationshipState: 'ROOT',
      status: 'NOT_MATERIALIZED',
      materialized: false,
      requestedSettings: input.executionContext.modelSettings
    });
    const run = await this.runtime.createRun({
      id: runId,
      owner,
      scope: {
        kind: 'DISCOURSE',
        conversationId: input.conversationId,
        waveId: wave.id,
        jobId: job.id,
        contextSnapshotId: job.contextSnapshotId,
        attemptId: job.attemptId
      },
      sessionId: session.id,
      sessionAccessEpoch: session.accessEpoch.epoch,
      purpose: purposeForJob(job),
      generationKey: job.generationKey,
      clientOperationId: `${input.clientOperationId}:run`,
      requestedSettings: input.executionContext.modelSettings,
      promptArtifactId,
      outputArtifactId,
      diagnosticArtifactId
    });
    await Promise.all([
      this.runtime.createArtifact({
        id: promptArtifactId,
        owner,
        runId,
        kind: 'PROMPT',
        clientOperationId: `${input.clientOperationId}:prompt`,
        content: input.prompt
      }),
      this.runtime.createArtifact({
        id: outputArtifactId,
        owner,
        runId,
        kind: 'OUTPUT',
        clientOperationId: `${input.clientOperationId}:output`,
        content: ''
      }),
      this.runtime.createArtifact({
        id: diagnosticArtifactId,
        owner,
        runId,
        kind: 'DIAGNOSTIC',
        clientOperationId: `${input.clientOperationId}:diagnostic`,
        content: ''
      })
    ]);

    let linkedJob = job;
    if (job.status === 'QUEUED') {
      linkedJob = await this.discourse.updateJob({
        conversationId: input.conversationId,
        expectedRevision: job.recordRevision,
        clientOperationId: `${input.clientOperationId}:link-job`,
        job: {
          ...job,
          contextSnapshotId: job.contextSnapshotId,
          sessionId: session.id,
          executionProfileHash: session.accessEpoch.executionProfileHash,
          runId: run.id,
          promptArtifactId,
          outputArtifactId,
          recordRevision: job.recordRevision + 1,
          status: 'RESOLVING_CONTEXT'
        }
      });
    } else {
      assertExistingJobLink(linkedJob, session, run);
    }
    const queueEntry = await this.runtime.enqueueRun(
      run.id,
      priorityForJob(job),
      `${input.clientOperationId}:enqueue`
    );
    if (wave.status === 'SNAPSHOTTING') {
      wave = await this.discourse.updateWave({
        conversationId: input.conversationId,
        expectedRevision: wave.recordRevision,
        clientOperationId: `${input.clientOperationId}:wave-queued`,
        wave: {
          ...wave,
          recordRevision: wave.recordRevision + 1,
          status: 'QUEUED'
        }
      });
    }
    void wave;
    return { session, run, queueEntry, job: linkedJob };
  }

  async cancelQueuedWave(
    input: CancelQueuedDiscourseWaveInput
  ): Promise<DiscourseResponseWaveRecord> {
    const aggregate = await this.discourse.getConversation(input.conversationId);
    let wave = requireWave(aggregate.waves, input.waveId);
    const jobs = aggregate.jobs.filter((job) => job.waveId === wave.id);
    if (wave.status === 'SETTLED') return wave;
    if (!['PLANNED', 'SNAPSHOTTING', 'QUEUED', 'STOP_REQUESTED'].includes(wave.status)) {
      throw new Error('Only an unsubmitted discourse wave can use queued cancellation.');
    }
    const runtimeSnapshot = await this.runtime.snapshot();
    for (const job of jobs) {
      if (['COMPLETED', 'FAILED', 'CANCELED', 'CONTEXT_STALE'].includes(job.status)) {
        continue;
      }
      if (job.status === 'QUEUED' && !job.runId) continue;
      if (!['RESOLVING_CONTEXT', 'CANCEL_REQUESTED'].includes(job.status) || !job.runId) {
        throw new Error('Queued cancellation found a job that may have reached the provider.');
      }
      const run = requireRuntimeRun(runtimeSnapshot.runs, job.runId);
      const entry = runtimeSnapshot.queueEntries.find(
        (candidate) => candidate.runId === run.id
      );
      if (
        !(
          (run.status === 'QUEUED' && run.delivery === 'NOT_SENT') ||
          (run.status === 'INTERRUPTED' && run.delivery === 'NOT_DELIVERED')
        ) ||
        !entry ||
        !['QUEUED', 'CANCELED'].includes(entry.status)
      ) {
        throw new Error('Queued cancellation cannot prove that provider delivery never began.');
      }
    }
    if (wave.status !== 'STOP_REQUESTED') {
      wave = await this.discourse.updateWave({
        conversationId: input.conversationId,
        expectedRevision: wave.recordRevision,
        clientOperationId: `${input.clientOperationId}:wave-stop-intent`,
        wave: {
          ...wave,
          recordRevision: wave.recordRevision + 1,
          status: 'STOP_REQUESTED'
        }
      });
    }
    for (const originalJob of jobs) {
      if (['COMPLETED', 'FAILED', 'CANCELED', 'CONTEXT_STALE'].includes(originalJob.status)) {
        continue;
      }
      let job = originalJob;
      if (job.status === 'QUEUED') {
        await this.discourse.updateJob({
          conversationId: input.conversationId,
          expectedRevision: job.recordRevision,
          clientOperationId: `${input.clientOperationId}:job-canceled:${job.id}`,
          job: {
            ...job,
            recordRevision: job.recordRevision + 1,
            status: 'CANCELED',
            finishedAt: this.now()
          }
        });
        continue;
      }
      if (job.status === 'RESOLVING_CONTEXT') {
        job = await this.discourse.updateJob({
          conversationId: input.conversationId,
          expectedRevision: job.recordRevision,
          clientOperationId: `${input.clientOperationId}:job-stop-intent:${job.id}`,
          job: {
            ...job,
            recordRevision: job.recordRevision + 1,
            status: 'CANCEL_REQUESTED'
          }
        });
      }
      let run = requireRuntimeRun(
        (await this.runtime.snapshot()).runs,
        job.runId!
      );
      if (run.status === 'QUEUED' && run.delivery === 'NOT_SENT') {
        run = await this.runtime.updateRun(
          run.id,
          run.recordRevision,
          {
            status: 'INTERRUPTED',
            delivery: 'NOT_DELIVERED',
            recoveryState: 'NONE',
            terminalReason: input.reason,
            lastEventAt: this.now(),
            endedAt: this.now()
          },
          `${input.clientOperationId}:runtime-canceled:${job.id}`
        );
      }
      const entry = (await this.runtime.snapshot()).queueEntries.find(
        (candidate) => candidate.runId === run.id
      );
      if (!entry || !['QUEUED', 'CANCELED'].includes(entry.status)) {
        throw new Error('Queued cancellation lost its durable scheduler entry.');
      }
      if (entry.status === 'QUEUED') {
        await this.runtime.cancelQueueEntry(
          entry.id,
          entry.recordRevision,
          input.reason,
          `${input.clientOperationId}:queue-canceled:${job.id}`
        );
      }
      await this.discourse.updateJob({
        conversationId: input.conversationId,
        expectedRevision: job.recordRevision,
        clientOperationId: `${input.clientOperationId}:job-canceled:${job.id}`,
        job: {
          ...job,
          recordRevision: job.recordRevision + 1,
          status: 'CANCELED',
          finishedAt: this.now()
        }
      });
    }
    await this.reconcileWaveFromChildren(
      input.conversationId,
      input.waveId,
      input.clientOperationId
    );
    return requireWave(
      (await this.discourse.getConversation(input.conversationId)).waves,
      input.waveId
    );
  }

  async stopActiveWave(
    input: StopActiveDiscourseWaveInput,
    provider: AgentScopedTurnProvider
  ): Promise<DiscourseResponseWaveRecord> {
    const aggregate = await this.discourse.getConversation(input.conversationId);
    let wave = requireWave(aggregate.waves, input.waveId);
    const jobs = aggregate.jobs.filter((job) => job.waveId === wave.id);
    if (wave.status === 'SETTLED') return wave;
    if (
      !['RUNNING', 'STOP_REQUESTED', 'STOPPING', 'RECOVERY_REQUIRED'].includes(
        wave.status
      )
    ) {
      throw new Error('Only a running discourse wave can be interrupted.');
    }
    const runtimeSnapshot = await this.runtime.snapshot();
    for (const job of jobs) {
      if (['COMPLETED', 'FAILED', 'CANCELED', 'CONTEXT_STALE'].includes(job.status)) {
        continue;
      }
      if (
        !['RUNNING', 'CANCEL_REQUESTED', 'RECOVERY_REQUIRED'].includes(job.status) ||
        !job.runId
      ) {
        throw new Error('Active wave interruption found an unsafe job checkpoint.');
      }
      const run = requireRuntimeRun(runtimeSnapshot.runs, job.runId);
      const recoverableStop =
        run.status === 'RECOVERY_REQUIRED' &&
        (run.delivery === 'AMBIGUOUS' ||
          run.delivery === 'NOT_DELIVERED' ||
          (run.delivery === 'ACKNOWLEDGED' &&
            ['NOT_DELIVERED', 'AMBIGUOUS'].includes(run.interruptDelivery ?? '')));
      if (
        !(
          (run.status === 'RUNNING' && run.delivery === 'ACKNOWLEDGED') ||
          (run.status === 'INTERRUPTING' &&
            ['SENDING', 'ACKNOWLEDGED'].includes(run.interruptDelivery ?? '')) ||
          recoverableStop
        ) ||
        (!recoverableStop && !run.providerTurnId)
      ) {
        throw new Error('Active wave interruption cannot prove its provider turn identity.');
      }
    }
    if (wave.status === 'RUNNING') {
      wave = await this.discourse.updateWave({
        conversationId: input.conversationId,
        expectedRevision: wave.recordRevision,
        clientOperationId: `${input.clientOperationId}:wave-stop-intent`,
        wave: {
          ...wave,
          recordRevision: wave.recordRevision + 1,
          status: 'STOP_REQUESTED'
        }
      });
    } else if (wave.status === 'RECOVERY_REQUIRED') {
      wave = await this.discourse.updateWave({
        conversationId: input.conversationId,
        expectedRevision: wave.recordRevision,
        clientOperationId: `${input.clientOperationId}:wave-recovery-stop`,
        wave: {
          ...wave,
          recordRevision: wave.recordRevision + 1,
          status: 'STOPPING'
        }
      });
    }
    let recoveryRequired = false;
    for (const originalJob of jobs) {
      if (['COMPLETED', 'FAILED', 'CANCELED', 'CONTEXT_STALE'].includes(originalJob.status)) {
        continue;
      }
      let job = originalJob;
      if (job.status === 'RUNNING') {
        job = await this.discourse.updateJob({
          conversationId: input.conversationId,
          expectedRevision: job.recordRevision,
          clientOperationId: `${input.clientOperationId}:job-stop-intent:${job.id}`,
          job: {
            ...job,
            recordRevision: job.recordRevision + 1,
            status: 'CANCEL_REQUESTED'
          }
        });
      }
      let runtimeNow = await this.runtime.snapshot();
      let run = requireRuntimeRun(runtimeNow.runs, job.runId!);
      let session = requireRuntimeSession(runtimeNow.sessions, run.sessionId);
      let interruptIssuedByThisCall = false;
      if (run.status === 'RUNNING') {
        run = await this.runtime.updateRun(
          run.id,
          run.recordRevision,
          {
            status: 'INTERRUPTING',
            interruptDelivery: 'SENDING',
            stopRequestedAt: this.now(),
            terminalReason: input.reason,
            lastEventAt: this.now()
          },
          `${input.clientOperationId}:runtime-stop-intent:${job.id}`
        );
        interruptIssuedByThisCall = true;
      } else if (run.status === 'RECOVERY_REQUIRED' || job.status === 'RECOVERY_REQUIRED') {
        if (run.status !== 'RECOVERY_REQUIRED' || job.status !== 'RECOVERY_REQUIRED') {
          throw new Error('Recovery stop found mismatched runtime and curated checkpoints.');
        }
        if (run.delivery === 'NOT_DELIVERED') {
          run = await this.runtime.updateRun(
            run.id,
            run.recordRevision,
            {
              status: 'INTERRUPTED',
              recoveryState: 'NONE',
              terminalReason: input.reason,
              lastEventAt: this.now(),
              endedAt: this.now()
            },
            `${input.clientOperationId}:runtime-recovery-canceled:${job.id}`
          );
          await this.settleRuntimeAfterTerminal(
            session,
            run,
            run.endedAt!,
            `${input.clientOperationId}:runtime-recovery-settled:${job.id}`
          );
        }
        const entry = (await this.runtime.snapshot()).queueEntries.find(
          (candidate) => candidate.runId === run.id
        );
        if (entry?.status === 'LEASED') {
          await this.runtime.settleQueueEntry(
            entry.id,
            entry.recordRevision,
            `${input.clientOperationId}:queue-recovery-stopped:${job.id}`
          );
        } else if (entry?.status === 'QUEUED' && run.delivery === 'NOT_DELIVERED') {
          await this.runtime.cancelQueueEntry(
            entry.id,
            entry.recordRevision,
            input.reason,
            `${input.clientOperationId}:queue-recovery-canceled:${job.id}`
          );
        } else if (!entry || !['SETTLED', 'CANCELED'].includes(entry.status)) {
          throw new Error('Recovery stop lost its durable scheduler entry.');
        }
        await this.discourse.updateJob({
          conversationId: input.conversationId,
          expectedRevision: job.recordRevision,
          clientOperationId: `${input.clientOperationId}:job-recovery-canceled:${job.id}`,
          job: {
            ...job,
            recordRevision: job.recordRevision + 1,
            status: 'CANCELED',
            finishedAt: this.now()
          }
        });
        continue;
      } else if (run.interruptDelivery === 'ACKNOWLEDGED') {
        continue;
      } else if (
        run.status === 'INTERRUPTING' &&
        run.interruptDelivery === 'SENDING' &&
        !interruptIssuedByThisCall
      ) {
        run = await this.runtime.updateRun(
          run.id,
          run.recordRevision,
          {
            status: 'RECOVERY_REQUIRED',
            interruptDelivery: 'AMBIGUOUS',
            recoveryState: 'REQUIRES_USER_ACTION',
            terminalReason:
              'A durable interrupt intent has no authoritative delivery result.',
            lastEventAt: this.now()
          },
          `${input.clientOperationId}:runtime-existing-stop-recovery:${job.id}`
        );
        const latestJob = requireJob(
          (await this.discourse.getConversation(input.conversationId)).jobs,
          job.id,
          job.waveId
        );
        if (latestJob.status === 'CANCEL_REQUESTED') {
          await this.discourse.updateJob({
            conversationId: input.conversationId,
            expectedRevision: latestJob.recordRevision,
            clientOperationId: `${input.clientOperationId}:job-existing-stop-recovery:${job.id}`,
            job: {
              ...latestJob,
              recordRevision: latestJob.recordRevision + 1,
              status: 'RECOVERY_REQUIRED',
              error: {
                code: 'DELIVERY_AMBIGUOUS',
                message:
                  'The provider interruption has no authoritative delivery result.',
                category: 'DELIVERY',
                retryable: false
              }
            }
          });
        }
        recoveryRequired = true;
        continue;
      }
      try {
        if (!provider.interruptScopedTurn) {
          throw new AgentScopedMutationError(
            'NOT_DELIVERED',
            'The scoped provider does not support interruption.'
          );
        }
        await provider.interruptScopedTurn({ session, run });
        const latest = (await this.runtime.getRun(run.id)) ?? run;
        if (isRuntimeTerminal(latest.status)) continue;
        if (latest.status === 'INTERRUPTING' && latest.interruptDelivery === 'SENDING') {
          await this.runtime.updateRun(
            latest.id,
            latest.recordRevision,
            { interruptDelivery: 'ACKNOWLEDGED', lastEventAt: this.now() },
            `${input.clientOperationId}:runtime-stop-ack:${job.id}`
          );
        }
      } catch (error) {
        const latest = (await this.runtime.getRun(run.id)) ?? run;
        if (isRuntimeTerminal(latest.status)) continue;
        const interruptDelivery =
          error instanceof AgentScopedMutationError ? error.delivery : 'AMBIGUOUS';
        await this.runtime.updateRun(
          latest.id,
          latest.recordRevision,
          {
            status: 'RECOVERY_REQUIRED',
            interruptDelivery,
            recoveryState: 'REQUIRES_USER_ACTION',
            terminalReason: error instanceof Error ? error.message : String(error),
            lastEventAt: this.now()
          },
          `${input.clientOperationId}:runtime-stop-recovery:${job.id}`
        );
        const latestJob = requireJob(
          (await this.discourse.getConversation(input.conversationId)).jobs,
          job.id,
          job.waveId
        );
        if (latestJob.status === 'CANCEL_REQUESTED') {
          await this.discourse.updateJob({
            conversationId: input.conversationId,
            expectedRevision: latestJob.recordRevision,
            clientOperationId: `${input.clientOperationId}:job-stop-recovery:${job.id}`,
            job: {
              ...latestJob,
              recordRevision: latestJob.recordRevision + 1,
              status: 'RECOVERY_REQUIRED',
              error: {
                code: 'DELIVERY_AMBIGUOUS',
                message: error instanceof Error ? error.message : String(error),
                category: 'DELIVERY',
                retryable: false
              }
            }
          });
        }
        recoveryRequired = true;
      }
      void session;
    }
    wave = requireWave(
      (await this.discourse.getConversation(input.conversationId)).waves,
      input.waveId
    );
    if (wave.status === 'SETTLED') return wave;
    if (recoveryRequired) {
      await this.markWaveRecovery(
        input.conversationId,
        wave,
        input.clientOperationId
      );
    } else if (wave.status === 'STOP_REQUESTED') {
      await this.discourse.updateWave({
        conversationId: input.conversationId,
        expectedRevision: wave.recordRevision,
        clientOperationId: `${input.clientOperationId}:wave-stopping`,
        wave: {
          ...wave,
          recordRevision: wave.recordRevision + 1,
          status: 'STOPPING'
        }
      });
    }
    await this.reconcileWaveFromChildren(
      input.conversationId,
      input.waveId,
      input.clientOperationId
    );
    return requireWave(
      (await this.discourse.getConversation(input.conversationId)).waves,
      input.waveId
    );
  }

  setConversationArchived(input: {
    conversationId: string;
    archived: boolean;
    expectedRevision: number;
    clientOperationId: string;
  }) {
    return this.withConversationMutation(input.conversationId, async () => {
      if (input.archived) {
        await this.assertConversationRuntimeSettled(input.conversationId);
      }
      return this.discourse.setConversationArchived(input);
    });
  }

  deleteConversation(input: {
    conversationId: string;
    expectedRevision: number;
    clientOperationId: string;
  }) {
    return this.withConversationMutation(input.conversationId, async () => {
      const existingTombstone = await this.discourse.getConversationTombstone(
        input.conversationId
      );
      if (!existingTombstone) {
        await this.assertConversationRuntimeSettled(input.conversationId);
      }
      const tombstone = await this.discourse.deleteConversation(input);
      await this.runtime.purgeDiscourseConversation(input.conversationId);
      return tombstone;
    });
  }

  private withConversationMutation<T>(
    conversationId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const prior = this.conversationMutations.get(conversationId) ?? Promise.resolve();
    const queued = prior.catch(() => undefined).then(operation);
    const settled = queued.then(
      () => undefined,
      () => undefined
    );
    this.conversationMutations.set(conversationId, settled);
    void settled.finally(() => {
      if (this.conversationMutations.get(conversationId) === settled) {
        this.conversationMutations.delete(conversationId);
      }
    });
    return queued;
  }

  async dispatchLeasedJob(
    queueEntryId: string,
    provider: AgentScopedTurnProvider,
    clientOperationId: string
  ): Promise<AgentRuntimeRunRecord> {
    const runtimeSnapshot = await this.runtime.snapshot();
    const entry = runtimeSnapshot.queueEntries.find((candidate) => candidate.id === queueEntryId);
    if (!entry || entry.status !== 'LEASED' || entry.scope.kind !== 'DISCOURSE') {
      throw new Error('Only a leased discourse queue entry can be dispatched.');
    }
    let run = requireRuntimeRun(runtimeSnapshot.runs, entry.runId);
    let session = requireRuntimeSession(runtimeSnapshot.sessions, run.sessionId);
    const aggregate = await this.discourse.getConversation(entry.scope.conversationId);
    let job = requireJob(aggregate.jobs, entry.scope.jobId, entry.scope.waveId);
    let wave = requireWave(aggregate.waves, entry.scope.waveId);
    if (run.status !== 'QUEUED' || job.status !== 'RESOLVING_CONTEXT') {
      throw new Error('Discourse dispatch checkpoint is not safe to submit.');
    }
    if (wave.status === 'QUEUED') {
      wave = await this.discourse.updateWave({
        conversationId: entry.scope.conversationId,
        expectedRevision: wave.recordRevision,
        clientOperationId: `${clientOperationId}:wave-running`,
        wave: {
          ...wave,
          recordRevision: wave.recordRevision + 1,
          status: 'RUNNING',
          phase: phaseForJob(job),
          startedAt: wave.startedAt ?? this.now()
        }
      });
    }
    run = await this.runtime.updateRun(
      run.id,
      run.recordRevision,
      { status: 'STARTING', delivery: 'SENDING', startedAt: this.now(), lastEventAt: this.now() },
      `${clientOperationId}:runtime-starting`
    );
    job = await this.discourse.updateJob({
      conversationId: entry.scope.conversationId,
      expectedRevision: job.recordRevision,
      clientOperationId: `${clientOperationId}:job-starting`,
      job: {
        ...job,
        recordRevision: job.recordRevision + 1,
        status: 'STARTING',
        delivery: 'SENDING',
        startedAt: job.startedAt ?? this.now()
      }
    });
    const executionContext = executionContextFromSession(session, run);
    const prompt = await this.runtime.readArtifact(run.promptArtifactId);
    let started: StartedScopedAgentTurn;
    try {
      started = await provider.startScopedTurn({ session, run, executionContext, prompt });
    } catch (error) {
      const latestRuntime = await this.runtime.snapshot();
      run = requireRuntimeRun(latestRuntime.runs, run.id);
      if (run.status === 'RUNNING' && run.delivery === 'ACKNOWLEDGED') {
        return this.reconcileStartedProviderTurn(entry, undefined, clientOperationId);
      }
      if (isRuntimeTerminal(run.status)) {
        return run;
      }
      const latestAggregate = await this.discourse.getConversation(
        entry.scope.conversationId
      );
      job = requireJob(latestAggregate.jobs, entry.scope.jobId, entry.scope.waveId);
      wave = requireWave(latestAggregate.waves, entry.scope.waveId);
      const delivery =
        error instanceof AgentScopedMutationError ? error.delivery : 'AMBIGUOUS';
      const structured = providerStartError(error, delivery);
      const terminal = delivery === 'NOT_DELIVERED';
      run = await this.runtime.updateRun(
        run.id,
        run.recordRevision,
        {
          status: terminal ? 'FAILED' : 'RECOVERY_REQUIRED',
          delivery,
          recoveryState: terminal ? 'NONE' : 'REQUIRES_USER_ACTION',
          terminalReason: structured.message,
          lastEventAt: this.now(),
          ...(terminal ? { endedAt: this.now() } : {})
        },
        `${clientOperationId}:runtime-start-failed`
      );
      job = await this.discourse.updateJob({
        conversationId: entry.scope.conversationId,
        expectedRevision: job.recordRevision,
        clientOperationId: `${clientOperationId}:job-start-failed`,
        job: {
          ...job,
          recordRevision: job.recordRevision + 1,
          status: terminal ? 'FAILED' : 'RECOVERY_REQUIRED',
          delivery,
          error: structured,
          ...(terminal ? { finishedAt: this.now() } : {})
        }
      });
      if (terminal) {
        const latestEntry = (await this.runtime.snapshot()).queueEntries.find(
          (candidate) => candidate.id === entry.id
        );
        if (!latestEntry || latestEntry.status !== 'LEASED') {
          throw new Error('Discourse queue lease disappeared during provider start failure.');
        }
        await this.runtime.settleQueueEntry(
          latestEntry.id,
          latestEntry.recordRevision,
          `${clientOperationId}:settle-not-delivered`
        );
        await this.reconcileWaveFromChildren(entry.scope.conversationId, wave.id, clientOperationId);
      } else {
        await this.markWaveRecovery(entry.scope.conversationId, wave, clientOperationId);
      }
      throw error;
    }
    return this.reconcileStartedProviderTurn(entry, started, clientOperationId);
  }

  async rejectLeasedJobForStaleContext(
    queueEntryId: string,
    clientOperationId: string
  ): Promise<DiscourseAgentJobRecord> {
    const runtimeSnapshot = await this.runtime.snapshot();
    const entry = runtimeSnapshot.queueEntries.find(
      (candidate) => candidate.id === queueEntryId
    );
    if (!entry || entry.status !== 'LEASED' || entry.scope.kind !== 'DISCOURSE') {
      throw new Error('Only a leased discourse job can be rejected for stale context.');
    }
    let run = requireRuntimeRun(runtimeSnapshot.runs, entry.runId);
    if (run.status !== 'QUEUED' || run.delivery !== 'NOT_SENT') {
      throw new Error('Stale context rejection must happen before provider delivery.');
    }
    const aggregate = await this.discourse.getConversation(entry.scope.conversationId);
    const job = requireJob(aggregate.jobs, entry.scope.jobId, entry.scope.waveId);
    if (job.status !== 'RESOLVING_CONTEXT') {
      throw new Error('Stale context rejection found an invalid discourse job checkpoint.');
    }
    const at = this.now();
    run = await this.runtime.updateRun(
      run.id,
      run.recordRevision,
      {
        status: 'FAILED',
        delivery: 'NOT_DELIVERED',
        recoveryState: 'NONE',
        terminalReason: 'Selected context changed before provider dispatch.',
        lastEventAt: at,
        endedAt: at
      },
      `${clientOperationId}:runtime-stale`
    );
    const stale = await this.discourse.updateJob({
      conversationId: entry.scope.conversationId,
      expectedRevision: job.recordRevision,
      clientOperationId: `${clientOperationId}:job-stale`,
      job: {
        ...job,
        recordRevision: job.recordRevision + 1,
        status: 'CONTEXT_STALE',
        freshnessAtCompletion: 'CHANGED_DURING_JOB',
        error: {
          code: 'CONTEXT_CHANGED',
          message: 'Selected context changed before the response started.',
          category: 'CONTEXT',
          retryable: true
        },
        finishedAt: at
      }
    });
    await this.runtime.settleQueueEntry(
      entry.id,
      entry.recordRevision,
      `${clientOperationId}:queue-stale`
    );
    await this.reconcileWaveFromChildren(
      entry.scope.conversationId,
      entry.scope.waveId,
      clientOperationId
    );
    void run;
    return stale;
  }

  private async persistSuccessfulTerminal(
    input: IngestDiscourseContributionInput,
    options: { persistOutput?: boolean } = {}
  ) {
    requireTimestamp(input.completedAt);
    const runtimeSnapshot = await this.runtime.snapshot();
    let run = requireRuntimeRun(runtimeSnapshot.runs, input.runId);
    if (run.scope.kind !== 'DISCOURSE' || run.providerTurnId !== input.providerTurnId) {
      throw new Error('Provider terminal does not match its durable discourse run.');
    }
    const scope = run.scope;
    const session = requireRuntimeSession(runtimeSnapshot.sessions, run.sessionId);
    const outputArtifact = await this.runtime.getArtifact(run.outputArtifactId);
    if (!outputArtifact) throw new Error('Discourse runtime output artifact is missing.');
    if (
      options.persistOutput !== false &&
      outputArtifact.contentSha256 !== sha256(input.body)
    ) {
      await this.runtime.updateArtifact({
        artifactId: outputArtifact.id,
        expectedRevision: outputArtifact.recordRevision,
        clientOperationId: `${input.clientOperationId}:output`,
        content: input.body
      });
    }
    if (run.status !== 'COMPLETED') {
      run = await this.runtime.updateRun(
        run.id,
        run.recordRevision,
        {
          status: 'COMPLETED',
          delivery: 'TERMINAL',
          ...(run.interruptDelivery ? { interruptDelivery: 'TERMINAL' } : {}),
          recoveryState: 'NONE',
          providerTerminalSource: input.providerTerminalSource,
          contextFreshnessAtCompletion: input.freshnessAtCompletion,
          lastEventAt: input.completedAt,
          endedAt: input.completedAt
        },
        `${input.clientOperationId}:runtime-terminal`
      );
    } else if (
      run.contextFreshnessAtCompletion !== input.freshnessAtCompletion ||
      !run.providerTerminalSource
    ) {
      run = await this.runtime.updateRun(
        run.id,
        run.recordRevision,
        {
          contextFreshnessAtCompletion: input.freshnessAtCompletion,
          providerTerminalSource: run.providerTerminalSource ?? input.providerTerminalSource,
          lastEventAt: run.lastEventAt ?? input.completedAt,
          endedAt: run.endedAt ?? input.completedAt
        },
        `${input.clientOperationId}:runtime-provenance`
      );
    }
    const tombstone = await this.discourse.getConversationTombstone(scope.conversationId);
    if (tombstone) {
      await this.settleRuntimeAfterTerminal(session, run, input.completedAt, input.clientOperationId);
    }
    return { run, session, scope, ...(tombstone ? { tombstone } : {}) };
  }

  private async failInvalidResult(
    job: DiscourseAgentJobRecord,
    input: IngestDiscourseContributionInput,
    cause: unknown
  ): Promise<{ kind: 'INVALID_RESULT'; job: DiscourseAgentJobRecord; error: StructuredDiscourseError }> {
    const error: StructuredDiscourseError = {
      code: 'INVALID_RESULT',
      message: 'The agent returned a response that did not match the required structured format.',
      category: 'VALIDATION',
      retryable: true,
      detail: cause instanceof Error ? cause.message : String(cause)
    };
    if (['FAILED', 'CANCELED', 'CONTEXT_STALE'].includes(job.status)) {
      return { kind: 'INVALID_RESULT', job, error: job.error ?? error };
    }
    const canceled = job.status === 'CANCEL_REQUESTED';
    const failed = await this.discourse.updateJob({
      conversationId: job.conversationId,
      expectedRevision: job.recordRevision,
      clientOperationId: `${input.clientOperationId}:invalid-result`,
      job: {
        ...job,
        recordRevision: job.recordRevision + 1,
        status: canceled ? 'CANCELED' : 'FAILED',
        delivery: 'TERMINAL',
        ...(canceled ? {} : { error }),
        finishedAt: input.completedAt
      }
    });
    return { kind: 'INVALID_RESULT', job: failed, error };
  }

  private async failTerminalResult(
    job: DiscourseAgentJobRecord,
    input: IngestDiscourseContributionInput,
    error: StructuredDiscourseError
  ): Promise<DiscourseAgentJobRecord> {
    if (['FAILED', 'CANCELED', 'CONTEXT_STALE'].includes(job.status)) return job;
    return this.discourse.updateJob({
      conversationId: job.conversationId,
      expectedRevision: job.recordRevision,
      clientOperationId: `${input.clientOperationId}:terminal-result-failed`,
      job: {
        ...job,
        recordRevision: job.recordRevision + 1,
        status: 'FAILED',
        delivery: 'TERMINAL',
        error,
        finishedAt: input.completedAt
      }
    });
  }

  private async terminalBodyError(
    run: AgentRuntimeRunRecord,
    body: string
  ): Promise<StructuredDiscourseError | undefined> {
    const bytes = Buffer.byteLength(body, 'utf8');
    if (!body.trim()) {
      return {
        code: 'OUTPUT_MISSING',
        message: 'The agent completed without a usable response.',
        category: 'VALIDATION',
        retryable: true
      };
    }
    if (bytes > DISCOURSE_LIMITS.maxAgentContributionBytes) {
      return {
        code: 'INVALID_RESULT',
        message: 'The agent response exceeded the bounded contribution limit.',
        category: 'VALIDATION',
        retryable: true,
        detail: `${bytes} bytes exceeds ${DISCOURSE_LIMITS.maxAgentContributionBytes} bytes.`
      };
    }
    if (run.scope.kind !== 'DISCOURSE') return undefined;
    const snapshot = await this.runtime.snapshot();
    let cumulativeBytes = 0;
    for (const candidate of snapshot.runs) {
      if (
        candidate.scope.kind !== 'DISCOURSE' ||
        candidate.scope.conversationId !== run.scope.conversationId ||
        candidate.scope.waveId !== run.scope.waveId ||
        (candidate.id !== run.id && candidate.status !== 'COMPLETED')
      ) {
        continue;
      }
      cumulativeBytes += Buffer.byteLength(
        candidate.id === run.id
          ? body
          : await this.runtime.readArtifact(candidate.outputArtifactId),
        'utf8'
      );
    }
    if (cumulativeBytes > DISCOURSE_LIMITS.maxWaveOutputBytes) {
      return {
        code: 'INVALID_RESULT',
        message: 'The response wave exceeded its bounded cumulative output limit.',
        category: 'VALIDATION',
        retryable: true,
        detail: `${cumulativeBytes} bytes exceeds ${DISCOURSE_LIMITS.maxWaveOutputBytes} bytes.`
      };
    }
    return undefined;
  }

  async ingestContribution(
    input: IngestDiscourseContributionInput
  ): Promise<DiscourseTerminalIngestionResult> {
    const inputBytes = Buffer.byteLength(input.body, 'utf8');
    const terminal = await this.persistSuccessfulTerminal(input, {
      persistOutput: inputBytes <= DISCOURSE_LIMITS.maxAgentContributionBytes
    });
    const { run, session, scope } = terminal;
    if (terminal.tombstone) {
      return { kind: 'CONVERSATION_DELETED', tombstone: terminal.tombstone };
    }
    const aggregate = await this.discourse.getConversation(scope.conversationId);
    let job = requireJob(aggregate.jobs, scope.jobId, scope.waveId);
    if (!['ANSWER', 'TARGETED_REPLY', 'SYNTHESIZE'].includes(job.role)) {
      throw new Error('This terminal ingestion path accepts contribution-producing jobs only.');
    }
    if (['FAILED', 'CANCELED', 'CONTEXT_STALE'].includes(job.status)) {
      await this.settleRuntimeAfterTerminal(
        session,
        run,
        input.completedAt,
        input.clientOperationId
      );
      return { kind: 'IGNORED_TERMINAL', job };
    }
    const bodyError = await this.terminalBodyError(run, input.body);
    if (bodyError) {
      job = await this.failTerminalResult(job, input, bodyError);
      await this.settleRuntimeAfterTerminal(
        session,
        run,
        input.completedAt,
        input.clientOperationId
      );
      await this.reconcileWaveFromChildren(
        scope.conversationId,
        scope.waveId,
        input.clientOperationId
      );
      return { kind: 'INVALID_RESULT', job, error: bodyError };
    }
    const existingOutputId =
      job.status === 'COMPLETED' && job.result?.kind === 'CONTRIBUTION'
        ? job.result.outputMessageId
        : undefined;
    const message = existingOutputId
      ? requireMessage(
          (await this.discourse.listMessages({
            conversationId: scope.conversationId,
            limit: 100
          })).messages,
          existingOutputId
        )
      : await this.discourse.appendAgentMessage({
          conversationId: scope.conversationId,
          body: input.body,
          stableParticipantId: job.assignment.stableParticipantId,
          participantRevisionId: job.assignment.participantRevisionId,
          displayNameSnapshot: job.assignment.displayNameSnapshot,
          waveId: job.waveId,
          jobId: job.id,
          contextSnapshotId: job.contextSnapshotId,
          sourceMessageIds: job.visibleMessageIds,
          freshnessAtCompletion: input.freshnessAtCompletion,
          clientOperationId: `${input.clientOperationId}:message`
        });
    if (job.status !== 'COMPLETED') {
      job = await this.discourse.updateJob({
        conversationId: scope.conversationId,
        expectedRevision: job.recordRevision,
        clientOperationId: `${input.clientOperationId}:job-terminal`,
        job: {
          ...job,
          recordRevision: job.recordRevision + 1,
          status: 'COMPLETED',
          delivery: 'TERMINAL',
          freshnessAtCompletion: input.freshnessAtCompletion,
          result: { kind: 'CONTRIBUTION', outputMessageId: message.id },
          finishedAt: input.completedAt
        }
      });
    }
    await this.settleRuntimeAfterTerminal(
      session,
      run,
      input.completedAt,
      input.clientOperationId
    );
    await this.reconcileWaveFromChildren(
      scope.conversationId,
      scope.waveId,
      input.clientOperationId
    );
    return { kind: 'CURATED', message };
  }

  async ingestReview(
    input: IngestDiscourseContributionInput
  ): Promise<DiscourseReviewIngestionResult> {
    const inputBytes = Buffer.byteLength(input.body, 'utf8');
    const terminal = await this.persistSuccessfulTerminal(input, {
      persistOutput: inputBytes <= DISCOURSE_LIMITS.maxAgentContributionBytes
    });
    const { run, session, scope } = terminal;
    if (terminal.tombstone) {
      return { kind: 'CONVERSATION_DELETED', tombstone: terminal.tombstone };
    }
    const aggregate = await this.discourse.getConversation(scope.conversationId);
    let job = requireJob(aggregate.jobs, scope.jobId, scope.waveId);
    if (job.role !== 'CRITIQUE' || job.targetMessageIds.length !== 1) {
      throw new Error('This terminal ingestion path accepts one-target review jobs only.');
    }
    if (['FAILED', 'CANCELED', 'CONTEXT_STALE'].includes(job.status)) {
      await this.settleRuntimeAfterTerminal(
        session,
        run,
        input.completedAt,
        input.clientOperationId
      );
      return { kind: 'IGNORED_TERMINAL', job };
    }
    const bodyError = await this.terminalBodyError(run, input.body);
    if (bodyError) {
      job = await this.failTerminalResult(job, input, bodyError);
      await this.settleRuntimeAfterTerminal(session, run, input.completedAt, input.clientOperationId);
      await this.reconcileWaveFromChildren(scope.conversationId, scope.waveId, input.clientOperationId);
      return { kind: 'INVALID_RESULT', job, error: bodyError };
    }
    let parsed: ReturnType<typeof parseDiscourseReview>;
    try {
      parsed = parseDiscourseReview(input.body);
      if (parsed.reviewedScope !== job.targetMessageIds[0]) {
        throw new Error('Discourse review did not identify its exact target message.');
      }
    } catch (error) {
      const invalid = await this.failInvalidResult(job, input, error);
      await this.settleRuntimeAfterTerminal(session, run, input.completedAt, input.clientOperationId);
      await this.reconcileWaveFromChildren(scope.conversationId, scope.waveId, input.clientOperationId);
      return invalid;
    }
    const priorConcerns = aggregate.concerns.filter(
      (concern) => concern.waveId === scope.waveId
    );
    const concerns: DiscourseConcernRecord[] = [];
    parsed.concerns.forEach((concern, index) => {
      const duplicate = [...priorConcerns, ...concerns].find(
        (candidate) => concernFingerprint(candidate) === concernFingerprint(concern)
      );
      concerns.push({
        id: deterministicId('discourse-concern', `${job.id}:${index}:${job.targetMessageIds[0]}`),
        conversationId: scope.conversationId,
        waveId: scope.waveId,
        reviewJobId: job.id,
        reviewerParticipantRevisionId: job.assignment.participantRevisionId,
        targetMessageId: job.targetMessageIds[0]!,
        targetClaim: concern.targetClaim,
        category: concern.category,
        severity: concern.severity,
        confidence: concern.confidence,
        evidenceStatus: concern.evidenceStatus,
        reason: concern.reason,
        evidence: concern.evidence,
        suggestedResolution: concern.suggestedResolution,
        requiredAccessAvailable: parsed.requiredAccessAvailable,
        ...(duplicate ? { redundantOfConcernId: duplicate.id } : {}),
        recordRevision: 1,
        createdAt: input.completedAt
      });
    });
    if (job.status !== 'COMPLETED') {
      job = await this.discourse.completeReviewJob({
        conversationId: scope.conversationId,
        expectedRevision: job.recordRevision,
        clientOperationId: `${input.clientOperationId}:review-terminal`,
        concerns,
        job: {
          ...job,
          recordRevision: job.recordRevision + 1,
          status: 'COMPLETED',
          delivery: 'TERMINAL',
          freshnessAtCompletion: input.freshnessAtCompletion,
          result: {
            kind: 'REVIEW',
            outcome: parsed.outcome,
            reviewedScope: parsed.reviewedScope,
            limitations: parsed.limitations,
            requiredAccessAvailable: parsed.requiredAccessAvailable,
            concernIds: concerns.map((concern) => concern.id)
          },
          finishedAt: input.completedAt
        }
      });
    }
    await this.settleRuntimeAfterTerminal(session, run, input.completedAt, input.clientOperationId);
    await this.reconcileWaveFromChildren(scope.conversationId, scope.waveId, input.clientOperationId);
    return { kind: 'REVIEW', job, concerns };
  }

  async ingestCorrection(
    input: IngestDiscourseContributionInput
  ): Promise<DiscourseCorrectionIngestionResult> {
    const inputBytes = Buffer.byteLength(input.body, 'utf8');
    const terminal = await this.persistSuccessfulTerminal(input, {
      persistOutput: inputBytes <= DISCOURSE_LIMITS.maxAgentContributionBytes
    });
    const { run, session, scope } = terminal;
    if (terminal.tombstone) {
      return { kind: 'CONVERSATION_DELETED', tombstone: terminal.tombstone };
    }
    const aggregate = await this.discourse.getConversation(scope.conversationId);
    let job = requireJob(aggregate.jobs, scope.jobId, scope.waveId);
    if (job.role !== 'CORRECT') {
      throw new Error('This terminal ingestion path accepts correction jobs only.');
    }
    if (['FAILED', 'CANCELED', 'CONTEXT_STALE'].includes(job.status)) {
      await this.settleRuntimeAfterTerminal(
        session,
        run,
        input.completedAt,
        input.clientOperationId
      );
      return { kind: 'IGNORED_TERMINAL', job };
    }
    const bodyError = await this.terminalBodyError(run, input.body);
    if (bodyError) {
      job = await this.failTerminalResult(job, input, bodyError);
      await this.settleRuntimeAfterTerminal(session, run, input.completedAt, input.clientOperationId);
      await this.reconcileWaveFromChildren(scope.conversationId, scope.waveId, input.clientOperationId);
      return { kind: 'INVALID_RESULT', job, error: bodyError };
    }
    let parsed: ReturnType<typeof parseDiscourseCorrection>;
    try {
      parsed = parseDiscourseCorrection(input.body);
    } catch (error) {
      const invalid = await this.failInvalidResult(job, input, error);
      await this.settleRuntimeAfterTerminal(session, run, input.completedAt, input.clientOperationId);
      await this.reconcileWaveFromChildren(scope.conversationId, scope.waveId, input.clientOperationId);
      return invalid;
    }
    const message = parsed.outcome === 'ABSTAINED'
      ? undefined
      : await this.discourse.appendAgentMessage({
          conversationId: scope.conversationId,
          body: parsed.body,
          stableParticipantId: job.assignment.stableParticipantId,
          participantRevisionId: job.assignment.participantRevisionId,
          displayNameSnapshot: job.assignment.displayNameSnapshot,
          waveId: job.waveId,
          jobId: job.id,
          contextSnapshotId: job.contextSnapshotId,
          ...(job.targetMessageIds[0] ? { replyToMessageId: job.targetMessageIds[0] } : {}),
          sourceMessageIds: job.visibleMessageIds,
          freshnessAtCompletion: input.freshnessAtCompletion,
          clientOperationId: `${input.clientOperationId}:message`
        });
    const eligibleConcernIds = aggregate.concerns
      .filter(
        (concern) =>
          concern.waveId === job.waveId &&
          !concern.resolution &&
          isEligibleDiscourseConcern(concern)
      )
      .map((concern) => concern.id);
    if (job.status !== 'COMPLETED') {
      job = await this.discourse.completeCorrectionJob({
        conversationId: scope.conversationId,
        expectedRevision: job.recordRevision,
        clientOperationId: `${input.clientOperationId}:correction-terminal`,
        concernIds: eligibleConcernIds,
        job: {
          ...job,
          recordRevision: job.recordRevision + 1,
          status: 'COMPLETED',
          delivery: 'TERMINAL',
          freshnessAtCompletion: input.freshnessAtCompletion,
          result: {
            kind: 'CORRECTION',
            outcome: parsed.outcome,
            limitations: parsed.limitations,
            ...(message ? { outputMessageId: message.id } : {})
          },
          finishedAt: input.completedAt
        }
      });
    }
    await this.settleRuntimeAfterTerminal(session, run, input.completedAt, input.clientOperationId);
    await this.reconcileWaveFromChildren(scope.conversationId, scope.waveId, input.clientOperationId);
    return message
      ? { kind: 'CURATED', message }
      : { kind: 'CORRECTION', job };
  }

  async ingestFailure(input: IngestDiscourseFailureInput): Promise<{
    kind: 'FAILED' | 'CONVERSATION_DELETED';
  }> {
    requireTimestamp(input.completedAt);
    const runtimeSnapshot = await this.runtime.snapshot();
    let run = requireRuntimeRun(runtimeSnapshot.runs, input.runId);
    if (run.scope.kind !== 'DISCOURSE' || run.providerTurnId !== input.providerTurnId) {
      throw new Error('Provider failure terminal does not match its durable discourse run.');
    }
    const scope = run.scope;
    const session = requireRuntimeSession(runtimeSnapshot.sessions, run.sessionId);
    const tombstone = await this.discourse.getConversationTombstone(
      run.scope.conversationId
    );
    if (tombstone) {
      if (!isRuntimeTerminal(run.status)) {
        run = await this.runtime.updateRun(
          run.id,
          run.recordRevision,
          {
            status: run.interruptDelivery ? 'INTERRUPTED' : 'FAILED',
            delivery: 'TERMINAL',
            ...(run.interruptDelivery ? { interruptDelivery: 'TERMINAL' } : {}),
            recoveryState: 'NONE',
            terminalReason: input.reason,
            providerTerminalSource: input.providerTerminalSource,
            lastEventAt: input.completedAt,
            endedAt: input.completedAt
          },
          `${input.clientOperationId}:runtime-deleted-terminal`
        );
      }
      await this.settleRuntimeAfterTerminal(
        session,
        run,
        input.completedAt,
        input.clientOperationId
      );
      return { kind: 'CONVERSATION_DELETED' };
    }
    const aggregate = await this.discourse.getConversation(run.scope.conversationId);
    const job = requireJob(aggregate.jobs, run.scope.jobId, run.scope.waveId);
    if (!isRuntimeTerminal(run.status)) {
      const canceled =
        job.status === 'CANCEL_REQUESTED' || job.status === 'RECOVERY_REQUIRED';
      run = await this.runtime.updateRun(
        run.id,
        run.recordRevision,
        {
          status: canceled ? 'INTERRUPTED' : 'FAILED',
          delivery: 'TERMINAL',
          ...(run.interruptDelivery ? { interruptDelivery: 'TERMINAL' } : {}),
          recoveryState: 'NONE',
          terminalReason: input.reason,
          providerTerminalSource: input.providerTerminalSource,
          lastEventAt: input.completedAt,
          endedAt: input.completedAt
        },
        `${input.clientOperationId}:runtime-failure-terminal`
      );
    } else if (run.interruptDelivery && run.interruptDelivery !== 'TERMINAL') {
      run = await this.runtime.updateRun(
        run.id,
        run.recordRevision,
        { interruptDelivery: 'TERMINAL' },
        `${input.clientOperationId}:runtime-interrupt-terminal`
      );
    }
    if (!['COMPLETED', 'FAILED', 'CANCELED', 'CONTEXT_STALE'].includes(job.status)) {
      const canceled = job.status === 'CANCEL_REQUESTED' || job.status === 'RECOVERY_REQUIRED';
      await this.discourse.updateJob({
        conversationId: scope.conversationId,
        expectedRevision: job.recordRevision,
        clientOperationId: `${input.clientOperationId}:job-failed`,
        job: {
          ...job,
          recordRevision: job.recordRevision + 1,
          status: canceled ? 'CANCELED' : 'FAILED',
          delivery: 'TERMINAL',
          ...(canceled
            ? { error: undefined }
            : {
                error: {
                  code: 'PROVIDER_UNAVAILABLE',
                  message: input.reason,
                  category: 'PROVIDER',
                  retryable: true
                } as StructuredDiscourseError
              }),
          finishedAt: input.completedAt
        }
      });
    }
    await this.settleRuntimeAfterTerminal(
      session,
      run,
      input.completedAt,
      input.clientOperationId
    );
    await this.reconcileWaveFromChildren(
      scope.conversationId,
      scope.waveId,
      input.clientOperationId
    );
    return { kind: 'FAILED' };
  }

  async recoverConversation(
    conversationId: string
  ): Promise<DiscourseRuntimeRecoveryResult> {
    const recoveredJobIds = new Set<string>();
    const recoveryRequiredJobIds = new Set<string>();
    const tombstonedRunIds = new Set<string>();
    const runtimeSnapshot = await this.runtime.snapshot();
    const tombstone = await this.discourse.getConversationTombstone(conversationId);
    if (tombstone) {
      for (const run of runtimeSnapshot.runs.filter(
        (candidate) =>
          candidate.scope.kind === 'DISCOURSE' &&
          candidate.scope.conversationId === conversationId
      )) {
        if (run.scope.kind !== 'DISCOURSE') continue;
        if (isRuntimeTerminal(run.status)) {
          const session = requireRuntimeSession(runtimeSnapshot.sessions, run.sessionId);
          await this.settleRuntimeAfterTerminal(
            session,
            run,
            run.endedAt ?? tombstone.deletedAt,
            `recover-deleted:${run.id}`
          );
          tombstonedRunIds.add(run.id);
        } else {
          recoveryRequiredJobIds.add(run.scope.jobId);
        }
      }
      return toRecoveryResult(recoveredJobIds, recoveryRequiredJobIds, tombstonedRunIds);
    }

    const aggregate = await this.discourse.getConversation(conversationId);
    for (const originalJob of aggregate.jobs) {
      let job = originalJob;
      const matchingRuns = runtimeSnapshot.runs.filter(
        (run) =>
          run.scope.kind === 'DISCOURSE' &&
          run.scope.conversationId === conversationId &&
          run.scope.waveId === job.waveId &&
          run.scope.jobId === job.id &&
          run.scope.attemptId === job.attemptId &&
          run.generationKey === job.generationKey
      );
      if (matchingRuns.length > 1) {
        recoveryRequiredJobIds.add(job.id);
        continue;
      }
      let run = matchingRuns[0];
      if (!run) {
        if (job.runId) recoveryRequiredJobIds.add(job.id);
        continue;
      }
      const session = runtimeSnapshot.sessions.find((candidate) => candidate.id === run.sessionId);
      if (!session || (job.runId && job.runId !== run.id)) {
        recoveryRequiredJobIds.add(job.id);
        continue;
      }
      if (job.status === 'QUEUED') {
        job = await this.discourse.updateJob({
          conversationId,
          expectedRevision: job.recordRevision,
          clientOperationId: `recover-link:${run.id}`,
          job: {
            ...job,
            contextSnapshotId:
              run.scope.kind === 'DISCOURSE'
                ? run.scope.contextSnapshotId
                : job.contextSnapshotId,
            sessionId: session.id,
            executionProfileHash: session.accessEpoch.executionProfileHash,
            runId: run.id,
            promptArtifactId: run.promptArtifactId,
            outputArtifactId: run.outputArtifactId,
            recordRevision: job.recordRevision + 1,
            status: 'RESOLVING_CONTEXT'
          }
        });
        recoveredJobIds.add(job.id);
      } else {
        try {
          assertExistingJobLink(job, session, run);
        } catch {
          recoveryRequiredJobIds.add(job.id);
          continue;
        }
      }

      const queueEntry = runtimeSnapshot.queueEntries.find(
        (candidate) => candidate.runId === run.id
      );
      if (!queueEntry && run.status === 'QUEUED') {
        await this.runtime.enqueueRun(
          run.id,
          priorityForJob(job),
          `recover-enqueue:${run.id}`
        );
        recoveredJobIds.add(job.id);
      }
      if (
        queueEntry?.status === 'LEASED' &&
        run.status === 'QUEUED' &&
        run.delivery === 'NOT_SENT'
      ) {
        await this.runtime.releaseQueueEntry(
          queueEntry.id,
          queueEntry.recordRevision,
          `recover-release:${run.id}`
        );
        recoveredJobIds.add(job.id);
      }
      if (run.status === 'QUEUED') {
        await this.ensureWaveQueued(conversationId, job.waveId, `recover:${run.id}`);
      }

      if (
        job.status === 'CANCEL_REQUESTED' &&
        ((run.status === 'QUEUED' && run.delivery === 'NOT_SENT') ||
          (run.status === 'INTERRUPTED' && run.delivery === 'NOT_DELIVERED'))
      ) {
        if (run.status === 'QUEUED') {
          run = await this.runtime.updateRun(
            run.id,
            run.recordRevision,
            {
              status: 'INTERRUPTED',
              delivery: 'NOT_DELIVERED',
              recoveryState: 'NONE',
              terminalReason: 'Recovered queued cancellation.',
              lastEventAt: this.now(),
              endedAt: this.now()
            },
            `recover-cancel-runtime:${run.id}`
          );
        }
        const cancelEntry = (await this.runtime.snapshot()).queueEntries.find(
          (candidate) => candidate.runId === run.id
        );
        if (cancelEntry?.status === 'QUEUED') {
          await this.runtime.cancelQueueEntry(
            cancelEntry.id,
            cancelEntry.recordRevision,
            'Recovered queued cancellation.',
            `recover-cancel-queue:${run.id}`
          );
        } else if (!cancelEntry || cancelEntry.status !== 'CANCELED') {
          recoveryRequiredJobIds.add(job.id);
          continue;
        }
        await this.discourse.updateJob({
          conversationId,
          expectedRevision: job.recordRevision,
          clientOperationId: `recover-cancel-job:${run.id}`,
          job: {
            ...job,
            recordRevision: job.recordRevision + 1,
            status: 'CANCELED',
            finishedAt: this.now()
          }
        });
        await this.reconcileWaveFromChildren(
          conversationId,
          job.waveId,
          `recover-cancel:${run.id}`
        );
        recoveredJobIds.add(job.id);
        continue;
      }

      if (
        job.status === 'CANCEL_REQUESTED' &&
        run.interruptDelivery &&
        ['INTERRUPTING', 'RECOVERY_REQUIRED'].includes(run.status)
      ) {
        if (run.status === 'INTERRUPTING') {
          run = await this.runtime.updateRun(
            run.id,
            run.recordRevision,
            {
              status: 'RECOVERY_REQUIRED',
              interruptDelivery:
                run.interruptDelivery === 'SENDING'
                  ? 'AMBIGUOUS'
                  : run.interruptDelivery,
              recoveryState: 'REQUIRES_USER_ACTION',
              terminalReason:
                'The app restarted before the provider interruption reached a terminal result.',
              lastEventAt: this.now()
            },
            `recover-interrupt-runtime:${run.id}`
          );
        }
        job = await this.discourse.updateJob({
          conversationId,
          expectedRevision: job.recordRevision,
          clientOperationId: `recover-interrupt-job:${run.id}`,
          job: {
            ...job,
            recordRevision: job.recordRevision + 1,
            status: 'RECOVERY_REQUIRED',
            error: {
              code: 'DELIVERY_AMBIGUOUS',
              message:
                'The provider interruption has no authoritative terminal result.',
              category: 'DELIVERY',
              retryable: false
            }
          }
        });
        const recoveryWave = requireWave(
          (await this.discourse.getConversation(conversationId)).waves,
          job.waveId
        );
        await this.markWaveRecovery(
          conversationId,
          recoveryWave,
          `recover-interrupt:${run.id}`
        );
        recoveryRequiredJobIds.add(job.id);
        continue;
      }

      if (run.status === 'COMPLETED' && job.status !== 'COMPLETED') {
        const body = await this.runtime.readArtifact(run.outputArtifactId);
        if (
          !body.trim() ||
          !run.providerTurnId ||
          !run.endedAt ||
          !run.contextFreshnessAtCompletion
        ) {
          recoveryRequiredJobIds.add(job.id);
          continue;
        }
        const result = await this.ingestContribution({
          runId: run.id,
          providerTurnId: run.providerTurnId,
          body,
          freshnessAtCompletion: run.contextFreshnessAtCompletion,
          clientOperationId: `recover-terminal:${run.id}`,
          completedAt: run.endedAt,
          providerTerminalSource: run.providerTerminalSource ?? 'RUNTIME_RECOVERY'
        });
        if (result.kind === 'CURATED') recoveredJobIds.add(job.id);
        else tombstonedRunIds.add(run.id);
        continue;
      }

      if (['FAILED', 'INTERRUPTED', 'LOST'].includes(run.status)) {
        const completedAt = run.endedAt ?? run.lastEventAt ?? this.now();
        if (
          run.providerTurnId &&
          !['COMPLETED', 'FAILED', 'CANCELED', 'CONTEXT_STALE'].includes(job.status)
        ) {
          await this.ingestFailure({
            runId: run.id,
            providerTurnId: run.providerTurnId,
            clientOperationId: `recover-failure:${run.id}`,
            completedAt,
            providerTerminalSource:
              run.providerTerminalSource ?? 'RUNTIME_RECOVERY',
            reason:
              run.terminalReason ??
              `Provider runtime ended with status ${run.status}.`
          });
          recoveredJobIds.add(job.id);
          continue;
        }
        if (['COMPLETED', 'FAILED', 'CANCELED', 'CONTEXT_STALE'].includes(job.status)) {
          await this.settleRuntimeAfterTerminal(
            session,
            run,
            completedAt,
            `recover-settle:${run.id}`
          );
          await this.reconcileWaveFromChildren(
            conversationId,
            job.waveId,
            `recover-settle:${run.id}`
          );
          recoveredJobIds.add(job.id);
          continue;
        }
        recoveryRequiredJobIds.add(job.id);
        continue;
      }

      if (run.status === 'RUNNING' && run.delivery === 'ACKNOWLEDGED') {
        await this.ensureWaveRunning(
          conversationId,
          job.waveId,
          job,
          `recover:${run.id}`
        );
        if (job.status === 'RESOLVING_CONTEXT') {
          job = await this.discourse.updateJob({
            conversationId,
            expectedRevision: job.recordRevision,
            clientOperationId: `recover-job-starting:${run.id}`,
            job: {
              ...job,
              recordRevision: job.recordRevision + 1,
              status: 'STARTING',
              delivery: 'SENDING',
              startedAt: job.startedAt ?? run.startedAt ?? this.now()
            }
          });
        }
        if (job.status === 'STARTING') {
          await this.discourse.updateJob({
            conversationId,
            expectedRevision: job.recordRevision,
            clientOperationId: `recover-job-running:${run.id}`,
            job: {
              ...job,
              recordRevision: job.recordRevision + 1,
              status: 'RUNNING',
              delivery: 'ACKNOWLEDGED'
            }
          });
        }
        recoveredJobIds.add(job.id);
        continue;
      }

      if (run.status === 'STARTING' && run.delivery === 'SENDING') {
        if (job.status === 'RESOLVING_CONTEXT') {
          job = await this.discourse.updateJob({
            conversationId,
            expectedRevision: job.recordRevision,
            clientOperationId: `recover-ambiguous-starting:${run.id}`,
            job: {
              ...job,
              recordRevision: job.recordRevision + 1,
              status: 'STARTING',
              delivery: 'SENDING',
              startedAt: job.startedAt ?? run.startedAt ?? this.now()
            }
          });
        }
        const runtimeRecovery = await this.runtime.updateRun(
          run.id,
          run.recordRevision,
          {
            status: 'RECOVERY_REQUIRED',
            delivery: 'AMBIGUOUS',
            recoveryState: 'REQUIRES_USER_ACTION',
            terminalReason: 'Provider start intent was durable without an authoritative delivery result.',
            lastEventAt: this.now()
          },
          `recover-runtime-ambiguous:${run.id}`
        );
        void runtimeRecovery;
        if (job.status === 'STARTING') {
          job = await this.discourse.updateJob({
            conversationId,
            expectedRevision: job.recordRevision,
            clientOperationId: `recover-job-ambiguous:${run.id}`,
            job: {
              ...job,
              recordRevision: job.recordRevision + 1,
              status: 'RECOVERY_REQUIRED',
              delivery: 'AMBIGUOUS',
              error: {
                code: 'DELIVERY_AMBIGUOUS',
                message: 'Provider start intent has no authoritative delivery result.',
                category: 'DELIVERY',
                retryable: false
              }
            }
          });
        }
        await this.ensureWaveRunning(
          conversationId,
          job.waveId,
          job,
          `recover-ambiguous:${run.id}`
        );
        const wave = requireWave(
          (await this.discourse.getConversation(conversationId)).waves,
          job.waveId
        );
        await this.markWaveRecovery(conversationId, wave, `recover:${run.id}`);
        recoveryRequiredJobIds.add(job.id);
      }
    }
    return toRecoveryResult(recoveredJobIds, recoveryRequiredJobIds, tombstonedRunIds);
  }

  private async settleRuntimeAfterTerminal(
    session: AgentRuntimeSessionRecord,
    run: AgentRuntimeRunRecord,
    completedAt: string,
    operationId: string
  ): Promise<void> {
    if (session.status !== 'IDLE') {
      await this.runtime.updateSession(
        session.id,
        session.recordRevision,
        { status: 'IDLE', lastAttachedAt: completedAt },
        `${operationId}:session-idle`
      );
    }
    const entry = (await this.runtime.snapshot()).queueEntries.find(
      (candidate) => candidate.runId === run.id
    );
    if (entry?.status === 'LEASED') {
      await this.runtime.settleQueueEntry(
        entry.id,
        entry.recordRevision,
        `${operationId}:queue-terminal`
      );
    }
  }

  private async assertConversationRuntimeSettled(conversationId: string): Promise<void> {
    const aggregate = await this.discourse.getConversation(conversationId);
    if (
      aggregate.waves.some((wave) =>
        [
          'PLANNED',
          'SNAPSHOTTING',
          'QUEUED',
          'RUNNING',
          'STOP_REQUESTED',
          'STOPPING',
          'RECOVERY_REQUIRED'
        ].includes(wave.status)
      )
    ) {
      throw new Error('Stop and safely settle the active response before archive or deletion.');
    }
    const runtimeSnapshot = await this.runtime.snapshot();
    const runs = runtimeSnapshot.runs.filter(
      (run) =>
        run.scope.kind === 'DISCOURSE' &&
        run.scope.conversationId === conversationId
    );
    if (runs.some((run) => !isRuntimeTerminal(run.status))) {
      throw new Error('Conversation runtime recovery must finish before archive or deletion.');
    }
    const runIds = new Set(runs.map((run) => run.id));
    if (
      runtimeSnapshot.queueEntries.some(
        (entry) =>
          runIds.has(entry.runId) &&
          (entry.status === 'QUEUED' || entry.status === 'LEASED')
      )
    ) {
      throw new Error('Conversation scheduler work must settle before archive or deletion.');
    }
  }

  private async reconcileStartedProviderTurn(
    entry: AgentSchedulerQueueEntry,
    started: StartedScopedAgentTurn | undefined,
    operationId: string
  ): Promise<AgentRuntimeRunRecord> {
    if (entry.scope.kind !== 'DISCOURSE') {
      throw new Error('Only discourse queue entries can acknowledge scoped turns.');
    }
    const runtimeSnapshot = await this.runtime.snapshot();
    let run = requireRuntimeRun(runtimeSnapshot.runs, entry.runId);
    let session = requireRuntimeSession(runtimeSnapshot.sessions, run.sessionId);
    const providerSessionId = started?.providerSessionId ?? session.providerSessionId;
    const providerTurnId = started?.providerTurnId ?? run.providerTurnId;
    const serverInstanceId = started?.serverInstanceId ?? run.serverInstanceId;
    const startedAt = started?.startedAt ?? run.lastEventAt;
    if (!providerSessionId || !providerTurnId || !serverInstanceId) {
      throw new Error('Provider acknowledgement is missing durable scoped identities.');
    }
    if (session.providerSessionId && session.providerSessionId !== providerSessionId) {
      throw new Error('Provider acknowledgement changed the scoped session identity.');
    }
    if (run.providerTurnId && run.providerTurnId !== providerTurnId) {
      throw new Error('Provider acknowledgement changed the scoped turn identity.');
    }
    if (run.serverInstanceId && run.serverInstanceId !== serverInstanceId) {
      throw new Error('Provider acknowledgement changed the scoped server identity.');
    }
    if (isRuntimeTerminal(run.status)) {
      return run;
    }
    if (
      session.status !== 'ACTIVE' ||
      session.providerSessionId !== providerSessionId ||
      (started?.providerSessionTreeId &&
        session.providerSessionTreeId !== started.providerSessionTreeId)
    ) {
      session = await this.runtime.updateSession(
        session.id,
        session.recordRevision,
        {
          providerSessionId,
          ...(started?.providerSessionTreeId
            ? { providerSessionTreeId: started.providerSessionTreeId }
            : {}),
          status: 'ACTIVE',
          materialized: true,
          lastAttachedAt: startedAt
        },
        `${operationId}:session-acknowledged`
      );
    }
    if (run.status === 'STARTING' && run.delivery === 'SENDING') {
      run = await this.runtime.updateRun(
        run.id,
        run.recordRevision,
        {
          serverInstanceId,
          providerTurnId,
          status: 'RUNNING',
          delivery: 'ACKNOWLEDGED',
          lastEventAt: startedAt
        },
        `${operationId}:runtime-acknowledged`
      );
    } else if (run.status !== 'RUNNING' || run.delivery !== 'ACKNOWLEDGED') {
      throw new Error(
        `Scoped provider acknowledgement cannot advance runtime run from ${run.status}/${run.delivery}.`
      );
    }
    const aggregate = await this.discourse.getConversation(entry.scope.conversationId);
    const job = requireJob(aggregate.jobs, entry.scope.jobId, entry.scope.waveId);
    if (job.status === 'STARTING' && job.delivery === 'SENDING') {
      await this.discourse.updateJob({
        conversationId: entry.scope.conversationId,
        expectedRevision: job.recordRevision,
        clientOperationId: `${operationId}:job-acknowledged`,
        job: {
          ...job,
          recordRevision: job.recordRevision + 1,
          status: 'RUNNING',
          delivery: 'ACKNOWLEDGED'
        }
      });
    } else if (job.status !== 'RUNNING' || job.delivery !== 'ACKNOWLEDGED') {
      throw new Error(
        `Scoped provider acknowledgement cannot advance discourse job from ${job.status}/${job.delivery}.`
      );
    }
    void session;
    return run;
  }

  private async ensureWaveQueued(
    conversationId: string,
    waveId: string,
    operationId: string
  ): Promise<void> {
    let wave = requireWave(
      (await this.discourse.getConversation(conversationId)).waves,
      waveId
    );
    if (wave.status === 'PLANNED') {
      wave = await this.discourse.updateWave({
        conversationId,
        expectedRevision: wave.recordRevision,
        clientOperationId: `${operationId}:wave-snapshotting`,
        wave: {
          ...wave,
          recordRevision: wave.recordRevision + 1,
          status: 'SNAPSHOTTING'
        }
      });
    }
    if (wave.status === 'SNAPSHOTTING') {
      await this.discourse.updateWave({
        conversationId,
        expectedRevision: wave.recordRevision,
        clientOperationId: `${operationId}:wave-queued`,
        wave: {
          ...wave,
          recordRevision: wave.recordRevision + 1,
          status: 'QUEUED'
        }
      });
    }
  }

  private async ensureWaveRunning(
    conversationId: string,
    waveId: string,
    job: DiscourseAgentJobRecord,
    operationId: string
  ): Promise<void> {
    await this.ensureWaveQueued(conversationId, waveId, operationId);
    const wave = requireWave(
      (await this.discourse.getConversation(conversationId)).waves,
      waveId
    );
    if (wave.status === 'QUEUED') {
      await this.discourse.updateWave({
        conversationId,
        expectedRevision: wave.recordRevision,
        clientOperationId: `${operationId}:wave-running`,
        wave: {
          ...wave,
          recordRevision: wave.recordRevision + 1,
          status: 'RUNNING',
          phase: phaseForJob(job),
          startedAt: wave.startedAt ?? this.now()
        }
      });
    }
  }

  private async reconcileWaveFromChildren(
    conversationId: string,
    waveId: string,
    operationId: string
  ): Promise<void> {
    const aggregate = await this.discourse.getConversation(conversationId);
    const wave = requireWave(aggregate.waves, waveId);
    if (wave.status === 'SETTLED') return;
    const derived = deriveDiscourseWaveAggregate({
      wave,
      jobs: aggregate.jobs.filter((job) => job.waveId === wave.id),
      concerns: aggregate.concerns.filter((concern) => concern.waveId === wave.id)
    });
    if (derived.status === 'RECOVERY_REQUIRED') {
      await this.markWaveRecovery(conversationId, wave, operationId);
      return;
    }
    if (derived.status !== 'SETTLED') return;
    await this.discourse.updateWave({
      conversationId,
      expectedRevision: wave.recordRevision,
      clientOperationId: `${operationId}:wave-terminal`,
      wave: {
        ...wave,
        recordRevision: wave.recordRevision + 1,
        status: 'SETTLED',
        phase: 'COMPLETE',
        outcome: derived.outcome,
        settlementReason: derived.settlementReason,
        settledAt: this.now()
      }
    });
  }

  private async markWaveRecovery(
    conversationId: string,
    wave: DiscourseResponseWaveRecord,
    operationId: string
  ): Promise<void> {
    if (wave.status === 'RECOVERY_REQUIRED') return;
    await this.discourse.updateWave({
      conversationId,
      expectedRevision: wave.recordRevision,
      clientOperationId: `${operationId}:wave-recovery`,
      wave: {
        ...wave,
        recordRevision: wave.recordRevision + 1,
        status: 'RECOVERY_REQUIRED'
      }
    });
  }
}

export function discourseRuntimeSessionId(clientOperationId: string): string {
  if (!clientOperationId.trim()) {
    throw new Error('Discourse runtime identity requires a client operation id.');
  }
  return deterministicId('discourse-session', clientOperationId);
}

function executionContextFromSession(
  session: AgentRuntimeSessionRecord,
  run: AgentRuntimeRunRecord
): AgentExecutionContext {
  if (session.id !== run.sessionId) {
    throw new Error('Discourse runtime execution context belongs to another session.');
  }
  return structuredClone(session.executionContext);
}

function purposeForJob(job: DiscourseAgentJobRecord): AgentRuntimePurpose {
  switch (job.role) {
    case 'ANSWER': return 'DISCOURSE_ANSWER';
    case 'CRITIQUE': return 'DISCOURSE_CRITIQUE';
    case 'CORRECT': return 'DISCOURSE_CORRECT';
    case 'TARGETED_REPLY': return 'DISCOURSE_TARGETED_REPLY';
    case 'SYNTHESIZE': return 'DISCOURSE_SYNTHESIZE';
    case 'COMPACT_HISTORY': return 'DISCOURSE_COMPACT_HISTORY';
  }
}

function priorityForJob(job: DiscourseAgentJobRecord) {
  return job.role === 'CRITIQUE' || job.role === 'CORRECT' || job.role === 'COMPACT_HISTORY'
    ? 'DISCOURSE_BACKGROUND' as const
    : job.role === 'TARGETED_REPLY'
      ? 'DISCOURSE_TARGETED' as const
      : 'DISCOURSE_RESPONSE' as const;
}

function phaseForJob(job: DiscourseAgentJobRecord): DiscourseResponseWaveRecord['phase'] {
  return job.role === 'CRITIQUE'
    ? 'REVIEW'
    : job.role === 'CORRECT'
      ? 'CORRECT'
      : job.role === 'SYNTHESIZE'
        ? 'SYNTHESIZE'
        : 'ANSWER';
}

function concernFingerprint(concern: {
  targetClaim: string;
  category: string;
  reason: string;
  evidenceStatus: string;
}): string {
  return [
    concern.targetClaim,
    concern.category,
    concern.reason,
    concern.evidenceStatus
  ].map((value) => value.normalize('NFC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase())
    .join('\u0000');
}

function deterministicId(prefix: string, value: string): string {
  return `${prefix}-${sha256(value).slice(0, 32)}`;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function requireJob(
  jobs: readonly DiscourseAgentJobRecord[],
  jobId: string,
  waveId: string
): DiscourseAgentJobRecord {
  const job = jobs.find((candidate) => candidate.id === jobId && candidate.waveId === waveId);
  if (!job) throw new Error(`Discourse job not found: ${jobId}`);
  return job;
}

function requireWave(
  waves: readonly DiscourseResponseWaveRecord[],
  waveId: string
): DiscourseResponseWaveRecord {
  const wave = waves.find((candidate) => candidate.id === waveId);
  if (!wave) throw new Error(`Discourse wave not found: ${waveId}`);
  return wave;
}

function requireRuntimeRun(
  runs: readonly AgentRuntimeRunRecord[],
  runId: string
): AgentRuntimeRunRecord {
  const run = runs.find((candidate) => candidate.id === runId);
  if (!run) throw new Error(`Agent runtime run not found: ${runId}`);
  return run;
}

function requireRuntimeSession(
  sessions: readonly AgentRuntimeSessionRecord[],
  sessionId: string
): AgentRuntimeSessionRecord {
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!session) throw new Error(`Agent runtime session not found: ${sessionId}`);
  return session;
}

function requireMessage(
  messages: readonly DiscourseMessageRecord[],
  messageId: string
): DiscourseMessageRecord {
  const message = messages.find((candidate) => candidate.id === messageId);
  if (!message) throw new Error(`Discourse output message not found: ${messageId}`);
  return message;
}

function assertExistingJobLink(
  job: DiscourseAgentJobRecord,
  session: AgentRuntimeSessionRecord,
  run: AgentRuntimeRunRecord
): void {
  if (
    job.sessionId !== session.id ||
    job.runId !== run.id ||
    job.executionProfileHash !== session.accessEpoch.executionProfileHash ||
    job.promptArtifactId !== run.promptArtifactId ||
    job.outputArtifactId !== run.outputArtifactId
  ) {
    throw new Error('Discourse job link contradicts its owner-bearing runtime records.');
  }
}

function providerStartError(
  error: unknown,
  delivery: 'NOT_DELIVERED' | 'AMBIGUOUS'
): StructuredDiscourseError {
  return {
    code: delivery === 'NOT_DELIVERED' ? 'PROVIDER_UNAVAILABLE' : 'DELIVERY_AMBIGUOUS',
    message: error instanceof Error ? error.message : String(error),
    category: delivery === 'NOT_DELIVERED' ? 'PROVIDER' : 'DELIVERY',
    retryable: delivery === 'NOT_DELIVERED'
  };
}

function requireTimestamp(value: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error('Discourse runtime timestamp is invalid.');
  }
}

function isRuntimeTerminal(status: AgentRuntimeRunRecord['status']): boolean {
  return ['COMPLETED', 'FAILED', 'INTERRUPTED', 'LOST'].includes(status);
}

function toRecoveryResult(
  recoveredJobIds: ReadonlySet<string>,
  recoveryRequiredJobIds: ReadonlySet<string>,
  tombstonedRunIds: ReadonlySet<string>
): DiscourseRuntimeRecoveryResult {
  const sort = (values: ReadonlySet<string>) => [...values].sort();
  return {
    recoveredJobIds: sort(recoveredJobIds),
    recoveryRequiredJobIds: sort(recoveryRequiredJobIds),
    tombstonedRunIds: sort(tombstonedRunIds)
  };
}
