import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunRecord, Task, TaskSnapshot } from '../../shared/contracts';
import { prepareTestWorktree } from '../../testSupport/prepareWorktree';
import { TaskMonkiScenarioRegistry, type TaskMonkiScenario } from '../../testSupport/taskMonkiScenario';

const scenarios = new TaskMonkiScenarioRegistry();

afterEach(async () => {
  await scenarios.dispose();
});

const REVIEW_OUTPUT = 'Three findings.\n```json\n' + JSON.stringify({
  schemaVersion: 'agent-review/v1',
  verdict: 'NEEDS_CHANGES',
  summary: 'Three findings.',
  findings: [
    { id: 'leak', severity: 'MAJOR', title: 'Listener leaks', explanation: 'It is never removed.', path: 'feature.ts', line: 2 },
    { id: 'naming', severity: 'NIT', title: 'Unclear name', explanation: 'Rename the value.' },
    { id: 'docs', severity: 'MINOR', title: 'Missing docs', explanation: 'Document the module.' }
  ]
}) + '\n```';

async function reviewedTask(name: string): Promise<{
  s: TaskMonkiScenario;
  task: Task;
  implementation: RunRecord;
  review: RunRecord;
  worktreePath: string;
}> {
  const s = await scenarios.create({ name });
  const task = await s.createTask({ title: 'Review decisions', prompt: 'Add the feature module.' });
  const worktree = await prepareTestWorktree(s.service, task.id);
  const implementation = await s.service.startRun({ taskId: task.id });
  await fs.writeFile(path.join(worktree.worktreePath, 'feature.ts'), 'export const value = 1;\nwindow.addEventListener("x", () => {});\n');
  await s.completeRun(implementation.id, 'Implemented the feature module.');
  s.agent.nextRuntimeTurnResult = { output: REVIEW_OUTPUT };
  const review = await s.service.startReview({ taskId: task.id, runId: implementation.id });
  await s.waitForSnapshot((state) =>
    state.tasks.find((candidate) => candidate.id === task.id)?.projection.agentReview?.status === 'NEEDS_CHANGES' &&
    Boolean(state.runs.find((candidate) => candidate.id === review.id)?.afterGitSnapshotId));
  return { s, task, implementation, review, worktreePath: worktree.worktreePath };
}

function reviewOf(state: TaskSnapshot, taskId: string) {
  return state.tasks.find((candidate) => candidate.id === taskId)!.projection.agentReview;
}

async function boardReview(s: TaskMonkiScenario, taskId: string) {
  return (await s.service.getBoardSnapshot()).tasks.find((candidate) => candidate.id === taskId)!.projection.agentReview;
}

