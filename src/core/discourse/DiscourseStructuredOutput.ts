import type {
  DiscourseConcernConfidence,
  DiscourseConcernEvidenceStatus,
  DiscourseConcernSeverity,
  DiscourseCorrectionOutcome,
  DiscourseReviewOutcome,
  DiscourseAgentJobRecord,
  DiscourseResponseWaveRecord,
  DiscourseTeamComparison,
  DiscourseTeamResponse
} from '../../shared/discourse';
import { outputMessageId, teamComparison } from './DiscourseResponses';

/** Only the continuation decision is structured; the conversation remains normal prose. */
export function parseDiscoursePeerOutput(value: string): { message: string; requestAuthorResponse: boolean } {
  const record = parseRecord(value, 'peer');
  if (Object.keys(record).some((key) => key !== 'message' && key !== 'requestAuthorResponse') ||
      typeof record.requestAuthorResponse !== 'boolean') throw new Error('The peer response format is invalid.');
  return { message: requireText(record.message, 'peer message', 64 * 1024), requestAuthorResponse: record.requestAuthorResponse };
}

export function parseDiscourseTeamOutput(
  value: string, job: DiscourseAgentJobRecord,
  wave: DiscourseResponseWaveRecord, jobs: readonly DiscourseAgentJobRecord[]
): DiscourseTeamComparison | DiscourseTeamResponse {
  const record = parseRecord(value, 'Team');
  if (job.role === 'RESPOND') {
    const source = jobs.find((candidate) => outputMessageId(candidate).some((id) => job.targetMessageIds.includes(id)));
    const assigned = teamComparison(source)?.actions.filter((action) => action.participantId === job.assignment.stableParticipantId) ?? [];
    const responses = requireRecords(record.responses, 'responses', 8).map((response) => ({
      pointId: requireText(response.pointId, 'response point', 80),
      stance: requireEnum(response.stance, ['REVISE', 'DEFEND', 'CLARIFY', 'WITHDRAW', 'UNCERTAIN', 'ABSTAIN'] as const, 'response stance'),
      answer: requireText(response.answer, 'response answer', 8_000),
      reason: requireText(response.reason, 'response reason', 4_000),
      evidence: requireTextArray(response.evidence, 'response evidence', 8, 2_000)
    }));
    if (!assigned.length || new Set(responses.map((response) => response.pointId)).size !== responses.length ||
      assigned.length !== responses.length || assigned.some((action) => !responses.some((response) => response.pointId === action.pointId))) {
      throw new Error('Team response must address each assigned point once, including uncertainty or abstention.');
    }
    return { kind: 'RESPONSE', responses, newIssues: requireTextArray(record.newIssues, 'new issues', 8, 2_000) };
  }
  if (job.role !== 'COMPARE') throw new Error('This job does not accept Team structured output.');
  const points = requireRecords(record.points, 'comparison points', 16).map((point) => ({
    id: requireText(point.id, 'point id', 80),
    question: requireText(point.question, 'point question', 2_000),
    importance: requireEnum(point.importance, ['MATERIAL', 'ADVISORY'] as const, 'point importance'),
    status: requireEnum(point.status, ['OPEN', 'AGREED', 'CORRECTED', 'DISAGREED', 'NEEDS_EVIDENCE', 'NEEDS_USER'] as const, 'point status'),
    explanation: requireText(point.explanation, 'point explanation', 4_000),
    sourceMessageIds: requireTextArray(point.sourceMessageIds, 'point source messages', 16, 200),
    evidence: requireTextArray(point.evidence, 'point evidence', 8, 2_000),
    confidence: requireEnum(point.confidence, ['LOW', 'MEDIUM', 'HIGH'] as const, 'point confidence')
  }));
  const actions = requireRecords(record.actions, 'comparison actions', 8).map((action) => ({
    pointId: requireText(action.pointId, 'action point', 80),
    participantId: requireText(action.participantId, 'action participant', 200),
    task: requireText(action.task, 'action task', 2_000),
    expectedBenefit: requireText(action.expectedBenefit, 'action benefit', 2_000),
    basisMessageIds: requireTextArray(action.basisMessageIds, 'action basis messages', 16, 200)
  }));
  const next = requireEnum(record.next, ['CONTINUE', 'READY', 'NEEDS_EVIDENCE', 'NEEDS_USER', 'OPEN_DISAGREEMENT'] as const, 'comparison next step');
  const previous = jobs.filter((candidate) => candidate.waveId === job.waveId && candidate.role === 'COMPARE' && candidate.phase < job.phase)
    .sort((a, b) => a.phase - b.phase).at(-1) ?? jobs.filter((candidate) => candidate.role === 'COMPARE' &&
      outputMessageId(candidate).some((id) => job.targetMessageIds.includes(id)))
      .sort((a, b) => (a.finishedAt ?? a.createdAt).localeCompare(b.finishedAt ?? b.createdAt)).at(-1);
  if (new Set(points.map((point) => point.id)).size !== points.length ||
    teamComparison(previous)?.points.some((point) => !points.some((candidate) => candidate.id === point.id))) {
    throw new Error('Comparison updates must preserve every prior point ID, including disagreements and corrected comparisons.');
  }
  const comparatorMessages = new Set(jobs.filter((candidate) => candidate.role === 'COMPARE').flatMap(outputMessageId));
  if (points.some((point) => !point.sourceMessageIds.length || point.sourceMessageIds.some((id) => !job.visibleMessageIds.includes(id)))) {
    throw new Error('Comparison points must reference visible source messages.');
  }
  if (actions.some((action) =>
    !points.some((point) => point.id === action.pointId && point.importance === 'MATERIAL' && point.status === 'OPEN') ||
    !wave.assignments.some((assignment) => assignment.assignmentRole === 'AUTHOR' && assignment.stableParticipantId === action.participantId) ||
    !action.basisMessageIds.length || action.basisMessageIds.some((id) => !job.visibleMessageIds.includes(id) || comparatorMessages.has(id)))) {
    throw new Error('Team actions require an open material point, an author, and visible non-comparator input.');
  }
  if (new Set(actions.map((action) => `${action.pointId}:${action.participantId}`)).size !== actions.length ||
    (next === 'CONTINUE') !== (actions.length > 0)) throw new Error('Comparison next step and actions are inconsistent.');
  if (next === 'READY' && points.some((point) => point.importance === 'MATERIAL' && ['OPEN', 'NEEDS_EVIDENCE', 'NEEDS_USER', 'DISAGREED'].includes(point.status))) {
    throw new Error('A ready comparison cannot hide unresolved material points.');
  }
  if ((next === 'NEEDS_USER' || next === 'NEEDS_EVIDENCE') &&
    !points.some((point) => point.importance === 'MATERIAL' && point.status === next)) {
    throw new Error('A waiting comparison must identify the material question or missing evidence.');
  }
  return { kind: 'COMPARISON', summary: requireText(record.summary, 'comparison summary', 8_000), points,
    next, reason: requireText(record.reason, 'comparison stopping reason', 2_000), actions };
}

