import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  CiChecksStatus,
  MergeStatus,
  TaskIteration,
  WorktreeRecord
} from '../../shared/contracts';
import { TASK_STORE_SCHEMA_VERSION } from '../../shared/contracts';
import { FileTaskStore } from './FileTaskStore';
import { createDomainEvent } from './domainEvent';

describe('FileTaskStore', () => {
  it('surfaces a crash-persisted queued run for startup recovery', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-queued-recovery-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({
      title: 'Recover queued run',
      prompt: 'Start safely.',
      repositoryPath: dir
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/queued-recovery',
      worktreePath: dir,
      baseSha: 'base'
    });
    const session = await store.createAgentSession({
      task,
      iteration,
      worktree,
      provider: 'codex'
    });
    const run = await store.createRun({
      task,
      session,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });

    expect(run.status).toBe('QUEUED');
    await expect(store.getRunsRequiringRecovery()).resolves.toEqual([]);
    await expect(
      store.getRunsRequiringRecovery({ includeQueued: true })
    ).resolves.toEqual([
      expect.objectContaining({ id: run.id, status: 'QUEUED' })
    ]);
  });

  it('persists tasks, runs, events, and artifacts', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-'));
    const store = new FileTaskStore(dir);

    const task = await store.createTask({
      title: 'Read repo',
      prompt: 'Summarize and do not write.',
      repositoryPath: dir
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/test',
      worktreePath: dir,
      baseSha: 'base'
    });
    const session = await store.createAgentSession({
      task,
      iteration,
      worktree,
      provider: 'codex'
    });
    const run = await store.createRun({
      task,
      session,
      mode: 'ANALYSIS',
      prompt: task.prompt
    });

    await store.appendArtifact(run.outputArtifactId, '{"type":"turn.started"}\n');
    const final = await store.writeFinalArtifact(task.id, run.id, '# Final\n');

    const reloaded = new FileTaskStore(dir);
    const snapshot = await reloaded.snapshot();

    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.agentSessions).toHaveLength(1);
    expect(snapshot.events.some((event) => event.type === 'TASK_CREATED')).toBe(true);
    expect(snapshot.artifacts.some((artifact) => artifact.id === final.id)).toBe(true);
    await expect(reloaded.readArtifact(final.id)).resolves.toBe('# Final\n');
  });

  it('reconciles managed artifact orphans after a published delete survives restart', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-artifact-reconcile-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({
      title: 'Artifact crash cleanup',
      prompt: 'Leave artifacts until restart can resolve publication.',
      repositoryPath: dir
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/artifact-crash-cleanup',
      worktreePath: dir,
      baseSha: 'base'
    });
    const session = await store.createAgentSession({
      task,
      iteration,
      worktree,
      provider: 'codex'
    });
    const run = await store.createRun({
      task,
      session,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });
    const final = await store.writeFinalArtifact(task.id, run.id, 'final output');
    const artifactPaths = (await store.snapshot()).artifacts
      .filter((artifact) => artifact.taskId === task.id)
      .map((artifact) => artifact.path);
    expect(artifactPaths).toContain(final.path);

    const artifactsDir = path.join(dir, 'artifacts');
    const unknownFile = path.join(artifactsDir, 'user-notes.txt');
    const unknownDirectory = path.join(artifactsDir, 'user-folder');
    const almostManaged = path.join(
      artifactsDir,
      `${task.id}-task-agent-final-not-a-managed-uuid.log`
    );
    await fs.writeFile(unknownFile, 'preserve me', 'utf8');
    await fs.mkdir(unknownDirectory);
    await fs.writeFile(almostManaged, 'also preserve me', 'utf8');

    const originalOpen = fs.open.bind(fs);
    let injectedFailure = false;
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (!injectedFailure && String(args[0]) === dir) {
        injectedFailure = true;
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(
          new Error('Injected post-publication directory sync failure.')
        );
      }
      return handle;
    });
    try {
      await store.deleteTask(task.id);
    } finally {
      open.mockRestore();
    }
    for (const artifactPath of artifactPaths) {
      await expect(fs.access(artifactPath)).resolves.toBeUndefined();
    }
    await store.close();

    const restarted = new FileTaskStore(dir);
    await restarted.snapshot();
    for (const artifactPath of artifactPaths) {
      await expect(fs.access(artifactPath)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await expect(fs.readFile(unknownFile, 'utf8')).resolves.toBe('preserve me');
    await expect(fs.readFile(almostManaged, 'utf8')).resolves.toBe('also preserve me');
    expect((await fs.stat(unknownDirectory)).isDirectory()).toBe(true);
    await restarted.close();
  });

  it.runIf(process.platform !== 'win32')(
    'fails closed on unsafe artifact entries without following or removing them',
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-artifact-unsafe-'));
      const first = new FileTaskStore(dir);
      await first.snapshot();
      await first.close();
      const outside = path.join(dir, 'outside.txt');
      await fs.writeFile(outside, 'outside', 'utf8');
      const unsafeName =
        '00000000-0000-4000-8000-000000000001-task-agent-final-' +
        '00000000-0000-4000-8000-000000000002.log';
      const unsafePath = path.join(dir, 'artifacts', unsafeName);
      await fs.symlink(outside, unsafePath);

      await expect(new FileTaskStore(dir).snapshot()).rejects.toThrow(
        'artifact directory contains an unsafe entry'
      );
      await expect(fs.readFile(outside, 'utf8')).resolves.toBe('outside');
      expect((await fs.lstat(unsafePath)).isSymbolicLink()).toBe(true);
    }
  );

  it('rejects a durable artifact record that claims a path outside the managed directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-artifact-path-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({
      title: 'Artifact path integrity',
      prompt: 'Keep artifact paths managed.',
      repositoryPath: dir
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/artifact-path-integrity',
      worktreePath: dir,
      baseSha: 'base'
    });
    const session = await store.createAgentSession({
      task,
      iteration,
      worktree,
      provider: 'codex'
    });
    await store.createRun({
      task,
      session,
      mode: 'ANALYSIS',
      prompt: task.prompt
    });
    await store.close();

    const outside = path.join(dir, 'outside-artifact.log');
    await fs.writeFile(outside, 'outside', 'utf8');
    const storePath = path.join(dir, 'store.json');
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as {
      artifacts: Array<{ path: string }>;
    };
    persisted.artifacts[0]!.path = outside;
    await fs.writeFile(storePath, `${JSON.stringify(persisted, null, 2)}\n`, {
      mode: 0o600
    });

    await expect(new FileTaskStore(dir).snapshot()).rejects.toThrow(
      'artifact path failed its managed-path integrity check'
    );
    await expect(fs.readFile(outside, 'utf8')).resolves.toBe('outside');
  });

  it('recovers queued persistence after a write failure', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-retry-'));
    const store = new FileTaskStore(dir);

    await store.createTask({
      title: 'Initial task',
      prompt: 'Seed the store.',
      repositoryPath: dir
    });

    const originalOpen = fs.open.bind(fs);
    const storeTemporaryPathPrefix = `${path.join(dir, 'store.json')}.`;
    let injectedFailure = false;
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (
        !injectedFailure &&
        String(args[0]).startsWith(storeTemporaryPathPrefix) &&
        String(args[0]).endsWith('.tmp')
      ) {
        injectedFailure = true;
        vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(
          new Error('Injected store write failure.')
        );
      }
      return handle;
    });
    try {
      await expect(
        store.createTask({
          title: 'Fails while store write is unavailable',
          prompt: 'This persist should fail.',
          repositoryPath: dir
        })
      ).rejects.toThrow('Injected store write failure');
    } finally {
      open.mockRestore();
    }

    expect(injectedFailure).toBe(true);
    expect((await store.snapshot()).tasks.map((task) => task.title)).toEqual([
      'Initial task'
    ]);
    expect(
      (await fs.readdir(dir)).filter(
        (entry) => entry.startsWith('store.json.') && entry.endsWith('.tmp')
      )
    ).toEqual([]);

    await store.createTask({
      title: 'Persists after recovery',
      prompt: 'This persist should succeed.',
      repositoryPath: dir
    });

    const reloaded = new FileTaskStore(dir);
    const snapshot = await reloaded.snapshot();
    expect(snapshot.tasks.map((task) => task.title)).toContain('Initial task');
    expect(snapshot.tasks.map((task) => task.title)).not.toContain(
      'Fails while store write is unavailable'
    );
    expect(snapshot.tasks.map((task) => task.title)).toContain('Persists after recovery');
  });

  it('validates optional task completion policy input', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-policy-input-'));
    const store = new FileTaskStore(dir);

    const manual = await store.createTask({
      title: 'Manual policy task',
      prompt: 'Keep manual completion.',
      repositoryPath: dir,
      completionPolicy: 'MANUAL'
    });

    expect(manual.completionPolicy).toBe('MANUAL');
    await expect(
      store.createTask({
        title: 'Invalid policy task',
        prompt: 'Reject bad input.',
        repositoryPath: dir,
        completionPolicy: 'NOT_A_POLICY' as never
      })
    ).rejects.toThrow('Invalid completion policy');
  });

  it('rejects malformed persisted task-creation retry metadata', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-create-key-'));
    const store = new FileTaskStore(dir);
    await store.createTask({
      title: 'Idempotent task',
      prompt: 'Persist the retry key.',
      repositoryPath: dir,
      creationToken: 'task-create-persisted-shape-0001'
    });
    await store.close();

    const storePath = path.join(dir, 'store.json');
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as {
      tasks: Array<{ creationRequestFingerprint?: string }>;
    };
    persisted.tasks[0]!.creationRequestFingerprint = 'not-a-sha256';
    await fs.writeFile(storePath, `${JSON.stringify(persisted, null, 2)}\n`);

    await expect(new FileTaskStore(dir).snapshot()).rejects.toThrow(
      'tasks contains invalid creation retry metadata'
    );
  });

  it('rejects duplicate persisted task-creation retry tokens', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-create-duplicate-'));
    const store = new FileTaskStore(dir);
    await store.createTask({
      title: 'First idempotent task',
      prompt: 'Persist the first retry key.',
      repositoryPath: dir,
      creationToken: 'task-create-persisted-first-0001'
    });
    await store.createTask({
      title: 'Second idempotent task',
      prompt: 'Persist the second retry key.',
      repositoryPath: dir,
      creationToken: 'task-create-persisted-second-0001'
    });
    await store.close();

    const storePath = path.join(dir, 'store.json');
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as {
      tasks: Array<{ creationToken?: string }>;
    };
    persisted.tasks[1]!.creationToken = persisted.tasks[0]!.creationToken;
    await fs.writeFile(storePath, `${JSON.stringify(persisted, null, 2)}\n`);

    await expect(new FileTaskStore(dir).snapshot()).rejects.toThrow(
      'tasks contains invalid creation retry metadata'
    );
  });

  it('migrates schema 8 stores by dropping the legacy testRuns collection', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-schema8-'));
    const store = new FileTaskStore(dir);
    await store.createTask({
      title: 'Existing schema 8 task',
      prompt: 'Keep this task after migration.',
      repositoryPath: dir
    });

    const storePath = path.join(dir, 'store.json');
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as Record<
      string,
      unknown
    >;
    await fs.writeFile(
      storePath,
      `${JSON.stringify(
        {
          ...persisted,
          schemaVersion: 8,
          testRuns: [{ id: 'legacy-test-run' }]
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    const migrated = await new FileTaskStore(dir).snapshot();
    expect(migrated.schemaVersion).toBe(TASK_STORE_SCHEMA_VERSION);
    expect(migrated.tasks[0]?.title).toBe('Existing schema 8 task');

    const rewritten = JSON.parse(await fs.readFile(storePath, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(rewritten.schemaVersion).toBe(TASK_STORE_SCHEMA_VERSION);
    expect(rewritten.testRuns).toBeUndefined();
  });

  it('links forked alternative tasks to their source task and run', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-fork-'));
    const store = new FileTaskStore(dir);

    const task = await store.createTask({
      title: 'Compare approaches',
      prompt: 'Implement the feature.',
      repositoryPath: dir
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/source',
      worktreePath: dir,
      baseSha: 'base'
    });
    const session = await store.createAgentSession({
      task,
      iteration,
      worktree,
      provider: 'codex'
    });
    const run = await store.createRun({
      task,
      session,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });

    const alternative = await store.createForkedAlternativeTask({
      title: 'Alternative: Compare approaches',
      prompt: 'Try another implementation.',
      repositoryPath: dir,
      sourceTaskId: task.id,
      sourceRunId: run.id
    });
    const snapshot = await store.snapshot();
    const source = snapshot.tasks.find((candidate) => candidate.id === task.id);
    const linkedAlternative = snapshot.tasks.find(
      (candidate) => candidate.id === alternative.id
    );

    expect(source?.forkedAlternativeTaskIds).toEqual([alternative.id]);
    expect(linkedAlternative?.forkedFromTaskId).toBe(task.id);
    expect(linkedAlternative?.forkedFromRunId).toBe(run.id);
    expect(
      snapshot.events.some(
        (event) =>
          event.type === 'TASK_ALTERNATIVE_CREATED' &&
          event.taskId === task.id &&
          event.runId === run.id
      )
    ).toBe(true);
  });

  it('moves only the linked task to merged completion policy when PR evidence is recorded', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-pr-policy-'));
    const store = new FileTaskStore(dir);

    const linkedTask = await store.createTask({
      title: 'Linked PR task',
      prompt: 'Open a PR for this task.',
      repositoryPath: dir
    });
    const untouchedTask = await store.createTask({
      title: 'Untouched local task',
      prompt: 'Keep this task local.',
      repositoryPath: dir
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task: linkedTask,
      branchName: 'codex/linked-pr',
      worktreePath: path.join(dir, 'linked'),
      baseSha: 'base'
    });

    await recordOpenPullRequest(store, linkedTask.id, iteration, worktree);

    const snapshot = await store.snapshot();
    const linked = snapshot.tasks.find((task) => task.id === linkedTask.id);
    const untouched = snapshot.tasks.find((task) => task.id === untouchedTask.id);
    expect(linked?.completionPolicy).toBe('MERGED');
    expect(linked?.phaseVersion).toBe(linkedTask.phaseVersion + 1);
    expect(untouched?.completionPolicy).toBe('LOCAL_ACCEPTANCE');
  });

  it('records in-progress branch publication as a request, not a failure', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-branch-pushing-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({
      title: 'Publish branch',
      prompt: 'Push the branch.',
      repositoryPath: dir
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/publish-branch',
      worktreePath: path.join(dir, 'worktree'),
      baseSha: 'base'
    });

    await store.recordBranchPublication({
      taskId: task.id,
      iterationId: iteration.id,
      worktreeId: worktree.id,
      remoteName: 'origin',
      branchName: worktree.branchName,
      remoteRef: `origin/${worktree.branchName}`,
      status: 'PUSHING'
    });

    const snapshot = await store.snapshot();
    expect(snapshot.branchPublications[0]).toMatchObject({ status: 'PUSHING' });
    expect(snapshot.tasks.find((candidate) => candidate.id === task.id)?.projection).toMatchObject({
      branchPublication: 'PUSHING'
    });
    expect(
      snapshot.events.some((event) => event.type === 'BRANCH_PUBLISH_REQUESTED')
    ).toBe(true);
    expect(snapshot.events.some((event) => event.type === 'BRANCH_PUBLISH_FAILED')).toBe(false);
  });

  it('does not downgrade stricter or manual completion policies when PR evidence refreshes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-pr-policy-preserve-'));
    const store = new FileTaskStore(dir);

    const verifiedTask = await store.createTask({
      title: 'Verified merge task',
      prompt: 'Keep verification after merge.',
      repositoryPath: dir
    });
    const manualTask = await store.createTask({
      title: 'Manual completion task',
      prompt: 'Keep manual completion.',
      repositoryPath: dir
    });
    const verifiedRecords = await store.createIterationAndWorktree({
      task: verifiedTask,
      branchName: 'codex/verified-policy',
      worktreePath: path.join(dir, 'verified'),
      baseSha: 'base'
    });
    const manualRecords = await store.createIterationAndWorktree({
      task: manualTask,
      branchName: 'codex/manual-policy',
      worktreePath: path.join(dir, 'manual'),
      baseSha: 'base'
    });

    const storePath = path.join(dir, 'store.json');
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as {
      tasks: Array<{ id: string; completionPolicy: string }>;
    };
    persisted.tasks = persisted.tasks.map((task) =>
      task.id === verifiedTask.id
        ? { ...task, completionPolicy: 'MERGED_AND_VERIFIED' }
        : task.id === manualTask.id
          ? { ...task, completionPolicy: 'MANUAL' }
          : task
    );
    await fs.writeFile(storePath, JSON.stringify(persisted, null, 2));

    const reloaded = new FileTaskStore(dir);
    await recordOpenPullRequest(
      reloaded,
      verifiedTask.id,
      verifiedRecords.iteration,
      verifiedRecords.worktree
    );
    await recordOpenPullRequest(
      reloaded,
      manualTask.id,
      manualRecords.iteration,
      manualRecords.worktree,
      83
    );

    const snapshot = await reloaded.snapshot();
    expect(snapshot.tasks.find((task) => task.id === verifiedTask.id)?.completionPolicy).toBe(
      'MERGED_AND_VERIFIED'
    );
    expect(snapshot.tasks.find((task) => task.id === manualTask.id)?.completionPolicy).toBe(
      'MANUAL'
    );
  });

  it('auto-completes only when merged PR evidence satisfies the task completion policy', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-pr-auto-done-'));
    const store = new FileTaskStore(dir);

    const mergedTask = await store.createTask({
      title: 'Merged task',
      prompt: 'Complete when merged.',
      repositoryPath: dir
    });
    const verifiedTask = await store.createTask({
      title: 'Verified task',
      prompt: 'Require checks after merge.',
      repositoryPath: dir
    });
    const verifiedStaleTask = await store.createTask({
      title: 'Verified stale task',
      prompt: 'Reject old passing checks after merge.',
      repositoryPath: dir
    });
    const verifiedPassingTask = await store.createTask({
      title: 'Verified passing task',
      prompt: 'Complete when merged checks match.',
      repositoryPath: dir
    });
    const manualTask = await store.createTask({
      title: 'Manual task',
      prompt: 'Require explicit completion.',
      repositoryPath: dir
    });
    const mergedRecords = await store.createIterationAndWorktree({
      task: mergedTask,
      branchName: 'codex/merged-task',
      worktreePath: path.join(dir, 'merged'),
      baseSha: 'base'
    });
    const verifiedRecords = await store.createIterationAndWorktree({
      task: verifiedTask,
      branchName: 'codex/verified-task',
      worktreePath: path.join(dir, 'verified'),
      baseSha: 'base'
    });
    const verifiedStaleRecords = await store.createIterationAndWorktree({
      task: verifiedStaleTask,
      branchName: 'codex/verified-stale-task',
      worktreePath: path.join(dir, 'verified-stale'),
      baseSha: 'base'
    });
    const verifiedPassingRecords = await store.createIterationAndWorktree({
      task: verifiedPassingTask,
      branchName: 'codex/verified-passing-task',
      worktreePath: path.join(dir, 'verified-passing'),
      baseSha: 'base'
    });
    const manualRecords = await store.createIterationAndWorktree({
      task: manualTask,
      branchName: 'codex/manual-task',
      worktreePath: path.join(dir, 'manual'),
      baseSha: 'base'
    });

    const storePath = path.join(dir, 'store.json');
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as {
      tasks: Array<{ id: string; completionPolicy: string }>;
    };
    persisted.tasks = persisted.tasks.map((task) =>
      task.id === verifiedTask.id ||
      task.id === verifiedStaleTask.id ||
      task.id === verifiedPassingTask.id
        ? { ...task, completionPolicy: 'MERGED_AND_VERIFIED' }
        : task.id === manualTask.id
          ? { ...task, completionPolicy: 'MANUAL' }
          : task
    );
    await fs.writeFile(storePath, JSON.stringify(persisted, null, 2));

    const reloaded = new FileTaskStore(dir);
    await recordOpenPullRequest(reloaded, mergedTask.id, mergedRecords.iteration, mergedRecords.worktree, {
      mergeStatus: 'MERGED'
    });
    await recordOpenPullRequest(
      reloaded,
      verifiedTask.id,
      verifiedRecords.iteration,
      verifiedRecords.worktree,
      { ciStatus: 'FAILING', mergeStatus: 'MERGED', pullRequestNumber: 83 }
    );
    await recordOpenPullRequest(
      reloaded,
      verifiedStaleTask.id,
      verifiedStaleRecords.iteration,
      verifiedStaleRecords.worktree,
      {
        ciStatus: 'PASSING',
        ciHeadSha: 'old-head',
        mergeHeadSha: 'merged-head',
        mergeStatus: 'MERGED',
        pullRequestNumber: 84
      }
    );
    await recordOpenPullRequest(
      reloaded,
      verifiedPassingTask.id,
      verifiedPassingRecords.iteration,
      verifiedPassingRecords.worktree,
      {
        ciStatus: 'PASSING',
        ciHeadSha: 'merged-head',
        mergeHeadSha: 'merged-head',
        mergeStatus: 'MERGED',
        pullRequestNumber: 85
      }
    );
    await recordOpenPullRequest(
      reloaded,
      manualTask.id,
      manualRecords.iteration,
      manualRecords.worktree,
      { mergeStatus: 'MERGED', pullRequestNumber: 86 }
    );

    const snapshot = await reloaded.snapshot();
    expect(snapshot.tasks.find((task) => task.id === mergedTask.id)).toMatchObject({
      completionPolicy: 'MERGED',
      workflowPhase: 'DONE',
      resolution: 'COMPLETED'
    });
    expect(snapshot.tasks.find((task) => task.id === verifiedTask.id)).toMatchObject({
      completionPolicy: 'MERGED_AND_VERIFIED',
      workflowPhase: 'READY',
      resolution: 'NONE'
    });
    expect(snapshot.tasks.find((task) => task.id === verifiedStaleTask.id)).toMatchObject({
      completionPolicy: 'MERGED_AND_VERIFIED',
      workflowPhase: 'READY',
      resolution: 'NONE'
    });
    expect(snapshot.tasks.find((task) => task.id === verifiedPassingTask.id)).toMatchObject({
      completionPolicy: 'MERGED_AND_VERIFIED',
      workflowPhase: 'DONE',
      resolution: 'COMPLETED'
    });
    expect(snapshot.tasks.find((task) => task.id === manualTask.id)).toMatchObject({
      completionPolicy: 'MANUAL',
      workflowPhase: 'READY',
      resolution: 'NONE'
    });
  });

  it('deletes only the selected task records and repairs fork links', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-delete-'));
    const store = new FileTaskStore(dir);

    const sourceTask = await store.createTask({
      title: 'Compare deletion',
      prompt: 'Build the source task.',
      repositoryPath: dir
    });
    const { iteration: sourceIteration, worktree: sourceWorktree } =
      await store.createIterationAndWorktree({
        task: sourceTask,
        branchName: 'codex/source-delete',
        worktreePath: path.join(dir, 'source'),
        baseSha: 'base'
      });
    const sourceSession = await store.createAgentSession({
      task: sourceTask,
      iteration: sourceIteration,
      worktree: sourceWorktree,
      provider: 'codex'
    });
    const sourceRun = await store.createRun({
      task: sourceTask,
      session: sourceSession,
      mode: 'IMPLEMENTATION',
      prompt: sourceTask.prompt
    });

    const alternativeTask = await store.createForkedAlternativeTask({
      title: 'Alternative: Compare deletion',
      prompt: 'Try another implementation.',
      repositoryPath: dir,
      sourceTaskId: sourceTask.id,
      sourceRunId: sourceRun.id
    });
    const { iteration: alternativeIteration, worktree: alternativeWorktree } =
      await store.createIterationAndWorktree({
        task: alternativeTask,
        branchName: 'codex/alternative-delete',
        worktreePath: path.join(dir, 'alternative'),
        baseSha: 'base'
      });
    const alternativeSession = await store.createAgentSession({
      task: alternativeTask,
      iteration: alternativeIteration,
      worktree: alternativeWorktree,
      provider: 'codex'
    });
    const alternativeRun = await store.createRun({
      task: alternativeTask,
      session: alternativeSession,
      mode: 'IMPLEMENTATION',
      prompt: alternativeTask.prompt
    });
    const finalArtifact = await store.writeFinalArtifact(
      alternativeTask.id,
      alternativeRun.id,
      'done\n'
    );
    const gitSnapshot = await store.recordGitSnapshot(
      {
        taskId: alternativeTask.id,
        iterationId: alternativeIteration.id,
        worktreeId: alternativeWorktree.id,
        worktreePath: alternativeWorktree.worktreePath,
        repoRoot: dir,
        gitCommonDir: path.join(dir, '.git'),
        headSha: 'head',
        branch: alternativeWorktree.branchName,
        baseSha: alternativeWorktree.baseSha,
        aheadCount: 0,
        behindCount: 0,
        stagedCount: 0,
        unstagedCount: 0,
        untrackedCount: 0,
        conflictedCount: 0,
        commitsAheadOfBase: 0,
        committedDiffFileCount: 0,
        workingDiffFileCount: 0,
        diffStat: '',
        dirtyFingerprint: 'clean',
        status: 'CLEAN'
      },
      ''
    );
    await store.recordGitHubPreflight({
      taskId: alternativeTask.id,
      iterationId: alternativeIteration.id,
      worktreeId: alternativeWorktree.id,
      remoteName: 'origin',
      remoteUrl: 'https://github.com/example/repo.git',
      host: 'github.com',
      owner: 'example',
      repo: 'repo',
      status: 'READY'
    });
    await store.recordBranchPublication({
      taskId: alternativeTask.id,
      iterationId: alternativeIteration.id,
      worktreeId: alternativeWorktree.id,
      remoteName: 'origin',
      branchName: alternativeWorktree.branchName,
      remoteRef: `refs/heads/${alternativeWorktree.branchName}`,
      headSha: 'head',
      status: 'PUSHED'
    });
    await store.recordPullRequestSync({
      pullRequest: {
        taskId: alternativeTask.id,
        iterationId: alternativeIteration.id,
        worktreeId: alternativeWorktree.id,
        number: 42,
        url: 'https://github.com/example/repo/pull/42',
        status: 'OPEN_DRAFT',
        headRefName: alternativeWorktree.branchName,
        headRefOid: 'head'
      },
      ci: {
        taskId: alternativeTask.id,
        iterationId: alternativeIteration.id,
        worktreeId: alternativeWorktree.id,
        pullRequestNumber: 42,
        headSha: 'head',
        status: 'PASSING',
        requiredStatus: 'PASSING',
        totalCount: 1,
        pendingCount: 0,
        passingCount: 1,
        failingCount: 0,
        skippedCount: 0,
        canceledCount: 0,
        checkDetails: []
      },
      reviews: {
        taskId: alternativeTask.id,
        iterationId: alternativeIteration.id,
        worktreeId: alternativeWorktree.id,
        pullRequestNumber: 42,
        headSha: 'head',
        status: 'APPROVED'
      },
      merge: {
        taskId: alternativeTask.id,
        iterationId: alternativeIteration.id,
        worktreeId: alternativeWorktree.id,
        pullRequestNumber: 42,
        headSha: 'head',
        status: 'MERGEABLE'
      }
    });
    const promptArtifactPath = await store.getArtifactPath(alternativeRun.promptArtifactId);
    const finalArtifactPath = await store.getArtifactPath(finalArtifact.id);
    const diffArtifactPath = await store.getArtifactPath(gitSnapshot.diffArtifactId!);

    await store.deleteTask(alternativeTask.id);

    const snapshot = await store.snapshot();
    const sourceAfterDelete = snapshot.tasks.find((task) => task.id === sourceTask.id);

    expect(snapshot.tasks.some((task) => task.id === alternativeTask.id)).toBe(false);
    expect(sourceAfterDelete).toBeDefined();
    expect(sourceAfterDelete?.forkedAlternativeTaskIds).not.toContain(alternativeTask.id);
    expect(snapshot.runs.some((run) => run.taskId === alternativeTask.id)).toBe(false);
    expect(snapshot.iterations.some((iteration) => iteration.taskId === alternativeTask.id)).toBe(
      false
    );
    expect(snapshot.worktrees.some((worktree) => worktree.taskId === alternativeTask.id)).toBe(
      false
    );
    expect(snapshot.gitSnapshots.some((record) => record.taskId === alternativeTask.id)).toBe(
      false
    );
    expect(snapshot.githubRepositories.some((record) => record.taskId === alternativeTask.id)).toBe(
      false
    );
    expect(snapshot.branchPublications.some((record) => record.taskId === alternativeTask.id)).toBe(
      false
    );
    expect(snapshot.pullRequests.some((record) => record.taskId === alternativeTask.id)).toBe(false);
    expect(snapshot.ciRollups.some((record) => record.taskId === alternativeTask.id)).toBe(false);
    expect(snapshot.reviewRollups.some((record) => record.taskId === alternativeTask.id)).toBe(
      false
    );
    expect(snapshot.mergeSnapshots.some((record) => record.taskId === alternativeTask.id)).toBe(
      false
    );
    expect(snapshot.agentSessions.some((session) => session.taskId === alternativeTask.id)).toBe(false);
    expect(snapshot.events.some((event) => event.taskId === alternativeTask.id)).toBe(false);
    expect(snapshot.artifacts.some((artifact) => artifact.taskId === alternativeTask.id)).toBe(false);
    expect(
      snapshot.events.some(
        (event) =>
          event.taskId === sourceTask.id &&
          typeof event.payload === 'object' &&
          event.payload !== null &&
          !Array.isArray(event.payload) &&
          (event.payload as { alternativeTaskId?: string }).alternativeTaskId === alternativeTask.id
      )
    ).toBe(true);
    await expect(fs.access(promptArtifactPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(finalArtifactPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(diffArtifactPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not delete fork alternatives when deleting their source task', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-delete-source-'));
    const store = new FileTaskStore(dir);

    const sourceTask = await store.createTask({
      title: 'Source delete',
      prompt: 'Build the original task.',
      repositoryPath: dir
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task: sourceTask,
      branchName: 'codex/delete-source',
      worktreePath: path.join(dir, 'source'),
      baseSha: 'base'
    });
    const session = await store.createAgentSession({
      task: sourceTask,
      iteration,
      worktree,
      provider: 'codex'
    });
    const run = await store.createRun({
      task: sourceTask,
      session,
      mode: 'IMPLEMENTATION',
      prompt: sourceTask.prompt
    });
    const alternativeTask = await store.createForkedAlternativeTask({
      title: 'Alternative: Source delete',
      prompt: 'Keep this alternative.',
      repositoryPath: dir,
      sourceTaskId: sourceTask.id,
      sourceRunId: run.id
    });

    await store.deleteTask(sourceTask.id);

    const snapshot = await store.snapshot();
    const alternativeAfterDelete = snapshot.tasks.find(
      (candidate) => candidate.id === alternativeTask.id
    );

    expect(snapshot.tasks.some((candidate) => candidate.id === sourceTask.id)).toBe(false);
    expect(alternativeAfterDelete).toBeDefined();
    expect(alternativeAfterDelete?.forkedFromTaskId).toBeUndefined();
    expect(alternativeAfterDelete?.forkedFromRunId).toBeUndefined();
  });

  it('repairs schema-current task records missing alternative ids', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-store-repair-'));
    const store = new FileTaskStore(dir);

    const task = await store.createTask({
      title: 'Repair task shape',
      prompt: 'Keep current records loadable.',
      repositoryPath: dir
    });
    const storePath = path.join(dir, 'store.json');
    const raw = JSON.parse(await fs.readFile(storePath, 'utf8'));
    raw.tasks = raw.tasks.map((candidate: any) => {
      if (candidate.id !== task.id) {
        return candidate;
      }
      const withoutAlternatives = { ...candidate };
      delete withoutAlternatives.forkedAlternativeTaskIds;
      return withoutAlternatives;
    });
    await fs.writeFile(storePath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

    const repaired = await new FileTaskStore(dir).snapshot();
    expect(repaired.tasks[0]?.forkedAlternativeTaskIds).toEqual([]);
  });

  it('preserves structured terminal review status when reloading', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-review-status-'));
    const store = new FileTaskStore(dir);

    const task = await store.createTask({
      title: 'Keep review verdict',
      prompt: 'Render passed review actions.',
      repositoryPath: dir
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/review-verdict',
      worktreePath: dir,
      baseSha: 'base'
    });
    const implementationSession = await store.createAgentSession({
      task,
      iteration,
      worktree,
      provider: 'codex'
    });
    const implementationRun = await store.createRun({
      task,
      session: implementationSession,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });
    await store.appendEvent(
      createDomainEvent({
        type: 'AGENT_RUN_COMPLETED',
        taskId: task.id,
        iterationId: iteration.id,
        runId: implementationRun.id,
        worktreeId: worktree.id,
        agentSessionId: implementationSession.id,
        source: 'provider',
        payload: { terminalReason: 'completed' }
      })
    );

    const reviewTask = (await store.getTask(task.id))!;
    const reviewSession = await store.createAgentSession({
      task: reviewTask,
      iteration,
      worktree,
      provider: 'codex',
      role: 'REVIEW',
      parentSessionId: implementationSession.id,
      forkedFromSessionId: implementationSession.id
    });
    const reviewRun = await store.createRun({
      task: reviewTask,
      session: reviewSession,
      mode: 'REVIEW',
      prompt: 'Review current changes.',
      continuedFromRunId: implementationRun.id
    });
    await store.appendEvent(
      createDomainEvent({
        type: 'AGENT_RUN_COMPLETED',
        taskId: task.id,
        iterationId: iteration.id,
        runId: reviewRun.id,
        worktreeId: worktree.id,
        agentSessionId: reviewSession.id,
        source: 'provider',
        payload: {
          mode: 'REVIEW',
          codexReviewResult: {
            schemaVersion: 'codex-review/v1',
            verdict: 'PASSED',
            summary: 'No blocking issues found.',
            findings: []
          }
        }
      })
    );

    expect((await store.getTask(task.id))?.projection.codexReview?.status).toBe('PASSED');
    const reloadedTask = (await new FileTaskStore(dir).getTask(task.id))!;
    expect(reloadedTask.projection.codexReview?.status).toBe('PASSED');
    expect(reloadedTask.projection.codexReview?.result?.verdict).toBe('PASSED');
  });

  it('keeps detached review runs inside the review workflow phase', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-review-store-'));
    const store = new FileTaskStore(dir);

    const task = await store.createTask({
      title: 'Review flow',
      prompt: 'Implement and review.',
      repositoryPath: dir
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/review-flow',
      worktreePath: dir,
      baseSha: 'base'
    });
    const implementationSession = await store.createAgentSession({
      task,
      iteration,
      worktree,
      provider: 'codex'
    });
    const implementationRun = await store.createRun({
      task,
      session: implementationSession,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });

    await store.transitionTask(task.id, 'REVIEW', 'implementation complete');
    const reviewTask = (await store.getTask(task.id))!;
    const reviewSession = await store.createAgentSession({
      task: reviewTask,
      iteration,
      worktree,
      provider: 'codex',
      role: 'REVIEW',
      parentSessionId: implementationSession.id,
      forkedFromSessionId: implementationSession.id
    });
    const reviewRun = await store.createRun({
      task: reviewTask,
      session: reviewSession,
      mode: 'REVIEW',
      prompt: 'Review current changes.',
      continuedFromRunId: implementationRun.id
    });

    const storedTask = (await store.getTask(task.id))!;
    expect(storedTask.workflowPhase).toBe('REVIEW');
    expect(storedTask.currentRunId).toBe(implementationRun.id);
    expect(storedTask.projection.codexReview?.status).toBe('RUNNING');
    expect(storedTask.projection.codexReview?.runId).toBe(reviewRun.id);
  });

  it('repairs persisted active review runs that were incorrectly moved to in progress', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-review-repair-'));
    const store = new FileTaskStore(dir);

    const task = await store.createTask({
      title: 'Repair review flow',
      prompt: 'Implement and review.',
      repositoryPath: dir
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/review-repair',
      worktreePath: dir,
      baseSha: 'base'
    });
    const implementationSession = await store.createAgentSession({
      task,
      iteration,
      worktree,
      provider: 'codex'
    });
    const implementationRun = await store.createRun({
      task,
      session: implementationSession,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });
    await store.transitionTask(task.id, 'REVIEW', 'implementation complete');
    const reviewTask = (await store.getTask(task.id))!;
    const reviewSession = await store.createAgentSession({
      task: reviewTask,
      iteration,
      worktree,
      provider: 'codex',
      role: 'REVIEW',
      parentSessionId: implementationSession.id,
      forkedFromSessionId: implementationSession.id
    });
    const reviewRun = await store.createRun({
      task: reviewTask,
      session: reviewSession,
      mode: 'REVIEW',
      prompt: 'Review current changes.',
      continuedFromRunId: implementationRun.id
    });

    const storePath = path.join(dir, 'store.json');
    const raw = JSON.parse(await fs.readFile(storePath, 'utf8'));
    raw.runs = raw.runs.map((candidate: any) =>
      candidate.id === implementationRun.id
        ? {
            ...candidate,
            status: 'COMPLETED'
          }
        : candidate.id === reviewRun.id
          ? {
              ...candidate,
              status: 'RUNNING'
            }
        : candidate
    );
    raw.tasks = raw.tasks.map((candidate: any) =>
      candidate.id === task.id
        ? {
            ...candidate,
            currentRunId: reviewRun.id,
            currentAgentSessionId: reviewSession.id,
            workflowPhase: 'IN_PROGRESS',
            projection: {
              ...candidate.projection,
              agentRun: 'RUNNING',
              codexReview: undefined
            }
          }
        : candidate
    );
    await fs.writeFile(storePath, `${JSON.stringify(raw, null, 2)}\n`);

    const repaired = await new FileTaskStore(dir).snapshot();
    const repairedTask = repaired.tasks.find((candidate) => candidate.id === task.id);
    expect(repairedTask?.workflowPhase).toBe('REVIEW');
    expect(repairedTask?.currentRunId).toBe(implementationRun.id);
    expect(repairedTask?.projection.agentRun).toBe('COMPLETED');
    expect(repairedTask?.projection.codexReview?.status).toBe('RUNNING');
    expect(repairedTask?.projection.codexReview?.runId).toBe(reviewRun.id);
  });

  it('repairs interrupting reviews whose provider session is already idle', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-manager-review-idle-repair-')
    );
    const store = new FileTaskStore(dir);

    const task = await store.createTask({
      title: 'Repair idle review',
      prompt: 'Implement and review.',
      repositoryPath: dir
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/review-idle-repair',
      worktreePath: dir,
      baseSha: 'base'
    });
    const implementationSession = await store.createAgentSession({
      task,
      iteration,
      worktree,
      provider: 'codex'
    });
    const implementationRun = await store.createRun({
      task,
      session: implementationSession,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });
    await store.transitionTask(task.id, 'REVIEW', 'implementation complete');
    const reviewTask = (await store.getTask(task.id))!;
    const reviewSession = await store.createAgentSession({
      task: reviewTask,
      iteration,
      worktree,
      provider: 'codex',
      role: 'REVIEW',
      parentSessionId: implementationSession.id,
      forkedFromSessionId: implementationSession.id
    });
    const reviewRun = await store.createRun({
      task: reviewTask,
      session: reviewSession,
      mode: 'REVIEW',
      prompt: 'Review current changes.',
      continuedFromRunId: implementationRun.id
    });

    const storePath = path.join(dir, 'store.json');
    const raw = JSON.parse(await fs.readFile(storePath, 'utf8'));
    raw.agentSessions = raw.agentSessions.map((candidate: any) =>
      candidate.id === reviewSession.id
        ? {
            ...candidate,
            status: 'IDLE'
          }
        : candidate
    );
    raw.runs = raw.runs.map((candidate: any) =>
      candidate.id === reviewRun.id
        ? {
            ...candidate,
            status: 'INTERRUPTING'
          }
        : candidate.id === implementationRun.id
          ? {
              ...candidate,
              status: 'COMPLETED'
            }
          : candidate
    );
    raw.tasks = raw.tasks.map((candidate: any) =>
      candidate.id === task.id
        ? {
            ...candidate,
            currentRunId: reviewRun.id,
            currentAgentSessionId: reviewSession.id,
            workflowPhase: 'REVIEW',
            projection: {
              ...candidate.projection,
              agentRun: 'COMPLETED',
              codexReview: {
                status: 'RUNNING',
                runId: reviewRun.id,
                summary: 'Codex is reviewing the current diff.',
                updatedAt: candidate.updatedAt
              }
            }
          }
        : candidate
    );
    await fs.writeFile(storePath, `${JSON.stringify(raw, null, 2)}\n`);

    const repaired = await new FileTaskStore(dir).snapshot();
    const repairedTask = repaired.tasks.find((candidate) => candidate.id === task.id);
    const repairedReviewRun = repaired.runs.find(
      (candidate) => candidate.id === reviewRun.id
    );
    expect(repairedReviewRun?.status).toBe('INTERRUPTED');
    expect(repairedReviewRun?.recoveryState).toBe('NONE');
    expect(repairedTask?.workflowPhase).toBe('REVIEW');
    expect(repairedTask?.currentRunId).toBe(implementationRun.id);
    expect(repairedTask?.projection.agentRun).toBe('COMPLETED');
    expect(repairedTask?.projection.codexReview?.status).toBe('CANCELED');
    expect(repairedTask?.projection.codexReview?.summary).toBe(
      'Codex review was stopped before completion.'
    );
  });

  it('repairs running reviews whose provider session is already idle', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-manager-review-running-idle-repair-')
    );
    const store = new FileTaskStore(dir);

    const task = await store.createTask({
      title: 'Repair completed but unfinalized review',
      prompt: 'Implement and review.',
      repositoryPath: dir
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/review-running-idle-repair',
      worktreePath: dir,
      baseSha: 'base'
    });
    const implementationSession = await store.createAgentSession({
      task,
      iteration,
      worktree,
      provider: 'codex'
    });
    const implementationRun = await store.createRun({
      task,
      session: implementationSession,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });
    await store.transitionTask(task.id, 'REVIEW', 'implementation complete');
    const reviewTask = (await store.getTask(task.id))!;
    const reviewSession = await store.createAgentSession({
      task: reviewTask,
      iteration,
      worktree,
      provider: 'codex',
      role: 'REVIEW',
      parentSessionId: implementationSession.id,
      forkedFromSessionId: implementationSession.id
    });
    const reviewRun = await store.createRun({
      task: reviewTask,
      session: reviewSession,
      mode: 'REVIEW',
      prompt: 'Review current changes.',
      continuedFromRunId: implementationRun.id
    });

    const storePath = path.join(dir, 'store.json');
    const raw = JSON.parse(await fs.readFile(storePath, 'utf8'));
    raw.agentSessions = raw.agentSessions.map((candidate: any) =>
      candidate.id === reviewSession.id
        ? {
            ...candidate,
            status: 'IDLE'
          }
        : candidate
    );
    raw.runs = raw.runs.map((candidate: any) =>
      candidate.id === implementationRun.id
        ? {
            ...candidate,
            status: 'COMPLETED'
          }
        : candidate.id === reviewRun.id
          ? {
              ...candidate,
              status: 'RUNNING'
            }
        : candidate
    );
    raw.tasks = raw.tasks.map((candidate: any) =>
      candidate.id === task.id
        ? {
            ...candidate,
            projection: {
              ...candidate.projection,
              agentRun: 'COMPLETED',
              codexReview: {
                status: 'RUNNING',
                runId: reviewRun.id,
                summary: 'Codex is reviewing the current diff.',
                updatedAt: candidate.updatedAt
              }
            }
          }
        : candidate
    );
    await fs.writeFile(storePath, `${JSON.stringify(raw, null, 2)}\n`);

    const repaired = await new FileTaskStore(dir).snapshot();
    const repairedTask = repaired.tasks.find((candidate) => candidate.id === task.id);
    const repairedReviewRun = repaired.runs.find(
      (candidate) => candidate.id === reviewRun.id
    );
    expect(repairedReviewRun?.status).toBe('RECOVERY_REQUIRED');
    expect(repairedReviewRun?.recoveryState).toBe('REQUIRES_USER_ACTION');
    expect(repairedTask?.workflowPhase).toBe('REVIEW');
    expect(repairedTask?.currentRunId).toBe(implementationRun.id);
    expect(repairedTask?.projection.agentRun).toBe('COMPLETED');
    expect(repairedTask?.projection.codexReview?.status).toBe('FAILED');
    expect(repairedTask?.projection.codexReview?.summary).toBe(
      'Codex review stopped sending updates before Task Monki received a terminal event.'
    );
  });

  it('repairs persisted completed review results with structured findings', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-manager-review-result-repair-'));
    const store = new FileTaskStore(dir);

    const task = await store.createTask({
      title: 'Repair completed review result',
      prompt: 'Implement and review.',
      repositoryPath: dir
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/review-result-repair',
      worktreePath: dir,
      baseSha: 'base'
    });
    const implementationSession = await store.createAgentSession({
      task,
      iteration,
      worktree,
      provider: 'codex'
    });
    const implementationRun = await store.createRun({
      task,
      session: implementationSession,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });
    await store.transitionTask(task.id, 'REVIEW', 'implementation complete');
    const reviewTask = (await store.getTask(task.id))!;
    const reviewSession = await store.createAgentSession({
      task: reviewTask,
      iteration,
      worktree,
      provider: 'codex',
      role: 'REVIEW',
      parentSessionId: implementationSession.id,
      forkedFromSessionId: implementationSession.id
    });
    const reviewRun = await store.createRun({
      task: reviewTask,
      session: reviewSession,
      mode: 'REVIEW',
      prompt: 'Review current changes.',
      continuedFromRunId: implementationRun.id
    });

    const finalMessage = `Review found a blocker.

\`\`\`json
{
  "schemaVersion": "codex-review/v1",
  "verdict": "NEEDS_CHANGES",
  "summary": "A keyboard shortcut listener leaks.",
  "findings": [
    {
      "id": "listener-leak",
      "severity": "BLOCKER",
      "title": "Listener is not cleaned up",
      "explanation": "The listener is added repeatedly.",
      "path": "src/renderer/ui/App.tsx",
      "line": 42
    }
  ]
}
\`\`\``;
    const storePath = path.join(dir, 'store.json');
    const raw = JSON.parse(await fs.readFile(storePath, 'utf8'));
    raw.runs = raw.runs.map((candidate: any) =>
      candidate.id === reviewRun.id
        ? {
            ...candidate,
            status: 'COMPLETED',
            finalMessage
          }
        : candidate.id === implementationRun.id
          ? {
              ...candidate,
              status: 'COMPLETED'
            }
        : candidate
    );
    raw.tasks = raw.tasks.map((candidate: any) =>
      candidate.id === task.id
        ? {
            ...candidate,
            currentRunId: reviewRun.id,
            currentAgentSessionId: reviewSession.id,
            workflowPhase: 'IN_PROGRESS',
            projection: {
              ...candidate.projection,
              agentRun: 'RUNNING',
              codexReview: undefined
            }
          }
        : candidate
    );
    await fs.writeFile(storePath, `${JSON.stringify(raw, null, 2)}\n`);

    const repaired = await new FileTaskStore(dir).snapshot();
    const repairedTask = repaired.tasks.find((candidate) => candidate.id === task.id);
    expect(repairedTask?.workflowPhase).toBe('REVIEW');
    expect(repairedTask?.currentRunId).toBe(implementationRun.id);
    expect(repairedTask?.projection.agentRun).toBe('COMPLETED');
    expect(repairedTask?.projection.codexReview?.status).toBe('NEEDS_CHANGES');
    expect(repairedTask?.projection.codexReview?.summary).toBe(
      'A keyboard shortcut listener leaks.'
    );
    expect(repairedTask?.projection.codexReview?.result?.findings[0]?.id).toBe(
      'listener-leak'
    );
  });

  it('repairs persisted completed review results with native Codex review comments', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-manager-native-review-result-repair-')
    );
    const store = new FileTaskStore(dir);

    const task = await store.createTask({
      title: 'Repair native review result',
      prompt: 'Implement and review.',
      repositoryPath: dir
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/native-review-result-repair',
      worktreePath: dir,
      baseSha: 'base'
    });
    const implementationSession = await store.createAgentSession({
      task,
      iteration,
      worktree,
      provider: 'codex'
    });
    const implementationRun = await store.createRun({
      task,
      session: implementationSession,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });
    await store.transitionTask(task.id, 'REVIEW', 'implementation complete');
    const reviewTask = (await store.getTask(task.id))!;
    const reviewSession = await store.createAgentSession({
      task: reviewTask,
      iteration,
      worktree,
      provider: 'codex',
      role: 'REVIEW',
      parentSessionId: implementationSession.id,
      forkedFromSessionId: implementationSession.id
    });
    const reviewRun = await store.createRun({
      task: reviewTask,
      session: reviewSession,
      mode: 'REVIEW',
      prompt: 'Review current changes.',
      continuedFromRunId: implementationRun.id
    });

    const finalMessage = `The patch introduces review-flow regressions that can bypass the review gate.

Full review comments:

- [P2] Pause source-run controls while reviews run — ${dir}/src/renderer/ui/AgentControlPanel.tsx:44-45
  The selected run remains the completed implementation run while a detached review is running.

- [P3] Allow change requests from unstructured reviews — ${dir}/src/renderer/ui/taskView.ts:96-99
  The predicate hides Request changes even though the drawer can build a follow-up from raw output.
`;
    const storePath = path.join(dir, 'store.json');
    const raw = JSON.parse(await fs.readFile(storePath, 'utf8'));
    raw.runs = raw.runs.map((candidate: any) =>
      candidate.id === reviewRun.id
        ? {
            ...candidate,
            status: 'COMPLETED',
            finalMessage
          }
        : candidate.id === implementationRun.id
          ? {
              ...candidate,
              status: 'COMPLETED'
            }
          : candidate
    );
    raw.tasks = raw.tasks.map((candidate: any) =>
      candidate.id === task.id
        ? {
            ...candidate,
            currentRunId: reviewRun.id,
            currentAgentSessionId: reviewSession.id,
            workflowPhase: 'REVIEW',
            projection: {
              ...candidate.projection,
              agentRun: 'COMPLETED',
              codexReview: {
                status: 'INCONCLUSIVE',
                runId: reviewRun.id,
                sourceRunId: implementationRun.id,
                summary: 'Codex review completed, but no structured pass/fail verdict was provided.',
                updatedAt: candidate.updatedAt
              }
            }
          }
        : candidate
    );
    await fs.writeFile(storePath, `${JSON.stringify(raw, null, 2)}\n`);

    const repaired = await new FileTaskStore(dir).snapshot();
    const repairedTask = repaired.tasks.find((candidate) => candidate.id === task.id);
    expect(repairedTask?.workflowPhase).toBe('REVIEW');
    expect(repairedTask?.currentRunId).toBe(implementationRun.id);
    expect(repairedTask?.projection.agentRun).toBe('COMPLETED');
    expect(repairedTask?.projection.codexReview?.status).toBe('NEEDS_CHANGES');
    expect(repairedTask?.projection.codexReview?.summary).toBe(
      'The patch introduces review-flow regressions that can bypass the review gate.'
    );
    expect(repairedTask?.projection.codexReview?.result?.findings).toHaveLength(2);
    expect(repairedTask?.projection.codexReview?.result?.findings[0]).toMatchObject({
      severity: 'MAJOR',
      title: 'Pause source-run controls while reviews run',
      path: 'src/renderer/ui/AgentControlPanel.tsx',
      line: 44,
      endLine: 45
    });
  });
});

