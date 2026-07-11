import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git } from '../git/gitCli';
import { createTaskMonkiScenario, type TaskMonkiScenario } from '../../testSupport/taskMonkiScenario';

const scenarios: TaskMonkiScenario[] = [];
afterEach(async () => {
  await Promise.allSettled(scenarios.splice(0).map((scenario) => scenario.service.shutdown()));
});

const describeMac = process.platform === 'darwin' ? describe : describe.skip;

describeMac('TaskManagerService Phase 1 preview scenario', () => {
  it('runs resolve → approve → dirty capture → job → ready → stale → stop without touching the worktree', async () => {
    const scenario = await previewScenario('task-monki-preview-service');
    const task = await scenario.createTask({ title: 'Preview vertical slice' });
    const worktree = await scenario.service.prepareWorktree({ taskId: task.id });
    await fs.writeFile(path.join(worktree.worktreePath, 'untracked-preview.txt'), 'captured-untracked');
    const statusBefore = await git(worktree.worktreePath, ['status', '--porcelain=v1', '-uall']);

    const resolved = await scenario.service.resolvePreview({ taskId: task.id });
    expect(resolved.status).toBe('PLAN');
    if (resolved.status !== 'PLAN') throw new Error('Expected a preview plan.');
    expect(resolved.approval).toBeUndefined();
    await expect(scenario.service.startPreview({ taskId: task.id })).rejects.toThrow('approval');
    expect((await scenario.store.snapshot()).previewGenerations).toEqual([]);

    await scenario.service.approvePreviewPlan({
      taskId: task.id,
      planId: resolved.plan.id,
      executionDigest: resolved.plan.executionDigest
    });
    const ready = await scenario.service.startPreview({ taskId: task.id });
    expect(ready.state).toBe('READY');
    expect(ready.freshness).toBe('CURRENT');
    expect(ready.routes).toHaveLength(1);
    const route = ready.routes[0];
    await expect(requestRoute(route.gatewayPort, route.hostname, '/')).resolves.toMatchObject({
      status: 200,
      body: 'captured-untracked'
    });
    await expect(requestRoute(route.gatewayPort, route.hostname, '/health/ready')).resolves.toMatchObject({
      status: 204
    });
    await expect(fs.access(path.join(worktree.worktreePath, 'generated-preview.txt'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    expect(await git(worktree.worktreePath, ['status', '--porcelain=v1', '-uall'])).toBe(statusBefore);
    const capturedEvidence = (await scenario.store.snapshot()).gitSnapshots
      .filter((snapshot) => snapshot.taskId === task.id)
      .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
    expect(capturedEvidence[0]?.dirtyFingerprint).toBe(capturedEvidence[1]?.dirtyFingerprint);

    await fs.writeFile(path.join(worktree.worktreePath, 'untracked-preview.txt'), 'changed-after-capture');
    await scenario.service.refreshEvidence({ taskId: task.id });
    const stale = await scenario.store.getPreviewGeneration(ready.id);
    expect(stale?.freshness).toBe('STALE');
    await expect(requestRoute(route.gatewayPort, route.hostname, '/')).resolves.toMatchObject({
      body: 'captured-untracked'
    });

    const stopped = await scenario.service.stopPreview({ taskId: task.id, generationId: ready.id });
    expect(stopped.state).toBe('STOPPED');
    await expect(fs.access(ready.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(requestRoute(route.gatewayPort, route.hostname, '/')).resolves.toMatchObject({
      status: 503
    });
    await expect(
      scenario.service.stopPreview({ taskId: task.id, generationId: ready.id })
    ).resolves.toMatchObject({ state: 'STOPPED' });

    const snapshot = await scenario.store.snapshot();
    expect(snapshot.previewNodeAttempts.map((attempt) => attempt.state)).toEqual(
      expect.arrayContaining(['SUCCEEDED', 'STOPPED'])
    );
    expect(snapshot.artifacts.some((artifact) => artifact.kind === 'preview-source-manifest')).toBe(true);
  }, 20_000);

  it('invalidates approval for capability changes and never starts the changed command', async () => {
    const scenario = await previewScenario('task-monki-preview-approval');
    const task = await scenario.createTask();
    const worktree = await scenario.service.prepareWorktree({ taskId: task.id });
    const first = await scenario.service.resolvePreview({ taskId: task.id });
    if (first.status !== 'PLAN') throw new Error('Expected a preview plan.');
    await scenario.service.approvePreviewPlan({
      taskId: task.id,
      planId: first.plan.id,
      executionDigest: first.plan.executionDigest
    });
    const recipePath = path.join(worktree.worktreePath, '.taskmonki', 'preview.yaml');
    const recipe = await fs.readFile(recipePath, 'utf8');
    await fs.writeFile(recipePath, recipe.replace('PREVIEW_MODE: phase-one', 'PREVIEW_MODE: changed'));

    const changed = await scenario.service.resolvePreview({ taskId: task.id });
    expect(changed.status).toBe('PLAN');
    if (changed.status !== 'PLAN') throw new Error('Expected changed plan.');
    expect(changed.plan.executionDigest).not.toBe(first.plan.executionDigest);
    expect(changed.approval).toBeUndefined();
    await expect(scenario.service.startPreview({ taskId: task.id })).rejects.toThrow('approval');
    expect((await scenario.store.snapshot()).previewResources).toEqual([]);
  });

  it('records bounded job failure evidence and blocks service start', async () => {
    const scenario = await previewScenario('task-monki-preview-job-failure', true);
    const task = await scenario.createTask();
    await scenario.service.prepareWorktree({ taskId: task.id });
    const resolved = await scenario.service.resolvePreview({ taskId: task.id });
    if (resolved.status !== 'PLAN') throw new Error('Expected plan.');
    await scenario.service.approvePreviewPlan({
      taskId: task.id,
      planId: resolved.plan.id,
      executionDigest: resolved.plan.executionDigest
    });
    await expect(scenario.service.startPreview({ taskId: task.id })).rejects.toThrow('failed with 7');
    const snapshot = await scenario.store.snapshot();
    const job = snapshot.previewNodeAttempts.find((attempt) => attempt.kind === 'JOB');
    expect(job).toMatchObject({ state: 'FAILED', exitCode: 7 });
    expect(snapshot.previewNodeAttempts.some((attempt) => attempt.kind === 'SERVICE')).toBe(false);
    const stderr = await scenario.service.readPreviewLog({
      taskId: task.id,
      artifactId: job!.stderrArtifactId
    });
    expect(stderr).toContain('intentional job failure');
    expect(Buffer.byteLength(stderr)).toBeLessThanOrEqual(256 * 1024);
  });

  it('runs three task previews concurrently with distinct resources and stops all on graceful shutdown', async () => {
    const scenario = await previewScenario('task-monki-preview-concurrency');
    const tasks = await Promise.all([
      scenario.createTask({ title: 'Preview A' }),
      scenario.createTask({ title: 'Preview B' }),
      scenario.createTask({ title: 'Preview C' })
    ]);
    await Promise.all(tasks.map((task) => scenario.service.prepareWorktree({ taskId: task.id })));
    for (const task of tasks) {
      const resolved = await scenario.service.resolvePreview({ taskId: task.id });
      if (resolved.status !== 'PLAN') throw new Error('Expected plan.');
      await scenario.service.approvePreviewPlan({
        taskId: task.id,
        planId: resolved.plan.id,
        executionDigest: resolved.plan.executionDigest
      });
    }
    const generations = await Promise.all(
      tasks.map((task) => scenario.service.startPreview({ taskId: task.id }))
    );
    expect(new Set(generations.map((generation) => generation.workspacePath)).size).toBe(3);
    expect(new Set(generations.map((generation) => generation.routes[0].hostname)).size).toBe(3);
    expect(new Set(generations.map((generation) => generation.routes[0].targetPort)).size).toBe(3);
    const resources = (await scenario.store.snapshot()).previewResources.filter(
      (resource) => resource.logicalNodeId === 'web'
    );
    expect(new Set(resources.map((resource) => resource.native?.launcher.pid)).size).toBe(3);
    await scenario.service.shutdown();
    const stopped = await scenario.store.getPreviewGenerations();
    expect(stopped.every((generation) => generation.state === 'STOPPED')).toBe(true);
    for (const generation of generations) {
      await expect(fs.access(generation.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    scenarios.splice(scenarios.indexOf(scenario), 1);
  }, 25_000);

  it('blocks capture during agent work and cleans a verified preview before task deletion', async () => {
    const scenario = await previewScenario('task-monki-preview-delete');
    const activeTask = await scenario.createTask({ title: 'Active agent preview guard' });
    const activeWorktree = await scenario.service.prepareWorktree({ taskId: activeTask.id });
    const activePlan = await scenario.service.resolvePreview({ taskId: activeTask.id });
    if (activePlan.status !== 'PLAN') throw new Error('Expected plan.');
    await scenario.service.approvePreviewPlan({
      taskId: activeTask.id,
      planId: activePlan.plan.id,
      executionDigest: activePlan.plan.executionDigest
    });
    await scenario.service.startRun({ taskId: activeTask.id, mode: 'IMPLEMENTATION' });
    await expect(scenario.service.startPreview({ taskId: activeTask.id })).rejects.toThrow(
      'active agent run'
    );
    expect(await fs.access(activeWorktree.worktreePath).then(() => true)).toBe(true);

    const task = await scenario.createTask({ title: 'Delete running preview' });
    await scenario.service.prepareWorktree({ taskId: task.id });
    const resolved = await scenario.service.resolvePreview({ taskId: task.id });
    if (resolved.status !== 'PLAN') throw new Error('Expected plan.');
    await scenario.service.approvePreviewPlan({
      taskId: task.id,
      planId: resolved.plan.id,
      executionDigest: resolved.plan.executionDigest
    });
    const generation = await scenario.service.startPreview({ taskId: task.id });
    await expect(
      scenario.service.deleteTask({ taskId: task.id, removeWorktree: false })
    ).resolves.toEqual({ taskId: task.id, removedWorktree: false });
    await expect(fs.access(generation.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
    const snapshot = await scenario.store.snapshot();
    expect(snapshot.tasks.some((candidate) => candidate.id === task.id)).toBe(false);
    expect(snapshot.previewResources.some((resource) => resource.taskId === task.id)).toBe(false);
  }, 20_000);
});

async function previewScenario(name: string, failingJob = false) {
  const scenario = await createTaskMonkiScenario({ name, previewEnabled: true });
  scenarios.push(scenario);
  await fs.mkdir(path.join(scenario.repositoryPath, '.taskmonki'), { recursive: true });
  await fs.mkdir(path.join(scenario.repositoryPath, 'scripts'), { recursive: true });
  await fs.writeFile(
    path.join(scenario.repositoryPath, 'scripts', 'prepare-preview.mjs'),
    failingJob
      ? `process.stderr.write('intentional job failure\\n'); process.exit(7);\n`
      : `import fs from 'node:fs/promises'; await fs.writeFile('generated-preview.txt', 'generated');\n`
  );
  await fs.writeFile(
    path.join(scenario.repositoryPath, 'server.mjs'),
    `import http from 'node:http'; import fs from 'node:fs/promises';
const body = await fs.readFile('untracked-preview.txt', 'utf8').catch(() => 'committed-content');
http.createServer((request, response) => {
  if (request.url === '/health/ready') { response.writeHead(204).end(); return; }
  response.end(body);
}).listen(Number(process.env.PORT), '127.0.0.1');\n`
  );
  await fs.writeFile(
    path.join(scenario.repositoryPath, '.taskmonki', 'preview.yaml'),
    `version: 1
jobs:
  prepare:
    command: [node, scripts/prepare-preview.mjs]
services:
  web:
    command: [node, server.mjs]
    needs: { prepare: succeeded }
    env: { PREVIEW_MODE: phase-one }
    ports: { http: { env: PORT } }
    ready: { type: http, port: http, path: /health/ready, timeoutSeconds: 5 }
routes:
  app: { service: web, port: http, primary: true }
`
  );
  await git(scenario.repositoryPath, ['add', '.']);
  await git(scenario.repositoryPath, ['commit', '-m', 'Add preview fixture']);
  return scenario;
}

function requestRoute(port: number, hostname: string, requestPath: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: requestPath, headers: { host: hostname } },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (body += chunk));
        response.once('end', () => resolve({ status: response.statusCode ?? 0, body }));
      }
    );
    request.once('error', reject);
    request.end();
  });
}
