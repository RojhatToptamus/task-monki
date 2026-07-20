import crypto, { randomUUID } from 'node:crypto';
import type { AgentRuntimeCatalog, TaskManagerAppSettings } from '../../shared/agent';
import { DISCOURSE_LIMITS } from '../../shared/discourse';
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
  GetDiscourseMessageByClientIdRequest,
  DiscourseMessageRecord,
  DiscourseAgentJobRecord,
  DiscourseAgentSelectionInput,
  DiscourseAcceptedSendRecord,
  DiscourseParticipantRecord,
  DiscourseParticipantRevisionRecord,
  DiscourseResponseWaveRecord,
  ListDiscourseConversationsRequest,
  ListDiscourseMessagesRequest,
  PreviewDiscourseContextRequest,
  RenameDiscourseConversationRequest,
  SaveDiscourseDraftRequest,
  ResumeDiscourseAcceptedSendRequest,
  CancelDiscourseAcceptedSendRequest,
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
import {
  AgentProfileCatalog,
  discourseModelMatches,
  discourseRuntimeUnavailableReason
} from './AgentProfileCatalog';
import type { DiscourseContextSnapshotService } from './DiscourseContextSnapshotService';
import type { DiscourseContextResolver } from './DiscourseContextResolver';
import {
  DiscourseRuntimeCoordinator,
  discourseRuntimeSessionId
} from './DiscourseRuntimeCoordinator';
import {
  appendDiscourseSystemContext,
  assembleDiscoursePrompt
} from './DiscoursePromptBuilder';
import {
  assertDiscoursePolicyRoster,
  deriveDiscourseWaveAggregate
} from './DiscourseState';
import type { DiscourseStore } from './DiscourseStore';

export interface DiscourseServiceOptions {
  getRuntimeCatalog(): Promise<AgentRuntimeCatalog> | AgentRuntimeCatalog;
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

  async getMessageByClientId(
    input: GetDiscourseMessageByClientIdRequest
  ): Promise<DiscourseMessageRecord | null> {
    return (await this.store.getMessageByClientId(input)) ?? null;
  }

  async getMentionCatalog(): Promise<DiscourseMentionCatalogSnapshot> {
    const [runtimeCatalog, settings, contextCatalog] = await Promise.all([
      this.options.getRuntimeCatalog(),
      this.options.getAppSettings(),
      this.context.catalogEntries()
    ]);
    const agents = this.profiles.list(runtimeCatalog, {
      defaultRuntimeId: settings.defaultRuntimeId,
      defaultModel: settings.defaultModel,
      defaultModelProvider: settings.defaultModelProvider,
      defaultReasoningEffort: settings.defaultReasoningEffort
    }).profiles;
    return {
      agents,
      runtimeCatalog,
      tasks: contextCatalog.tasks,
      repositories: contextCatalog.repositories,
      refreshedAt: this.now()
    };
  }

