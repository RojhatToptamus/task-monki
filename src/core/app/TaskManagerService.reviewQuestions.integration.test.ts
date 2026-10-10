import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunRecord, Task, TaskSnapshot } from '../../shared/contracts';
import { readTaskUserContext } from '../prompt/TaskUserContext';
import { openTestPersistence } from '../../testSupport/persistenceFixture';
import { prepareTestWorktree } from '../../testSupport/prepareWorktree';
import { TaskMonkiScenarioRegistry, type TaskMonkiScenario } from '../../testSupport/taskMonkiScenario';

const scenarios = new TaskMonkiScenarioRegistry();

afterEach(async () => {
  await scenarios.dispose();
});

const REVIEW_OUTPUT = 'Two findings.\n```json\n' + JSON.stringify({
  schemaVersion: 'agent-review/v1',
  verdict: 'NEEDS_CHANGES',
  summary: 'Two findings.',
  findings: [
    { id: 'leak', severity: 'MAJOR', title: 'Listener leaks', explanation: 'It is never removed.', path: 'feature.ts', line: 2 },
    { id: 'naming', severity: 'NIT', title: 'Unclear name', explanation: 'Rename the value.' }
  ]
}) + '\n```';

function revisionAnswer(prose: string, entries: unknown[]): string {
  return `${prose}\n\n\`\`\`task-monki-revisions\n${JSON.stringify(entries)}\n\`\`\``;
}

