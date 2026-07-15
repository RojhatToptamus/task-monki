import crypto, { randomUUID } from 'node:crypto';
import type { AgentProviderState, TaskManagerAppSettings } from '../../shared/agent';
import type {
  AppendHumanDiscourseMessageRequest,
  AgentAssignmentSnapshot,
  AgentProfileCatalogEntry,
  BuiltInAgentProfileId,
  ContextSnapshotRecord,
  ConfirmDiscourseWaveContextRequest,
  CreateDiscourseConversationRequest,
  DeleteDiscourseConversationRequest,
  DeleteDiscourseDraftRequest,
  DiscourseConversationAggregateRecord,
  DiscourseConversationPage,
  DiscourseConversationRecord,
  DiscourseContextPreview,
  DiscourseDefaultPolicy,
  DiscourseDraftRecord,
  DiscourseMentionCatalogSnapshot,
  DiscourseMessagePage,
  DiscourseMessageRecord,
  DiscourseAgentJobRecord,
  DiscourseParticipantRevisionRecord,
  DiscourseResponseWaveRecord,
  ListDiscourseConversationsRequest,
  ListDiscourseMessagesRequest,
  PreviewDiscourseContextRequest,
  RenameDiscourseConversationRequest,
  SaveDiscourseDraftRequest,
  SendDiscourseMessageRequest,
  SendDiscourseMessageResult,
  SetDiscourseConversationArchivedRequest,
  SetDiscourseConversationReadRequest,
  SetPinnedDiscourseContextRequest,
  StopDiscourseWaveRequest,
  StructuredDiscourseError,
  TombstoneDiscourseMessageRequest
} from '../../shared/discourse';
import type { AppEventBus } from '../runner/AppEventBus';
import type { AgentScopedTurnProvider } from '../agent/AgentScopedTurnProvider';
import { AgentProfileCatalog } from './AgentProfileCatalog';
import type { DiscourseContextSnapshotService } from './DiscourseContextSnapshotService';
import type { DiscourseContextResolver } from './DiscourseContextResolver';
import {
  DiscourseRuntimeCoordinator,
  discourseRuntimeSessionId
} from './DiscourseRuntimeCoordinator';
import { assembleDiscoursePrompt } from './DiscoursePromptBuilder';
import {
  deriveDiscourseWaveAggregate
} from './DiscourseState';
import type { DiscourseStore } from './DiscourseStore';

export interface DiscourseServiceOptions {
  getProviderState(): Promise<AgentProviderState> | AgentProviderState;
  getAppSettings(): Promise<TaskManagerAppSettings> | TaskManagerAppSettings;
  now?: () => string;
  createId?: () => string;
  runtime?: {
    coordinator: DiscourseRuntimeCoordinator;
    contextSnapshots: DiscourseContextSnapshotService;
    provider: AgentScopedTurnProvider;
    notifySchedulerWorkAvailable(): void;
  };
}

