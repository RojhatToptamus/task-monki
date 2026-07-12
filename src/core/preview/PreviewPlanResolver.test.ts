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

  it('binds OCI approval authority to the exact engine context and reports mutable images and limits', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-plan-oci-'));
    const worktreePath = path.join(root, 'worktree');
    await fs.mkdir(worktreePath);
    const first = await resolveOci(worktreePath, 'engine-a');
    const second = await resolveOci(worktreePath, 'engine-b');

    expect(first.ociCapability).toMatchObject({
      status: 'READY',
      identity: { contextName: 'desktop-linux', engineId: 'engine-a' }
    });
    expect(first.executionDigest).not.toBe(second.executionDigest);
    expect(first.warnings.join('\n')).toContain('mutable image reference');
    expect(first.warnings.join('\n')).toContain('disk size is advisory');
  });

  it.each([
    ['CPU', '{ cpus: 1 }', { cpu: false, memory: true, pids: true }],
    ['memory', '{ memoryMb: 256 }', { cpu: true, memory: false, pids: true }],
    ['PID', '{ pids: 64 }', { cpu: true, memory: true, pids: false }]
  ] as const)('rejects requested %s enforcement before approval when unsupported', async (name, limits, support) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-plan-limits-'));
    const worktreePath = path.join(root, 'worktree');
    await fs.mkdir(worktreePath);
    await expect(resolveOci(worktreePath, 'engine', support, limits)).rejects.toThrow(name);
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

function resolveOci(
  worktreePath: string,
  engineId: string,
  support: { cpu: boolean; memory: boolean; pids: boolean } = { cpu: true, memory: true, pids: true },
  limits = '{ cpus: 1, memoryMb: 256, diskMb: 1024 }'
) {
  const now = '2026-01-01T00:00:00.000Z';
  const resolver = new PreviewPlanResolver({
    async probe() {
      return {
        status: 'READY' as const,
        contextName: 'desktop-linux',
        supportsMemoryLimit: support.memory,
        supportsCpuLimit: support.cpu,
        supportsPidsLimit: support.pids,
        identity: {
          contextName: 'desktop-linux', endpointDigest: 'endpoint', engineId,
          serverVersion: '28.0.4', apiVersion: '1.48', operatingSystem: 'linux', architecture: 'arm64'
        }
      };
    }
  } as never);
  return resolver.resolve({
    task: { id: 'task', title: 'Task', prompt: 'Prompt', repositoryPath: worktreePath, workflowPhase: 'REVIEW', resolution: 'NONE', completionPolicy: 'LOCAL_ACCEPTANCE', phaseVersion: 1, currentIterationId: 'iteration', currentWorktreeId: 'worktree', forkedAlternativeTaskIds: [], agentSettings: {}, createdAt: now, updatedAt: now, projection: createInitialProjection(now) },
    iteration: { id: 'iteration', taskId: 'task', actionRequestId: 'action', generationKey: 'generation', branchName: 'codex/task', baseSha: 'base', status: 'ACTIVE', worktreeId: 'worktree', createdAt: now, updatedAt: now },
    worktree: { id: 'worktree', taskId: 'task', iterationId: 'iteration', repositoryPath: worktreePath, worktreePath, branchName: 'codex/task', baseSha: 'base', status: 'PRESENT', createdAt: now, updatedAt: now },
    parsed: parsePreviewRecipe(`version: 1
resources:
  database:
    type: postgres
    limits: ${limits}
services:
  web:
    command: [node, server.mjs]
    needs: { database: ready }
    env: { DATABASE_URL: { type: postgres-url, resource: database } }
    ports: { http: { env: PORT } }
    ready: { type: http, port: http, path: /ready }
routes:
  app: { service: web, port: http, primary: true }
`),
    now
  });
}
