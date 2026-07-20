import type {
  ContextSnapshotRecord,
  ContextSnapshotStatus,
  DiscourseAgentJobRecord,
  DiscourseConcernRecord,
  DiscourseDeliveryStatus,
  DiscourseJobResult,
  DiscourseJobStatus,
  DiscourseMessageRecord,
  DiscourseResponseWaveRecord,
  DiscourseWavePhase,
  DiscourseWaveOutcome,
  DiscourseWaveSettlementReason,
  DiscourseWaveStatus,
  StructuredDiscourseError
} from '../../shared/discourse';

const CONTEXT_TRANSITIONS: Readonly<Record<ContextSnapshotStatus, readonly ContextSnapshotStatus[]>> = {
  RESOLVING: ['READY', 'PARTIAL', 'BLOCKED'],
  READY: [],
  PARTIAL: [],
  BLOCKED: []
};

const WAVE_TRANSITIONS: Readonly<Record<DiscourseWaveStatus, readonly DiscourseWaveStatus[]>> = {
  PLANNED: ['SNAPSHOTTING', 'STOP_REQUESTED', 'SETTLED'],
  SNAPSHOTTING: ['QUEUED', 'STOP_REQUESTED', 'RECOVERY_REQUIRED', 'SETTLED'],
  QUEUED: ['RUNNING', 'STOP_REQUESTED', 'SETTLED'],
  RUNNING: ['STOP_REQUESTED', 'RECOVERY_REQUIRED', 'SETTLED'],
  STOP_REQUESTED: ['STOPPING', 'RECOVERY_REQUIRED', 'SETTLED'],
  STOPPING: ['RECOVERY_REQUIRED', 'SETTLED'],
  RECOVERY_REQUIRED: ['RUNNING', 'STOPPING', 'SETTLED'],
  SETTLED: []
};

const JOB_TRANSITIONS: Readonly<Record<DiscourseJobStatus, readonly DiscourseJobStatus[]>> = {
  QUEUED: ['RESOLVING_CONTEXT', 'CANCELED'],
  RESOLVING_CONTEXT: ['STARTING', 'CANCEL_REQUESTED', 'FAILED', 'CONTEXT_STALE'],
  STARTING: ['RUNNING', 'CANCEL_REQUESTED', 'RECOVERY_REQUIRED', 'FAILED', 'CONTEXT_STALE'],
  RUNNING: [
    'CANCEL_REQUESTED',
    'RECOVERY_REQUIRED',
    'COMPLETED',
    'FAILED',
    'CONTEXT_STALE'
  ],
  CANCEL_REQUESTED: ['RECOVERY_REQUIRED', 'COMPLETED', 'CANCELED'],
  RECOVERY_REQUIRED: ['COMPLETED', 'FAILED', 'CANCELED'],
  COMPLETED: [],
  FAILED: [],
  CANCELED: [],
  CONTEXT_STALE: []
};

const DELIVERY_TRANSITIONS: Readonly<
  Record<DiscourseDeliveryStatus, readonly DiscourseDeliveryStatus[]>
> = {
  NOT_SENT: ['SENDING'],
  SENDING: ['ACKNOWLEDGED', 'NOT_DELIVERED', 'AMBIGUOUS'],
  ACKNOWLEDGED: ['TERMINAL'],
  NOT_DELIVERED: [],
  AMBIGUOUS: [],
  TERMINAL: []
};

const TERMINAL_JOB_STATUSES: ReadonlySet<DiscourseJobStatus> = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELED',
  'CONTEXT_STALE'
]);

export function assertContextSnapshotTransition(
  current: ContextSnapshotStatus,
  next: ContextSnapshotStatus
): void {
  assertTransition('context snapshot', current, next, CONTEXT_TRANSITIONS[current]);
}

