import { DISCOURSE_LIMITS } from '../../shared/discourse';
import type {
  AgentAssignmentSnapshot, DiscourseAgentJobRecord, DiscourseResponseWaveRecord,
  DiscourseTeamComparison, DiscourseWaveSettlementReason
} from '../../shared/discourse';

export function isAdaptiveTeam(wave: DiscourseResponseWaveRecord): boolean {
  return wave.policy === 'TEAM' && wave.policyVersion === 2;
}

export function teamDeadline(wave: DiscourseResponseWaveRecord): number | undefined {
  return isAdaptiveTeam(wave) && wave.startedAt
    ? Date.parse(wave.startedAt) + DISCOURSE_LIMITS.maxAdaptiveTeamDurationMs : undefined;
}

export function teamTimeExpired(wave: DiscourseResponseWaveRecord, now: string): boolean {
  const deadline = teamDeadline(wave);
  return deadline !== undefined && Date.parse(now) >= deadline;
}

export function teamComparison(job: DiscourseAgentJobRecord | undefined): DiscourseTeamComparison | undefined {
  return job?.result?.kind === 'CONTRIBUTION' && job.result.team?.kind === 'COMPARISON'
    ? job.result.team : undefined;
}

export function outputMessageId(job: DiscourseAgentJobRecord): string[] {
  return job.result && 'outputMessageId' in job.result && job.result.outputMessageId
    ? [job.result.outputMessageId] : [];
}

export interface TeamJobPlan {
  assignment: AgentAssignmentSnapshot;
  role: 'COMPARE' | 'RESPOND';
  phase: number;
  targetMessageIds: string[];
  visibleMessageIds: string[];
}

/** Derived from durable jobs, not a second lifecycle or a model-authored scheduler. */
export function nextTeamStep(wave: DiscourseResponseWaveRecord, jobs: readonly DiscourseAgentJobRecord[]):
  { jobs: TeamJobPlan[]; stop?: never } | { jobs?: never; stop: DiscourseWaveSettlementReason } {
  if (!isAdaptiveTeam(wave)) throw new Error('Adaptive Team planning requires policy version 2.');
  const ordered = [...jobs].sort((a, b) => a.phase - b.phase);
  if (ordered.some((job) => job.status !== 'COMPLETED' || job.freshnessAtCompletion !== 'FRESH')) {
    return { stop: ordered.some((job) => job.freshnessAtCompletion === 'CHANGED_DURING_JOB' || job.status === 'CONTEXT_STALE') ? 'CONTEXT_CHANGED' : 'FAILED' };
  }
  const authors = ordered.filter((job) => job.role === 'ANSWER');
  if (authors.length !== 2 || authors.some((job) => outputMessageId(job).length !== 1)) return { stop: 'FAILED' };
  const phase = Math.max(...ordered.map((job) => job.phase)) + 1;
  const visibleMessageIds = [...new Set([...authors[0]!.visibleMessageIds, ...ordered.flatMap(outputMessageId)])];
  const comparisonJob = ordered.filter((job) => job.role === 'COMPARE').at(-1);
  const comparison = teamComparison(comparisonJob);
  const responsesSinceComparison = comparisonJob
    ? ordered.filter((job) => job.role === 'RESPOND' && job.phase > comparisonJob.phase)
    : [];
  if (responsesSinceComparison.length && responsesSinceComparison.every((job) => {
    const result = job.result?.kind === 'CONTRIBUTION' ? job.result.team : undefined;
    return result?.kind === 'RESPONSE' && result.newIssues.length === 0 &&
      result.responses.length > 0 && result.responses.every((response) => response.stance === 'ABSTAIN');
  })) return { stop: 'NO_NEW_BASIS' };
  // Every response batch is followed by a comparison update. Reserve that call
  // before dispatching the batch; failed responses stop without invented closure.
  if (!comparisonJob || ordered.some((job) => job.phase > comparisonJob.phase)) {
    if (jobs.length >= DISCOURSE_LIMITS.maxAdaptiveTeamJobs) return { stop: 'TURN_LIMIT' };
    const assignment = wave.assignments.find((entry) => entry.assignmentRole === 'COMPARATOR');
    if (!assignment) return { stop: 'FAILED' };
    return { jobs: [{ assignment, role: 'COMPARE', phase,
      targetMessageIds: ordered.flatMap(outputMessageId), visibleMessageIds }] };
  }
  if (!comparison) return { stop: 'FAILED' };
  if (comparison.next !== 'CONTINUE') {
    return { stop: comparison.next === 'READY' ? 'COMPLETED' : comparison.next };
  }
  const participants = [...new Set(comparison.actions.map((action) => action.participantId))];
  if (!participants.length) return { stop: 'NO_NEW_BASIS' };
  if (jobs.length + participants.length + 1 > DISCOURSE_LIMITS.maxAdaptiveTeamJobs) return { stop: 'TURN_LIMIT' };
  for (const action of comparison.actions) {
    const point = comparison.points.find((item) => item.id === action.pointId);
    if (!point || point.importance !== 'MATERIAL' || point.status !== 'OPEN') return { stop: 'NO_NEW_BASIS' };
    // Rephrasing the same request does not buy another turn. Only a new visible
    // non-comparator input or an as-yet-unanswered point can justify continuation.
    const prior = ordered.filter((job) => job.role === 'RESPOND' && job.assignment.stableParticipantId === action.participantId);
    const repeated = prior.some((response) => {
      const source = ordered.find((job) => outputMessageId(job).some((id) => response.targetMessageIds.includes(id)));
      return teamComparison(source)?.actions.some((previous) =>
        previous.participantId === action.participantId && previous.pointId === action.pointId &&
        action.basisMessageIds.every((id) => response.visibleMessageIds.includes(id))
      );
    });
    if (repeated) return { stop: 'NO_NEW_BASIS' };
  }
  return { jobs: participants.map((participantId) => {
    const assignment = wave.assignments.find((entry) => entry.stableParticipantId === participantId && entry.assignmentRole === 'AUTHOR');
    if (!assignment) throw new Error('Team action targets an unavailable author.');
    return { assignment, role: 'RESPOND', phase, targetMessageIds: outputMessageId(comparisonJob), visibleMessageIds };
  }) };
}