async function recordOpenPullRequest(
  store: FileTaskStore,
  taskId: string,
  iteration: TaskIteration,
  worktree: WorktreeRecord,
  options: number | {
    ciStatus?: CiChecksStatus;
    ciHeadSha?: string;
    mergeStatus?: MergeStatus;
    mergeHeadSha?: string;
    pullRequestHeadSha?: string;
    pullRequestNumber?: number;
  } = 82
): Promise<void> {
  const pullRequestNumber =
    typeof options === 'number' ? options : options.pullRequestNumber ?? 82;
  const ciStatus = typeof options === 'number' ? 'PASSING' : options.ciStatus ?? 'PASSING';
  const ciHeadSha = typeof options === 'number' ? 'head' : options.ciHeadSha ?? 'head';
  const mergeStatus = typeof options === 'number' ? 'MERGEABLE' : options.mergeStatus ?? 'MERGEABLE';
  const mergeHeadSha = typeof options === 'number' ? 'head' : options.mergeHeadSha ?? 'head';
  const pullRequestHeadSha =
    typeof options === 'number' ? 'head' : options.pullRequestHeadSha ?? mergeHeadSha;
  await store.recordPullRequestSync({
    pullRequest: {
      taskId,
      iterationId: iteration.id,
      worktreeId: worktree.id,
      number: pullRequestNumber,
      url: `https://github.com/example/repo/pull/${pullRequestNumber}`,
      status: 'OPEN_READY',
      state: 'OPEN',
      isDraft: false,
      headRefName: worktree.branchName,
      headRefOid: pullRequestHeadSha,
      baseRefName: 'main'
    },
    ci: {
      taskId,
      iterationId: iteration.id,
      worktreeId: worktree.id,
      pullRequestNumber,
      headSha: ciHeadSha,
      status: ciStatus,
      requiredStatus: 'PASSING',
      totalCount: 1,
      pendingCount: 0,
      passingCount: ciStatus === 'PASSING' ? 1 : 0,
      failingCount: ciStatus === 'FAILING' || ciStatus === 'BLOCKED' ? 1 : 0,
      skippedCount: 0,
      canceledCount: 0,
      checkDetails: []
    },
    reviews: {
      taskId,
      iterationId: iteration.id,
      worktreeId: worktree.id,
      pullRequestNumber,
      headSha: 'head',
      status: 'NOT_REQUESTED'
    },
    merge: {
      taskId,
      iterationId: iteration.id,
      worktreeId: worktree.id,
      pullRequestNumber,
      headSha: mergeHeadSha,
      status: mergeStatus
    }
  });
}
