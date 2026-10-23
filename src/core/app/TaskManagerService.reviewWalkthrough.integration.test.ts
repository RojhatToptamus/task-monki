import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REVIEW_WALKTHROUGH_MAX_BYTES,
  parseReviewWalkthrough,
  type ReviewWalkthroughState,
  type TaskSnapshot
} from '../../shared/contracts';
import { openTestPersistence } from '../../testSupport/persistenceFixture';
import { prepareTestWorktree } from '../../testSupport/prepareWorktree';
import { TaskMonkiScenarioRegistry, type TaskMonkiScenario } from '../../testSupport/taskMonkiScenario';

const scenarios = new TaskMonkiScenarioRegistry();

afterEach(async () => {
  await scenarios.dispose();
});

const FINDING = {
  id: 'unbounded-retry', severity: 'NIT', title: 'Retries never stop', explanation: 'The loop has no limit.', path: 'retry.ts', line: 2, recommendation: 'Bound it.'
};

const review = (walkthrough?: object) => 'Review.\n```json\n' + JSON.stringify({
  schemaVersion: 'agent-review/v1', verdict: 'PASSED', summary: 'Fine.', findings: [FINDING], ...(walkthrough ? { walkthrough } : {})
}) + '\n```';

const WALKTHROUGH = {
  summary: 'Calls retry with backoff. The retry module holds the loop.',
  attention: [{ text: 'A new retry module', section: 1, path: 'retry.ts' }, { text: 'Retries never stop', section: 1, finding: FINDING.id }],
  sections: [{
    title: 'Retry failed calls',
    explanation: 'Failed calls now retry with backoff.',
    files: ['retry.ts'],
    excerpts: [{ path: 'retry.ts', side: 'head', line: 1, endLine: 3, caption: 'The retry loop' }],
    terms: [{ text: 'backoff', path: 'retry.ts', line: 2 }]
  }]
};

function reviewOf(state: TaskSnapshot, taskId: string) {
  return state.tasks.find((candidate) => candidate.id === taskId)!.projection.agentReview;
}

/** A task whose implementation added `retry.ts` and `notes.md`, ready for review. */
async function implemented(s: TaskMonkiScenario) {
  const task = await s.createTask({ title: 'Retries', prompt: 'Retry failed calls.' });
  const worktree = await prepareTestWorktree(s.service, task.id);
  const implementation = await s.service.startRun({ taskId: task.id });
  await fs.writeFile(path.join(worktree.worktreePath, 'retry.ts'), 'export function retry() {\n  return backoff();\n}\n');
  await fs.writeFile(path.join(worktree.worktreePath, 'notes.md'), 'Retries.\n');
  await s.completeRun(implementation.id, 'Added retries.');
  return { task, worktree, implementation };
}

