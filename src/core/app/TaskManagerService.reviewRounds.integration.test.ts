import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acceptedRequestItems, type ReviewRequestRecord, type TaskSnapshot } from '../../shared/contracts';
import { openTestPersistence } from '../../testSupport/persistenceFixture';
import { prepareTestWorktree } from '../../testSupport/prepareWorktree';
import { TaskMonkiScenarioRegistry } from '../../testSupport/taskMonkiScenario';

const scenarios = new TaskMonkiScenarioRegistry();

afterEach(async () => {
  await scenarios.dispose();
});

const review = (body: object) => 'Review.\n```json\n' + JSON.stringify({ schemaVersion: 'agent-review/v1', ...body }) + '\n```';

function reviewOf(state: TaskSnapshot, taskId: string) {
  return state.tasks.find((candidate) => candidate.id === taskId)!.projection.agentReview;
}

describe('TaskManagerService review rounds', () => {
  it('keeps the exact code each review read and shows what changed since it', async () => {
    const s = await scenarios.create({ name: 'task-monki-review-snapshot' });
    const task = await s.createTask({ title: 'Review snapshots', prompt: 'Add the feature module.' });
    const worktree = await prepareTestWorktree(s.service, task.id);
    const implementation = await s.service.startRun({ taskId: task.id });
    await fs.writeFile(path.join(worktree.worktreePath, 'feature.ts'), 'export const value = 1;\n');
    await s.completeRun(implementation.id, 'Implemented the feature module.');
    s.agent.nextRuntimeTurnResult = { output: review({ verdict: 'PASSED', summary: 'Fine.', findings: [] }) };
    const first = await s.service.startReview({ taskId: task.id, runId: implementation.id });
    const reviewed = await s.waitForSnapshot((state) => reviewOf(state, task.id)?.status === 'PASSED' && Boolean(reviewOf(state, task.id)?.reviewedTreeSha));
    const tree = reviewOf(reviewed, task.id)!.reviewedTreeSha!;

    expect(await s.service.readReviewChanges({ taskId: task.id, reviewRunId: first.id })).toEqual({ status: 'READY', reviewRunId: first.id, tree, diff: '' });
    await fs.writeFile(path.join(worktree.worktreePath, 'feature.ts'), 'export const value = 2;\n');
    const changes = await s.service.readReviewChanges({ taskId: task.id, reviewRunId: first.id });
    expect(changes).toMatchObject({ status: 'READY', tree });
    expect(changes.status === 'READY' ? changes.diff : '').toContain('-export const value = 1;\n+export const value = 2;');
    await expect(s.service.readReviewChanges({ taskId: task.id, reviewRunId: implementation.id })).rejects.toThrow('This review is not part of the task.');
  }, 30_000);


  it('carries a request item by item, records the agent\'s answers, and gives the next review both', async () => {
    const s = await scenarios.create({ name: 'task-monki-review-round' });
    const task = await s.createTask({ title: 'Review rounds', prompt: 'Add the feature module.' });
    const worktree = await prepareTestWorktree(s.service, task.id);
    const implementation = await s.service.startRun({ taskId: task.id });
    await fs.writeFile(path.join(worktree.worktreePath, 'feature.ts'), 'window.addEventListener("x", () => {});\n');
    await s.completeRun(implementation.id, 'Implemented the feature module.');
    s.agent.nextRuntimeTurnResult = {
      output: review({
        verdict: 'NEEDS_CHANGES',
        summary: 'One leak.',
        findings: [{ id: 'leak', severity: 'MAJOR', title: 'Listener leaks', explanation: 'It is never removed.', path: 'feature.ts', line: 1 }]
      })
    };
    const first = await s.service.startReview({ taskId: task.id, runId: implementation.id });
    await s.waitForSnapshot((state) => reviewOf(state, task.id)?.status === 'NEEDS_CHANGES' &&
      Boolean(state.runs.find((run) => run.id === first.id)?.afterGitSnapshotId));

    const request: ReviewRequestRecord = {
      reviewRunId: first.id,
      items: [
        { number: 1, kind: 'FINDING', findingId: 'leak', severity: 'MAJOR', title: 'Listener leaks', path: 'feature.ts', line: 1 },
        { number: 2, kind: 'COMMENT', path: 'feature.ts', side: 'NEW', line: 1, text: 'Should this be a named handler?' }
      ]
    };
    await expect(s.service.continueRun({
      taskId: task.id, runId: implementation.id, instruction: 'Address the review.', reviewRequest: { ...request, items: [] }
    })).rejects.toThrow('The review request is not valid.');
    const followUp = await s.service.continueRun({
      taskId: task.id, runId: implementation.id, clientMessageId: randomUUID(), instruction: 'Address the review.', reviewRequest: request
    });
    const sent = (await s.store.getTaskDetail(task.id)).taskInstructions.find((item) => item.runId === followUp.id);
    expect(sent?.reviewRequest).toEqual(request);

    await fs.writeFile(path.join(worktree.worktreePath, 'feature.ts'), 'const onX = () => {};\nwindow.addEventListener("x", onX);\n');
    await s.completeRun(followUp.id, [
      'Removed the listener on close.',
      '```task-monki-review-response',
      JSON.stringify([
        { item: 1, outcome: 'FIXED', note: 'Removed on close.' },
        { item: 2, outcome: 'NEEDS_DECISION', note: 'Name it onResize or onX?' }
      ]),
      '```'
    ].join('\n'));
    const answered = await s.waitForSnapshot((state) => Boolean(reviewOf(state, task.id)?.requestAnswer));
    expect(reviewOf(answered, task.id)).toMatchObject({
      status: 'STALE', requestAnswer: { awaitingDecision: true }
    });
    expect((await s.service.getBoardSnapshot()).tasks.find((candidate) => candidate.id === task.id)?.projection.agentReview)
      .toMatchObject({ requestAnswered: { awaitingDecision: true } });

    // The person's reply starts a turn, so the answer no longer waits on them.
    const reply = await s.service.continueRun({ taskId: task.id, runId: followUp.id, instruction: 'Call it onX.' });
    expect(reviewOf(await s.store.snapshot(), task.id)?.requestAnswer).toBeUndefined();
    await s.completeRun(reply.id, 'Named it onX.');

    s.agent.nextRuntimeTurnResult = {
      output: review({
        verdict: 'PASSED',
        summary: 'The leak is fixed.',
        findings: [],
        resolvedFindings: [{ previousFindingId: 'leak', title: 'Listener leaks', note: 'Removed on close.' }]
      })
    };
    const second = await s.service.startReview({ taskId: task.id, runId: reply.id });
    const prompt = await s.runtimeStore.readArtifact(second.promptArtifactId);
    expect(prompt).toContain('- id leak: [MAJOR] Listener leaks at feature.ts:1 (open).');
    expect(prompt).toContain('Summary: One leak.');
    expect(prompt).toContain('1. Finding leak, [MAJOR] Listener leaks at feature.ts:1. Agent: fixed. Removed on close.');
    expect(prompt).toContain('2. Comment on feature.ts:1: Should this be a named handler? Agent: needs the person\'s decision. Name it onResize or onX?');
    expect(prompt).toContain('Report a new finding, one without previousFindingId, only when it is BLOCKER or MAJOR.');
    const rereviewed = await s.waitForSnapshot((state) => reviewOf(state, task.id)?.status === 'PASSED');
    expect(reviewOf(rereviewed, task.id)?.result?.resolvedFindings).toEqual([
      { previousFindingId: 'leak', title: 'Listener leaks', note: 'Removed on close.' }
    ]);

    // The request, the answer and the resolved finding reload through the store's validation.
    await s.service.shutdown();
    await s.persistence.close();
    const reopened = await openTestPersistence(path.join(s.rootDir, 'profile'));
    const restored = await reopened.tasks.snapshot();
    expect(restored.taskInstructions.find((item) => item.runId === followUp.id)?.reviewRequest).toEqual(request);
    expect(reviewOf(restored, task.id)?.result?.resolvedFindings).toHaveLength(1);
    await reopened.close();
  }, 30_000);

  it('settles an answer only when the person accepts it, on the latest request after the review, and keeps that through a restart', async () => {
    const s = await scenarios.create({ name: 'task-monki-review-answer-decisions' });
    const task = await s.createTask({ title: 'Answer decisions', prompt: 'Add the feature module.' });
    const worktree = await prepareTestWorktree(s.service, task.id);
    const implementation = await s.service.startRun({ taskId: task.id });
    await fs.writeFile(path.join(worktree.worktreePath, 'feature.ts'), 'window.addEventListener("x", () => {});\n');
    await s.completeRun(implementation.id, 'Implemented the feature module.');
    s.agent.nextRuntimeTurnResult = {
      output: review({
        verdict: 'NEEDS_CHANGES',
        summary: 'One leak.',
        findings: [{ id: 'leak', severity: 'MAJOR', title: 'Listener leaks', explanation: 'It is never removed.', path: 'feature.ts', line: 1 }]
      })
    };
    const reviewed = await s.service.startReview({ taskId: task.id, runId: implementation.id });
    await s.waitForSnapshot((state) => reviewOf(state, task.id)?.status === 'NEEDS_CHANGES' &&
      Boolean(state.runs.find((run) => run.id === reviewed.id)?.afterGitSnapshotId));

    const send = async (from: string, comment: string) => {
      const run = await s.service.continueRun({
        taskId: task.id, runId: from, clientMessageId: randomUUID(), instruction: 'Address the review.',
        reviewRequest: { reviewRunId: reviewed.id, items: [
          { number: 1, kind: 'FINDING', findingId: 'leak', severity: 'MAJOR', title: 'Listener leaks', path: 'feature.ts', line: 1 },
          { number: 2, kind: 'COMMENT', path: 'feature.ts', side: 'NEW', line: 1, text: comment }
        ] }
      });
      return { run, message: (await s.store.getTaskDetail(task.id)).taskInstructions.find((item) => item.runId === run.id)! };
    };
    const answer = async (runId: string) => {
      await s.completeRun(runId, ['Done.', '```task-monki-review-response',
        JSON.stringify([{ item: 1, outcome: 'FIXED', note: 'Removed on close.' }, { item: 2, outcome: 'NOT_CHANGED', note: 'The name is fine.' }]), '```'].join('\n'));
      await s.waitForSnapshot((state) => Boolean(reviewOf(state, task.id)?.requestAnswer));
    };
    const decide = (instructionId: string, item: number, kind: 'ACCEPT' | 'REOPEN', reviewRunId = reviewed.id) =>
      s.service.decideReviewRequestItem({ taskId: task.id, reviewRunId, instructionId, item, kind });

    const first = await send(implementation.id, 'Name the handler?');
    await expect(decide(first.message.id, 1, 'ACCEPT')).rejects.toThrow('Wait for the agent to answer the request.');
    await fs.writeFile(path.join(worktree.worktreePath, 'feature.ts'), 'const onX = () => {};\nwindow.addEventListener("x", onX);\n');
    await answer(first.run.id);

    // The agent changed the code, so the review is out of date; the person still settles its answers, and only they do.
    expect(reviewOf(await s.store.snapshot(), task.id)?.status).toBe('STALE');
    await decide(first.message.id, 1, 'ACCEPT');
    await expect(decide(first.message.id, 1, 'ACCEPT')).rejects.toThrow('This answer is already accepted.');
    await expect(decide(first.message.id, 2, 'REOPEN')).rejects.toThrow('Only an accepted answer can be reopened.');
    await expect(decide(first.message.id, 3, 'ACCEPT')).rejects.toThrow('This item is not part of the request.');
    await expect(decide(first.message.id, 1, 'ACCEPT', randomUUID())).rejects.toThrow('no longer the task’s current review');
    await decide(first.message.id, 1, 'REOPEN');
    await decide(first.message.id, 2, 'ACCEPT');
    expect(acceptedRequestItems(reviewOf(await s.store.snapshot(), task.id)?.requestItemDecisions ?? [], first.message.id)).toEqual(new Set([2]));

    // A later request after the same review takes the decisions from then on.
    const second = await send(first.run.id, 'Name it onX.');
    await answer(second.run.id);
    await expect(decide(first.message.id, 1, 'ACCEPT')).rejects.toThrow('Only the latest request after the review takes decisions.');
    await decide(second.message.id, 1, 'ACCEPT');

    // The decisions reload through the store's validation.
    await s.service.shutdown();
    await s.persistence.close();
    const reopened = await openTestPersistence(path.join(s.rootDir, 'profile'));
    const restored = reviewOf(await reopened.tasks.snapshot(), task.id)?.requestItemDecisions ?? [];
    expect(restored.map((decision) => [decision.instructionId === first.message.id ? 'first' : 'second', decision.item, decision.kind])).toEqual([
      ['first', 1, 'ACCEPT'], ['first', 1, 'REOPEN'], ['first', 2, 'ACCEPT'], ['second', 1, 'ACCEPT']
    ]);
    expect(acceptedRequestItems(restored, second.message.id)).toEqual(new Set([1]));
    await reopened.close();
  }, 30_000);
});