async function reviewedTask(name: string): Promise<{
  s: TaskMonkiScenario;
  task: Task;
  implementation: RunRecord;
  review: RunRecord;
  worktreePath: string;
}> {
  const s = await scenarios.create({ name });
  const task = await s.createTask({ title: 'Reviewer questions', prompt: 'Add the feature module.' });
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

describe('TaskManagerService review finding decisions and reviewer questions', () => {
  it('lets the person dismiss and restore findings of the current review only', async () => {
    const { s, task, implementation, review, worktreePath } = await reviewedTask('task-monki-review-decisions');
    expect(await boardReview(s, task.id)).toMatchObject({
      asksForChanges: true,
      findingCounts: { MAJOR: 1, NIT: 1 }
    });

    const dismissed = await s.service.decideReviewFinding({
      taskId: task.id, reviewRunId: review.id, findingId: 'leak', kind: 'DISMISS', note: '  Handled by the caller.  '
    });
    expect(dismissed).toMatchObject({ actor: 'USER', kind: 'DISMISS', findingId: 'leak', note: 'Handled by the caller.' });
    await s.service.decideReviewFinding({ taskId: task.id, reviewRunId: review.id, findingId: 'naming', kind: 'DISMISS' });
    // Dismissing the last open finding means the review no longer asks for changes.
    expect(await boardReview(s, task.id)).toMatchObject({ status: 'NEEDS_CHANGES', asksForChanges: false, findingCounts: {} });

    await expect(s.service.decideReviewFinding({
      taskId: task.id, reviewRunId: review.id, findingId: 'leak', kind: 'DISMISS'
    })).rejects.toThrow('already dismissed');
    await expect(s.service.decideReviewFinding({
      taskId: task.id, reviewRunId: review.id, findingId: 'naming', kind: 'RESTORE', note: 'Not allowed.'
    })).rejects.toThrow('Only a dismissal takes a note.');
    await expect(s.service.decideReviewFinding({
      taskId: task.id, reviewRunId: review.id, findingId: 'missing', kind: 'DISMISS'
    })).rejects.toThrow('not part of the review');
    await expect(s.service.decideReviewFinding({
      taskId: task.id, reviewRunId: randomUUID(), findingId: 'leak', kind: 'RESTORE'
    })).rejects.toThrow('no longer the task’s current review');
    await expect(s.service.decideReviewFinding({
      taskId: task.id, reviewRunId: review.id, findingId: 'naming', kind: 'DISMISS', note: 'x'.repeat(501)
    })).rejects.toThrow('at most 500 characters');

    await s.service.decideReviewFinding({ taskId: task.id, reviewRunId: review.id, findingId: 'naming', kind: 'RESTORE' });
    expect(await boardReview(s, task.id)).toMatchObject({ asksForChanges: true, findingCounts: { NIT: 1 } });
    const recorded = reviewOf(await s.store.snapshot(), task.id)?.findingDecisions ?? [];
    expect(recorded.map((decision) => `${decision.kind}:${decision.findingId}`)).toEqual([
      'DISMISS:leak', 'DISMISS:naming', 'RESTORE:naming'
    ]);

    await fs.writeFile(path.join(worktreePath, 'feature.ts'), 'export const value = 2;\n');
    await s.service.refreshEvidence({ taskId: task.id });
    expect(reviewOf(await s.store.snapshot(), task.id)?.status).toBe('STALE');
    await expect(s.service.decideReviewFinding({
      taskId: task.id, reviewRunId: review.id, findingId: 'naming', kind: 'DISMISS'
    })).rejects.toThrow('The code changed after this review.');
    await expect(s.service.askReviewer({
      taskId: task.id, reviewRunId: review.id, messageId: randomUUID(), text: 'Still relevant?'
    })).rejects.toThrow('The code changed after this review.');

    // The next review starts with no decisions and sees how the earlier findings were left.
    const rerun = await s.service.startReview({ taskId: task.id, runId: implementation.id });
    expect(reviewOf(await s.store.snapshot(), task.id)).toMatchObject({ runId: rerun.id, findingDecisions: [] });
    const rerunPrompt = await s.runtimeStore.readArtifact(rerun.promptArtifactId);
    expect(rerunPrompt).toContain('[MAJOR] Listener leaks at feature.ts:2 (dismissed by the person: Handled by the caller.)');
    expect(rerunPrompt).toContain('[NIT] Unclear name (open)');
    expect(rerunPrompt).toContain('Do not raise a dismissed or withdrawn finding again unless the code changed');
  }, 20_000);

  it('answers questions on the review lane and applies only a valid revision block', async () => {
    const { s, task, implementation, review } = await reviewedTask('task-monki-reviewer-questions');
    const reviewTurns = s.agent.startedRuntimeTurns.length;
    const messageId = randomUUID();
    s.agent.nextRuntimeTurnResult = {
      output: revisionAnswer('The listener is removed when the view closes.', [
        { finding: 'leak', action: 'withdraw', reason: 'The view removes the listener on close.' }
      ])
    };
    const question = await s.service.askReviewer({
      taskId: task.id, reviewRunId: review.id, messageId, text: 'Is the listener really leaked?', findingId: 'leak'
    });
    expect(question).toMatchObject({
      id: messageId, role: 'REVIEW', reviewRunId: review.id, findingId: 'leak', status: 'SUBMITTED'
    });
    // Repeating the message returns the recorded question instead of asking again.
    await expect(s.service.askReviewer({
      taskId: task.id, reviewRunId: review.id, messageId, text: 'Is the listener really leaked?', findingId: 'leak'
    })).resolves.toMatchObject({ id: messageId, runId: question.runId });
    await expect(s.service.askReviewer({
      taskId: task.id, reviewRunId: review.id, messageId, text: 'A different question.'
    })).rejects.toThrow('already been used for different content');
    expect(s.agent.startedRuntimeTurns).toHaveLength(reviewTurns + 1);

    const answered = await s.waitForSnapshot((state) =>
      state.events.some((event) => event.type === 'AGENT_RUN_COMPLETED' && event.runId === question.runId));
    const questionRun = answered.runs.find((run) => run.id === question.runId)!;
    const reviewRun = answered.runs.find((run) => run.id === review.id)!;
    const turn = s.agent.startedRuntimeTurns.at(-1)!;
    expect(turn.run.purpose).toBe('TASK_REVIEW_QUESTION');
    expect(turn.session.role).toBe('REVIEW');
    expect(turn.executionContext.repositoryAccess).toBe('READ_ONLY');
    expect(questionRun).toMatchObject({ mode: 'REVIEW_QUESTION', runtimeId: reviewRun.runtimeId, continuedFromRunId: review.id });
    expect(questionRun.sessionId).not.toBe(reviewRun.sessionId);
    expect(questionRun.requestedSettings).toMatchObject({ sandbox: 'READ_ONLY', model: reviewRun.requestedSettings.model });
    expect(reviewOf(answered, task.id)?.findingDecisions).toEqual([
      expect.objectContaining({
        actor: 'REVIEWER', kind: 'WITHDRAW', findingId: 'leak', questionRunId: question.runId,
        reason: 'The view removes the listener on close.'
      })
    ]);
    const prompt = await s.runtimeStore.readArtifact(questionRun.promptArtifactId);
    expect(prompt).toContain('You are working read-only.');
    expect(prompt).toContain('id leak: [MAJOR] Listener leaks at feature.ts:2');
    expect(prompt).toContain('--- feature.ts');
    expect(prompt).toContain('- feature.ts (+2 -0)');
    expect(prompt).toContain('task-monki-revisions');
    // The question never moves the task or touches the implementation run or review status.
    const answeredTask = answered.tasks.find((candidate) => candidate.id === task.id)!;
    expect(answeredTask).toMatchObject({ workflowPhase: 'REVIEW', currentRunId: implementation.id });
    expect(answeredTask.projection.agentReview).toMatchObject({ status: 'NEEDS_CHANGES', runId: review.id });
    expect(answered.events.find((event) => event.type === 'AGENT_RUN_COMPLETED' && event.runId === question.runId)?.payload)
      .toMatchObject({ mode: 'REVIEW_QUESTION', reviewerRevisions: { status: 'APPLIED' } });

    // An answer still running holds further questions and implementation work until it ends or is stopped.
    const pending = await s.service.askReviewer({
      taskId: task.id, reviewRunId: review.id, messageId: randomUUID(), text: 'What about the naming?'
    });
    await expect(s.service.askReviewer({
      taskId: task.id, reviewRunId: review.id, messageId: randomUUID(), text: 'And another thing?'
    })).rejects.toThrow('Wait for the reviewer to answer the current question.');
    await expect(s.service.continueRun({
      taskId: task.id, runId: implementation.id, instruction: 'Fix the review findings.'
    })).rejects.toThrow('Wait for the reviewer to answer, or stop the question, before starting follow-up work.');
    await s.service.stopReviewerQuestion({ taskId: task.id, runId: pending.runId! });
    await s.waitForSnapshot((state) => state.runs.find((run) => run.id === pending.runId)?.status === 'INTERRUPTED');

    s.agent.nextRuntimeTurnResult = {
      output: revisionAnswer('Restore it as a blocker.', [
        { finding: 'leak', action: 'severity', severity: 'BLOCKER', reason: 'Withdrawn findings cannot change.' }
      ])
    };
    const rejected = await s.service.askReviewer({
      taskId: task.id, reviewRunId: review.id, messageId: randomUUID(), text: 'Should the leak be a blocker?'
    });
    const settled = await s.waitForSnapshot((state) =>
      state.events.some((event) => event.type === 'AGENT_RUN_COMPLETED' && event.runId === rejected.runId));
    expect(settled.events.find((event) => event.type === 'AGENT_RUN_COMPLETED' && event.runId === rejected.runId)?.payload)
      .toMatchObject({ reviewerRevisions: { status: 'REJECTED', reason: expect.stringContaining('withdrawn finding leak') } });
    expect(reviewOf(settled, task.id)?.findingDecisions).toHaveLength(1);
    const rejectedRun = settled.runs.find((run) => run.id === rejected.runId)!;
    expect(rejectedRun.status).toBe('COMPLETED');
    expect(await s.runtimeStore.readArtifact(rejectedRun.diagnosticArtifactId)).toContain('withdrawn finding leak');
    const followUpPrompt = await s.runtimeStore.readArtifact(rejectedRun.promptArtifactId);
    expect(followUpPrompt).toContain('Your answer 1: The listener is removed when the view closes.');
    expect(followUpPrompt).not.toContain('"action":"withdraw"');

    // Questions stay between the person and the reviewer; implementation and review prompts never see them.
    expect(await readTaskUserContext(s.store, task.id)).not.toContain('Is the listener really leaked?');

    // Decisions, questions and question runs reload through the store's validation.
    await s.service.shutdown();
    await s.persistence.close();
    const reopened = await openTestPersistence(path.join(s.rootDir, 'profile'));
    await reopened.agentRuntime.init();
    const restored = await reopened.tasks.snapshot();
    expect(reviewOf(restored, task.id)?.findingDecisions).toEqual(reviewOf(settled, task.id)?.findingDecisions);
    expect(restored.taskInstructions.filter((item) => item.role === 'REVIEW').map((item) => item.reviewRunId))
      .toEqual([review.id, review.id, review.id]);
    expect(restored.runs.filter((run) => run.mode === 'REVIEW_QUESTION')).toHaveLength(3);
    expect(restored.events.filter((event) => event.type === 'AGENT_REVIEW_FINDING_DECIDED')).toHaveLength(1);
    await reopened.close();
  }, 30_000);

  it('refuses a question while the review is still running', async () => {
    const s = await scenarios.create({ name: 'task-monki-reviewer-question-running-review' });
    const task = await s.createTask({ title: 'Running review', prompt: 'Review in progress.' });
    await prepareTestWorktree(s.service, task.id);
    const implementation = await s.service.startRun({ taskId: task.id });
    await s.completeRun(implementation.id, 'Implemented.');
    const review = await s.service.startReview({ taskId: task.id, runId: implementation.id });
    await expect(s.service.askReviewer({
      taskId: task.id, reviewRunId: review.id, messageId: randomUUID(), text: 'Anything yet?'
    })).rejects.toThrow('Wait for the review to finish.');
    await expect(s.service.decideReviewFinding({
      taskId: task.id, reviewRunId: review.id, findingId: 'leak', kind: 'DISMISS'
    })).rejects.toThrow('Wait for the review to finish.');
  }, 20_000);
});
