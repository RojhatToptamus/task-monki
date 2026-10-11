import { describe, expect, it } from 'vitest';
import {
  effectiveReviewFindings,
  effectiveReviewGateStatus,
  openReviewFindings,
  reviewAcceptsDecisions,
  reviewAsksForChanges,
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
function decision(input: Partial<ReviewFindingDecision> & Pick<ReviewFindingDecision, 'kind' | 'findingId'>): ReviewFindingDecision {
  sequence += 1;
  return {
    id: `decision-${sequence}`,
    reviewRunId: REVIEW_RUN,
    actor: input.kind === 'DISMISS' || input.kind === 'RESTORE' ? 'USER' : 'REVIEWER',
    createdAt: AT,
    ...input
  };
}

function gate(overrides: Partial<AgentReviewGateProjection> = {}): AgentReviewGateProjection {
  return { status: 'NEEDS_CHANGES', runId: REVIEW_RUN, result, findingDecisions: [], ...overrides };
}

describe('effectiveReviewFindings', () => {
  it('applies dismissals, restores and reviewer revisions in order', () => {
    const findings = effectiveReviewFindings(result, [
      decision({ kind: 'DISMISS', findingId: 'naming', dismissReason: 'NOT_A_PROBLEM', note: 'Matches the codebase.' }),
      decision({ kind: 'CHANGE_SEVERITY', findingId: 'leak', severity: 'MINOR', reason: 'Only in tests.' }),
      decision({
        kind: 'ADD',
        findingId: 'added-1',
        reason: 'Found while answering.',
        finding: { id: 'added-1', severity: 'MAJOR', title: 'Missing guard', explanation: 'Null input crashes.', path: 'src/a.ts' }
      })
    ]);

    expect(findings).toEqual([
      expect.objectContaining({
        id: 'leak',
        severity: 'MINOR',
        originalSeverity: 'BLOCKER',
        state: 'OPEN',
        addedByReviewer: false,
        revision: { kind: 'CHANGE_SEVERITY', reason: 'Only in tests.', decidedAt: AT }
      }),
      expect.objectContaining({
        id: 'naming',
        state: 'DISMISSED',
        dismissal: { reason: 'NOT_A_PROBLEM', note: 'Matches the codebase.', decidedAt: AT }
      }),
      expect.objectContaining({
        id: 'added-1',
        state: 'OPEN',
        addedByReviewer: true,
        revision: { kind: 'ADD', reason: 'Found while answering.', decidedAt: AT }
      })
    ]);

    const restored = effectiveReviewFindings(result, [
      decision({ kind: 'DISMISS', findingId: 'naming' }),
      decision({ kind: 'RESTORE', findingId: 'naming' })
    ]);
    expect(restored[1]).toMatchObject({ state: 'OPEN' });
    expect(restored[1]).not.toHaveProperty('dismissal');
  });

  it('keeps a withdrawn finding withdrawn and ignores decisions that cannot apply', () => {
    const findings = effectiveReviewFindings(result, [
      decision({ kind: 'WITHDRAW', findingId: 'leak', reason: 'The listener is removed in dispose.' }),
      decision({ kind: 'DISMISS', findingId: 'leak' }),
      decision({ kind: 'RESTORE', findingId: 'naming' }),
      decision({ kind: 'DISMISS', findingId: 'unknown' }),
      decision({ kind: 'CHANGE_SEVERITY', findingId: 'leak', severity: 'NIT', reason: 'Late.' })
    ]);

    expect(findings[0]).toMatchObject({
      state: 'WITHDRAWN',
      severity: 'BLOCKER',
      revision: { kind: 'WITHDRAW', reason: 'The listener is removed in dispose.' }
    });
    expect(findings[0]).not.toHaveProperty('dismissal');
    expect(findings[1]).toMatchObject({ state: 'OPEN' });
    expect(findings).toHaveLength(2);
  });

  it('lists open findings in review order, then added order', () => {
    const open = openReviewFindings(result, [
      decision({ kind: 'DISMISS', findingId: 'leak' }),
      decision({
        kind: 'ADD',
        findingId: 'added-1',
        reason: 'New.',
        finding: { id: 'added-1', severity: 'MINOR', title: 'Added', explanation: 'Added.', path: 'src/b.ts' }
      })
    ]);
    expect(open.map((finding) => finding.id)).toEqual(['naming', 'added-1']);
  });
});

describe('reviewAsksForChanges', () => {
  it('asks for changes while a NEEDS_CHANGES verdict has an open Blocker or Major, and never for a stale or failed review', () => {
    expect(reviewAsksForChanges(gate())).toBe(true);
    // The open Nit alone is a suggestion: nothing would be sent by default.
    expect(reviewAsksForChanges(gate({ findingDecisions: [decision({ kind: 'DISMISS', findingId: 'leak' })] }))).toBe(false);
    expect(reviewAsksForChanges(gate({
      findingDecisions: [
        decision({ kind: 'DISMISS', findingId: 'leak' }),
        decision({ kind: 'WITHDRAW', findingId: 'naming', reason: 'Style only.' })
      ]
    }))).toBe(false);
    expect(reviewAsksForChanges(gate({
      findingDecisions: [
        decision({ kind: 'DISMISS', findingId: 'leak' }),
        decision({ kind: 'RESTORE', findingId: 'leak' })
      ]
    }))).toBe(true);
    expect(reviewAsksForChanges(gate({ status: 'STALE' }))).toBe(false);
    expect(reviewAsksForChanges(gate({ status: 'FAILED' }))).toBe(false);
    expect(reviewAsksForChanges(undefined)).toBe(false);
  });

  it('asks for changes once the reviewer adds or raises a BLOCKER or MAJOR finding on a passed or inconclusive review', () => {
    const passed: AgentReviewResult = {
      schemaVersion: 'agent-review/v1',
      verdict: 'PASSED',
      summary: 'Looks good.',
      findings: [{ id: 'style', severity: 'MINOR', title: 'Long function', explanation: 'Split it.', path: 'src/a.ts' }]
    };
    const added = (severity: AgentReviewResult['findings'][number]['severity']) => decision({
      kind: 'ADD',
      findingId: 'added-1',
      reason: 'Found while answering.',
      finding: { id: 'added-1', severity, title: 'Missing guard', explanation: 'Null input crashes.', path: 'src/a.ts' }
    });
    const passedGate = (findingDecisions: ReviewFindingDecision[]) =>
      gate({ status: 'PASSED', result: passed, findingDecisions });

    expect(effectiveReviewGateStatus(passedGate([]))).toBe('PASSED');
    expect(effectiveReviewGateStatus(passedGate([added('MINOR')]))).toBe('PASSED');
    expect(effectiveReviewGateStatus(passedGate([added('BLOCKER')]))).toBe('NEEDS_CHANGES');
    expect(reviewAsksForChanges(passedGate([added('BLOCKER')]))).toBe(true);
    expect(effectiveReviewGateStatus(passedGate([
      decision({ kind: 'CHANGE_SEVERITY', findingId: 'style', severity: 'MAJOR', reason: 'Reachable in production.' })
    ]))).toBe('NEEDS_CHANGES');
    // Dismissing the added blocker returns the review to its passing verdict.
    expect(effectiveReviewGateStatus(passedGate([added('BLOCKER'), decision({ kind: 'DISMISS', findingId: 'added-1' })])))
      .toBe('PASSED');
    expect(effectiveReviewGateStatus(gate({
      status: 'INCONCLUSIVE',
      result: { ...passed, verdict: 'INCONCLUSIVE' },
      findingDecisions: [added('MAJOR')]
    }))).toBe('NEEDS_CHANGES');
  });

  it('stops asking for changes once the findings that caused it are downgraded, returning to the verdict', () => {
    const majorFindings = (verdict: AgentReviewResult['verdict']): AgentReviewResult => ({
      ...result,
      verdict,
      findings: [{ ...result.findings[0]!, severity: 'MAJOR' }, result.findings[1]!]
    });
    const downgraded = [decision({ kind: 'CHANGE_SEVERITY', findingId: 'leak', severity: 'MINOR', reason: 'Only in tests.' })];

    expect(effectiveReviewGateStatus(gate({ result: majorFindings('PASSED') }))).toBe('NEEDS_CHANGES');
    expect(effectiveReviewGateStatus(gate({ result: majorFindings('PASSED'), findingDecisions: downgraded }))).toBe('PASSED');
    expect(reviewAsksForChanges(gate({ result: majorFindings('PASSED'), findingDecisions: downgraded }))).toBe(false);
    // The reviewer never reached a verdict, so clearing its findings never reads as passed.
    expect(effectiveReviewGateStatus(gate({ result: majorFindings('INCONCLUSIVE'), findingDecisions: downgraded })))
      .toBe('INCONCLUSIVE');
    expect(effectiveReviewGateStatus(gate({
      result: majorFindings('INCONCLUSIVE'),
      findingDecisions: [decision({ kind: 'DISMISS', findingId: 'leak' }), decision({ kind: 'DISMISS', findingId: 'naming' })]
    }))).toBe('INCONCLUSIVE');
    // A NEEDS_CHANGES verdict asks only while a Blocker or Major stays open; Minor and Nit are suggestions.
    expect(effectiveReviewGateStatus(gate({ findingDecisions: downgraded }))).toBe('PASSED');
    expect(effectiveReviewGateStatus(gate({ result: majorFindings('NEEDS_CHANGES') }))).toBe('NEEDS_CHANGES');
    expect(effectiveReviewGateStatus(gate({ status: 'STALE', findingDecisions: downgraded }))).toBe('STALE');
  });

  it('keeps a raw-output review without findings asking for changes', () => {
    expect(reviewAsksForChanges({ status: 'NEEDS_CHANGES', runId: REVIEW_RUN })).toBe(true);
    expect(reviewAsksForChanges(gate({ result: { ...result, findings: [] } }))).toBe(true);
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
