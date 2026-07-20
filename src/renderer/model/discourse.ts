import type {
  ConversationContextReferenceSnapshot,
  DiscourseAgentJobRecord,
  DiscourseConcernRecord,
  DiscourseConversationAggregateRecord,
  DiscourseConversationSummary,
  DiscourseCorrectionOutcome,
  DiscourseDefaultPolicy,
  DiscourseDraftRecord,
  DiscourseDraftToken,
  DiscourseDraftTokenInput,
  DiscourseAgentSelectionInput,
  DiscourseContextSelection,
  DiscourseJobStatus,
  DiscourseMentionCatalogSnapshot,
  DiscourseMessageRecord,
  DiscourseResponseWaveRecord
} from '../../shared/discourse';
import type { AgentRuntimeCatalog } from '../../shared/agent';
import type {
  DiscourseComposerToken,
  DiscourseMentionCandidate
} from './discourseMentions';
import { repositoryDisplayPath } from './repositories';

export function discourseMentionCandidates(
  catalog: DiscourseMentionCatalogSnapshot,
  recent: readonly DiscourseDraftToken[] = []
): DiscourseMentionCandidate[] {
  const recentOrder = new Map(
    recent.map((token, index) => [`${token.kind}:${token.entityId}`, recent.length - index])
  );
  return [
    ...catalog.agents.map((entry): DiscourseMentionCandidate => ({
      kind: 'AGENT',
      id: entry.profile.id,
      label: entry.profile.displayName,
      description: entry.availability === 'AVAILABLE'
        ? `${roleLabel(entry.profile.roleTemplate)} · ${entry.resolvedSettings?.model ?? 'No model'}`
        : entry.unavailableReason ?? 'Agent unavailable',
      searchAliases: [
        entry.profile.roleTemplate,
        entry.resolvedSettings?.runtimeId ?? '',
        entry.resolvedSettings?.model ?? ''
      ],
      available: entry.availability === 'AVAILABLE',
      recentOrdinal: recentOrder.get(`AGENT:${entry.profile.id}`)
    })),
    ...catalog.tasks.map((task): DiscourseMentionCandidate => ({
      kind: 'TASK',
      id: task.id,
      label: task.title,
      description: `${shortId(task.id)} · ${task.repositoryName} · ${humanize(task.workflowPhase)}`,
      searchAliases: [task.id, task.repositoryName, task.workflowPhase],
      available: task.availability === 'AVAILABLE',
      recentOrdinal: recentOrder.get(`TASK:${task.id}`)
    })),
    ...catalog.repositories.map((repository): DiscourseMentionCandidate => ({
      kind: 'REPOSITORY',
      id: repository.id,
      label: repository.displayName,
      description: `${repositoryDisplayPath(repository.displayPath)} · ${repository.taskCount} task${repository.taskCount === 1 ? '' : 's'} · ${accessLabel(repository.accessMode)}`,
      searchAliases: [repository.id, repository.displayPath],
      available: repository.availability === 'AVAILABLE',
      recentOrdinal: recentOrder.get(`REPOSITORY:${repository.id}`)
    }))
  ];
}

export function eligibleDiscourseRuntimeCatalog(
  catalog: DiscourseMentionCatalogSnapshot
): AgentRuntimeCatalog {
  const runtimes = catalog.runtimeCatalog.runtimes.filter((runtime) => {
    const discourse = runtime.preflight.capabilities.extensions['task-monki.discourse'];
    return runtime.preflight.readiness.canStart &&
      discourse?.maturity === 'stable' &&
      runtime.preflight.capabilities.executionPolicy.presets.some(
        (preset) =>
          preset.sandbox === 'READ_ONLY' &&
          preset.networkAccess === 'DISABLED' &&
          preset.approvalPolicy.toLowerCase() === 'never'
      );
  });
  const runtimeIds = new Set(
    runtimes.map((runtime) => runtime.preflight.runtime.id)
  );
  return {
    ...catalog.runtimeCatalog,
    runtimes,
    models: catalog.runtimeCatalog.models.filter((model) => runtimeIds.has(model.runtimeId))
  };
}

export function defaultDiscourseAgentSelection(
  catalog: DiscourseMentionCatalogSnapshot,
  agentProfileId: DiscourseAgentSelectionInput['agentProfileId']
): DiscourseAgentSelectionInput {
  const resolved = catalog.agents.find(
    (entry) => entry.profile.id === agentProfileId
  )?.resolvedSettings;
  return {
    agentProfileId,
    ...(resolved
      ? {
          runtimeId: resolved.runtimeId,
          modelId: resolved.modelId,
          ...(resolved.reasoningEffort
            ? { reasoningEffort: resolved.reasoningEffort }
            : {})
        }
      : {})
  };
}