export function resolveContextSnapshot(
  snapshot: ContextSnapshotRecord,
  status: Exclude<ContextSnapshotStatus, 'RESOLVING'>,
  resolvedAt: string,
  error?: StructuredDiscourseError
): ContextSnapshotRecord {
  assertContextSnapshotRecord(snapshot);
  assertContextSnapshotTransition(snapshot.status, status);
  const { status: _status, resolvedAt: _resolvedAt, error: _error, ...base } = snapshot;
  if (status === 'BLOCKED') {
    if (!error) {
      throw new Error('A blocked context snapshot requires a structured error.');
    }
    const resolved: ContextSnapshotRecord = {
      ...base,
      recordRevision: base.recordRevision + 1,
      status,
      resolvedAt,
      error
    };
    assertContextSnapshotRecord(resolved);
    return resolved;
  }
  if (error) {
    throw new Error('A ready or partial context snapshot cannot carry an error.');
  }
  const resolved: ContextSnapshotRecord = {
    ...base,
    recordRevision: base.recordRevision + 1,
    status,
    resolvedAt
  };
  assertContextSnapshotRecord(resolved);
  return resolved;
}

export function assertContextSnapshotRecord(snapshot: ContextSnapshotRecord): void {
  if (snapshot.budget.sourceCount !== snapshot.sources.length) {
    throw new Error('Context snapshot budget source count does not match its manifest.');
  }
  const linkIds = new Set<string>();
  let hasDegradedOptionalSource = false;
  let hasBlockedRequiredSource = false;
  for (const source of snapshot.sources) {
    if (linkIds.has(source.contextLinkId)) {
      throw new Error('Context snapshot sources must be unique by context link.');
    }
    linkIds.add(source.contextLinkId);
    const filesystemReady =
      source.availability === 'AVAILABLE' &&
      source.accessMode === 'FILESYSTEM_READ' &&
      Boolean(source.generation && source.inspectedAt);
    if (source.accessMode === 'FILESYSTEM_READ' && !filesystemReady) {
      throw new Error('Filesystem context requires available generation evidence.');
    }
    if (!filesystemReady) {
      if (source.required) hasBlockedRequiredSource = true;
      else hasDegradedOptionalSource = true;
    }
  }
  if (snapshot.status === 'READY' && (hasDegradedOptionalSource || hasBlockedRequiredSource)) {
    throw new Error('A ready context snapshot cannot contain degraded sources.');
  }
  if (
    snapshot.status === 'PARTIAL' &&
    (hasBlockedRequiredSource || !hasDegradedOptionalSource)
  ) {
    throw new Error('A partial context snapshot requires only optional degraded sources.');
  }
  if (
    snapshot.status === 'BLOCKED' &&
    !hasBlockedRequiredSource &&
    snapshot.error.code !== 'CONTEXT_TOO_LARGE' &&
    snapshot.error.code !== 'CONTEXT_UNSAFE'
  ) {
    throw new Error('A blocked context snapshot requires blocking source or budget evidence.');
  }
}

export function assertDiscourseWaveTransition(
  current: DiscourseWaveStatus,
  next: DiscourseWaveStatus
): void {
  assertTransition('discourse wave', current, next, WAVE_TRANSITIONS[current]);
}

export function assertDiscourseJobTransition(
  current: DiscourseJobStatus,
  next: DiscourseJobStatus
): void {
  assertTransition('discourse job', current, next, JOB_TRANSITIONS[current]);
}

export function assertDiscourseDeliveryTransition(
  current: DiscourseDeliveryStatus,
  next: DiscourseDeliveryStatus
): void {
  assertTransition('discourse delivery', current, next, DELIVERY_TRANSITIONS[current]);
}

export function reconcileDiscourseDelivery(
  current: DiscourseDeliveryStatus,
  authoritative: 'ACKNOWLEDGED' | 'NOT_DELIVERED' | 'TERMINAL'
): void {
  if (current !== 'AMBIGUOUS') {
    throw new Error('Only ambiguous delivery may use authoritative reconciliation.');
  }
  if (!['ACKNOWLEDGED', 'NOT_DELIVERED', 'TERMINAL'].includes(authoritative)) {
    throw new Error('Invalid authoritative delivery reconciliation.');
  }
}

