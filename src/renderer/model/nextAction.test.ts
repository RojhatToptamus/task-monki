import { describe, expect, it } from 'vitest';
import { createInitialProjection } from '../../shared/contracts';
import type { CodexReviewFinding, Task } from '../../shared/contracts';
import type { FinishEvidenceState, FinishRequirement } from '../ui/taskView';
import { selectNextAction, type NextActionInput } from './nextAction';

const now = '2026-06-24T10:00:00.000Z';

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Task',
    prompt: 'Prompt',
    repositoryPath: '/tmp/repo',
    workflowPhase: 'REVIEW',
    resolution: 'NONE',
    completionPolicy: 'LOCAL_ACCEPTANCE',
    phaseVersion: 1,
    forkedAlternativeTaskIds: [],
    agentSettings: {},
    createdAt: now,
    updatedAt: now,
    projection: createInitialProjection(now),
    ...overrides
  };
}

function clean(): FinishEvidenceState {
  return { mode: 'clean', warnings: [] };
}

function baseInput(overrides: Partial<NextActionInput> = {}): NextActionInput {
  return {
    task: createTask(),
    reviewStatus: 'NOT_RUN',
    finishEvidence: clean(),
    requirements: [],
    hasReviewSource: true,
    reviewHasActionableFindings: false,
    canCommit: false,
    awaitingMoveToReview: false,
    runInFlight: false,
    ...overrides
  };
}

const findings: CodexReviewFinding[] = [
  { id: 'a', severity: 'BLOCKER', title: 'A', explanation: 'x' }
];

describe('selectNextAction', () => {
  it('names the running state and offers no primary while in flight', () => {
    expect(selectNextAction(baseInput({ runInFlight: true })).primary).toBeUndefined();
    const running = selectNextAction(baseInput({ reviewStatus: 'RUNNING' }));
    expect(running.primary).toBeUndefined();
    expect(running.sentence).toMatch(/reviewing/i);
  });

  it('recommends running review when none has run', () => {
    expect(selectNextAction(baseInput()).primary?.id).toBe('run-review');
  });

  it('has no primary review action without a review source', () => {
    expect(selectNextAction(baseInput({ hasReviewSource: false })).primary).toBeUndefined();
  });

  it('recommends request-changes when review needs changes with findings', () => {
    const model = selectNextAction(
      baseInput({
        reviewStatus: 'NEEDS_CHANGES',
        reviewHasActionableFindings: true,
        task: createTask({
          projection: {
            ...createInitialProjection(now),
            codexReview: {
              status: 'NEEDS_CHANGES',
              runId: 'r',
              result: {
                schemaVersion: 'codex-review/v1',
                verdict: 'NEEDS_CHANGES',
                summary: 's',
                findings
              }
            }
          }
        })
      })
    );
    expect(model.primary?.id).toBe('request-changes');
    expect(model.secondaries.map((s) => s.id)).toContain('run-review-again');
    expect(model.sentence).toContain('1 finding');
  });

  it('recommends re-running a stale review', () => {
    const model = selectNextAction(baseInput({ reviewStatus: 'STALE' }));
    expect(model.primary?.id).toBe('run-review-again');
    expect(model.sentence).toMatch(/re-run/i);
  });

  it('recommends mark-done when review passed and tree is clean', () => {
    const model = selectNextAction(baseInput({ reviewStatus: 'PASSED' }));
    expect(model.primary?.id).toBe('mark-done');
  });

  it('leads with commit and offers mark-done-anyway on an override', () => {
    const requirements: FinishRequirement[] = [
      { label: 'Tree', detail: '3 dirty', tone: 'action', unresolved: true }
    ];
    const model = selectNextAction(
      baseInput({
        reviewStatus: 'PASSED',
        finishEvidence: { mode: 'override', warnings: [] },
        requirements,
        canCommit: true
      })
    );
    expect(model.primary?.id).toBe('commit');
    expect(model.secondaries.map((s) => s.id)).toContain('mark-done-anyway');
    expect(model.sentence).toContain('Tree 3 dirty');
  });

  it('offers no primary but names the gate when blocked from finishing', () => {
    const requirements: FinishRequirement[] = [
      { label: 'Merge', detail: 'not merged', tone: 'action', unresolved: true }
    ];
    const model = selectNextAction(
      baseInput({
        reviewStatus: 'PASSED',
        finishEvidence: { mode: 'blocked', warnings: [] },
        requirements
      })
    );
    expect(model.primary).toBeUndefined();
    expect(model.sentence).toMatch(/blocked/i);
  });

  it('recommends moving a finished implementation to review', () => {
    const model = selectNextAction(baseInput({ awaitingMoveToReview: true }));
    expect(model.primary?.id).toBe('move-to-review');
  });

  it('says nothing to do once done', () => {
    const model = selectNextAction(
      baseInput({ task: createTask({ workflowPhase: 'DONE' }) })
    );
    expect(model.primary).toBeUndefined();
    expect(model.sentence).toMatch(/done/i);
  });
});
