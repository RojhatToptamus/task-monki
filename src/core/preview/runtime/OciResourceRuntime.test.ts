import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client as PgClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type {
  PreviewManagedEnvironmentRecord,
  PreviewManagedResourceRecord,
  PreviewOciEngineIdentity,
  PreviewPostgresResourcePlan,
  PreviewRedisResourcePlan
} from '../../../shared/contracts';
import { PreviewReadinessService } from '../PreviewReadinessService';
import { OciEngineAdapter, type OciCommandExecutor } from './OciEngineAdapter';
import { PreviewCredentialHost } from './PreviewCredentialHost';
import {
  OciResourceRuntime,
  probeManagedPostgres,
  type ManagedPostgresClient,
  type ManagedPostgresProbeInput
} from './OciResourceRuntime';

describe('OciResourceRuntime', () => {
  it('keeps one preview-owned resource stable across application generations without persisting credentials', async () => {
    const fixture = createFixture();
    const first = await fixture.runtime.ensureManagedPreview(runtimeInput(fixture.identity, [redisResource()]));
    await fixture.runtime.markSetupReady(first.setupResourceIds);
    const ready = await fixture.store.getPreviewManagedResources('task-1');
    const password = fixture.credentials.require(ready[0].id).password;
    const firstIdentity = identitySummary(first);

    const second = await fixture.runtime.ensureManagedPreview(runtimeInput(fixture.identity, [redisResource()]));

    expect(second.setupResourceIds).toEqual([]);
    expect(identitySummary(second)).toEqual(firstIdentity);
    expect(fixture.cli.calls.filter((call) => call.argv.includes('create'))).toHaveLength(3);
    expect(JSON.stringify(fixture.store)).not.toContain(password);
    expect(fixture.cli.calls.some((call) => call.argv.some((argument) => argument.includes(password)))).toBe(false);
    expect(fixture.cli.calls.some((call) => Object.values(call.env).includes(password))).toBe(false);
    const authenticatedExec = fixture.cli.calls.find(
      (call) => call.argv.includes('container') && call.argv.includes('exec')
    );
    expect(authenticatedExec?.argv).toContainEqual(expect.stringContaining('/run/taskmonki/redis.conf'));
    expect(authenticatedExec?.argv).not.toContain('REDIS_PASSWORD');
    expect(second.bindings.cache.redisUrl).toBe(first.bindings.cache.redisUrl);
  });

  it('launches Redis from a protected config without credentials in argv or configured environment', async () => {
    const fixture = createFixture();
    try {
      const managed = await fixture.runtime.ensureManagedPreview(
        runtimeInput(fixture.identity, [redisResource()])
      );
      const credential = fixture.credentials.require(managed.resources[0].id);
      const mount = credential.secretMounts[0];
      const createCall = fixture.cli.calls.find(
        (call) => call.argv.includes('container') && call.argv.includes('create')
      )!;

      expect(mount.targetPath).toBe('/run/taskmonki/redis.conf');
      expect(await fs.readFile(mount.sourcePath, 'utf8')).toBe(
        `appendonly yes\nrequirepass ${credential.password}\n`
      );
      expect((await fs.stat(path.dirname(mount.sourcePath))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(mount.sourcePath)).mode & 0o777).toBe(0o644);
      expect(createCall.argv).toContain('redis-server');
      expect(createCall.argv).toContain('/run/taskmonki/redis.conf');
      expect(createCall.argv).not.toContain('sh');
      expect(JSON.stringify(createCall)).not.toContain(credential.password);
      expect(Object.values(createCall.env)).not.toContain(credential.password);
    } finally {
      await fixture.credentials.clear();
    }
  });

  it('authenticates PostgreSQL over its published TCP binding without a Docker helper credential', async () => {
    const fixture = createFixture({ hostAuthenticationEnv: true });
    const managed = await fixture.runtime.ensureManagedPreview(
      runtimeInput(fixture.identity, [postgresResource(), redisResource()])
    );
    const credentials = managed.resources.map((resource) => fixture.credentials.require(resource.id));
    const execCalls = fixture.cli.calls.filter(
      (call) => call.argv.includes('container') && call.argv.includes('exec')
    );

    expect(execCalls).toHaveLength(1);
    for (const call of execCalls) {
      expect(call.argv).not.toContain('--env');
      expect(call.env.PGPASSWORD).toBeUndefined();
      expect(call.env.REDIS_PASSWORD).toBeUndefined();
      expect(call.env.REDISCLI_AUTH).toBeUndefined();
      for (const credential of credentials) {
        expect(JSON.stringify(call)).not.toContain(credential.password);
      }
    }
    expect(execCalls[0].argv).toContainEqual(expect.stringContaining('/run/taskmonki/redis.conf'));
    expect(execCalls.some((call) =>
      call.argv.some((argument) => argument.includes('/run/taskmonki/postgres-password'))
    )).toBe(false);
    expect(fixture.postgres.calls).toHaveLength(1);
    expect(fixture.postgres.calls[0]).toMatchObject({
      host: '127.0.0.1',
      port: managed.bindings.database.ports.postgres,
      database: 'app',
      user: credentials.find((credential) => credential.type === 'postgres')!.username,
      password: credentials.find((credential) => credential.type === 'postgres')!.password
    });
  });

  it('closes the PostgreSQL client after a bounded timeout', async () => {
    let ended = 0;
    let configuredTimeout: number | undefined;
    const client: ManagedPostgresClient = {
      async connect() { throw new Error('connection timeout'); },
      async query() {},
      async end() { ended += 1; }
    };

    await expect(probeManagedPostgres({
      host: '127.0.0.1', port: 5432, database: 'app', user: 'tm_user', password: 'secret', timeoutMs: 25
    }, (config) => {
      configuredTimeout = config.connectionTimeoutMillis;
      expect(config.query_timeout).toBe(25);
      return client;
    })).rejects.toThrow('connection timeout');

    expect(configuredTimeout).toBe(25);
    expect(ended).toBe(1);
  });

  it('cancels and joins an in-flight PostgreSQL client before returning', async () => {
    const controller = new AbortController();
    let rejectConnect!: (error: Error) => void;
    let ended = 0;
    const client: ManagedPostgresClient = {
      connect() {
        return new Promise((_resolve, reject) => { rejectConnect = reject; });
      },
      async query() {},
      async end() {
        ended += 1;
        rejectConnect(new Error('connection closed'));
      }
    };
    const operation = probeManagedPostgres({
      host: '127.0.0.1', port: 5432, database: 'app', user: 'tm_user', password: 'secret',
      signal: controller.signal
    }, () => client);
    await Promise.resolve();

    controller.abort(new Error('preview canceled'));

    await expect(operation).rejects.toThrow('preview canceled');
    expect(ended).toBe(1);
  });

  it('refuses reuse when persisted safe binding identity no longer matches runtime authority', async () => {
    const fixture = createFixture();
    const managed = await fixture.runtime.ensureManagedPreview(runtimeInput(fixture.identity, [redisResource()]));
    await fixture.runtime.markSetupReady(managed.setupResourceIds);
    fixture.store.resources[0].binding!.ports.redis += 1;

    await expect(
      fixture.runtime.ensureManagedPreview(runtimeInput(fixture.identity, [redisResource()]))
    ).rejects.toThrow('binding identity is invalid');
  });

  it('creates exactly one network owner and lets generation history have no cleanup authority', async () => {
    const fixture = createFixture();
    const managed = await fixture.runtime.ensureManagedPreview(runtimeInput(fixture.identity, [postgresResource(), redisResource()]));
    await fixture.runtime.markSetupReady(managed.setupResourceIds);

    expect(fixture.store.environments).toHaveLength(1);
    expect(fixture.store.resources).toHaveLength(2);
    expect([...fixture.cli.objects.values()].filter((object) => object.kind === 'network' && !object.removed)).toHaveLength(1);
    expect([...fixture.cli.objects.values()].filter((object) => object.kind === 'container' && !object.removed)).toHaveLength(3);
    expect(managed.resources.every((resource) => resource.environmentId === managed.environment.id)).toBe(true);
  });

  it('isolates two task previews across environment, resource, volume, port, URL, and credential identity', async () => {
    const fixture = createFixture();
    const first = await fixture.runtime.ensureManagedPreview(runtimeInput(fixture.identity, [postgresResource(), redisResource()]));
    const second = await fixture.runtime.ensureManagedPreview({
      ...runtimeInput(fixture.identity, [postgresResource(), redisResource()]),
      taskId: 'task-2',
      previewKey: 'preview-2',
      markerDigest: 'marker-2'
    });
    await fixture.runtime.markSetupReady([...first.setupResourceIds, ...second.setupResourceIds]);

    expect(second.environment.id).not.toBe(first.environment.id);
    expect(second.environment.network.objectId).not.toBe(first.environment.network.objectId);
    expect(new Set([...first.resources, ...second.resources].flatMap((resource) => [
      resource.id, resource.container.objectId!, resource.volume.objectId!
    ])).size).toBe(12);
    const ports = [...Object.values(first.bindings), ...Object.values(second.bindings)]
      .flatMap((binding) => Object.values(binding.ports));
    expect(new Set(ports).size).toBe(ports.length);
    expect(new Set([...Object.values(first.bindings), ...Object.values(second.bindings)]
      .map((binding) => binding.postgresUrl ?? binding.redisUrl)).size).toBe(4);
  });

  it('resets only the selected managed resource and never mounts one volume into two containers', async () => {
    const fixture = createFixture();
    const first = await fixture.runtime.ensureManagedPreview(runtimeInput(fixture.identity, [postgresResource(), redisResource()]));
    await fixture.runtime.markSetupReady(first.setupResourceIds);
    const database = first.resources.find((resource) => resource.logicalResourceId === 'database')!;
    const cache = first.resources.find((resource) => resource.logicalResourceId === 'cache')!;

    await expect(fixture.runtime.stopManagedResource(database.id)).resolves.toBe('STOPPED');
    expect(fixture.cli.objects.get(cache.container.objectId!)?.removed).toBe(false);
    expect(fixture.cli.objects.get(cache.volume.objectId!)?.removed).toBe(false);
    const replacement = await fixture.runtime.ensureManagedPreview(runtimeInput(fixture.identity, [postgresResource(), redisResource()]));

    const nextDatabase = replacement.resources.find((resource) => resource.logicalResourceId === 'database')!;
    expect(nextDatabase.id).not.toBe(database.id);
    expect(nextDatabase.volume.objectId).not.toBe(database.volume.objectId);
    const volumeMounts = fixture.cli.calls
      .filter((call) => call.argv.includes('container') && call.argv.includes('create'))
      .flatMap((call) => call.argv.filter((value, index) => call.argv[index - 1] === '--mount'))
      .filter((mount) => mount.startsWith('type=volume'));
    expect(new Set(volumeMounts).size).toBe(volumeMounts.length);
  });

  it('permits exact cleanup preflight when a failed resource container is already absent', async () => {
    const fixture = createFixture();
    const managed = await fixture.runtime.ensureManagedPreview(runtimeInput(fixture.identity, [redisResource()]));
    await fixture.runtime.markSetupReady(managed.setupResourceIds);
    const resource = managed.resources[0];
    fixture.cli.objects.get(resource.container.objectId!)!.removed = true;

    await expect(fixture.runtime.verifyManagedPreview({
      taskId: 'task-1', expectedEngine: fixture.identity, resources: [redisResource()],
      verification: 'CLEANUP'
    })).resolves.toMatchObject({ resources: [{ id: resource.id }] });
    await expect(fixture.runtime.verifyManagedPreview({
      taskId: 'task-1', expectedEngine: fixture.identity, resources: [redisResource()]
    })).rejects.toThrow();
    await expect(fixture.runtime.stopManagedResource(resource.id)).resolves.toBe('STOPPED');
    expect(fixture.cli.objects.get(resource.volume.objectId!)?.removed).toBe(true);
  });

  it('joins concurrent task and global cleanup for each exact OCI owner', async () => {
    const fixture = createFixture();
    const managed = await fixture.runtime.ensureManagedPreview(
      runtimeInput(fixture.identity, [redisResource()])
    );
    await fixture.runtime.markSetupReady(managed.setupResourceIds);

    const results = await Promise.all([
      fixture.runtime.cleanupTaskResources('task-1'),
      fixture.runtime.cleanupTaskResources()
    ]);

    expect(results).not.toContain('REFUSED');
    expect((await fixture.store.getPreviewManagedResources('task-1'))[0].state).toBe('STOPPED');
    expect((await fixture.store.getPreviewManagedEnvironments())[0].state).toBe('STOPPED');
    for (const objectId of [
      managed.resources[0].container.objectId!,
      managed.resources[0].volume.objectId!,
      managed.environment.network.objectId!
    ]) {
      expect(
        fixture.cli.calls.filter(
          (call) => call.argv.includes('rm') && call.argv.includes(objectId)
        )
      ).toHaveLength(1);
    }
  });

  it('retries observed setup failure only through explicit authority without recreating the resource', async () => {
    const fixture = createFixture();
    const first = await fixture.runtime.ensureManagedPreview(runtimeInput(fixture.identity, [redisResource()]));
    await fixture.runtime.markSetupFailure(first.setupResourceIds, {
      ambiguous: false,
      reason: 'observed setup failure'
    });
    await expect(
      fixture.runtime.ensureManagedPreview(runtimeInput(fixture.identity, [redisResource()]))
    ).rejects.toThrow('setup failed');

    const retried = await fixture.runtime.ensureManagedPreview({
      ...runtimeInput(fixture.identity, [redisResource()]),
      retrySetupResourceIds: first.setupResourceIds
    });
    expect(retried.setupResourceIds).toEqual(first.setupResourceIds);
    expect(identitySummary(retried)).toEqual(identitySummary(first));
    expect(fixture.cli.calls.filter((call) => call.argv.includes('create'))).toHaveLength(3);
    await fixture.runtime.markSetupReady(retried.setupResourceIds);
    expect((await fixture.store.getPreviewManagedResources('task-1'))[0].state).toBe('READY');
  });

  it.each(['network-create', 'volume-create', 'container-create'] as const)(
    'discovers and cleans the %s create/record crash boundary by full reserved labels',
    async (operation) => {
      const fixture = createFixture({ failAfter: operation });
      await expect(
        fixture.runtime.ensureManagedPreview(runtimeInput(fixture.identity, [redisResource()]))
      ).rejects.toThrow('injected crash');

      await expect(fixture.runtime.cleanupTaskResources('task-1')).resolves.toBe('STOPPED');
      expect([...fixture.cli.objects.values()]
        .filter((object) => object.id !== 'unrelated')
        .every((object) => object.removed)).toBe(true);
      expect(fixture.cli.objects.get('unrelated')?.removed).toBe(false);
    }
  );

  it('accepts inherited labels, refuses engine retarget cleanup, and keeps failure retryable', async () => {
    const fixture = createFixture({ inheritedLabels: true });
    const managed = await fixture.runtime.ensureManagedPreview(runtimeInput(fixture.identity, [redisResource()]));
    await fixture.runtime.markSetupReady(managed.setupResourceIds);
    await expect(fixture.runtime.ensureManagedPreview(
      runtimeInput({ ...fixture.identity, endpointDigest: 'different-approved-endpoint' }, [redisResource()])
    )).rejects.toMatchObject({ code: 'ENGINE_IDENTITY_MISMATCH' });
    fixture.cli.engineId = 'retargeted-engine';

    await expect(fixture.runtime.cleanupTaskResources('task-1')).resolves.toBe('REFUSED');
    expect(fixture.store.resources.some((resource) => resource.state === 'CLEANUP_INCOMPLETE')).toBe(true);
    expect(fixture.cli.objects.get('unrelated')?.removed).toBe(false);
  });

  it('refuses cleanup when an exact recorded object still exists with altered ownership labels', async () => {
    const fixture = createFixture();
    const managed = await fixture.runtime.ensureManagedPreview(runtimeInput(fixture.identity, [redisResource()]));
    await fixture.runtime.markSetupReady(managed.setupResourceIds);
    const container = fixture.cli.objects.get(managed.resources[0].container.objectId!)!;
    container.labels['io.taskmonki.preview.store'] = 'different-store';

    await expect(fixture.runtime.cleanupTaskResources('task-1')).resolves.toBe('REFUSED');
    expect(container.removed).toBe(false);
    expect((await fixture.store.getPreviewManagedResources('task-1'))[0].state).toBe('CLEANUP_INCOMPLETE');
  });

  it('treats an object name as diagnostic when exact identity and reserved ownership labels match', async () => {
    const fixture = createFixture();
    const managed = await fixture.runtime.ensureManagedPreview(runtimeInput(fixture.identity, [redisResource()]));
    await fixture.runtime.markSetupReady(managed.setupResourceIds);
    fixture.cli.objects.get(managed.resources[0].container.objectId!)!.name = 'renamed-for-diagnostics';

    await expect(fixture.runtime.cleanupTaskResources('task-1')).resolves.toBe('STOPPED');
    expect((await fixture.store.getPreviewManagedResources('task-1'))[0].state).toBe('STOPPED');
  });

  it('keeps partial cleanup failure visible and retries exact remaining objects', async () => {
    const fixture = createFixture({ failRemoveOnce: 'volume' });
    const managed = await fixture.runtime.ensureManagedPreview(runtimeInput(fixture.identity, [redisResource()]));
    await fixture.runtime.markSetupReady(managed.setupResourceIds);

    await expect(fixture.runtime.cleanupTaskResources('task-1')).resolves.toBe('REFUSED');
    expect((await fixture.store.getPreviewManagedResources('task-1'))[0].state).toBe('CLEANUP_INCOMPLETE');
    await expect(fixture.runtime.cleanupTaskResources('task-1')).resolves.toBe('STOPPED');
    expect((await fixture.store.getPreviewManagedResources('task-1'))[0].state).toBe('STOPPED');
    expect(fixture.store.environments[0].state).toBe('STOPPED');
  });

  it('marks post-ready resource death without deleting its volume', async () => {
    const fixture = createFixture();
    const managed = await fixture.runtime.ensureManagedPreview(runtimeInput(fixture.identity, [redisResource()]));
    await fixture.runtime.markSetupReady(managed.setupResourceIds);
    const resource = managed.resources[0];
    fixture.cli.objects.get(resource.container.objectId!)!.running = false;

    let resolveFailure!: (resource: PreviewManagedResourceRecord) => void;
    const failure = new Promise<PreviewManagedResourceRecord>((resolve) => { resolveFailure = resolve; });
    await fixture.runtime.watchRequiredResources(
      'task-1', [resource.id], async (failed) => resolveFailure(failed)
    );
    await expect(failure).resolves.toMatchObject({ id: resource.id, state: 'FAILED' });
    expect(fixture.cli.objects.get(resource.volume.objectId!)?.removed).toBe(false);
  });

  it('marks post-ready authenticated health failure without deleting data', async () => {
    const fixture = createFixture();
    const managed = await fixture.runtime.ensureManagedPreview(runtimeInput(fixture.identity, [redisResource()]));
    await fixture.runtime.markSetupReady(managed.setupResourceIds);
    const resource = managed.resources[0];
    fixture.cli.resourceExecHealthy = false;

    let resolveFailure!: (resource: PreviewManagedResourceRecord) => void;
    const failure = new Promise<PreviewManagedResourceRecord>((resolve) => { resolveFailure = resolve; });
    await fixture.runtime.watchRequiredResources(
      'task-1', [resource.id], async (failed) => resolveFailure(failed)
    );
    await expect(failure).resolves.toMatchObject({ id: resource.id, state: 'FAILED' });
    expect(fixture.cli.objects.get(resource.container.objectId!)?.running).toBe(true);
    expect(fixture.cli.objects.get(resource.volume.objectId!)?.removed).toBe(false);
  });

  it('retries delivery of a recorded health failure until the owner handles it', async () => {
    const fixture = createFixture();
    const managed = await fixture.runtime.ensureManagedPreview(runtimeInput(fixture.identity, [redisResource()]));
    await fixture.runtime.markSetupReady(managed.setupResourceIds);
    const resource = managed.resources[0];
    fixture.cli.objects.get(resource.container.objectId!)!.running = false;
    let attempts = 0;
    let resolveHandled!: () => void;
    const handled = new Promise<void>((resolve) => { resolveHandled = resolve; });
    const stop = await fixture.runtime.watchRequiredResources('task-1', [resource.id], async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Injected owner update failure.');
      resolveHandled();
    });

    await handled;
    expect(attempts).toBe(2);
    expect((await fixture.store.getPreviewManagedResource(resource.id))?.state).toBe('FAILED');
    await stop();
  });

  it('joins an in-flight health failure callback before destructive cleanup', async () => {
    const fixture = createFixture();
    const managed = await fixture.runtime.ensureManagedPreview(runtimeInput(fixture.identity, [redisResource()]));
    await fixture.runtime.markSetupReady(managed.setupResourceIds);
    const resource = managed.resources[0];
    fixture.cli.objects.get(resource.container.objectId!)!.running = false;
    let releaseFailure!: () => void;
    const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
    let markFailureStarted!: () => void;
    const failureStarted = new Promise<void>((resolve) => { markFailureStarted = resolve; });
    await fixture.runtime.watchRequiredResources('task-1', [resource.id], async () => {
      markFailureStarted();
      await failureGate;
    });
    await failureStarted;

    let cleanupSettled = false;
    const cleanup = fixture.runtime.cleanupTaskResources('task-1').then((result) => {
      cleanupSettled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cleanupSettled).toBe(false);
    releaseFailure();
    await expect(cleanup).resolves.toBe('STOPPED');
  });

  it('supervises only resources attached to the active application generation', async () => {
    const fixture = createFixture();
    const managed = await fixture.runtime.ensureManagedPreview(
      runtimeInput(fixture.identity, [postgresResource(), redisResource()])
    );
    await fixture.runtime.markSetupReady(managed.setupResourceIds);
    const database = managed.resources.find((resource) => resource.logicalResourceId === 'database')!;
    const cache = managed.resources.find((resource) => resource.logicalResourceId === 'cache')!;
    fixture.cli.objects.get(database.container.objectId!)!.running = false;
    let failed = false;
    let resolveFailure!: (resource: PreviewManagedResourceRecord) => void;
    const failure = new Promise<PreviewManagedResourceRecord>((resolve) => { resolveFailure = resolve; });
    await fixture.runtime.watchRequiredResources('task-1', [cache.id], async (resource) => {
        failed = true;
        resolveFailure(resource);
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(failed).toBe(false);
    fixture.cli.objects.get(cache.container.objectId!)!.running = false;
    await expect(failure).resolves.toMatchObject({ id: cache.id, state: 'FAILED' });
    expect((await fixture.store.getPreviewManagedResource(database.id))?.state).toBe('READY');
  });

  it.runIf(process.platform === 'darwin' && process.env.TASK_MONKI_OCI_INTEGRATION === '1')(
    'authenticates, reuses, resets, fails, restart-cleans, and isolates real managed previews',
    async () => {
      const store = new MemoryManagedStore();
      const adapter = new OciEngineAdapter({
        executable: process.env.TASK_MONKI_OCI_BIN || 'docker',
        contextName: process.env.TASK_MONKI_OCI_CONTEXT || 'desktop-linux'
      });
      const capability = await adapter.requireReady();
      const credentialRoot = `/tmp/task-monki-oci-${randomUUID()}`;
      const credentials = new PreviewCredentialHost(credentialRoot);
      const runtime = new OciResourceRuntime(
        store as never,
        adapter,
        new PreviewReadinessService(),
        credentials,
        { healthIntervalMs: 100 }
      );
      const previews = await Promise.all(['one', 'two'].map((suffix) => runtime.ensureManagedPreview({
        taskId: `task-${suffix}`,
        previewKey: `preview-${suffix}`,
        markerDigest: `marker-${suffix}`,
        expectedEngine: capability.identity,
        resources: [postgresResource(), redisResource()]
      })));
      try {
        for (const preview of previews) await runtime.markSetupReady(preview.setupResourceIds);
        const failedSetup = await runtime.ensureManagedPreview({
          taskId: 'task-retry', previewKey: 'preview-retry', markerDigest: 'marker-retry',
          expectedEngine: capability.identity, resources: [redisResource()]
        });
        await runtime.markSetupFailure(failedSetup.setupResourceIds, {
          ambiguous: false,
          reason: 'observed real-engine setup failure'
        });
        await expect(runtime.ensureManagedPreview({
          taskId: 'task-retry', previewKey: 'preview-retry', markerDigest: 'marker-retry',
          expectedEngine: capability.identity, resources: [redisResource()]
        })).rejects.toThrow('setup failed');
        const retriedSetup = await runtime.ensureManagedPreview({
          taskId: 'task-retry', previewKey: 'preview-retry', markerDigest: 'marker-retry',
          expectedEngine: capability.identity, resources: [redisResource()],
          retrySetupResourceIds: failedSetup.setupResourceIds
        });
        expect(identitySummary(retriedSetup)).toEqual(identitySummary(failedSetup));
        await runtime.markSetupReady(retriedSetup.setupResourceIds);
        await expect(runtime.ensureManagedPreview({
          taskId: 'task-retry', previewKey: 'preview-retry', markerDigest: 'marker-retry',
          expectedEngine: capability.identity, resources: [redisResource()]
        })).resolves.toMatchObject({ setupResourceIds: [] });
        const ports = previews.flatMap((preview) => Object.values(preview.bindings).flatMap((binding) => Object.values(binding.ports)));
        expect(new Set(ports).size).toBe(ports.length);
        expect(new Set(previews.flatMap((preview) => Object.values(preview.bindings).map((binding) => binding.postgresUrl ?? binding.redisUrl))).size).toBe(4);
        const firstIdentity = identitySummary(previews[0]);
        await assertRealAuthentication(adapter, previews[0], credentials);

        const replacement = await runtime.ensureManagedPreview({
          taskId: 'task-one', previewKey: 'preview-one', markerDigest: 'marker-one',
          expectedEngine: capability.identity, resources: [postgresResource(), redisResource()]
        });
        expect(replacement.setupResourceIds).toEqual([]);
        expect(identitySummary(replacement)).toEqual(firstIdentity);
        await assertRealAuthentication(adapter, replacement, credentials);

        const oldDatabase = replacement.resources.find((resource) => resource.logicalResourceId === 'database')!;
        const stableCache = replacement.resources.find((resource) => resource.logicalResourceId === 'cache')!;
        await runtime.stopManagedResource(oldDatabase.id);
        const reset = await runtime.ensureManagedPreview({
          taskId: 'task-one', previewKey: 'preview-one', markerDigest: 'marker-one',
          expectedEngine: capability.identity, resources: [postgresResource(), redisResource()]
        });
        await runtime.markSetupReady(reset.setupResourceIds);
        const firstResetDatabase = reset.resources.find(
          (resource) => resource.logicalResourceId === 'database'
        )!;
        expect(firstResetDatabase.id).not.toBe(oldDatabase.id);
        expect(reset.resources.find((resource) => resource.logicalResourceId === 'cache')?.id).toBe(stableCache.id);
        await assertRealAuthentication(adapter, reset, credentials);

        await runtime.stopManagedResource(firstResetDatabase.id);
        const repeatedReset = await runtime.ensureManagedPreview({
          taskId: 'task-one', previewKey: 'preview-one', markerDigest: 'marker-one',
          expectedEngine: capability.identity, resources: [postgresResource(), redisResource()]
        });
        await runtime.markSetupReady(repeatedReset.setupResourceIds);
        const stableDatabase = repeatedReset.resources.find(
          (resource) => resource.logicalResourceId === 'database'
        )!;
        expect(stableDatabase.id).not.toBe(firstResetDatabase.id);
        expect(repeatedReset.resources.find((resource) => resource.logicalResourceId === 'cache')?.id)
          .toBe(stableCache.id);

        await runtime.stopManagedResource(stableCache.id);
        const alternatingReset = await runtime.ensureManagedPreview({
          taskId: 'task-one', previewKey: 'preview-one', markerDigest: 'marker-one',
          expectedEngine: capability.identity, resources: [postgresResource(), redisResource()]
        });
        await runtime.markSetupReady(alternatingReset.setupResourceIds);
        const resetCache = alternatingReset.resources.find(
          (resource) => resource.logicalResourceId === 'cache'
        )!;
        expect(alternatingReset.resources.find((resource) => resource.logicalResourceId === 'database')?.id)
          .toBe(stableDatabase.id);
        expect(resetCache.id).not.toBe(stableCache.id);
        await assertRealAuthentication(adapter, alternatingReset, credentials);

        await adapter.run([
          '--context', capability.identity.contextName,
          'container', 'rm', '--force', resetCache.container.objectId!
        ]);
        let resolveFailure!: (resource: PreviewManagedResourceRecord) => void;
        const failure = new Promise<PreviewManagedResourceRecord>((resolve) => { resolveFailure = resolve; });
        await runtime.watchRequiredResources(
          'task-one', [resetCache.id], async (resource) => resolveFailure(resource)
        );
        const failed = await failure;
        expect(failed).toMatchObject({ id: resetCache.id, state: 'FAILED' });
        await expect(adapter.run([
          '--context', capability.identity.contextName,
          'volume', 'inspect', resetCache.volume.objectId!
        ])).resolves.toBeDefined();

        const restarted = new OciResourceRuntime(
          store as never,
          adapter,
          new PreviewReadinessService(),
          new PreviewCredentialHost(credentialRoot)
        );
        await expect(restarted.cleanupTaskResources('task-one')).resolves.toBe('STOPPED');
        await expect(runtime.cleanupTaskResources('task-two')).resolves.toBe('STOPPED');
      } finally {
        await runtime.cleanupTaskResources().catch(() => undefined);
        await credentials.clear();
      }
      expect(store.resources.every((resource) => resource.state === 'STOPPED')).toBe(true);
      expect(store.environments.every((environment) => environment.state === 'STOPPED')).toBe(true);
      for (const environment of store.environments) {
        await expect(adapter.run([
          '--context', environment.engine.contextName, 'network', 'inspect', environment.network.objectId!
        ])).rejects.toThrow();
      }
      for (const resource of store.resources) {
        await expect(adapter.run([
          '--context', resource.container.engine.contextName, 'container', 'inspect', resource.container.objectId!
        ])).rejects.toThrow();
        await expect(adapter.run([
          '--context', resource.volume.engine.contextName, 'volume', 'inspect', resource.volume.objectId!
        ])).rejects.toThrow();
      }
    },
    180_000
  );
});

async function assertRealAuthentication(
  adapter: OciEngineAdapter,
  runtime: Awaited<ReturnType<OciResourceRuntime['ensureManagedPreview']>>,
  credentials: PreviewCredentialHost
): Promise<void> {
  const database = runtime.resources.find((resource) => resource.logicalResourceId === 'database')!;
  const databaseCredential = credentials.require(database.id);
  const databasePort = runtime.bindings.database.ports.postgres;
  await expect(queryRealPostgres({
    port: databasePort,
    user: databaseCredential.username!,
    password: databaseCredential.password
  })).resolves.toBeUndefined();
  await expect(queryRealPostgres({
    port: databasePort,
    user: databaseCredential.username!,
    password: 'deliberately-wrong-password'
  })).rejects.toThrow();

  const cache = runtime.resources.find((resource) => resource.logicalResourceId === 'cache')!;
  const cacheCredential = credentials.require(cache.id);
  const unauthenticated = await adapter.run([
    '--context', cache.container.engine.contextName,
    'container', 'exec', cache.container.objectId!,
    'redis-cli', 'ping'
  ]);
  expect(unauthenticated.stdout).not.toContain('PONG');
  await expect(adapter.run([
    '--context', cache.container.engine.contextName,
    'container', 'exec', cache.container.objectId!,
    'sh', '-eu', '-c',
    'REDISCLI_AUTH="$(sed -n "s/^requirepass //p" /run/taskmonki/redis.conf)"; export REDISCLI_AUTH; exec redis-cli --no-auth-warning ping'
  ])).resolves.toMatchObject({
    stdout: expect.stringContaining('PONG')
  });
  const surfaces = await Promise.all([
    adapter.run([
      '--context', cache.container.engine.contextName,
      'container', 'inspect', cache.container.objectId!
    ]),
    adapter.run([
      '--context', cache.container.engine.contextName,
      'container', 'logs', cache.container.objectId!
    ]),
    adapter.run([
      '--context', cache.container.engine.contextName,
      'container', 'top', cache.container.objectId!, '-eo', 'pid,user,args'
    ])
  ]);
  for (const surface of surfaces) {
    const serialized = JSON.stringify(surface);
    expect(serialized).not.toContain(cacheCredential.password);
    expect(serialized).not.toContain(encodeURIComponent(cacheCredential.password));
  }
}

async function queryRealPostgres(input: {
  port: number;
  user: string;
  password: string;
}): Promise<void> {
  const client = new PgClient({
    host: '127.0.0.1',
    port: input.port,
    database: 'app',
    user: input.user,
    password: input.password,
    ssl: false,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000
  });
  try {
    await client.connect();
    await client.query('SELECT 1');
  } finally {
    await client.end().catch(() => undefined);
  }
}

function runtimeInput(expectedEngine: PreviewOciEngineIdentity, resources: Array<PreviewPostgresResourcePlan | PreviewRedisResourcePlan>) {
  return {
    taskId: 'task-1',
    previewKey: 'preview-1',
    markerDigest: 'marker-digest',
    expectedEngine,
    resources
  };
}

function identitySummary(runtime: Awaited<ReturnType<OciResourceRuntime['ensureManagedPreview']>>) {
  return {
    environment: runtime.environment.id,
    network: runtime.environment.network.objectId,
    resources: runtime.resources.map((resource) => ({
      id: resource.id,
      container: resource.container.objectId,
      volume: resource.volume.objectId,
      binding: resource.binding
    })),
    bindings: runtime.bindings
  };
}

function redisResource(): PreviewRedisResourcePlan {
  return {
    id: 'cache', type: 'redis', image: 'redis:7-alpine',
    limits: { cpus: 1, memoryMb: 128, diskMb: 256, pids: 64 }
  };
}

function postgresResource(): PreviewPostgresResourcePlan {
  return {
    id: 'database', type: 'postgres', database: 'app', image: 'postgres:17-alpine',
    limits: { cpus: 1, memoryMb: 256, diskMb: 512, pids: 128 }
  };
}

function createFixture(options: {
  failAfter?: 'network-create' | 'volume-create' | 'container-create';
  inheritedLabels?: boolean;
  failRemoveOnce?: 'container' | 'network' | 'volume';
  hostAuthenticationEnv?: boolean;
} = {}) {
  const store = new MemoryManagedStore();
  const cli = new FakeOciCli(options.inheritedLabels === true, options.failRemoveOnce);
  const postgres = new FakePostgresProbe();
  const adapter = new OciEngineAdapter({
    execute: cli.execute,
    env: options.hostAuthenticationEnv
      ? {
          ...process.env,
          PGPASSWORD: 'unrelated-host-postgres-secret',
          REDIS_PASSWORD: 'unrelated-host-redis-secret',
          REDISCLI_AUTH: 'unrelated-host-redis-cli-secret'
        }
      : undefined
  });
  const identity: PreviewOciEngineIdentity = {
    contextName: 'desktop-linux', endpointDigest: cli.endpointDigest, engineId: cli.engineId,
    serverVersion: '28.0.4', apiVersion: '1.48', operatingSystem: 'linux', architecture: 'arm64'
  };
  const credentials = new PreviewCredentialHost(`/tmp/task-monki-credentials-${randomUUID()}`);
  const runtime = new OciResourceRuntime(
    store as never,
    adapter,
    { async waitForTcp() { return { status: 'PASSED' as const }; } } as never,
    credentials,
    {
      healthIntervalMs: 20,
      afterMutation(operation) { if (operation === options.failAfter) throw new Error('injected crash'); },
      postgresProbe: postgres.probe
    }
  );
  return { store, cli, postgres, runtime, identity, credentials };
}

class FakePostgresProbe {
  readonly calls: ManagedPostgresProbeInput[] = [];
  healthy = true;

  probe = async (input: ManagedPostgresProbeInput): Promise<void> => {
    this.calls.push({ ...input });
    if (!this.healthy) throw new Error('authenticated PostgreSQL query failed');
  };
}

class MemoryManagedStore {
  environments: PreviewManagedEnvironmentRecord[] = [];
  resources: PreviewManagedResourceRecord[] = [];
  getStoreIdentity() { return 'store-identity'; }
  async savePreviewManagedEnvironment(environment: PreviewManagedEnvironmentRecord) {
    this.environments = [structuredClone(environment), ...this.environments.filter((candidate) => candidate.id !== environment.id)];
    return structuredClone(environment);
  }
  async getPreviewManagedEnvironment(taskId: string) {
    return structuredClone(this.environments.find((environment) => environment.taskId === taskId));
  }
  async getPreviewManagedEnvironments() { return structuredClone(this.environments); }
  async savePreviewManagedResource(resource: PreviewManagedResourceRecord) {
    this.resources = [structuredClone(resource), ...this.resources.filter((candidate) => candidate.id !== resource.id)];
    return structuredClone(resource);
  }
  async getPreviewManagedResource(id: string) {
    return structuredClone(this.resources.find((resource) => resource.id === id));
  }
  async getPreviewManagedResources(taskId?: string) {
    return structuredClone(this.resources.filter((resource) => !taskId || resource.taskId === taskId));
  }
}

interface FakeObject {
  id: string;
  kind: 'container' | 'network' | 'volume';
  name: string;
  labels: Record<string, string>;
  ports: Record<string, Array<{ HostIp: string; HostPort: string }>>;
  removed: boolean;
  running: boolean;
}

class FakeOciCli {
  readonly calls: Array<{ argv: string[]; env: NodeJS.ProcessEnv }> = [];
  readonly objects = new Map<string, FakeObject>([[
    'unrelated',
    { id: 'unrelated', kind: 'container', name: 'unrelated', labels: {}, ports: {}, removed: false, running: true }
  ]]);
  readonly endpointDigest = 'f120d06200affbb4da036243e8ea30b016001f09b53b4c29cdb696824006c005';
  engineId = 'engine-id';
  resourceExecHealthy = true;
  private sequence = 0;
  private imageAvailable = false;

  constructor(
    private readonly inheritedLabels: boolean,
    private failRemoveOnce?: 'container' | 'network' | 'volume'
  ) {}

  execute: OciCommandExecutor = async (_executable, argv, execution) => {
    this.calls.push({ argv: [...argv], env: { ...execution.env } });
    if (argv[0] === 'context' && argv[1] === 'show') return output('desktop-linux\n');
    if (argv[0] === 'context' && argv[1] === 'inspect') {
      return output(JSON.stringify([{
        Name: 'desktop-linux',
        Endpoints: { docker: { Host: 'unix:///private/docker.sock', SkipTLSVerify: false } }
      }]));
    }
    if (argv.includes('version')) return output(JSON.stringify({
      Server: { Version: '28.0.4', ApiVersion: '1.48', Os: 'linux', Arch: 'aarch64' }
    }));
    if (argv.includes('info')) return output(JSON.stringify({
      ID: this.engineId, MemoryLimit: true, CpuCfsQuota: true, PidsLimit: true
    }));
    const command = argv.slice(2);
    if (command[0] === 'pull') { this.imageAvailable = true; return output('pulled\n'); }
    if (command[0] === 'image' && command[1] === 'inspect') {
      if (!this.imageAvailable) throw new Error('image not found');
      return output('sha256:image-id\n');
    }
    if (['network', 'volume'].includes(command[0]) && command[1] === 'create') {
      return this.create(command[0] as 'network' | 'volume', command);
    }
    if (command[0] === 'container' && command[1] === 'create') return this.create('container', command);
    if (command[0] === 'container' && command[1] === 'start') {
      const object = this.objects.get(command[2]);
      if (object) object.running = true;
      return output('ok\n');
    }
    if (command[0] === 'container' && command[1] === 'exec') {
      if (!this.resourceExecHealthy) throw new Error('authenticated command failed');
      return output('ok\n');
    }
    if (['container', 'network', 'volume'].includes(command[0]) && command[1] === 'inspect') {
      const object = this.objects.get(command[2]);
      if (!object || object.removed) throw new Error('not found');
      return output(JSON.stringify([inspection(object, this.inheritedLabels)]));
    }
    if (['container', 'network', 'volume'].includes(command[0]) && command[1] === 'ls') {
      const expected = command.filter((_, index) => command[index - 1] === '--filter')
        .map((value) => value.replace(/^label=/, ''));
      const ids = [...this.objects.values()].filter((object) =>
        !object.removed && object.kind === command[0] && expected.every((entry) => {
          const separator = entry.indexOf('=');
          return object.labels[entry.slice(0, separator)] === entry.slice(separator + 1);
        })
      ).map((object) => object.id);
      return output(`${ids.join('\n')}${ids.length ? '\n' : ''}`);
    }
    if (['container', 'network', 'volume'].includes(command[0]) && command[1] === 'rm') {
      if (this.failRemoveOnce === command[0]) {
        this.failRemoveOnce = undefined;
        throw new Error('injected cleanup failure');
      }
      const object = this.objects.get(command.at(-1)!);
      if (!object || object.removed) throw new Error('not found');
      object.removed = true;
      return output(`${object.id}\n`);
    }
    throw new Error(`Unexpected fake OCI command: ${argv.join(' ')}`);
  };

  private create(kind: FakeObject['kind'], command: string[]) {
    const id = `${kind}-${++this.sequence}`;
    const name = kind === 'container' ? command[command.indexOf('--name') + 1] : command.at(-1)!;
    const labels = Object.fromEntries(
      command.filter((_, index) => command[index - 1] === '--label').map((entry) => {
        const separator = entry.indexOf('=');
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      })
    );
    const published = command.filter((_, index) => command[index - 1] === '--publish');
    const ports = Object.fromEntries(published.map((entry, index) => {
      const match = /^127\.0\.0\.1::(\d+)\/(tcp|udp)$/.exec(entry)!;
      return [`${match[1]}/${match[2]}`, [{ HostIp: '127.0.0.1', HostPort: String(41_000 + this.sequence + index) }]];
    }));
    this.objects.set(id, { id, kind, name, labels, ports, removed: false, running: kind !== 'container' });
    return output(`${id}\n`);
  }
}

function inspection(object: FakeObject, inheritedLabels: boolean) {
  const labels = inheritedLabels ? { ...object.labels, 'image.inherited': 'allowed' } : object.labels;
  if (object.kind === 'container') {
    return {
      Id: object.id, Name: `/${object.name}`, Config: { Labels: labels },
      NetworkSettings: { Ports: object.ports }, State: { Running: object.running }
    };
  }
  return { Id: object.id, Name: object.name, Labels: labels };
}

function output(stdout: string) { return { stdout, stderr: '' }; }