export function assertDiscourseWaveRecord(record: DiscourseResponseWaveRecord): void {
  assertWaveAssignments(record);
  if (record.dispatchGate.status === 'RECONFIRMATION_REQUIRED' && record.status !== 'PLANNED') {
    throw new Error('A wave requiring preview reconfirmation cannot be dispatched.');
  }
  if (record.status === 'SETTLED') {
    if (!record.outcome || !record.settlementReason || !record.settledAt) {
      throw new Error('A settled discourse wave requires an outcome, reason, and settled timestamp.');
    }
    if (record.phase !== 'COMPLETE') {
      throw new Error('A settled discourse wave must use the COMPLETE phase.');
    }
    assertWaveSettlementPair(record.outcome, record.settlementReason);
    return;
  }
  if (record.phase === 'COMPLETE') {
    throw new Error('An active discourse wave cannot use the COMPLETE phase.');
  }
  if (record.outcome || record.settlementReason || record.settledAt) {
    throw new Error('Only a settled discourse wave may carry settlement fields.');
  }
}

export function assertDiscourseJobRecord(record: DiscourseAgentJobRecord): void {
  const terminal = TERMINAL_JOB_STATUSES.has(record.status);
  if (terminal !== Boolean(record.finishedAt)) {
    throw new Error(
      terminal
        ? 'A terminal discourse job requires a finished timestamp.'
        : 'An active discourse job cannot carry a finished timestamp.'
    );
  }
  if (record.status === 'COMPLETED') {
    if (!record.result) {
      throw new Error('A completed discourse job requires a typed result and finished timestamp.');
    }
    if (record.delivery !== 'TERMINAL') {
      throw new Error('A completed discourse job requires terminal provider delivery.');
    }
    if (record.error) {
      throw new Error('A completed discourse job cannot carry a terminal error.');
    }
    if (record.role === 'COMPACT_HISTORY') {
      if (record.freshnessAtCompletion) {
        throw new Error('A history compaction job cannot carry repository freshness evidence.');
      }
    } else if (!record.freshnessAtCompletion) {
      throw new Error('A completed discourse job requires explicit context freshness evidence.');
    }
    assertResultMatchesRole(record.role, record.result);
    if (
      record.result.kind === 'CONTRIBUTION' &&
      !record.result.outputMessageId.trim()
    ) {
      throw new Error('A contribution result requires a nonblank output message id.');
    }
    if (
      record.result.kind === 'REVIEW' &&
      !record.result.requiredAccessAvailable &&
      record.result.outcome !== 'ABSTAINED'
    ) {
      throw new Error('A reviewer without required access must abstain.');
    }
    if (record.result.kind === 'REVIEW') {
      if (
        !record.result.reviewedScope.trim() ||
        !record.targetMessageIds.includes(record.result.reviewedScope)
      ) {
        throw new Error('A review result must identify its exact target message.');
      }
      if (new Set(record.result.concernIds).size !== record.result.concernIds.length) {
        throw new Error('A review result cannot repeat concern ids.');
      }
      if (record.result.limitations.some((limitation) => !limitation.trim())) {
        throw new Error('Review limitations cannot be blank.');
      }
      if (record.result.outcome === 'CONCERNS' && record.result.concernIds.length === 0) {
        throw new Error('A concerns review result requires at least one concern id.');
      }
      if (record.result.outcome !== 'CONCERNS' && record.result.concernIds.length > 0) {
        throw new Error('Only a concerns review result may reference concerns.');
      }
      if (record.result.outcome === 'ABSTAINED' && record.result.limitations.length === 0) {
        throw new Error('An abstained review result requires an explicit limitation.');
      }
    }
    if (record.result.kind === 'CORRECTION') {
      if (record.result.limitations.some((limitation) => !limitation.trim())) {
        throw new Error('Correction limitations cannot be blank.');
      }
      if (
        record.result.outcome !== 'ABSTAINED' &&
        !record.result.outputMessageId?.trim()
      ) {
        throw new Error('A non-abstained correction requires an output message id.');
      }
      if (
        record.result.outcome === 'ABSTAINED' &&
        record.result.limitations.length === 0
      ) {
        throw new Error('An abstained correction requires an explicit limitation.');
      }
    }
    return;
  }
  if (record.freshnessAtCompletion && !terminal) {
    throw new Error('An active discourse job cannot carry completion freshness evidence.');
  }
  if (record.result) {
    throw new Error('Only a completed discourse job may carry a typed result.');
  }
  if (record.status === 'FAILED' && !record.error) {
    throw new Error('A failed discourse job requires a structured error.');
  }
  if (
    (record.status === 'QUEUED' || record.status === 'RESOLVING_CONTEXT') &&
    record.delivery !== 'NOT_SENT'
  ) {
    throw new Error('An undispatched discourse job cannot carry provider delivery evidence.');
  }
  if (record.status === 'RUNNING' && record.delivery !== 'ACKNOWLEDGED') {
    throw new Error('A running discourse job requires acknowledged provider delivery.');
  }
}

