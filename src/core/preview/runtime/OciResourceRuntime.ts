import { randomUUID } from 'node:crypto';
import type {
  PreviewOciEngineIdentity,
  PreviewOciObjectIdentity,
  PreviewOciResourcePlan,
  PreviewOciResourceRecord,
  PreviewOciPublishedPort
} from '../../../shared/contracts';
import { FileTaskStore } from '../../storage/FileTaskStore';
import { PreviewReadinessService } from '../PreviewReadinessService';
import { OciEngineAdapter, OciEngineError } from './OciEngineAdapter';
import {
  asRecord,
  boundedError,
  buildBinding,
  cleanupRank,
  delay,
  digestLabels,
  expectedLabels,
  generatedCredentials,
  isArchitectureMismatch,
  labelArgs,
  limitArgs,
  objectCliType,
  objectName,
  ownershipLabels,
  readLabels,
  resourceCommand,
  resourceLiteralEnv,
  resourcePorts,
  resourceVolumeMount,
  sameLabels,
  throwIfAborted,
  type OciAdapterKind
} from './OciResourceRuntimeSupport';

const PULL_TIMEOUT_MS = 5 * 60_000;
const MUTATION_TIMEOUT_MS = 60_000;
const MAX_DISCOVERED_OBJECTS = 2;

export type OciRuntimeErrorCode =
  | 'ENGINE_MISSING'
  | 'ENGINE_UNAVAILABLE'
  | 'UNSUPPORTED_ENGINE'
  | 'ENGINE_IDENTITY_MISMATCH'
  | 'IMAGE_PULL_FAILED'
  | 'IMAGE_ARCHITECTURE_MISMATCH'
  | 'CREATE_FAILED'
  | 'UNHEALTHY_CONTAINER'
  | 'CLEANUP_FAILED';

