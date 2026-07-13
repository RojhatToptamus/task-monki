import { randomUUID } from 'node:crypto';
import { Client as PgClient, type ClientConfig } from 'pg';
import type {
  PreviewManagedEnvironmentRecord,
  PreviewManagedResourceRecord,
  PreviewManagedResourceState,
  PreviewOciEngineIdentity,
  PreviewOciObjectIdentity,
  PreviewOciPublishedPort,
  PreviewOciResourcePlan
} from '../../../shared/contracts';
import { FileTaskStore } from '../../storage/FileTaskStore';
import { PreviewReadinessService } from '../PreviewReadinessService';
import { OciEngineAdapter, OciEngineError } from './OciEngineAdapter';
import {
  asRecord,
  bindingDigest,
  boundedError,
  createObjectIdentity,
  delay,
  digestLabels,
  digestResourcePlan,
  environmentLabels,
  expectedEnvironmentLabels,
  expectedManagedResourceLabels,
  isArchitectureMismatch,
  labelArgs,
  limitArgs,
  managedResourceLabels,
  objectName,
  readLabels,
  resourceCommand,
  resourcePorts,
  resourceVolumeMount,
  sameLabels,
  throwIfAborted,
  type OciObjectKind
} from './OciResourceRuntimeSupport';
import {
  PreviewCredentialHost,
  type HostedResourceCredential,
  type RuntimeManagedResourceBinding
} from './PreviewCredentialHost';

const PULL_TIMEOUT_MS = 5 * 60_000;
const MUTATION_TIMEOUT_MS = 60_000;
const MAX_DISCOVERED_OBJECTS = 2;
const RESOURCE_HEALTH_INTERVAL_MS = 5_000;
const POSTGRES_PROBE_TIMEOUT_MS = 5_000;

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

export interface ManagedPreviewRuntime {
  environment: PreviewManagedEnvironmentRecord;
  resources: PreviewManagedResourceRecord[];
  bindings: Record<string, RuntimeManagedResourceBinding>;
  setupResourceIds: string[];
}

export interface OciResourceRuntimeHooks {
  afterMutation?(operation: 'network-create' | 'volume-create' | 'container-create'): Promise<void> | void;
  healthIntervalMs?: number;
  postgresProbe?(input: ManagedPostgresProbeInput): Promise<void>;
}

