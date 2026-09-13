import { describe, expect, it } from 'vitest';
import type { AgentAssignmentSnapshot, DiscourseAgentJobRecord, DiscourseResponseWaveRecord, DiscourseTeamComparison } from '../../shared/discourse';
import { nextTeamStep, teamTimeExpired } from './DiscourseTeam';
import { parseDiscourseTeamOutput } from './DiscourseStructuredOutput';
import { deriveDiscourseWaveAggregate } from './DiscourseState';

describe('adaptive Team decisions', () => {
  it('compares blind answers and reserves a comparison update before each response batch', () => {
    const { wave, answers, comparisonJob } = fixture();
    expect(nextTeamStep(wave, answers).jobs?.[0]).toMatchObject({ role: 'COMPARE', phase: 2, targetMessageIds: ['answer-a', 'answer-b'] });
    expect(nextTeamStep(wave, [...answers, comparisonJob]).jobs).toMatchObject([{ role: 'RESPOND', phase: 3, targetMessageIds: ['comparison'] }]);
    const many = [...answers, ...Array.from({ length: 8 }, (_, index) => ({ ...comparisonJob, id: `prior-${index}`, phase: index + 2 })), { ...comparisonJob, phase: 10 }];
    expect(nextTeamStep(wave, many)).toEqual({ stop: 'TURN_LIMIT' });
  });

  it('stops repeated requests despite changed wording, but allows a newly visible author response', () => {
    const { wave, answers, comparisonJob, comparison } = fixture();
    const response = job('response', wave.assignments[0]!, 'RESPOND', 3, {
      targetMessageIds: ['comparison'], visibleMessageIds: ['question', 'answer-a', 'answer-b', 'comparison'],
      result: { kind: 'CONTRIBUTION', outputMessageId: 'response-a', team: { kind: 'RESPONSE', responses: [{ pointId: 'P1', stance: 'DEFEND', answer: 'No change.', reason: 'Same evidence.', evidence: [] }], newIssues: [] } }
    });
    const updated = { ...comparisonJob, id: 'updated', phase: 4, result: { kind: 'CONTRIBUTION' as const, outputMessageId: 'comparison-2', team: { ...comparison, actions: comparison.actions.map((action) => ({ ...action, task: 'Please reconsider once more.' })) } } };
    expect(nextTeamStep(wave, [...answers, comparisonJob, response, updated])).toEqual({ stop: 'NO_NEW_BASIS' });
    updated.result.team.actions[0]!.basisMessageIds = ['response-a'];
    expect(nextTeamStep(wave, [...answers, comparisonJob, response, updated]).jobs?.[0]?.role).toBe('RESPOND');
  });

  it('stops after abstention-only receipts, but compares an abstention that reports a new issue', () => {
    const { wave, answers, comparisonJob } = fixture();
    const result = { kind: 'RESPONSE' as const, responses: [{ pointId: 'P1', stance: 'ABSTAIN' as const,
      answer: 'I cannot determine this.', reason: 'The required source is unavailable.', evidence: [] }], newIssues: [] as string[] };
    const response = job('response', wave.assignments[0]!, 'RESPOND', 3, {
      result: { kind: 'CONTRIBUTION', outputMessageId: 'response-a', team: result }
    });
    expect(nextTeamStep(wave, [...answers, comparisonJob, response])).toEqual({ stop: 'NO_NEW_BASIS' });
    result.newIssues.push('C attributed a deployment requirement to the wrong author.');
    expect(nextTeamStep(wave, [...answers, comparisonJob, response]).jobs?.[0]?.role).toBe('COMPARE');
  });

  it.each(['NEEDS_EVIDENCE', 'NEEDS_USER', 'OPEN_DISAGREEMENT'] as const)('settles %s without holding a runtime turn', (next) => {
    const { wave, answers, comparisonJob, comparison } = fixture();
    comparisonJob.result = { kind: 'CONTRIBUTION', outputMessageId: 'comparison', team: { ...comparison, next, actions: [] } };
    expect(deriveDiscourseWaveAggregate({ wave, jobs: [...answers, comparisonJob] })).toEqual({ status: 'SETTLED', outcome: 'PARTIAL', settlementReason: next });
  });

  it('does not substitute a winner after an author failure or changed context', () => {
    const { wave, answers } = fixture();
    expect(nextTeamStep(wave, [answers[0]!, { ...answers[1]!, status: 'FAILED' }])).toEqual({ stop: 'FAILED' });
    expect(nextTeamStep(wave, [answers[0]!, { ...answers[1]!, freshnessAtCompletion: 'CHANGED_DURING_JOB' }])).toEqual({ stop: 'CONTEXT_CHANGED' });
    expect(teamTimeExpired(wave, '2026-07-13T00:25:00Z')).toBe(true);
    expect(teamTimeExpired({ ...wave, startedAt: undefined }, '2026-07-13T10:25:00Z')).toBe(false);
  });
});