export function discourseAgentSelectionFromCurrentRevision(
  aggregate: DiscourseConversationAggregateRecord | undefined,
  catalog: DiscourseMentionCatalogSnapshot,
  agentProfileId: DiscourseAgentSelectionInput['agentProfileId']
): DiscourseAgentSelectionInput | undefined {
  const participant = aggregate?.participants.find(
    (candidate) => candidate.enabled && candidate.agentProfileId === agentProfileId
  );
  const revision = participant
    ? aggregate?.participantRevisions.find(
        (candidate) => candidate.id === participant.currentRevisionId
      )
    : undefined;
  if (!revision) return undefined;
  const model = catalog.runtimeCatalog.models.find(
    (candidate) =>
      candidate.runtimeId === revision.runtimeId &&
      candidate.model === revision.model &&
      (candidate.modelProvider ?? candidate.runtimeId) === revision.modelProvider
  );
  return {
    agentProfileId,
    runtimeId: revision.runtimeId,
    ...(model ? { modelId: model.id } : {}),
    ...(revision.reasoningEffort
      ? { reasoningEffort: revision.reasoningEffort }
      : {})
  };
}

export function currentDiscourseParticipantRevisions(
  aggregate: DiscourseConversationAggregateRecord | undefined
) {
  if (!aggregate) return [];
  return aggregate.participants
    .filter((participant) => participant.enabled)
    .flatMap((participant) => {
      const revision = aggregate.participantRevisions.find(
        (candidate) => candidate.id === participant.currentRevisionId
      );
      return revision ? [revision] : [];
    });
}

export function interruptedDiscourseAcceptedSends(
  aggregate: DiscourseConversationAggregateRecord | undefined
) {
  if (!aggregate) return [];
  const plannedMessageIds = new Set(
    aggregate.waves.map((wave) => wave.triggerMessageId)
  );
  return aggregate.acceptedSends.filter(
    (accepted) =>
      accepted.status === 'PENDING' &&
      !plannedMessageIds.has(accepted.triggerMessageId)
  );
}

export function discourseAcceptedSendForClientMessage(
  aggregate: DiscourseConversationAggregateRecord,
  clientMessageId: string
) {
  return aggregate.acceptedSends.find(
    (accepted) => accepted.clientMessageId === clientMessageId
  );
}

export function discourseClientMessageWasPersisted(
  aggregate: DiscourseConversationAggregateRecord,
  messages: readonly DiscourseMessageRecord[],
  clientMessageId: string
): boolean {
  return aggregate.acceptedSends.some(
    (accepted) => accepted.clientMessageId === clientMessageId
  ) || messages.some(
    (message) =>
      message.author.kind === 'USER' &&
      message.clientMessageId === clientMessageId
  );
}

export function discourseDraftsAlreadySent(
  aggregate: DiscourseConversationAggregateRecord,
  messages: readonly DiscourseMessageRecord[],
  drafts: readonly DiscourseDraftRecord[]
): DiscourseDraftRecord[] {
  return drafts.filter(
    (draft) =>
      draft.pendingClientMessageId !== undefined &&
      discourseClientMessageWasPersisted(
        aggregate,
        messages,
        draft.pendingClientMessageId
      )
  );
}

/**
 * An empty first-send shell is disposable only while no durable draft still
 * points at it. Keeping that ownership check in the renderer model prevents a
 * navigation cleanup from making a successfully checkpointed message
 * unreachable.
 */
export function canDeleteAbandonedDiscourseShell(input: {
  conversationId: string;
  latestOrdinal: number;
  drafts: readonly DiscourseDraftRecord[];
}): boolean {
  return input.latestOrdinal === 0 && !input.drafts.some(
    (draft) => draft.conversationId === input.conversationId
  );
}

/**
 * A replacement must replay an unresolved create operation before moving on.
 * That turns a lost create response into a known shell ID which remains owned
 * until the replacement draft is durable and cleanup succeeds.
 */
