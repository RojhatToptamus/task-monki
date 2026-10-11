import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentItemRecord, TaskSnapshot } from '../../shared/contracts';
import { listGitWorktrees } from '../worktree/WorktreeService';
import { readTaskUserContext } from '../prompt/TaskUserContext';
import { openTestPersistence } from '../../testSupport/persistenceFixture';
import { prepareTestWorktree } from '../../testSupport/prepareWorktree';
import { TaskMonkiScenarioRegistry, type TaskMonkiScenario } from '../../testSupport/taskMonkiScenario';

const scenarios = new TaskMonkiScenarioRegistry();

afterEach(async () => {
  await scenarios.dispose();
});

const REVIEW_OUTPUT = 'One finding.\n```json\n' + JSON.stringify({
  schemaVersion: 'agent-review/v1',
  verdict: 'NEEDS_CHANGES',
  summary: 'One finding.',
  findings: [{ id: 'leak', severity: 'MAJOR', title: 'Listener leaks', explanation: 'It is never removed.' }]
}) + '\n```';

function runOf(state: TaskSnapshot, runId: string | undefined) {
  return state.runs.find((run) => run.id === runId);
}

async function snapshotRegistrations(s: TaskMonkiScenario): Promise<string[]> {
  const root = `${await fs.realpath(s.worktreeRoot)}${path.sep}snapshots${path.sep}`;
  return (await listGitWorktrees(s.repositoryPath)).map((entry) => entry.path).filter((entry) => entry.startsWith(root));
}