export interface ManagedPostgresProbeInput {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ManagedPostgresClient {
  connect(): Promise<unknown>;
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
}

export type ManagedPostgresClientFactory = (
  config: ClientConfig
) => ManagedPostgresClient;

export async function probeManagedPostgres(
  input: ManagedPostgresProbeInput,
  createClient: ManagedPostgresClientFactory = (config) => new PgClient(config)
): Promise<void> {
  const timeoutMs = input.timeoutMs ?? POSTGRES_PROBE_TIMEOUT_MS;
  const client = createClient({
    host: input.host,
    port: input.port,
    database: input.database,
    user: input.user,
    password: input.password,
    ssl: false,
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs
  });
  let closePromise: Promise<void> | undefined;
  const close = () => closePromise ??= client.end().catch(() => undefined);
  let rejectAbort!: (reason: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    void close();
    rejectAbort(abortError(input.signal));
  };
  input.signal?.addEventListener('abort', onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  const operation = (async () => {
    await client.connect();
    throwIfAborted(input.signal);
    await client.query('SELECT 1');
    throwIfAborted(input.signal);
  })();
  try {
    await Promise.race([operation, aborted]);
  } finally {
    input.signal?.removeEventListener('abort', onAbort);
    await close();
    await operation.catch(() => undefined);
  }
}

export class OciResourceRuntime {
  private readonly healthStops = new Map<string, () => Promise<void>>();
  private readonly resourceCleanup = new Map<
    string,
    Promise<'STOPPED' | 'ALREADY_EXITED' | 'REFUSED'>
  >();
  private readonly environmentCleanup = new Map<
    string,
    Promise<'STOPPED' | 'ALREADY_EXITED' | 'REFUSED'>
  >();

  constructor(
    private readonly store: FileTaskStore,
    private readonly engine: OciEngineAdapter,
    private readonly readiness: PreviewReadinessService,
    private readonly credentials: PreviewCredentialHost,
    private readonly hooks: OciResourceRuntimeHooks = {}
  ) {}

  async ensureManagedPreview(input: {
    taskId: string;
    previewKey: string;
    markerDigest: string;
    expectedEngine: PreviewOciEngineIdentity;
    resources: PreviewOciResourcePlan[];
    retrySetupResourceIds?: string[];
    signal?: AbortSignal;
  }): Promise<ManagedPreviewRuntime> {
    const environment = await this.ensureEnvironment(input);
    const bindings: Record<string, RuntimeManagedResourceBinding> = {};
    const records: PreviewManagedResourceRecord[] = [];
    const setupResourceIds: string[] = [];
    for (const plan of input.resources) {
      throwIfAborted(input.signal);
      const existing = (await this.store.getPreviewManagedResources(input.taskId)).find(
        (candidate) =>
          candidate.environmentId === environment.id &&
          candidate.logicalResourceId === plan.id &&
          candidate.state !== 'STOPPED'
      );
      if (existing) {
        if (existing.planDigest !== digestResourcePlan(plan) || existing.type !== plan.type) {
          throw new Error(`Managed resource ${plan.id} differs from the approved stable preview resource; reset it explicitly.`);
        }
        const retryingSetup =
          existing.state === 'SETUP_FAILED' && input.retrySetupResourceIds?.includes(existing.id);
        if (existing.state !== 'READY' && !retryingSetup) {
          throw new Error(`Managed resource ${plan.id} is ${existing.state.toLowerCase().replace(/_/g, ' ')} and is not reusable.`);
        }
        await this.verifyManagedResource(existing);
        bindings[plan.id] = this.credentials.requireBinding(existing.id);
        const reusable = retryingSetup
          ? await this.store.savePreviewManagedResource({
              ...existing,
              state: 'SETTING_UP',
              setupAttemptedAt: new Date().toISOString(),
              failureReason: undefined,
              updatedAt: new Date().toISOString()
            })
          : existing;
        records.push(reusable);
        if (retryingSetup) setupResourceIds.push(existing.id);
        continue;
      }
      const created = await this.createManagedResource(environment, plan, input.markerDigest, input.signal);
      bindings[plan.id] = this.credentials.requireBinding(created.id);
      records.push(created);
      setupResourceIds.push(created.id);
    }
    return { environment, resources: records, bindings, setupResourceIds };
  }

  async verifyManagedPreview(input: {
    taskId: string;
    expectedEngine: PreviewOciEngineIdentity;
    resources: PreviewOciResourcePlan[];
    resourceStates?: readonly PreviewManagedResourceState[];
    verification?: 'REUSABLE' | 'CLEANUP';
  }): Promise<{ environment: PreviewManagedEnvironmentRecord; resources: PreviewManagedResourceRecord[] }> {
    const environment = await this.store.getPreviewManagedEnvironment(input.taskId);
    if (!environment || environment.state !== 'READY') {
      throw new Error('Managed preview environment is not ready.');
    }
    await this.requireEngine(input.expectedEngine);
    this.assertEngineIdentity(environment.engine, input.expectedEngine);
    await this.assertObject('network', environment.network, expectedEnvironmentLabels(
      this.store.getStoreIdentity(), environment
    ));
    const allowedStates = new Set(input.resourceStates ?? ['READY']);
    const records: PreviewManagedResourceRecord[] = [];
    for (const plan of input.resources) {
      const resource = (await this.store.getPreviewManagedResources(input.taskId)).find(
        (candidate) =>
          candidate.environmentId === environment.id &&
          candidate.logicalResourceId === plan.id &&
          allowedStates.has(candidate.state)
      );
      if (!resource || resource.planDigest !== digestResourcePlan(plan)) {
        throw new Error(`Managed resource ${plan.id} does not match the current approved plan.`);
      }
      if (input.verification === 'CLEANUP') {
        await this.verifyManagedResourceCleanupAuthority(resource);
      } else {
        this.credentials.requireBinding(resource.id);
        await this.verifyManagedResource(resource);
      }
      records.push(resource);
    }
    return { environment, resources: records };
  }

  async markSetupReady(resourceIds: string[]): Promise<void> {
    for (const resourceId of resourceIds) {
      const resource = await this.requireManagedResource(resourceId);
      if (resource.state !== 'SETTING_UP') continue;
      await this.store.savePreviewManagedResource({
        ...resource,
        state: 'READY',
        readyAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }
  }

  async markSetupFailure(
    resourceIds: string[],
    input: { ambiguous: boolean; reason: string }
  ): Promise<void> {
    for (const resourceId of resourceIds) {
      const resource = await this.requireManagedResource(resourceId);
      if (!['SETTING_UP', 'STARTING'].includes(resource.state)) continue;
      await this.store.savePreviewManagedResource({
        ...resource,
        state: input.ambiguous ? 'RECOVERY_REQUIRED' : 'SETUP_FAILED',
        failureReason: this.credentials.redact(input.reason).slice(0, 512),
        updatedAt: new Date().toISOString()
      });
    }
  }

  async watchRequiredResources(
    taskId: string,
    resourceIds: readonly string[],
    onFailure: (resource: PreviewManagedResourceRecord, reason: string) => Promise<void>
  ): Promise<() => Promise<void>> {
    await this.healthStops.get(taskId)?.();
    const requiredIds = new Set(resourceIds);
    let stopped = false;
    let checking = false;
    let pendingFailure: { resource: PreviewManagedResourceRecord; reason: string } | undefined;
    let operation = Promise.resolve();
    const timer = setInterval(() => {
      if (stopped || checking) return;
      checking = true;
      operation = (pendingFailure
        ? Promise.resolve(pendingFailure)
        : this.checkRequiredResources(taskId, requiredIds))
        .then(async (failure) => {
          if (!failure || stopped) return;
          pendingFailure = failure;
          await onFailure(failure.resource, failure.reason);
          stopped = true;
          clearInterval(timer);
        })
        .catch(() => undefined)
        .finally(() => {
          checking = false;
          if (stopped && this.healthStops.get(taskId) === stop) this.healthStops.delete(taskId);
        });
    }, this.hooks.healthIntervalMs ?? RESOURCE_HEALTH_INTERVAL_MS);
    timer.unref?.();
    const stop = async () => {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
      }
      await operation;
      if (this.healthStops.get(taskId) === stop) this.healthStops.delete(taskId);
    };
    this.healthStops.set(taskId, stop);
    return stop;
  }

  stopManagedResource(resourceId: string): Promise<'STOPPED' | 'ALREADY_EXITED' | 'REFUSED'> {
    const existing = this.resourceCleanup.get(resourceId);
    if (existing) return existing;
    const operation = this.stopManagedResourceOnce(resourceId).finally(() => {
      if (this.resourceCleanup.get(resourceId) === operation) {
        this.resourceCleanup.delete(resourceId);
      }
    });
    this.resourceCleanup.set(resourceId, operation);
    return operation;
  }

  private async stopManagedResourceOnce(
    resourceId: string
  ): Promise<'STOPPED' | 'ALREADY_EXITED' | 'REFUSED'> {
    let resource = await this.requireManagedResource(resourceId);
    if (resource.state === 'STOPPED') return 'ALREADY_EXITED';
    const now = new Date().toISOString();
    resource = await this.store.savePreviewManagedResource({
      ...resource,
      state: 'STOPPING',
      cleanupAttemptedAt: now,
      updatedAt: now
    });
    try {
      await this.requireEngine(resource.container.engine);
      await this.removeOwnedObject('container', resource.container, expectedManagedResourceLabels(
        this.store.getStoreIdentity(), resource, 'container'
      ));
      await this.removeOwnedObject('volume', resource.volume, expectedManagedResourceLabels(
        this.store.getStoreIdentity(), resource, 'volume'
      ));
      await this.credentials.delete(resource.id);
      await this.store.savePreviewManagedResource({
        ...resource,
        state: 'STOPPED',
        cleanupError: undefined,
        updatedAt: new Date().toISOString(),
        stoppedAt: new Date().toISOString()
      });
      return 'STOPPED';
    } catch (error) {
      await this.store.savePreviewManagedResource({
        ...resource,
        state: 'CLEANUP_INCOMPLETE',
        cleanupError: this.credentials.redact(boundedError(error)),
        updatedAt: new Date().toISOString()
      });
      return 'REFUSED';
    }
  }

  private stopManagedEnvironment(
    environmentId: string
  ): Promise<'STOPPED' | 'ALREADY_EXITED' | 'REFUSED'> {
    const existing = this.environmentCleanup.get(environmentId);
    if (existing) return existing;
    const operation = this.stopManagedEnvironmentOnce(environmentId).finally(() => {
      if (this.environmentCleanup.get(environmentId) === operation) {
        this.environmentCleanup.delete(environmentId);
      }
    });
    this.environmentCleanup.set(environmentId, operation);
    return operation;
  }

  private async stopManagedEnvironmentOnce(
    environmentId: string
  ): Promise<'STOPPED' | 'ALREADY_EXITED' | 'REFUSED'> {
    let environment = (await this.store.getPreviewManagedEnvironments()).find(
      (candidate) => candidate.id === environmentId
    );
    if (!environment) throw new Error(`Managed preview environment not found: ${environmentId}`);
    if (environment.state === 'STOPPED') return 'ALREADY_EXITED';
    const liveResource = (await this.store.getPreviewManagedResources(environment.taskId)).find(
      (resource) => resource.environmentId === environmentId && resource.state !== 'STOPPED'
    );
    if (liveResource) return 'REFUSED';
    const now = new Date().toISOString();
    environment = await this.store.savePreviewManagedEnvironment({
      ...environment,
      state: 'STOPPING',
      cleanupAttemptedAt: now,
      updatedAt: now
    });
    try {
      await this.requireEngine(environment.engine);
      await this.removeOwnedObject('network', environment.network, expectedEnvironmentLabels(
        this.store.getStoreIdentity(), environment
      ));
      await this.store.savePreviewManagedEnvironment({
        ...environment,
        state: 'STOPPED',
        cleanupError: undefined,
        updatedAt: new Date().toISOString(),
        stoppedAt: new Date().toISOString()
      });
      return 'STOPPED';
    } catch (error) {
      await this.store.savePreviewManagedEnvironment({
        ...environment,
        state: 'CLEANUP_INCOMPLETE',
        cleanupError: this.credentials.redact(boundedError(error)),
        updatedAt: new Date().toISOString()
      });
      return 'REFUSED';
    }
  }

  async cleanupTaskResources(taskId?: string): Promise<'STOPPED' | 'ALREADY_EXITED' | 'REFUSED'> {
    if (taskId) await this.healthStops.get(taskId)?.();
    else await Promise.all([...this.healthStops.values()].map((stop) => stop()));
    let changed = false;
    let refused = false;
    const resources = (await this.store.getPreviewManagedResources(taskId)).filter(
      (resource) => resource.state !== 'STOPPED'
    );
    for (const resource of resources) {
      changed = true;
      if (await this.stopManagedResource(resource.id) === 'REFUSED') refused = true;
    }
    const environments = (await this.store.getPreviewManagedEnvironments()).filter(
      (environment) => (!taskId || environment.taskId === taskId) && environment.state !== 'STOPPED'
    );
    for (const environment of environments) {
      changed = true;
      if (await this.stopManagedEnvironment(environment.id) === 'REFUSED') refused = true;
    }
    return refused ? 'REFUSED' : changed ? 'STOPPED' : 'ALREADY_EXITED';
  }

  private async ensureEnvironment(input: {
    taskId: string;
    previewKey: string;
    markerDigest: string;
    expectedEngine: PreviewOciEngineIdentity;
  }): Promise<PreviewManagedEnvironmentRecord> {
    const existing = await this.store.getPreviewManagedEnvironment(input.taskId);
    if (existing && existing.state !== 'STOPPED') {
      if (existing.state !== 'READY') {
        throw new Error(`Managed preview environment is ${existing.state.toLowerCase().replace(/_/g, ' ')}.`);
      }
      this.assertEngineIdentity(existing.engine, input.expectedEngine);
      await this.requireEngine(input.expectedEngine);
      await this.assertObject('network', existing.network, expectedEnvironmentLabels(
        this.store.getStoreIdentity(), existing
      ));
      return existing;
    }
    const capability = await this.requireEngine(input.expectedEngine);
    const id = randomUUID();
    const labels = environmentLabels(this.store.getStoreIdentity(), {
      taskId: input.taskId,
      environmentId: id,
      markerDigest: input.markerDigest
    });
    const network = createObjectIdentity({
      engine: capability.identity,
      objectName: objectName('network', id, input.previewKey),
      labels
    });
    const now = new Date().toISOString();
    let environment = await this.store.savePreviewManagedEnvironment({
      id,
      previewKey: input.previewKey,
      taskId: input.taskId,
      state: 'INTENDED',
      engine: capability.identity,
      network,
      ownershipMarkerDigest: input.markerDigest,
      createdAt: now,
      updatedAt: now
    });
    try {
      environment = await this.store.savePreviewManagedEnvironment({
        ...environment,
        state: 'STARTING',
        updatedAt: new Date().toISOString()
      });
      const result = await this.engine.run([
        '--context', capability.identity.contextName,
        'network', 'create', ...labelArgs(labels), network.objectName
      ], this.engine.environment(), { timeoutMs: MUTATION_TIMEOUT_MS });
      await this.hooks.afterMutation?.('network-create');
      const objectId = result.stdout.trim();
      if (!objectId) throw new Error('Network creation returned no object identity.');
      const createdNetwork = { ...network, objectId };
      await this.assertObject('network', createdNetwork, labels);
      return this.store.savePreviewManagedEnvironment({
        ...environment,
        state: 'READY',
        network: createdNetwork,
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      await this.store.savePreviewManagedEnvironment({
        ...environment,
        state: 'CLEANUP_INCOMPLETE',
        cleanupError: this.credentials.redact(boundedError(error)),
        updatedAt: new Date().toISOString()
      });
      throw error;
    }
  }

  private async createManagedResource(
    environment: PreviewManagedEnvironmentRecord,
    plan: PreviewOciResourcePlan,
    markerDigest: string,
    signal?: AbortSignal
  ): Promise<PreviewManagedResourceRecord> {
    throwIfAborted(signal);
    const id = randomUUID();
    const containerLabels = managedResourceLabels(this.store.getStoreIdentity(), {
      taskId: environment.taskId,
      environmentId: environment.id,
      managedResourceId: id,
      logicalResourceId: plan.id,
      markerDigest,
      kind: 'container'
    });
    const volumeLabels = managedResourceLabels(this.store.getStoreIdentity(), {
      taskId: environment.taskId,
      environmentId: environment.id,
      managedResourceId: id,
      logicalResourceId: plan.id,
      markerDigest,
      kind: 'volume'
    });
    const container = createObjectIdentity({
      engine: environment.engine,
      objectName: objectName('container', id, plan.id),
      labels: containerLabels,
      imageReference: plan.image
    });
    const volume = createObjectIdentity({
      engine: environment.engine,
      objectName: objectName('volume', id, plan.id),
      labels: volumeLabels
    });
    const now = new Date().toISOString();
    let record = await this.store.savePreviewManagedResource({
      id,
      taskId: environment.taskId,
      environmentId: environment.id,
      logicalResourceId: plan.id,
      type: plan.type,
      state: 'INTENDED',
      planDigest: digestResourcePlan(plan),
      ownershipMarkerDigest: markerDigest,
      container,
      volume,
      creationAttemptedAt: now,
      createdAt: now,
      updatedAt: now
    });
    const credential = await this.credentials.create(id, plan);
    try {
      record = await this.store.savePreviewManagedResource({
        ...record,
        state: 'STARTING',
        updatedAt: new Date().toISOString()
      });
      const volumeResult = await this.engine.run([
        '--context', environment.engine.contextName,
        'volume', 'create', ...labelArgs(volumeLabels), volume.objectName
      ], this.engine.environment(), { timeoutMs: MUTATION_TIMEOUT_MS });
      await this.hooks.afterMutation?.('volume-create');
      const volumeId = volumeResult.stdout.trim();
      if (!volumeId) throw new Error('Volume creation returned no object identity.');
      const createdVolume = { ...volume, objectId: volumeId };
      await this.assertObject('volume', createdVolume, volumeLabels);
      record = await this.store.savePreviewManagedResource({
        ...record,
        volume: createdVolume,
        updatedAt: new Date().toISOString()
      });

      const imageId = await this.requireImage(environment.engine, plan);
      const createdContainer = await this.createContainer(
        environment, record, plan, credential, imageId, containerLabels
      );
      record = await this.store.savePreviewManagedResource({
        ...record,
        container: createdContainer,
        updatedAt: new Date().toISOString()
      });
      const publishedPorts = await this.waitForPublishedPorts(createdContainer, Object.keys(resourcePorts(plan)).length, signal);
      const ports = this.mapPublishedPorts(plan, publishedPorts);
      const binding = this.credentials.bind(id, plan, ports);
      const bindingId = randomUUID();
      record = await this.store.savePreviewManagedResource({
        ...record,
        state: 'SETTING_UP',
        container: { ...createdContainer, publishedPorts },
        binding: {
          id: bindingId,
          digest: bindingDigest({
            id: bindingId,
            type: plan.type,
            host: '127.0.0.1',
            ports,
            username: credential.username,
            database: plan.type === 'postgres' ? plan.database : undefined
          }),
          host: '127.0.0.1',
          ports,
          username: credential.username,
          database: plan.type === 'postgres' ? plan.database : undefined
        },
        setupAttemptedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      await this.waitUntilAuthenticated(plan, record, binding, signal);
      return record;
    } catch (error) {
      const message = this.credentials.redact(boundedError(error));
      await this.store.savePreviewManagedResource({
        ...record,
        state: 'FAILED',
        failureReason: message,
        updatedAt: new Date().toISOString()
      });
      if (error instanceof OciRuntimeError) throw error;
      throw new OciRuntimeError('CREATE_FAILED', `Managed resource ${plan.id} creation failed: ${message}`, { cause: error });
    }
  }

  private async createContainer(
    environment: PreviewManagedEnvironmentRecord,
    record: PreviewManagedResourceRecord,
    plan: PreviewOciResourcePlan,
    credential: HostedResourceCredential,
    imageId: string,
    labels: Record<string, string>
  ): Promise<PreviewOciObjectIdentity> {
    const ports = resourcePorts(plan);
    const env = this.engine.environment(credential.containerEnvironment);
    const result = await this.engine.run([
      '--context', environment.engine.contextName,
      'container', 'create', '--name', record.container.objectName,
      ...labelArgs(labels),
      '--network', environment.network.objectId!,
      ...limitArgs(plan),
      ...Object.keys(credential.containerEnvironment).sort().flatMap((key) => ['--env', key]),
      ...credential.secretMounts.flatMap((mount) => [
        '--mount', `type=bind,src=${mount.sourcePath},dst=${mount.targetPath},readonly`
      ]),
      ...Object.values(ports).flatMap((port) => [
        '--publish', `127.0.0.1::${port.containerPort}/${port.protocol}`
      ]),
      '--mount', `type=volume,src=${record.volume.objectId},dst=${resourceVolumeMount(plan)}`,
      imageId,
      ...resourceCommand(plan)
    ], env, { timeoutMs: MUTATION_TIMEOUT_MS });
    await this.hooks.afterMutation?.('container-create');
    const objectId = result.stdout.trim();
    if (!objectId) throw new Error('Container creation returned no object identity.');
    const container = { ...record.container, objectId, imageId };
    await this.assertObject('container', container, labels);
    await this.engine.run([
      '--context', environment.engine.contextName, 'container', 'start', objectId
    ], this.engine.environment(), { timeoutMs: MUTATION_TIMEOUT_MS });
    return container;
  }

  private async waitUntilAuthenticated(
    plan: PreviewOciResourcePlan,
    record: PreviewManagedResourceRecord,
    binding: RuntimeManagedResourceBinding,
    signal?: AbortSignal
  ): Promise<void> {
    const portId = plan.type === 'postgres' ? 'postgres' : 'redis';
    const readiness = await this.readiness.waitForTcp({
      port: binding.ports[portId],
      timeoutMs: 60_000,
      signal
    });
    if (readiness.status !== 'PASSED') {
      throw new OciRuntimeError('UNHEALTHY_CONTAINER', `Managed resource ${plan.id} did not open its loopback port.`);
    }
    if (plan.type === 'postgres') {
      await this.retryPostgres(record, binding, plan.database, 60, signal);
    } else {
      await this.retryExec(record, this.redisAuthenticationProbe(), 60, signal);
    }
  }

  private redisAuthenticationProbe(): string[] {
    return [
      'sh', '-eu', '-c',
      'REDISCLI_AUTH="$(sed -n "s/^requirepass //p" /run/taskmonki/redis.conf)"; export REDISCLI_AUTH; test "$(redis-cli --no-auth-warning ping)" = PONG'
    ];
  }

  private async retryPostgres(
    resource: PreviewManagedResourceRecord,
    binding: RuntimeManagedResourceBinding,
    database: string,
    timeoutSeconds: number,
    signal?: AbortSignal
  ): Promise<void> {
    const deadline = Date.now() + timeoutSeconds * 1_000;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      try {
        await this.probePostgres(resource, binding, database, signal, Math.min(
          POSTGRES_PROBE_TIMEOUT_MS,
          Math.max(1, deadline - Date.now())
        ));
        return;
      } catch {
        throwIfAborted(signal);
        await delay(250, signal);
      }
    }
    throw new OciRuntimeError(
      'UNHEALTHY_CONTAINER',
      `Managed resource ${resource.logicalResourceId} failed authenticated readiness.`
    );
  }

  private probePostgres(
    resource: PreviewManagedResourceRecord,
    binding: RuntimeManagedResourceBinding,
    database: string,
    signal?: AbortSignal,
    timeoutMs = POSTGRES_PROBE_TIMEOUT_MS
  ): Promise<void> {
    const credential = this.credentials.require(resource.id);
    return (this.hooks.postgresProbe ?? probeManagedPostgres)({
      host: '127.0.0.1',
      port: binding.ports.postgres,
      database,
      user: credential.username!,
      password: credential.password,
      signal,
      timeoutMs
    });
  }

  private async retryExec(
    resource: PreviewManagedResourceRecord,
    command: string[],
    timeoutSeconds: number,
    signal?: AbortSignal
  ): Promise<void> {
    const deadline = Date.now() + timeoutSeconds * 1_000;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      try {
        await this.engine.run([
          '--context', resource.container.engine.contextName,
          'container', 'exec',
          resource.container.objectId!,
          ...command
        ], authenticationProbeEnvironment(this.engine.environment()));
        return;
      } catch {
        await delay(250, signal);
      }
    }
    throw new OciRuntimeError('UNHEALTHY_CONTAINER', `Managed resource ${resource.logicalResourceId} failed authenticated readiness.`);
  }

  private async requireImage(
    engine: PreviewOciEngineIdentity,
    plan: PreviewOciResourcePlan
  ): Promise<string> {
    const contextArgs = ['--context', engine.contextName];
    let imageId = await this.inspectLocalImage(contextArgs, plan.image);
    if (!imageId) {
      try {
        await this.engine.run([...contextArgs, 'pull', plan.image], this.engine.environment(), { timeoutMs: PULL_TIMEOUT_MS });
      } catch (error) {
        if (isArchitectureMismatch(error)) {
          throw new OciRuntimeError('IMAGE_ARCHITECTURE_MISMATCH', `OCI image architecture is incompatible for ${plan.id}.`);
        }
        throw new OciRuntimeError('IMAGE_PULL_FAILED', `OCI image pull failed for ${plan.id}.`);
      }
      imageId = await this.inspectLocalImage(contextArgs, plan.image);
    }
    if (!imageId) throw new OciRuntimeError('IMAGE_PULL_FAILED', `OCI image ${plan.image} has no image ID.`);
    return imageId;
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

  private async verifyManagedResource(resource: PreviewManagedResourceRecord): Promise<void> {
    await this.requireEngine(resource.container.engine);
    await this.assertObject('container', resource.container, expectedManagedResourceLabels(
      this.store.getStoreIdentity(), resource, 'container'
    ));
    await this.assertObject('volume', resource.volume, expectedManagedResourceLabels(
      this.store.getStoreIdentity(), resource, 'volume'
    ));
    const inspection = await this.inspect('container', resource.container.objectId!, resource.container.engine.contextName);
    const state = asRecord(inspection.State, 'container state');
    if (state.Running !== true) throw new Error(`Managed resource ${resource.logicalResourceId} is not running.`);
    const safeBinding = resource.binding;
    const credential = this.credentials.require(resource.id);
    if (!safeBinding || safeBinding.digest !== bindingDigest({
      id: safeBinding.id,
      type: resource.type,
      host: safeBinding.host,
      ports: safeBinding.ports,
      username: safeBinding.username,
      database: safeBinding.database
    })) {
      throw new Error(`Managed resource ${resource.logicalResourceId} binding identity is invalid.`);
    }
    if (
      (resource.type === 'postgres' && (
        !safeBinding.database ||
        !safeBinding.username ||
        safeBinding.username !== credential.username
      )) ||
      (resource.type === 'redis' && (safeBinding.database !== undefined || safeBinding.username !== undefined))
    ) {
      throw new Error(`Managed resource ${resource.logicalResourceId} binding metadata is invalid.`);
    }
    const runtimeBinding = this.credentials.requireBinding(resource.id);
    if (
      Object.keys(runtimeBinding.ports).length !== Object.keys(safeBinding.ports).length ||
      Object.entries(runtimeBinding.ports).some(([id, port]) => safeBinding.ports[id] !== port)
    ) {
      throw new Error(`Managed resource ${resource.logicalResourceId} runtime binding does not match its record.`);
    }
    const expectedContainerPort = resource.type === 'postgres' ? 5432 : 6379;
    const portId = resource.type === 'postgres' ? 'postgres' : 'redis';
    const published = await this.inspectPublishedPorts(resource.container);
    if (!published.some(
      (port) =>
        port.containerPort === expectedContainerPort &&
        port.protocol === 'tcp' &&
        port.hostPort === safeBinding.ports[portId]
    )) {
      throw new Error(`Managed resource ${resource.logicalResourceId} published binding changed.`);
    }
    try {
      if (resource.type === 'postgres') {
        await this.probePostgres(resource, runtimeBinding, safeBinding.database!);
      } else {
        await this.engine.run([
          '--context', resource.container.engine.contextName,
          'container', 'exec',
          resource.container.objectId!,
          ...this.redisAuthenticationProbe()
        ], authenticationProbeEnvironment(this.engine.environment()));
      }
    } catch {
      throw new Error(`Managed resource ${resource.logicalResourceId} failed authenticated health verification.`);
    }
  }

  private async checkRequiredResources(
    taskId: string,
    requiredIds: ReadonlySet<string>
  ): Promise<{ resource: PreviewManagedResourceRecord; reason: string } | undefined> {
    for (const resource of await this.store.getPreviewManagedResources(taskId)) {
      if (resource.state !== 'READY' || !requiredIds.has(resource.id)) continue;
      try {
        await this.verifyManagedResource(resource);
      } catch {
        const failed = await this.store.savePreviewManagedResource({
          ...resource,
          state: 'FAILED',
          failureReason: `Managed resource ${resource.logicalResourceId} lost verified runtime ownership or health.`,
          updatedAt: new Date().toISOString()
        });
        return { resource: failed, reason: failed.failureReason! };
      }
    }
    return undefined;
  }

  private async verifyManagedResourceCleanupAuthority(
    resource: PreviewManagedResourceRecord
  ): Promise<void> {
    await this.requireEngine(resource.container.engine);
    await this.findVerifiedOwnedObject('container', resource.container, expectedManagedResourceLabels(
      this.store.getStoreIdentity(), resource, 'container'
    ));
    await this.findVerifiedOwnedObject('volume', resource.volume, expectedManagedResourceLabels(
      this.store.getStoreIdentity(), resource, 'volume'
    ));
  }

  private mapPublishedPorts(
    plan: PreviewOciResourcePlan,
    published: PreviewOciPublishedPort[]
  ): Record<string, number> {
    const ports: Record<string, number> = {};
    for (const [portId, expected] of Object.entries(resourcePorts(plan))) {
      const match = published.find(
        (candidate) => candidate.containerPort === expected.containerPort && candidate.protocol === expected.protocol
      );
      if (!match) throw new Error(`Managed resource ${plan.id} did not publish ${portId} on loopback.`);
      ports[portId] = match.hostPort;
    }
    return ports;
  }

  private async waitForPublishedPorts(
    container: PreviewOciObjectIdentity,
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

  private async inspectPublishedPorts(container: PreviewOciObjectIdentity): Promise<PreviewOciPublishedPort[]> {
    const inspection = await this.inspect('container', container.objectId!, container.engine.contextName);
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

  private async removeOwnedObject(
    kind: OciObjectKind,
    identity: PreviewOciObjectIdentity,
    expectedLabels: Record<string, string>
  ): Promise<void> {
    const objectId = await this.findVerifiedOwnedObject(kind, identity, expectedLabels);
    if (!objectId) return;
    const args = kind === 'container'
      ? ['container', 'rm', '--force', objectId]
      : [kind, 'rm', objectId];
    try {
      await this.engine.run(
        ['--context', identity.engine.contextName, ...args],
        this.engine.environment(),
        { timeoutMs: MUTATION_TIMEOUT_MS }
      );
    } catch (error) {
      throw new OciRuntimeError('CLEANUP_FAILED', `OCI ${kind} cleanup failed: ${boundedError(error)}`, { cause: error });
    }
  }

  private async findVerifiedOwnedObject(
    kind: OciObjectKind,
    identity: PreviewOciObjectIdentity,
    expectedLabels: Record<string, string>
  ): Promise<string | undefined> {
    if (identity.labelsDigest !== digestLabels(expectedLabels)) {
      throw new Error(`OCI ${kind} Task Monki ownership-label identity does not match.`);
    }
    if (identity.objectId) {
      const inspection = await this.inspect(
        kind, identity.objectId, identity.engine.contextName
      ).catch(() => undefined);
      if (inspection) {
        this.assertObjectInspection(kind, identity.objectId, identity, expectedLabels, inspection);
        return identity.objectId;
      }
    }
    const discovered = await this.discoverExactObject(kind, identity, expectedLabels);
    if (discovered) await this.assertObject(kind, { ...identity, objectId: discovered }, expectedLabels);
    return discovered;
  }

  private async discoverExactObject(
    kind: OciObjectKind,
    identity: PreviewOciObjectIdentity,
    labels: Record<string, string>
  ): Promise<string | undefined> {
    const argv = [
      '--context', identity.engine.contextName,
      kind, 'ls', ...(kind === 'container' ? ['--all'] : []),
      ...Object.entries(labels).sort().flatMap(([key, value]) => ['--filter', `label=${key}=${value}`]),
      '--format', '{{.ID}}'
    ];
    const ids = (await this.engine.run(argv)).stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (ids.length >= MAX_DISCOVERED_OBJECTS) throw new Error(`OCI ${kind} ownership discovery is ambiguous.`);
    return ids[0];
  }

  private async assertObject(
    kind: OciObjectKind,
    identity: PreviewOciObjectIdentity,
    expectedLabels: Record<string, string>
  ): Promise<void> {
    const objectId = identity.objectId ?? await this.discoverExactObject(kind, identity, expectedLabels);
    if (!objectId) throw new Error(`Owned OCI ${kind} is missing.`);
    const inspection = await this.inspect(kind, objectId, identity.engine.contextName);
    this.assertObjectInspection(kind, objectId, identity, expectedLabels, inspection);
  }

  private assertObjectInspection(
    kind: OciObjectKind,
    objectId: string,
    identity: PreviewOciObjectIdentity,
    expectedLabels: Record<string, string>,
    inspection: Record<string, unknown>
  ): void {
    const actualId = String(inspection.Id ?? inspection.ID ?? inspection.Name ?? '');
    const actualLabels = readLabels(inspection, kind);
    if (
      !actualId.startsWith(objectId) ||
      identity.labelsDigest !== digestLabels(expectedLabels) ||
      !sameLabels(actualLabels, expectedLabels)
    ) {
      throw new Error(`OCI ${kind} identity or Task Monki ownership labels do not match.`);
    }
  }

  private async inspect(kind: OciObjectKind, objectId: string, contextName: string): Promise<Record<string, unknown>> {
    const parsed = JSON.parse((await this.engine.run([
      '--context', contextName, kind, 'inspect', objectId
    ])).stdout) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error('OCI inspection returned an invalid result.');
    return asRecord(parsed[0], 'OCI inspection');
  }

  private async requireManagedResource(id: string): Promise<PreviewManagedResourceRecord> {
    const resource = await this.store.getPreviewManagedResource(id);
    if (!resource) throw new Error(`Managed preview resource not found: ${id}`);
    return resource;
  }

  private assertEngineIdentity(
    recorded: PreviewOciEngineIdentity,
    expected: PreviewOciEngineIdentity
  ): void {
    if (
      recorded.contextName !== expected.contextName ||
      recorded.endpointDigest !== expected.endpointDigest ||
      recorded.engineId !== expected.engineId
    ) {
      throw new OciRuntimeError(
        'ENGINE_IDENTITY_MISMATCH',
        'The approved OCI engine no longer owns this preview environment.'
      );
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

function authenticationProbeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...environment };
  delete sanitized.PGPASSWORD;
  delete sanitized.REDIS_PASSWORD;
  delete sanitized.REDISCLI_AUTH;
  return sanitized;
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error('Managed PostgreSQL authentication was canceled.');
}