export function isEligibleDiscourseConcern(concern: DiscourseConcernRecord): boolean {
  return (
    !concern.redundantOfConcernId &&
    (concern.severity === 'MATERIAL' || concern.severity === 'BLOCKING') &&
    (concern.confidence === 'MEDIUM' || concern.confidence === 'HIGH') &&
    concern.evidenceStatus !== 'SPECULATIVE' &&
    concern.requiredAccessAvailable
  );
}

export interface DiscourseWaveAggregate {
  status: DiscourseWaveStatus;
  nextPhase?: DiscourseWavePhase;
  outcome?: DiscourseWaveOutcome;
  settlementReason?: DiscourseWaveSettlementReason;
}

export interface DeriveDiscourseWaveAggregateInput {
  wave: DiscourseResponseWaveRecord;
  jobs: readonly DiscourseAgentJobRecord[];
  concerns?: readonly DiscourseConcernRecord[];
  contextChangedBeforeStart?: boolean;
}

/**
 * Derives parent state solely from durable children and immutable freshness
 * evidence. The scheduler may persist this result, but it must not infer
 * semantic success from provider delivery or free-form text.
 */
export function deriveDiscourseWaveAggregate(
  input: DeriveDiscourseWaveAggregateInput
): DiscourseWaveAggregate {
  const { wave, jobs } = input;
  assertWaveAssignments(wave);
  if (wave.dispatchGate.status === 'RECONFIRMATION_REQUIRED') {
    return { status: 'PLANNED' };
  }
  const jobKeys = new Set<string>();
  for (const job of jobs) {
    if (job.waveId !== wave.id || job.conversationId !== wave.conversationId) {
      throw new Error('A discourse wave cannot aggregate jobs owned by another wave.');
    }
    const plannedAssignment = wave.assignments.find(
      (assignment) =>
        assignment.stableParticipantId === job.assignment.stableParticipantId &&
        assignment.participantRevisionId === job.assignment.participantRevisionId
    );
    if (!plannedAssignment || JSON.stringify(plannedAssignment) !== JSON.stringify(job.assignment)) {
      throw new Error('A discourse job must use an immutable assignment from its wave.');
    }
    assertJobMatchesPolicy(wave, job);
    const jobKey = `${job.assignment.stableParticipantId}:${job.role}`;
    if (jobKeys.has(jobKey)) {
      throw new Error('A discourse wave cannot create duplicate jobs for one assignment and role.');
    }
    jobKeys.add(jobKey);
    assertDiscourseJobRecord(job);
  }
  assertConcernReferences(input);

  if (wave.status === 'SETTLED') {
    assertDiscourseWaveRecord(wave);
    return {
      status: 'SETTLED',
      outcome: wave.outcome,
      settlementReason: wave.settlementReason
    };
  }

  if (jobs.some((job) => job.status === 'RECOVERY_REQUIRED')) {
    return { status: 'RECOVERY_REQUIRED' };
  }
  if (
    jobs.some(
      (job) => job.status === 'COMPLETED' && job.freshnessAtCompletion === 'UNKNOWN'
    )
  ) {
    return { status: 'RECOVERY_REQUIRED' };
  }

  const stopRequested = wave.status === 'STOP_REQUESTED' || wave.status === 'STOPPING';
  const activeJobs = jobs.filter((job) => !TERMINAL_JOB_STATUSES.has(job.status));
  if (stopRequested) {
    if (activeJobs.length > 0) {
      return { status: 'STOPPING' };
    }
    return hasUsableContribution(jobs)
      ? settled('PARTIAL', 'STOPPED')
      : settled('CANCELED', 'USER_CANCELED');
  }

  if (input.contextChangedBeforeStart) {
    return settled('STALE', 'CONTEXT_CHANGED');
  }

  if (activeJobs.length > 0) {
    return {
      status: jobs.some((job) => job.status !== 'QUEUED') ? 'RUNNING' : 'QUEUED'
    };
  }

  if (jobs.length === 0) {
    return wave.status === 'PLANNED' || wave.status === 'SNAPSHOTTING'
      ? { status: wave.status }
      : settled('FAILED', 'FAILED');
  }

  switch (wave.policy) {
    case 'TEAM':
      return deriveTeamSettlement(input);
    case 'PANEL':
      return derivePanelSettlement(input);
    case 'DIRECT':
    case 'TARGETED_REVIEW':
    case 'TARGETED_REPLY':
    case 'SYNTHESIS':
      return deriveSinglePhaseSettlement(input);
  }
}

