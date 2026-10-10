import { describe, expect, it } from 'vitest';
import { createInitialProjection } from '../../shared/contracts';
import type { AgentReviewFinding, RunRecord, Task } from '../../shared/contracts';
import type { FinishEvidenceState } from './taskFinish';
import {
  findCompletedCurrentImplementationRun,
  isActiveNonReviewRun,
  isCompletedCurrentImplementationRun,
  selectNextAction,
  type NextActionInput
} from './nextAction';

const now = '2026-06-24T10:00:00.000Z';

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    kind: overrides.kind ?? 'NORMAL',
    runtimeId: 'codex',
    title: 'Task',
    prompt: 'Prompt',
    repositoryId: '/tmp/repo',
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
    hasReviewSource: true,
    reviewHasActionableFindings: false,
    canCommit: false,
    awaitingMoveToReview: false,
    runInFlight: false,
    ...overrides
  };
}

const findings: AgentReviewFinding[] = [
  { id: 'a', severity: 'BLOCKER', title: 'A', explanation: 'x' }
];

describe('selectNextAction', () => {
  it('names the running state and offers no primary while in flight', () => {
    expect(selectNextAction(baseInput({ runInFlight: true })).primary).toBeUndefined();
    const running = selectNextAction(baseInput({ reviewStatus: 'RUNNING' }));
    expect(running.primary).toBeUndefined();
    expect(running.title).toBe('Reviewing');
  });

  it('recommends running review when none has run', () => {
    expect(selectNextAction(baseInput()).primary?.id).toBe('run-review');
  });

  it('lets the owner finish without running the agent review', () => {
    const override: FinishEvidenceState = {
      mode: 'override',
      warnings: [{ title: 'No passing review is recorded.', detail: 'x' }]
    };
    const ids = (input: Partial<NextActionInput>) =>
      selectNextAction(baseInput(input)).secondaries.map((choice) => choice.id);

    // The review is a detached gate: Commit and Mark done anyway stay reachable.
    expect(ids({ finishEvidence: override, canCommit: true })).toEqual(['commit', 'mark-done-anyway']);
    expect(ids({ reviewStatus: 'STALE', finishEvidence: override })).toEqual(['mark-done-anyway']);
    expect(ids({ reviewStatus: 'NEEDS_CHANGES', reviewHasActionableFindings: true, finishEvidence: override }))
      .toEqual(['run-review-again', 'mark-done-anyway']);
    // A policy that still needs merge evidence blocks Mark done, not Commit.
    expect(ids({ finishEvidence: { mode: 'blocked', warnings: [] }, canCommit: true })).toEqual(['commit']);
    // Nothing to finish yet, and nothing while work is in flight.
    expect(ids({ hasReviewSource: false, finishEvidence: override })).toEqual([]);
    expect(ids({ runInFlight: true, finishEvidence: override })).toEqual([]);
  });

  it('leads with finishing once the pull request is merged', () => {
    const merged = (finishEvidence: FinishEvidenceState) => selectNextAction(baseInput({
      task: createTask({ projection: { ...createInitialProjection(now), githubPullRequest: 'MERGED', merge: 'MERGED' } }),
      finishEvidence
    }));

    // The agent review no longer leads after delivery; the policy decides how to finish.
    expect(merged({ mode: 'clean', warnings: [] }).primary?.id).toBe('mark-done');
    // Marking done despite open evidence is offered as the owner's override, never the lead.
    const override = merged({ mode: 'override', warnings: [{ title: 'No passing review is recorded.', detail: 'x' }] });
    expect(override.primary).toBeUndefined();
    expect(override.secondaries.map((choice) => choice.id)).toEqual(['mark-done-anyway']);
    // A policy still waiting on verified checks leaves nothing to press, only requirements.
    const blocked = merged({ mode: 'blocked', warnings: [] });
    expect(blocked.primary).toBeUndefined();
    expect(blocked.title).toBe('Merged');
  });

  it('keeps finishing to the Review phases', () => {
    const inProgress = selectNextAction(baseInput({
      task: createTask({ workflowPhase: 'IN_PROGRESS' }),
      finishEvidence: { mode: 'override', warnings: [{ title: 'No passing review is recorded.', detail: 'x' }] },
      canCommit: true
    }));

    expect(inProgress.primary?.id).toBe('run-review');
    expect(inProgress.secondaries).toEqual([]);
    // Outside the Review phases a review source with nothing completed is imported work.
    expect(inProgress.title).toBe('No agent run yet');
  });

  it('has no primary review action without a review source', () => {
    expect(selectNextAction(baseInput({ hasReviewSource: false })).primary).toBeUndefined();
  });

  it('keeps failed implementation recovery ahead of the review gate', () => {
    const model = selectNextAction(
      baseInput({
        implementationRunStatus: 'FAILED',
        hasReviewSource: false
      })
    );

    expect(model.primary).toBeUndefined();
    expect(model.secondaries).toEqual([]);
    expect(model.title).toBe('Run failed');
  });

  it('keeps a locally blocked completed implementation ahead of the review gate', () => {
    const model = selectNextAction(
      baseInput({
        implementationRunStatus: 'COMPLETED',
        implementationRetryRequired: true,
        awaitingMoveToReview: false,
        hasReviewSource: false
      })
    );

    expect(model.primary).toBeUndefined();
    expect(model.title).toBe('Needs retry');
  });

  it('does not offer review from an older completed run while the current run is interrupting', () => {
    const priorCompletedRun = run({ id: 'prior-run', status: 'COMPLETED' });
    const currentRun = run({ id: 'current-run', status: 'INTERRUPTING' });
    const model = selectNextAction(
      baseInput({
        hasReviewSource: priorCompletedRun.status === 'COMPLETED',
        runInFlight: isActiveNonReviewRun(currentRun),
        implementationRunStatus: currentRun.status
      })
    );

    expect(isActiveNonReviewRun(currentRun)).toBe(true);
    expect(model.primary).toBeUndefined();
    expect(model.secondaries).toEqual([]);
    expect(model.title).toBe('Running');
  });

  it('recommends request-changes when review needs changes with findings', () => {
    const model = selectNextAction(
      baseInput({
        reviewStatus: 'NEEDS_CHANGES',
        reviewHasActionableFindings: true,
        task: createTask({
          projection: {
            ...createInitialProjection(now),
            agentReview: {
              status: 'NEEDS_CHANGES',
              runId: 'r',
              result: {
                schemaVersion: 'agent-review/v1',
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
    // The title is the review's verdict, so the review section need not repeat it.
    expect(model.title).toBe('Needs changes');
  });

  it('recommends re-running a stale review', () => {
    const model = selectNextAction(baseInput({ reviewStatus: 'STALE' }));
    expect(model.primary?.id).toBe('run-review-again');
    expect(model.title).toBe('Needs re-review');
  });

  it.each(['ANALYSIS', 'COMPACTION'] as const)(
    'keeps a stale historical review contextual after completed %s work',
    (mode) => {
      const task = createTask({
        currentRunId: 'current-run',
        workflowPhase: 'IN_PROGRESS'
      });
      const historicalImplementation = run({
        id: 'historical-implementation',
        status: 'COMPLETED'
      });
      const currentRun = run({ id: 'current-run', mode, status: 'COMPLETED' });
      const actionableSource = findCompletedCurrentImplementationRun(task, [
        historicalImplementation,
        currentRun
      ]);
      const model = selectNextAction(
        baseInput({
          task,
          reviewStatus: 'STALE',
          hasReviewSource: Boolean(actionableSource),
          implementationRunStatus: currentRun.status
        })
      );

      expect(actionableSource).toBeUndefined();
      expect(model.primary).toBeUndefined();
      expect(model.secondaries).toEqual([]);
      expect(model.title).toBe('Review is from an earlier run');
    }
  );

  it('selects the exact current completed implementation for a fresh review', () => {
    const task = createTask({
      currentRunId: 'current-implementation',
      workflowPhase: 'REVIEW'
    });
    const historicalImplementation = run({
      id: 'historical-implementation',
      status: 'COMPLETED'
    });
    const currentImplementation = run({
      id: 'current-implementation',
      mode: 'FOLLOW_UP',
      status: 'COMPLETED'
    });

    expect(
      findCompletedCurrentImplementationRun(task, [
        historicalImplementation,
        currentImplementation
      ])
    ).toBe(currentImplementation);
  });

  it('recommends mark-done when review passed and tree is clean', () => {
    const model = selectNextAction(baseInput({ reviewStatus: 'PASSED' }));
    expect(model.primary?.id).toBe('mark-done');
  });

  it('never leads with the mark-done override when there is nothing to commit', () => {
    const model = selectNextAction(
      baseInput({ reviewStatus: 'PASSED', finishEvidence: { mode: 'override', warnings: [] }, canCommit: false })
    );
    expect(model.primary).toBeUndefined();
    expect(model.secondaries.map((choice) => choice.id)).toEqual(['mark-done-anyway']);
  });

  it('leads with commit and offers mark-done-anyway on an override', () => {
    const model = selectNextAction(
      baseInput({
        reviewStatus: 'PASSED',
        finishEvidence: { mode: 'override', warnings: [] },
        canCommit: true
      })
    );
    expect(model.primary?.id).toBe('commit');
    expect(model.secondaries.map((s) => s.id)).toContain('mark-done-anyway');
    expect(model.title).toBe('Review passed');
  });

  it('offers no primary when blocked from finishing; the requirements name the gate', () => {
    const model = selectNextAction(
      baseInput({
        reviewStatus: 'PASSED',
        finishEvidence: { mode: 'blocked', warnings: [] }
      })
    );
    expect(model.primary).toBeUndefined();
    expect(model.title).toBe('Review passed');
  });

  it('recommends moving a completed current implementation to review', () => {
    const task = createTask({
      currentRunId: 'implementation-run',
      workflowPhase: 'IN_PROGRESS'
    });
    const currentRun = run({ id: 'implementation-run', status: 'COMPLETED' });
    const model = selectNextAction(
      baseInput({
        task,
        awaitingMoveToReview: isCompletedCurrentImplementationRun(task, currentRun)
      })
    );

    expect(isCompletedCurrentImplementationRun(task, currentRun)).toBe(true);
    expect(model.primary?.id).toBe('move-to-review');
  });

  it.each(['ANALYSIS', 'COMPACTION'] as const)(
    'does not offer review after a completed %s run',
    (mode) => {
      const task = createTask({
        currentRunId: `${mode.toLowerCase()}-run`,
        workflowPhase: 'IN_PROGRESS'
      });
      const currentRun = run({
        id: task.currentRunId,
        mode,
        status: 'COMPLETED'
      });
      const reviewReady = isCompletedCurrentImplementationRun(task, currentRun);
      const model = selectNextAction(
        baseInput({ task, awaitingMoveToReview: reviewReady, hasReviewSource: false })
      );

      expect(reviewReady).toBe(false);
      expect(model.primary).toBeUndefined();
      expect(model.title).not.toMatch(/move.*review/i);
    }
  );

  it('says nothing to do once done', () => {
    const model = selectNextAction(
      baseInput({ task: createTask({ workflowPhase: 'DONE' }) })
    );
    expect(model.primary).toBeUndefined();
    expect(model.title).toBe('Done');
  });
});

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    runtimeId: 'codex',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    sessionId: 'session-1',
    mode: 'IMPLEMENTATION',
    origin: 'TASK_MONKI',
    status: 'RUNNING',
    recoveryState: 'NONE',
    requestedSettings: {},
    promptArtifactId: 'prompt-1',
    outputArtifactId: 'output-1',
    diagnosticArtifactId: 'diagnostic-1',
    startedAt: now,
    eventCount: 0,
    ...overrides,
    attachmentSelection: overrides.attachmentSelection ?? []
  };
}
