import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorktreeBaseOption } from '../../shared/contracts';
import { TaskMonkiScenarioRegistry } from '../../testSupport/taskMonkiScenario';
import { git } from '../git/gitCli';

const scenarios = new TaskMonkiScenarioRegistry();
afterEach(() => scenarios.dispose());

describe('Explicit worktree base selection', () => {
  it('uses the selected local branch without copying dirty source files or switching the source checkout', async () => {
    const scenario = await scenarios.create();
    const task = await scenario.createTask();
    const sourceBranch = (await git(scenario.repositoryPath, ['branch', '--show-current'])).trim();
    await git(scenario.repositoryPath, ['checkout', '-b', 'backend-contract']);
    const featureSha = await scenario.commitFile('contract.txt', 'version 2\n');
    await git(scenario.repositoryPath, ['checkout', sourceBranch]);
    await fs.writeFile(path.join(scenario.repositoryPath, 'README.md'), 'source edit\n');
    await fs.writeFile(path.join(scenario.repositoryPath, 'untracked.txt'), 'source only\n');
    const inspection = await scenario.service.inspectWorktreePreparation({ taskId: task.id });
    expect(inspection.mode).toBe('CREATE');
    if (inspection.mode !== 'CREATE') throw new Error('Expected base selection.');
    const selected = inspection.bases.find((base) => base.refName === 'refs/heads/backend-contract')!;
    expect(selected.sha).toBe(featureSha);
    const result = await scenario.service.prepareWorktree(createInput(task.id, selected));
    expect(result.outcome).toBe('PREPARED');
    if (result.outcome !== 'PREPARED') throw new Error('Expected a prepared worktree.');
    expect(result.worktree).toMatchObject({ baseRef: 'backend-contract', baseSha: featureSha });
    await expect(fs.readFile(path.join(result.worktree.worktreePath, 'contract.txt'), 'utf8')).resolves.toBe('version 2\n');
    await expect(fs.readFile(path.join(result.worktree.worktreePath, 'README.md'), 'utf8')).resolves.toBe('# Scenario\n');
    await expect(fs.access(path.join(result.worktree.worktreePath, 'untracked.txt'))).rejects.toThrow();
    expect((await git(scenario.repositoryPath, ['branch', '--show-current'])).trim()).toBe(sourceBranch);
    await expect(fs.readFile(path.join(scenario.repositoryPath, 'README.md'), 'utf8')).resolves.toBe('source edit\n');
  }, 20_000);

  it('requires a new confirmation when a branch moves and keeps one bound base after repeated or conflicting requests', async () => {
    const scenario = await scenarios.create();
    const task = await scenario.createTask();
    await expect(scenario.service.startRun({ taskId: task.id })).rejects.toThrow('choose its base');
    await expect(scenario.service.prepareWorktree({ taskId: task.id } as never)).rejects.toThrow('explicit CREATE or RECOVER');
    const inspection = await scenario.service.inspectWorktreePreparation({ taskId: task.id });
    if (inspection.mode !== 'CREATE') throw new Error('Expected base selection.');
    const selected = inspection.bases.find((base) => base.current)!;
    const movedSha = await scenario.commitFile('later.txt', 'later\n');
    const changed = await scenario.service.prepareWorktree(createInput(task.id, selected));
    expect(changed).toMatchObject({ outcome: 'BASE_CHANGED' });
    expect((await scenario.store.snapshot()).worktrees).toHaveLength(0);
    expect((await scenario.store.snapshot()).iterations).toHaveLength(0);
    await expect(fs.access(path.join(scenario.worktreeRoot, task.id))).rejects.toThrow();
    if (changed.outcome !== 'BASE_CHANGED') throw new Error('Expected changed base.');
    const refreshed = changed.inspection.bases.find((base) => base.refName === selected.refName)!;
    expect(refreshed.sha).toBe(movedSha);
    const prepared = await scenario.service.prepareWorktree(createInput(task.id, refreshed));
    if (prepared.outcome !== 'PREPARED') throw new Error('Expected a prepared worktree.');
    for (const base of [selected, { ...selected, refName: 'refs/heads/other' }]) {
      await expect(scenario.service.prepareWorktree(createInput(task.id, base))).resolves.toMatchObject({
        outcome: 'BASE_ALREADY_BOUND', worktree: { id: prepared.worktree.id, baseSha: movedSha }
      });
    }
    expect((await scenario.store.snapshot()).iterations).toHaveLength(1);
  }, 20_000);

  it('offers detached HEAD explicitly and rejects deleted branches and arbitrary Git revisions', async () => {
    const scenario = await scenarios.create();
    const task = await scenario.createTask();
    await git(scenario.repositoryPath, ['branch', 'temporary-base']);
    const inspection = await scenario.service.inspectWorktreePreparation({ taskId: task.id });
    if (inspection.mode !== 'CREATE') throw new Error('Expected base selection.');
    const temporary = inspection.bases.find((base) => base.refName === 'refs/heads/temporary-base')!;
    await git(scenario.repositoryPath, ['branch', '-d', 'temporary-base']);
    for (const refName of [temporary.refName, 'HEAD', '--help', 'HEAD~0']) {
      await expect(scenario.service.prepareWorktree(createInput(task.id, { ...temporary, refName }))).resolves.toMatchObject({ outcome: 'BASE_CHANGED' });
    }
    expect((await scenario.store.snapshot()).worktrees).toHaveLength(0);
    await git(scenario.repositoryPath, ['checkout', '--detach', temporary.sha]);
    const detached = await scenario.service.inspectWorktreePreparation({ taskId: task.id });
    if (detached.mode !== 'CREATE') throw new Error('Expected base selection.');
    const selected = detached.bases.find((base) => base.current)!;
    expect(selected).toMatchObject({ displayName: 'Detached HEAD', sha: temporary.sha });
    expect(selected.refName).toBeUndefined();
    await expect(scenario.service.prepareWorktree(createInput(task.id, selected))).resolves.toMatchObject({
      outcome: 'PREPARED', worktree: { baseSha: temporary.sha }
    });
  }, 20_000);

  it.each(['LOCKED', 'MISSING_REGISTERED'] as const)('does not report a %s worktree as restored', async (status) => {
    const scenario = await scenarios.create();
    const task = await scenario.createTask();
    const inspection = await scenario.service.inspectWorktreePreparation({ taskId: task.id });
    if (inspection.mode !== 'CREATE') throw new Error('Expected base selection.');
    const prepared = await scenario.service.prepareWorktree(createInput(task.id, inspection.bases[0]!));
    if (prepared.outcome !== 'PREPARED') throw new Error('Expected a prepared worktree.');
    if (status === 'LOCKED') {
      await git(scenario.repositoryPath, ['worktree', 'lock', prepared.worktree.worktreePath]);
    } else {
      await fs.rm(prepared.worktree.worktreePath, { recursive: true });
    }
    await expect(scenario.service.prepareWorktree({ taskId: task.id, intent: 'RECOVER' }))
      .rejects.toThrow(status === 'LOCKED' ? /locked/ : /prunable|registered/i);
    expect((await scenario.store.getCurrentWorktree(task.id))?.status)
      .toMatch(status === 'LOCKED' ? /^LOCKED$/ : /^(PRUNABLE|ERROR)$/);
    expect((await scenario.store.snapshot()).runs).toHaveLength(0);
  }, 20_000);

  it('restores the last verified commit explicitly, refuses a conflicting task branch, and never recreates from Start', async () => {
    const scenario = await scenarios.create();
    const task = await scenario.createTask();
    const inspection = await scenario.service.inspectWorktreePreparation({ taskId: task.id });
    if (inspection.mode !== 'CREATE') throw new Error('Expected base selection.');
    const base = inspection.bases.find((candidate) => candidate.current)!;
    const prepared = await scenario.service.prepareWorktree(createInput(task.id, base));
    if (prepared.outcome !== 'PREPARED') throw new Error('Expected a prepared worktree.');
    const worktree = prepared.worktree;
    await git(worktree.worktreePath, ['checkout', '-b', 'manually-switched']);
    await expect(scenario.service.startRun({ taskId: task.id })).rejects.toThrow('Task Monki-owned branch');
    expect((await scenario.store.snapshot()).runs).toHaveLength(0);
    await git(worktree.worktreePath, ['checkout', worktree.branchName]);
    await fs.writeFile(path.join(worktree.worktreePath, 'progress.txt'), 'saved work\n');
    await git(worktree.worktreePath, ['add', 'progress.txt']);
    await git(worktree.worktreePath, ['commit', '-m', 'Save task progress']);
    await scenario.service.refreshEvidence({ taskId: task.id });
    const savedSha = (await git(worktree.worktreePath, ['rev-parse', 'HEAD'])).trim();
    await git(scenario.repositoryPath, ['worktree', 'remove', worktree.worktreePath]);
    await expect(scenario.service.startRun({ taskId: task.id })).rejects.toThrow(/worktree/i);
    await expect(fs.access(worktree.worktreePath)).rejects.toThrow();
    await expect(scenario.service.prepareWorktree(createInput(task.id, base))).resolves.toMatchObject({ outcome: 'BASE_ALREADY_BOUND' });
    await expect(scenario.service.prepareWorktree({ taskId: task.id, intent: 'RECOVER' })).resolves.toMatchObject({
      outcome: 'PREPARED', worktree: { id: worktree.id, headSha: savedSha }
    });
    await expect(fs.readFile(path.join(worktree.worktreePath, 'progress.txt'), 'utf8')).resolves.toBe('saved work\n');
    await git(scenario.repositoryPath, ['worktree', 'remove', worktree.worktreePath]);
    await git(scenario.repositoryPath, ['branch', '-f', worktree.branchName, base.sha]);
    await expect(scenario.service.prepareWorktree({ taskId: task.id, intent: 'RECOVER' })).rejects.toThrow('different commit');
    await expect(fs.access(worktree.worktreePath)).rejects.toThrow();
    expect((await scenario.store.snapshot()).iterations).toHaveLength(1);
  }, 20_000);
});

function createInput(taskId: string, base: WorktreeBaseOption) {
  return { taskId, intent: 'CREATE' as const, baseRef: base.refName, expectedBaseSha: base.sha };
}