export class OciRuntimeError extends Error {
  constructor(readonly code: OciRuntimeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export interface OciResourceBinding {
  ports: Record<string, number>;
  postgresUrl?: string;
  redisUrl?: string;
}

export interface RunningOciGeneration {
  startResource(resource: PreviewOciResourcePlan, signal?: AbortSignal): Promise<OciResourceBinding>;
  stop(): Promise<'STOPPED' | 'ALREADY_EXITED' | 'REFUSED'>;
}

export interface OciResourceRuntimeHooks {
  afterMutation?(operation: 'network-create' | 'volume-create' | 'container-create'): Promise<void> | void;
}

interface GenerationContext {
  taskId: string;
  generationId: string;
  markerDigest: string;
  engine: PreviewOciEngineIdentity;
  network: PreviewOciResourceRecord;
  adoptedGenerationVolumes: PreviewOciResourceRecord[];
}

export class OciResourceRuntime {
  constructor(
    private readonly store: FileTaskStore,
    private readonly engine: OciEngineAdapter,
    private readonly readiness: PreviewReadinessService,
    private readonly hooks: OciResourceRuntimeHooks = {}
  ) {}

  async startGeneration(input: {
    taskId: string;
    generationId: string;
    markerDigest: string;
    expectedEngine: PreviewOciEngineIdentity;
  }): Promise<RunningOciGeneration> {
    const capability = await this.requireEngine(input.expectedEngine);
    const context: GenerationContext = {
      ...input,
      engine: capability.identity,
      adoptedGenerationVolumes: [],
      network: await this.createObject({
        ...input,
        engine: capability.identity,
        logicalNodeId: '__network',
        kind: 'OCI_NETWORK',
        operation: 'network-create',
        createArgs: (name, labels) => ['network', 'create', ...labelArgs(labels), name]
      })
    };
    let stopOperation: Promise<'STOPPED' | 'ALREADY_EXITED' | 'REFUSED'> | undefined;
    return {
      startResource: (resource, signal) => this.startResource(context, resource, signal),
      stop: () => stopOperation ??= this.stopGenerationContext(context)
    };
  }

  async stopGeneration(generationId: string): Promise<'STOPPED' | 'ALREADY_EXITED' | 'REFUSED'> {
    const resources = await this.store.getPreviewResources(generationId);
    let result: 'STOPPED' | 'ALREADY_EXITED' | 'REFUSED' = resources.length === 0 ? 'ALREADY_EXITED' : 'STOPPED';
    const ordered = [...resources].sort((left, right) => cleanupRank(left) - cleanupRank(right));
    for (const resource of ordered) {
      if (resource.adapterKind === 'NATIVE_PROCESS' || resource.state === 'STOPPED') continue;
      if (
        resource.adapterKind === 'OCI_VOLUME' &&
        (resource.oci.scope === 'preview' || resource.oci.retainedForReset)
      ) continue;
      const stopped = await this.stop(resource).catch(() => 'REFUSED' as const);
      if (stopped === 'REFUSED') result = 'REFUSED';
    }
    return result;
  }

  async cleanupTaskResources(taskId?: string): Promise<'STOPPED' | 'ALREADY_EXITED' | 'REFUSED'> {
    const resources = (await this.store.getPreviewResources())
      .filter((resource): resource is PreviewOciResourceRecord =>
        resource.adapterKind !== 'NATIVE_PROCESS' &&
        (!taskId || resource.taskId === taskId) &&
        resource.state !== 'STOPPED'
      )
      .sort((left, right) => cleanupRank(left) - cleanupRank(right));
    let result: 'STOPPED' | 'ALREADY_EXITED' | 'REFUSED' = resources.length ? 'STOPPED' : 'ALREADY_EXITED';
    for (const resource of resources) {
      if (await this.stop(resource) === 'REFUSED') result = 'REFUSED';
    }
    return result;
  }

  async resetDataResource(
    taskId: string,
    logicalNodeId: string
  ): Promise<'STOPPED' | 'ALREADY_EXITED' | 'REFUSED'> {
    const resources = (await this.store.getPreviewResources())
      .filter((resource): resource is PreviewOciResourceRecord =>
        resource.adapterKind === 'OCI_VOLUME' &&
        resource.taskId === taskId &&
        resource.logicalNodeId === logicalNodeId &&
        resource.state !== 'STOPPED'
      );
    if (resources.length > 1) {
      throw new Error(`Preview data ownership is ambiguous for ${logicalNodeId}.`);
    }
    return resources[0] ? this.stop(resources[0]) : 'ALREADY_EXITED';
  }

  async prepareDataReset(generationId: string): Promise<void> {
    for (const resource of await this.store.getPreviewResources(generationId)) {
      if (
        resource.adapterKind !== 'OCI_VOLUME' ||
        resource.state === 'STOPPED'
      ) continue;
      await this.store.savePreviewResource({
        ...resource,
        oci: { ...resource.oci, retainedForReset: true },
        updatedAt: new Date().toISOString()
      });
    }
  }

  private async stopGenerationContext(
    context: GenerationContext
  ): Promise<'STOPPED' | 'ALREADY_EXITED' | 'REFUSED'> {
    let result = await this.stopGeneration(context.generationId);
    for (const volume of context.adoptedGenerationVolumes) {
      const stopped = await this.stop(volume).catch(() => 'REFUSED' as const);
      if (stopped === 'REFUSED') result = 'REFUSED';
      else if (result === 'ALREADY_EXITED') result = 'STOPPED';
    }
    return result;
  }

  async stop(resource: PreviewOciResourceRecord): Promise<'STOPPED' | 'ALREADY_EXITED' | 'REFUSED'> {
    const now = new Date().toISOString();
    try {
      await this.requireEngine(resource.oci.engine);
      const objectId = resource.oci.objectId ?? await this.discoverExactObject(resource);
      if (!objectId) {
        await this.store.savePreviewResource({
          ...resource,
          state: 'STOPPED',
          cleanupAttemptedAt: now,
          updatedAt: now
        });
        return 'ALREADY_EXITED';
      }
      await this.assertExactOwnership(resource, objectId);
      await this.removeObject(resource.adapterKind, objectId, resource.oci.engine.contextName);
      await this.store.savePreviewResource({
        ...resource,
        state: 'STOPPED',
        oci: { ...resource.oci, objectId },
        cleanupAttemptedAt: now,
        cleanupError: undefined,
        updatedAt: now
      });
      return 'STOPPED';
    } catch (error) {
      await this.store.savePreviewResource({
        ...resource,
        state: 'CLEANUP_INCOMPLETE',
        cleanupAttemptedAt: now,
        cleanupError: boundedError(error),
        updatedAt: now
      });
      return 'REFUSED';
    }
  }

  private async startResource(
    context: GenerationContext,
    resource: PreviewOciResourcePlan,
    signal?: AbortSignal
  ): Promise<OciResourceBinding> {
    throwIfAborted(signal);
    const credentials = generatedCredentials(resource);
    const volume = resourceVolumeMount(resource)
      ? await this.findReusableVolume(context, resource) ?? (resource.scope === 'preview'
        ? await this.createObject({
            ...context,
            logicalNodeId: resource.id,
            kind: 'OCI_VOLUME',
            scope: 'preview',
            operation: 'volume-create',
            createArgs: (name, labels) => ['volume', 'create', ...labelArgs(labels), name]
          })
        : await this.createObject({
          ...context,
          logicalNodeId: resource.id,
          kind: 'OCI_VOLUME',
          scope: 'generation',
          operation: 'volume-create',
          createArgs: (name, labels) => ['volume', 'create', ...labelArgs(labels), name]
        }))
      : undefined;
    throwIfAborted(signal);
    const contextArgs = ['--context', context.engine.contextName];
    let imageId = await this.inspectLocalImage(contextArgs, resource.image);
    if (!imageId) {
      try {
        await this.engine.run(
          [...contextArgs, 'pull', resource.image],
          this.engine.environment(),
          { timeoutMs: PULL_TIMEOUT_MS }
        );
      } catch (error) {
        if (isArchitectureMismatch(error)) {
          throw new OciRuntimeError(
            'IMAGE_ARCHITECTURE_MISMATCH',
            `OCI image architecture is incompatible for ${resource.id}: ${boundedError(error)}`,
            { cause: error }
          );
        }
        throw new OciRuntimeError(
          'IMAGE_PULL_FAILED',
          `OCI image pull failed for ${resource.id}: ${boundedError(error)}`,
          { cause: error }
        );
      }
      imageId = await this.inspectLocalImage(contextArgs, resource.image);
    }
    if (!imageId) throw new OciRuntimeError('IMAGE_PULL_FAILED', `OCI image ${resource.image} has no image ID.`);

    const ports = resourcePorts(resource);
    const env = this.engine.environment({
      ...credentials.environment,
      ...resourceLiteralEnv(resource)
    });
    let container: PreviewOciResourceRecord;
    try {
      container = await this.createObject({
        ...context,
        logicalNodeId: resource.id,
        kind: 'OCI_CONTAINER',
        scope: 'generation',
        operation: 'container-create',
        imageReference: resource.image,
        imageId,
        createArgs: (name, labels) => [
          'container', 'create', '--name', name,
          ...labelArgs(labels),
          '--network', context.network.oci.objectId!,
          ...limitArgs(resource),
          ...Object.keys({ ...credentials.environment, ...resourceLiteralEnv(resource) })
            .sort().flatMap((key) => ['--env', key]),
          ...Object.values(ports).flatMap((port) => [
            '--publish', `127.0.0.1::${port.containerPort}/${port.protocol}`
          ]),
          ...(volume ? ['--mount', `type=volume,src=${volume.oci.objectId},dst=${resourceVolumeMount(resource)}`] : []),
          imageId,
          ...resourceCommand(resource)
        ],
        env
      });
      await this.engine.run([...contextArgs, 'container', 'start', container.oci.objectId!]);
    } catch (error) {
      if (error instanceof OciRuntimeError) throw error;
      if (isArchitectureMismatch(error)) {
        throw new OciRuntimeError(
          'IMAGE_ARCHITECTURE_MISMATCH',
          `OCI image architecture is incompatible for ${resource.id}: ${boundedError(error)}`,
          { cause: error }
        );
      }
      throw new OciRuntimeError(
        'CREATE_FAILED',
        `OCI container creation failed for ${resource.id}: ${boundedError(error)}`,
        { cause: error }
      );
    }

    const publishedPorts = await this.waitForPublishedPorts(
      container,
      Object.keys(ports).length,
      signal
    );
    container = await this.store.savePreviewResource({
      ...container,
      state: 'RUNNING',
      oci: { ...container.oci, publishedPorts },
      targetHost: '127.0.0.1',
      targetPort: publishedPorts[0]?.hostPort,
      updatedAt: new Date().toISOString()
    });
    const binding = buildBinding(resource, credentials, ports, publishedPorts);
    try {
      await this.waitUntilReady(resource, binding, container, credentials.environment, signal);
    } catch (error) {
      await this.store.savePreviewResource({
        ...container,
        state: 'FAILED',
        updatedAt: new Date().toISOString()
      });
      throw new OciRuntimeError(
        'UNHEALTHY_CONTAINER',
        `OCI resource ${resource.id} did not become healthy: ${boundedError(error)}`,
        { cause: error }
      );
    }
    return binding;
  }

  private async inspectLocalImage(contextArgs: string[], image: string): Promise<string | undefined> {
    try {
      return (await this.engine.run([
        ...contextArgs, 'image', 'inspect', '--format', '{{.Id}}', image
      ])).stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private async waitUntilReady(
    resource: PreviewOciResourcePlan,
    binding: OciResourceBinding,
    container: PreviewOciResourceRecord,
    credentials: Record<string, string>,
    signal?: AbortSignal
  ): Promise<void> {
    const timeoutSeconds = resource.type === 'oci' ? resource.ready.timeoutSeconds : 60;
    const portId = resource.type === 'oci' ? resource.ready.port : resource.type === 'postgres' ? 'postgres' : 'redis';
    const port = binding.ports[portId];
    const readiness = resource.type === 'oci' && resource.ready.type === 'http'
      ? await this.readiness.waitForHttp({
          port,
          path: resource.ready.path,
          timeoutMs: timeoutSeconds * 1_000,
          signal
        })
      : await this.readiness.waitForTcp({ port, timeoutMs: timeoutSeconds * 1_000, signal });
    if (readiness.status !== 'PASSED') throw new Error(readiness.lastError ?? 'readiness timed out');
    if (resource.type === 'postgres') {
      await this.retryExec(container, credentials, [
        'pg_isready', '-U', credentials.POSTGRES_USER, '-d', resource.database
      ], timeoutSeconds, signal);
    } else if (resource.type === 'redis') {
      await this.retryExec(container, credentials, [
        'sh', '-c', 'redis-cli -a "$REDIS_PASSWORD" ping | grep -qx PONG'
      ], timeoutSeconds, signal);
    }
  }

  private async retryExec(
    container: PreviewOciResourceRecord,
    env: Record<string, string>,
    command: string[],
    timeoutSeconds: number,
    signal?: AbortSignal
  ): Promise<void> {
    const deadline = Date.now() + timeoutSeconds * 1_000;
    let lastError = 'container probe failed';
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      try {
        await this.engine.run([
          '--context', container.oci.engine.contextName,
          'container', 'exec',
          ...Object.keys(env).sort().flatMap((key) => ['--env', key]),
          container.oci.objectId!,
          ...command
        ], this.engine.environment(env));
        return;
      } catch (error) {
        lastError = boundedError(error);
        await delay(250, signal);
      }
    }
    throw new Error(lastError);
  }

  private async createObject(input: {
    taskId: string;
    generationId: string;
    markerDigest: string;
    engine: PreviewOciEngineIdentity;
    logicalNodeId: string;
    kind: OciAdapterKind;
    scope?: 'generation' | 'preview';
    operation: 'network-create' | 'volume-create' | 'container-create';
    imageReference?: string;
    imageId?: string;
    env?: NodeJS.ProcessEnv;
    createArgs(name: string, labels: Record<string, string>): string[];
  }): Promise<PreviewOciResourceRecord> {
    const id = randomUUID();
    const name = objectName(input.kind, input.generationId, input.logicalNodeId, id);
    const labels = ownershipLabels(this.store.getStoreIdentity(), input, id);
    const now = new Date().toISOString();
    let record: PreviewOciResourceRecord = {
      id,
      taskId: input.taskId,
      generationId: input.generationId,
      logicalNodeId: input.logicalNodeId,
      adapterKind: input.kind,
      state: 'INTENDED',
      ownershipMarkerDigest: input.markerDigest,
      creationAttemptedAt: now,
      updatedAt: now,
      oci: {
        engine: input.engine,
        objectName: name,
        labelsDigest: digestLabels(labels),
        imageReference: input.imageReference,
        imageId: input.imageId,
        scope: input.scope
      }
    };
    record = await this.store.savePreviewResource(record);
    const result = await this.engine.run(
      ['--context', input.engine.contextName, ...input.createArgs(name, labels)],
      input.env ?? this.engine.environment(),
      { timeoutMs: MUTATION_TIMEOUT_MS }
    );
    await this.hooks.afterMutation?.(input.operation);
    const objectId = result.stdout.trim();
    if (!objectId) throw new Error(`${input.operation} returned no object identity.`);
    await this.assertExactOwnership(record, objectId);
    return this.store.savePreviewResource({
      ...record,
      state: input.kind === 'OCI_CONTAINER' ? 'PREPARED' : 'RUNNING',
      oci: { ...record.oci, objectId },
      updatedAt: new Date().toISOString()
    });
  }

  private async findReusableVolume(
    context: GenerationContext,
    resource: PreviewOciResourcePlan
  ): Promise<PreviewOciResourceRecord | undefined> {
    const candidates = (await this.store.getPreviewResources())
      .filter((candidate): candidate is PreviewOciResourceRecord =>
        candidate.taskId === context.taskId &&
        candidate.logicalNodeId === resource.id &&
        candidate.adapterKind === 'OCI_VOLUME' &&
        (candidate.oci.scope === 'preview' || candidate.oci.retainedForReset === true) &&
        !['STOPPED', 'CLEANUP_INCOMPLETE'].includes(candidate.state)
      );
    if (candidates.length > 1) {
      throw new Error(`Preview-scoped volume ownership is ambiguous for ${resource.id}.`);
    }
    const candidate = candidates[0];
    if (!candidate) return undefined;
    await this.requireEngine(candidate.oci.engine);
    const objectId = candidate.oci.objectId ?? await this.discoverExactObject(candidate);
    if (!objectId) return undefined;
    await this.assertExactOwnership(candidate, objectId);
    const adopted = await this.store.savePreviewResource({
          ...candidate,
          oci: { ...candidate.oci, objectId, retainedForReset: false },
          updatedAt: new Date().toISOString()
        });
    if (resource.scope === 'generation' && adopted.generationId !== context.generationId) {
      context.adoptedGenerationVolumes.push(adopted);
    }
    return adopted;
  }

  private async inspectPublishedPorts(
    container: PreviewOciResourceRecord
  ): Promise<PreviewOciPublishedPort[]> {
    const inspection = await this.inspect(container.adapterKind, container.oci.objectId!, container.oci.engine.contextName);
    const settings = asRecord(inspection.NetworkSettings, 'container NetworkSettings');
    const ports = asRecord(settings.Ports, 'container published ports');
    const result: PreviewOciPublishedPort[] = [];
    for (const [containerKey, bindings] of Object.entries(ports)) {
      if (!Array.isArray(bindings)) continue;
      const [portText, protocolText] = containerKey.split('/');
      for (const bindingValue of bindings) {
        const binding = asRecord(bindingValue, 'published port binding');
        const hostIp = String(binding.HostIp);
        const hostPort = Number(binding.HostPort);
        if (hostIp !== '127.0.0.1' || !Number.isInteger(hostPort)) {
          throw new Error('OCI engine did not preserve loopback-only dynamic port publication.');
        }
        result.push({
          containerPort: Number(portText),
          protocol: protocolText === 'udp' ? 'udp' : 'tcp',
          hostIp: '127.0.0.1',
          hostPort
        });
      }
    }
    return result.sort((left, right) => left.containerPort - right.containerPort);
  }

  private async waitForPublishedPorts(
    container: PreviewOciResourceRecord,
    expectedCount: number,
    signal?: AbortSignal
  ): Promise<PreviewOciPublishedPort[]> {
    const deadline = Date.now() + 5_000;
    let published: PreviewOciPublishedPort[] = [];
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      published = await this.inspectPublishedPorts(container);
      if (published.length === expectedCount) return published;
      await delay(50, signal);
    }
    return published;
  }

  private async discoverExactObject(resource: PreviewOciResourceRecord): Promise<string | undefined> {
    const type = objectCliType(resource.adapterKind);
    const labels = expectedLabels(this.store.getStoreIdentity(), resource);
    const argv = [
      '--context', resource.oci.engine.contextName,
      type, 'ls', ...(type === 'container' ? ['--all'] : []),
      ...Object.entries(labels).sort().flatMap(([key, value]) => ['--filter', `label=${key}=${value}`]),
      '--format', '{{.ID}}'
    ];
    const ids = (await this.engine.run(argv)).stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (ids.length >= MAX_DISCOVERED_OBJECTS) {
      throw new Error(`OCI ownership discovery was ambiguous for resource ${resource.id}.`);
    }
    if (ids.length === 0) return undefined;
    await this.assertExactOwnership(resource, ids[0]);
    return ids[0];
  }

  private async assertExactOwnership(resource: PreviewOciResourceRecord, objectId: string): Promise<void> {
    const inspection = await this.inspect(resource.adapterKind, objectId, resource.oci.engine.contextName);
    const actualId = String(inspection.Id ?? inspection.ID ?? inspection.Name ?? '');
    const actualName = String(inspection.Name ?? '').replace(/^\//, '');
    const labels = readLabels(inspection, resource.adapterKind);
    if (
      !actualId.startsWith(objectId) ||
      actualName !== resource.oci.objectName ||
      digestLabels(labels) !== resource.oci.labelsDigest ||
      !sameLabels(labels, expectedLabels(this.store.getStoreIdentity(), resource))
    ) {
      throw new Error(`OCI ${objectCliType(resource.adapterKind)} identity or ownership labels do not match.`);
    }
  }

  private async inspect(kind: OciAdapterKind, objectId: string, contextName: string): Promise<Record<string, unknown>> {
    const result = await this.engine.run([
      '--context', contextName, objectCliType(kind), 'inspect', objectId
    ]);
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error('OCI inspection returned an invalid result.');
    return asRecord(parsed[0], 'OCI inspection');
  }

  private async removeObject(kind: OciAdapterKind, objectId: string, contextName: string): Promise<void> {
    const type = objectCliType(kind);
    const args = type === 'container'
      ? [type, 'rm', '--force', objectId]
      : [type, 'rm', objectId];
    try {
      await this.engine.run(
        ['--context', contextName, ...args],
        this.engine.environment(),
        { timeoutMs: MUTATION_TIMEOUT_MS }
      );
    } catch (error) {
      throw new OciRuntimeError('CLEANUP_FAILED', `OCI ${type} cleanup failed: ${boundedError(error)}`, { cause: error });
    }
  }

  private async requireEngine(expected: PreviewOciEngineIdentity) {
    try {
      return await this.engine.requireReady(expected);
    } catch (error) {
      if (error instanceof OciEngineError) {
        throw new OciRuntimeError(error.code, error.message, { cause: error });
      }
      throw error;
    }
  }
}
