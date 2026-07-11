import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createInitialProjection } from '../../shared/contracts';
import { PreviewPlanResolver } from './PreviewPlanResolver';
import { parsePreviewRecipe } from './PreviewRecipeLoader';

describe('PreviewPlanResolver', () => {
  it('rejects cwd symlink escape after canonicalizing the nearest existing ancestor', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-plan-resolver-'));
    const worktreePath = path.join(root, 'worktree');
    const outside = path.join(root, 'outside');
    await fs.mkdir(worktreePath);
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(worktreePath, 'escaped'));
    await expect(resolve(worktreePath, 'escaped')).rejects.toThrow('escapes');
    await expect(resolve(worktreePath, 'missing/inside')).resolves.toMatchObject({
      executionDigest: expect.any(String)
    });
  });
});

function resolve(worktreePath: string, cwd: string) {
  const now = '2026-01-01T00:00:00.000Z';
  return new PreviewPlanResolver().resolve({
    task: { id: 'task', title: 'Task', prompt: 'Prompt', repositoryPath: worktreePath, workflowPhase: 'REVIEW', resolution: 'NONE', completionPolicy: 'LOCAL_ACCEPTANCE', phaseVersion: 1, currentIterationId: 'iteration', currentWorktreeId: 'worktree', forkedAlternativeTaskIds: [], agentSettings: {}, createdAt: now, updatedAt: now, projection: createInitialProjection(now) },
    iteration: { id: 'iteration', taskId: 'task', actionRequestId: 'action', generationKey: 'generation', branchName: 'codex/task', baseSha: 'base', status: 'ACTIVE', worktreeId: 'worktree', createdAt: now, updatedAt: now },
    worktree: { id: 'worktree', taskId: 'task', iterationId: 'iteration', repositoryPath: worktreePath, worktreePath, branchName: 'codex/task', baseSha: 'base', status: 'PRESENT', createdAt: now, updatedAt: now },
    parsed: parsePreviewRecipe(`version: 1
services:
  web:
    cwd: ${cwd}
    command: [node, server.mjs]
    ports: { http: { env: PORT } }
    ready: { type: http, port: http, path: /ready }
routes:
  app: { service: web, port: http, primary: true }
`),
    now
  });
}
