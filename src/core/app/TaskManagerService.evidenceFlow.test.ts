import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  commandLine,
  createTaskMonkiScenario
} from '../../testSupport/taskMonkiScenario';

describe('TaskManagerService evidence flow', () => {
  it('observes post-run Git evidence, real test execution, artifacts, and stale tests', async () => {
    const scenario = await createTaskMonkiScenario({ name: 'task-monki-evidence-flow' });
    await scenario.commitFile(
      'pass-test.cjs',
      [
        "console.log('stdout from local test command');",
        "console.error('stderr from local test command');"
      ].join('\n')
    );
    const task = await scenario.createTask({
      title: 'Evidence flow',
      prompt: 'Run through implementation and verification evidence.',
      testCommand: commandLine(process.execPath, 'pass-test.cjs')
    });

    const run = await scenario.service.startRun({ taskId: task.id });
    expect(run.status).toBe('RUNNING');
    expect(scenario.agent.startedTurns).toHaveLength(1);

    const postRunEvidence = scenario.waitForSnapshot((snapshot) =>
      snapshot.runs.some(
        (candidate) => candidate.id === run.id && Boolean(candidate.afterGitSnapshotId)
      )
    );
    await scenario.completeRun(run.id, 'Implementation finished.');
    const afterRunSnapshot = await postRunEvidence;
    const afterRunTask = afterRunSnapshot.tasks.find((candidate) => candidate.id === task.id);
    const completedRun = afterRunSnapshot.runs.find((candidate) => candidate.id === run.id);
    expect(afterRunTask?.workflowPhase).toBe('REVIEW');
    expect(afterRunTask?.projection.agentRun).toBe('COMPLETED');
    expect(completedRun?.afterGitSnapshotId).toBeTruthy();

    const testTerminal = scenario.waitForEvent(
      (event) => event.type === 'test.terminal' && event.taskId === task.id
    );
    const queuedTest = await scenario.service.runTests({ taskId: task.id });
    expect(queuedTest.status).toBe('QUEUED');
    await testTerminal;

    const testedSnapshot = await scenario.store.snapshot();
    const completedTest = testedSnapshot.testRuns.find(
      (candidate) => candidate.id === queuedTest.id
    );
    if (!completedTest) {
      throw new Error('Expected the local test run to be stored.');
    }
    const testedTask = testedSnapshot.tasks.find((candidate) => candidate.id === task.id);
    expect(completedTest.status).toBe('PASSED');
    expect(completedTest.processStatus).toBe('EXITED');
    expect(completedTest.exitCode).toBe(0);
    expect(testedTask?.projection.tests).toBe('PASSED');
    await expect(scenario.store.readArtifact(completedTest.stdoutArtifactId)).resolves.toContain(
      'stdout from local test command'
    );
    await expect(scenario.store.readArtifact(completedTest.stderrArtifactId)).resolves.toContain(
      'stderr from local test command'
    );

    const worktree = testedSnapshot.worktrees.find(
      (candidate) => candidate.id === testedTask?.currentWorktreeId
    );
    if (!worktree) {
      throw new Error('Expected the task worktree to be present.');
    }
    await fs.writeFile(path.join(worktree.worktreePath, 'changed-after-tests.txt'), 'dirty\n');

    const dirtyGit = await scenario.service.refreshEvidence({ taskId: task.id });
    const staleSnapshot = await scenario.store.snapshot();
    const staleTest = staleSnapshot.testRuns.find(
      (candidate) => candidate.id === queuedTest.id
    );
    const staleTask = staleSnapshot.tasks.find((candidate) => candidate.id === task.id);
    expect(dirtyGit.status).toBe('DIRTY');
    expect(staleTest?.status).toBe('STALE');
    expect(staleTask?.projection.tests).toBe('STALE');
    expect(staleSnapshot.events.some((event) => event.type === 'TEST_RESULT_STALE')).toBe(true);
  });

  it('blocks a second local test run while the first process is still active', async () => {
    const scenario = await createTaskMonkiScenario({ name: 'task-monki-test-active' });
    await scenario.commitFile(
      'slow-test.cjs',
      'setTimeout(() => process.exit(0), 250);\n'
    );
    const task = await scenario.createTask({
      title: 'Active test guard',
      prompt: 'Keep a local test process active.',
      testCommand: commandLine(process.execPath, 'slow-test.cjs')
    });
    await scenario.service.prepareWorktree({ taskId: task.id });

    const testTerminal = scenario.waitForEvent(
      (event) => event.type === 'test.terminal' && event.taskId === task.id
    );
    await scenario.service.runTests({ taskId: task.id });

    await expect(scenario.service.runTests({ taskId: task.id })).rejects.toThrow(
      'already active'
    );
    await testTerminal;
  });
});
