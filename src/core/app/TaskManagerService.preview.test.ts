import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PreviewGenerationRecord } from '../../shared/contracts';
import { git } from '../git/gitCli';
import type { FileTaskStore } from '../storage/FileTaskStore';
import { createTaskMonkiScenario, type TaskMonkiScenario } from '../../testSupport/taskMonkiScenario';

const scenarios: TaskMonkiScenario[] = [];
afterEach(async () => {
  await Promise.allSettled(
    scenarios.splice(0).map(async (scenario) => {
      await scenario.service.shutdown().catch(() => undefined);
      await fs.rm(scenario.rootDir, { recursive: true, force: true });
    })
  );
});

const describeMac = process.platform === 'darwin' ? describe : describe.skip;

describeMac('TaskManagerService native preview scenarios', () => {
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

  it('cuts over a ready replacement atomically and preserves the active generation when the next candidate fails', async () => {
    const scenario = await previewScenario('task-monki-preview-replacement');
    const task = await scenario.createTask({ title: 'Atomic replacement' });
    const worktree = await scenario.service.prepareWorktree({ taskId: task.id });
    await fs.writeFile(path.join(worktree.worktreePath, 'untracked-preview.txt'), 'version-one');
    const resolved = await scenario.service.resolvePreview({ taskId: task.id });
    if (resolved.status !== 'PLAN') throw new Error('Expected plan.');
    await scenario.service.approvePreviewPlan({
      taskId: task.id,
      planId: resolved.plan.id,
      executionDigest: resolved.plan.executionDigest
    });
    const first = await scenario.service.startPreview({ taskId: task.id });
    const route = first.routes[0];
    await expect(requestRoute(route.gatewayPort, route.hostname, '/')).resolves.toMatchObject({ body: 'version-one' });

    await fs.writeFile(path.join(worktree.worktreePath, 'untracked-preview.txt'), 'version-two');
    const second = await scenario.service.startPreview({ taskId: task.id });
    expect(second).toMatchObject({ routingState: 'ACTIVE', replacesGenerationId: first.id });
    expect(second.routes[0].hostname).toBe(route.hostname);
    await expect(requestRoute(route.gatewayPort, route.hostname, '/')).resolves.toMatchObject({ body: 'version-two' });
    expect(await scenario.store.getPreviewGeneration(first.id)).toMatchObject({
      state: 'STOPPED', routingState: 'RETIRED', freshness: 'STALE'
    });
    expect(second.freshness).toBe('CURRENT');

    await fs.writeFile(path.join(worktree.worktreePath, 'server.mjs'), 'throw new Error("candidate failed");\n');
    await expect(scenario.service.startPreview({ taskId: task.id })).rejects.toThrow();
    await expect(requestRoute(route.gatewayPort, route.hostname, '/')).resolves.toMatchObject({
      status: 200,
      body: 'version-two'
    });
    expect(await scenario.store.getPreviewGeneration(second.id)).toMatchObject({
      state: 'READY', routingState: 'ACTIVE'
    });
    const generations = await scenario.store.getPreviewGenerations(task.id);
    expect(generations.filter((generation) => generation.routingState === 'ACTIVE')).toHaveLength(1);

    await fs.writeFile(path.join(worktree.worktreePath, 'server.mjs'), `
import http from 'node:http';
http.createServer((request, response) => {
  if (request.url === '/health/ready') response.writeHead(503).end();
  else response.end('candidate-never-ready');
}).listen(Number(process.env.PORT), '127.0.0.1');
`);
    const starting = scenario.service.startPreview({ taskId: task.id });
    const waiting = await scenario.waitForSnapshot((snapshot) =>
      snapshot.previewGenerations.some(
        (generation) => generation.taskId === task.id && generation.routingState === 'CANDIDATE' && generation.state === 'WAITING_READY'
      )
    );
    const candidate = waiting.previewGenerations.find(
      (generation) => generation.taskId === task.id && generation.routingState === 'CANDIDATE' && generation.state === 'WAITING_READY'
    )!;
    const rejected = expect(starting).rejects.toThrow('canceled');
    await scenario.service.stopPreview({ taskId: task.id, generationId: candidate.id });
    await rejected;
    await expect(requestRoute(route.gatewayPort, route.hostname, '/')).resolves.toMatchObject({ body: 'version-two' });
  }, 30_000);

  it('runs a shared install, multiple services, typed origins, TCP and argv probes, routes, and a bounded worker restart', async () => {
    const scenario = await previewScenario('task-monki-preview-phase-two');
    const task = await scenario.createTask({ title: 'Phase 2 native graph' });
    const worktree = await scenario.service.prepareWorktree({ taskId: task.id });
    await fs.writeFile(path.join(worktree.worktreePath, 'scripts', 'install.mjs'), `
import fs from 'node:fs/promises';
const path = 'install-count.txt';
const count = Number(await fs.readFile(path, 'utf8').catch(() => '0')) + 1;
await fs.writeFile(path, String(count));
`);
    await fs.writeFile(path.join(worktree.worktreePath, 'api.mjs'), `
import http from 'node:http';
http.createServer((_request, response) => response.end('api')).listen(Number(process.env.API_PORT), '127.0.0.1');
`);
    await fs.writeFile(path.join(worktree.worktreePath, 'web.mjs'), `
import http from 'node:http';
http.createServer((_request, response) => response.end(process.env.API_ORIGIN + '|' + process.env.PUBLIC_ORIGIN)).listen(Number(process.env.WEB_PORT), '127.0.0.1');
`);
    await fs.writeFile(path.join(worktree.worktreePath, 'scripts', 'check-web.mjs'), `
import http from 'node:http';
const request = http.get({ host: '127.0.0.1', port: Number(process.env.WEB_PORT), path: '/' }, (response) => {
  response.resume(); response.once('end', () => setTimeout(() => process.exit(response.statusCode === 200 ? 0 : 1), 350));
});
request.once('error', () => process.exit(1));
`);
    await fs.writeFile(path.join(worktree.worktreePath, 'worker.mjs'), `
import fs from 'node:fs/promises';
const path = 'worker-attempt.txt';
const count = Number(await fs.readFile(path, 'utf8').catch(() => '0')) + 1;
await fs.writeFile(path, String(count));
if (count === 1) setTimeout(() => process.exit(7), 150);
else setInterval(() => {}, 1000);
`);
    await fs.writeFile(path.join(worktree.worktreePath, '.taskmonki', 'preview.yaml'), `
version: 1
jobs:
  install:
    command: [node, scripts/install.mjs]
services:
  api:
    command: [node, api.mjs]
    needs: { install: succeeded }
    ports: { http: { env: API_PORT } }
    ready: { type: tcp, port: http, timeoutSeconds: 5 }
  web:
    command: [node, web.mjs]
    needs: { install: succeeded, api: ready }
    env:
      API_ORIGIN: { type: service-origin, service: api, port: http }
      PUBLIC_ORIGIN: { type: route-origin, route: app }
    ports: { http: { env: WEB_PORT } }
    ready: { type: argv, command: [node, scripts/check-web.mjs], timeoutSeconds: 5 }
workers:
  indexer:
    command: [node, worker.mjs]
    needs: { api: ready }
    env: { API_ORIGIN: { type: service-origin, service: api, port: http } }
    critical: true
    restart: { mode: on-failure, maxRestarts: 1, backoffMs: 25 }
routes:
  api: { service: api, port: http, primary: false }
  app: { service: web, port: http, primary: true }
`);
    const resolved = await scenario.service.resolvePreview({ taskId: task.id });
    if (resolved.status !== 'PLAN') throw new Error('Expected plan.');
    await scenario.service.approvePreviewPlan({
      taskId: task.id, planId: resolved.plan.id, executionDigest: resolved.plan.executionDigest
    });
    const generation = await scenario.service.startPreview({ taskId: task.id });
    const attemptsAtCutover = await scenario.store.getPreviewNodeAttempts(generation.id);
    expect(
      attemptsAtCutover.some(
        (attempt) => attempt.nodeId === 'indexer' && attempt.attempt === 2 && attempt.state === 'READY'
      )
    ).toBe(true);
    expect(generation.routes).toHaveLength(2);
    const app = generation.routes.find((route) => route.id === 'app')!;
    const api = generation.routes.find((route) => route.id === 'api')!;
    await expect(requestRoute(api.gatewayPort, api.hostname, '/')).resolves.toMatchObject({ body: 'api' });
    await expect(requestRoute(app.gatewayPort, app.hostname, '/')).resolves.toMatchObject({
      body: `http://127.0.0.1:${api.targetPort}|http://${app.hostname}:${app.gatewayPort}`
    });
    await scenario.waitForSnapshot((snapshot) =>
      snapshot.previewNodeAttempts.some(
        (attempt) => attempt.generationId === generation.id && attempt.nodeId === 'indexer' && attempt.attempt === 2 && attempt.state === 'READY'
      )
    );
    expect(await fs.readFile(path.join(generation.workspacePath, 'source', 'install-count.txt'), 'utf8')).toBe('1');
    const attempts = await scenario.store.getPreviewNodeAttempts(generation.id);
    expect(attempts.filter((attempt) => attempt.nodeId === 'install')).toHaveLength(1);
    expect(attempts.some((attempt) => attempt.kind === 'PROBE' && attempt.state === 'SUCCEEDED')).toBe(true);
    expect(attempts.filter((attempt) => attempt.nodeId === 'indexer').map((attempt) => attempt.attempt).sort()).toEqual([1, 2]);
  }, 30_000);

  it('refuses cutover when an argv-ready route port is not owned by its service', async () => {
    const scenario = await previewScenario('task-monki-preview-unowned-route');
    const task = await scenario.createTask({ title: 'Unowned routed port' });
    const worktree = await scenario.service.prepareWorktree({ taskId: task.id });
    await fs.writeFile(path.join(worktree.worktreePath, 'health-only.mjs'), `
import http from 'node:http';
http.createServer((_request, response) => response.end('health')).listen(Number(process.env.HEALTH_PORT), '127.0.0.1');
`);
    await fs.writeFile(path.join(worktree.worktreePath, '.taskmonki', 'preview.yaml'), `
version: 1
services:
  web:
    command: [node, health-only.mjs]
    ports:
      health: { env: HEALTH_PORT }
      public: { env: PUBLIC_PORT }
    ready: { type: argv, command: [node, -e, process.exit(0)], timeoutSeconds: 5 }
routes:
  app: { service: web, port: public, primary: true }
`);
    const resolved = await scenario.service.resolvePreview({ taskId: task.id });
    if (resolved.status !== 'PLAN') throw new Error('Expected plan.');
    await scenario.service.approvePreviewPlan({
      taskId: task.id, planId: resolved.plan.id, executionDigest: resolved.plan.executionDigest
    });
    await expect(scenario.service.startPreview({ taskId: task.id })).rejects.toThrow('listener');
    const generation = (await scenario.store.getPreviewGenerations(task.id))[0];
    expect(generation.state).toBe('FAILED');
    await expect(fs.access(generation.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 20_000);

  it('waits for an in-flight argv liveness probe before removing its generation', async () => {
    const scenario = await previewScenario('task-monki-preview-probe-stop');
    const task = await scenario.createTask({ title: 'Probe shutdown ownership' });
    const worktree = await scenario.service.prepareWorktree({ taskId: task.id });
    await fs.writeFile(path.join(worktree.worktreePath, 'worker.mjs'), 'setInterval(() => {}, 1000);\n');
    await fs.writeFile(path.join(worktree.worktreePath, '.taskmonki', 'preview.yaml'), `
version: 1
services:
  web:
    command: [node, server.mjs]
    ports: { http: { env: PORT } }
    ready: { type: http, port: http, path: /health/ready, timeoutSeconds: 5 }
workers:
  observer:
    command: [node, worker.mjs]
    critical: false
    liveness:
      type: argv
      command: [node, -e, setTimeout(() => process.exit(0), 10000)]
      timeoutSeconds: 15
      intervalSeconds: 1
      failureThreshold: 1
routes:
  app: { service: web, port: http, primary: true }
`);
    const resolved = await scenario.service.resolvePreview({ taskId: task.id });
    if (resolved.status !== 'PLAN') throw new Error('Expected plan.');
    await scenario.service.approvePreviewPlan({
      taskId: task.id, planId: resolved.plan.id, executionDigest: resolved.plan.executionDigest
    });
    const ready = await scenario.service.startPreview({ taskId: task.id });
    await scenario.waitForSnapshot((snapshot) =>
      snapshot.previewNodeAttempts.some(
        (attempt) =>
          attempt.generationId === ready.id && attempt.kind === 'PROBE' && attempt.state === 'RUNNING'
      )
    );
    const stopped = await scenario.service.stopPreview({ taskId: task.id, generationId: ready.id });
    expect(stopped.state).toBe('STOPPED');
    const resources = await scenario.store.getPreviewResources(ready.id);
    expect(resources.every((resource) => ['STOPPED', 'EXITED', 'FAILED'].includes(resource.state))).toBe(true);
    await expect(fs.access(ready.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 25_000);

  it('stops graph supervision before cleaning a generation whose cutover persistence fails', async () => {
    const scenario = await previewScenario('task-monki-preview-cutover-cleanup');
    const task = await scenario.createTask({ title: 'Cutover cleanup ownership' });
    const worktree = await scenario.service.prepareWorktree({ taskId: task.id });
    const recipePath = path.join(worktree.worktreePath, '.taskmonki', 'preview.yaml');
    const recipe = await fs.readFile(recipePath, 'utf8');
    await fs.writeFile(
      recipePath,
      recipe.replace(
        'ready: { type: http, port: http, path: /health/ready, timeoutSeconds: 5 }',
        'ready: { type: http, port: http, path: /health/ready, timeoutSeconds: 5 }\n    restart: { mode: always, maxRestarts: 1, backoffMs: 0 }'
      )
    );
    const resolved = await scenario.service.resolvePreview({ taskId: task.id });
    if (resolved.status !== 'PLAN') throw new Error('Expected plan.');
    await scenario.service.approvePreviewPlan({
      taskId: task.id, planId: resolved.plan.id, executionDigest: resolved.plan.executionDigest
    });
    const mutableStore = scenario.store as FileTaskStore & {
      cutoverPreviewGenerations: FileTaskStore['cutoverPreviewGenerations'];
    };
    const cutover = mutableStore.cutoverPreviewGenerations.bind(scenario.store);
    mutableStore.cutoverPreviewGenerations = async () => {
      throw new Error('Injected cutover persistence failure.');
    };
    await expect(scenario.service.startPreview({ taskId: task.id })).rejects.toThrow(
      'cutover persistence failure'
    );
    mutableStore.cutoverPreviewGenerations = cutover;

    const generation = (await scenario.store.getPreviewGenerations(task.id))[0];
    expect(generation.state).toBe('FAILED');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const resources = await scenario.store.getPreviewResources(generation.id);
    expect(resources.every((resource) => ['STOPPED', 'EXITED', 'FAILED'].includes(resource.state))).toBe(true);
    await expect(fs.access(generation.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 20_000);

  it('fails and cleans an active generation when a critical worker exhausts liveness policy', async () => {
    const scenario = await previewScenario('task-monki-preview-critical-worker');
    const task = await scenario.createTask({ title: 'Critical worker liveness' });
    const worktree = await scenario.service.prepareWorktree({ taskId: task.id });
    await fs.writeFile(path.join(worktree.worktreePath, 'worker.mjs'), 'setInterval(() => {}, 1000);\n');
    await fs.writeFile(path.join(worktree.worktreePath, '.taskmonki', 'preview.yaml'), `
version: 1
services:
  web:
    command: [node, server.mjs]
    ports: { http: { env: PORT } }
    ready: { type: http, port: http, path: /health/ready, timeoutSeconds: 5 }
workers:
  guard:
    command: [node, worker.mjs]
    needs: { web: ready }
    critical: true
    restart: { mode: never, maxRestarts: 0 }
    liveness:
      type: argv
      command: [node, -e, process.exit(1)]
      timeoutSeconds: 2
      intervalSeconds: 1
      failureThreshold: 1
routes:
  app: { service: web, port: http, primary: true }
`);
    const resolved = await scenario.service.resolvePreview({ taskId: task.id });
    if (resolved.status !== 'PLAN') throw new Error('Expected plan.');
    await scenario.service.approvePreviewPlan({
      taskId: task.id, planId: resolved.plan.id, executionDigest: resolved.plan.executionDigest
    });
    const ready = await scenario.service.startPreview({ taskId: task.id });
    const failed = await scenario.waitForSnapshot((snapshot) =>
      snapshot.previewGenerations.some(
        (generation) => generation.id === ready.id && generation.state === 'FAILED'
      )
    );
    expect(failed.previewGenerations.find((generation) => generation.id === ready.id)?.failureReason).toContain('liveness');
    await expect(requestRoute(ready.routes[0].gatewayPort, ready.routes[0].hostname, '/')).resolves.toMatchObject({ status: 503 });
    await expect(fs.access(ready.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 25_000);

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
      artifactId: job!.stderrArtifactId,
      offset: 0,
      maxBytes: 64 * 1024
    });
    expect(stderr.chunk).toContain('intentional job failure');
    expect(Buffer.byteLength(stderr.chunk)).toBeLessThanOrEqual(64 * 1024);
  });

  it('rejects a wildcard listener and cleans the failed generation', async () => {
    const scenario = await previewScenario('task-monki-preview-wildcard', false, 'wildcard');
    const task = await prepareApprovedPreview(scenario);
    await expect(scenario.service.startPreview({ taskId: task.id })).rejects.toThrow(
      'non-loopback address'
    );
    const snapshot = await scenario.store.snapshot();
    const generation = snapshot.previewGenerations.find((record) => record.taskId === task.id)!;
    expect(generation.state).toBe('FAILED');
    await expect(fs.access(generation.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 20_000);

  it('never overwrites an early service exit with READY', async () => {
    const scenario = await previewScenario('task-monki-preview-early-exit', false, 'exit-after-ready');
    const task = await prepareApprovedPreview(scenario);
    await expect(scenario.service.startPreview({ taskId: task.id })).rejects.toThrow();
    const generations = (await scenario.store.snapshot()).previewGenerations.filter(
      (record) => record.taskId === task.id
    );
    expect(generations).toHaveLength(1);
    expect(generations[0].state).not.toBe('READY');
    await expect(fs.access(generations[0].workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 20_000);

  it('serializes a post-READY service exit into FAILED cleanup and route detachment', async () => {
    const scenario = await previewScenario('task-monki-preview-later-exit', false, 'exit-later');
    const task = await prepareApprovedPreview(scenario);
    const ready = await scenario.service.startPreview({ taskId: task.id });
    expect(ready.state).toBe('READY');
    const failed = await scenario.waitForSnapshot((snapshot) =>
      snapshot.previewGenerations.some(
        (generation) => generation.id === ready.id && generation.state === 'FAILED'
      )
    );
    expect(failed.previewGenerations.find((generation) => generation.id === ready.id)?.state).toBe(
      'FAILED'
    );
    await expect(requestRoute(ready.routes[0].gatewayPort, ready.routes[0].hostname, '/')).resolves.toMatchObject({
      status: 503
    });
    await expect(fs.access(ready.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 20_000);

  it('records terminal attempt and resource evidence when launcher startup fails', async () => {
    const scenario = await previewScenario('task-monki-preview-launch-failure', false, 'missing-command');
    const task = await prepareApprovedPreview(scenario);
    await expect(scenario.service.startPreview({ taskId: task.id })).rejects.toThrow();
    const snapshot = await scenario.store.snapshot();
    const serviceAttempt = snapshot.previewNodeAttempts.find(
      (attempt) => attempt.taskId === task.id && attempt.kind === 'SERVICE'
    );
    const serviceResource = snapshot.previewResources.find(
      (resource) => resource.taskId === task.id && resource.logicalNodeId === 'web'
    );
    expect(serviceAttempt).toMatchObject({ state: 'FAILED' });
    expect(serviceAttempt?.endedAt).toBeDefined();
    expect(serviceResource?.state).toBe('FAILED');
  }, 20_000);

  it('cancels readiness immediately and completes verified cleanup on stop', async () => {
    const scenario = await previewScenario('task-monki-preview-cancel-ready', false, 'never-ready');
    const task = await prepareApprovedPreview(scenario);
    const starting = scenario.service.startPreview({ taskId: task.id });
    const rejectedStart = expect(starting).rejects.toThrow('canceled');
    const waiting = await scenario.waitForSnapshot((snapshot) =>
      snapshot.previewGenerations.some(
        (generation) => generation.taskId === task.id && generation.state === 'WAITING_READY'
      )
    );
    const generation = waiting.previewGenerations.find((record) => record.taskId === task.id)!;
    const stopped = await scenario.service.stopPreview({ taskId: task.id, generationId: generation.id });
    await rejectedStart;
    expect(stopped.state).toBe('STOPPED');
    await expect(fs.access(generation.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 20_000);

  it('serializes task deletion against source capture so no orphan records can be recreated', async () => {
    const scenario = await previewScenario('task-monki-preview-delete-race');
    const task = await prepareApprovedPreview(scenario);
    const starting = scenario.service.startPreview({ taskId: task.id });
    await expect(
      scenario.service.deleteTask({ taskId: task.id, removeWorktree: false })
    ).rejects.toThrow('Preview source capture is already running');
    const ready = await starting;
    const snapshot = await scenario.store.snapshot();
    expect(snapshot.tasks.some((candidate) => candidate.id === task.id)).toBe(true);
    expect(snapshot.previewGenerations.every((generation) => generation.taskId === task.id)).toBe(true);
    await scenario.service.stopPreview({ taskId: task.id, generationId: ready.id });
  }, 20_000);

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
  }, 25_000);

  it('keeps one active graph and stable routes through a bounded eight-cycle replacement stress run', async () => {
    const scenario = await previewScenario('task-monki-preview-replacement-stress');
    const task = await scenario.createTask({ title: 'Replacement stress' });
    const worktree = await scenario.service.prepareWorktree({ taskId: task.id });
    const resolved = await scenario.service.resolvePreview({ taskId: task.id });
    if (resolved.status !== 'PLAN') throw new Error('Expected plan.');
    await scenario.service.approvePreviewPlan({
      taskId: task.id, planId: resolved.plan.id, executionDigest: resolved.plan.executionDigest
    });
    let stableHostname: string | undefined;
    let latest: PreviewGenerationRecord | undefined;
    for (let index = 0; index < 8; index += 1) {
      await fs.writeFile(path.join(worktree.worktreePath, 'untracked-preview.txt'), `cycle-${index}`);
      latest = await scenario.service.startPreview({ taskId: task.id });
      stableHostname ??= latest.routes[0].hostname;
      expect(latest.routes[0].hostname).toBe(stableHostname);
      await expect(requestRoute(latest.routes[0].gatewayPort, stableHostname, '/')).resolves.toMatchObject({
        body: `cycle-${index}`
      });
    }
    const snapshot = await scenario.store.snapshot();
    const generations = snapshot.previewGenerations.filter((generation) => generation.taskId === task.id);
    expect(generations.filter((generation) => generation.state === 'READY' && generation.routingState === 'ACTIVE')).toHaveLength(1);
    expect(generations.filter((generation) => generation.state === 'STOPPED' && generation.routingState === 'RETIRED')).toHaveLength(7);
    const liveResources = snapshot.previewResources.filter(
      (resource) => resource.taskId === task.id && resource.state === 'RUNNING'
    );
    expect(liveResources).toHaveLength(1);
    await scenario.service.stopPreview({ taskId: task.id, generationId: latest!.id });
  }, 60_000);

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

type ServiceMode =
  | 'normal'
  | 'wildcard'
  | 'exit-after-ready'
  | 'exit-later'
  | 'missing-command'
  | 'never-ready';

async function previewScenario(name: string, failingJob = false, serviceMode: ServiceMode = 'normal') {
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
const server = http.createServer((request, response) => {
  if (request.url === '/health/ready') {
    response.writeHead(${serviceMode === 'never-ready' ? '503' : '204'}).end();
    ${serviceMode === 'exit-after-ready' ? 'server.close(() => process.exit(0));' : ''}
    ${serviceMode === 'exit-later' ? 'setTimeout(() => server.close(() => process.exit(0)), 300);' : ''}
    return;
  }
  response.end(body);
});
server.listen(Number(process.env.PORT), '${serviceMode === 'wildcard' ? '0.0.0.0' : '127.0.0.1'}');\n`
  );
  await fs.writeFile(
    path.join(scenario.repositoryPath, '.taskmonki', 'preview.yaml'),
    `version: 1
jobs:
  prepare:
    command: [node, scripts/prepare-preview.mjs]
services:
  web:
    command: [${serviceMode === 'missing-command' ? 'task-monki-command-does-not-exist' : 'node, server.mjs'}]
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

async function prepareApprovedPreview(scenario: TaskMonkiScenario) {
  const task = await scenario.createTask();
  await scenario.service.prepareWorktree({ taskId: task.id });
  const resolved = await scenario.service.resolvePreview({ taskId: task.id });
  if (resolved.status !== 'PLAN') throw new Error('Expected preview plan.');
  await scenario.service.approvePreviewPlan({
    taskId: task.id,
    planId: resolved.plan.id,
    executionDigest: resolved.plan.executionDigest
  });
  return task;
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