describe('TaskManagerService side questions', () => {
  it('answers from a read-only snapshot while the implementation agent runs, without holding its work', async () => {
    const s = await scenarios.create({ name: 'task-monki-side-question-snapshot' });
    const task = await s.createTask({ title: 'Side questions', prompt: 'Add the feature module.' });
    const worktree = await prepareTestWorktree(s.service, task.id);
    const implementation = await s.service.startRun({ taskId: task.id });
    await fs.writeFile(path.join(worktree.worktreePath, 'feature.ts'), 'export const value = 1;\n');
    const threadId = randomUUID();
    const messageId = randomUUID();

    const question = await s.service.askSideQuestion({
      taskId: task.id, threadId, messageId, text: 'Which file holds the feature?'
    });

    expect(question).toMatchObject({ id: messageId, role: 'SIDE', threadId, status: 'SUBMITTED' });
    expect(question.snapshotTakenAt).toEqual(expect.any(String));
    const turn = s.agent.startedRuntimeTurns.at(-1)!;
    const snapshotPath = turn.executionContext.primaryCwd;
    expect(turn.run.purpose).toBe('TASK_SIDE_QUESTION');
    expect(turn.session.role).toBe('SIDE');
    expect(turn.executionContext).toMatchObject({
      repositoryAccess: 'READ_ONLY',
      readRoots: [{ canonicalPath: snapshotPath, kind: 'WORKTREE_SNAPSHOT', entityId: worktree.id }],
      modelSettings: { sandbox: 'READ_ONLY', approvalPolicy: 'NEVER' }
    });
    // The runtime receives canonical paths; the temporary folder can be a symlink.
    expect(snapshotPath.startsWith(path.join(await fs.realpath(s.worktreeRoot), 'snapshots'))).toBe(true);
    expect(await fs.readFile(path.join(snapshotPath, 'feature.ts'), 'utf8')).toBe('export const value = 1;\n');
    const prompt = await s.runtimeStore.readArtifact(turn.run.promptArtifactId);
    expect(prompt).toContain('You are working read-only.');
    expect(prompt).toContain('You are answering a side question about a task another agent is working on.');
    expect(prompt).toContain('The implementation agent is running now');
    expect(prompt).toContain(`The checkout is a read-only snapshot of the task worktree taken at ${question.snapshotTakenAt}`);
    expect(prompt).toContain('Which file holds the feature?');

    let state = await s.store.snapshot();
    const sideRun = runOf(state, question.runId)!;
    expect(sideRun).toMatchObject({ mode: 'SIDE_QUESTION', runtimeId: task.runtimeId, status: 'RUNNING' });
    expect(sideRun.sessionId).not.toBe(implementation.sessionId);
    expect(state.tasks.find((candidate) => candidate.id === task.id)).toMatchObject({
      currentRunId: implementation.id,
      currentAgentSessionId: implementation.sessionId,
      workflowPhase: 'IN_PROGRESS'
    });

    // One question at a time per task; repeating a message returns the recorded question.
    await expect(s.service.askSideQuestion({
      taskId: task.id, threadId, messageId: randomUUID(), text: 'Another one?'
    })).rejects.toThrow('Wait for the current side question to finish, or stop it.');
    await expect(s.service.askSideQuestion({
      taskId: task.id, threadId, messageId, text: 'Which file holds the feature?'
    })).resolves.toMatchObject({ id: messageId, runId: question.runId });
    await expect(s.service.askSideQuestion({
      taskId: task.id, threadId, messageId, text: 'Different text.'
    })).rejects.toThrow('already been used for different content');
    expect(s.agent.startedRuntimeTurns.filter((item) => item.run.purpose === 'TASK_SIDE_QUESTION')).toHaveLength(1);

    // A snapshot reader leaves the live worktree to the implementation agent's follow-up work.
    await s.completeRun(implementation.id, 'Implemented the feature module.');
    const followUp = await s.service.continueRun({
      taskId: task.id, runId: implementation.id, instruction: 'Also export a helper.'
    });
    expect(followUp.mode).toBe('FOLLOW_UP');

    await s.service.stopSideQuestion({ taskId: task.id, runId: question.runId! });
    await s.waitForSnapshot((next) => runOf(next, question.runId)?.status === 'INTERRUPTED');

    // The next question of the thread reuses the unchanged snapshot.
    s.agent.nextRuntimeTurnResult = { output: 'feature.ts exports the value.' };
    const second = await s.service.askSideQuestion({
      taskId: task.id, threadId, messageId: randomUUID(), text: 'What does it export?'
    });
    expect(second.snapshotTakenAt).toBe(question.snapshotTakenAt);
    expect(s.agent.startedRuntimeTurns.at(-1)!.executionContext.primaryCwd).toBe(snapshotPath);
    state = await s.waitForSnapshot((next) => runOf(next, second.runId)?.status === 'COMPLETED');
    expect(state.tasks.find((candidate) => candidate.id === task.id)).toMatchObject({ currentRunId: followUp.id });
    expect(await snapshotRegistrations(s)).toEqual([await fs.realpath(snapshotPath)]);

    // Closing the panel removes the snapshot; its runs stay.
    await s.service.endSideThread({ taskId: task.id, threadId });
    await s.service.endSideThread({ taskId: task.id, threadId });
    await expect(fs.access(snapshotPath)).rejects.toThrow();
    expect(await snapshotRegistrations(s)).toEqual([]);
    expect(runOf(await s.store.snapshot(), second.runId)?.mode).toBe('SIDE_QUESTION');

    // Sessions that read a removed snapshot still reload.
    await s.completeRun(followUp.id);
    await s.service.shutdown();
    await s.persistence.close();
    const reopened = await openTestPersistence(path.join(s.rootDir, 'profile'));
    await reopened.agentRuntime.init();
    const restored = await reopened.tasks.snapshot();
    expect(restored.agentSessions.filter((session) => session.role === 'SIDE')).toHaveLength(2);
    expect(restored.taskInstructions.filter((item) => item.role === 'SIDE').every((item) => item.snapshotTakenAt))
      .toBe(true);
    await reopened.close();
  }, 30_000);

  it('reads the live worktree when idle, holds other work meanwhile, and leaves the review current', async () => {
    const s = await scenarios.create({ name: 'task-monki-side-question-live' });
    const task = await s.createTask({ title: 'Live side questions', prompt: 'Add the feature module.' });
    const worktree = await prepareTestWorktree(s.service, task.id);
    const implementation = await s.service.startRun({ taskId: task.id });
    await fs.writeFile(path.join(worktree.worktreePath, 'feature.ts'), 'window.addEventListener("x", () => {});\n');
    await s.completeRun(implementation.id, 'Implemented the feature module.');
    s.agent.nextRuntimeTurnResult = { output: REVIEW_OUTPUT };
    const review = await s.service.startReview({ taskId: task.id, runId: implementation.id });
    const reviewed = await s.waitForSnapshot((state) =>
      state.tasks.find((candidate) => candidate.id === task.id)?.projection.agentReview?.status === 'NEEDS_CHANGES' &&
      Boolean(runOf(state, review.id)?.afterGitSnapshotId));
    const reviewedTask = reviewed.tasks.find((candidate) => candidate.id === task.id)!;

    const threadId = randomUUID();
    let streamed: AgentItemRecord | undefined;
    s.agent.nextRuntimeTurnResult = { output: 'The listener is removed when the view closes.' };
    s.agent.beforeNextRuntimeTurnTerminal = async () => {
      const runId = s.agent.startedRuntimeTurns.at(-1)!.run.id;
      for (const text of ['The listener ', 'is removed']) {
        s.agent.emitRuntimeTurnEvent({
          type: 'DELTA', runId, providerTurnId: 'scenario-delta', text, observedAt: new Date().toISOString()
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
      streamed = (await s.store.getTaskDetail(task.id)).agentItems.find((item) => item.runId === runId);
    };
    const question = await s.service.askSideQuestion({
      taskId: task.id, threadId, messageId: randomUUID(), text: 'Is the listener really leaked?'
    });
    expect(question.snapshotTakenAt).toBeUndefined();
    const turn = s.agent.startedRuntimeTurns.at(-1)!;
    const canonicalWorktree = await fs.realpath(worktree.worktreePath);
    expect(turn.executionContext.primaryCwd).toBe(canonicalWorktree);
    expect(turn.executionContext.readRoots).toEqual([
      { canonicalPath: canonicalWorktree, kind: 'WORKTREE', entityId: worktree.id }
    ]);

    const answered = await s.waitForSnapshot((state) =>
      state.events.some((event) => event.type === 'AGENT_RUN_COMPLETED' && event.runId === question.runId));
    // The answer streamed into one agent message item and settled with the run.
    expect(streamed).toMatchObject({ type: 'AGENT_MESSAGE', status: 'IN_PROGRESS', payload: { text: 'The listener is removed' } });
    expect(answered.agentItems.filter((item) => item.runId === question.runId)).toEqual([
      expect.objectContaining({
        type: 'AGENT_MESSAGE', status: 'COMPLETED', payload: { text: 'The listener is removed when the view closes.' }
      })
    ]);
    expect(answered.events.find((event) => event.type === 'AGENT_RUN_COMPLETED' && event.runId === question.runId)?.payload)
      .toMatchObject({ mode: 'SIDE_QUESTION' });
    // The question never moves the task, its implementation run, or its review.
    const answeredTask = answered.tasks.find((candidate) => candidate.id === task.id)!;
    expect(answeredTask).toMatchObject({ workflowPhase: 'REVIEW', currentRunId: implementation.id });
    expect(answeredTask.projection.agentRun).toBe(reviewedTask.projection.agentRun);
    expect(answeredTask.projection.agentReview).toEqual(reviewedTask.projection.agentReview);
    const prompt = await s.runtimeStore.readArtifact(runOf(answered, question.runId)!.promptArtifactId);
    expect(prompt).toContain('Agent: Implemented the feature module.');
    expect(prompt).toContain('The implementation agent is not running.');
    expect(prompt).toContain(`Checkout: ${worktree.worktreePath}`);
    expect(prompt).not.toContain('read-only snapshot');

    // A question that reads the live worktree holds other work until it ends or is stopped.
    const pending = await s.service.askSideQuestion({
      taskId: task.id, threadId, messageId: randomUUID(), text: 'And the naming?'
    });
    const followUpPrompt = await s.runtimeStore.readArtifact(s.agent.startedRuntimeTurns.at(-1)!.run.promptArtifactId);
    expect(followUpPrompt).toContain('Question 1: Is the listener really leaked?');
    expect(followUpPrompt).toContain('Your answer 1: The listener is removed when the view closes.');
    await expect(s.service.continueRun({
      taskId: task.id, runId: implementation.id, instruction: 'Fix the review findings.'
    })).rejects.toThrow('Wait for the side question to finish, or stop it, before starting follow-up work.');
    await s.service.stopSideQuestion({ taskId: task.id, runId: pending.runId! });
    await s.waitForSnapshot((state) => runOf(state, pending.runId)?.status === 'INTERRUPTED');

    // Side questions stay out of the agent's task context.
    expect(await readTaskUserContext(s.store, task.id)).not.toContain('Is the listener really leaked?');

    // Questions and their runs reload through the store's validation.
    await s.service.shutdown();
    await s.persistence.close();
    const reopened = await openTestPersistence(path.join(s.rootDir, 'profile'));
    await reopened.agentRuntime.init();
    const restored = await reopened.tasks.snapshot();
    expect(restored.taskInstructions.filter((item) => item.role === 'SIDE').map((item) => item.threadId))
      .toEqual([threadId, threadId]);
    expect(restored.runs.filter((run) => run.mode === 'SIDE_QUESTION')).toHaveLength(2);
    expect(restored.agentSessions.filter((session) => session.role === 'SIDE')).toHaveLength(2);
    await reopened.close();
  }, 30_000);

  it('admits a side question only on one of the profile\'s own read-only snapshots', async () => {
    const s = await scenarios.create({ name: 'task-monki-side-question-foreign-snapshot' });
    const task = await s.createTask({ title: 'Foreign snapshot', prompt: 'Work.' });
    const worktree = await prepareTestWorktree(s.service, task.id);
    const agents = (s.service as unknown as { agents: import('../agent/AgentOrchestrator').AgentOrchestrator }).agents;
    // A folder that is laid out like a snapshot but sits outside the profile's snapshot root.
    const foreign = path.join(s.rootDir, 'elsewhere', task.id, randomUUID());
    await fs.mkdir(foreign, { recursive: true });
    await expect(agents.startSideQuestion({
      runId: randomUUID(), sessionId: randomUUID(), task, iteration: (await s.store.getCurrentIteration(task.id))!, worktree,
      settings: task.agentSettings, prompt: 'What changed?', snapshotPath: foreign
    })).rejects.toThrow('only a Task Monki read-only snapshot');
    expect(s.agent.startedRuntimeTurns).toHaveLength(0);
  });

  it('removes a snapshot when its task is deleted', async () => {
    const s = await scenarios.create({ name: 'task-monki-side-question-delete' });
    const task = await s.createTask({ title: 'Deleted with a snapshot', prompt: 'Work.' });
    const worktree = await prepareTestWorktree(s.service, task.id);
    await expect(s.service.askSideQuestion({
      taskId: task.id, threadId: randomUUID(), messageId: randomUUID(), text: '   '
    })).rejects.toThrow('Write a question of at most');
    const implementation = await s.service.startRun({ taskId: task.id });
    s.agent.nextRuntimeTurnResult = { output: 'Nothing changed yet.' };
    const question = await s.service.askSideQuestion({
      taskId: task.id, threadId: randomUUID(), messageId: randomUUID(), text: 'What changed?'
    });
    const snapshotPath = s.agent.startedRuntimeTurns.at(-1)!.executionContext.primaryCwd;
    await s.waitForSnapshot((state) => runOf(state, question.runId)?.status === 'COMPLETED');
    await s.completeRun(implementation.id);
    await fs.access(snapshotPath);

    await s.service.deleteTask({ taskId: task.id, removeWorktree: false });

    await expect(fs.access(snapshotPath)).rejects.toThrow();
    expect(await snapshotRegistrations(s)).toEqual([]);
    expect((await listGitWorktrees(s.repositoryPath)).map((entry) => entry.path))
      .toContain(await fs.realpath(worktree.worktreePath));
  }, 30_000);
});