export function discourseTeamOutputBody(result: DiscourseTeamComparison | DiscourseTeamResponse): string {
  if (result.kind === 'RESPONSE') return [
    ...result.responses.map((response) => `### ${response.pointId} · ${response.stance.toLowerCase()}\n\n${response.answer}\n\n${response.reason}${response.evidence.length ? `\n\nEvidence: ${response.evidence.join('; ')}` : ''}`),
    ...(result.newIssues.length ? [`### New issues or corrections to the comparison\n\n${result.newIssues.join('\n\n')}`] : [])
  ].join('\n\n');
  return [result.summary, ...result.points.map((point) =>
    `### ${point.id} · ${point.question}\n\n${point.status.toLowerCase().replaceAll('_', ' ')} · ${point.confidence.toLowerCase()} confidence\n\n${point.explanation}\n\nSource messages: ${point.sourceMessageIds.join(', ')}${point.evidence.length ? `\n\nEvidence cited by C: ${point.evidence.join('; ')}` : ''}`),
    `Next: ${result.next.toLowerCase().replaceAll('_', ' ')}. ${result.reason}`,
    ...result.actions.map((action) => `For ${action.participantId}, point ${action.pointId}: ${action.task}\n\nExpected benefit: ${action.expectedBenefit}`)
  ].join('\n\n');
}

function requireRecords(value: unknown, label: string, maxItems: number): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > maxItems || value.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
    throw new Error(`Discourse ${label} are invalid.`);
  }
  return value as Record<string, unknown>[];
}

export interface ParsedDiscourseConcern {
  targetClaim: string;
  category: string;
  severity: DiscourseConcernSeverity;
  confidence: DiscourseConcernConfidence;
  evidenceStatus: DiscourseConcernEvidenceStatus;
  reason: string;
  evidence: string;
  suggestedResolution: string;
}

export interface ParsedDiscourseReview {
  outcome: DiscourseReviewOutcome;
  reviewedScope: string;
  limitations: string[];
  requiredAccessAvailable: boolean;
  concerns: ParsedDiscourseConcern[];
}

