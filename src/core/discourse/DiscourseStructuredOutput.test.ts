import { describe, expect, it } from 'vitest';
import type { DiscourseAgentJobRecord, DiscourseResponseWaveRecord } from '../../shared/discourse';
import { parseDiscourseCorrection, parseDiscourseReview, parseDiscourseTeamOutput } from './DiscourseStructuredOutput';

describe('structured discourse output', () => {
  it('reconciles a saved author response against its targeted comparison, not an earlier answer', () => {
    const answer = { result: { kind: 'CONTRIBUTION', outputMessageId: 'answer' } } as DiscourseAgentJobRecord;
    const comparison = { result: { kind: 'CONTRIBUTION', outputMessageId: 'comparison', team: {
      kind: 'COMPARISON', actions: [{ participantId: 'author', pointId: 'shared-limit' }]
    } } } as DiscourseAgentJobRecord;
    const unrelated = { result: { kind: 'CONTRIBUTION', outputMessageId: 'unrelated', team: {
      kind: 'COMPARISON', actions: [{ participantId: 'author', pointId: 'other-point' }]
    } } } as DiscourseAgentJobRecord;
    const job = { role: 'RESPOND', assignment: { stableParticipantId: 'author' },
      targetMessageIds: ['answer', 'comparison'] } as DiscourseAgentJobRecord;
    const wave = { policy: 'TEAM' } as DiscourseResponseWaveRecord;
    const response = { responses: [{ pointId: 'shared-limit', stance: 'REVISE',
      answer: 'Use one durable attempt counter.', reason: 'Workers share the retry budget.', evidence: [] }], newIssues: [] };

    expect(parseDiscourseTeamOutput(JSON.stringify(response), job, wave, [answer, unrelated, comparison]))
      .toEqual({ kind: 'RESPONSE', ...response });
    expect(() => parseDiscourseTeamOutput(JSON.stringify({ ...response, responses: [
      { ...response.responses[0], pointId: 'other-point' }
    ] }), job, wave, [answer, unrelated, comparison])).toThrow('each assigned point once');
  });

  it('accepts an evidence-scoped material concern', () => {
    expect(parseDiscourseReview(JSON.stringify({
      outcome: 'CONCERNS',
      reviewedScope: 'Lead answer against repository context',
      limitations: [],
      requiredAccessAvailable: true,
      concerns: [{
        targetClaim: 'The migration is reversible.',
        category: 'storage',
        severity: 'MATERIAL',
        confidence: 'HIGH',
        evidenceStatus: 'OBSERVED_CONTEXT',
        reason: 'The schema reader rejects older records.',
        evidence: 'The version guard is one-way.',
        suggestedResolution: 'Describe the migration as one-way.'
      }]
    }))).toMatchObject({ outcome: 'CONCERNS', concerns: [{ severity: 'MATERIAL' }] });
  });

  it('requires complete access for no-concern and a limitation for abstention', () => {
    expect(() => parseDiscourseReview(JSON.stringify({
      outcome: 'NO_CONCERN_FOUND',
      reviewedScope: 'answer',
      limitations: [],
      requiredAccessAvailable: false,
      concerns: []
    }))).toThrow('complete access');
    expect(() => parseDiscourseReview(JSON.stringify({
      outcome: 'ABSTAINED',
      reviewedScope: 'answer',
      limitations: [],
      requiredAccessAvailable: false,
      concerns: []
    }))).toThrow('explicit limitation');
  });

  it('parses an attributable defended correction outcome', () => {
    expect(parseDiscourseCorrection(JSON.stringify({
      outcome: 'DEFENDED',
      body: 'The original conclusion stands because the cited guard runs before dispatch.',
      limitations: []
    }))).toMatchObject({ outcome: 'DEFENDED' });
  });
});
