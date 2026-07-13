import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  PreviewComposeInspection,
  PreviewComposePlan,
  PreviewComposeProjectRecord,
  PreviewOciEngineIdentity
} from '../../../shared/contracts';
import { execFilePortable } from '../../process/portableChildProcess';
import { FileTaskStore } from '../../storage/FileTaskStore';
import { OciEngineAdapter } from '../runtime/OciEngineAdapter';
import { PreviewComposeCliAdapter } from './PreviewComposeCliAdapter';
import { previewComposeProjectName } from './PreviewComposeIdentity';
import { PreviewComposeInspector } from './PreviewComposeInspector';
import {
  PreviewComposeActivationError,
  PreviewComposeResetRequiredError,
  PreviewComposeRuntime
} from './PreviewComposeRuntime';

const describeReal = process.env.TASK_MONKI_REAL_COMPOSE === '1' ? describe : describe.skip;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describeReal('PreviewComposeRuntime real Docker lifecycle', () => {
  it('covers update, restart, reset, failure, cancellation, exact cleanup, and external protection', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-compose-real-'));
    roots.push(root);
    const store = new FileTaskStore(path.join(root, 'store'));
    const repository = path.join(root, 'repository');
    await fs.mkdir(repository);
    const task = await store.createTask({ title: 'Real Compose matrix', prompt: 'Verify', repositoryPath: repository });
    const projectName = previewComposeProjectName(task.id);
    const runId = randomUUID().replace(/-/g, '').slice(0, 16);
    const externalVolume = `taskmonki_external_volume_${runId}`;
    const externalNetwork = `taskmonki_external_network_${runId}`;
    const externalLabel = `taskmonki.phase5.matrix=${runId}`;
    const engine = new OciEngineAdapter({ contextName: 'desktop-linux', cwd: root });
    const capability = await engine.requireReady();
    const identity = capability.identity;
    const controlRoot = path.join(root, 'control');
    await fs.mkdir(controlRoot, { recursive: true });
    let composeDiagnostic = '';
    const cli = new PreviewComposeCliAdapter({
      contextName: identity.contextName,
      dockerConfigPath: path.join(process.env.HOME ?? '', '.docker'),
      controlledHome: controlRoot,
      execute: async (executable, argv, options) => {
        try {
          return await execFilePortable(executable, argv, {
            cwd: options.cwd,
            env: options.env,
            timeout: options.timeoutMs,
            maxBuffer: Math.max(options.maxOutputBytes, options.maxErrorBytes),
            signal: options.signal
          });
        } catch (error) {
          const failure = error as Error & { stderr?: string };
          composeDiagnostic = String(failure.stderr ?? failure.message).replace(/[\r\n]+/g, ' ').slice(0, 1_000);
          throw error;
        }
      }
    });
    const probe = await cli.probe(identity.contextName);
    expect(probe.supportsNoEnvResolution).toBe(true);
    expect(probe.supportsRuntimeFlags).toBe(true);
    const inspector = new PreviewComposeInspector(cli, path.join(controlRoot, 'inspection'));
    const runtime = new PreviewComposeRuntime(store, cli, inspector, engine);

    await engine.run(engine.contextArgs(identity.contextName, [
      'volume', 'create', '--label', externalLabel, externalVolume
    ]));
    await engine.run(engine.contextArgs(identity.contextName, [
      'network', 'create', '--label', externalLabel, externalNetwork
    ]));
    const externalBefore = await externalIdentity(engine, identity, externalVolume, externalNetwork);

    let lastInspection: PreviewComposeInspection | undefined;
    let generation = 0;
    const publishedPorts = new Set<number>();
    const apply = async (
      variant: ComposeVariant,
      options: {
        previous?: PreviewComposeInspection;
        signal?: AbortSignal;
        beforeActivation?: () => Promise<void>;
      } = {}
    ) => {
      generation += 1;
      const generationId = `generation-${generation}`;
      const sourceRoot = path.join(root, 'sources', generationId);
      const generationRoot = path.join(root, 'generations', generationId);
      await fs.mkdir(sourceRoot, { recursive: true });
      await fs.mkdir(generationRoot, { recursive: true });
      const plan = composePlan();
      await writeComposeSource(sourceRoot, externalVolume, externalNetwork, variant);
      const approvedInspection = await inspector.inspect({
        sourceRoot,
        contextName: identity.contextName,
        projectName,
        plan
      });
      const result = await runtime.apply({
        taskId: task.id,
        previewKey: 'real-compose-matrix',
        generationId,
        sourcePath: sourceRoot,
        generationRoot,
        markerDigest: `marker-${generation}`,
        plan,
        approvedInspection,
        previousInspection: options.previous,
        expectedEngine: identity,
        signal: options.signal ?? new AbortController().signal,
        beforeActivation: options.beforeActivation ?? (async () => undefined)
      });
      for (const ports of Object.values(result.ports)) {
        for (const port of Object.values(ports)) publishedPorts.add(port);
      }
      lastInspection = approvedInspection;
      return { ...result, inspection: approvedInspection, generationRoot, sourceRoot };
    };

    try {
      let initial: Awaited<ReturnType<typeof apply>>;
      try {
        initial = await apply({ revisionKey: 'REVISION_ONE' });
      } catch (error) {
        throw new Error(`Initial real Compose activation failed: ${composeDiagnostic || 'no diagnostic'}`, { cause: error });
      }
      expect(initial.change).toBe('RESTART_PRESERVE_DATA');
      await insertDatabaseValue(engine, identity, initial.project, 'initial-data');
      expect(await readDatabaseValues(engine, identity, initial.project)).toContain('initial-data');
      const initialDataVolume = requiredVolume(initial.project, 'database-data');

      const stateless = await apply(
        { revisionKey: 'REVISION_TWO' },
        { previous: initial.inspection }
      );
      expect(stateless.change).toBe('IN_PLACE_UPDATE');
      expect(requiredVolume(stateless.project, 'database-data').object).toEqual(initialDataVolume.object);
      expect(await readDatabaseValues(engine, identity, stateless.project)).toContain('initial-data');

      const restarted = await apply(
        { revisionKey: 'REVISION_TWO', scratchVolume: true },
        { previous: stateless.inspection }
      );
      expect(restarted.change).toBe('RESTART_PRESERVE_DATA');
      expect(requiredVolume(restarted.project, 'database-data').object).toEqual(initialDataVolume.object);
      expect(await readDatabaseValues(engine, identity, restarted.project)).toContain('initial-data');

      const resetSource = await prepareInspection(
        root,
        ++generation,
        inspector,
        identity,
        projectName,
        externalVolume,
        externalNetwork,
        { revisionKey: 'REVISION_RESET', scratchVolume: true, databaseCommand: true }
      );
      await expect(runtime.apply({
        taskId: task.id,
        previewKey: 'real-compose-matrix',
        generationId: resetSource.generationId,
        sourcePath: resetSource.sourceRoot,
        generationRoot: resetSource.generationRoot,
        markerDigest: 'marker-reset-required',
        plan: resetSource.plan,
        approvedInspection: resetSource.inspection,
        previousInspection: restarted.inspection,
        expectedEngine: identity,
        signal: new AbortController().signal,
        beforeActivation: async () => undefined
      })).rejects.toBeInstanceOf(PreviewComposeResetRequiredError);
      expect(requiredVolume((await requiredProject(store, task.id)), 'database-data').object)
        .toEqual(initialDataVolume.object);
      expect(await readDatabaseValues(engine, identity, await requiredProject(store, task.id)))
        .toContain('initial-data');

      const resetCleanup = await runtime.cleanupTask(task.id, { deleteData: true });
      if (resetCleanup !== 'CLEANED') {
        throw new Error(`Explicit reset cleanup refused: ${(await requiredProject(store, task.id)).cleanupError ?? 'no reason'}`);
      }
      const reset = await runtime.apply({
        taskId: task.id,
        previewKey: 'real-compose-matrix',
        generationId: resetSource.generationId,
        sourcePath: resetSource.sourceRoot,
        generationRoot: resetSource.generationRoot,
        markerDigest: 'marker-after-reset',
        plan: resetSource.plan,
        approvedInspection: resetSource.inspection,
        expectedEngine: identity,
        signal: new AbortController().signal,
        beforeActivation: async () => undefined
      });
      for (const ports of Object.values(reset.ports)) {
        for (const port of Object.values(ports)) publishedPorts.add(port);
      }
      lastInspection = resetSource.inspection;
      const resetDataVolume = requiredVolume(reset.project, 'database-data');
      expect(resetDataVolume.object).not.toEqual(initialDataVolume.object);
      expect(await readDatabaseValues(engine, identity, reset.project)).not.toContain('initial-data');
      await insertDatabaseValue(engine, identity, reset.project, 'post-reset-data');

      const failedSource = await prepareInspection(
        root,
        ++generation,
        inspector,
        identity,
        projectName,
        externalVolume,
        externalNetwork,
        { revisionKey: 'REVISION_FAILURE', scratchVolume: true, databaseCommand: true, appFails: true }
      );
      let readinessFailure: PreviewComposeActivationError | undefined;
      try {
        await runtime.apply({
          taskId: task.id,
          previewKey: 'real-compose-matrix',
          generationId: failedSource.generationId,
          sourcePath: failedSource.sourceRoot,
          generationRoot: failedSource.generationRoot,
          markerDigest: 'marker-readiness-failure',
          plan: failedSource.plan,
          approvedInspection: failedSource.inspection,
          previousInspection: lastInspection,
          expectedEngine: identity,
          signal: new AbortController().signal,
          beforeActivation: async () => undefined
        });
      } catch (error) {
        readinessFailure = error as PreviewComposeActivationError;
      }
      expect(readinessFailure).toBeInstanceOf(PreviewComposeActivationError);
      expect(readinessFailure?.cleanupIncomplete).toBe(false);
      expect((await requiredProject(store, task.id)).containers).toEqual([]);
      expect(requiredVolume(await requiredProject(store, task.id), 'database-data').object)
        .toEqual(resetDataVolume.object);

      const retry = await apply(
        { revisionKey: 'REVISION_RETRY', scratchVolume: true, databaseCommand: true },
        { previous: lastInspection }
      );
      expect(await readDatabaseValues(engine, identity, retry.project)).toContain('post-reset-data');

      const beforeCancelProject = retry.project;
      const beforeController = new AbortController();
      beforeController.abort();
      const canceledBefore = prepareInspection(
        root,
        ++generation,
        inspector,
        identity,
        projectName,
        externalVolume,
        externalNetwork,
        { revisionKey: 'REVISION_CANCEL_BEFORE', scratchVolume: true, databaseCommand: true }
      );
      const beforeSource = await canceledBefore;
      await expect(runtime.apply({
        taskId: task.id,
        previewKey: 'real-compose-matrix',
        generationId: beforeSource.generationId,
        sourcePath: beforeSource.sourceRoot,
        generationRoot: beforeSource.generationRoot,
        markerDigest: 'marker-cancel-before',
        plan: beforeSource.plan,
        approvedInspection: beforeSource.inspection,
        previousInspection: retry.inspection,
        expectedEngine: identity,
        signal: beforeController.signal,
        beforeActivation: async () => { throw new Error('Activation must not begin.'); }
      })).rejects.toMatchObject({ name: 'AbortError' });
      const afterCancelBefore = await requiredProject(store, task.id);
      expect(afterCancelBefore.state).toBe('READY');
      expect(afterCancelBefore.containers).toEqual(beforeCancelProject.containers);
      expect(requiredVolume(afterCancelBefore, 'database-data').object).toEqual(resetDataVolume.object);

      const afterController = new AbortController();
      const afterSource = await prepareInspection(
        root,
        ++generation,
        inspector,
        identity,
        projectName,
        externalVolume,
        externalNetwork,
        { revisionKey: 'REVISION_CANCEL_AFTER', scratchVolume: true, databaseCommand: true }
      );
      await expect(runtime.apply({
        taskId: task.id,
        previewKey: 'real-compose-matrix',
        generationId: afterSource.generationId,
        sourcePath: afterSource.sourceRoot,
        generationRoot: afterSource.generationRoot,
        markerDigest: 'marker-cancel-after',
        plan: afterSource.plan,
        approvedInspection: afterSource.inspection,
        previousInspection: retry.inspection,
        expectedEngine: identity,
        signal: afterController.signal,
        beforeActivation: async () => { afterController.abort(); }
      })).rejects.toMatchObject({
        name: 'Error',
        activationStarted: true,
        cleanupIncomplete: false
      });
      expect((await requiredProject(store, task.id)).containers).toEqual([]);
      expect(requiredVolume(await requiredProject(store, task.id), 'database-data').object)
        .toEqual(resetDataVolume.object);

      const afterCancelRetry = await apply(
        { revisionKey: 'REVISION_FINAL', scratchVolume: true, databaseCommand: true },
        { previous: retry.inspection }
      );
      expect(await readDatabaseValues(engine, identity, afterCancelRetry.project)).toContain('post-reset-data');

      await runtime.shutdown();
      await expect(runtime.cleanupTask(task.id, { deleteData: true })).resolves.toBe('CLEANED');
      expect(await listProjectObjects(engine, identity, afterCancelRetry.project.id)).toEqual({
        containers: [], volumes: [], networks: []
      });
      expect(await externalIdentity(engine, identity, externalVolume, externalNetwork)).toEqual(externalBefore);
      for (const port of publishedPorts) await expect(canConnect(port)).resolves.toBe(false);
      const activeHandles = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles();
      expect(activeHandles.filter((handle) =>
        (handle as { constructor?: { name?: string } }).constructor?.name === 'ChildProcess'
      )).toEqual([]);
    } finally {
      await runtime.shutdown().catch(() => undefined);
      await runtime.cleanupTask(task.id, { deleteData: true }).catch(() => undefined);
      await forceRemoveProjectObjects(engine, identity, await store.getPreviewComposeProject(task.id));
      await engine.run(engine.contextArgs(identity.contextName, ['network', 'rm', externalNetwork])).catch(() => undefined);
      await engine.run(engine.contextArgs(identity.contextName, ['volume', 'rm', externalVolume])).catch(() => undefined);
    }
  }, 10 * 60_000);
});