/** Application façade for renderer-safe human discourse operations. */
export class DiscourseService {
  private readonly profiles = new AgentProfileCatalog();
  private readonly now: () => string;
  private readonly createId: () => string;
  private readonly conversationMutations = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: DiscourseStore,
    private readonly context: DiscourseContextResolver,
    private readonly events: AppEventBus,
    private readonly options: DiscourseServiceOptions
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() => randomUUID());
  }

  listConversations(input: ListDiscourseConversationsRequest = {}): Promise<DiscourseConversationPage> {
    return this.store.listConversations(input);
  }

  getConversation(conversationId: string): Promise<DiscourseConversationAggregateRecord> {
    return this.store.getConversation(conversationId);
  }

  listMessages(input: ListDiscourseMessagesRequest): Promise<DiscourseMessagePage> {
    return this.store.listMessages(input);
  }

  async getMentionCatalog(): Promise<DiscourseMentionCatalogSnapshot> {
    const [providerState, settings, contextCatalog] = await Promise.all([
      this.options.getProviderState(),
      this.options.getAppSettings(),
      this.context.catalogEntries()
    ]);
    const agents = this.profiles.list(providerState, {
      defaultModel: settings.defaultModel,
      defaultReasoningEffort: settings.defaultReasoningEffort
    }).profiles;
    return {
      agents,
      tasks: contextCatalog.tasks,
      repositories: contextCatalog.repositories,
      refreshedAt: this.now()
    };
  }

  async createConversation(
    input: CreateDiscourseConversationRequest
  ): Promise<DiscourseConversationRecord> {
    const profileIds = validateRoster(input.defaultPolicy, input.participantProfileIds);
    const [providerState, settings] = await Promise.all([
      this.options.getProviderState(),
      this.options.getAppSettings()
    ]);
    const catalog = this.profiles.list(providerState, {
      defaultModel: settings.defaultModel,
      defaultReasoningEffort: settings.defaultReasoningEffort
    });
    const now = this.now();
    const participants = profileIds.map((profileId) => {
      const entry = catalog.profiles.find((candidate) => candidate.profile.id === profileId);
      if (!entry) throw new Error(`Unknown discourse agent profile: ${profileId}`);
      const participantId = this.createId();
      const revisionId = this.createId();
      const resolved = entry.resolvedSettings;
      return {
        participant: {
          id: participantId,
          conversationId: '',
          agentProfileId: profileId,
          currentRevisionId: revisionId,
          enabled: true,
          recordRevision: 1,
          createdAt: now
        },
        revision: {
          id: revisionId,
          conversationId: '',
          stableParticipantId: participantId,
          agentProfileId: profileId,
          profileRevision: entry.profile.revision,
          displayNameSnapshot: entry.profile.displayName,
          providerId: entry.profile.providerId,
          model: resolved?.model ?? 'unavailable',
          modelProvider: resolved?.modelProvider ?? 'openai',
          ...(resolved?.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}),
          ...(resolved?.serviceTier ? { serviceTier: resolved.serviceTier } : {}),
          configuredRole: entry.profile.roleTemplate,
          roleContractVersion: entry.profile.roleContractVersion,
          roleContractHash: sha256(this.profiles.roleContract(profileId)),
          revision: 1,
          createdAt: now
        }
      };
    });
    const conversation = await this.store.createConversation({
      title: input.title,
      defaultPolicy: input.defaultPolicy,
      participants: participants.map(({ participant }) => participant),
      participantRevisions: participants.map(({ revision }) => revision),
      clientOperationId: input.clientOperationId
    });
    this.emit('discourse.summary.updated', conversation.id, conversation);
    return conversation;
  }

  async appendHumanMessage(
    input: AppendHumanDiscourseMessageRequest
  ): Promise<DiscourseMessageRecord> {
    const context = await this.context.resolveSelections(input.context ?? []);
    const message = await this.store.appendHumanMessage({
      conversationId: input.conversationId,
      body: input.body,
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
      ...(input.supersedesMessageId
        ? { supersedesMessageId: input.supersedesMessageId }
        : {}),
      ...(input.sourceMessageIds ? { sourceMessageIds: input.sourceMessageIds } : {}),
      context: context.map((reference) => reference.snapshot),
      clientMessageId: input.clientMessageId
    });
    this.emit('discourse.message.appended', input.conversationId, message);
    this.emit('discourse.summary.updated', input.conversationId, {
      latestOrdinal: message.ordinal
    });
    return message;
  }

  sendMessage(input: SendDiscourseMessageRequest): Promise<SendDiscourseMessageResult> {
    return this.withConversationMutation(input.conversationId, () =>
      this.sendMessageUnlocked(input)
    );
  }

  private async sendMessageUnlocked(
    input: SendDiscourseMessageRequest
  ): Promise<SendDiscourseMessageResult> {
    if (input.policy === 'NONE') {
      if (input.agentProfileIds.length !== 0) {
        throw new Error('A human-only discourse message cannot select agent recipients.');
      }
      return {
        message: await this.appendHumanMessage(input),
        jobs: []
      };
    }
    const runtime = this.options.runtime;
    if (!runtime) throw new Error('Discourse agent execution is not configured.');
    const profileIds = validateRoster(input.policy, input.agentProfileIds);
    if (!input.previewFingerprint) {
      throw new Error('An agent discourse response requires a current context preview.');
    }
    let aggregate = await this.store.getConversation(input.conversationId);
    const [providerState, settings] = await Promise.all([
      this.options.getProviderState(),
      this.options.getAppSettings()
    ]);
    const catalog = this.profiles.list(providerState, {
      defaultModel: settings.defaultModel,
      defaultReasoningEffort: settings.defaultReasoningEffort
    });
    const entries = new Map<BuiltInAgentProfileId, AgentProfileCatalogEntry>();
    for (const profileId of profileIds) {
      const entry = catalog.profiles.find((candidate) => candidate.profile.id === profileId);
      if (!entry || entry.availability !== 'AVAILABLE' || !entry.resolvedSettings) {
        throw new Error(entry?.unavailableReason ?? `Agent profile is unavailable: ${profileId}`);
      }
      entries.set(profileId, entry);
      const existing = aggregate.participants.find(
        (participant) => participant.agentProfileId === profileId && participant.enabled
      );
      if (existing) {
        const revision = aggregate.participantRevisions.find(
          (candidate) => candidate.id === existing.currentRevisionId
        );
        if (!revision) {
          throw new Error(`Discourse participant revision is missing: ${profileId}`);
        }
        assertParticipantRevisionAvailable(entry, revision, providerState);
      }
    }
    for (const profileId of profileIds) {
      await this.ensureParticipant(
        aggregate,
        profileId,
        entries.get(profileId)!,
        `${input.clientMessageId}:participant:${profileId}`
      );
      aggregate = await this.store.getConversation(input.conversationId);
    }
    const context = await this.context.resolveSelections(input.context ?? []);
    const message = await this.store.appendHumanMessage({
      conversationId: input.conversationId,
      body: input.body,
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
      ...(input.supersedesMessageId
        ? { supersedesMessageId: input.supersedesMessageId }
        : {}),
      ...(input.sourceMessageIds ? { sourceMessageIds: input.sourceMessageIds } : {}),
      context: context.map((reference) => reference.snapshot),
      clientMessageId: input.clientMessageId
    });
    aggregate = await this.store.getConversation(input.conversationId);
    const existingWave = aggregate.waves.find(
      (candidate) => candidate.clientOperationId === `${input.clientMessageId}:wave`
    );
    if (existingWave) {
      await runtime.coordinator.recoverConversation(input.conversationId);
      await this.activateNextWave(
        input.conversationId,
        `${existingWave.clientOperationId}:retry-recovery`
      );
      aggregate = await this.store.getConversation(input.conversationId);
      const recoveredWave = requireWave(aggregate.waves, existingWave.id);
      return {
        message,
        wave: recoveredWave,
        jobs: aggregate.jobs.filter((job) => job.waveId === recoveredWave.id)
      };
    }
    if (!message.contextRevisionId) {
      throw new Error('Discourse message context revision is missing.');
    }
    const contextRevision = aggregate.contextRevisions.find(
      (revision) => revision.id === message.contextRevisionId
    );
    if (!contextRevision) throw new Error('Discourse message context could not be loaded.');
    const assignments = assignmentsFromRoster(aggregate, input.policy, profileIds);
    const hasEarlierActiveWave = aggregate.waves.some((wave) => wave.status !== 'SETTLED');
    const now = this.now();
    const waveId = this.createId();
    const snapshotId = this.createId();
    const waveOperationId = `${input.clientMessageId}:wave`;
    const requestFingerprint = sha256(JSON.stringify({
      conversationId: input.conversationId,
      messageId: message.id,
      policy: input.policy,
      profileIds,
      previewFingerprint: input.previewFingerprint
    }));
    const wave = {
      id: waveId,
      conversationId: input.conversationId,
      triggerMessageId: message.id,
      policy: input.policy,
      policyVersion: 1,
      assignments,
      sourceMessageIds: [message.id],
      plannedContextRevisionId: contextRevision.id,
      contextSnapshotId: snapshotId,
      attempt: 1,
      recordRevision: 1,
      status: 'PLANNED' as const,
      phase: 'ANSWER' as const,
      clientOperationId: waveOperationId,
      requestFingerprint,
      dispatchGate: {
        status: 'READY' as const,
        previewFingerprint: input.previewFingerprint,
        confirmedAtRevision: aggregate.conversation.recordRevision
      },
      createdAt: now
    };
    const transcript = (
      await this.store.listMessages({
        conversationId: input.conversationId,
        limit: 80
      })
    ).messages;
    const answerAssignments = input.policy === 'TEAM'
      ? assignments.filter((assignment) => assignment.assignmentRole === 'PRIMARY')
      : assignments;
    const jobs = answerAssignments.map((assignment): DiscourseAgentJobRecord => {
      const jobId = this.createId();
      return {
        id: jobId,
        conversationId: input.conversationId,
        waveId,
        assignment,
        role: 'ANSWER',
        phase: 1,
        targetMessageIds: [message.id],
        visibleMessageIds: transcript.map((candidate) => candidate.id),
        contextSnapshotId: snapshotId,
        attemptId: this.createId(),
        generationKey: sha256(`${waveId}:${jobId}:1:${snapshotId}`),
        recordRevision: 1,
        status: 'QUEUED',
        delivery: 'NOT_SENT',
        createdAt: now
      };
    });
    const firstJob = jobs[0]!;
    const firstPrepareOperationId = `${waveOperationId}:prepare:${firstJob.id}`;
    const prepared = await runtime.contextSnapshots.prepare({
      conversationId: input.conversationId,
      waveId,
      snapshotId,
      contextRevision,
      transcript,
      assignment: firstJob.assignment,
      sessionId: discourseRuntimeSessionId(firstPrepareOperationId),
      clientOperationId: firstPrepareOperationId,
      buildPrompt: (snapshot) => assembleDiscoursePrompt({
        aggregate: {
          ...aggregate,
          waves: [...aggregate.waves, wave],
          jobs: [...aggregate.jobs, ...jobs]
        },
        job: firstJob,
        snapshot,
        messages: transcript
      })
    });
    const plannedWave = prepared.preview.fingerprint === input.previewFingerprint
      ? wave
      : {
          ...wave,
          dispatchGate: {
            status: 'RECONFIRMATION_REQUIRED' as const,
            previewFingerprint: input.previewFingerprint,
            currentFingerprint: prepared.preview.fingerprint,
            mismatchReason: 'Selected context changed after the preview.'
          }
        };
    await this.store.createWave({
      conversationId: input.conversationId,
      expectedConversationRevision: aggregate.conversation.recordRevision,
      wave: plannedWave,
      jobs,
      contextSnapshot: prepared.snapshot,
      clientOperationId: waveOperationId
    });
    this.emit('discourse.message.appended', input.conversationId, message);
    this.emit('discourse.wave.updated', input.conversationId, plannedWave);
    if (prepared.snapshot.status === 'BLOCKED') {
      const settled = await this.settleBlockedContextWave(
        input.conversationId,
        plannedWave,
        jobs,
        prepared.snapshot,
        waveOperationId
      );
      const failed = (await this.store.getConversation(input.conversationId)).jobs.filter(
        (job) => job.waveId === plannedWave.id
      );
      failed.forEach((job) => this.emit('discourse.job.updated', input.conversationId, job));
      this.emit('discourse.wave.updated', input.conversationId, settled);
      return { message, wave: settled, jobs: failed };
    }
    if (
      !hasEarlierActiveWave &&
      plannedWave.dispatchGate.status === 'READY' &&
      prepared.executionContext
    ) {
      const plannedAggregate = await this.store.getConversation(input.conversationId);
      let preparedJobCount = 0;
      for (const job of jobs) {
        const prepareOperationId = `${waveOperationId}:prepare:${job.id}`;
        const bounded = await this.buildBoundedPrompt({
          aggregate: plannedAggregate,
          job,
          snapshot: prepared.snapshot,
          messages: transcript
        });
        if (bounded.error) {
          await this.markQueuedJobsPromptBlocked(
            input.conversationId,
            [job],
            bounded.error,
            `${waveOperationId}:prompt-budget`
          );
          continue;
        }
        const executionContext = job.id === firstJob.id
          ? prepared.executionContext
          : await runtime.contextSnapshots.executionContextForSnapshot({
              snapshot: prepared.snapshot,
              assignment: job.assignment,
              sessionId: discourseRuntimeSessionId(prepareOperationId),
              clientOperationId: prepareOperationId
            });
        const runtimeJob = await runtime.coordinator.prepareJob({
          conversationId: input.conversationId,
          waveId,
          jobId: job.id,
          executionContext,
          prompt: bounded.prompt!,
          clientOperationId: prepareOperationId
        });
        preparedJobCount += 1;
        this.emit('discourse.job.updated', input.conversationId, runtimeJob.job);
      }
      if (preparedJobCount > 0) runtime.notifySchedulerWorkAvailable();
      await runtime.coordinator.reconcileWave(
        input.conversationId,
        waveId,
        `${waveOperationId}:prompt-budget`
      );
      const queuedAggregate = await this.store.getConversation(input.conversationId);
      return {
        message,
        wave: queuedAggregate.waves.find((candidate) => candidate.id === waveId)!,
        jobs: queuedAggregate.jobs.filter((candidate) => candidate.waveId === waveId)
      };
    }
    return { message, wave: plannedWave, jobs };
  }

  advanceWave(
    conversationId: string,
    waveId: string,
    clientOperationId: string
  ): Promise<DiscourseResponseWaveRecord> {
    return this.withConversationMutation(conversationId, () =>
      this.advanceWaveUnlocked(conversationId, waveId, clientOperationId)
    );
  }

  /** Repairs durable discourse work before scheduler/provider startup or request replay. */
  async recoverConversation(conversationId: string): Promise<DiscourseResponseWaveRecord | undefined> {
    const runtime = this.options.runtime;
    if (!runtime) return undefined;
    await runtime.coordinator.recoverConversation(conversationId);
    return this.withConversationMutation(conversationId, () =>
      this.activateNextWave(conversationId, `service-recovery:${conversationId}`)
    );
  }

  confirmWaveContext(
    input: ConfirmDiscourseWaveContextRequest
  ): Promise<DiscourseResponseWaveRecord> {
    return this.withConversationMutation(input.conversationId, async () => {
      const runtime = this.options.runtime;
      if (!runtime) throw new Error('Discourse agent execution is not configured.');
      let aggregate = await this.store.getConversation(input.conversationId);
      let wave = requireWave(aggregate.waves, input.waveId);
      if (
        wave.dispatchGate.status === 'READY' &&
        wave.dispatchGate.previewFingerprint === input.previewFingerprint
      ) return wave;
      if (
        wave.status !== 'PLANNED' ||
        wave.recordRevision !== input.expectedWaveRevision ||
        wave.dispatchGate.status !== 'RECONFIRMATION_REQUIRED'
      ) {
        throw new Error('This discourse response can no longer be confirmed.');
      }
      const contextRevision = aggregate.contextRevisions.find(
        (revision) => revision.id === wave.plannedContextRevisionId
      );
      const snapshot = aggregate.contextSnapshots.find(
        (candidate) => candidate.id === wave.contextSnapshotId
      );
      if (!contextRevision || !snapshot) {
        throw new Error('The frozen discourse context is missing.');
      }
      const currentPreview = await this.context.preview({
        pinned: contextRevision.references.filter((reference) => reference.scope === 'PINNED'),
        messageContext: contextRevision.references
          .filter((reference) => reference.scope === 'MESSAGE')
          .map((reference) => ({
            entityKind: reference.entityKind,
            entityId: reference.entityId
          }))
      });
      if (
        currentPreview.fingerprint !== input.previewFingerprint ||
        wave.dispatchGate.currentFingerprint !== input.previewFingerprint ||
        await runtime.contextSnapshots.freshness(snapshot) !== 'FRESH'
      ) {
        return this.settleWaveForChangedContext(
          input.conversationId,
          wave,
          input.clientOperationId
        );
      }
      wave = await this.store.updateWave({
        conversationId: input.conversationId,
        expectedRevision: wave.recordRevision,
        clientOperationId: `${input.clientOperationId}:confirm`,
        wave: {
          ...wave,
          recordRevision: wave.recordRevision + 1,
          dispatchGate: {
            status: 'READY',
            previewFingerprint: input.previewFingerprint,
            confirmedAtRevision: aggregate.conversation.recordRevision
          }
        }
      });
      aggregate = await this.store.getConversation(input.conversationId);
      const firstActive = aggregate.waves.find((candidate) => candidate.status !== 'SETTLED');
      if (firstActive?.id !== wave.id) {
        this.emit('discourse.wave.updated', input.conversationId, wave);
        return wave;
      }
      const jobs = aggregate.jobs.filter((job) => job.waveId === wave.id);
      const messages = (await this.store.listMessages({
        conversationId: input.conversationId,
        limit: 100
      })).messages;
      let preparedJobCount = 0;
      for (const job of jobs) {
        const operationId = `${wave.clientOperationId}:prepare:${job.id}`;
        const bounded = await this.buildBoundedPrompt({ aggregate, job, snapshot, messages });
        if (bounded.error) {
          await this.markQueuedJobsPromptBlocked(
            input.conversationId,
            [job],
            bounded.error,
            `${input.clientOperationId}:prompt-budget`
          );
          continue;
        }
        const executionContext = await runtime.contextSnapshots.executionContextForSnapshot({
          snapshot,
          assignment: job.assignment,
          sessionId: discourseRuntimeSessionId(operationId),
          clientOperationId: operationId
        });
        const prepared = await runtime.coordinator.prepareJob({
          conversationId: input.conversationId,
          waveId: wave.id,
          jobId: job.id,
          executionContext,
          prompt: bounded.prompt!,
          clientOperationId: operationId
        });
        preparedJobCount += 1;
        this.emit('discourse.job.updated', input.conversationId, prepared.job);
      }
      if (preparedJobCount > 0) runtime.notifySchedulerWorkAvailable();
      const confirmed = await runtime.coordinator.reconcileWave(
        input.conversationId,
        wave.id,
        `${input.clientOperationId}:prompt-budget`
      );
      this.emit('discourse.wave.updated', input.conversationId, confirmed);
      return confirmed;
    });
  }

  private async advanceWaveUnlocked(
    conversationId: string,
    waveId: string,
    clientOperationId: string
  ): Promise<DiscourseResponseWaveRecord> {
    const runtime = this.options.runtime;
    if (!runtime) throw new Error('Discourse agent execution is not configured.');
    let aggregate = await this.store.getConversation(conversationId);
    let wave = requireWave(aggregate.waves, waveId);
    if (wave.status === 'SETTLED') {
      return (await this.activateNextWave(conversationId, `${clientOperationId}:next`)) ?? wave;
    }
    if (wave.policy !== 'TEAM') return wave;
    const derived = deriveDiscourseWaveAggregate({
      wave,
      jobs: aggregate.jobs.filter((job) => job.waveId === wave.id),
      concerns: aggregate.concerns.filter((concern) => concern.waveId === wave.id)
    });
    if (!derived.nextPhase || !['REVIEW', 'CORRECT'].includes(derived.nextPhase)) {
      return wave;
    }
    const snapshot = aggregate.contextSnapshots.find(
      (candidate) => candidate.id === wave.contextSnapshotId
    );
    if (!snapshot || await runtime.contextSnapshots.freshness(snapshot) !== 'FRESH') {
      const settled = await this.settleWaveForChangedContext(
        conversationId,
        wave,
        clientOperationId
      );
      return (await this.activateNextWave(conversationId, `${clientOperationId}:next`)) ?? settled;
    }
    const leadJob = aggregate.jobs.find(
      (job) =>
        job.waveId === wave.id &&
        job.role === 'ANSWER' &&
        job.result?.kind === 'CONTRIBUTION'
    );
    const leadMessageId = leadJob?.result?.kind === 'CONTRIBUTION'
      ? leadJob.result.outputMessageId
      : undefined;
    if (!leadJob || !leadMessageId) {
      throw new Error('A Team downstream phase requires the lead answer.');
    }
    const createdAt = this.now();
    const downstreamJobs: DiscourseAgentJobRecord[] = derived.nextPhase === 'REVIEW'
      ? wave.assignments
          .filter((assignment) => assignment.assignmentRole === 'REVIEWER')
          .map((assignment) => this.createQueuedJob({
            conversationId,
            waveId,
            snapshotId: snapshot.id,
            assignment,
            role: 'CRITIQUE',
            phase: 2,
            targetMessageIds: [leadMessageId],
            visibleMessageIds: uniqueStrings([...leadJob.visibleMessageIds, leadMessageId]),
            createdAt
          }))
      : [this.createQueuedJob({
          conversationId,
          waveId,
          snapshotId: snapshot.id,
          assignment: wave.assignments.find(
            (assignment) => assignment.assignmentRole === 'PRIMARY'
          )!,
          role: 'CORRECT',
          phase: 3,
          targetMessageIds: [leadMessageId],
          visibleMessageIds: uniqueStrings([...leadJob.visibleMessageIds, leadMessageId]),
          createdAt
        })];

    wave = await this.store.updateWave({
      conversationId,
      expectedRevision: wave.recordRevision,
      clientOperationId: `${clientOperationId}:phase:${derived.nextPhase.toLowerCase()}`,
      wave: {
        ...wave,
        recordRevision: wave.recordRevision + 1,
        phase: derived.nextPhase
      }
    });
    aggregate = await this.store.getConversation(conversationId);
    await this.store.addJobsToWave({
      conversationId,
      waveId,
      jobs: downstreamJobs,
      expectedConversationRevision: aggregate.conversation.recordRevision,
      clientOperationId: `${clientOperationId}:jobs:${derived.nextPhase.toLowerCase()}`
    });
    aggregate = await this.store.getConversation(conversationId);
    const messages = (await this.store.listMessages({ conversationId, limit: 100 })).messages;
    const promptByJob = new Map<string, string>();
    for (const job of downstreamJobs) {
      const bounded = await this.buildBoundedPrompt({ aggregate, job, snapshot, messages });
      if (bounded.error) {
        await this.markQueuedJobsPromptBlocked(
          conversationId,
          [job],
          bounded.error,
          `${clientOperationId}:prompt-budget`
        );
      } else {
        promptByJob.set(job.id, bounded.prompt!);
      }
    }
    const runnableJobs = downstreamJobs.filter((job) => promptByJob.has(job.id));
    const executionContexts = new Map<string, Awaited<ReturnType<DiscourseContextSnapshotService['executionContextForSnapshot']>>>();
    try {
      for (const job of runnableJobs) {
        const operationId = `${wave.clientOperationId}:prepare:${job.id}`;
        executionContexts.set(job.id, await runtime.contextSnapshots.executionContextForSnapshot({
          snapshot,
          assignment: job.assignment,
          sessionId: discourseRuntimeSessionId(operationId),
          clientOperationId: operationId
        }));
      }
    } catch (error) {
      await this.markQueuedJobsContextStale(
        conversationId,
        downstreamJobs,
        `${clientOperationId}:context-stale`
      );
      const currentWave = requireWave(
        (await this.store.getConversation(conversationId)).waves,
        waveId
      );
      const settled = await this.settleWaveForChangedContext(
        conversationId,
        currentWave,
        clientOperationId
      );
      return (await this.activateNextWave(conversationId, `${clientOperationId}:next`)) ?? settled;
    }
    for (const job of runnableJobs) {
      const operationId = `${wave.clientOperationId}:prepare:${job.id}`;
      const executionContext = executionContexts.get(job.id);
      if (!executionContext) throw new Error('Discourse execution context preparation was lost.');
      const prepared = await runtime.coordinator.prepareJob({
        conversationId,
        waveId,
        jobId: job.id,
        executionContext,
        prompt: promptByJob.get(job.id)!,
        clientOperationId: operationId
      });
      this.emit('discourse.job.updated', conversationId, prepared.job);
    }
    if (runnableJobs.length > 0) runtime.notifySchedulerWorkAvailable();
    const current = await runtime.coordinator.reconcileWave(
      conversationId,
      waveId,
      `${clientOperationId}:prompt-budget`
    );
    this.emit('discourse.wave.updated', conversationId, current);
    return current.status === 'SETTLED'
      ? (await this.activateNextWave(conversationId, `${clientOperationId}:next`)) ?? current
      : current;
  }

  private async activateNextWave(
    conversationId: string,
    clientOperationId: string
  ): Promise<DiscourseResponseWaveRecord | undefined> {
    const runtime = this.options.runtime;
    if (!runtime) return undefined;
    for (;;) {
      const aggregate = await this.store.getConversation(conversationId);
      const wave = aggregate.waves.find((candidate) => candidate.status !== 'SETTLED');
      if (!wave) return undefined;
      const jobs = aggregate.jobs.filter((job) => job.waveId === wave.id);
      const jobsWithoutRuntime = jobs.filter(
        (job) =>
          !job.runId &&
          ['QUEUED', 'RESOLVING_CONTEXT'].includes(job.status)
      );
      if (
        !['PLANNED', 'SNAPSHOTTING', 'QUEUED'].includes(wave.status) ||
        wave.dispatchGate.status === 'RECONFIRMATION_REQUIRED'
      ) return wave;
      if (jobsWithoutRuntime.length === 0) {
        const reconciled = await runtime.coordinator.reconcileWave(
          conversationId,
          wave.id,
          `${clientOperationId}:unlinked-terminal:${wave.id}`
        );
        if (reconciled.status === 'SETTLED') continue;
        return reconciled;
      }
      const snapshot = aggregate.contextSnapshots.find(
        (candidate) => candidate.id === wave.contextSnapshotId
      );
      if (snapshot?.status === 'BLOCKED') {
        await this.settleBlockedContextWave(
          conversationId,
          wave,
          jobsWithoutRuntime,
          snapshot,
          `${clientOperationId}:blocked:${wave.id}`
        );
        continue;
      }
      if (
        !snapshot ||
        !['READY', 'PARTIAL'].includes(snapshot.status) ||
        await runtime.contextSnapshots.freshness(snapshot) !== 'FRESH'
      ) {
        await this.markQueuedJobsContextStale(
          conversationId,
          jobsWithoutRuntime,
          `${clientOperationId}:stale:${wave.id}`
        );
        await this.settleWaveForChangedContext(
          conversationId,
          requireWave((await this.store.getConversation(conversationId)).waves, wave.id),
          `${clientOperationId}:stale:${wave.id}`
        );
        continue;
      }
      const messages = (await this.store.listMessages({ conversationId, limit: 100 })).messages;
      const promptByJob = new Map<string, string>();
      for (const job of jobsWithoutRuntime) {
        const bounded = await this.buildBoundedPrompt({ aggregate, job, snapshot, messages });
        if (bounded.error) {
          await this.markQueuedJobsPromptBlocked(
            conversationId,
            [job],
            bounded.error,
            `${clientOperationId}:prompt-budget:${wave.id}`
          );
        } else {
          promptByJob.set(job.id, bounded.prompt!);
        }
      }
      const runnableJobs = jobsWithoutRuntime.filter((job) => promptByJob.has(job.id));
      if (runnableJobs.length === 0) {
        const reconciled = await runtime.coordinator.reconcileWave(
          conversationId,
          wave.id,
          `${clientOperationId}:prompt-budget:${wave.id}`
        );
        if (reconciled.status === 'SETTLED') continue;
        return reconciled;
      }
      const executionContexts = new Map<string, Awaited<ReturnType<DiscourseContextSnapshotService['executionContextForSnapshot']>>>();
      try {
        for (const job of runnableJobs) {
          const operationId = `${wave.clientOperationId}:prepare:${job.id}`;
          executionContexts.set(job.id, await runtime.contextSnapshots.executionContextForSnapshot({
            snapshot,
            assignment: job.assignment,
            sessionId: discourseRuntimeSessionId(operationId),
            clientOperationId: operationId
          }));
        }
      } catch {
        await this.markQueuedJobsContextStale(
          conversationId,
          runnableJobs,
          `${clientOperationId}:attestation:${wave.id}`
        );
        await this.settleWaveForChangedContext(
          conversationId,
          requireWave((await this.store.getConversation(conversationId)).waves, wave.id),
          `${clientOperationId}:attestation:${wave.id}`
        );
        continue;
      }
      for (const job of runnableJobs) {
        const operationId = `${wave.clientOperationId}:prepare:${job.id}`;
        const executionContext = executionContexts.get(job.id);
        if (!executionContext) throw new Error('Discourse queued execution context was lost.');
        const prepared = await runtime.coordinator.prepareJob({
          conversationId,
          waveId: wave.id,
          jobId: job.id,
          executionContext,
          prompt: promptByJob.get(job.id)!,
          clientOperationId: operationId
        });
        this.emit('discourse.job.updated', conversationId, prepared.job);
      }
      runtime.notifySchedulerWorkAvailable();
      const active = requireWave(
        (await this.store.getConversation(conversationId)).waves,
        wave.id
      );
      this.emit('discourse.wave.updated', conversationId, active);
      return active;
    }
  }

  private async buildBoundedPrompt(input: {
    aggregate: DiscourseConversationAggregateRecord;
    job: DiscourseAgentJobRecord;
    snapshot: ContextSnapshotRecord;
    messages: readonly DiscourseMessageRecord[];
  }): Promise<{ prompt?: string; error?: StructuredDiscourseError }> {
    const runtime = this.options.runtime;
    if (!runtime) throw new Error('Discourse agent execution is not configured.');
    const assembly = assembleDiscoursePrompt(input);
    const cumulativeWaveOutputBytes = await runtime.coordinator.cumulativeWaveOutputBytes(
      input.job.conversationId,
      input.job.waveId
    );
    const { assessment } = runtime.contextSnapshots.assessPrompt(
      assembly,
      cumulativeWaveOutputBytes
    );
    if (assessment.status === 'READY') return { prompt: assembly.prompt };
    return {
      error: {
        code: 'CONTEXT_TOO_LARGE',
        message: 'The discourse response exceeds its bounded prompt budget.',
        category: 'CONTEXT',
        retryable: false,
        detail: assessment.violations.map((violation) =>
          `${violation.code}: actual=${violation.actual}, limit=${violation.limit}${
            violation.referenceId ? `, reference=${violation.referenceId}` : ''
          }`
        ).join('; ')
      }
    };
  }

  private async markQueuedJobsPromptBlocked(
    conversationId: string,
    jobs: readonly DiscourseAgentJobRecord[],
    error: StructuredDiscourseError,
    operationId: string
  ): Promise<void> {
    for (const planned of jobs) {
      let current = (await this.store.getConversation(conversationId)).jobs.find(
        (candidate) => candidate.id === planned.id
      );
      if (!current || ['COMPLETED', 'FAILED', 'CANCELED', 'CONTEXT_STALE'].includes(current.status)) {
        continue;
      }
      if (current.runId) {
        throw new Error('Prompt-budget settlement cannot discard prepared runtime work.');
      }
      if (current.status === 'QUEUED') {
        current = await this.store.updateJob({
          conversationId,
          expectedRevision: current.recordRevision,
          clientOperationId: `${operationId}:resolving:${current.id}`,
          job: {
            ...current,
            recordRevision: current.recordRevision + 1,
            status: 'RESOLVING_CONTEXT'
          }
        });
      }
      if (current.status !== 'RESOLVING_CONTEXT') {
        throw new Error('Prompt-budget settlement found an unsafe job checkpoint.');
      }
      await this.store.updateJob({
        conversationId,
        expectedRevision: current.recordRevision,
        clientOperationId: `${operationId}:failed:${current.id}`,
        job: {
          ...current,
          recordRevision: current.recordRevision + 1,
          status: 'FAILED',
          error,
          finishedAt: this.now()
        }
      });
    }
  }

  private createQueuedJob(input: {
    conversationId: string;
    waveId: string;
    snapshotId: string;
    assignment: AgentAssignmentSnapshot;
    role: 'CRITIQUE' | 'CORRECT';
    phase: number;
    targetMessageIds: string[];
    visibleMessageIds: string[];
    createdAt: string;
  }): DiscourseAgentJobRecord {
    const id = this.createId();
    return {
      id,
      conversationId: input.conversationId,
      waveId: input.waveId,
      assignment: input.assignment,
      role: input.role,
      phase: input.phase,
      targetMessageIds: input.targetMessageIds,
      visibleMessageIds: input.visibleMessageIds,
      contextSnapshotId: input.snapshotId,
      attemptId: this.createId(),
      generationKey: sha256(`${input.waveId}:${id}:${input.phase}:${input.snapshotId}`),
      recordRevision: 1,
      status: 'QUEUED',
      delivery: 'NOT_SENT',
      createdAt: input.createdAt
    };
  }

  private async markQueuedJobsContextStale(
    conversationId: string,
    jobs: readonly DiscourseAgentJobRecord[],
    operationId: string
  ): Promise<void> {
    for (const planned of jobs) {
      const current = (await this.store.getConversation(conversationId)).jobs.find(
        (candidate) => candidate.id === planned.id
      );
      if (!current || ['COMPLETED', 'FAILED', 'CANCELED', 'CONTEXT_STALE'].includes(current.status)) {
        continue;
      }
      if (current.runId) continue;
      const resolving = current.status === 'QUEUED'
        ? await this.store.updateJob({
            conversationId,
            expectedRevision: current.recordRevision,
            clientOperationId: `${operationId}:resolving:${current.id}`,
            job: {
              ...current,
              recordRevision: current.recordRevision + 1,
              status: 'RESOLVING_CONTEXT'
            }
          })
        : current;
      if (resolving.status !== 'RESOLVING_CONTEXT') continue;
      await this.store.updateJob({
        conversationId,
        expectedRevision: resolving.recordRevision,
        clientOperationId: `${operationId}:terminal:${resolving.id}`,
        job: {
          ...resolving,
          recordRevision: resolving.recordRevision + 1,
          status: 'CONTEXT_STALE',
          freshnessAtCompletion: 'CHANGED_DURING_JOB',
          error: {
            code: 'CONTEXT_CHANGED',
            message: 'The selected context changed before this phase started.',
            category: 'CONTEXT',
            retryable: true
          },
          finishedAt: this.now()
        }
      });
    }
  }

  private async settleBlockedContextWave(
    conversationId: string,
    wave: DiscourseResponseWaveRecord,
    jobs: readonly DiscourseAgentJobRecord[],
    snapshot: ContextSnapshotRecord,
    operationId: string
  ): Promise<DiscourseResponseWaveRecord> {
    if (snapshot.status !== 'BLOCKED') {
      throw new Error('Only blocked context can use blocked-wave settlement.');
    }
    for (const planned of jobs) {
      let current = (await this.store.getConversation(conversationId)).jobs.find(
        (candidate) => candidate.id === planned.id
      );
      if (!current || ['COMPLETED', 'FAILED', 'CANCELED', 'CONTEXT_STALE'].includes(current.status)) {
        continue;
      }
      if (current.runId) {
        throw new Error('Blocked context settlement cannot discard prepared runtime work.');
      }
      if (current.status === 'QUEUED') {
        current = await this.store.updateJob({
          conversationId,
          expectedRevision: current.recordRevision,
          clientOperationId: `${operationId}:resolving:${current.id}`,
          job: {
            ...current,
            recordRevision: current.recordRevision + 1,
            status: 'RESOLVING_CONTEXT'
          }
        });
      }
      if (current.status !== 'RESOLVING_CONTEXT') {
        throw new Error('Blocked context settlement found an unsafe job checkpoint.');
      }
      await this.store.updateJob({
        conversationId,
        expectedRevision: current.recordRevision,
        clientOperationId: `${operationId}:failed:${current.id}`,
        job: {
          ...current,
          recordRevision: current.recordRevision + 1,
          status: 'FAILED',
          error: snapshot.error,
          finishedAt: this.now()
        }
      });
    }
    const currentWave = requireWave(
      (await this.store.getConversation(conversationId)).waves,
      wave.id
    );
    if (currentWave.status === 'SETTLED') return currentWave;
    return this.store.updateWave({
      conversationId,
      expectedRevision: currentWave.recordRevision,
      clientOperationId: `${operationId}:wave`,
      wave: {
        ...currentWave,
        recordRevision: currentWave.recordRevision + 1,
        status: 'SETTLED',
        phase: 'COMPLETE',
        outcome: 'FAILED',
        settlementReason: 'FAILED',
        settledAt: this.now()
      }
    });
  }

  private async settleWaveForChangedContext(
    conversationId: string,
    wave: DiscourseResponseWaveRecord,
    operationId: string
  ): Promise<DiscourseResponseWaveRecord> {
    if (wave.status === 'SETTLED') return wave;
    const settled = await this.store.updateWave({
      conversationId,
      expectedRevision: wave.recordRevision,
      clientOperationId: `${operationId}:wave-context-stale`,
      wave: {
        ...wave,
        recordRevision: wave.recordRevision + 1,
        status: 'SETTLED',
        phase: 'COMPLETE',
        outcome: 'STALE',
        settlementReason: 'CONTEXT_CHANGED',
        settledAt: this.now()
      }
    });
    this.emit('discourse.wave.updated', conversationId, settled);
    return settled;
  }

  private async ensureParticipant(
    aggregate: DiscourseConversationAggregateRecord,
    profileId: BuiltInAgentProfileId,
    entry: AgentProfileCatalogEntry,
    clientOperationId: string
  ) {
    const existing = aggregate.participants.find(
      (participant) => participant.agentProfileId === profileId && participant.enabled
    );
    if (existing) return existing;
    if (entry.profile.id !== profileId || !entry.resolvedSettings) {
      throw new Error(`Agent profile is unavailable: ${profileId}`);
    }
    const now = this.now();
    const participantId = this.createId();
    const revisionId = this.createId();
    const participant = {
      id: participantId,
      conversationId: aggregate.conversation.id,
      agentProfileId: profileId,
      currentRevisionId: revisionId,
      enabled: true,
      recordRevision: 1,
      createdAt: now
    };
    const revision = {
      id: revisionId,
      conversationId: aggregate.conversation.id,
      stableParticipantId: participantId,
      agentProfileId: profileId,
      profileRevision: entry.profile.revision,
      displayNameSnapshot: entry.profile.displayName,
      providerId: entry.profile.providerId,
      model: entry.resolvedSettings.model,
      modelProvider: entry.resolvedSettings.modelProvider,
      ...(entry.resolvedSettings.reasoningEffort
        ? { reasoningEffort: entry.resolvedSettings.reasoningEffort }
        : {}),
      ...(entry.resolvedSettings.serviceTier
        ? { serviceTier: entry.resolvedSettings.serviceTier }
        : {}),
      configuredRole: entry.profile.roleTemplate,
      roleContractVersion: entry.profile.roleContractVersion,
      roleContractHash: sha256(this.profiles.roleContract(profileId)),
      revision: 1,
      createdAt: now
    };
    const updated = await this.store.addParticipants({
      conversationId: aggregate.conversation.id,
      participants: [participant],
      participantRevisions: [revision],
      expectedRevision: aggregate.conversation.recordRevision,
      clientOperationId
    });
    const stored = updated.participants.find((candidate) => candidate.id === participantId);
    if (!stored) throw new Error('Discourse participant update was not persisted.');
    return stored;
  }

  async tombstoneMessage(
    input: TombstoneDiscourseMessageRequest
  ): Promise<DiscourseConversationRecord> {
    const conversation = await this.store.tombstoneMessage(input);
    this.emit('discourse.message.appended', input.conversationId, {
      messageId: input.messageId,
      status: 'TOMBSTONE'
    });
    return conversation;
  }

  async setPinnedContext(
    input: SetPinnedDiscourseContextRequest
  ): Promise<DiscourseConversationAggregateRecord> {
    const context = await this.context.resolveSelections(input.context);
    await this.store.setPinnedContext({
      ...input,
      context: context.map((reference) => reference.snapshot)
    });
    const aggregate = await this.store.getConversation(input.conversationId);
    this.emit('discourse.summary.updated', input.conversationId, aggregate.conversation);
    return aggregate;
  }

  async previewContext(input: PreviewDiscourseContextRequest): Promise<DiscourseContextPreview> {
    const pinned = input.conversationId
      ? currentPinnedReferences(await this.store.getConversation(input.conversationId))
      : [];
    return this.context.preview({ pinned, messageContext: input.messageContext });
  }

  saveDraft(input: SaveDiscourseDraftRequest): Promise<DiscourseDraftRecord> {
    return this.store.saveDraft(input);
  }

  getDraft(draftId: string): Promise<DiscourseDraftRecord | undefined> {
    return this.store.getDraft(draftId);
  }

  listDrafts(): Promise<DiscourseDraftRecord[]> {
    return this.store.listDrafts();
  }

  deleteDraft(input: DeleteDiscourseDraftRequest): Promise<void> {
    return this.store.deleteDraft(input);
  }

  async renameConversation(
    input: RenameDiscourseConversationRequest
  ): Promise<DiscourseConversationRecord> {
    const conversation = await this.store.renameConversation(input);
    this.emit('discourse.summary.updated', input.conversationId, conversation);
    return conversation;
  }

  async setConversationRead(
    input: SetDiscourseConversationReadRequest
  ): Promise<DiscourseConversationRecord> {
    const conversation = await this.store.setConversationReadOrdinal(input);
    this.emit('discourse.summary.updated', input.conversationId, conversation);
    return conversation;
  }

  async setConversationArchived(
    input: SetDiscourseConversationArchivedRequest
  ): Promise<DiscourseConversationRecord> {
    const conversation = this.options.runtime
      ? await this.options.runtime.coordinator.setConversationArchived(input)
      : await this.store.setConversationArchived(input);
    this.emit('discourse.summary.updated', input.conversationId, conversation);
    return conversation;
  }

  async deleteConversation(
    input: DeleteDiscourseConversationRequest
  ): Promise<void> {
    if (this.options.runtime) {
      await this.options.runtime.coordinator.deleteConversation(input);
    } else {
      await this.store.deleteConversation(input);
    }
    const drafts = await this.store.listDrafts();
    await Promise.all(
      drafts
        .filter((draft) => draft.conversationId === input.conversationId)
        .map((draft) =>
          this.store.deleteDraft({
            draftId: draft.id,
            expectedRevision: draft.recordRevision
          })
        )
    );
    this.emit('discourse.summary.updated', input.conversationId, { deleted: true });
  }

  async stopWave(input: StopDiscourseWaveRequest) {
    const runtime = this.options.runtime;
    if (!runtime) throw new Error('Discourse agent execution is not configured.');
    const aggregate = await this.store.getConversation(input.conversationId);
    const wave = aggregate.waves.find((candidate) => candidate.id === input.waveId);
    if (!wave) throw new Error(`Discourse wave not found: ${input.waveId}`);
    const stopped = ['PLANNED', 'SNAPSHOTTING', 'QUEUED'].includes(wave.status)
      ? await runtime.coordinator.cancelQueuedWave(input)
      : await runtime.coordinator.stopActiveWave(input, runtime.provider);
    if (stopped.status === 'SETTLED') {
      await this.activateNextWave(
        input.conversationId,
        `${input.clientOperationId}:next`
      );
    }
    runtime.notifySchedulerWorkAvailable();
    this.emit('discourse.wave.updated', input.conversationId, stopped);
    return stopped;
  }

  private withConversationMutation<T>(
    conversationId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const prior = this.conversationMutations.get(conversationId) ?? Promise.resolve();
    const queued = prior.catch(() => undefined).then(operation);
    const settled = queued.then(() => undefined, () => undefined);
    this.conversationMutations.set(conversationId, settled);
    void settled.finally(() => {
      if (this.conversationMutations.get(conversationId) === settled) {
        this.conversationMutations.delete(conversationId);
      }
    });
    return queued;
  }

  private emit(
    type:
      | 'discourse.summary.updated'
      | 'discourse.message.appended'
      | 'discourse.wave.updated'
      | 'discourse.job.updated',
    conversationId: string,
    payload: unknown
  ): void {
    this.events.emit({
      type,
      scope: { kind: 'DISCOURSE', conversationId },
      payload,
      at: this.now()
    });
  }
}

