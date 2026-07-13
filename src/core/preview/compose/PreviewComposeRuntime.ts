import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  PreviewComposeChangeKind,
  PreviewComposeInspection,
  PreviewComposeNetworkRecord,
  PreviewComposePlan,
  PreviewComposeProjectRecord,
  PreviewComposeVolumeRecord,
  PreviewOciEngineIdentity,
  PreviewOciObjectIdentity,
  PreviewOciPublishedPort
} from '../../../shared/contracts';
import { FileTaskStore } from '../../storage/FileTaskStore';
import { PreviewReadinessService } from '../PreviewReadinessService';
import { OciEngineAdapter } from '../runtime/OciEngineAdapter';
import { classifyPreviewComposeChange } from './PreviewComposeChangePolicy';
import { PreviewComposeCliAdapter, type PreviewComposeCommand } from './PreviewComposeCliAdapter';
import { previewComposeProjectName } from './PreviewComposeIdentity';
import { PreviewComposeInspector } from './PreviewComposeInspector';

const PROJECT_LABEL = 'com.taskmonki.preview.compose-project';
const TASK_LABEL = 'com.taskmonki.preview.task';
const MARKER_LABEL = 'com.taskmonki.preview.marker';

export class PreviewComposeResetRequiredError extends Error {
  constructor(readonly reasons: string[]) {
    super(`Compose preview requires explicit data reset: ${reasons.join(' ')}`);
  }
}

export class PreviewComposeActivationError extends Error {
  constructor(
    readonly activationStarted: boolean,
    readonly cleanupIncomplete: boolean,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

export interface PreviewComposeApplyResult {
  project: PreviewComposeProjectRecord;
  change: PreviewComposeChangeKind;
  ports: Record<string, Record<string, number>>;
}

export class PreviewComposeRuntime {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly watches = new Map<string, { stop: () => Promise<void> }>();
  private readonly watchWork = new Set<Promise<void>>();

  constructor(
    private readonly store: FileTaskStore,
    private readonly cli: PreviewComposeCliAdapter,
    private readonly inspector: PreviewComposeInspector,
    private readonly engine: OciEngineAdapter,
    private readonly readiness = new PreviewReadinessService()
  ) {}

  apply(input: {
    taskId: string;
    previewKey: string;
    generationId: string;
    sourcePath: string;
    generationRoot: string;
    markerDigest: string;
    plan: PreviewComposePlan;
    approvedInspection: PreviewComposeInspection;
    previousInspection?: PreviewComposeInspection;
    expectedEngine: PreviewOciEngineIdentity;
    signal: AbortSignal;
    beforeActivation(): Promise<void>;
  }): Promise<PreviewComposeApplyResult> {
    return this.withTaskLock(input.taskId, () => this.applyOnce(input));
  }

  cleanupTask(taskId: string, options: { deleteData: boolean } = { deleteData: true }): Promise<'CLEANED' | 'REFUSED'> {
    return this.withTaskLock(taskId, () => this.cleanupTaskOnce(taskId, options));
  }

  async reconcile(): Promise<Set<string>> {
    const refusedTaskIds = new Set<string>();
    for (const project of await this.store.getPreviewComposeProjects()) {
      if (project.state === 'STOPPED') continue;
      if (await this.cleanupTask(project.taskId, { deleteData: true }) === 'REFUSED') {
        refusedTaskIds.add(project.taskId);
      }
    }
    return refusedTaskIds;
  }

  async watch(
    taskId: string,
    onFailure: (reason: string) => Promise<void>
  ): Promise<() => Promise<void>> {
    await this.stopWatch(taskId);
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let inFlight: Promise<void> = Promise.resolve();
    const stop = async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight.catch(() => undefined);
    };
    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(() => {
        const work = check();
        inFlight = work;
        this.watchWork.add(work);
        void work.then(
          () => this.watchWork.delete(work),
          () => this.watchWork.delete(work)
        );
      }, 5_000);
    };
    const check = async () => {
      const fail = async (reason: string) => {
        if (stopped) return;
        stopped = true;
        if (timer) clearTimeout(timer);
        if (this.watches.get(taskId)?.stop === stop) this.watches.delete(taskId);
        await onFailure(reason);
      };
      try {
        const project = await this.store.getPreviewComposeProject(taskId);
        if (!project || project.state !== 'READY') return;
        await this.engine.requireReady(project.engine);
        for (const container of project.containers) {
          const inspection = await this.inspectObject('container', container.object.objectId!, project.engine.contextName);
          this.assertOwnedInspection('container', inspection, container.object, expectedLabels(project));
          const state = asRecord(inspection.State, 'container state');
          if (state.Running !== true || state.Paused === true || state.Restarting === true) {
            await fail(`Compose service ${container.serviceId} is no longer running.`);
            return;
          }
        }
      } catch {
        await fail('Compose project health or ownership could not be verified.');
        return;
      }
      schedule();
    };
    this.watches.set(taskId, { stop });
    schedule();
    return async () => {
      await stop();
      if (this.watches.get(taskId)?.stop === stop) this.watches.delete(taskId);
    };
  }

