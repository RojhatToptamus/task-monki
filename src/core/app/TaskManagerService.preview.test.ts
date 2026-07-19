import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitSnapshotRecord, PreviewGenerationRecord } from '../../shared/contracts';
import { git } from '../git/gitCli';
import { previewRouteHostname } from '../preview/PreviewRouteHostname';
import { FileTaskStore } from '../storage/FileTaskStore';
import { createTaskMonkiScenario, type TaskMonkiScenario } from '../../testSupport/taskMonkiScenario';

const scenarios: TaskMonkiScenario[] = [];
const controlledHttpServers: http.Server[] = [];
afterEach(async () => {
  await Promise.allSettled(controlledHttpServers.splice(0).map((server) =>
    server.listening
      ? new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      : Promise.resolve()
  ));
  await Promise.allSettled(
    scenarios.splice(0).map(async (scenario) => {
      await scenario.service.shutdown().catch(() => undefined);
      await fs.rm(scenario.rootDir, { recursive: true, force: true });
    })
  );
});

const describeMac = process.platform === 'darwin' ? describe : describe.skip;

describeMac('TaskManagerService native preview scenarios', () => {
  it('returns exact local-binding requirements and resolves the same scenario after configuration', async () => {
    const scenario = await previewScenario('task-monki-preview-local-binding');
    const backend = http.createServer((request, response) => {
      const origin = request.headers.origin;
      if (origin) {
        response.setHeader('access-control-allow-origin', origin);
        response.setHeader('access-control-allow-credentials', 'true');
      }
      response.end('controlled backend');
    });
    controlledHttpServers.push(backend);
    await new Promise<void>((resolve, reject) => {
      backend.once('error', reject);
      backend.listen(0, '127.0.0.1', resolve);
    });
    const backendPort = (backend.address() as { port: number }).port;
    await fs.writeFile(
      path.join(scenario.repositoryPath, '.taskmonki', 'preview.yaml'),
      `version: 1
attachments:
  backend:
    label: Competitions API
    type: http
    target: { type: local }
services:
  web:
    command: [node, server.mjs]
    env:
      NEXT_PUBLIC_API_URL: { type: attached-http-origin, attachment: backend }
    ports: { http: { env: PORT } }
    ready: { type: http, port: http, path: /health/ready }
routes:
  app: { service: web, port: http, primary: true }
scenarios:
  frontend: { jobs: [], resources: [] }
  alternate: { jobs: [], resources: [] }
defaultScenario: frontend
`
    );
    await fs.writeFile(
      path.join(scenario.repositoryPath, 'server.mjs'),
      `import http from 'node:http';
const server = http.createServer(async (request, response) => {
  response.statusCode = request.url === '/health/ready' ? 204 : 200;
  if (request.url === '/health/ready') { response.end(); return; }
  if (request.url === '/backend') {
    const backend = await fetch(process.env.NEXT_PUBLIC_API_URL);
    response.end(await backend.text());
    return;
  }
  response.end(process.env.NEXT_PUBLIC_API_URL ?? 'missing');
});
server.listen(Number(process.env.PORT), '127.0.0.1');
`
    );
    await git(scenario.repositoryPath, ['add', '.taskmonki/preview.yaml', 'server.mjs']);
    await git(scenario.repositoryPath, ['commit', '-m', 'Use local backend binding']);
    const task = await scenario.createTask({ title: 'Frontend binding' });
    await scenario.service.prepareWorktree({ taskId: task.id });

    const required = await scenario.service.resolvePreview({
      taskId: task.id,
      scenarioId: 'alternate'
    });
    expect(required).toEqual({
      status: 'CONFIGURATION_REQUIRED',
      reason: 'Local preview bindings are required for: backend.',
      selectedScenarioId: 'alternate',
      requirements: [{
        attachmentId: 'backend',
        label: 'Competitions API',
        attachmentType: 'http',
        allowedTargetTypes: ['endpoint', 'task-preview-route'],
        usages: [{
          kind: 'ENVIRONMENT', recipient: 'PROCESS', nodeKind: 'SERVICE', nodeId: 'web',
          environmentKeys: ['NEXT_PUBLIC_API_URL']
        }]
      }]
    });

    await scenario.service.setPreviewLocalAttachmentBinding({
      taskId: task.id,
      attachmentId: 'backend',
      target: {
        type: 'endpoint', scheme: 'http', host: '127.0.0.1', port: backendPort, basePath: '/'
      }
    });
    const resolved = await scenario.service.resolvePreview({
      taskId: task.id,
      scenarioId: required.status === 'CONFIGURATION_REQUIRED'
        ? required.selectedScenarioId
        : 'frontend'
    });
    expect(resolved.status).toBe('PLAN');
    if (resolved.status !== 'PLAN') throw new Error('Expected configured plan.');
    expect(resolved.plan.executionPlan.selectedScenarioId).toBe('alternate');
    expect(resolved.plan.executionPlan.attachments?.[0]?.target).toEqual({
      type: 'endpoint', scheme: 'http', host: '127.0.0.1', port: backendPort, basePath: '/'
    });
    await scenario.service.approvePreviewPlan({
      taskId: task.id,
      planId: resolved.plan.id,
      executionDigest: resolved.plan.executionDigest
    });
    const generation = await scenario.service.startPreview({
      taskId: task.id,
      scenarioId: 'alternate'
    });
    const expectedBackendOrigin = `http://127.0.0.1:${backendPort}`;
    await expect(requestRoute(
      generation.routes[0].gatewayPort,
      generation.routes[0].hostname,
      '/'
    )).resolves.toMatchObject({ status: 200, body: expectedBackendOrigin });
    await expect(requestRoute(
      generation.routes[0].gatewayPort,
      generation.routes[0].hostname,
      '/backend'
    )).resolves.toMatchObject({ status: 200, body: 'controlled backend' });
    const previewOrigin = `http://${generation.routes[0].hostname}:${generation.routes[0].gatewayPort}`;
    await expect(requestRoute(
      backendPort,
      '127.0.0.1',
      '/',
      { origin: previewOrigin }
    )).resolves.toMatchObject({
      status: 200,
      headers: {
        'access-control-allow-origin': previewOrigin,
        'access-control-allow-credentials': 'true'
      }
    });
    await scenario.service.stopPreview({ taskId: task.id, generationId: generation.id });
  }, 20_000);

  it('keeps a cross-task Preview route stable through producer replacement and absence', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-preview-cross-task-binding',
      previewEnabled: true
    });
    scenarios.push(scenario);
    const producer = await scenario.createTask({ title: 'Backend producer' });
    const consumer = await scenario.createTask({ title: 'Frontend consumer' });
    const producerWorktree = await scenario.service.prepareWorktree({ taskId: producer.id });
    const consumerWorktree = await scenario.service.prepareWorktree({ taskId: consumer.id });
    await fs.mkdir(path.join(producerWorktree.worktreePath, '.taskmonki'), { recursive: true });
    await fs.mkdir(path.join(consumerWorktree.worktreePath, '.taskmonki'), { recursive: true });
    await fs.writeFile(
      path.join(producerWorktree.worktreePath, '.taskmonki', 'preview.yaml'),
      `version: 1
services:
  api:
    command: [node, producer.mjs]
    ports: { http: { env: PORT } }
    ready: { type: http, port: http, path: /health/ready }
routes:
  api: { service: api, port: http, primary: true }
`
    );
    const producerSource = (version: string) => `import http from 'node:http';
const server = http.createServer((request, response) => {
  if (request.url === '/health/ready') { response.writeHead(204).end(); return; }
  response.end('${version}:' + request.url);
});
server.listen(Number(process.env.PORT), '127.0.0.1');
`;
    await fs.writeFile(
      path.join(producerWorktree.worktreePath, 'producer.mjs'),
      producerSource('producer-one')
    );
    await fs.writeFile(
      path.join(consumerWorktree.worktreePath, '.taskmonki', 'preview.yaml'),
      `version: 1
attachments:
  backend:
    type: http
    target: { type: local }
services:
  web:
    command: [node, consumer.mjs]
    env:
      BACKEND_ORIGIN: { type: attached-http-origin, attachment: backend }
    ports: { http: { env: PORT } }
    ready: { type: http, port: http, path: /health/ready }
routes:
  app: { service: web, port: http, primary: true }
`
    );
    await fs.writeFile(
      path.join(consumerWorktree.worktreePath, 'consumer.mjs'),
      `import http from 'node:http';
const server = http.createServer((request, response) => {
  if (request.url === '/health/ready') { response.writeHead(204).end(); return; }
  response.end(process.env.BACKEND_ORIGIN ?? 'missing');
});
server.listen(Number(process.env.PORT), '127.0.0.1');
`
    );

    const producerPlan = await scenario.service.resolvePreview({ taskId: producer.id });
    if (producerPlan.status !== 'PLAN') throw new Error('Expected producer plan.');
    await scenario.service.approvePreviewPlan({
      taskId: producer.id,
      planId: producerPlan.plan.id,
      executionDigest: producerPlan.plan.executionDigest
    });
    const producerOne = await scenario.service.startPreview({ taskId: producer.id });

    const consumerRequired = await scenario.service.resolvePreview({ taskId: consumer.id });
    if (consumerRequired.status !== 'CONFIGURATION_REQUIRED') {
      throw new Error('Expected consumer binding requirement.');
    }
    await scenario.service.setPreviewLocalAttachmentBinding({
      taskId: consumer.id,
      attachmentId: 'backend',
      target: {
        type: 'task-preview-route',
        targetTaskId: producer.id,
        routeId: 'api',
        basePath: '/v1'
      }
    });
    const consumerPlan = await scenario.service.resolvePreview({
      taskId: consumer.id,
      scenarioId: consumerRequired.selectedScenarioId
    });
    if (consumerPlan.status !== 'PLAN') throw new Error('Expected consumer plan.');
    await scenario.service.approvePreviewPlan({
      taskId: consumer.id,
      planId: consumerPlan.plan.id,
      executionDigest: consumerPlan.plan.executionDigest
    });
    const consumerGeneration = await scenario.service.startPreview({ taskId: consumer.id });
    expect(consumerGeneration.routes[0].gatewayPort).toBe(producerOne.routes[0].gatewayPort);
    const stableBackendOrigin = `http://${previewRouteHostname(producer.id, 'api')}:${producerOne.routes[0].gatewayPort}/v1`;
    await expect(requestRoute(
      consumerGeneration.routes[0].gatewayPort,
      consumerGeneration.routes[0].hostname,
      '/'
    )).resolves.toMatchObject({ status: 200, body: stableBackendOrigin });
    await expect(requestRoute(
      producerOne.routes[0].gatewayPort,
      producerOne.routes[0].hostname,
      '/v1/ping'
    )).resolves.toMatchObject({ status: 200, body: 'producer-one:/v1/ping' });

    await fs.writeFile(
      path.join(producerWorktree.worktreePath, 'producer.mjs'),
      producerSource('producer-two')
    );
    const producerTwo = await scenario.service.startPreview({ taskId: producer.id });
    expect(producerTwo.routes[0].hostname).toBe(producerOne.routes[0].hostname);
    await expect(requestRoute(
      producerTwo.routes[0].gatewayPort,
      producerTwo.routes[0].hostname,
      '/v1/ping'
    )).resolves.toMatchObject({ status: 200, body: 'producer-two:/v1/ping' });

    await scenario.service.stopPreview({
      taskId: consumer.id,
      generationId: consumerGeneration.id
    });
    await expect(requestRoute(
      producerTwo.routes[0].gatewayPort,
      producerTwo.routes[0].hostname,
      '/v1/ping'
    )).resolves.toMatchObject({ status: 200, body: 'producer-two:/v1/ping' });
    const restartedConsumer = await scenario.service.startPreview({ taskId: consumer.id });
    await expect(requestRoute(
      restartedConsumer.routes[0].gatewayPort,
      restartedConsumer.routes[0].hostname,
      '/'
    )).resolves.toMatchObject({ status: 200, body: stableBackendOrigin });
    await scenario.service.stopPreview({ taskId: producer.id, generationId: producerTwo.id });
    await expect(requestRoute(
      restartedConsumer.routes[0].gatewayPort,
      producerTwo.routes[0].hostname,
      '/v1/ping'
    )).resolves.toMatchObject({ status: 503 });
    const consumerAfterProducerStop = await scenario.store.getPreviewGeneration(restartedConsumer.id);
    expect(consumerAfterProducerStop).toMatchObject({ state: 'READY', routingState: 'ACTIVE' });
    await scenario.service.stopPreview({
      taskId: consumer.id,
      generationId: restartedConsumer.id
    });
    const stoppedSnapshot = await scenario.store.snapshot();
    const stoppedGenerations = stoppedSnapshot.previewGenerations.filter(
      (generation) => generation.taskId === producer.id || generation.taskId === consumer.id
    );
    expect(stoppedGenerations).toHaveLength(4);
    expect(stoppedGenerations.every(
      (generation) => generation.state === 'STOPPED' && generation.routingState === 'RETIRED'
    )).toBe(true);
    expect(stoppedSnapshot.previewResources.filter(
      (resource) => resource.taskId === producer.id || resource.taskId === consumer.id
    ).every((resource) => resource.state === 'STOPPED')).toBe(true);
    for (const generation of stoppedGenerations) {
      await expect(fs.access(generation.workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  }, 30_000);

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
    expect(route.hostname).toBe(previewRouteHostname(task.id, 'app'));
    expect(route.hostname.split('.')).toHaveLength(2);
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

  it('retains every concurrent attachment-readiness result in generation evidence', async () => {
    const scenario = await previewScenario('task-monki-preview-attachment-evidence');
    const task = await scenario.createTask({ title: 'Concurrent attachment evidence' });
    const worktree = await scenario.service.prepareWorktree({ taskId: task.id });
    const target = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve, reject) => {
      target.once('error', reject);
      target.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = target.address();
      if (!address || typeof address === 'string') throw new Error('Attachment target did not bind.');
      const attachments = ['alpha', 'bravo', 'charlie', 'delta'];
      await fs.writeFile(path.join(worktree.worktreePath, '.taskmonki', 'preview.yaml'), `
version: 1
attachments:
${attachments.map((id) => `  ${id}:\n    type: tcp\n    target: { type: endpoint, host: 127.0.0.1, port: ${address.port} }\n    check: { timeoutSeconds: 2 }`).join('\n')}
services:
  web:
    command: [node, server.mjs]
    needs: { ${attachments.map((id) => `${id}: ready`).join(', ')} }
    ports: { http: { env: PORT } }
    ready: { type: http, port: http, path: /health/ready, timeoutSeconds: 5 }
routes:
  app: { service: web, port: http, primary: true }
`);
      const resolved = await scenario.service.resolvePreview({ taskId: task.id });
      if (resolved.status !== 'PLAN') throw new Error('Expected a preview plan.');
      await scenario.service.approvePreviewPlan({
        taskId: task.id,
        planId: resolved.plan.id,
        executionDigest: resolved.plan.executionDigest
      });
      const ready = await scenario.service.startPreview({ taskId: task.id });
      expect(ready.attachmentReadiness).toHaveLength(attachments.length);
      expect(new Set(ready.attachmentReadiness?.map((item) => item.attachmentId))).toEqual(
        new Set(attachments)
      );
      expect(ready.attachmentReadiness?.every((item) => item.status === 'PASSED')).toBe(true);
      await scenario.service.stopPreview({ taskId: task.id, generationId: ready.id });
    } finally {
      await new Promise<void>((resolve, reject) => target.close((error) => error ? reject(error) : resolve()));
    }
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

  it('hands off an exclusive worker without overlap and restores the old graph after candidate activation fails', async () => {
    const scenario = await previewScenario('task-monki-preview-exclusive-handoff');
    const task = await scenario.createTask({ title: 'Exclusive worker handoff' });
    const worktree = await scenario.service.prepareWorktree({ taskId: task.id });
    const lockPath = path.join(scenario.repositoryPath, 'exclusive-worker.lock');
    const overlapPath = path.join(scenario.repositoryPath, 'exclusive-worker-overlap');
    await fs.writeFile(path.join(worktree.worktreePath, 'server.mjs'), `
import http from 'node:http';
http.createServer((_request, response) => response.end('active')).listen(Number(process.env.PORT), '127.0.0.1');
`);
    await fs.writeFile(path.join(worktree.worktreePath, 'worker.mjs'), `
import fs from 'node:fs';
if (fs.existsSync(process.env.WORKER_LOCK)) fs.writeFileSync(process.env.OVERLAP_PATH, 'overlap');
fs.writeFileSync(process.env.WORKER_LOCK, String(process.pid));
const cleanup = () => { try { fs.unlinkSync(process.env.WORKER_LOCK); } catch {} process.exit(0); };
process.on('SIGINT', cleanup); process.on('SIGTERM', cleanup);
setInterval(() => {}, 1000);
`);
    await fs.writeFile(
      path.join(worktree.worktreePath, 'worker-ready.mjs'),
      'setTimeout(() => process.exit(0), 250);\n'
    );
    await fs.writeFile(path.join(worktree.worktreePath, '.taskmonki', 'preview.yaml'), `
version: 1
services:
  web:
    command: [node, server.mjs]
    ports: { http: { env: PORT } }
    ready: { type: http, port: http, path: / }
workers:
  consumer:
    command: [node, worker.mjs]
    needs: { web: ready }
    env:
      WORKER_LOCK: ${JSON.stringify(lockPath)}
      OVERLAP_PATH: ${JSON.stringify(overlapPath)}
    ready: { type: argv, command: [node, worker-ready.mjs], timeoutSeconds: 2 }
routes:
  app: { service: web, port: http, primary: true }
`);
    const resolved = await scenario.service.resolvePreview({ taskId: task.id });
    if (resolved.status !== 'PLAN') throw new Error('Expected plan.');
    await scenario.service.approvePreviewPlan({
      taskId: task.id, planId: resolved.plan.id, executionDigest: resolved.plan.executionDigest
    });
    const active = await scenario.service.startPreview({ taskId: task.id });
    const route = active.routes[0];
    await expect(requestRoute(route.gatewayPort, route.hostname, '/')).resolves.toMatchObject({ body: 'active' });

    await fs.writeFile(path.join(worktree.worktreePath, 'worker.mjs'), `
import fs from 'node:fs';
if (fs.existsSync(process.env.WORKER_LOCK)) fs.writeFileSync(process.env.OVERLAP_PATH, 'overlap');
process.exit(7);
`);
    await expect(scenario.service.startPreview({ taskId: task.id })).rejects.toThrow();

    expect(await scenario.store.getPreviewGeneration(active.id)).toMatchObject({
      state: 'READY', routingState: 'ACTIVE'
    });
    await expect(requestRoute(route.gatewayPort, route.hostname, '/')).resolves.toMatchObject({ body: 'active' });
    await expect(fs.access(overlapPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const attempts = await scenario.store.getPreviewNodeAttempts(active.id);
    expect(attempts.some(
      (attempt) => attempt.nodeId === 'consumer' && attempt.attempt === 2 && attempt.state === 'READY'
    )).toBe(true);
    await scenario.service.stopPreview({ taskId: task.id, generationId: active.id });
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
if (count === 1) {
  const timer = setInterval(async () => {
    const restart = await fs.access('restart-worker').then(() => true, () => false);
    if (!restart) return;
    clearInterval(timer);
    process.exit(7);
  }, 10);
} else setInterval(() => {}, 1000);
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
    ready: { type: argv, command: [node, -e, process.exit(0)], timeoutSeconds: 5 }
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
        (attempt) => attempt.nodeId === 'indexer' && attempt.attempt === 1 && attempt.state === 'READY'
      )
    ).toBe(true);
    await fs.writeFile(path.join(generation.workspacePath, 'source', 'restart-worker'), 'restart');
    expect(generation.routes).toHaveLength(2);
    const app = generation.routes.find((route) => route.id === 'app')!;
    const api = generation.routes.find((route) => route.id === 'api')!;
    expect(app.hostname).toBe(previewRouteHostname(task.id, 'app'));
    expect(api.hostname).toBe(previewRouteHostname(task.id, 'api'));
    expect(app.hostname).not.toBe(api.hostname);
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
    ready: { type: argv, command: [node, -e, process.exit(0)], timeoutSeconds: 5 }
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
    ready: { type: argv, command: [node, -e, process.exit(0)], timeoutSeconds: 5 }
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
    ).rejects.toThrow('Preview startup is already running');
    const ready = await starting;
    const snapshot = await scenario.store.snapshot();
    expect(snapshot.tasks.some((candidate) => candidate.id === task.id)).toBe(true);
    expect(snapshot.previewGenerations.every((generation) => generation.taskId === task.id)).toBe(true);
    await scenario.service.stopPreview({ taskId: task.id, generationId: ready.id });
  }, 20_000);

  it('checks Git before destructive reset and permits reset orchestration for recovery-required setup', async () => {
    const scenario = await previewScenario('task-monki-preview-reset-order');
    const task = await prepareApprovedPreview(scenario);
    const plan = await scenario.store.getLatestPreviewPlan(task.id);
    const approval = plan
      ? await scenario.store.getMatchingPreviewApproval(task.id, plan.executionDigest)
      : undefined;
    const worktree = await scenario.store.getCurrentWorktree(task.id);
    if (!plan || !approval || !worktree) throw new Error('Expected approved preview context.');
    const now = new Date().toISOString();
    const active = await scenario.store.savePreviewGeneration({
      id: 'reset-order-active', previewKey: 'task-reset-order', taskId: task.id,
      iterationId: worktree.iterationId, worktreeId: worktree.id, planId: plan.id,
      approvalId: approval.id, executionDigest: plan.executionDigest,
      sourceGitSnapshotId: 'git-active', sourceHeadSha: worktree.headSha!,
      sourceDirtyFingerprint: 'dirty-active', workspacePath: '/tmp/reset-order-active',
      state: 'READY', routingState: 'ACTIVE', freshness: 'CURRENT', routes: [],
      createdAt: now, updatedAt: now
    });
    const recovery = await scenario.store.savePreviewGeneration({
      ...active,
      id: 'reset-order-recovery',
      sourceGitSnapshotId: 'git-recovery',
      workspacePath: '/tmp/reset-order-recovery',
      state: 'RECOVERY_REQUIRED',
      routingState: 'CANDIDATE',
      replacesGenerationId: active.id,
      failureReason: 'Ambiguous setup completion.'
    });
    const internals = scenario.service as unknown as {
      previews: { resetData(input: unknown): Promise<void> };
      refreshEvidenceInternal(input: { taskId: string }): Promise<GitSnapshotRecord>;
    };
    const originalRefresh = internals.refreshEvidenceInternal.bind(scenario.service);
    const originalReset = internals.previews.resetData.bind(internals.previews);
    let resetCalls = 0;
    internals.previews.resetData = async () => {
      resetCalls += 1;
      throw new Error('reset orchestration reached');
    };
    internals.refreshEvidenceInternal = async () => ({
      id: 'conflicted', taskId: task.id, iterationId: worktree.iterationId,
      worktreeId: worktree.id, status: 'CONFLICTED', capturedAt: now
    } as GitSnapshotRecord);

    await expect(scenario.service.resetPreviewData({
      taskId: task.id, generationId: recovery.id, resourceId: 'database', scenarioId: 'default'
    })).rejects.toThrow('Git status is CONFLICTED');
    expect(resetCalls).toBe(0);

    internals.refreshEvidenceInternal = originalRefresh;
    await expect(scenario.service.resetPreviewData({
      taskId: task.id, generationId: recovery.id, resourceId: 'database', scenarioId: 'default'
    })).rejects.toThrow('reset orchestration reached');
    expect(resetCalls).toBe(1);

    internals.previews.resetData = originalReset;
    await scenario.store.savePreviewGeneration({ ...active, state: 'STOPPED', routingState: 'RETIRED' });
    await scenario.store.savePreviewGeneration({ ...recovery, state: 'STOPPED', routingState: 'RETIRED' });
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
    expect(generations.map((generation) => generation.routes[0].hostname)).toEqual(
      tasks.map((task) => previewRouteHostname(task.id, 'app'))
    );
    expect(new Set(generations.map((generation) => generation.routes[0].targetPort)).size).toBe(3);
    const resources = (await scenario.store.snapshot()).previewResources.filter(
      (resource) => resource.logicalNodeId === 'web'
    );
    expect(new Set(resources.map((resource) => resource.native?.launcher.pid)).size).toBe(3);
    await scenario.service.shutdown();
    const reopenedStore = new FileTaskStore(path.join(scenario.rootDir, 'store'));
    const stopped = await reopenedStore.getPreviewGenerations();
    await reopenedStore.close();
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
      expect(stableHostname).toBe(previewRouteHostname(task.id, 'app'));
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

  it.runIf(process.env.TASK_MONKI_OCI_INTEGRATION === '1')(
    'runs a real frontend, API, worker, PostgreSQL, Redis, migration, and seed graph',
    async () => {
      const scenario = await createTaskMonkiScenario({
        name: 'task-monki-oci-stack',
        previewEnabled: true,
        previewOciExecutablePath: process.env.TASK_MONKI_OCI_BIN || 'docker',
        previewOciContextName: process.env.TASK_MONKI_OCI_CONTEXT || 'desktop-linux'
      });
      scenarios.push(scenario);
      await fs.mkdir(path.join(scenario.repositoryPath, '.taskmonki'), { recursive: true });
      await fs.mkdir(path.join(scenario.repositoryPath, 'scripts'), { recursive: true });
      await fs.writeFile(path.join(scenario.repositoryPath, 'scripts', 'connect.mjs'), `
import net from 'node:net';
export function connect(value) {
  const url = new URL(value);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname);
    socket.setTimeout(5000);
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('dependency timeout')); });
    socket.once('error', reject);
  });
}
`);
      await fs.writeFile(path.join(scenario.repositoryPath, 'scripts', 'data-job.mjs'), `
import fs from 'node:fs/promises'; import { connect } from './connect.mjs';
await Promise.all([connect(process.env.DATABASE_URL), connect(process.env.REDIS_URL)]);
const role = process.argv[2];
const file = '.scenario-order';
const previous = await fs.readFile(file, 'utf8').catch(() => '');
if (role === 'seed' && previous !== 'migration\\n') throw new Error('seed ran before migration');
await fs.appendFile(file, role + '\\n');
`);
      await fs.writeFile(path.join(scenario.repositoryPath, 'api.mjs'), `
import http from 'node:http'; import { connect } from './scripts/connect.mjs';
await Promise.all([connect(process.env.DATABASE_URL), connect(process.env.REDIS_URL)]);
http.createServer((request, response) => {
  response.writeHead(request.url === '/ready' ? 204 : 200).end(request.url === '/ready' ? undefined : 'api');
}).listen(Number(process.env.PORT), '127.0.0.1');
`);
      await fs.writeFile(path.join(scenario.repositoryPath, 'worker.mjs'), `
import { connect } from './scripts/connect.mjs';
await Promise.all([connect(process.env.DATABASE_URL), connect(process.env.REDIS_URL)]);
setInterval(() => {}, 1000);
`);
      await fs.writeFile(path.join(scenario.repositoryPath, 'frontend.mjs'), `
import http from 'node:http';
const ready = await fetch(process.env.API_ORIGIN + '/ready');
if (!ready.ok) throw new Error('API is not ready');
http.createServer((request, response) => {
  if (request.url === '/ready') return response.writeHead(204).end();
  response.end('frontend');
}).listen(Number(process.env.PORT), '127.0.0.1');
`);
      await fs.writeFile(path.join(scenario.repositoryPath, '.taskmonki', 'preview.yaml'), `version: 1
resources:
  database:
    type: postgres
    limits: { cpus: 1, memoryMb: 256, diskMb: 512, pids: 128 }
  cache:
    type: redis
    limits: { cpus: 0.5, memoryMb: 128, diskMb: 256, pids: 64 }
jobs:
  migrate:
    command: [node, scripts/data-job.mjs, migration]
    role: migration
    retrySafe: false
    needs: { database: ready, cache: ready }
    env:
      DATABASE_URL: { type: postgres-url, resource: database }
      REDIS_URL: { type: redis-url, resource: cache }
  seed:
    command: [node, scripts/data-job.mjs, seed]
    role: seed
    retrySafe: true
    needs: { migrate: succeeded, database: ready, cache: ready }
    env:
      DATABASE_URL: { type: postgres-url, resource: database }
      REDIS_URL: { type: redis-url, resource: cache }
services:
  api:
    command: [node, api.mjs]
    needs: { seed: succeeded, database: ready, cache: ready }
    env:
      DATABASE_URL: { type: postgres-url, resource: database }
      REDIS_URL: { type: redis-url, resource: cache }
    ports: { http: { env: PORT } }
    ready: { type: http, port: http, path: /ready, timeoutSeconds: 10 }
  frontend:
    command: [node, frontend.mjs]
    needs: { api: ready }
    env:
      API_ORIGIN: { type: service-origin, service: api, port: http }
    ports: { http: { env: PORT } }
    ready: { type: http, port: http, path: /ready, timeoutSeconds: 10 }
workers:
  worker:
    command: [node, worker.mjs]
    ready: { type: argv, command: [node, -e, process.exit(0)], timeoutSeconds: 5 }
    needs: { seed: succeeded, database: ready, cache: ready }
    env:
      DATABASE_URL: { type: postgres-url, resource: database }
      REDIS_URL: { type: redis-url, resource: cache }
routes:
  app: { service: frontend, port: http, primary: true }
scenarios:
  full: { jobs: [migrate, seed], resources: [database, cache] }
defaultScenario: full
`);
      await git(scenario.repositoryPath, ['add', '.']);
      await git(scenario.repositoryPath, ['commit', '-m', 'Add OCI preview stack fixture']);
      const task = await scenario.createTask({ title: 'Full OCI stack' });
      await scenario.service.prepareWorktree({ taskId: task.id });
      const resolved = await scenario.service.resolvePreview({ taskId: task.id, scenarioId: 'full' });
      if (resolved.status !== 'PLAN') throw new Error('Expected OCI preview plan.');
      await scenario.service.approvePreviewPlan({
        taskId: task.id, planId: resolved.plan.id, executionDigest: resolved.plan.executionDigest
      });
      let ready: PreviewGenerationRecord;
      try {
        ready = await scenario.service.startPreview({ taskId: task.id, scenarioId: 'full' });
      } catch (error) {
        const attempt = (await scenario.store.snapshot()).previewNodeAttempts.find(
          (candidate) => candidate.taskId === task.id && candidate.nodeId === 'migrate'
        );
        const stderr = attempt
          ? await scenario.store.readArtifactRange(attempt.stderrArtifactId, 0, 64 * 1024)
          : undefined;
        throw new Error(`OCI stack startup failed: ${stderr?.chunk || String(error)}`, { cause: error });
      }
      expect(ready.state).toBe('READY');
      await expect(requestRoute(
        ready.routes[0].gatewayPort, ready.routes[0].hostname, '/'
      )).resolves.toMatchObject({ status: 200, body: 'frontend' });
      const attempts = (await scenario.store.snapshot()).previewNodeAttempts;
      expect(attempts.find((attempt) => attempt.nodeId === 'migrate')?.state).toBe('SUCCEEDED');
      expect(attempts.find((attempt) => attempt.nodeId === 'seed')?.state).toBe('SUCCEEDED');
      await scenario.service.stopPreview({ taskId: task.id, generationId: ready.id });
      const stopped = await scenario.store.snapshot();
      const resources = stopped.previewManagedResources.filter((resource) => resource.taskId === task.id);
      const environments = stopped.previewManagedEnvironments.filter(
        (environment) => environment.taskId === task.id
      );
      expect(resources).toHaveLength(2);
      expect(resources.every((resource) => resource.state === 'STOPPED')).toBe(true);
      expect(environments).toHaveLength(1);
      expect(environments[0].state).toBe('STOPPED');
    },
    180_000
  );
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

function requestRoute(
  port: number,
  hostname: string,
  requestPath: string,
  headers: Record<string, string> = {}
) {
  return new Promise<{
    status: number;
    body: string;
    headers: http.IncomingHttpHeaders;
  }>((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: requestPath, headers: { host: hostname, ...headers } },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (body += chunk));
        response.once('end', () => resolve({
          status: response.statusCode ?? 0,
          body,
          headers: response.headers
        }));
      }
    );
    request.once('error', reject);
    request.end();
  });
}