describe('TaskManagerService review walkthrough', () => {
  it('keeps the walkthrough a review writes, checked against the code it read, as earlier context across a rerun and a restart', async () => {
    const s = await scenarios.create({ name: 'task-monki-review-walkthrough' });
    const { task, worktree, implementation } = await implemented(s);
    let treeBeforeAnswer: string | undefined;
    s.agent.beforeNextRuntimeTurnTerminal = async () => {
      treeBeforeAnswer = reviewOf(await s.store.snapshot(), task.id)?.reviewedTreeSha;
    };
    s.agent.nextRuntimeTurnResult = { output: review(WALKTHROUGH) };
    const first = await s.service.startReview({ taskId: task.id, runId: implementation.id });
    const prompt = await s.runtimeStore.readArtifact(first.promptArtifactId);
    expect(prompt).toContain('notes.md new +1 -0 head 1');
    expect(prompt).toContain('retry.ts new +3 -0 head 1-3');

    const reviewed = reviewOf(await s.waitForSnapshot((state) => reviewOf(state, task.id)?.status === 'PASSED'), task.id)!;
    // The code the review read was recorded before the provider answered.
    expect(treeBeforeAnswer).toEqual(expect.any(String));
    expect(reviewed.reviewedTreeSha).toBe(treeBeforeAnswer);
    expect(reviewed.walkthrough).toEqual({
      status: 'STORED', reviewRunId: first.id, artifactId: expect.any(String)
    });
    const stored = reviewed.walkthrough as Extract<ReviewWalkthroughState, { status: 'STORED' }>;
    const walkthrough = parseReviewWalkthrough(await s.service.readArtifact({ artifactId: stored.artifactId }), first.id);
    expect(walkthrough).toMatchObject({
      base: worktree.baseSha,
      tree: reviewed.reviewedTreeSha,
      summary: WALKTHROUGH.summary,
      // What a pointer names holds: a file of its section, and a finding the review wrote with it.
      attention: [{ text: 'A new retry module', section: 0, path: 'retry.ts' }, { text: 'Retries never stop', section: 0, finding: FINDING.id }],
      sections: [
        {
          title: 'Retry failed calls',
          files: ['retry.ts'],
          excerpts: [{ path: 'retry.ts', side: 'NEW', line: 1, endLine: 3, caption: 'The retry loop' }],
          terms: [{ text: 'backoff', path: 'retry.ts', side: 'NEW', line: 2 }]
        },
        { title: 'Other changes', explanation: '', files: ['notes.md'] }
      ]
    });
    // Projected again, as after a restart, the outcome gets the same artifact back.
    expect(await s.store.recordReviewWalkthrough(first.id, '{}')).toMatchObject({ id: stored.artifactId });

    // A second review keeps the first walkthrough, and the code it describes, while it runs and once it fails.
    await fs.writeFile(path.join(worktree.worktreePath, 'retry.ts'), 'export const retry = () => backoff();\n');
    await s.service.refreshEvidence({ taskId: task.id });
    let running: ReturnType<typeof reviewOf>;
    s.agent.beforeNextRuntimeTurnTerminal = async () => {
      running = reviewOf(await s.store.snapshot(), task.id);
    };
    s.agent.nextRuntimeTurnResult = { output: '', status: 'failed', error: 'The provider stopped.' };
    const second = await s.service.startReview({ taskId: task.id, runId: implementation.id });
    const failed = reviewOf(await s.waitForSnapshot((state) => reviewOf(state, task.id)?.status === 'FAILED'), task.id)!;
    expect(running).toMatchObject({ status: 'RUNNING', runId: second.id, walkthrough: stored });
    expect(failed).toMatchObject({ runId: second.id, walkthrough: stored });
    // Too large to keep whole, a walkthrough is refused before anything is written.
    expect(await s.store.recordReviewWalkthrough(second.id, 'x'.repeat(REVIEW_WALKTHROUGH_MAX_BYTES))).toBeUndefined();
    const diff = await s.service.readReviewedDiff({ taskId: task.id, reviewRunId: first.id });
    expect(diff).toMatchObject({ status: 'READY', reviewRunId: first.id, tree: reviewed.reviewedTreeSha });
    expect(diff.status === 'READY' ? diff.diff : '').toContain('+  return backoff();');

    // Both reload through the store's validation.
    await s.service.shutdown();
    await s.persistence.close();
    const reopened = await openTestPersistence(path.join(s.rootDir, 'profile'));
    await reopened.agentRuntime.init();
    const restored = await reopened.tasks.snapshot();
    expect(reviewOf(restored, task.id)?.walkthrough).toEqual(stored);
    expect(restored.artifacts.filter((artifact) => artifact.kind === 'review-walkthrough')).toEqual([
      expect.objectContaining({ id: stored.artifactId, taskId: task.id, runId: first.id })
    ]);
    expect(parseReviewWalkthrough(await reopened.tasks.readArtifact(stored.artifactId), first.id)).toEqual(walkthrough);
    await reopened.close();
  }, 30_000);

  it('records why a review has no walkthrough when it wrote none, none of it holds, or it cannot be kept', async () => {
    const s = await scenarios.create({ name: 'task-monki-review-walkthrough-unavailable' });
    const { task, implementation } = await implemented(s);
    s.agent.nextRuntimeTurnResult = {
      output: review({ summary: 'Elsewhere.', sections: [{ title: 'Change other code', explanation: 'Nothing here.', files: ['missing.ts'] }] })
    };
    const first = await s.service.startReview({ taskId: task.id, runId: implementation.id });
    const invalid = reviewOf(await s.waitForSnapshot((state) => reviewOf(state, task.id)?.status === 'PASSED'), task.id)!;
    expect(invalid).toMatchObject({ runId: first.id, walkthrough: { status: 'UNAVAILABLE', reason: 'NO_SECTIONS' } });

    s.agent.nextRuntimeTurnResult = { output: review() };
    const second = await s.service.startReview({ taskId: task.id, runId: implementation.id });
    const none = reviewOf(await s.waitForSnapshot((state) =>
      reviewOf(state, task.id)?.runId === second.id && reviewOf(state, task.id)?.status === 'PASSED'), task.id)!;
    expect(none.walkthrough).toEqual({ status: 'UNAVAILABLE', reason: 'NOT_WRITTEN' });
    expect((await s.store.snapshot()).artifacts.some((artifact) => artifact.kind === 'review-walkthrough')).toBe(false);

    // A walkthrough that cannot be kept never holds back the review's verdict.
    const keep = vi.spyOn(s.store, 'recordReviewWalkthrough').mockRejectedValueOnce(new Error('The disk is full.'));
    s.agent.nextRuntimeTurnResult = { output: review(WALKTHROUGH) };
    const third = await s.service.startReview({ taskId: task.id, runId: implementation.id });
    const unkept = reviewOf(await s.waitForSnapshot((state) =>
      reviewOf(state, task.id)?.runId === third.id && reviewOf(state, task.id)?.status === 'PASSED'), task.id)!;
    expect(keep).toHaveBeenCalledOnce();
    expect(unkept.walkthrough).toEqual({ status: 'UNAVAILABLE', reason: 'UNREADABLE' });
  }, 30_000);
});