export async function recoverPendingDiscourseCreateForReplacement(input: {
  pending: {
    clientOperationId: string;
    supersededConversationIds?: readonly string[];
    createRequest: {
      title: string;
      defaultPolicy: DiscourseDefaultPolicy;
      agents: readonly DiscourseAgentSelectionInput[];
    };
  };
  replay(request: {
    title: string;
    defaultPolicy: DiscourseDefaultPolicy;
    agents: DiscourseAgentSelectionInput[];
    clientOperationId: string;
  }): Promise<{ id: string }>;
}): Promise<string[]> {
  const recovered = await input.replay({
    title: input.pending.createRequest.title,
    defaultPolicy: input.pending.createRequest.defaultPolicy,
    agents: input.pending.createRequest.agents.map((agent) => ({ ...agent })),
    clientOperationId: input.pending.clientOperationId
  });
  return [...new Set([
    ...(input.pending.supersededConversationIds ?? []),
    recovered.id
  ])];
}

/** Stable UI retry identity; unchanged failed sends reuse one durable client message id. */
export function discoursePendingSendFingerprint(input: {
  body: string;
  replyToMessageId?: string;
  supersedesMessageId?: string;
  sourceMessageIds: readonly string[];
  context: readonly DiscourseContextSelection[];
  policy: DiscourseDefaultPolicy;
  agents: readonly DiscourseAgentSelectionInput[];
}): string {
  return JSON.stringify({
    body: input.body,
    replyToMessageId: input.replyToMessageId ?? null,
    supersedesMessageId: input.supersedesMessageId ?? null,
    sourceMessageIds: input.sourceMessageIds,
    context: input.context,
    policy: input.policy,
    agents: input.agents.map((selection) => ({
      agentProfileId: selection.agentProfileId,
      runtimeId: selection.runtimeId ?? null,
      modelId: selection.modelId ?? null,
      reasoningEffort: selection.reasoningEffort ?? null
    }))
  });
}

export function currentPinnedContext(
  aggregate: DiscourseConversationAggregateRecord | undefined
): ConversationContextReferenceSnapshot[] {
  const revisionId = aggregate?.conversation.pinnedContextRevisionId;
  if (!aggregate || !revisionId) return [];
  return aggregate.contextRevisions.find((revision) => revision.id === revisionId)?.references
    .filter((reference) => reference.scope === 'PINNED') ?? [];
}

export function messageContext(
  aggregate: DiscourseConversationAggregateRecord | undefined,
  message: DiscourseMessageRecord
): ConversationContextReferenceSnapshot[] {
  if (!aggregate || !message.contextRevisionId) return [];
  return aggregate.contextRevisions.find((revision) => revision.id === message.contextRevisionId)?.references ?? [];
}

export function findReplyTarget(
  messages: readonly DiscourseMessageRecord[],
  message: DiscourseMessageRecord
): DiscourseMessageRecord | undefined {
  return message.replyToMessageId
    ? messages.find((candidate) => candidate.id === message.replyToMessageId)
    : undefined;
}

export function visibleConversationSummaries(
  conversations: readonly DiscourseConversationSummary[],
  query: string
): DiscourseConversationSummary[] {
  const normalized = normalize(query);
  return conversations.filter((conversation) =>
    !normalized || normalize(conversation.title).includes(normalized)
  );
}

export function composerTokensFromDraft(
  tokens: readonly DiscourseDraftToken[]
): DiscourseComposerToken[] {
  return tokens.map((token) => ({
    key: `${token.kind}:${token.entityId}`,
    kind: token.kind,
    entityId: token.entityId,
    labelSnapshot: token.labelSnapshot,
    available: true
  }));
}

export function draftTokensFromComposer(
  tokens: readonly DiscourseComposerToken[]
): DiscourseDraftTokenInput[] {
  return tokens.map((token) => ({
    kind: token.kind,
    entityId: token.entityId,
    labelSnapshot: token.labelSnapshot
  }));
}

export function shouldShowNewResponses(input: {
  wasNearBottom: boolean;
  previousLatestOrdinal: number;
  nextLatestOrdinal: number;
}): boolean {
  return !input.wasNearBottom && input.nextLatestOrdinal > input.previousLatestOrdinal;
}

export function isNearScrollBottom(input: {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  threshold?: number;
}): boolean {
  return input.scrollHeight - input.scrollTop - input.clientHeight <= (input.threshold ?? 72);
}

export function messageAuthorLabel(message: DiscourseMessageRecord): string {
  if (message.author.kind === 'USER') return 'You';
  if (message.author.kind === 'AGENT') return message.author.displayNameSnapshot;
  return 'Task Monki';
}

/**
 * A normal completed answer is already durable as a transcript message. Team
 * review results and incomplete outcomes are not, so keep their receipts in
 * view even after a later answer wave settles. Only the first non-settled wave
 * is shown because later waves are represented by its queued-follow-up count.
 */