function assignmentFromRevision(
  revision: DiscourseParticipantRevisionRecord,
  assignmentRole: AgentAssignmentSnapshot['assignmentRole'] = 'PRIMARY'
): AgentAssignmentSnapshot {
  return {
    stableParticipantId: revision.stableParticipantId,
    participantRevisionId: revision.id,
    agentProfileId: revision.agentProfileId,
    profileRevision: revision.profileRevision,
    displayNameSnapshot: revision.displayNameSnapshot,
    providerId: revision.providerId,
    model: revision.model,
    modelProvider: revision.modelProvider,
    ...(revision.reasoningEffort ? { reasoningEffort: revision.reasoningEffort } : {}),
    ...(revision.serviceTier ? { serviceTier: revision.serviceTier } : {}),
    configuredRole: revision.configuredRole,
    roleContractVersion: revision.roleContractVersion,
    roleContractHash: revision.roleContractHash,
    assignmentRole,
    required: true
  };
}

function assertParticipantRevisionAvailable(
  entry: AgentProfileCatalogEntry,
  revision: DiscourseParticipantRevisionRecord,
  providerState: AgentProviderState
): void {
  const displayName = entry.profile.displayName;
  const model = providerState.models.find(
    (candidate) =>
      candidate.provider === revision.providerId &&
      candidate.model === revision.model
  );
  if (!model) {
    throw new Error(
      `${displayName} cannot respond because its saved model (${revision.model}) is unavailable. ` +
      'Refresh Codex models or start a new conversation.'
    );
  }
  const modelProvider = model.provider === 'codex' ? 'openai' : model.provider;
  if (revision.modelProvider !== modelProvider) {
    throw new Error(
      `${displayName} cannot respond because its saved model provider is no longer valid. ` +
      'Start a new conversation with current agent settings.'
    );
  }
  if (
    revision.reasoningEffort &&
    revision.reasoningEffort !== model.defaultReasoningEffort &&
    !model.supportedReasoningEfforts.includes(revision.reasoningEffort)
  ) {
    throw new Error(
      `${displayName} cannot respond because ${revision.reasoningEffort} reasoning is no longer ` +
      `supported by ${revision.model}. Start a new conversation with current agent settings.`
    );
  }
  if (
    revision.serviceTier &&
    revision.serviceTier !== model.defaultServiceTier &&
    !model.serviceTiers.includes(revision.serviceTier)
  ) {
    throw new Error(
      `${displayName} cannot respond because its saved service tier is no longer supported. ` +
      'Start a new conversation with current agent settings.'
    );
  }
}

