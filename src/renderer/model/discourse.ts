import type {
  ConversationContextReferenceSnapshot,
  DiscourseAgentJobRecord,
  DiscourseConcernRecord,
  DiscourseConversationAggregateRecord,
  DiscourseConversationSummary,
  DiscourseCorrectionOutcome,
  DiscourseDraftToken,
  DiscourseDraftTokenInput,
  DiscourseJobStatus,
  DiscourseMentionCatalogSnapshot,
  DiscourseMessageRecord,
  DiscourseResponseWaveRecord
} from '../../shared/discourse';
import type {
  DiscourseComposerToken,
  DiscourseMentionCandidate
} from './discourseMentions';

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
        ? `${roleLabel(entry.profile.roleTemplate)} · ${entry.resolvedSettings?.model ?? entry.profile.providerId}`
        : entry.unavailableReason ?? 'Agent unavailable',
      searchAliases: [entry.profile.roleTemplate, entry.profile.providerId, entry.resolvedSettings?.model ?? ''],
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
      description: `${repository.displayPath} · ${repository.taskCount} task${repository.taskCount === 1 ? '' : 's'} · ${accessLabel(repository.accessMode)}`,
      searchAliases: [repository.id, repository.displayPath],
      available: repository.availability === 'AVAILABLE',
      recentOrdinal: recentOrder.get(`REPOSITORY:${repository.id}`)
    }))
  ];
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
    case 'QUEUED': return 'Waiting for runtime';
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
  const failedWithError = jobs.find((job) => job.error)?.error;
  if (failedWithError) return failedWithError.message;
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