describe('Team output boundaries', () => {
  it('allows no issue, disagreement, explicit uncertainty, and self-found corrections without invented evidence', () => {
    const { wave, answers, comparisonJob, comparison } = fixture();
    expect(parseDiscourseTeamOutput(JSON.stringify({ ...comparison, points: [], next: 'READY', actions: [] }), comparisonJob, wave, answers)).toMatchObject({ points: [], next: 'READY' });
    const responding = job('responding', wave.assignments[0]!, 'RESPOND', 3, { targetMessageIds: ['comparison'] });
    for (const stance of ['ABSTAIN', 'UNCERTAIN', 'DEFEND', 'REVISE', 'CLARIFY', 'WITHDRAW']) {
      const parsed = parseDiscourseTeamOutput(JSON.stringify({ responses: [{ pointId: 'P1', stance, answer: 'The required deployment policy was not supplied.', reason: 'C assumed it.', evidence: [] }], newIssues: ['C attributed B’s requirement to A.'] }), responding, wave, [...answers, comparisonJob]);
      expect(parsed).toMatchObject({ kind: 'RESPONSE', newIssues: ['C attributed B’s requirement to A.'] });
    }
  });

  it.each([
    ['unknown source', (c: DiscourseTeamComparison) => { c.points[0]!.sourceMessageIds = ['invisible']; }],
    ['unknown author', (c: DiscourseTeamComparison) => { c.actions[0]!.participantId = 'D'; }],
    ['comparator authority as evidence', (c: DiscourseTeamComparison) => { c.actions[0]!.basisMessageIds = ['comparison']; }],
    ['unlocated criticism', (c: DiscourseTeamComparison) => { c.points[0]!.sourceMessageIds = []; }],
    ['advisory continuation', (c: DiscourseTeamComparison) => { c.points[0]!.importance = 'ADVISORY'; }],
    ['hidden disagreement', (c: DiscourseTeamComparison) => { c.next = 'READY'; c.actions = []; c.points[0]!.status = 'DISAGREED'; }],
    ['missing direct question', (c: DiscourseTeamComparison) => { c.actions[0]!.task = ''; }],
    ['duplicate action', (c: DiscourseTeamComparison) => { c.actions.push(c.actions[0]!); }]
  ])('rejects %s without repairing the output', (_label, mutate) => {
    const { wave, answers, comparisonJob, comparison } = fixture();
    mutate(comparison);
    expect(() => parseDiscourseTeamOutput(JSON.stringify(comparison), { ...comparisonJob, phase: 4, visibleMessageIds: [...comparisonJob.visibleMessageIds, 'comparison'] }, wave, [...answers, comparisonJob])).toThrow();
  });

  it('rejects dropped prior points and omitted or misdirected responses', () => {
    const { wave, answers, comparisonJob, comparison } = fixture();
    expect(() => parseDiscourseTeamOutput(JSON.stringify({ ...comparison, points: [], next: 'READY', actions: [] }), { ...comparisonJob, phase: 4 }, wave, [...answers, comparisonJob])).toThrow('preserve every prior point');
    const responding = job('responding', wave.assignments[0]!, 'RESPOND', 3, { targetMessageIds: ['comparison'] });
    expect(() => parseDiscourseTeamOutput('{"responses":[],"newIssues":[]}', responding, wave, [comparisonJob])).toThrow('each assigned point');
    expect(() => parseDiscourseTeamOutput('not JSON', comparisonJob, wave, answers)).toThrow('not valid JSON');
  });
});