export function resolveDiscourseIdempotency(input: {
  existingOperation?: { clientOperationId: string; requestFingerprint: string };
  clientOperationId: string;
  requestFingerprint: string;
}): 'NEW' | 'REPLAY' {
  if (!input.existingOperation) return 'NEW';
  if (input.existingOperation.clientOperationId !== input.clientOperationId) return 'NEW';
  if (input.existingOperation.requestFingerprint !== input.requestFingerprint) {
    throw new Error('REQUEST_CONFLICT: the client operation id was reused with different content.');
  }
  return 'REPLAY';
}

export function assertDiscourseMessageAppend(input: {
  conversationId: string;
  latestOrdinal: number;
  existingMessages?: readonly DiscourseMessageRecord[];
  findExistingMessage?: (messageId: string) => DiscourseMessageRecord | undefined;
  message: DiscourseMessageRecord;
}): void {
  const { message } = input;
  const findExistingMessage =
    input.findExistingMessage ??
    ((messageId: string) =>
      input.existingMessages?.find((candidate) => candidate.id === messageId));
  if (message.conversationId !== input.conversationId) {
    throw new Error('A discourse message cannot cross conversation ownership.');
  }
  if (message.ordinal !== input.latestOrdinal + 1) {
    throw new Error('A discourse message must append at the next durable ordinal.');
  }
  if (message.author.kind === 'USER') {
    if (!message.clientMessageId || !message.requestFingerprint) {
      throw new Error('A user discourse message requires idempotency evidence.');
    }
  } else if (message.clientMessageId || message.requestFingerprint) {
    throw new Error('Only a user discourse message may carry client idempotency evidence.');
  }
  if (message.replyToMessageId) {
    const target = findExistingMessage(message.replyToMessageId);
    if (!target || target.conversationId !== input.conversationId) {
      throw new Error('A discourse reply requires an existing message in the same conversation.');
    }
    if (target.replyToMessageId) {
      throw new Error('Discourse replies are limited to one visible nesting level.');
    }
  }
  if (message.supersedesMessageId) {
    const target = findExistingMessage(message.supersedesMessageId);
    if (!target || target.conversationId !== input.conversationId) {
      throw new Error('A discourse correction requires an existing message in the same conversation.');
    }
    if (target.author.kind !== message.author.kind) {
      throw new Error('A discourse correction cannot change the author kind.');
    }
    if (
      target.author.kind === 'AGENT' &&
      message.author.kind === 'AGENT' &&
      target.author.stableParticipantId !== message.author.stableParticipantId
    ) {
      throw new Error('A discourse correction cannot change the agent identity.');
    }
  }
}