export interface ParsedDiscourseCorrection {
  outcome: DiscourseCorrectionOutcome;
  body: string;
  limitations: string[];
}

export function parseDiscourseReview(value: string): ParsedDiscourseReview {
  const record = parseRecord(value, 'review');
  const outcome = requireEnum(record.outcome, [
    'CONCERNS',
    'NO_CONCERN_FOUND',
    'ABSTAINED'
  ] as const, 'review outcome');
  const reviewedScope = requireText(record.reviewedScope, 'reviewed scope', 2_000);
  const limitations = requireTextArray(record.limitations, 'review limitations', 8, 1_000);
  if (typeof record.requiredAccessAvailable !== 'boolean') {
    throw new Error('Discourse review required-access result is invalid.');
  }
  const rawConcerns = Array.isArray(record.concerns) ? record.concerns : [];
  if (rawConcerns.length > 8) throw new Error('Discourse review has too many concerns.');
  const concerns = rawConcerns.map((candidate): ParsedDiscourseConcern => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('Discourse review concern is invalid.');
    }
    const concern = candidate as Record<string, unknown>;
    return {
      targetClaim: requireText(concern.targetClaim, 'target claim', 2_000),
      category: requireText(concern.category, 'concern category', 120),
      severity: requireEnum(concern.severity, ['ADVISORY', 'MATERIAL', 'BLOCKING'] as const, 'concern severity'),
      confidence: requireEnum(concern.confidence, ['LOW', 'MEDIUM', 'HIGH'] as const, 'concern confidence'),
      evidenceStatus: requireEnum(concern.evidenceStatus, ['OBSERVED_CONTEXT', 'CITED_SOURCE', 'LOGICAL_CONTRADICTION', 'SPECULATIVE'] as const, 'concern evidence status'),
      reason: requireText(concern.reason, 'concern reason', 4_000),
      evidence: requireText(concern.evidence, 'concern evidence', 4_000),
      suggestedResolution: requireText(concern.suggestedResolution, 'suggested resolution', 2_000)
    };
  });
  if (outcome === 'CONCERNS' && concerns.length === 0) {
    throw new Error('A concerns review requires at least one structured concern.');
  }
  if (outcome !== 'CONCERNS' && concerns.length > 0) {
    throw new Error('A no-concern or abstained review cannot carry concerns.');
  }
  if (outcome === 'NO_CONCERN_FOUND' && !record.requiredAccessAvailable) {
    throw new Error('No-concern requires complete access to the reviewed scope.');
  }
  if (!record.requiredAccessAvailable && outcome !== 'ABSTAINED') {
    throw new Error('A review without required access must abstain.');
  }
  if (outcome === 'ABSTAINED' && limitations.length === 0) {
    throw new Error('An abstained review requires an explicit limitation.');
  }
  return {
    outcome,
    reviewedScope,
    limitations,
    requiredAccessAvailable: record.requiredAccessAvailable,
    concerns
  };
}

export function parseDiscourseCorrection(value: string): ParsedDiscourseCorrection {
  const record = parseRecord(value, 'correction');
  const outcome = requireEnum(record.outcome, [
    'REVISED',
    'DEFENDED',
    'PARTIALLY_REVISED',
    'ACKNOWLEDGED_UNRESOLVED',
    'ABSTAINED'
  ] as const, 'correction outcome');
  const body = outcome === 'ABSTAINED'
    ? optionalText(record.body, 'correction body', 64 * 1024)
    : requireText(record.body, 'correction body', 64 * 1024);
  const limitations = requireTextArray(record.limitations, 'correction limitations', 8, 1_000);
  if (outcome === 'ABSTAINED' && limitations.length === 0) {
    throw new Error('An abstained correction requires an explicit limitation.');
  }
  return { outcome, body, limitations };
}

function optionalText(value: unknown, label: string, maxBytes: number): string {
  if (value === undefined || value === null || value === '') return '';
  return requireText(value, label, maxBytes);
}

function parseRecord(value: string, label: string): Record<string, unknown> {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(`Discourse ${label} output is not valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Discourse ${label} output must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function requireText(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    throw new Error(`Discourse ${label} is invalid.`);
  }
  return value.trim();
}

function requireTextArray(
  value: unknown,
  label: string,
  maxItems: number,
  maxItemBytes: number
): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`Discourse ${label} are invalid.`);
  }
  return value.map((item) => requireText(item, label, maxItemBytes));
}

function requireEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string
): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new Error(`Discourse ${label} is invalid.`);
  }
  return value as T[number];
}
