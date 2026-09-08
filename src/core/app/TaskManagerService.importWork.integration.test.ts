import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskMonkiScenarioRegistry, type TaskMonkiScenario } from '../../testSupport/taskMonkiScenario';
import { openTestPersistence } from '../../testSupport/persistenceFixture';
import { git } from '../git/gitCli';
import * as gitCli from '../git/gitCli';
import { APP_DATABASE_SCHEMA_VERSION } from '../storage/sqlite/DatabaseMigrations';
import { AGENT_RUNTIME_LIMITS } from '../../shared/agentRuntime';

const scenarios = new TaskMonkiScenarioRegistry();
afterEach(async () => { vi.restoreAllMocks(); await scenarios.dispose(); });

async function importRequest(scenario: TaskMonkiScenario, checkout = scenario.repositoryPath) {
  return {
    title: 'Existing feature', prompt: 'Keep the imported task description.',
    repositoryId: scenario.repositoryId, worktreePath: checkout,
    branchName: (await git(checkout, ['branch', '--show-current'])).trim(),
    baseRef: (await git(scenario.repositoryPath, ['rev-list', '--max-parents=0', 'HEAD'])).trim(),
    agentSettings: { model: 'scenario-model', reasoningEffort: 'low' as const }
  };
}

describe('Import existing work', () => {
  it('rejects invalid review admission without moving the task and keeps failed or canceled reviews detached', async () => {
    const s = await scenarios.create();
    const task = await s.service.importTask(await importRequest(s));
    const gitDir = (await git(s.repositoryPath, ['rev-parse', '--absolute-git-dir'])).trim();
    await fs.writeFile(path.join(gitDir, 'MERGE_HEAD'), '1'.repeat(40));
    await expect(s.service.startReview({ taskId: task.id })).rejects.toThrow('Git operation');
    await fs.unlink(path.join(gitDir, 'MERGE_HEAD'));
    const capabilities = vi.spyOn(s.agent, 'capabilities').mockRejectedValueOnce(new Error('Review runtime unavailable'));
    await expect(s.service.startReview({ taskId: task.id })).rejects.toThrow('runtime unavailable');
    capabilities.mockRestore();
    expect(await s.store.getTask(task.id)).toMatchObject({ workflowPhase: 'IN_PROGRESS', phaseVersion: task.phaseVersion });
    expect((await s.store.snapshot()).runs).toEqual([]);

    s.agent.nextRuntimeTurnResult = { output: '', status: 'failed', error: 'Review provider failed' };
    const failed = await s.service.startReview({ taskId: task.id });
    await s.waitForSnapshot((state) => state.tasks[0]?.projection.agentReview?.status === 'FAILED' &&
      Boolean(state.runs.find((run) => run.id === failed.id)?.afterGitSnapshotId));
    const retry = await s.service.startReview({ taskId: task.id });
    await expect(s.service.startReview({ taskId: task.id })).rejects.toThrow('review to finish');
    await s.service.cancelRun({ runId: retry.id });
    await s.waitForSnapshot((state) => state.tasks[0]?.projection.agentReview?.status === 'CANCELED');
    const canceledTask = await s.store.getTask(task.id);
    expect(canceledTask?.workflowPhase).toBe('REVIEW');
    expect(canceledTask?.currentRunId).toBeUndefined();
    expect(canceledTask?.currentAgentSessionId).toBeUndefined();
    expect(s.agent.startedTurns).toEqual([]);
  });

  it('publishes the direct-review transition with its run-start event or neither on SQLite failure', async () => {
    const s = await scenarios.create();
    const task = await s.service.importTask(await importRequest(s));
    await s.persistence.database.write((transaction) => {
      transaction.run(`CREATE TRIGGER reject_review BEFORE INSERT ON task_domain_events
        WHEN NEW.type = 'AGENT_RUN_STARTED' BEGIN SELECT RAISE(ABORT, 'review admission failure'); END`);
    });
    await expect(s.service.startReview({ taskId: task.id })).rejects.toThrow('review admission failure');
    expect(await s.store.getTask(task.id)).toMatchObject({ workflowPhase: 'IN_PROGRESS', phaseVersion: task.phaseVersion });
    expect(s.persistence.database.get<{ count: number }>(
      "SELECT count(*) AS count FROM task_domain_events WHERE type IN ('TRANSITION_COMPLETED', 'AGENT_RUN_STARTED')"
    )?.count).toBe(0);
    expect(s.agent.startedRuntimeTurns).toEqual([]);
    await s.persistence.database.write((transaction) => { transaction.run('DROP TRIGGER reject_review'); });
    const prepared = (await s.store.snapshot()).runs[0]!;
    await s.store.recordAgentRunStarted(prepared);
    expect(await s.store.getTask(task.id)).toMatchObject({ workflowPhase: 'REVIEW', phaseVersion: task.phaseVersion + 1 });
    await s.transitionRun(prepared.id, { status: 'FAILED', terminalReason: 'Admission test finished without provider delivery.' });
  });

  it('imports committed and dirty work once, resolves aliases and archived duplicates, and starts no provider work', async () => {
    const s = await scenarios.create();
    const checkout = path.join(s.rootDir, 'external');
    await git(s.repositoryPath, ['worktree', 'add', '-b', 'feature', checkout]);
    await fs.writeFile(path.join(checkout, 'committed.txt'), 'committed feature\n');
    await git(checkout, ['add', 'committed.txt']);
    await git(checkout, ['commit', '-m', 'External feature']);
    await fs.writeFile(path.join(checkout, 'README.md'), 'staged feature\n');
    await git(checkout, ['add', 'README.md']);
    await fs.writeFile(path.join(checkout, 'README.md'), 'unstaged feature\n');
    await fs.writeFile(path.join(checkout, 'untracked.txt'), 'untracked feature\n');
    const request = await importRequest(s, checkout);
    const capabilities = vi.spyOn(s.agent, 'capabilities');
    const before = await git(checkout, ['status', '--porcelain=v2']);
    const indexPath = path.resolve(checkout, (await git(checkout, ['rev-parse', '--git-path', 'index'])).trim());
    const indexBefore = await fs.readFile(indexPath);
    const preview = await s.service.previewImport({ ...request, baseRef: undefined });
    expect(preview).toMatchObject({
      baseRef: 'refs/heads/main', commitCount: 1, fileCount: 2,
      commits: [{ sha: expect.any(String), subject: 'External feature' }],
      files: [{ path: 'README.md', status: 'MM' }, { path: 'untracked.txt', status: '??' }]
    });
    expect(await fs.readFile(indexPath)).toEqual(indexBefore);
    expect((await s.store.snapshot()).tasks).toEqual([]);
    expect((await s.store.snapshot()).artifacts).toEqual([]);
    await expect(s.service.previewImport({ ...request, baseRef: 'HEAD' })).resolves.toMatchObject({ commitCount: 0, fileCount: 2 });
    await expect(s.service.previewImport({ ...request, baseRef: '--not-a-commit' })).rejects.toThrow('valid local branch or commit');
    const [first, second] = await Promise.all([s.service.importTask(request), s.service.importTask(request)]);
    expect(first.id).toBe(second.id);
    expect(first).toMatchObject({ workflowPhase: 'IN_PROGRESS', projection: { requestedAction: 'NONE' } });
    expect(first.currentRunId).toBeUndefined();
    expect(first.currentAgentSessionId).toBeUndefined();
    const snapshot = await s.store.snapshot();
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.worktrees).toHaveLength(1);
    expect(snapshot.worktrees[0]).toMatchObject({ ownership: 'EXTERNAL', worktreePath: await fs.realpath(checkout), branchName: 'feature' });
    expect(snapshot.gitSnapshots).toHaveLength(1);
    expect(snapshot.gitSnapshots[0]).toMatchObject({ commitsAheadOfBase: 1, stagedCount: 1, unstagedCount: 1, untrackedCount: 1 });
    const diff = await s.store.readArtifact(snapshot.gitSnapshots[0]!.diffArtifactId!);
    for (const content of ['committed feature', 'staged feature', 'unstaged feature', 'untracked feature']) expect(diff).toContain(content);
    expect(snapshot.runs).toEqual([]);
    expect(snapshot.agentSessions).toEqual([]);
    expect(snapshot.events.some((event) => event.type === 'WORKTREE_CREATE_REQUESTED')).toBe(false);
    expect(s.agent.startedTurns).toEqual([]);
    expect(s.agent.startedRuntimeTurns).toEqual([]);
    expect(capabilities).not.toHaveBeenCalled();
    expect(await git(checkout, ['status', '--porcelain=v2'])).toBe(before);

    const alias = path.join(s.rootDir, 'checkout-alias');
    await fs.symlink(checkout, alias, 'junction');
    await expect(s.service.importTask({ ...request, worktreePath: alias })).resolves.toMatchObject({ id: first.id });
    await s.store.transitionTask(first.id, 'ARCHIVED', 'Archive imported work.');
    await expect(s.service.importTask(request)).resolves.toMatchObject({ id: first.id, workflowPhase: 'ARCHIVED' });
    const sameRepository = await s.service.addRepository(checkout);
    await expect(s.service.importTask({ ...request, repositoryId: sameRepository.id })).resolves.toMatchObject({ id: first.id });
    expect((await s.service.listExistingWorktrees(s.repositoryId)).find((entry) => entry.branchName === 'feature')?.existingTaskId).toBe(first.id);

    await s.service.shutdown();
    await s.persistence.close();
    const reopened = await openTestPersistence(path.join(s.rootDir, 'profile'));
    try {
      await expect(reopened.tasks.getTask(first.id)).resolves.toMatchObject({ workflowPhase: 'ARCHIVED' });
      expect((await reopened.tasks.snapshot()).worktrees[0]?.ownership).toBe('EXTERNAL');
    } finally { await reopened.close(); }
  });

  it('rolls back the complete import and its managed evidence after a database failure', async () => {
    const s = await scenarios.create();
    const request = await importRequest(s);
    await s.persistence.database.write((transaction) => {
      transaction.run(`CREATE TRIGGER reject_import BEFORE INSERT ON worktrees
        BEGIN SELECT RAISE(ABORT, 'import failure'); END`);
    });
    await expect(s.service.importTask(request)).rejects.toThrow('import failure');
    const snapshot = await s.store.snapshot();
    for (const collection of ['tasks', 'iterations', 'worktrees', 'gitSnapshots', 'artifacts', 'events'] as const) {
      expect(snapshot[collection]).toEqual([]);
    }
    for (const table of ['tasks', 'task_iterations', 'worktrees', 'git_snapshots', 'artifacts']) {
      expect(s.persistence.database.get<{ count: number }>(`SELECT count(*) AS count FROM ${table}`)?.count).toBe(0);
    }
    await s.persistence.database.write((transaction) => { transaction.run('DROP TRIGGER reject_import'); });
    const task = await s.service.importTask(request);
    expect(task.currentWorktreeId).toBeDefined();
    expect((await s.store.snapshot()).tasks).toHaveLength(1);
  });

  it('imports a clean checkout without a description while new work still requires one', async () => {
    const s = await scenarios.create();
    const request = { ...await importRequest(s), prompt: '' };
    await expect(s.store.createTask(request)).rejects.toThrow('Task prompt is required');
    await expect(s.service.previewImport({ ...request, baseRef: 'HEAD' })).resolves.toMatchObject({ commitCount: 0, fileCount: 0 });
    const task = await s.service.importTask(request);
    expect(task).toMatchObject({ prompt: '', workflowPhase: 'IN_PROGRESS' });
    expect(s.agent.startedTurns).toEqual([]);
    await s.service.shutdown();
    await s.persistence.close();
    const reopened = await openTestPersistence(path.join(s.rootDir, 'profile'));
    try { await expect(reopened.tasks.getTask(task.id)).resolves.toMatchObject({ prompt: '', workflowPhase: 'IN_PROGRESS' }); }
    finally { await reopened.close(); }
  });

  it('previews non-main branches, renamed and binary files, bounded lists, and unfinished Git operations', async () => {
    const s = await scenarios.create();
    await git(s.repositoryPath, ['branch', '-m', 'trunk']);
    await s.service.refreshRepository(s.repositoryId);
    const request = await importRequest(s);
    await expect(s.service.previewImport({ ...request, baseRef: undefined })).resolves.toMatchObject({
      baseRef: 'refs/heads/trunk', commitCount: 0, fileCount: 0
    });
    await fs.writeFile(path.join(s.repositoryPath, 'binary.dat'), Buffer.from([0, 1, 2]));
    await git(s.repositoryPath, ['add', 'binary.dat']);
    await git(s.repositoryPath, ['commit', '-m', 'Add binary fixture']);
    await git(s.repositoryPath, ['mv', 'README.md', 'renamed with spaces.txt']);
    await fs.writeFile(path.join(s.repositoryPath, 'binary.dat'), Buffer.from([0, 3, 4]));
    for (let index = 0; index < 105; index += 1) {
      await fs.writeFile(path.join(s.repositoryPath, `untracked-${index}.txt`), 'note\n');
    }
    const preview = await s.service.previewImport({ ...request, baseRef: 'HEAD' });
    expect(preview.fileCount).toBe(107);
    expect(preview.files).toHaveLength(100);
    expect(preview.files.find((file) => file.path === 'renamed with spaces.txt')).toMatchObject({ status: 'R', additions: 0, deletions: 0 });
    expect(preview.files.find((file) => file.path === 'binary.dat')).toEqual({ path: 'binary.dat', status: 'M' });
    const gitDir = (await git(s.repositoryPath, ['rev-parse', '--absolute-git-dir'])).trim();
    await fs.writeFile(path.join(gitDir, 'MERGE_HEAD'), preview.headSha);
    await expect(s.service.previewImport({ ...request, baseRef: 'HEAD' })).resolves.toMatchObject({
      unavailableReason: 'Finish the current Git operation and resolve conflicts before importing.'
    });
  });

  it('lists unavailable checkouts and revalidates the selected branch before importing', async () => {
    const s = await scenarios.create();
    const locked = path.join(s.rootDir, 'locked');
    const detached = path.join(s.rootDir, 'detached');
    const missing = path.join(s.rootDir, 'missing');
    await git(s.repositoryPath, ['worktree', 'add', '-b', 'locked', locked]);
    await git(s.repositoryPath, ['worktree', 'lock', locked]);
    await git(s.repositoryPath, ['worktree', 'add', '--detach', detached]);
    await git(s.repositoryPath, ['worktree', 'add', '-b', 'missing', missing]);
    await fs.rename(missing, path.join(s.rootDir, 'moved-outside-git'));

    const inventoryReads = vi.spyOn(gitCli, 'git');
    const candidates = await s.service.listExistingWorktrees(s.repositoryId);
    expect(inventoryReads.mock.calls.filter(([, args]) => args[0] === 'worktree' && args[1] === 'list')).toHaveLength(1);
    inventoryReads.mockRestore();
    expect(candidates).toHaveLength(4);
    for (const unavailable of [locked, detached, missing]) {
      expect(candidates.find((entry) => path.basename(entry.worktreePath) === path.basename(unavailable))?.unavailableReason).toBeTruthy();
    }
    const selected = candidates.find((entry) => entry.branchName === 'main')!;
    expect(selected.unavailableReason).toBeUndefined();
    const request = await importRequest(s, selected.worktreePath);
    await git(selected.worktreePath, ['switch', '-c', 'changed-after-selection']);
    await expect(s.service.importTask(request)).rejects.toThrow('main');
    expect((await s.store.snapshot()).tasks).toEqual([]);
  });

  it('protects an external checkout through prepare, failed removal, and task-only deletion', async () => {
    const s = await scenarios.create();
    const task = await s.service.importTask({ ...await importRequest(s), baseRef: 'HEAD' });
    const originalHead = (await git(s.repositoryPath, ['rev-parse', 'HEAD'])).trim();
    await s.service.prepareWorktree({ taskId: task.id });
    await fs.writeFile(path.join(s.repositoryPath, 'external.txt'), 'keep this external file\n');
    await expect(s.service.createDeliveryCommit({ taskId: task.id })).rejects.toThrow('external checkout');
    await expect(s.service.publishBranch({ taskId: task.id })).rejects.toThrow('external checkout');
    await expect(s.service.deleteTask({ taskId: task.id, removeWorktree: true })).rejects.toThrow('external checkout');
    expect(await s.store.getTask(task.id)).toBeDefined();
    await s.service.deleteTask({ taskId: task.id });
    expect(await s.store.getTask(task.id)).toBeUndefined();
    expect((await git(s.repositoryPath, ['rev-parse', 'HEAD'])).trim()).toBe(originalHead);
    await expect(fs.readFile(path.join(s.repositoryPath, 'README.md'), 'utf8')).resolves.toBe('# Scenario\n');
    await expect(fs.readFile(path.join(s.repositoryPath, 'external.txt'), 'utf8')).resolves.toBe('keep this external file\n');
  });

  it('upgrades existing managed worktrees through a forward migration and keeps a pre-upgrade backup', async () => {
    const s = await scenarios.create();
    const task = await s.createTask();
    const worktree = await s.service.prepareWorktree({ taskId: task.id });
    const databasePath = s.persistence.database.databasePath;
    await s.service.shutdown();
    await s.persistence.close();
    const old = new DatabaseSync(databasePath);
    old.exec(`UPDATE worktrees SET payload_json = json_remove(payload_json, '$.ownership'); PRAGMA user_version = 1;`);
    old.close();
    const upgraded = await openTestPersistence(path.join(s.rootDir, 'profile'));
    try {
      expect(upgraded.database.schemaVersion).toBe(APP_DATABASE_SCHEMA_VERSION);
      await expect(upgraded.tasks.getWorktree(worktree.id)).resolves.toMatchObject({ ownership: 'MANAGED', worktreePath: worktree.worktreePath });
      expect((await fs.readdir(path.join(s.rootDir, 'profile', 'backups'))).length).toBe(1);
    } finally { await upgraded.close(); }
  });

  it('observes external edits without phase changes or duplicate history, and reconnects without rewriting evidence', async () => {
    const s = await scenarios.create();
    const checkout = path.join(s.rootDir, 'external');
    const moved = path.join(s.rootDir, 'moved');
    await git(s.repositoryPath, ['worktree', 'add', '-b', 'feature', checkout]);
    const task = await s.service.importTask({ ...await importRequest(s, checkout), baseRef: 'HEAD' });
    const initial = await s.store.snapshot();
    const executeGit = gitCli.git;
    // A previously captured patch need not be exported again (and may exceed
    // the process output limit) just to observe an unchanged checkout.
    const unavailablePatch = vi.spyOn(gitCli, 'git').mockImplementation((cwd, args, options) => {
      if (args.length === 2 && args[0] === 'diff' && args[1] === `${initial.gitSnapshots[0]!.baseSha}..HEAD`) {
        return Promise.reject(new Error('Patch export exceeds the output limit'));
      }
      return executeGit(cwd, args, options);
    });
    const [one, two] = await Promise.all([
      s.service.refreshEvidence({ taskId: task.id }), s.service.refreshEvidence({ taskId: task.id })
    ]);
    unavailablePatch.mockRestore();
    expect(one.id).toBe(initial.gitSnapshots[0]!.id);
    expect(two.id).toBe(one.id);
    expect((await s.store.snapshot()).events).toHaveLength(initial.events.length);
    await fs.writeFile(path.join(checkout, 'external.txt'), 'an external change\n');
    const dirty = await s.service.refreshEvidence({ taskId: task.id });
    expect(dirty).toMatchObject({ untrackedCount: 1, baseSha: one.baseSha });
    await git(checkout, ['add', 'external.txt']);
    await git(checkout, ['commit', '-m', 'External change']);
    const committed = await s.service.refreshEvidence({ taskId: task.id });
    expect(committed).toMatchObject({ commitsAheadOfBase: 1, baseSha: one.baseSha });
    expect((await s.store.getTask(task.id))?.workflowPhase).toBe('IN_PROGRESS');
    await git(checkout, ['switch', '-c', 'wrong-branch']);
    await expect(s.service.refreshEvidence({ taskId: task.id })).rejects.toThrow('not ready');
    await git(checkout, ['switch', 'feature']);
    await git(s.repositoryPath, ['worktree', 'move', checkout, moved]);
    const missingObservation = s.service.refreshEvidence({ taskId: task.id });
    const reconnect = s.service.reconnectWorktree({ taskId: task.id, worktreePath: moved });
    await expect(missingObservation).rejects.toThrow('not ready');
    const reconnected = await reconnect;
    expect(reconnected).toMatchObject({ worktreePath: await fs.realpath(moved), baseSha: one.baseSha, status: 'PRESENT' });
    const beforeComparison = await s.store.snapshot();
    await s.persistence.database.write((transaction) => {
      transaction.run(`CREATE TRIGGER reject_comparison BEFORE UPDATE ON worktrees
        BEGIN SELECT RAISE(ABORT, 'comparison failure'); END`);
    });
    await expect(s.service.updateWorktreeComparison({ taskId: task.id, baseRef: 'HEAD' })).rejects.toThrow('comparison failure');
    const rejected = await s.store.snapshot();
    expect(rejected.worktrees).toEqual(beforeComparison.worktrees);
    expect(rejected.iterations).toEqual(beforeComparison.iterations);
    expect(rejected.gitSnapshots).toEqual(beforeComparison.gitSnapshots);
    expect(rejected.artifacts).toEqual(beforeComparison.artifacts);
    await s.persistence.database.write((transaction) => { transaction.run('DROP TRIGGER reject_comparison'); });
    const comparison = await s.service.updateWorktreeComparison({ taskId: task.id, baseRef: 'HEAD' });
    expect(comparison.baseSha).toBe(committed.headSha);
    const updated = await s.store.snapshot();
    expect(updated.iterations[0]?.baseSha).toBe(committed.headSha);
    expect(updated.gitSnapshots.find((entry) => entry.id === one.id)?.worktreePath).toBe(one.worktreePath);
    expect(updated.gitSnapshots[0]?.commitsAheadOfBase).toBe(0);
    expect(s.agent.startedTurns).toEqual([]);
    await s.service.shutdown();
    await s.persistence.close();
    const reopened = await openTestPersistence(path.join(s.rootDir, 'profile'));
    try { expect((await reopened.tasks.snapshot()).gitSnapshots).toHaveLength(updated.gitSnapshots.length); }
    finally { await reopened.close(); }
  });

  it('rejects an external edit during diff capture without replacing the previous evidence', async () => {
    const s = await scenarios.create();
    const task = await s.service.importTask(await importRequest(s));
    const initial = await s.store.snapshot();
    const changedFile = path.join(s.repositoryPath, 'external.txt');
    await fs.writeFile(changedFile, 'before capture\n');
    const executeGit = gitCli.git;
    const externalEdit = vi.spyOn(gitCli, 'git').mockImplementation(async (cwd, args, options) => {
      const result = await executeGit(cwd, args, options);
      if (args.length === 2 && args[0] === 'diff' && args[1] === `${initial.gitSnapshots[0]!.baseSha}..HEAD`) {
        await fs.writeFile(changedFile, 'changed during capture\n');
      }
      return result;
    });
    await expect(s.service.refreshEvidence({ taskId: task.id })).rejects.toThrow('checkout changed');
    externalEdit.mockRestore();
    const rejected = await s.store.snapshot();
    expect(rejected.gitSnapshots).toEqual(initial.gitSnapshots);
    expect(rejected.artifacts).toEqual(initial.artifacts);
    const refreshed = await s.service.refreshEvidence({ taskId: task.id });
    expect(refreshed.untrackedCount).toBe(1);
    expect(await s.store.readArtifact(refreshed.diffArtifactId!)).toContain('changed during capture');
  });

  it('reviews imported work without a coding session and invalidates review when only the comparison changes', async () => {
    const s = await scenarios.create();
    const settings = await s.service.saveAgentProfile({ name: 'Security', description: '', instructions: 'Trace input validation across the imported changes.' });
    const profile = settings.agentProfiles[0]!;
    const request = await importRequest(s);
    await s.commitFile('committed.txt', 'existing feature\n');
    await fs.writeFile(path.join(s.repositoryPath, 'dirty.txt'), 'untracked feature\n');
    const task = await s.service.importTask(request);
    expect(task.agentProfile).toBeUndefined();
    s.agent.nextRuntimeTurnResult = {
      output: 'No regressions found.\n```json\n' + JSON.stringify({
        schemaVersion: 'agent-review/v1', verdict: 'PASSED', summary: 'No regressions found.', findings: []
      }) + '\n```'
    };
    // Starting review immediately after task open waits for the same observation.
    const [, review] = await Promise.all([
      s.service.refreshEvidence({ taskId: task.id }),
      s.service.startReview({ taskId: task.id, agentProfileId: profile.id })
    ]);
    const reviewed = await s.waitForSnapshot((state) =>
      state.tasks[0]?.projection.agentReview?.status === 'PASSED' && Boolean(state.runs[0]?.afterGitSnapshotId));
    expect(reviewed.tasks[0]).toMatchObject({ workflowPhase: 'REVIEW', projection: { agentReview: { status: 'PASSED' } } });
    expect(reviewed.tasks[0]?.currentRunId).toBeUndefined();
    expect(reviewed.tasks[0]?.currentAgentSessionId).toBeUndefined();
    expect(reviewed.agentSessions.map((session) => session.role)).toEqual(['REVIEW']);
    expect(reviewed.agentSessions[0]?.parentSessionId).toBeUndefined();
    const prompt = await s.runtimeStore.readArtifact(review.promptArtifactId);
    expect(prompt).toContain(profile.instructions);
    expect(s.agent.startedRuntimeTurns.find((turn) => turn.run.id === review.id)?.prompt).toBe(prompt);
    expect(prompt).toContain(`from ${request.baseRef} to HEAD`);
    expect(prompt).toContain('staged, unstaged, and untracked');
    expect(review.requestedSettings.sandbox).toBe('READ_ONLY');
    await s.service.refreshEvidence({ taskId: task.id });
    expect((await s.store.getTask(task.id))?.projection.agentReview?.status).toBe('PASSED');
    s.agent.nextRuntimeTurnResult = {
      output: 'No regressions found.\n```json\n' + JSON.stringify({
        schemaVersion: 'agent-review/v1', verdict: 'PASSED', summary: 'No regressions found.', findings: []
      }) + '\n```'
    };
    const repeated = await s.service.startReview({ taskId: task.id });
    expect(repeated.id).not.toBe(review.id);
    await s.waitForSnapshot((state) => state.tasks[0]?.projection.agentReview?.status === 'PASSED' &&
      Boolean(state.runs.find((candidate) => candidate.id === repeated.id)?.afterGitSnapshotId));
    await s.service.updateWorktreeComparison({ taskId: task.id, baseRef: 'HEAD' });
    expect((await s.store.getTask(task.id))?.projection.agentReview?.status).toBe('STALE');
    s.agent.nextRuntimeTurnResult = { output: 'The unchanged code looks correct.' };
    s.agent.beforeNextRuntimeTurnTerminal = () => fs.writeFile(path.join(s.repositoryPath, 'dirty.txt'), 'changed in another editor\n');
    const concurrent = await s.service.startReview({ taskId: task.id });
    const changed = await s.waitForSnapshot((state) =>
      Boolean(state.runs.find((candidate) => candidate.id === concurrent.id)?.afterGitSnapshotId));
    expect(changed.tasks[0]?.projection.agentReview?.status).toBe('STALE');
    expect(changed.events.some((event) => event.type === 'AGENT_REVIEW_POLICY_VIOLATION')).toBe(false);
    expect(s.agent.startedTurns).toEqual([]);
  });

  it('requires explicit coding intent, retains it on retry, and starts a fresh session after reconnect', async () => {
    const s = await scenarios.create();
    const checkout = path.join(s.rootDir, 'external');
    const moved = path.join(s.rootDir, 'moved');
    await git(s.repositoryPath, ['worktree', 'add', '-b', 'feature', checkout]);
    const task = await s.service.importTask(await importRequest(s, checkout));
    await expect(s.service.startRun({ taskId: task.id })).rejects.toThrow('Enter an instruction');
    await expect(s.service.startRun({ taskId: task.id, instruction: 'x'.repeat(AGENT_RUNTIME_LIMITS.maxArtifactBytes) })).rejects.toThrow('prompt limit');
    expect((await s.store.snapshot()).agentSessions).toEqual([]);
    const instruction = 'Fix only the imported null-handling regression. Preserve the existing public behavior.';
    const run = await s.service.startRun({ taskId: task.id, instruction });
    const initialPrompt = await s.runtimeStore.readArtifact(run.promptArtifactId);
    expect(initialPrompt).toContain(instruction);
    expect(initialPrompt).toContain("user's original imported checkout");
    expect(initialPrompt).not.toContain('Perform this task in an isolated Git worktree.');
    await s.transitionRun(run.id, { status: 'FAILED', terminalReason: 'Provider stopped.' });
    await expect(s.service.startReview({ taskId: task.id })).rejects.toThrow('successfully completed');
    const retry = await s.service.retryRun({
      taskId: task.id, runId: run.id, strategy: 'SAME_SESSION', instruction: 'Add the missing boundary test.'
    });
    const retryPrompt = await s.runtimeStore.readArtifact(retry.promptArtifactId);
    expect(retryPrompt).toContain(instruction);
    expect(retryPrompt).toContain('Add the missing boundary test.');
    expect(retryPrompt).toContain("user's original imported checkout");
    expect(retryPrompt).not.toContain('Continue in the existing isolated task worktree.');
    expect(retry.sessionId).toBe(run.sessionId);
    await s.completeRun(retry.id);
    await s.waitForSnapshot((state) => Boolean(state.runs.find((candidate) => candidate.id === retry.id)?.afterGitSnapshotId));
    await git(s.repositoryPath, ['worktree', 'move', checkout, moved]);
    await s.service.reconnectWorktree({ taskId: task.id, worktreePath: moved });
    const followUp = await s.service.continueRun({ taskId: task.id, runId: retry.id, instruction: 'Check the remaining boundary case.' });
    expect(followUp.sessionId).not.toBe(run.sessionId);
    const state = await s.store.snapshot();
    expect(state.agentSessions.find((session) => session.id === run.sessionId)?.worktreePath).toBe(await fs.realpath(s.repositoryPath).then((root) => path.join(path.dirname(root), 'external')));
    expect(state.agentSessions.find((session) => session.id === followUp.sessionId)?.worktreePath).toBe(await fs.realpath(moved));
    expect((await s.store.getTask(task.id))?.prompt).toBe(task.prompt);
    await s.completeRun(followUp.id);
    const alternative = await s.service.retryRun({
      taskId: task.id, runId: followUp.id, strategy: 'FORK', instruction: 'Try the minimal alternative.'
    });
    const alternativePrompt = await s.runtimeStore.readArtifact(alternative.promptArtifactId);
    expect(alternativePrompt).toContain(instruction);
    expect(alternativePrompt).toContain('Check the remaining boundary case.');
    expect(alternativePrompt).toContain('Try the minimal alternative.');
    expect(alternative.taskId).not.toBe(task.id);
    expect((await s.store.getTask(task.id))?.prompt).toBe(task.prompt);
    await s.completeRun(alternative.id);
    await s.service.shutdown();
    await s.persistence.close();
    const reopened = await openTestPersistence(path.join(s.rootDir, 'profile'));
    try { expect((await reopened.tasks.snapshot()).agentSessions).toHaveLength(3); }
    finally { await reopened.close(); }
  }, 20_000);
});