function deriveTeamSettlement(input: DeriveDiscourseWaveAggregateInput): DiscourseWaveAggregate {
  const primary = input.wave.assignments.find(
    (assignment) => assignment.assignmentRole === 'PRIMARY'
  )!;
  const lead = input.jobs.find(
    (job) =>
      job.role === 'ANSWER' &&
      job.assignment.stableParticipantId === primary.stableParticipantId
  );
  if (!lead) {
    return { status: 'RUNNING', nextPhase: 'ANSWER' };
  }
  if (!hasUsableContribution([lead])) {
    if (lead?.status === 'CONTEXT_STALE') {
      return settled('STALE', 'CONTEXT_CHANGED');
    }
    return settled('NO_RESPONSE', 'FAILED');
  }
  if (jobContextChanged(lead)) {
    return settled('STALE', 'CONTEXT_CHANGED');
  }

  const requiredReviews = input.jobs.filter(
    (job) => job.role === 'CRITIQUE' && job.assignment.required
  );
  const expectedReviewers = input.wave.assignments.filter(
    (assignment) => assignment.assignmentRole === 'REVIEWER' && assignment.required
  );
  const missingReviewers = expectedReviewers.filter(
    (assignment) =>
      !requiredReviews.some(
        (job) => job.assignment.stableParticipantId === assignment.stableParticipantId
      )
  );
  if (expectedReviewers.length === 0) {
    throw new Error('A Team wave requires at least one required reviewer assignment.');
  }
  if (missingReviewers.length > 0) {
    return { status: 'RUNNING', nextPhase: 'REVIEW' };
  }
  if (requiredReviews.some((job) => job.status !== 'COMPLETED')) {
    return settled('PARTIAL', 'FAILED');
  }
  const reviewResults = requiredReviews.map((job) => {
    if (job.result?.kind !== 'REVIEW') {
      throw new Error('A completed required review job must have a review result.');
    }
    return { job, result: job.result };
  });
  if (
    reviewResults.some(
      ({ job, result }) =>
        result.outcome === 'ABSTAINED' ||
        !result.requiredAccessAvailable ||
        jobContextChanged(job)
    )
  ) {
    return settled('PARTIAL', 'COMPLETED');
  }

  const eligibleConcernIds = new Set(
    (input.concerns ?? []).filter(isEligibleDiscourseConcern).map((concern) => concern.id)
  );
  const hasEligibleConcern = requiredReviews.some(
    (job) =>
      job.result?.kind === 'REVIEW' &&
      job.result.concernIds.some((concernId) => eligibleConcernIds.has(concernId))
  );
  if (!hasEligibleConcern) {
    return settled('COMPLETE', 'COMPLETED');
  }

  const correction = input.jobs.find((job) => job.role === 'CORRECT');
  if (input.jobs.filter((job) => job.role === 'CORRECT').length > 1) {
    throw new Error('A Team wave may create at most one correction job.');
  }
  if (!correction) {
    return { status: 'RUNNING', nextPhase: 'CORRECT' };
  }
  if (
    correction?.status !== 'COMPLETED' ||
    correction.result?.kind !== 'CORRECTION' ||
    correction.result.outcome === 'ABSTAINED' ||
    jobContextChanged(correction)
  ) {
    return settled('PARTIAL', 'FAILED');
  }
  return settled('COMPLETE', 'COMPLETED');
}

function derivePanelSettlement(input: DeriveDiscourseWaveAggregateInput): DiscourseWaveAggregate {
  const requiredAssignments = input.wave.assignments;
  const required = requiredAssignments.flatMap((assignment) => {
    const matching = input.jobs.find(
      (job) =>
        job.role === 'ANSWER' &&
        job.assignment.stableParticipantId === assignment.stableParticipantId
    );
    return matching ? [matching] : [];
  });
  if (required.length < requiredAssignments.length) {
    return { status: 'RUNNING', nextPhase: 'ANSWER' };
  }
  const contributions = required.filter((job) => hasUsableContribution([job]));
  if (contributions.length === 0) {
    return required.some((job) => job.status === 'CONTEXT_STALE')
      ? settled('STALE', 'CONTEXT_CHANGED')
      : settled('NO_RESPONSE', 'FAILED');
  }
  const complete =
    contributions.length === required.length &&
    required.every((job) => !jobContextChanged(job));
  return complete ? settled('COMPLETE', 'COMPLETED') : settled('PARTIAL', 'FAILED');
}

