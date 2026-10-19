import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { openTestPersistence } from '../../../testSupport/persistenceFixture';
import { addTestRepository } from '../../../testSupport/repositoryFixture';
import {
  at,
  attempt,
  bugCaseRecord,
  captureRecord,
  keptApprovalRecord,
  reproducedQualification,
  versionRecord
} from '../../../testSupport/bugReplay/bugReplayFixtures';
import { KEPT_APPROVALS_PER_REPOSITORY } from './SqliteBugReplayStore';

async function openProfile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bug-replay-store-'));
  onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));
  const persistence = await openTestPersistence(path.join(dir, 'profile'));
  const repository = await addTestRepository(persistence.tasks, dir);
  const task = await persistence.tasks.createTask({ title: 'Checkout total', prompt: 'Fix the coupon total.', repositoryId: repository.id });
  return { persistence, store: persistence.bugReplay, task, dir };
}

/** A recorded, reproduced and verified bug of `taskId`, with one screenshot from the recording. */
async function seedBug(profile: Awaited<ReturnType<typeof openProfile>>) {
  const { store, task } = profile;
  const taskId = task.id;
  const capture = captureRecord({ taskId });
  const bugCase = bugCaseRecord({ taskId });
  const version = versionRecord({ taskId });
  const runs = [...reproducedQualification(), ...attempt('attempt-1', 'tree-fix', ['PASSED', 'PASSED'], 10)].map((run) => ({ ...run, taskId }));
  const screenshot = await store.publishFile({ taskId, ownerKind: 'CAPTURE', ownerId: capture.id, kind: 'SCREENSHOT', mediaType: 'image/png', bytes: new Uint8Array(2048) });
  const runLog = await store.publishFile({ taskId, ownerKind: 'RUN', ownerId: runs[2].id, kind: 'RUN_FRAMES', mediaType: 'application/json', bytes: new TextEncoder().encode('[]') });
  await store.write((tx) => {
    store.insertCapture(tx, capture);
    store.insertCase(tx, bugCase);
    store.insertVersion(tx, version);
    store.insertDecision(tx, { id: 'decision-1', caseId: bugCase.id, taskId, kind: 'APPROVED', versionId: version.id, createdAt: version.createdAt });
    for (const run of runs) store.insertRun(tx, run);
    store.recordFile(tx, screenshot);
    store.recordFile(tx, runLog);
  });
  return { capture, bugCase, version, runs, files: [screenshot, runLog] };
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false);
}

