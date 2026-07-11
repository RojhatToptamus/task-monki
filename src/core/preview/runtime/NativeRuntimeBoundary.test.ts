import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PreviewNativeProcessIdentity } from '../../../shared/contracts';
import { FileTaskStore } from '../../storage/FileTaskStore';
import { NativeJobRunner } from './NativeJobRunner';
import type { NativeLaunchInput } from './NativeLauncherHost';
import { NativeServiceRuntime } from './NativeServiceRuntime';

const fixtureRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

describe('native runtime launcher boundary evidence', () => {
  it.each(['JOB', 'SERVICE'] as const)(
    'makes the %s attempt and resource terminal when failure follows PREPARED persistence',
    async (kind) => {
      const fixture = await runtimeFixture();
      const launcher = {
        async launch(input: NativeLaunchInput) {
          const identity: PreviewNativeProcessIdentity = {
            receiptPath: input.receiptPath,
            ownershipToken: 'token',
            commandDigest: 'digest',
            launcher: {
              pid: 123,
              processGroupId: 123,
              startedAt: 'start',
              command: 'launcher token'
            }
          };
          await input.persistPrepared(identity);
          throw new Error('Injected launcher handshake failure.');
        }
      };
      const common = {
        taskId: fixture.taskId,
        generationId: fixture.generationId,
        generationRoot: fixture.generationRoot,
        sourcePath: fixture.sourcePath,
        markerDigest: 'marker'
      };
      if (kind === 'JOB') {
        await expect(
          new NativeJobRunner(fixture.store, launcher as never).run({
            ...common,
            node: { id: 'prepare', cwd: '.', command: ['node', 'prepare.mjs'], needs: {} }
          })
        ).rejects.toThrow('handshake failure');
      } else {
        await expect(
          new NativeServiceRuntime(fixture.store, launcher as never).start({
            ...common,
            node: {
              id: 'web', cwd: '.', command: ['node', 'server.mjs'], needs: {}, env: {},
              ports: { http: { env: 'PORT' } },
              ready: { type: 'http', port: 'http', path: '/ready', timeoutSeconds: 5 }
            },
            portValues: { http: 41234 }
          })
        ).rejects.toThrow('handshake failure');
      }
      const snapshot = await fixture.store.snapshot();
      const attempt = snapshot.previewNodeAttempts[0];
      const resource = snapshot.previewResources[0];
      expect(attempt.state).toBe('FAILED');
      expect(attempt.endedAt).toBeDefined();
      expect(resource.state).toBe('FAILED');
    }
  );
});

async function runtimeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-runtime-boundary-'));
  fixtureRoots.push(root);
  const sourcePath = path.join(root, 'preview', 'source');
  await fs.mkdir(sourcePath, { recursive: true });
  const store = new FileTaskStore(path.join(root, 'store'));
  const task = await store.createTask({ title: 'Boundary', prompt: 'Test', repositoryPath: root });
  const { iteration, worktree } = await store.createIterationAndWorktree({
    task, branchName: 'codex/boundary', worktreePath: root, baseSha: 'head'
  });
  const now = new Date().toISOString();
  const plan = await store.savePreviewPlan({
    id: 'plan', taskId: task.id, iterationId: iteration.id, worktreeId: worktree.id,
    recipePath: '.taskmonki/preview.yaml', recipeVersion: 1, recipeDigest: 'recipe',
    executionDigest: 'execution', executionPlan: { version: 1, jobs: [], services: [], routes: [] },
    warnings: [], createdAt: now
  });
  const approval = await store.savePreviewApproval({
    id: 'approval', taskId: task.id, planId: plan.id, executionDigest: plan.executionDigest,
    scope: 'TASK', approvedAt: now
  });
  const generation = await store.savePreviewGeneration({
    id: 'generation', previewKey: 'task-boundary', taskId: task.id, iterationId: iteration.id,
    worktreeId: worktree.id, planId: plan.id, approvalId: approval.id,
    executionDigest: plan.executionDigest, sourceGitSnapshotId: 'git', sourceHeadSha: 'head',
    sourceDirtyFingerprint: 'dirty', workspacePath: path.dirname(sourcePath), state: 'CREATED',
    freshness: 'CURRENT', routes: [], createdAt: now, updatedAt: now
  });
  return {
    root,
    store,
    taskId: task.id,
    generationId: generation.id,
    generationRoot: path.dirname(sourcePath),
    sourcePath
  };
}
