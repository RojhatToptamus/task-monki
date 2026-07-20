import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  PreviewComposeInspection,
  PreviewComposePlan,
  PreviewOciEngineIdentity
} from '../../../shared/contracts';
import { FileTaskStore } from '../../storage/FileTaskStore';
import { addTestRepository } from '../../../testSupport/repositoryFixture';
import {
  PreviewComposeActivationError,
  PreviewComposeResetRequiredError,
  PreviewComposeRuntime
} from './PreviewComposeRuntime';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const engineIdentity: PreviewOciEngineIdentity = {
  contextName: 'desktop-linux',
  endpointDigest: 'endpoint',
  engineId: 'engine',
  serverVersion: '28.0.0',
  apiVersion: '1.48',
  operatingSystem: 'linux',
  architecture: 'arm64'
};

describe('PreviewComposeRuntime', () => {
  it('persists one exact task project and removes only its recorded objects on destructive stop', async () => {
    const fixture = await runtimeFixture(false);
    const result = await fixture.runtime.apply(fixture.input());
    expect(result.change).toBe('RESTART_PRESERVE_DATA');
    expect(result.ports).toEqual({ web: { http: 49152 } });
    expect(fixture.portRequests).toEqual([['port', 'web', '3000']]);
    expect(result.project).toEqual(expect.objectContaining({
      taskId: fixture.taskId,
      state: 'READY',
      activeGenerationId: 'generation-1'
    }));
    expect(result.project.containers).toHaveLength(1);
    expect(result.project.networks).toHaveLength(1);

    await expect(fixture.runtime.cleanupTask(fixture.taskId, { deleteData: true }))
      .resolves.toBe('CLEANED');
    expect(fixture.removed).toEqual(expect.arrayContaining(['container-1', 'network-1']));
    expect((await fixture.store.getPreviewComposeProject(fixture.taskId))?.state).toBe('STOPPED');
  });

  it('preserves exact volumes and leaves recovery required when activation fails', async () => {
    const fixture = await runtimeFixture(true, true);
    let detached = 0;
    const operation = fixture.runtime.apply(fixture.input({
      beforeActivation: async () => { detached += 1; }
    }));
    await expect(operation).rejects.toMatchObject({
      name: 'Error', activationStarted: true, cleanupIncomplete: false
    });
    expect(detached).toBe(1);
    expect(fixture.removed).toContain('container-1');
    expect(fixture.removed).not.toContain('volume-1');
    const project = await fixture.store.getPreviewComposeProject(fixture.taskId);
    expect(project).toEqual(expect.objectContaining({
      state: 'RECOVERY_REQUIRED'
    }));
    expect(project?.activeGenerationId).toBeUndefined();
    expect(project?.containers).toEqual([]);
    expect(project?.volumes).toEqual([
      expect.objectContaining({ logicalName: 'data', state: 'ACTIVE', external: false })
    ]);
  });

  it('retains exact container authority when failed activation cleanup needs a retry', async () => {
    const fixture = await runtimeFixture(true, true, true);
    await expect(fixture.runtime.apply(fixture.input())).rejects.toMatchObject({
      name: 'Error', activationStarted: true, cleanupIncomplete: true
    });

    const recovery = await fixture.store.getPreviewComposeProject(fixture.taskId);
    expect(recovery).toEqual(expect.objectContaining({ state: 'RECOVERY_REQUIRED' }));
    expect(recovery?.containers).toEqual([
      expect.objectContaining({ serviceId: 'web', object: expect.objectContaining({ objectId: 'container-1' }) })
    ]);
    expect(fixture.removed).not.toContain('container-1');

    await expect(fixture.runtime.cleanupTask(fixture.taskId, { deleteData: true })).resolves.toBe('CLEANED');
    expect(fixture.removed).toEqual(expect.arrayContaining(['container-1', 'volume-1', 'network-1']));
  });

  it('discovers and persists the reserved label subset before restart cleanup', async () => {
    const fixture = await runtimeFixture(false, true);
    const ready = await fixture.runtime.apply(fixture.input());
    await fixture.store.savePreviewComposeProject({
      ...ready.project,
      state: 'RESTARTING',
      containers: [],
      volumes: [],
      networks: []
    });

    await expect(fixture.runtime.cleanupTask(fixture.taskId, { deleteData: true }))
      .resolves.toBe('CLEANED');

    expect(fixture.removed).toEqual(expect.arrayContaining([
      'container-1', 'volume-1', 'network-1'
    ]));
    expect((await fixture.store.getPreviewComposeProject(fixture.taskId))?.state).toBe('STOPPED');
  });

  it('requires reset before mutation when a data-bearing service compatibility surface changes', async () => {
    const fixture = await runtimeFixture(false, true);
    const previous = inspection(true);
    const next = inspection(true, 'postgres:18');
    fixture.inspection = next;
    let detached = 0;
    await expect(fixture.runtime.apply(fixture.input({
      approvedInspection: next,
      previousInspection: previous,
      beforeActivation: async () => { detached += 1; }
    }))).rejects.toBeInstanceOf(PreviewComposeResetRequiredError);
    expect(detached).toBe(0);
    expect(fixture.mutations).toEqual([]);
  });

  it('retains removed owned volumes until explicit destructive stop', async () => {
    const fixture = await runtimeFixture(false, true);
    const previous = inspection(true);
    await fixture.runtime.apply(fixture.input({ approvedInspection: previous }));
    const next = inspection(false, 'postgres:17');
    fixture.inspection = next;
    const generationRoot = path.join(path.dirname(fixture.input().generationRoot), 'generation-2');
    await fs.mkdir(generationRoot);
    const updated = await fixture.runtime.apply(fixture.input({
      generationId: 'generation-2',
      generationRoot,
      plan: plan(false),
      approvedInspection: next,
      previousInspection: previous
    }));
    expect(updated.change).toBe('RESTART_PRESERVE_DATA');
    expect(updated.project.volumes).toEqual([
      expect.objectContaining({ logicalName: 'data', state: 'RETAINED' })
    ]);
    expect(fixture.removed).not.toContain('volume-1');

    await fixture.runtime.cleanupTask(fixture.taskId, { deleteData: true });
    expect(fixture.removed).toContain('volume-1');
    expect(fixture.engineCommands
      .filter((command) => command[0] === 'volume' && command[1] === 'ls')
      .every((command) => !command.includes('--no-trunc'))).toBe(true);
  });

  it('rotates exact ownership identity when a verified stopped project is recreated', async () => {
    const fixture = await runtimeFixture(false, true);
    const initial = await fixture.runtime.apply(fixture.input());
    const initialVolume = initial.project.volumes.find((volume) => volume.logicalName === 'data')?.object;
    await expect(fixture.runtime.cleanupTask(fixture.taskId, { deleteData: true })).resolves.toBe('CLEANED');

    const generationRoot = path.join(path.dirname(fixture.input().generationRoot), 'generation-reset');
    await fs.mkdir(generationRoot);
    const reset = await fixture.runtime.apply(fixture.input({
      generationId: 'generation-reset',
      generationRoot
    }));
    const resetVolume = reset.project.volumes.find((volume) => volume.logicalName === 'data')?.object;

    expect(reset.project.projectName).toBe(initial.project.projectName);
    expect(reset.project.id).not.toBe(initial.project.id);
    expect(reset.project.ownershipMarkerDigest).not.toBe(initial.project.ownershipMarkerDigest);
    expect(resetVolume).not.toEqual(initialVolume);
  });

  it('cancels before activation with a fixed AbortError and no project mutation', async () => {
    const fixture = await runtimeFixture(false);
    const initial = await fixture.runtime.apply(fixture.input());
    const mutationCount = fixture.mutations.length;
    const controller = new AbortController();
    controller.abort();
    const generationRoot = path.join(path.dirname(fixture.input().generationRoot), 'generation-canceled');
    await fs.mkdir(generationRoot);

    await expect(fixture.runtime.apply(fixture.input({
      generationId: 'generation-canceled',
      generationRoot,
      previousInspection: fixture.inspection,
      signal: controller.signal
    }))).rejects.toMatchObject({ name: 'AbortError', message: 'Compose preview activation canceled.' });

    expect(fixture.mutations).toHaveLength(mutationCount);
    expect(await fixture.store.getPreviewComposeProject(fixture.taskId)).toEqual(expect.objectContaining({
      id: initial.project.id,
      state: 'READY',
      containers: initial.project.containers,
      volumes: initial.project.volumes,
      networks: initial.project.networks
    }));
  });

  it('cancels its project health timer and joins pending work on shutdown', async () => {
    const fixture = await runtimeFixture(false);
    await fixture.runtime.apply(fixture.input());
    let failures = 0;
    await fixture.runtime.watch(fixture.taskId, async () => { failures += 1; });
    await fixture.runtime.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(failures).toBe(0);
  });

  it('joins an in-flight health check without dispatching stale failure cleanup', async () => {
    vi.useFakeTimers();
    try {
      const fixture = await runtimeFixture(false);
      await fixture.runtime.apply(fixture.input());
      const inspectionGate = fixture.blockNextContainerInspection();
      let failures = 0;
      await fixture.runtime.watch(fixture.taskId, async () => { failures += 1; });
      await vi.advanceTimersByTimeAsync(5_000);
      await inspectionGate.started;

      const cleanup = fixture.runtime.cleanupTask(fixture.taskId, { deleteData: true });
      await Promise.resolve();
      await Promise.resolve();
      inspectionGate.release();

      await expect(cleanup).resolves.toBe('CLEANED');
      expect(failures).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('joins a health-failure callback after it leaves the active watch map', async () => {
    vi.useFakeTimers();
    try {
      const fixture = await runtimeFixture(false);
      await fixture.runtime.apply(fixture.input());
      fixture.failContainerHealth();
      let markFailureStarted!: () => void;
      let releaseFailure!: () => void;
      const failureStarted = new Promise<void>((resolve) => { markFailureStarted = resolve; });
      const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
      await fixture.runtime.watch(fixture.taskId, async () => {
        markFailureStarted();
        await failureGate;
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await failureStarted;

      let shutdownComplete = false;
      const shutdown = fixture.runtime.shutdown().then(() => { shutdownComplete = true; });
      await Promise.resolve();
      expect(shutdownComplete).toBe(false);
      releaseFailure();

      await shutdown;
      expect(shutdownComplete).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

async function runtimeFixture(failUp: boolean, data = false, failContainerRemovalOnce = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-compose-runtime-'));
  roots.push(root);
  const sourcePath = path.join(root, 'source');
  const generationRoot = path.join(root, 'generation');
  await fs.mkdir(sourcePath);
  await fs.mkdir(generationRoot);
  await fs.writeFile(path.join(sourcePath, 'compose.yaml'), 'services: {}\n');
  const store = new FileTaskStore(path.join(root, 'store'));
  const task = await store.createTask({ title: 'Compose', prompt: 'Test', repositoryId: (await addTestRepository(store, sourcePath)).id });
  const taskId = task.id;
  let currentInspection = inspection(data);
  const objects = new Map<string, Record<string, unknown>>();
  const removed: string[] = [];
  const mutations: string[] = [];
  const portRequests: string[][] = [];
  const engineCommands: string[][] = [];
  let projectId = '';
  let labels: Record<string, string> = {};
  let rejectContainerRemoval = failContainerRemovalOnce;
  let nextContainerInspectionGate: {
    started(): void;
    wait: Promise<void>;
  } | undefined;

  const cli = {
    async run(command: { files: string[] }, argv: string[]) {
      if (argv[0] === 'up') {
        mutations.push('up');
        const override = JSON.parse(await fs.readFile(command.files.at(-1)!, 'utf8')) as {
          services: { web: { labels: Record<string, string> } };
        };
        labels = override.services.web.labels;
        projectId = labels['com.taskmonki.preview.compose-project'];
        objects.set('container-1', {
          Id: 'container-1', Name: '/project-web-1', Image: 'image-1',
          Config: { Labels: { ...labels, 'com.docker.compose.service': 'web' } },
          State: { Running: true, Paused: false, Restarting: false },
          NetworkSettings: { Ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '49152' }] } }
        });
        objects.set('network-1', {
          Id: 'network-1', Name: 'project_default',
          Labels: { ...labels, 'com.docker.compose.network': 'default' }
        });
        if (data) {
          objects.set('volume-1', {
            Name: 'volume-1',
            Labels: { ...labels, 'com.docker.compose.volume': 'data' }
          });
        }
        if (failUp) throw new Error('injected readiness failure');
        return { stdout: '', stderr: '' };
      }
      if (argv[0] === 'port') {
        portRequests.push(argv);
        return { stdout: '127.0.0.1:49152\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    }
  };
  const engine = {
    async requireReady() { return { status: 'READY', identity: engineIdentity }; },
    async run(argv: string[]) {
      const command = argv.filter((value) => value !== '--context' && value !== 'desktop-linux');
      engineCommands.push(command);
      if (command[0] === 'ps') {
        return { stdout: objects.has('container-1') ? 'container-1\n' : '', stderr: '' };
      }
      if (command[0] === 'container' && command[1] === 'ls') {
        return { stdout: objects.has('container-1') ? 'container-1\n' : '', stderr: '' };
      }
      if (command[0] === 'volume' && command[1] === 'ls') {
        return { stdout: objects.has('volume-1') ? 'volume-1\n' : '', stderr: '' };
      }
      if (command[0] === 'network' && command[1] === 'ls') {
        return { stdout: objects.has('network-1') ? 'network-1\n' : '', stderr: '' };
      }
      if (['container', 'volume', 'network'].includes(command[0]) && command[1] === 'inspect') {
        if (command[0] === 'container' && nextContainerInspectionGate) {
          const gate = nextContainerInspectionGate;
          nextContainerInspectionGate = undefined;
          gate.started();
          await gate.wait;
        }
        return { stdout: JSON.stringify([objects.get(command[2])]), stderr: '' };
      }
      if (['container', 'volume', 'network'].includes(command[0]) && command[1] === 'rm') {
        if (command[0] === 'container' && rejectContainerRemoval) {
          rejectContainerRemoval = false;
          throw new Error('injected container removal failure');
        }
        removed.push(command.at(-1)!);
        objects.delete(command.at(-1)!);
        return { stdout: '', stderr: '' };
      }
      if (command[0] === 'container' && command[1] === 'stop') return { stdout: '', stderr: '' };
      throw new Error(`Unexpected engine command: ${command.join(' ')}`);
    }
  };
  const runtime = new PreviewComposeRuntime(
    store,
    cli as never,
    { async inspect() { return currentInspection; } } as never,
    engine as never,
    {
      async waitForHttp() { return { status: 'PASSED', observedAt: new Date().toISOString() }; },
      async waitForTcp() { return { status: 'PASSED', observedAt: new Date().toISOString() }; }
    } as never
  );
  const composePlan = plan(data);
  const fixture = {
    runtime,
    store,
    taskId,
    removed,
    mutations,
    portRequests,
    engineCommands,
    get inspection() { return currentInspection; },
    set inspection(value: PreviewComposeInspection) { currentInspection = value; },
    input(overrides: Partial<Parameters<PreviewComposeRuntime['apply']>[0]> = {}) {
      return {
        taskId,
        previewKey: 'task-preview',
        generationId: 'generation-1',
        sourcePath,
        generationRoot,
        markerDigest: 'marker',
        plan: composePlan,
        approvedInspection: currentInspection,
        expectedEngine: engineIdentity,
        signal: new AbortController().signal,
        async beforeActivation() {},
        ...overrides
      };
    },
    blockNextContainerInspection() {
      let markStarted!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const wait = new Promise<void>((resolve) => { release = resolve; });
      nextContainerInspectionGate = { started: markStarted, wait };
      return { started, release };
    },
    failContainerHealth() {
      const container = objects.get('container-1');
      if (!container) throw new Error('Missing fixture container.');
      container.State = { Running: false, Paused: false, Restarting: false };
    },
    get projectId() { return projectId; }
  };
  return fixture;
}

function plan(data: boolean): PreviewComposePlan {
  return {
    files: ['compose.yaml'], projectDirectory: '.', profiles: [], rootServices: ['web'],
    services: [{
      id: 'web', ports: { http: { target: 3000, protocol: 'tcp' } },
      ready: { type: 'tcp', port: 'http', timeoutSeconds: 5 }
    }],
    inspection: inspection(data)
  };
}

function inspection(data: boolean, image = data ? 'postgres:17' : 'node:22'): PreviewComposeInspection {
  return {
    composeVersion: '2.40.0', supportsNoEnvResolution: true,
    trustDigest: 'trust', configDigest: `config:${image}`,
    hostInputs: [{ kind: 'COMPOSE_FILE', path: 'compose.yaml' }],
    services: [{
      id: 'web', image, dependsOn: [], exposedPorts: [3000], environmentKeys: [],
      secretSources: [],
      namedVolumes: data ? [{ source: 'data', target: '/data', readOnly: false }] : [],
      networks: ['default'], healthcheck: { test: ['CMD', 'true'] }
    }],
    volumes: data ? [{ name: 'data', external: false }] : [],
    networks: [{ name: 'default', external: false }]
  };
}