describe('Bug Replay store', () => {
  it('keeps a bug, its versions and runs, and refuses an update from a stale read', async () => {
    const profile = await openProfile();
    const { bugCase, version, runs } = await seedBug(profile);
    const { store } = profile;

    const read = await store.read((reader) => ({
      active: store.activeCase(reader, profile.task.id),
      versions: store.listVersions(reader, bugCase.id),
      runs: store.listRuns(reader, { caseId: bugCase.id }),
      attempt: store.listRuns(reader, { setId: 'attempt-1' }),
      tasks: store.tasksWithActiveCases(reader)
    }));
    expect(read.active).toEqual(bugCase);
    expect(read.versions).toEqual([version]);
    expect(read.runs.map((run) => run.id)).toEqual([...runs].reverse().map((run) => run.id));
    expect(read.attempt).toHaveLength(2);
    expect(read.tasks).toEqual([profile.task.id]);

    await store.write((tx) => store.updateCase(tx, { ...bugCase, title: 'Coupon total is $5 off' }, bugCase.revision));
    // A second writer that read the old revision must not overwrite the first.
    await expect(store.write((tx) => store.updateCase(tx, { ...bugCase, status: 'REMOVED' }, bugCase.revision))).rejects.toThrow('The bug changed while it was being saved.');
    expect((await store.read((reader) => store.getCase(reader, bugCase.id)))?.title).toBe('Coupon total is $5 off');
  });

  it('accounts for evidence per bug and frees it when deleted', async () => {
    const profile = await openProfile();
    const { capture, bugCase, files } = await seedBug(profile);
    const { store } = profile;
    const bytes = files.reduce((sum, file) => sum + file.byteCount, 0);

    expect(await store.read((reader) => store.bytesForCase(reader, bugCase.id, capture.id))).toBe(bytes);
    expect(await store.read((reader) => store.usedBytes(reader))).toBe(bytes);
    expect(await store.readFile(files[0])).toHaveLength(2048);

    await store.write((tx) => store.deleteFiles(tx, files));
    expect(await store.read((reader) => store.bytesForCase(reader, bugCase.id, capture.id))).toBe(0);
    expect(await store.read((reader) => store.usedBytes(reader))).toBe(0);
    await expect(store.readFile(files[0])).rejects.toThrow();
  });

  it('removes bytes published for a write that did not commit', async () => {
    const profile = await openProfile();
    const { store, task, persistence } = profile;
    const file = await store.publishFile({ taskId: task.id, ownerKind: 'CAPTURE', ownerId: 'capture-x', kind: 'SCREENSHOT', mediaType: 'image/png', bytes: new Uint8Array(16) });
    const onDisk = path.join(persistence.paths.managedFilesRoot, file.storageKey);
    expect(await exists(onDisk)).toBe(true);

    await expect(store.write((tx) => {
      store.recordFile(tx, file);
      throw new Error('The capture failed to save');
    })).rejects.toThrow('The capture failed to save');

    await expect.poll(() => exists(onDisk)).toBe(false);
  });

  it('keeps a replay approval for its repository across restarts, once per recipe, until it is revoked', async () => {
    const profile = await openProfile();
    const profileRoot = path.join(profile.dir, 'profile');
    const repositoryId = profile.task.repositoryId;
    const approval = keptApprovalRecord({ repositoryId });
    expect(await profile.store.write((tx) => profile.store.keepApproval(tx, approval))).toEqual({ approval, released: [] });
    // Keeping the same recipe again keeps the first approval, not a second row.
    const again = await profile.store.write((tx) => profile.store.keepApproval(tx, keptApprovalRecord({ repositoryId, id: '0b9e8d7c-6f5a-4e3d-8c2b-1a0f9e8d7c6b', keptAt: at(5) })));
    expect(again.approval).toEqual(approval);

    // Task Monki quits and starts again: the approval is read back for its repository and recipe.
    await profile.persistence.close();
    const restarted = await openTestPersistence(profileRoot);
    expect(await restarted.bugReplay.read((reader) => ({
      kept: restarted.bugReplay.keptApproval(reader, repositoryId, approval.approvalDigest),
      otherRecipe: restarted.bugReplay.keptApproval(reader, repositoryId, 'b'.repeat(64)),
      otherRepository: restarted.bugReplay.keptApproval(reader, 'repository-2', approval.approvalDigest),
      all: restarted.bugReplay.listKeptApprovals(reader)
    }))).toEqual({ kept: approval, otherRecipe: undefined, otherRepository: undefined, all: [approval] });

    // Revoked, it stays gone after the next start too.
    expect(await restarted.bugReplay.write((tx) => restarted.bugReplay.revokeApproval(tx, approval.id))).toBe(true);
    await restarted.close();
    const later = await openTestPersistence(profileRoot);
    expect(await later.bugReplay.read((reader) => ({
      kept: later.bugReplay.keptApproval(reader, repositoryId, approval.approvalDigest),
      any: later.bugReplay.hasKeptApprovals(reader, repositoryId)
    }))).toEqual({ kept: undefined, any: false });
  });

  it('lets a repository’s oldest approvals go, never the one just kept', async () => {
    const profile = await openProfile();
    const { store } = profile;
    const repositoryId = profile.task.repositoryId;
    const kept = Array.from({ length: KEPT_APPROVALS_PER_REPOSITORY + 1 }, (_, index) => keptApprovalRecord({
      repositoryId,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      approvalDigest: index.toString(16).padStart(64, '0'),
      keptAt: at(index)
    }));
    const released: string[] = [];
    for (const approval of kept) released.push(...(await store.write((tx) => store.keepApproval(tx, approval))).released);

    expect(released).toEqual([kept[0].id]);
    const left = await store.read((reader) => store.listKeptApprovals(reader));
    expect(left.map((approval) => approval.id)).toEqual(kept.slice(1).reverse().map((approval) => approval.id));
  });

  it('leaves nothing of a bug behind when its task is deleted', async () => {
    const profile = await openProfile();
    const { files } = await seedBug(profile);
    const { store, task, persistence } = profile;
    const paths = files.map((file) => path.join(persistence.paths.managedFilesRoot, file.storageKey));

    await persistence.tasks.deleteTask(task.id);

    const rows = await persistence.database.read((reader) =>
      ['bug_captures', 'bug_cases', 'bug_case_versions', 'bug_case_decisions', 'bug_replay_runs', 'bug_replay_files']
        .map((table) => reader.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)?.count ?? -1)
    );
    expect(rows).toEqual([0, 0, 0, 0, 0, 0]);
    expect(await store.read((reader) => store.usedBytes(reader))).toBe(0);
    for (const file of paths) await expect.poll(() => exists(file)).toBe(false);
  });
});