  async stopWatch(taskId: string): Promise<void> {
    const watch = this.watches.get(taskId);
    if (!watch) return;
    await watch.stop();
    if (this.watches.get(taskId) === watch) this.watches.delete(taskId);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.watches.keys()].map((taskId) => this.stopWatch(taskId)));
    await Promise.allSettled([...this.watchWork]);
    await Promise.allSettled([...this.locks.values()]);
  }

  private async applyOnce(input: Parameters<PreviewComposeRuntime['apply']>[0]): Promise<PreviewComposeApplyResult> {
    await this.engine.requireReady(input.expectedEngine);
    const projectName = previewComposeProjectName(input.taskId);
    const inspected = await this.inspector.inspect({
      sourceRoot: input.sourcePath,
      contextName: input.expectedEngine.contextName,
      projectName,
      plan: { ...input.plan, inspection: undefined }
    });
    if (
      inspected.trustDigest !== input.approvedInspection.trustDigest ||
      inspected.configDigest !== input.approvedInspection.configDigest
    ) {
      throw new Error('Captured Compose authority no longer matches the approved plan.');
    }
    const decision = classifyPreviewComposeChange(input.previousInspection, inspected);
    if (decision.kind === 'DESTRUCTIVE_RESET_REQUIRED') {
      throw new PreviewComposeResetRequiredError(decision.reasons);
    }
    const priorProject = await this.store.getPreviewComposeProject(input.taskId);
    const existing = priorProject?.state === 'STOPPED' ? undefined : priorProject;
    const now = new Date().toISOString();
    const newProjectId = existing ? undefined : randomUUID();
    let project: PreviewComposeProjectRecord = existing ?? {
      id: newProjectId!,
      taskId: input.taskId,
      previewKey: input.previewKey,
      projectName,
      state: 'INTENDED',
      engine: input.expectedEngine,
      composeVersion: inspected.composeVersion,
      trustDigest: inspected.trustDigest,
      configDigest: inspected.configDigest,
      ownershipMarkerDigest: sha256(`${input.taskId}:${projectName}:${newProjectId}`),
      containers: [],
      volumes: [],
      networks: [],
      createdAt: now,
      updatedAt: now
    };
    assertSameEngine(project.engine, input.expectedEngine);
    project = await this.saveProject({
      ...project,
      state: existing ? 'PREPARING_UPDATE' : 'STARTING',
      pendingGenerationId: input.generationId,
      composeVersion: inspected.composeVersion,
      trustDigest: inspected.trustDigest,
      configDigest: inspected.configDigest,
      ownershipMarkerDigest: existing?.ownershipMarkerDigest ?? project.ownershipMarkerDigest,
      failureReason: undefined
    });
    const overridePath = path.join(input.generationRoot, 'compose.taskmonki.override.json');
    await fs.writeFile(overridePath, `${JSON.stringify(createOverride(project, input.plan, inspected), null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx'
    });
    const projectDirectory = path.resolve(input.sourcePath, input.plan.projectDirectory);
    const command: PreviewComposeCommand = {
      contextName: input.expectedEngine.contextName,
      projectName,
      projectDirectory,
      files: [
        ...input.plan.files.map((file) => path.resolve(projectDirectory, file)),
        overridePath
      ],
      profiles: input.plan.profiles,
      envFile: path.join(path.dirname(overridePath), '.compose-empty.env')
    };
    await fs.writeFile(command.envFile, '', { mode: 0o600, flag: 'wx' });
    let activationStarted = false;
    try {
      if (inspected.services.some((service) => service.build)) {
        await this.cli.run(command, ['build', ...input.plan.rootServices], {
          timeoutMs: 10 * 60_000,
          signal: input.signal
        });
      }
      throwIfAborted(input.signal);
      await input.beforeActivation();
      activationStarted = true;
      await this.stopWatch(input.taskId);
      project = await this.saveProject({
        ...project,
        state: decision.kind === 'IN_PLACE_UPDATE' ? 'UPDATING' : 'RESTARTING'
      });
      if (decision.kind === 'RESTART_PRESERVE_DATA') {
        await this.removeVerifiedContainers(project);
      } else {
        await this.removeObsoleteContainers(project, new Set(inspected.services.map((service) => service.id)));
      }
      throwIfAborted(input.signal);
      await this.cli.run(command, [
        'up', '--detach', '--wait', '--wait-timeout', '60', '--pull', 'missing', '--no-build',
        ...input.plan.rootServices
      ], { timeoutMs: 10 * 60_000, signal: input.signal });
      throwIfAborted(input.signal);
      const observed = await this.collectProjectObjects(project, inspected);
      project = await this.saveProject({ ...project, ...observed });
      const ports = await this.resolvePorts(command, input.plan, input.signal);
      project = await this.saveProject({
        ...project,
        state: 'READY',
        activeGenerationId: input.generationId,
        pendingGenerationId: undefined,
        failureReason: undefined
      });
      return { project, change: decision.kind, ports };
    } catch (error) {
      if (!activationStarted) {
        project = await this.saveProject(existing
          ? { ...existing, pendingGenerationId: undefined, failureReason: safeFailure(error) }
          : {
              ...project,
              state: 'RECOVERY_REQUIRED',
              pendingGenerationId: undefined,
              failureReason: safeFailure(error)
            });
        throw error;
      }
      let containersRemoved = false;
      try {
        const observed = await this.collectProjectObjects(project, inspected);
        project = await this.saveProject({ ...project, ...observed });
        await this.removeVerifiedContainers(project);
        containersRemoved = true;
      } catch {
        // The durable project record remains cleanup authority for an explicit retry.
      }
      await this.saveProject({
        ...project,
        state: 'RECOVERY_REQUIRED',
        containers: containersRemoved ? [] : project.containers,
        activeGenerationId: undefined,
        pendingGenerationId: undefined,
        failureReason: safeFailure(error)
      });
      throw new PreviewComposeActivationError(
        true,
        !containersRemoved,
        'Compose activation failed after the stable project began changing; verified data volumes were preserved.',
        { cause: error }
      );
    }
  }

  private async cleanupTaskOnce(
    taskId: string,
    options: { deleteData: boolean }
  ): Promise<'CLEANED' | 'REFUSED'> {
    await this.stopWatch(taskId);
    let project = await this.store.getPreviewComposeProject(taskId);
    if (!project || project.state === 'STOPPED') return 'CLEANED';
    project = await this.saveProject({
      ...project,
      state: 'STOPPING',
      cleanupAttemptedAt: new Date().toISOString()
    });
    try {
      await this.engine.requireReady(project.engine);
      const discovered = await this.collectProjectObjects(project);
      project = await this.saveProject({
        ...project,
        containers: mergeRecords(
          project.containers,
          discovered.containers,
          (container) => container.object.objectId ?? ''
        ),
        volumes: mergeRecords(
          project.volumes,
          discovered.volumes,
          (volume) => volume.object?.objectId ?? `external:${volume.logicalName}`
        ),
        networks: mergeRecords(
          project.networks,
          discovered.networks,
          (network) => network.object?.objectId ?? `external:${network.logicalName}`
        )
      });
      await this.removeVerifiedContainers(project);
      if (options.deleteData) {
        for (const volume of project.volumes) {
          if (!volume.external && volume.object) await this.removeVerifiedObject('volume', volume.object, project);
        }
      }
      for (const network of project.networks) {
        if (!network.external && network.object) await this.removeVerifiedObject('network', network.object, project);
      }
      await this.saveProject({
        ...project,
        state: options.deleteData ? 'STOPPED' : 'RECOVERY_REQUIRED',
        containers: [],
        volumes: options.deleteData ? [] : project.volumes,
        networks: [],
        activeGenerationId: undefined,
        pendingGenerationId: undefined,
        cleanupError: undefined,
        stoppedAt: options.deleteData ? new Date().toISOString() : undefined
      });
      return 'CLEANED';
    } catch (error) {
      await this.saveProject({
        ...project,
        state: 'CLEANUP_INCOMPLETE',
        cleanupError: safeFailure(error)
      });
      return 'REFUSED';
    }
  }

  private async resolvePorts(
    command: PreviewComposeCommand,
    plan: PreviewComposePlan,
    signal: AbortSignal
  ): Promise<Record<string, Record<string, number>>> {
    const result: Record<string, Record<string, number>> = {};
    for (const service of plan.services) {
      result[service.id] = {};
      for (const [name, port] of Object.entries(service.ports)) {
        throwIfAborted(signal);
        const output = await this.cli.run(
          command,
          ['port', service.id, String(port.target)],
          { signal }
        );
        const match = /^(?:127\.0\.0\.1|\[::1\]):(\d+)\s*$/.exec(output.stdout);
        if (!match) throw new Error(`Compose service ${service.id} port is not published on loopback.`);
        const hostPort = Number(match[1]);
        result[service.id][name] = hostPort;
        const readiness = service.ready;
        if (!readiness) continue;
        const observed = readiness.type === 'http'
          ? await this.readiness.waitForHttp({
              port: hostPort,
              path: readiness.path,
              timeoutMs: readiness.timeoutSeconds * 1000,
              signal
            })
          : await this.readiness.waitForTcp({
              port: hostPort,
              timeoutMs: readiness.timeoutSeconds * 1000,
              signal
            });
        if (observed.status !== 'PASSED') {
          throw new Error(`Compose service ${service.id} did not pass Task Monki readiness.`);
        }
      }
    }
    return result;
  }

  private async collectProjectObjects(
    project: PreviewComposeProjectRecord,
    inspection?: PreviewComposeInspection
  ): Promise<Pick<PreviewComposeProjectRecord, 'containers' | 'volumes' | 'networks'>> {
    const labels = expectedLabels(project);
    const containerIds = await this.listOwned('ps', project, ['-a']);
    const containers = [];
    for (const id of containerIds) {
      const inspected = await this.inspectObject('container', id, project.engine.contextName);
      const object = this.objectIdentity('container', inspected, project.engine, labels);
      const actualLabels = readLabels(inspected, 'container');
      const serviceId = String(actualLabels['com.docker.compose.service'] ?? '');
      if (!serviceId) throw new Error('Owned Compose container has no service identity.');
      containers.push({ serviceId, object });
    }
    const activeVolumes = new Set(
      inspection
        ? inspection.volumes.filter((volume) => !volume.external).map((volume) => volume.name)
        : project.volumes.filter((volume) => !volume.external && volume.state === 'ACTIVE').map((volume) => volume.logicalName)
    );
    const retainedById = new Map(project.volumes.filter((volume) => volume.object).map((volume) => [volume.object!.objectId, volume]));
    const volumeIds = await this.listOwned('volume', project);
    const volumes: PreviewComposeVolumeRecord[] = [];
    for (const id of volumeIds) {
      const inspected = await this.inspectObject('volume', id, project.engine.contextName);
      const object = this.objectIdentity('volume', inspected, project.engine, labels);
      const logicalName = String(readLabels(inspected, 'volume')['com.docker.compose.volume'] ?? retainedById.get(object.objectId)?.logicalName ?? '');
      if (!logicalName) throw new Error('Owned Compose volume has no logical identity.');
      volumes.push({ logicalName, external: false, state: activeVolumes.has(logicalName) ? 'ACTIVE' : 'RETAINED', object });
    }
    volumes.push(...(inspection?.volumes ?? []).filter((volume) => volume.external).map((volume) => ({
      logicalName: volume.name, external: true, state: 'ACTIVE' as const
    })));
    const networkIds = await this.listOwned('network', project);
    const networks: PreviewComposeNetworkRecord[] = [];
    for (const id of networkIds) {
      const inspected = await this.inspectObject('network', id, project.engine.contextName);
      const object = this.objectIdentity('network', inspected, project.engine, labels);
      const logicalName = String(readLabels(inspected, 'network')['com.docker.compose.network'] ?? '');
      if (!logicalName) throw new Error('Owned Compose network has no logical identity.');
      networks.push({ logicalName, external: false, object });
    }
    networks.push(...(inspection?.networks ?? []).filter((network) => network.external).map((network) => ({
      logicalName: network.name, external: true
    })));
    return { containers, volumes, networks };
  }

  private async listOwned(
    kind: 'ps' | 'volume' | 'network',
    project: PreviewComposeProjectRecord,
    extra: string[] = []
  ): Promise<string[]> {
    const argv = kind === 'ps'
      ? ['--context', project.engine.contextName, 'ps', ...extra, '--filter', `label=${PROJECT_LABEL}=${project.id}`, '--format', '{{.ID}}']
      : ['--context', project.engine.contextName, kind, 'ls', '-q', '--filter', `label=${PROJECT_LABEL}=${project.id}`];
    const output = await this.engine.run(argv);
    return output.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }

  private async removeObsoleteContainers(project: PreviewComposeProjectRecord, configured: Set<string>): Promise<void> {
    for (const container of project.containers) {
      if (!configured.has(container.serviceId)) {
        await this.removeVerifiedObject('container', container.object, project);
      }
    }
  }

  private async removeVerifiedContainers(project: PreviewComposeProjectRecord): Promise<void> {
    for (const container of project.containers) {
      await this.removeVerifiedObject('container', container.object, project);
    }
  }

  private async removeVerifiedObject(
    kind: 'container' | 'volume' | 'network',
    object: PreviewOciObjectIdentity,
    project: PreviewComposeProjectRecord
  ): Promise<void> {
    if (!object.objectId) throw new Error(`Compose ${kind} cleanup lacks an exact object ID.`);
    let inspection: Record<string, unknown>;
    try {
      inspection = await this.inspectObject(kind, object.objectId, project.engine.contextName);
    } catch (error) {
      if (!await this.objectExists(kind, object.objectId, project.engine.contextName)) return;
      throw error;
    }
    this.assertOwnedInspection(kind, inspection, object, expectedLabels(project));
    if (kind === 'container') {
      await this.engine.run(['--context', project.engine.contextName, 'container', 'stop', '--time', '10', object.objectId]);
      await this.engine.run(['--context', project.engine.contextName, 'container', 'rm', object.objectId]);
    } else {
      await this.engine.run(['--context', project.engine.contextName, kind, 'rm', object.objectId]);
    }
    if (await this.objectExists(kind, object.objectId, project.engine.contextName)) {
      throw new Error(`Compose ${kind} cleanup could not verify exact absence.`);
    }
  }

  private async objectExists(
    kind: 'container' | 'volume' | 'network',
    objectId: string,
    contextName: string
  ): Promise<boolean> {
    const argv = kind === 'container'
      ? ['--context', contextName, 'container', 'ls', '-aq', '--no-trunc']
      : ['--context', contextName, kind, 'ls', '-q'];
    const output = await this.engine.run(argv);
    return output.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).some((id) =>
      id === objectId || id.startsWith(objectId) || objectId.startsWith(id)
    );
  }

  private inspectObject(
    kind: 'container' | 'volume' | 'network',
    id: string,
    contextName: string
  ): Promise<Record<string, unknown>> {
    return this.engine.run(['--context', contextName, kind, 'inspect', id]).then((output) => {
      const parsed = JSON.parse(output.stdout) as unknown;
      if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error('Compose object inspection returned invalid data.');
      return asRecord(parsed[0], 'Compose object inspection');
    });
  }

  private objectIdentity(
    kind: 'container' | 'volume' | 'network',
    inspected: Record<string, unknown>,
    engine: PreviewOciEngineIdentity,
    labels: Record<string, string>
  ): PreviewOciObjectIdentity {
    const objectId = String(inspected.Id ?? inspected.ID ?? inspected.Name ?? '');
    if (!objectId) throw new Error(`Compose ${kind} has no exact object identity.`);
    const object: PreviewOciObjectIdentity = {
      engine,
      objectId,
      objectName: String(inspected.Name ?? objectId).replace(/^\//, ''),
      labelsDigest: digestLabels(labels),
      imageId: kind === 'container' ? String(inspected.Image ?? '') || undefined : undefined,
      publishedPorts: kind === 'container' ? readPublishedPorts(inspected) : undefined
    };
    this.assertOwnedInspection(kind, inspected, object, labels);
    return object;
  }

  private assertOwnedInspection(
    kind: 'container' | 'volume' | 'network',
    inspected: Record<string, unknown>,
    object: PreviewOciObjectIdentity,
    labels: Record<string, string>
  ): void {
    const actualId = String(inspected.Id ?? inspected.ID ?? inspected.Name ?? '');
    if (!object.objectId || !actualId.startsWith(object.objectId) || object.labelsDigest !== digestLabels(labels)) {
      throw new Error(`Compose ${kind} exact identity does not match.`);
    }
    const actual = readLabels(inspected, kind);
    for (const [key, value] of Object.entries(labels)) {
      if (actual[key] !== value) throw new Error(`Compose ${kind} ownership labels do not match.`);
    }
  }

  private saveProject(project: PreviewComposeProjectRecord): Promise<PreviewComposeProjectRecord> {
    return this.store.savePreviewComposeProject({ ...project, updatedAt: new Date().toISOString() });
  }

  private async withTaskLock<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(taskId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(action);
    this.locks.set(taskId, operation);
    try { return await operation; }
    finally { if (this.locks.get(taskId) === operation) this.locks.delete(taskId); }
  }
}

function createOverride(
  project: PreviewComposeProjectRecord,
  plan: PreviewComposePlan,
  inspection: PreviewComposeInspection
): Record<string, unknown> {
  const labels = expectedLabels(project);
  const servicePlans = new Map(plan.services.map((service) => [service.id, service]));
  const services = Object.fromEntries(inspection.services.map((service) => {
    const exposed = servicePlans.get(service.id);
    return [service.id, {
      labels,
      ...(exposed ? {
        ports: Object.values(exposed.ports).map((port) => ({
          target: port.target,
          published: '0',
          host_ip: '127.0.0.1',
          protocol: 'tcp'
        }))
      } : {})
    }];
  }));
  const volumes = Object.fromEntries(inspection.volumes.filter((volume) => !volume.external).map((volume) => [
    volume.name,
    { labels }
  ]));
  const networks = Object.fromEntries(inspection.networks.filter((network) => !network.external).map((network) => [
    network.name,
    { labels }
  ]));
  return { services, volumes, networks };
}

function expectedLabels(project: Pick<PreviewComposeProjectRecord, 'id' | 'taskId' | 'ownershipMarkerDigest'>): Record<string, string> {
  return {
    [PROJECT_LABEL]: project.id,
    [TASK_LABEL]: sha256(project.taskId),
    [MARKER_LABEL]: project.ownershipMarkerDigest
  };
}

function readLabels(
  inspected: Record<string, unknown>,
  kind: 'container' | 'volume' | 'network'
): Record<string, string> {
  const raw = kind === 'container'
    ? asRecord(asRecord(inspected.Config, 'container config').Labels, 'container labels')
    : asRecord(inspected.Labels, `${kind} labels`);
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, String(value)]));
}

function readPublishedPorts(inspected: Record<string, unknown>): PreviewOciPublishedPort[] {
  const ports = asRecord(asRecord(inspected.NetworkSettings, 'network settings').Ports, 'published ports');
  const result: PreviewOciPublishedPort[] = [];
  for (const [key, bindings] of Object.entries(ports)) {
    if (!bindings) continue;
    const match = /^(\d+)\/(tcp|udp)$/.exec(key);
    if (!match || !Array.isArray(bindings)) throw new Error('Compose container has invalid published ports.');
    for (const binding of bindings) {
      const record = asRecord(binding, 'published port');
      if (record.HostIp !== '127.0.0.1') throw new Error('Compose container published a non-loopback port.');
      result.push({
        containerPort: Number(match[1]),
        protocol: match[2] as 'tcp' | 'udp',
        hostIp: '127.0.0.1',
        hostPort: Number(record.HostPort)
      });
    }
  }
  return result;
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${context} is invalid.`);
  return value as Record<string, unknown>;
}

function digestLabels(labels: Record<string, string>): string {
  return sha256(JSON.stringify(Object.fromEntries(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)))));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeFailure(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ').slice(0, 512);
}

function assertSameEngine(expected: PreviewOciEngineIdentity, actual: PreviewOciEngineIdentity): void {
  if (
    expected.contextName !== actual.contextName ||
    expected.endpointDigest !== actual.endpointDigest ||
    expected.engineId !== actual.engineId
  ) throw new Error('Compose project engine authority no longer matches the approved engine.');
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error('Compose preview activation canceled.');
  error.name = 'AbortError';
  throw error;
}

function mergeRecords<T>(recorded: T[], discovered: T[], key: (record: T) => string): T[] {
  const records = new Map<string, T>();
  for (const record of recorded) records.set(key(record), record);
  for (const record of discovered) records.set(key(record), record);
  return [...records.values()];
}