  async createConversation(
    input: CreateDiscourseConversationRequest
  ): Promise<DiscourseConversationRecord> {
    const selections = validateAgentSelections(input.defaultPolicy, input.agents);
    const requestFingerprint = discourseCreateRequestFingerprint(input, selections);
    const replay = await this.store.findCreatedConversation({
      clientOperationId: input.clientOperationId,
      requestFingerprint
    });
    if (replay) return replay;
    const [runtimeCatalog, settings] = await Promise.all([
      this.options.getRuntimeCatalog(),
      this.options.getAppSettings()
    ]);
    const profileCatalog = this.profiles.list(runtimeCatalog, {
      defaultRuntimeId: settings.defaultRuntimeId,
      defaultModel: settings.defaultModel,
      defaultModelProvider: settings.defaultModelProvider,
      defaultReasoningEffort: settings.defaultReasoningEffort
    });
    const now = this.now();
    const participants = selections.map((selection) => {
      const profileId = selection.agentProfileId;
      const entry = profileCatalog.profiles.find((candidate) => candidate.profile.id === profileId);
      if (!entry) throw new Error(`Unknown discourse agent profile: ${profileId}`);
      const resolved = this.profiles.resolveSelection(runtimeCatalog, selection, {
        defaultRuntimeId: settings.defaultRuntimeId,
        defaultModel: settings.defaultModel,
        defaultModelProvider: settings.defaultModelProvider,
        defaultReasoningEffort: settings.defaultReasoningEffort
      });
      const participantId = this.createId();
      const revisionId = this.createId();
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
          runtimeId: resolved.runtimeId,
          model: resolved.model,
          modelProvider: resolved.modelProvider,
          ...(resolved.reasoningEffort ? { reasoningEffort: resolved.reasoningEffort } : {}),
          ...(resolved.serviceTier ? { serviceTier: resolved.serviceTier } : {}),
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
      requestFingerprint,
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
      if (input.agents.length !== 0) {
        throw new Error('A human-only discourse message cannot select agent recipients.');
      }
      return {
        message: await this.appendHumanMessage(input),
        jobs: []
      };
    }
    const selections = validateAgentSelections(input.policy, input.agents);
    const profileIds = selections.map((selection) => selection.agentProfileId);
    if (!input.previewFingerprint) {
      throw new Error('An agent discourse response requires a current context preview.');
    }
    let aggregate = await this.store.getConversation(input.conversationId);
    const waveOperationId = `${input.clientMessageId}:wave`;
    const requestFingerprint = discourseSendRequestFingerprint(input, selections);
    const existingWave = aggregate.waves.find(
      (candidate) => candidate.clientOperationId === waveOperationId
    );
    if (existingWave) {
      if (existingWave.requestFingerprint !== requestFingerprint) {
        throw new Error('REQUEST_CONFLICT: discourse send operation changed.');
      }
      const message = await this.findMessage(existingWave.triggerMessageId, input.conversationId);
      const runtime = this.options.runtime;
      if (runtime) {
        await this.recoverAndAdvanceUnlocked(
          input.conversationId,
          `${existingWave.clientOperationId}:retry-recovery`
        );
        aggregate = await this.store.getConversation(input.conversationId);
      }
      const recoveredWave = requireWave(aggregate.waves, existingWave.id);
      return {
        message,
        wave: recoveredWave,
        jobs: aggregate.jobs.filter((job) => job.waveId === recoveredWave.id)
      };
    }
    const acceptedReplay = aggregate.acceptedSends.find(
      (candidate) => candidate.clientMessageId === input.clientMessageId
    );
    if (acceptedReplay) {
      if (acceptedReplay.requestFingerprint !== requestFingerprint) {
        throw new Error('REQUEST_CONFLICT: discourse send operation changed.');
      }
      if (acceptedReplay.status === 'CANCELED') {
        throw new Error('This interrupted agent response was canceled. Send a new message instead.');
      }
      const message = await this.findMessage(
        acceptedReplay.triggerMessageId,
        input.conversationId
      );
      return this.planAcceptedSend(aggregate, message, acceptedReplay);
    }
    if (!this.options.runtime) throw new Error('Discourse agent execution is not configured.');
    const [runtimeCatalog, settings] = await Promise.all([
      this.options.getRuntimeCatalog(),
      this.options.getAppSettings()
    ]);
    const catalogSettings = {
      defaultRuntimeId: settings.defaultRuntimeId,
      defaultModel: settings.defaultModel,
      defaultModelProvider: settings.defaultModelProvider,
      defaultReasoningEffort: settings.defaultReasoningEffort
    };
    const profileCatalog = this.profiles.list(runtimeCatalog, catalogSettings);
    const entries = new Map<BuiltInAgentProfileId, AgentProfileCatalogEntry>();
    const resolvedSelections = new Map<
      BuiltInAgentProfileId,
      NonNullable<AgentProfileCatalogEntry['resolvedSettings']>
    >();
    for (const selection of selections) {
      const profileId = selection.agentProfileId;
      const entry = profileCatalog.profiles.find((candidate) => candidate.profile.id === profileId);
      if (!entry || entry.availability !== 'AVAILABLE') {
        throw new Error(entry?.unavailableReason ?? `Agent profile is unavailable: ${profileId}`);
      }
      entries.set(profileId, entry);
      const existing = aggregate.participants.find(
        (participant) => participant.agentProfileId === profileId && participant.enabled
      );
      let currentRevision: DiscourseParticipantRevisionRecord | undefined;
      if (existing) {
        currentRevision = aggregate.participantRevisions.find(
          (candidate) => candidate.id === existing.currentRevisionId
        );
        if (!currentRevision) {
          throw new Error(`Discourse participant revision is missing: ${profileId}`);
        }
      }
      let resolved: NonNullable<AgentProfileCatalogEntry['resolvedSettings']>;
      if (currentRevision && !selection.runtimeId && !selection.modelId) {
        assertParticipantRevisionAvailable(entry, currentRevision, runtimeCatalog);
        resolved = resolvedSettingsFromRevision(currentRevision, runtimeCatalog);
      } else {
        resolved = this.profiles.resolveSelection(runtimeCatalog, selection, catalogSettings);
        if (currentRevision) {
          resolved = preserveCurrentImplicitSettings(
            currentRevision,
            selection,
            resolved,
            runtimeCatalog
          );
        }
      }
      resolvedSelections.set(profileId, resolved);
      if (currentRevision && participantSettingsMatch(currentRevision, resolved)) {
        assertParticipantRevisionAvailable(entry, currentRevision, runtimeCatalog);
      }
    }
    const context = await this.context.resolveSelections(input.context ?? []);
    const priorTranscript = (
      await this.store.listMessages({
        conversationId: input.conversationId,
        limit: DISCOURSE_LIMITS.maxRecentTranscriptMessages - 1
      })
    ).messages;
    const configuration = this.buildParticipantConfiguration(
      aggregate,
      profileIds,
      entries,
      resolvedSelections
    );
    const projectedAggregate = projectParticipantConfiguration(aggregate, configuration);
    const assignments = assignmentsFromRoster(projectedAggregate, input.policy, profileIds);
    const accepted = await this.store.acceptAgentSend({
      conversationId: input.conversationId,
      body: input.body,
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
      ...(input.supersedesMessageId
        ? { supersedesMessageId: input.supersedesMessageId }
        : {}),
      ...(input.sourceMessageIds ? { sourceMessageIds: input.sourceMessageIds } : {}),
      context: context.map((reference) => reference.snapshot),
      clientMessageId: input.clientMessageId,
      participants: configuration.participants,
      participantRevisions: configuration.participantRevisions,
      expectedRevision: aggregate.conversation.recordRevision,
      policy: input.policy,
      assignments,
      priorVisibleMessageIds: priorTranscript.map((candidate) => candidate.id),
      previewFingerprint: input.previewFingerprint,
      requestFingerprint
    });
    return this.planAcceptedSend(
      accepted.aggregate,
      accepted.message,
      accepted.acceptedSend
    );
  }

  private async planAcceptedSend(
    aggregate: DiscourseConversationAggregateRecord,
    message: DiscourseMessageRecord,
    accepted: DiscourseAcceptedSendRecord
  ): Promise<SendDiscourseMessageResult> {
    const runtime = this.options.runtime;
    if (!runtime) throw new Error('Discourse agent execution is not configured.');
    const waveOperationId = `${accepted.clientMessageId}:wave`;
    if (!message.contextRevisionId) {
      throw new Error('Discourse message context revision is missing.');
    }
    const contextRevision = aggregate.contextRevisions.find(
      (revision) => revision.id === message.contextRevisionId
    );
    if (!contextRevision) throw new Error('Discourse message context could not be loaded.');
    const assignments = accepted.assignments;
    const hasEarlierActiveWave = aggregate.waves.some((wave) => wave.status !== 'SETTLED');
    const now = this.now();
    const waveId = this.createId();
    const snapshotId = this.createId();
    const wave = {
      id: waveId,
      conversationId: accepted.conversationId,
      triggerMessageId: message.id,
      policy: accepted.policy,
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
      requestFingerprint: accepted.requestFingerprint,
      dispatchGate: {
        status: 'READY' as const,
        previewFingerprint: accepted.previewFingerprint,
        confirmedAtRevision: aggregate.conversation.recordRevision
      },
      createdAt: now
    };
    if (accepted.status !== 'PENDING') {
      throw new Error('This interrupted agent response is no longer pending.');
    }
    const transcript = await this.findMessages(
      accepted.visibleMessageIds,
      accepted.conversationId
    );
    const answerAssignments = accepted.policy === 'TEAM'
      ? assignments.filter((assignment) => assignment.assignmentRole === 'PRIMARY')
      : assignments;
    const jobs = answerAssignments.map((assignment): DiscourseAgentJobRecord => {
      const jobId = this.createId();
      return {
        id: jobId,
        conversationId: accepted.conversationId,
        waveId,
        assignment,
        role: 'ANSWER',
        phase: 1,
        targetMessageIds: [message.id],
        visibleMessageIds: [...accepted.visibleMessageIds],
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
      conversationId: accepted.conversationId,
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
    const plannedWave = prepared.preview.fingerprint === accepted.previewFingerprint
      ? wave
      : {
          ...wave,
          dispatchGate: {
            status: 'RECONFIRMATION_REQUIRED' as const,
            previewFingerprint: accepted.previewFingerprint,
            currentFingerprint: prepared.preview.fingerprint,
            mismatchReason: 'Selected context changed after the preview.'
          }
        };
    await this.store.createWave({
      conversationId: accepted.conversationId,
      expectedConversationRevision: aggregate.conversation.recordRevision,
      wave: plannedWave,
      jobs,
      contextSnapshot: prepared.snapshot,
      clientOperationId: waveOperationId
    });
    this.emit('discourse.message.appended', accepted.conversationId, message);
    this.emit('discourse.wave.updated', accepted.conversationId, plannedWave);
    if (prepared.snapshot.status === 'BLOCKED') {
      const settled = await this.settleBlockedContextWave(
        accepted.conversationId,
        plannedWave,
        jobs,
        prepared.snapshot,
        waveOperationId
      );
      const failed = (await this.store.getConversation(accepted.conversationId)).jobs.filter(
        (job) => job.waveId === plannedWave.id
      );
      failed.forEach((job) => this.emit('discourse.job.updated', accepted.conversationId, job));
      this.emit('discourse.wave.updated', accepted.conversationId, settled);
      return { message, wave: settled, jobs: failed };
    }
    if (
      !hasEarlierActiveWave &&
      plannedWave.dispatchGate.status === 'READY' &&
      prepared.executionContext
    ) {
      const plannedAggregate = await this.store.getConversation(accepted.conversationId);
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
            accepted.conversationId,
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
          conversationId: accepted.conversationId,
          waveId,
          jobId: job.id,
          executionContext,
          prompt: bounded.prompt!,
          clientOperationId: prepareOperationId
        });
        preparedJobCount += 1;
        this.emit('discourse.job.updated', accepted.conversationId, runtimeJob.job);
      }
      if (preparedJobCount > 0) runtime.notifySchedulerWorkAvailable();
      await runtime.coordinator.reconcileWave(
        accepted.conversationId,
        waveId,
        `${waveOperationId}:prompt-budget`
      );
      const queuedAggregate = await this.store.getConversation(accepted.conversationId);
      return {
        message,
        wave: queuedAggregate.waves.find((candidate) => candidate.id === waveId)!,
        jobs: queuedAggregate.jobs.filter((candidate) => candidate.waveId === waveId)
      };
    }
    return { message, wave: plannedWave, jobs };
  }

  resumeAcceptedSend(
    input: ResumeDiscourseAcceptedSendRequest
  ): Promise<SendDiscourseMessageResult> {
    return this.withConversationMutation(input.conversationId, async () => {
      let aggregate = await this.store.getConversation(input.conversationId);
      const accepted = aggregate.acceptedSends.find(
        (candidate) => candidate.id === input.acceptedSendId
      );
      if (!accepted || accepted.status !== 'PENDING') {
        throw new Error('The interrupted agent response is no longer pending.');
      }
      const existingWave = aggregate.waves.find(
        (wave) => wave.triggerMessageId === accepted.triggerMessageId
      );
      const message = await this.findMessage(
        accepted.triggerMessageId,
        input.conversationId
      );
      if (existingWave) {
        const runtime = this.options.runtime;
        if (runtime) {
          await this.recoverAndAdvanceUnlocked(
            input.conversationId,
            `${existingWave.clientOperationId}:explicit-resume`
          );
          aggregate = await this.store.getConversation(input.conversationId);
        }
        const wave = requireWave(aggregate.waves, existingWave.id);
        return {
          message,
          wave,
          jobs: aggregate.jobs.filter((job) => job.waveId === wave.id)
        };
      }
      return this.planAcceptedSend(aggregate, message, accepted);
    });
  }

  cancelAcceptedSend(
    input: CancelDiscourseAcceptedSendRequest
  ): Promise<DiscourseConversationAggregateRecord> {
    return this.withConversationMutation(input.conversationId, async () => {
      const aggregate = await this.store.cancelAcceptedSend({
        conversationId: input.conversationId,
        acceptedSendId: input.acceptedSendId,
        expectedConversationRevision: input.expectedConversationRevision,
        clientOperationId: input.clientOperationId
      });
      this.emit('discourse.summary.updated', input.conversationId, aggregate.conversation);
      return aggregate;
    });
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
    return this.withConversationMutation(conversationId, async () => {
      let aggregate = await this.store.getConversation(conversationId);
      const waveTriggerIds = new Set(
        aggregate.waves.map((wave) => wave.triggerMessageId)
      );
      for (const accepted of aggregate.acceptedSends) {
        if (accepted.status !== 'PENDING' || waveTriggerIds.has(accepted.triggerMessageId)) {
          continue;
        }
        const message = await this.findMessage(accepted.triggerMessageId, conversationId);
        try {
          await this.planAcceptedSend(aggregate, message, accepted);
        } catch {
          // The accepted user message and response intent remain durable. A
          // later explicit retry or startup pass can resume planning without
          // duplicating the message; one transient context/runtime failure
          // must not prevent the rest of Task Monki from starting.
          continue;
        }
        aggregate = await this.store.getConversation(conversationId);
        waveTriggerIds.add(accepted.triggerMessageId);
      }
      return this.recoverAndAdvanceUnlocked(
        conversationId,
        `service-recovery:${conversationId}`
      );
    });
  }

  private async recoverAndAdvanceUnlocked(
    conversationId: string,
    clientOperationId: string
  ): Promise<DiscourseResponseWaveRecord | undefined> {
    const runtime = this.options.runtime;
    if (!runtime) return undefined;
    await runtime.coordinator.recoverConversation(conversationId);
    const aggregate = await this.store.getConversation(conversationId);
    const activeWave = aggregate.waves.find((candidate) => candidate.status !== 'SETTLED');
    if (activeWave) {
      await this.advanceWaveUnlocked(
        conversationId,
        activeWave.id,
        `${clientOperationId}:advance`
      );
    }
    return this.activateNextWave(conversationId, `${clientOperationId}:next`);
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
        const jobs = aggregate.jobs.filter((job) => job.waveId === wave.id);
        await this.markQueuedJobsContextStale(
          input.conversationId,
          jobs,
          `${input.clientOperationId}:context-stale`
        );
        wave = requireWave(
          (await this.store.getConversation(input.conversationId)).waves,
          wave.id
        );
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
    const assembly = appendDiscourseSystemContext(
      assembleDiscoursePrompt(input),
      await runtime.contextSnapshots.promptFilesystemGuide(input.snapshot)
    );
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

  private buildParticipantConfiguration(
    aggregate: DiscourseConversationAggregateRecord,
    profileIds: readonly BuiltInAgentProfileId[],
    entries: ReadonlyMap<BuiltInAgentProfileId, AgentProfileCatalogEntry>,
    resolvedSelections: ReadonlyMap<
      BuiltInAgentProfileId,
      NonNullable<AgentProfileCatalogEntry['resolvedSettings']>
    >
  ): {
    participants: DiscourseParticipantRecord[];
    participantRevisions: DiscourseParticipantRevisionRecord[];
  } {
    const participants: DiscourseParticipantRecord[] = [];
    const participantRevisions: DiscourseParticipantRevisionRecord[] = [];
    for (const profileId of profileIds) {
      const entry = entries.get(profileId);
      const resolved = resolvedSelections.get(profileId);
      if (!entry || entry.profile.id !== profileId || !resolved) {
        throw new Error(`Agent profile is unavailable: ${profileId}`);
      }
      const existing = aggregate.participants.find(
        (participant) => participant.agentProfileId === profileId && participant.enabled
      );
      if (existing) {
        const currentRevision = aggregate.participantRevisions.find(
          (revision) => revision.id === existing.currentRevisionId
        );
        if (!currentRevision) {
          throw new Error(`Discourse participant revision is missing: ${profileId}`);
        }
        if (participantSettingsMatch(currentRevision, resolved)) continue;
        const revisionId = this.createId();
        participants.push({
          ...existing,
          currentRevisionId: revisionId,
          recordRevision: existing.recordRevision + 1
        });
        participantRevisions.push(participantRevisionFromSettings({
          id: revisionId,
          conversationId: aggregate.conversation.id,
          participantId: existing.id,
          profileId,
          entry,
          resolved,
          revision: currentRevision.revision + 1,
          createdAt: this.now(),
          roleContractHash: sha256(this.profiles.roleContract(profileId))
        }));
        continue;
      }
      const now = this.now();
      const participantId = this.createId();
      const revisionId = this.createId();
      participants.push({
        id: participantId,
        conversationId: aggregate.conversation.id,
        agentProfileId: profileId,
        currentRevisionId: revisionId,
        enabled: true,
        recordRevision: 1,
        createdAt: now
      });
      participantRevisions.push(participantRevisionFromSettings({
        id: revisionId,
        conversationId: aggregate.conversation.id,
        participantId,
        profileId,
        entry,
        resolved,
        revision: 1,
        createdAt: now,
        roleContractHash: sha256(this.profiles.roleContract(profileId))
      }));
    }
    return { participants, participantRevisions };
  }

  private async findMessages(
    messageIds: readonly string[],
    conversationId: string
  ): Promise<DiscourseMessageRecord[]> {
    const wanted = new Set(messageIds);
    const found = new Map<string, DiscourseMessageRecord>();
    let beforeCursor: string | undefined;
    do {
      const page = await this.store.listMessages({
        conversationId,
        ...(beforeCursor ? { beforeCursor } : {}),
        limit: 100
      });
      for (const message of page.messages) {
        if (wanted.has(message.id)) found.set(message.id, message);
      }
      if (found.size === wanted.size) break;
      beforeCursor = page.previousCursor;
    } while (beforeCursor);
    const ordered = messageIds.flatMap((messageId) => {
      const message = found.get(messageId);
      return message ? [message] : [];
    });
    if (ordered.length !== messageIds.length) {
      throw new Error('The durable Discourse transcript window could not be recovered.');
    }
    return ordered;
  }

  private async findMessage(
    messageId: string,
    conversationId: string
  ): Promise<DiscourseMessageRecord> {
    let beforeCursor: string | undefined;
    do {
      const page = await this.store.listMessages({
        conversationId,
        ...(beforeCursor ? { beforeCursor } : {}),
        limit: 100
      });
      const message = page.messages.find((candidate) => candidate.id === messageId);
      if (message) return message;
      beforeCursor = page.previousCursor;
    } while (beforeCursor);
    throw new Error('The durable Discourse send message could not be recovered.');
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
      taskId: `discourse:${conversationId}`,
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
    runtimeId: revision.runtimeId,
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
  runtimeCatalog: AgentRuntimeCatalog
): void {
  const displayName = entry.profile.displayName;
  const runtime = runtimeCatalog.runtimes.find(
    (candidate) => candidate.preflight.runtime.id === revision.runtimeId
  );
  const runtimeUnavailable = discourseRuntimeUnavailableReason(runtime);
  if (runtimeUnavailable) {
    throw new Error(
      `${displayName} cannot respond through its saved provider. ${runtimeUnavailable} ` +
      'Choose another provider and model for this conversation.'
    );
  }
  const model = runtimeCatalog.models.find((candidate) =>
    candidate.runtimeId === revision.runtimeId && discourseModelMatches(candidate, revision)
  );
  if (!model) {
    throw new Error(
      `${displayName} cannot respond because its saved model (${revision.model}) is unavailable. ` +
      'Refresh agent models or choose another model for this conversation.'
    );
  }
  const modelProvider = model.modelProvider ?? model.runtimeId;
  if (revision.modelProvider !== modelProvider) {
    throw new Error(
      `${displayName} cannot respond because its saved model provider is no longer valid. ` +
      'Choose another model for this conversation.'
    );
  }
  if (
    revision.reasoningEffort &&
    revision.reasoningEffort !== model.defaultReasoningEffort &&
    !model.supportedReasoningEfforts.includes(revision.reasoningEffort)
  ) {
    throw new Error(
      `${displayName} cannot respond because ${revision.reasoningEffort} reasoning is no longer ` +
      `supported by ${revision.model}. Choose another reasoning level.`
    );
  }
  if (
    revision.serviceTier &&
    revision.serviceTier !== model.defaultServiceTier &&
    !model.serviceTiers.includes(revision.serviceTier)
  ) {
    throw new Error(
      `${displayName} cannot respond because its saved service tier is no longer supported. ` +
      'Choose another model for this conversation.'
    );
  }
}

function validateAgentSelections(
  policy: DiscourseDefaultPolicy,
  input: readonly DiscourseAgentSelectionInput[]
): DiscourseAgentSelectionInput[] {
  const ids = [...new Set(input.map((selection) => selection.agentProfileId))];
  if (ids.length !== input.length || ids.some((id) => !['builtin.lead', 'builtin.skeptic', 'builtin.verifier'].includes(id))) {
    throw new Error('Discourse participant roster is invalid.');
  }
  assertDiscoursePolicyRoster(policy, ids.length);
  if (policy === 'TEAM') {
    const team: BuiltInAgentProfileId[] = [
      'builtin.lead',
      'builtin.skeptic',
      'builtin.verifier'
    ];
    if (team.some((id) => !ids.includes(id))) {
      throw new Error('A Team response requires Lead, Skeptic, and Verifier.');
    }
    return team.map((profileId) => input.find(
      (selection) => selection.agentProfileId === profileId
    )!);
  }
  return [...input];
}

function discourseSendRequestFingerprint(
  input: SendDiscourseMessageRequest,
  selections: readonly DiscourseAgentSelectionInput[]
): string {
  return sha256(JSON.stringify({
    conversationId: input.conversationId,
    body: input.body,
    replyToMessageId: input.replyToMessageId ?? null,
    supersedesMessageId: input.supersedesMessageId ?? null,
    sourceMessageIds: input.sourceMessageIds ?? [],
    context: input.context ?? [],
    policy: input.policy,
    agents: selections.map((selection) => ({
      agentProfileId: selection.agentProfileId,
      runtimeId: selection.runtimeId ?? null,
      modelId: selection.modelId ?? null,
      reasoningEffort: selection.reasoningEffort ?? null
    })),
    previewFingerprint: input.previewFingerprint ?? null
  }));
}

function discourseCreateRequestFingerprint(
  input: CreateDiscourseConversationRequest,
  selections: readonly DiscourseAgentSelectionInput[]
): string {
  return sha256(JSON.stringify({
    title: input.title.trim(),
    defaultPolicy: input.defaultPolicy,
    agents: selections.map((selection) => ({
      agentProfileId: selection.agentProfileId,
      runtimeId: selection.runtimeId ?? null,
      modelId: selection.modelId ?? null,
      reasoningEffort: selection.reasoningEffort ?? null
    }))
  }));
}

function participantSettingsMatch(
  revision: DiscourseParticipantRevisionRecord,
  settings: NonNullable<AgentProfileCatalogEntry['resolvedSettings']>
): boolean {
  return revision.runtimeId === settings.runtimeId &&
    revision.model === settings.model &&
    revision.modelProvider === settings.modelProvider &&
    revision.reasoningEffort === settings.reasoningEffort &&
    revision.serviceTier === settings.serviceTier;
}

function projectParticipantConfiguration(
  aggregate: DiscourseConversationAggregateRecord,
  configuration: {
    participants: readonly DiscourseParticipantRecord[];
    participantRevisions: readonly DiscourseParticipantRevisionRecord[];
  }
): DiscourseConversationAggregateRecord {
  const replacements = new Map(
    configuration.participants.map((participant) => [participant.id, participant])
  );
  const existingIds = new Set(aggregate.participants.map((participant) => participant.id));
  return {
    ...aggregate,
    participants: [
      ...aggregate.participants.map(
        (participant) => replacements.get(participant.id) ?? participant
      ),
      ...configuration.participants.filter((participant) => !existingIds.has(participant.id))
    ],
    participantRevisions: [
      ...aggregate.participantRevisions,
      ...configuration.participantRevisions
    ]
  };
}

function resolvedSettingsFromRevision(
  revision: DiscourseParticipantRevisionRecord,
  runtimeCatalog: AgentRuntimeCatalog
): NonNullable<AgentProfileCatalogEntry['resolvedSettings']> {
  const model = runtimeCatalog.models.find((candidate) =>
    discourseModelMatches(candidate, revision)
  );
  if (!model) {
    throw new Error(`The saved Discourse model (${revision.model}) is unavailable.`);
  }
  return {
    runtimeId: revision.runtimeId,
    modelId: model.id,
    model: revision.model,
    modelProvider: revision.modelProvider,
    ...(revision.reasoningEffort
      ? { reasoningEffort: revision.reasoningEffort }
      : {}),
    ...(revision.serviceTier ? { serviceTier: revision.serviceTier } : {})
  };
}

function preserveCurrentImplicitSettings(
  revision: DiscourseParticipantRevisionRecord,
  selection: DiscourseAgentSelectionInput,
  resolved: NonNullable<AgentProfileCatalogEntry['resolvedSettings']>,
  runtimeCatalog: AgentRuntimeCatalog
): NonNullable<AgentProfileCatalogEntry['resolvedSettings']> {
  const selectedModel = runtimeCatalog.models.find(
    (model) => model.runtimeId === selection.runtimeId && model.id === selection.modelId
  );
  if (!selectedModel || !discourseModelMatches(selectedModel, revision)) return resolved;
  const next = { ...resolved };
  delete next.serviceTier;
  if (revision.serviceTier) next.serviceTier = revision.serviceTier;
  if (!selection.reasoningEffort) {
    delete next.reasoningEffort;
    if (revision.reasoningEffort) next.reasoningEffort = revision.reasoningEffort;
  }
  return next;
}

function participantRevisionFromSettings(input: {
  id: string;
  conversationId: string;
  participantId: string;
  profileId: BuiltInAgentProfileId;
  entry: AgentProfileCatalogEntry;
  resolved: NonNullable<AgentProfileCatalogEntry['resolvedSettings']>;
  revision: number;
  createdAt: string;
  roleContractHash: string;
}): DiscourseParticipantRevisionRecord {
  return {
    id: input.id,
    conversationId: input.conversationId,
    stableParticipantId: input.participantId,
    agentProfileId: input.profileId,
    profileRevision: input.entry.profile.revision,
    displayNameSnapshot: input.entry.profile.displayName,
    runtimeId: input.resolved.runtimeId,
    model: input.resolved.model,
    modelProvider: input.resolved.modelProvider,
    ...(input.resolved.reasoningEffort
      ? { reasoningEffort: input.resolved.reasoningEffort }
      : {}),
    ...(input.resolved.serviceTier
      ? { serviceTier: input.resolved.serviceTier }
      : {}),
    configuredRole: input.entry.profile.roleTemplate,
    roleContractVersion: input.entry.profile.roleContractVersion,
    roleContractHash: input.roleContractHash,
    revision: input.revision,
    createdAt: input.createdAt
  };
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