interface ComposeVariant {
  revisionKey: string;
  scratchVolume?: boolean;
  databaseCommand?: boolean;
  appFails?: boolean;
}

function composePlan(): PreviewComposePlan {
  return {
    files: ['compose.yaml'],
    projectDirectory: '.',
    profiles: [],
    rootServices: ['app'],
    services: [{
      id: 'app',
      ports: { http: { target: 8080, protocol: 'tcp' } },
      ready: { type: 'tcp', port: 'http', timeoutSeconds: 30 }
    }]
  };
}

async function writeComposeSource(
  sourceRoot: string,
  externalVolume: string,
  externalNetwork: string,
  variant: ComposeVariant
): Promise<void> {
  const appVolumes = [`${externalVolume}:/external:ro`];
  if (variant.scratchVolume) appVolumes.push('scratch:/scratch:ro');
  const compose = {
    services: {
      db: {
        image: 'postgres:17-alpine',
        ...(variant.databaseCommand ? { command: ['postgres', '-c', 'max_connections=101'] } : {}),
        environment: { POSTGRES_PASSWORD_FILE: '/run/secrets/database-password' },
        secrets: ['database-password'],
        volumes: ['database-data:/var/lib/postgresql/data'],
        networks: ['default', externalNetwork],
        healthcheck: {
          test: ['CMD-SHELL', 'pg_isready -U postgres -d postgres'],
          interval: '1s', timeout: '5s', retries: 30, start_period: '2s'
        }
      },
      app: {
        image: 'alpine:3.21',
        command: variant.appFails
          ? ['sh', '-c', 'exit 23']
          : ['nc', '-lk', '-p', '8080'],
        depends_on: { db: { condition: 'service_healthy', required: true } },
        environment: { [variant.revisionKey]: 'enabled' },
        expose: [8080],
        volumes: appVolumes,
        networks: ['default', externalNetwork]
      }
    },
    secrets: { 'database-password': { file: './database-password.txt' } },
    volumes: {
      'database-data': {},
      ...(variant.scratchVolume ? { scratch: {} } : {}),
      [externalVolume]: { external: true }
    },
    networks: { default: {}, [externalNetwork]: { external: true } }
  };
  await fs.writeFile(path.join(sourceRoot, 'compose.yaml'), `${JSON.stringify(compose, null, 2)}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(sourceRoot, 'database-password.txt'), randomUUID(), { mode: 0o600 });
}

async function prepareInspection(
  root: string,
  generation: number,
  inspector: PreviewComposeInspector,
  identity: PreviewOciEngineIdentity,
  projectName: string,
  externalVolume: string,
  externalNetwork: string,
  variant: ComposeVariant
) {
  const generationId = `generation-${generation}`;
  const sourceRoot = path.join(root, 'sources', generationId);
  const generationRoot = path.join(root, 'generations', generationId);
  await fs.mkdir(sourceRoot, { recursive: true });
  await fs.mkdir(generationRoot, { recursive: true });
  const plan = composePlan();
  await writeComposeSource(sourceRoot, externalVolume, externalNetwork, variant);
  const inspection = await inspector.inspect({
    sourceRoot,
    contextName: identity.contextName,
    projectName,
    plan
  });
  return { generationId, sourceRoot, generationRoot, plan, inspection };
}

async function insertDatabaseValue(
  engine: OciEngineAdapter,
  identity: PreviewOciEngineIdentity,
  project: PreviewComposeProjectRecord,
  value: string
): Promise<void> {
  const container = requiredContainer(project, 'db').object.objectId!;
  await engine.run(engine.contextArgs(identity.contextName, [
    'exec', '--user', 'postgres', container,
    'psql', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres', '-c',
    `CREATE TABLE IF NOT EXISTS phase5_matrix(value text PRIMARY KEY); INSERT INTO phase5_matrix(value) VALUES ('${value}') ON CONFLICT DO NOTHING;`
  ]));
}

async function readDatabaseValues(
  engine: OciEngineAdapter,
  identity: PreviewOciEngineIdentity,
  project: PreviewComposeProjectRecord
): Promise<string[]> {
  const container = requiredContainer(project, 'db').object.objectId!;
  const output = await engine.run(engine.contextArgs(identity.contextName, [
    'exec', '--user', 'postgres', container,
    'psql', '-At', '-d', 'postgres', '-c',
    "SELECT value FROM phase5_matrix ORDER BY value;"
  ])).catch(() => ({ stdout: '', stderr: '' }));
  return output.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function requiredContainer(project: PreviewComposeProjectRecord, serviceId: string) {
  const container = project.containers.find((candidate) => candidate.serviceId === serviceId);
  if (!container) throw new Error(`Missing real Compose container for ${serviceId}.`);
  return container;
}

function requiredVolume(project: PreviewComposeProjectRecord, logicalName: string) {
  const volume = project.volumes.find((candidate) => candidate.logicalName === logicalName && !candidate.external);
  if (!volume?.object) throw new Error(`Missing real Compose volume for ${logicalName}.`);
  return volume;
}

async function requiredProject(store: FileTaskStore, taskId: string): Promise<PreviewComposeProjectRecord> {
  const project = await store.getPreviewComposeProject(taskId);
  if (!project) throw new Error('Real Compose project record is missing.');
  return project;
}

async function externalIdentity(
  engine: OciEngineAdapter,
  identity: PreviewOciEngineIdentity,
  volume: string,
  network: string
) {
  const volumeInspection = JSON.parse((await engine.run(engine.contextArgs(identity.contextName, [
    'volume', 'inspect', volume
  ]))).stdout)[0] as Record<string, unknown>;
  const networkInspection = JSON.parse((await engine.run(engine.contextArgs(identity.contextName, [
    'network', 'inspect', network
  ]))).stdout)[0] as Record<string, unknown>;
  return {
    volume: {
      name: volumeInspection.Name,
      driver: volumeInspection.Driver,
      labels: volumeInspection.Labels,
      options: volumeInspection.Options,
      scope: volumeInspection.Scope
    },
    network: {
      id: networkInspection.Id,
      name: networkInspection.Name,
      driver: networkInspection.Driver,
      labels: networkInspection.Labels,
      options: networkInspection.Options,
      internal: networkInspection.Internal,
      attachable: networkInspection.Attachable,
      scope: networkInspection.Scope
    }
  };
}

async function listProjectObjects(
  engine: OciEngineAdapter,
  identity: PreviewOciEngineIdentity,
  projectId: string
) {
  const label = `label=com.taskmonki.preview.compose-project=${projectId}`;
  const [containers, volumes, networks] = await Promise.all([
    engine.run(engine.contextArgs(identity.contextName, ['ps', '-aq', '--filter', label])),
    engine.run(engine.contextArgs(identity.contextName, ['volume', 'ls', '-q', '--filter', label])),
    engine.run(engine.contextArgs(identity.contextName, ['network', 'ls', '-q', '--filter', label]))
  ]);
  const lines = (value: string) => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return { containers: lines(containers.stdout), volumes: lines(volumes.stdout), networks: lines(networks.stdout) };
}

async function forceRemoveProjectObjects(
  engine: OciEngineAdapter,
  identity: PreviewOciEngineIdentity,
  project: PreviewComposeProjectRecord | undefined
): Promise<void> {
  if (!project) return;
  const objects = await listProjectObjects(engine, identity, project.id).catch(() => ({
    containers: [], volumes: [], networks: []
  }));
  for (const container of objects.containers) {
    await engine.run(engine.contextArgs(identity.contextName, ['container', 'rm', '--force', container])).catch(() => undefined);
  }
  for (const network of objects.networks) {
    await engine.run(engine.contextArgs(identity.contextName, ['network', 'rm', network])).catch(() => undefined);
  }
  for (const volume of objects.volumes) {
    await engine.run(engine.contextArgs(identity.contextName, ['volume', 'rm', volume])).catch(() => undefined);
  }
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (connected: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(connected);
    };
    const timer = setTimeout(() => finish(false), 1_000);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