export function visibleDiscourseResponseWaves(
  aggregate: Pick<DiscourseConversationAggregateRecord, 'waves'>
): DiscourseResponseWaveRecord[] {
  const currentWave = aggregate.waves.find((wave) => wave.status !== 'SETTLED');
  return aggregate.waves.filter((wave) =>
    wave.id === currentWave?.id ||
    (wave.status === 'SETTLED' && (wave.policy === 'TEAM' || wave.outcome !== 'COMPLETE'))
  );
}

export interface DiscourseResponseWavePlacement {
  wave: DiscourseResponseWaveRecord;
  afterMessageId: string;
}

/**
 * Place each receipt beside the newest loaded message produced by its wave, or
 * beside the triggering user message before any output exists. Historical
 * receipts whose messages are outside the current page wait for that page to
 * load instead of appearing detached beneath unrelated newer answers.
 */
export function visibleDiscourseResponseWavePlacements(
  aggregate: Pick<DiscourseConversationAggregateRecord, 'waves'>,
  messages: readonly DiscourseMessageRecord[]
): DiscourseResponseWavePlacement[] {
  return visibleDiscourseResponseWaves(aggregate).flatMap((wave) => {
    const waveMessage = messages.reduce<DiscourseMessageRecord | undefined>(
      (latest, message) =>
        message.waveId === wave.id && (!latest || message.ordinal > latest.ordinal)
          ? message
          : latest,
      undefined
    );
    const anchor = waveMessage ?? messages.find((message) => message.id === wave.triggerMessageId);
    return anchor ? [{ wave, afterMessageId: anchor.id }] : [];
  });
}

export function discourseJobStatusLabel(status: DiscourseJobStatus): string {
  switch (status) {
    case 'QUEUED': return 'Waiting to start';
    case 'RESOLVING_CONTEXT': return 'Preparing context';
    case 'STARTING': return 'Starting response';
    case 'RUNNING': return 'Responding';
    case 'CANCEL_REQUESTED': return 'Stopping';
    case 'RECOVERY_REQUIRED': return 'Needs attention';
    case 'COMPLETED': return 'Completed';
    case 'FAILED': return 'Failed';
    case 'CANCELED': return 'Canceled';
    case 'CONTEXT_STALE': return 'Context changed';
  }
}

export function discourseReviewResultLabel(job: DiscourseAgentJobRecord): string {
  if (job.status === 'FAILED') return 'Review failed';
  if (job.status === 'CANCELED') return 'Review canceled';
  if (job.status === 'CONTEXT_STALE') return 'Context changed';
  if (job.result?.kind === 'REVIEW') {
    switch (job.result.outcome) {
      case 'NO_CONCERN_FOUND': return 'No material concerns';
      case 'CONCERNS': return `${job.result.concernIds.length} concern${job.result.concernIds.length === 1 ? '' : 's'}`;
      case 'ABSTAINED': return 'Abstained';
    }
  }
  switch (job.status) {
    case 'COMPLETED': return 'Review result unavailable';
    case 'RUNNING': return 'Reviewing';
    default: return discourseJobStatusLabel(job.status);
  }
}

export function discourseCorrectionOutcomeLabel(
  outcome: DiscourseCorrectionOutcome
): string {
  switch (outcome) {
    case 'REVISED': return 'Revised';
    case 'DEFENDED': return 'Defended';
    case 'PARTIALLY_REVISED': return 'Partially revised';
    case 'ACKNOWLEDGED_UNRESOLVED': return 'Unresolved';
    case 'ABSTAINED': return 'Correction abstained';
  }
}

export function discourseConcernResolutionLabel(
  concern: DiscourseConcernRecord
): string | undefined {
  return concern.resolution
    ? discourseCorrectionOutcomeLabel(concern.resolution.outcome)
    : undefined;
}