function validateRoster(
  policy: DiscourseDefaultPolicy,
  input: readonly BuiltInAgentProfileId[]
): BuiltInAgentProfileId[] {
  const ids = [...new Set(input)];
  if (ids.length !== input.length || ids.some((id) => !['builtin.lead', 'builtin.skeptic', 'builtin.verifier'].includes(id))) {
    throw new Error('Discourse participant roster is invalid.');
  }
  const valid =
    policy === 'NONE' ||
    (policy === 'DIRECT' && ids.length === 1) ||
    (policy === 'PANEL' && ids.length >= 2 && ids.length <= 3) ||
    (policy === 'TEAM' && ids.length === 3);
  if (!valid) throw new Error(`Discourse ${policy.toLowerCase()} roster is incomplete.`);
  if (policy === 'TEAM') {
    const team: BuiltInAgentProfileId[] = [
      'builtin.lead',
      'builtin.skeptic',
      'builtin.verifier'
    ];
    if (team.some((id) => !ids.includes(id))) {
      throw new Error('A Team response requires Lead, Skeptic, and Verifier.');
    }
    return team;
  }
  return ids;
}

function assignmentsFromRoster(
  aggregate: DiscourseConversationAggregateRecord,
  policy: Exclude<DiscourseDefaultPolicy, 'NONE'>,
  profileIds: readonly BuiltInAgentProfileId[]
): AgentAssignmentSnapshot[] {
  return profileIds.map((profileId) => {
    const participant = aggregate.participants.find(
      (candidate) => candidate.enabled && candidate.agentProfileId === profileId
    );
    const revision = participant
      ? aggregate.participantRevisions.find(
          (candidate) => candidate.id === participant.currentRevisionId
        )
      : undefined;
    if (!participant || !revision) {
      throw new Error(`Discourse participant revision is missing: ${profileId}`);
    }
    const role = policy === 'PANEL'
      ? 'PANELIST' as const
      : policy === 'TEAM' && profileId !== 'builtin.lead'
        ? 'REVIEWER' as const
        : 'PRIMARY' as const;
    return assignmentFromRevision(revision, role);
  });
}

function requireWave(
  waves: readonly DiscourseResponseWaveRecord[],
  waveId: string
): DiscourseResponseWaveRecord {
  const wave = waves.find((candidate) => candidate.id === waveId);
  if (!wave) throw new Error(`Discourse wave not found: ${waveId}`);
  return wave;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function currentPinnedReferences(
  aggregate: DiscourseConversationAggregateRecord
) {
  const revisionId = aggregate.conversation.pinnedContextRevisionId;
  return revisionId
    ? aggregate.contextRevisions.find((revision) => revision.id === revisionId)?.references
        .filter((reference) => reference.scope === 'PINNED') ?? []
    : [];
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
