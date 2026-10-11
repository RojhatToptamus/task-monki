import { describe, expect, it } from 'vitest';
import {
  effectiveReviewFindings,
  effectiveReviewGateStatus,
  openReviewFindings,
  reviewAcceptsDecisions,
  type AgentReviewGateProjection,
  type AgentReviewResult,
  type ReviewFindingDecision
} from './agentReviewFindings';

const AT = '2026-10-10T10:00:00.000Z';
const REVIEW_RUN = 'review-run';

const result: AgentReviewResult = {
  schemaVersion: 'agent-review/v1',
  verdict: 'NEEDS_CHANGES',
  summary: 'Two problems.',
  findings: [
    { id: 'leak', severity: 'BLOCKER', title: 'Listener leaks', explanation: 'Never removed.', path: 'src/a.ts', line: 4 },
    { id: 'naming', severity: 'NIT', title: 'Unclear name', explanation: 'Rename it.' }
  ]
};

let sequence = 0;
function dismiss(findingId: string, note?: string): ReviewFindingDecision {
  sequence += 1;
  return { id: `decision-${sequence}`, reviewRunId: REVIEW_RUN, findingId, kind: 'DISMISS', dismissReason: 'NOT_A_PROBLEM', ...(note ? { note } : {}), createdAt: AT };
}
function restore(findingId: string): ReviewFindingDecision {
  sequence += 1;
  return { id: `decision-${sequence}`, reviewRunId: REVIEW_RUN, findingId, kind: 'RESTORE', createdAt: AT };
}

function gate(overrides: Partial<AgentReviewGateProjection> = {}): AgentReviewGateProjection {
  return { status: 'NEEDS_CHANGES', runId: REVIEW_RUN, result, findingDecisions: [], ...overrides };
}

describe('effectiveReviewFindings', () => {
  it('applies dismissals and restores in order', () => {
    const findings = effectiveReviewFindings(result, [dismiss('naming', 'Matches the codebase.')]);
    expect(findings).toEqual([
      expect.objectContaining({ id: 'leak', state: 'OPEN' }),
      expect.objectContaining({
        id: 'naming',
        state: 'DISMISSED',
        dismissal: { reason: 'NOT_A_PROBLEM', note: 'Matches the codebase.', decidedAt: AT }
      })
    ]);

    const restored = effectiveReviewFindings(result, [dismiss('naming'), restore('naming')]);
    expect(restored[1]).toMatchObject({ state: 'OPEN' });
    expect(restored[1]).not.toHaveProperty('dismissal');
  });

  it('ignores decisions that cannot apply', () => {
    const findings = effectiveReviewFindings(result, [
      restore('naming'),
      dismiss('unknown'),
      dismiss('leak', 'First.'),
      dismiss('leak', 'Second.')
    ]);
    expect(findings[0]).toMatchObject({ state: 'DISMISSED', dismissal: { note: 'First.' } });
    expect(findings[1]).toMatchObject({ state: 'OPEN' });
    expect(findings).toHaveLength(2);
  });

  it('lists open findings in review order', () => {
    expect(openReviewFindings(result, [dismiss('leak')]).map((finding) => finding.id)).toEqual(['naming']);
  });
});

const asksForChanges = (review: AgentReviewGateProjection | undefined) => effectiveReviewGateStatus(review) === 'NEEDS_CHANGES';

describe('effectiveReviewGateStatus', () => {
  it('asks for changes while a NEEDS_CHANGES verdict has an open Blocker or Major, and never for a stale or failed review', () => {
    expect(asksForChanges(gate())).toBe(true);
    // The open Nit alone is a suggestion: nothing would be sent by default.
    expect(asksForChanges(gate({ findingDecisions: [dismiss('leak')] }))).toBe(false);
    expect(asksForChanges(gate({ findingDecisions: [dismiss('leak'), restore('leak')] }))).toBe(true);
    expect(asksForChanges(gate({ status: 'STALE' }))).toBe(false);
    expect(asksForChanges(gate({ status: 'FAILED' }))).toBe(false);
    expect(asksForChanges(undefined)).toBe(false);
  });

  it('returns to the verdict once the findings that asked for changes are dismissed', () => {
    const majorFindings = (verdict: AgentReviewResult['verdict']): AgentReviewResult => ({
      ...result,
      verdict,
      findings: [{ ...result.findings[0]!, severity: 'MAJOR' }, result.findings[1]!]
    });

    expect(effectiveReviewGateStatus(gate({ result: majorFindings('PASSED') }))).toBe('NEEDS_CHANGES');
    expect(effectiveReviewGateStatus(gate({ result: majorFindings('PASSED'), findingDecisions: [dismiss('leak')] }))).toBe('PASSED');
    // The reviewer never reached a verdict, so clearing its findings never reads as passed.
    expect(effectiveReviewGateStatus(gate({
      result: majorFindings('INCONCLUSIVE'),
      findingDecisions: [dismiss('leak'), dismiss('naming')]
    }))).toBe('INCONCLUSIVE');
    // A NEEDS_CHANGES verdict asks only while a Blocker or Major stays open; Minor and Nit are suggestions.
    expect(effectiveReviewGateStatus(gate({ findingDecisions: [dismiss('leak')] }))).toBe('PASSED');
    expect(effectiveReviewGateStatus(gate({ result: majorFindings('NEEDS_CHANGES') }))).toBe('NEEDS_CHANGES');
    expect(effectiveReviewGateStatus(gate({ status: 'STALE', findingDecisions: [dismiss('leak')] }))).toBe('STALE');
  });

  it('keeps a raw-output review without findings asking for changes', () => {
    expect(asksForChanges({ status: 'NEEDS_CHANGES', runId: REVIEW_RUN })).toBe(true);
    expect(asksForChanges(gate({ result: { ...result, findings: [] } }))).toBe(true);
  });

  it('accepts decisions only for the current, finished review', () => {
    expect(reviewAcceptsDecisions(gate(), REVIEW_RUN)).toBe(true);
    expect(reviewAcceptsDecisions(gate({ status: 'PASSED' }), REVIEW_RUN)).toBe(true);
    expect(reviewAcceptsDecisions(gate(), 'other-review')).toBe(false);
    expect(reviewAcceptsDecisions(gate({ status: 'STALE' }), REVIEW_RUN)).toBe(false);
    expect(reviewAcceptsDecisions(gate({ status: 'RUNNING' }), REVIEW_RUN)).toBe(false);
    expect(reviewAcceptsDecisions({ status: 'NOT_RUN' })).toBe(false);
  });
});