export function discourseTeamCompletionSummary(input: {
  jobs: readonly DiscourseAgentJobRecord[];
  concerns: readonly DiscourseConcernRecord[];
}): { label: string; detail: string } {
  const correction = input.jobs.find(
    (job) => job.role === 'CORRECT' && job.result?.kind === 'CORRECTION'
  );
  const outcome = correction?.result?.kind === 'CORRECTION'
    ? correction.result.outcome
    : input.concerns.find((concern) => concern.resolution)?.resolution?.outcome;
  const concernCount = input.concerns.length;
  const concernSubject = `${concernCount} structured concern${concernCount === 1 ? '' : 's'}`;

  switch (outcome) {
    case 'REVISED':
      return { label: 'Answer revised', detail: `${concernSubject} reviewed; Lead revised the answer.` };
    case 'DEFENDED':
      return { label: 'Answer defended', detail: `${concernSubject} reviewed; Lead defended the original answer.` };
    case 'PARTIALLY_REVISED':
      return {
        label: 'Answer partially revised',
        detail: `${concernSubject} reviewed; Lead revised part of the answer and the remaining disagreement stays visible.`
      };
    case 'ACKNOWLEDGED_UNRESOLVED':
      return {
        label: concernCount === 1 ? 'Concern unresolved' : 'Concerns unresolved',
        detail: `${concernSubject} reviewed; Lead acknowledged the unresolved disagreement.`
      };
    case 'ABSTAINED':
      return {
        label: 'Correction abstained',
        detail: `${concernSubject} reviewed; Lead did not issue a correction.`
      };
  }

  if (concernCount === 0) {
    return {
      label: 'Review complete',
      detail: 'Skeptic and Verifier found no material concerns with complete access.'
    };
  }
  const correctionRequired = input.concerns.some((concern) =>
    !concern.redundantOfConcernId &&
    concern.requiredAccessAvailable &&
    (concern.severity === 'MATERIAL' || concern.severity === 'BLOCKING')
  );
  return correctionRequired
    ? {
        label: 'Review complete',
        detail: `${concernSubject} recorded; the correction outcome is unavailable.`
      }
    : {
        label: 'Review complete',
        detail: `${concernSubject} recorded; no automatic correction was required.`
      };
}

export function discourseTerminalJobDetail(
  jobs: readonly DiscourseAgentJobRecord[]
): string | undefined {
  const failedWithError = jobs.find((job) => job.error);
  if (failedWithError?.error) {
    return discourseErrorDetail(failedWithError);
  }
  const terminal = jobs.find((job) =>
    job.status === 'FAILED' || job.status === 'CANCELED' || job.status === 'CONTEXT_STALE'
  );
  if (!terminal) return undefined;
  const work = terminal.role === 'CRITIQUE'
    ? 'review'
    : terminal.role === 'CORRECT'
      ? 'correction'
      : 'response';
  switch (terminal.status) {
    case 'FAILED': return `${terminal.assignment.displayNameSnapshot}'s ${work} failed.`;
    case 'CANCELED': return `${terminal.assignment.displayNameSnapshot}'s ${work} was canceled.`;
    case 'CONTEXT_STALE': return `${terminal.assignment.displayNameSnapshot}'s ${work} used changed context and was not accepted.`;
    default: return undefined;
  }
}

/**
 * Stored errors keep exact runtime diagnostics for recovery and debugging, but
 * the normal conversation UI must not expose provider implementation details.
 * Translate the durable code into stable, actionable product language here.
 */
function discourseErrorDetail(job: DiscourseAgentJobRecord): string {
  switch (job.error!.code) {
    case 'CONTEXT_UNAVAILABLE':
      return 'The selected context could not be prepared for this response.';
    case 'CONTEXT_UNSAFE':
      return 'The selected context did not pass the read-only safety checks.';
    case 'CONTEXT_TOO_LARGE':
      return 'The selected context is too large for this response.';
    case 'CONTEXT_CHANGED':
      return 'The selected context changed before this response could be accepted.';
    case 'PERMISSION_ATTESTATION_FAILED':
      return 'The selected agent could not confirm the required read-only access policy.';
    case 'PROVIDER_UNAVAILABLE':
      return 'The selected agent is unavailable. Check its connection in Settings, then try again.';
    case 'PROVIDER_INTERACTION_UNSUPPORTED':
      return 'This response needed an interaction that Discourse does not allow.';
    case 'DELIVERY_NOT_CONFIRMED':
    case 'DELIVERY_AMBIGUOUS':
      return 'Task Monki could not confirm whether this response reached the agent. Stop it before trying again.';
    case 'INVALID_RESULT':
      return 'The agent returned a response that could not be used. Try again.';
    case 'OUTPUT_MISSING':
      return 'The agent finished without a usable response. Try again.';
    case 'INTERNAL_FAILURE':
      return 'Task Monki could not complete this response. Try again.';
  }
}

function roleLabel(value: string): string {
  return value.charAt(0) + value.slice(1).toLocaleLowerCase('en-US');
}

function accessLabel(value: string): string {
  return value === 'FILESYSTEM_READ'
    ? 'read-only files'
    : value === 'METADATA_ONLY'
      ? 'metadata only'
      : 'unavailable';
}

function humanize(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/_/gu, ' ');
}

function shortId(value: string): string {
  return `#${value.slice(-7)}`;
}

function normalize(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}+/gu, '').toLocaleLowerCase('en-US').trim();
}