describe('TaskManagerService review finding decisions', () => {
  it('dismisses findings as incorrect, intentional or not now, restores them, and tells the next review', async () => {
    const { s, task, implementation, review, worktreePath } = await reviewedTask('task-monki-review-decisions');
    expect(await boardReview(s, task.id)).toMatchObject({
      effectiveStatus: 'NEEDS_CHANGES',
      findingCounts: { MAJOR: 1, MINOR: 1, NIT: 1 }
    });

    const dismissed = await s.service.decideReviewFinding({
      taskId: task.id, reviewRunId: review.id, findingId: 'leak', kind: 'DISMISS', dismissReason: 'ACCEPTED', note: '  Handled by the caller.  '
    });
    expect(dismissed).toMatchObject({
      actor: 'USER', kind: 'DISMISS', findingId: 'leak', dismissReason: 'ACCEPTED', note: 'Handled by the caller.'
    });
    // With the Major dismissed, nothing would be sent by default: the review no longer asks for changes.
    expect(await boardReview(s, task.id)).toMatchObject({ status: 'NEEDS_CHANGES', effectiveStatus: 'PASSED', findingCounts: { MINOR: 1, NIT: 1 } });
    await s.service.decideReviewFinding({ taskId: task.id, reviewRunId: review.id, findingId: 'docs', kind: 'DISMISS', dismissReason: 'DEFERRED' });
    await s.service.decideReviewFinding({ taskId: task.id, reviewRunId: review.id, findingId: 'naming', kind: 'DISMISS', dismissReason: 'NOT_A_PROBLEM' });
    expect(await boardReview(s, task.id)).toMatchObject({ status: 'NEEDS_CHANGES', effectiveStatus: 'PASSED', findingCounts: {} });

    await expect(s.service.decideReviewFinding({
      taskId: task.id, reviewRunId: review.id, findingId: 'leak', kind: 'DISMISS'
    })).rejects.toThrow('already dismissed');
    await expect(s.service.decideReviewFinding({
      taskId: task.id, reviewRunId: review.id, findingId: 'naming', kind: 'RESTORE', note: 'Not allowed.'
    })).rejects.toThrow('Only a dismissal takes a note.');
    await expect(s.service.decideReviewFinding({
      taskId: task.id, reviewRunId: review.id, findingId: 'naming', kind: 'RESTORE', dismissReason: 'NOT_A_PROBLEM'
    })).rejects.toThrow('A dismissal reason is Incorrect, Intentional or Won\'t fix now.');
    await expect(s.service.decideReviewFinding({
      taskId: task.id, reviewRunId: review.id, findingId: 'missing', kind: 'DISMISS'
    })).rejects.toThrow('not part of the review');
    await expect(s.service.decideReviewFinding({
      taskId: task.id, reviewRunId: randomUUID(), findingId: 'leak', kind: 'RESTORE'
    })).rejects.toThrow('no longer the task’s current review');
    await expect(s.service.decideReviewFinding({
      taskId: task.id, reviewRunId: review.id, findingId: 'naming', kind: 'RESTORE', note: 'x'.repeat(501)
    })).rejects.toThrow('Only a dismissal takes a note.');
    // A missing review or finding ID is refused up front, never treated as "the current review".
    await expect(s.service.decideReviewFinding({
      taskId: task.id, reviewRunId: undefined as unknown as string, findingId: 'naming', kind: 'DISMISS'
    })).rejects.toThrow('A valid review run ID is required.');
    await expect(s.service.decideReviewFinding({
      taskId: task.id, reviewRunId: review.id, findingId: '', kind: 'DISMISS'
    })).rejects.toThrow('A valid finding ID is required.');

    // An open Nit is a suggestion: the review asks for changes only while a Blocker or Major is open.
    await s.service.decideReviewFinding({ taskId: task.id, reviewRunId: review.id, findingId: 'naming', kind: 'RESTORE' });
    expect(await boardReview(s, task.id)).toMatchObject({ effectiveStatus: 'PASSED', findingCounts: { NIT: 1 } });
    await expect(s.service.decideReviewFinding({
      taskId: task.id, reviewRunId: review.id, findingId: 'naming', kind: 'DISMISS', note: 'x'.repeat(501)
    })).rejects.toThrow('at most 500 characters');
    const recorded = reviewOf(await s.store.snapshot(), task.id)?.findingDecisions ?? [];
    expect(recorded.map((decision) => `${decision.kind}:${decision.findingId}:${decision.dismissReason ?? ''}`)).toEqual([
      'DISMISS:leak:ACCEPTED', 'DISMISS:docs:DEFERRED', 'DISMISS:naming:NOT_A_PROBLEM', 'RESTORE:naming:'
    ]);

    await fs.writeFile(path.join(worktreePath, 'feature.ts'), 'export const value = 2;\n');
    await s.service.refreshEvidence({ taskId: task.id });
    expect(reviewOf(await s.store.snapshot(), task.id)?.status).toBe('STALE');
    await expect(s.service.decideReviewFinding({
      taskId: task.id, reviewRunId: review.id, findingId: 'naming', kind: 'DISMISS'
    })).rejects.toThrow('The code changed after this review.');

    // The next review starts with no decisions and is told how each earlier finding was left.
    const rerun = await s.service.startReview({ taskId: task.id, runId: implementation.id });
    expect(reviewOf(await s.store.snapshot(), task.id)).toMatchObject({ runId: rerun.id, findingDecisions: [] });
    const rerunPrompt = await s.runtimeStore.readArtifact(rerun.promptArtifactId);
    expect(rerunPrompt).toContain('[MAJOR] Listener leaks at feature.ts:2 (marked intentional by the person: Handled by the caller.)');
    expect(rerunPrompt).toContain('[MINOR] Missing docs (deferred by the person)');
    expect(rerunPrompt).toContain('[NIT] Unclear name (open)');
    expect(rerunPrompt).toContain('Never raise one they marked incorrect, or one withdrawn, again.');
    expect(rerunPrompt).toContain('Raise one they marked intentional again only if the code around it changed materially');
  }, 20_000);

  it('keeps the review of a canceled or archived task as a record that takes no decisions', async () => {
    const { s, task, review } = await reviewedTask('task-monki-review-decisions-closed-task');
    const dismiss = () => s.service.decideReviewFinding({
      taskId: task.id, reviewRunId: review.id, findingId: 'naming', kind: 'DISMISS'
    });

    await s.service.transitionTask({ taskId: task.id, toPhase: 'CANCELED' });
    await expect(dismiss()).rejects.toThrow('This task is canceled, so its review takes no decisions.');
    await s.service.transitionTask({ taskId: task.id, toPhase: 'ARCHIVED' });
    await expect(dismiss()).rejects.toThrow('This task is archived, so its review takes no decisions.');

    expect(reviewOf(await s.store.snapshot(), task.id)?.findingDecisions).toEqual([]);
  }, 20_000);
});