function fixture() {
  const assignments = ['a', 'b', 'c'].map((id, index): AgentAssignmentSnapshot => ({
    stableParticipantId: id, participantRevisionId: `${id}-revision`, agentProfileId: ['builtin.lead', 'builtin.skeptic', 'builtin.verifier'][index]!,
    profileRevision: 2, displayNameSnapshot: id.toUpperCase(), runtimeId: 'codex', model: 'gpt-test', configuredRole: 'GENERAL',
    roleContractVersion: 4, roleContractHash: 'a'.repeat(64), assignmentRole: index < 2 ? 'AUTHOR' : 'COMPARATOR', required: true
  }));
  const wave: DiscourseResponseWaveRecord = { id: 'wave', conversationId: 'conversation', triggerMessageId: 'question', policy: 'TEAM', policyVersion: 2,
    assignments, sourceMessageIds: ['question'], plannedContextRevisionId: 'context', attempt: 1, recordRevision: 1, status: 'RUNNING', phase: 'COMPARE',
    clientOperationId: 'wave-create', requestFingerprint: 'f'.repeat(64), dispatchGate: { status: 'READY', previewFingerprint: 'p', confirmedAtRevision: 1 },
    createdAt: '2026-07-13T00:01:00Z', startedAt: '2026-07-13T00:05:00Z' };
  const answers = assignments.slice(0, 2).map((assignment) => job(`answer-${assignment.stableParticipantId}`, assignment, 'ANSWER', 1));
  const comparison: DiscourseTeamComparison = { kind: 'COMPARISON', summary: 'Compare rollback assumptions.',
    points: [{ id: 'P1', question: 'Which reader must remain?', importance: 'MATERIAL', status: 'OPEN', explanation: 'A and B may mean different deployment windows.', sourceMessageIds: ['answer-a', 'answer-b'], evidence: [], confidence: 'LOW' }],
    next: 'CONTINUE', reason: 'Clarify before choosing.', actions: [{ pointId: 'P1', participantId: 'a', task: 'Bound your requirement.', expectedBenefit: 'Avoid unnecessary support.', basisMessageIds: ['answer-a', 'answer-b'] }] };
  const comparisonJob = job('comparison', assignments[2]!, 'COMPARE', 2, { visibleMessageIds: ['question', 'answer-a', 'answer-b'],
    result: { kind: 'CONTRIBUTION', outputMessageId: 'comparison', team: comparison } });
  return { wave, answers, comparisonJob, comparison };
}

function job(id: string, assignment: AgentAssignmentSnapshot, role: DiscourseAgentJobRecord['role'], phase: number, overrides: Partial<DiscourseAgentJobRecord> = {}): DiscourseAgentJobRecord {
  return { id, conversationId: 'conversation', waveId: 'wave', assignment, role, phase, targetMessageIds: ['question'], visibleMessageIds: ['question'],
    attemptId: `${id}-attempt`, generationKey: id, recordRevision: 1, status: 'COMPLETED', delivery: 'TERMINAL', freshnessAtCompletion: 'FRESH',
    result: { kind: 'CONTRIBUTION', outputMessageId: id }, createdAt: '2026-07-13T00:05:00Z', finishedAt: '2026-07-13T00:10:00Z', ...overrides };
}