function deriveSinglePhaseSettlement(
  input: DeriveDiscourseWaveAggregateInput
): DiscourseWaveAggregate {
  const assignment = input.wave.assignments[0]!;
  const required = input.jobs.filter(
    (job) => job.assignment.stableParticipantId === assignment.stableParticipantId
  );
  if (required.length === 0) {
    return {
      status: 'RUNNING',
      nextPhase: input.wave.policy === 'SYNTHESIS' ? 'SYNTHESIZE' : 'ANSWER'
    };
  }
  const completed = required.filter((job) => hasUsableResult(job));
  if (completed.some((job) => jobContextChanged(job))) {
    return settled('STALE', 'CONTEXT_CHANGED');
  }
  if (
    completed.some(
      (job) => job.result?.kind === 'REVIEW' && job.result.outcome === 'ABSTAINED'
    )
  ) {
    return settled('PARTIAL', 'COMPLETED');
  }
  if (completed.length === required.length && required.length > 0) {
    return settled('COMPLETE', 'COMPLETED');
  }
  if (completed.length > 0) {
    return settled('PARTIAL', 'FAILED');
  }
  return required.some((job) => job.status === 'CONTEXT_STALE')
    ? settled('STALE', 'CONTEXT_CHANGED')
    : settled('NO_RESPONSE', 'FAILED');
}

function hasUsableContribution(jobs: readonly DiscourseAgentJobRecord[]): boolean {
  return jobs.some(
    (job) =>
      job.status === 'COMPLETED' &&
      ((job.result?.kind === 'CONTRIBUTION' && Boolean(job.result.outputMessageId)) ||
        (job.result?.kind === 'CORRECTION' && Boolean(job.result.outputMessageId)))
  );
}

function hasUsableResult(job: DiscourseAgentJobRecord): boolean {
  if (job.status !== 'COMPLETED' || !job.result) return false;
  if (job.result.kind === 'REVIEW') {
    return job.result.outcome === 'ABSTAINED' || job.result.requiredAccessAvailable;
  }
  if (job.result.kind === 'COMPACTION') return true;
  return Boolean(job.result.outputMessageId);
}

function jobContextChanged(job: DiscourseAgentJobRecord): boolean {
  return job.freshnessAtCompletion === 'CHANGED_DURING_JOB';
}

function assertConcernReferences(input: DeriveDiscourseWaveAggregateInput): void {
  const concerns = input.concerns ?? [];
  const byId = new Map<string, DiscourseConcernRecord>();
  for (const concern of concerns) {
    if (byId.has(concern.id)) {
      throw new Error(`Duplicate discourse concern id: ${concern.id}`);
    }
    if (
      concern.waveId !== input.wave.id ||
      concern.conversationId !== input.wave.conversationId
    ) {
      throw new Error('A discourse wave cannot aggregate concerns owned by another wave.');
    }
    byId.set(concern.id, concern);
  }
  const referenced = new Set<string>();
  for (const job of input.jobs) {
    if (job.result?.kind !== 'REVIEW') continue;
    for (const concernId of job.result.concernIds) {
      const concern = byId.get(concernId);
      if (
        !concern ||
        concern.reviewJobId !== job.id ||
        concern.reviewerParticipantRevisionId !== job.assignment.participantRevisionId ||
        !job.targetMessageIds.includes(concern.targetMessageId)
      ) {
        throw new Error(`Review job ${job.id} references an unknown discourse concern.`);
      }
      referenced.add(concernId);
    }
  }
  if (concerns.some((concern) => !referenced.has(concern.id))) {
    throw new Error('Every discourse concern must be referenced by its review result.');
  }
}

function assertWaveAssignments(wave: DiscourseResponseWaveRecord): void {
  const keys = new Set<string>();
  for (const assignment of wave.assignments) {
    if (keys.has(assignment.stableParticipantId)) {
      throw new Error('A discourse wave cannot assign the same participant twice.');
    }
    keys.add(assignment.stableParticipantId);
  }
  if (wave.assignments.some((assignment) => !assignment.required)) {
    throw new Error('Optional discourse assignments are not supported in v1.');
  }
  const required = wave.assignments;
  if (wave.policy === 'TEAM') {
    const primaries = required.filter((assignment) => assignment.assignmentRole === 'PRIMARY');
    const reviewers = required.filter((assignment) => assignment.assignmentRole === 'REVIEWER');
    if (primaries.length !== 1 || reviewers.length !== 2 || wave.assignments.length !== 3) {
      throw new Error('A v1 Team wave requires one primary and two required reviewers.');
    }
  } else if (wave.policy === 'PANEL') {
    if (
      required.length < 1 ||
      required.length > 3 ||
      required.some((assignment) => assignment.assignmentRole !== 'PANELIST')
    ) {
      throw new Error('A Panel wave requires one to three required panelists.');
    }
  } else if (required.length !== 1) {
    throw new Error('A single-agent discourse wave requires exactly one assignment.');
  }
}

function assertJobMatchesPolicy(
  wave: DiscourseResponseWaveRecord,
  job: DiscourseAgentJobRecord
): void {
  const role = job.assignment.assignmentRole;
  const valid =
    (wave.policy === 'TEAM' &&
      ((role === 'PRIMARY' && (job.role === 'ANSWER' || job.role === 'CORRECT')) ||
        (role === 'REVIEWER' && job.role === 'CRITIQUE'))) ||
    (wave.policy === 'PANEL' && role === 'PANELIST' && job.role === 'ANSWER') ||
    (wave.policy === 'DIRECT' && role === 'PRIMARY' && job.role === 'ANSWER') ||
    (wave.policy === 'TARGETED_REVIEW' && role === 'REVIEWER' && job.role === 'CRITIQUE') ||
    (wave.policy === 'TARGETED_REPLY' &&
      role === 'RESPONDENT' &&
      job.role === 'TARGETED_REPLY') ||
    (wave.policy === 'SYNTHESIS' &&
      role === 'SYNTHESIZER' &&
      job.role === 'SYNTHESIZE');
  if (!valid) {
    throw new Error('Discourse job role is incompatible with its wave policy assignment.');
  }
}

function assertWaveSettlementPair(
  outcome: DiscourseWaveOutcome,
  reason: DiscourseWaveSettlementReason
): void {
  const allowed: Readonly<Record<DiscourseWaveOutcome, readonly DiscourseWaveSettlementReason[]>> = {
    COMPLETE: ['COMPLETED'],
    PARTIAL: ['COMPLETED', 'FAILED', 'STOPPED', 'SUPERSEDED'],
    NO_RESPONSE: ['FAILED'],
    CANCELED: ['USER_CANCELED', 'STOPPED', 'SUPERSEDED'],
    STALE: ['CONTEXT_CHANGED'],
    FAILED: ['FAILED']
  };
  if (!allowed[outcome].includes(reason)) {
    throw new Error(`Invalid discourse wave settlement: ${outcome} / ${reason}`);
  }
}

function settled(
  outcome: DiscourseWaveOutcome,
  settlementReason: DiscourseWaveSettlementReason
): DiscourseWaveAggregate {
  return { status: 'SETTLED', outcome, settlementReason };
}

function assertResultMatchesRole(
  role: DiscourseAgentJobRecord['role'],
  result: DiscourseJobResult
): void {
  const expected =
    role === 'CRITIQUE'
      ? 'REVIEW'
      : role === 'CORRECT'
        ? 'CORRECTION'
        : role === 'COMPACT_HISTORY'
          ? 'COMPACTION'
          : 'CONTRIBUTION';
  if (result.kind !== expected) {
    throw new Error(`Discourse ${role} jobs require a ${expected} result.`);
  }
}

function assertTransition<T extends string>(
  label: string,
  current: T,
  next: T,
  allowed: readonly T[]
): void {
  if (!allowed.includes(next)) {
    throw new Error(`Invalid ${label} transition: ${current} -> ${next}`);
  }
}
