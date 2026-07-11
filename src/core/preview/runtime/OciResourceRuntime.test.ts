import { describe, expect, it } from 'vitest';
import type {
  PreviewOciEngineIdentity,
  PreviewOciResourceRecord,
  PreviewPostgresResourcePlan,
  PreviewRedisResourcePlan
} from '../../../shared/contracts';
import { PreviewReadinessService } from '../PreviewReadinessService';
import { OciEngineAdapter, type OciCommandExecutor } from './OciEngineAdapter';
import { OciResourceRuntime, OciRuntimeError } from './OciResourceRuntime';

describe('OciResourceRuntime', () => {
  it('creates isolated labeled resources, keeps generated credentials out of argv and records, and cleans exact IDs', async () => {
    const fixture = createFixture();
    const running = await fixture.runtime.startGeneration(generationInput(fixture.identity));
    const binding = await running.startResource(redisResource());

    expect(binding.redisUrl).toMatch(/^redis:\/\/:.+@127\.0\.0\.1:41\d{3}\/0$/);
    expect(fixture.store.resources.map((resource) => resource.adapterKind).sort()).toEqual([
      'OCI_CONTAINER', 'OCI_NETWORK', 'OCI_VOLUME'
    ]);
    expect(fixture.store.resources.every((resource) => resource.oci.objectId)).toBe(true);
    expect(new Set(fixture.store.resources.map((resource) => resource.oci.objectId)).size).toBe(3);

    const generatedPassword = decodeURIComponent(binding.redisUrl!.split(':')[2].split('@')[0]);
    expect(fixture.cli.calls.some((call) => call.argv.includes(generatedPassword))).toBe(false);
    expect(JSON.stringify(fixture.store.resources)).not.toContain(generatedPassword);
    expect(fixture.cli.calls.some((call) => call.env.REDIS_PASSWORD === generatedPassword)).toBe(true);

    await expect(running.stop()).resolves.toBe('STOPPED');
    expect(fixture.cli.objects.get('unrelated')?.removed).toBe(false);
    expect([...fixture.cli.objects.values()].filter((object) => object.id !== 'unrelated').every((object) => object.removed)).toBe(true);
  });

  it('recovers the create-before-record crash window by exact full-label discovery', async () => {
    const fixture = createFixture({ failAfter: 'network-create' });
    await expect(
      fixture.runtime.startGeneration(generationInput(fixture.identity))
    ).rejects.toThrow('injected crash');

    const [intended] = fixture.store.resources;
    expect(intended).toMatchObject({ adapterKind: 'OCI_NETWORK', state: 'INTENDED' });
    expect(intended.oci.objectId).toBeUndefined();
    await expect(fixture.runtime.stop(intended)).resolves.toBe('STOPPED');
    expect(fixture.cli.objects.get('unrelated')?.removed).toBe(false);
  });

  it.each(['volume-create', 'container-create'] as const)(
    'recovers the %s create-before-record crash window without touching unrelated objects',
    async (operation) => {
      const fixture = createFixture({ failAfter: operation });
      const running = await fixture.runtime.startGeneration(generationInput(fixture.identity));
      await expect(running.startResource(redisResource())).rejects.toThrow('injected crash');
      await expect(running.stop()).resolves.toBe('STOPPED');
      expect([...fixture.cli.objects.values()]
        .filter((object) => object.id !== 'unrelated')
        .every((object) => object.removed)).toBe(true);
      expect(fixture.cli.objects.get('unrelated')?.removed).toBe(false);
    }
  );

  it('distinguishes pull and architecture failures and refuses cleanup after context retargeting', async () => {
    const pullFailure = createFixture({ failPull: true });
    const generation = await pullFailure.runtime.startGeneration(generationInput(pullFailure.identity));
    await expect(generation.startResource(redisResource())).rejects.toMatchObject({
      code: 'IMAGE_PULL_FAILED'
    } satisfies Partial<OciRuntimeError>);

    const wrongArchitecture = createFixture({ pullError: 'no matching manifest for linux/arm64' });
    const incompatible = await wrongArchitecture.runtime.startGeneration(
      generationInput(wrongArchitecture.identity)
    );
    await expect(incompatible.startResource(redisResource())).rejects.toMatchObject({
      code: 'IMAGE_ARCHITECTURE_MISMATCH'
    } satisfies Partial<OciRuntimeError>);

    const retargeted = createFixture();
    const active = await retargeted.runtime.startGeneration(generationInput(retargeted.identity));
    await active.startResource(redisResource());
    retargeted.cli.engineId = 'another-engine';
    await expect(active.stop()).resolves.toBe('REFUSED');
    expect(retargeted.store.resources.some((resource) => resource.state === 'CLEANUP_INCOMPLETE')).toBe(true);
    expect(retargeted.cli.objects.get('unrelated')?.removed).toBe(false);
  });

  it('reuses preview-scoped data across generations and resets only its exact volume', async () => {
    const fixture = createFixture();
    const resource = { ...redisResource(), scope: 'preview' as const };
    const first = await fixture.runtime.startGeneration(generationInput(fixture.identity));
    await first.startResource(resource);
    const volumeId = fixture.store.resources.find(
      (candidate) => candidate.adapterKind === 'OCI_VOLUME'
    )!.oci.objectId!;
    await first.stop();
    expect(fixture.cli.objects.get(volumeId)?.removed).toBe(false);

    const second = await fixture.runtime.startGeneration({
      ...generationInput(fixture.identity), generationId: 'generation-2'
    });
    await second.startResource(resource);
    expect(fixture.store.resources.filter((candidate) => candidate.adapterKind === 'OCI_VOLUME')).toHaveLength(1);
    await second.stop();

    await expect(fixture.runtime.resetDataResource('task-1', 'cache')).resolves.toBe('STOPPED');
    expect(fixture.cli.objects.get(volumeId)?.removed).toBe(true);
    expect(fixture.cli.objects.get('unrelated')?.removed).toBe(false);
  });

  it('hands non-target generation data to the reset replacement without deleting it', async () => {
    const fixture = createFixture();
    const first = await fixture.runtime.startGeneration(generationInput(fixture.identity));
    await first.startResource(postgresResource());
    await first.startResource(redisResource());
    const firstVolumes = Object.fromEntries(fixture.store.resources
      .filter((candidate) => candidate.adapterKind === 'OCI_VOLUME')
      .map((candidate) => [candidate.logicalNodeId, candidate.oci.objectId!]));

    await fixture.runtime.prepareDataReset('generation-1');
    await first.stop();
    expect(fixture.cli.objects.get(firstVolumes.database)?.removed).toBe(false);
    expect(fixture.cli.objects.get(firstVolumes.cache)?.removed).toBe(false);
    await fixture.runtime.resetDataResource('task-1', 'database');
    expect(fixture.cli.objects.get(firstVolumes.database)?.removed).toBe(true);
    expect(fixture.cli.objects.get(firstVolumes.cache)?.removed).toBe(false);

    const second = await fixture.runtime.startGeneration({
      ...generationInput(fixture.identity), generationId: 'generation-2'
    });
    await second.startResource(postgresResource());
    await second.startResource(redisResource());
    const liveVolumes = fixture.store.resources.filter(
      (candidate) => candidate.adapterKind === 'OCI_VOLUME' && candidate.state !== 'STOPPED'
    );
    expect(liveVolumes.find((candidate) => candidate.logicalNodeId === 'cache')?.oci.objectId)
      .toBe(firstVolumes.cache);
    expect(liveVolumes.find((candidate) => candidate.logicalNodeId === 'database')?.oci.objectId)
      .not.toBe(firstVolumes.database);
    await second.stop();
    expect(fixture.cli.objects.get(firstVolumes.cache)?.removed).toBe(true);
  });

  it.runIf(process.platform === 'darwin' && process.env.TASK_MONKI_OCI_INTEGRATION === '1')(
    'starts two isolated real PostgreSQL and Redis stacks and cleans every owned object',
    async () => {
      const store = new MemoryResourceStore();
      const adapter = new OciEngineAdapter({
        executable: process.env.TASK_MONKI_OCI_BIN || 'docker',
        contextName: process.env.TASK_MONKI_OCI_CONTEXT || 'desktop-linux'
      });
      const capability = await adapter.requireReady();
      const runtime = new OciResourceRuntime(store as never, adapter, new PreviewReadinessService());
      const generations = await Promise.all(['one', 'two'].map((suffix) => runtime.startGeneration({
        taskId: `task-${suffix}`,
        generationId: `generation-${suffix}`,
        markerDigest: `marker-${suffix}`,
        expectedEngine: capability.identity
      })));
      try {
        const bindings = await Promise.all(generations.flatMap((generation) => [
          generation.startResource(postgresResource()),
          generation.startResource(redisResource())
        ]));
        const ports = bindings.flatMap((binding) => Object.values(binding.ports));
        expect(new Set(ports).size).toBe(ports.length);
        expect(bindings.filter((binding) => binding.postgresUrl)).toHaveLength(2);
        expect(bindings.filter((binding) => binding.redisUrl)).toHaveLength(2);
        expect(new Set(bindings.map((binding) => binding.postgresUrl ?? binding.redisUrl)).size).toBe(4);
      } finally {
        await Promise.all(generations.map((generation) => generation.stop()));
        await runtime.cleanupTaskResources();
      }
      expect(store.resources.every((resource) => resource.state === 'STOPPED')).toBe(true);
    },
    180_000
  );
});

function generationInput(expectedEngine: PreviewOciEngineIdentity) {
  return {
    taskId: 'task-1',
    generationId: 'generation-1',
    markerDigest: 'marker-digest',
    expectedEngine
  };
}

function redisResource(): PreviewRedisResourcePlan {
  return {
    id: 'cache',
    type: 'redis',
    image: 'redis:7-alpine',
    scope: 'generation',
    limits: { cpus: 1, memoryMb: 128, diskMb: 256, pids: 64 }
  };
}

function postgresResource(): PreviewPostgresResourcePlan {
  return {
    id: 'database',
    type: 'postgres',
    database: 'app',
    image: 'postgres:17-alpine',
    scope: 'generation',
    limits: { cpus: 1, memoryMb: 256, diskMb: 512, pids: 128 }
  };
}

function createFixture(options: { failAfter?: string; failPull?: boolean; pullError?: string } = {}) {
  const store = new MemoryResourceStore();
  const cli = new FakeOciCli(options.pullError ?? (options.failPull ? 'registry unavailable' : undefined));
  const adapter = new OciEngineAdapter({ execute: cli.execute });
  const identity: PreviewOciEngineIdentity = {
    contextName: 'desktop-linux',
    endpointDigest: cli.endpointDigest,
    engineId: cli.engineId,
    serverVersion: '28.0.4',
    apiVersion: '1.48',
    operatingSystem: 'linux',
    architecture: 'arm64'
  };
  const runtime = new OciResourceRuntime(
    store as never,
    adapter,
    {
      async waitForTcp() { return { status: 'PASSED' as const }; },
      async waitForHttp() { return { status: 'PASSED' as const }; }
    } as never,
    {
      afterMutation(operation) {
        if (operation === options.failAfter) throw new Error('injected crash');
      }
    }
  );
  return { store, cli, runtime, identity };
}

class MemoryResourceStore {
  resources: PreviewOciResourceRecord[] = [];
  getStoreIdentity() { return 'store-identity'; }
  async savePreviewResource(resource: PreviewOciResourceRecord) {
    this.resources = [structuredClone(resource), ...this.resources.filter((candidate) => candidate.id !== resource.id)];
    return structuredClone(resource);
  }
  async getPreviewResources(generationId?: string) {
    return structuredClone(this.resources.filter((resource) => !generationId || resource.generationId === generationId));
  }
}

interface FakeObject {
  id: string;
  kind: 'container' | 'network' | 'volume';
  name: string;
  labels: Record<string, string>;
  ports: Record<string, Array<{ HostIp: string; HostPort: string }>>;
  removed: boolean;
}

class FakeOciCli {
  readonly calls: Array<{ argv: string[]; env: NodeJS.ProcessEnv }> = [];
  readonly objects = new Map<string, FakeObject>([[
    'unrelated',
    { id: 'unrelated', kind: 'container', name: 'unrelated', labels: {}, ports: {}, removed: false }
  ]]);
  readonly endpointDigest = 'f120d06200affbb4da036243e8ea30b016001f09b53b4c29cdb696824006c005';
  engineId = 'engine-id';
  private sequence = 0;
  private imageAvailable = false;

  constructor(private readonly pullError?: string) {}

  execute: OciCommandExecutor = async (_executable, argv, execution) => {
    this.calls.push({ argv: [...argv], env: { ...execution.env } });
    if (argv[0] === 'context' && argv[1] === 'show') return output('desktop-linux\n');
    if (argv[0] === 'context' && argv[1] === 'inspect') {
      return output(JSON.stringify([{
        Name: 'desktop-linux',
        Endpoints: { docker: { Host: 'unix:///private/docker.sock', SkipTLSVerify: false } }
      }]));
    }
    if (argv.includes('version')) {
      return output(JSON.stringify({
        Server: { Version: '28.0.4', ApiVersion: '1.48', Os: 'linux', Arch: 'aarch64' }
      }));
    }
    if (argv.includes('info')) {
      return output(JSON.stringify({
        ID: this.engineId, MemoryLimit: true, CpuCfsQuota: true, PidsLimit: true
      }));
    }
    const command = argv.slice(2);
    if (command[0] === 'pull') {
      if (this.pullError) throw new Error(this.pullError);
      this.imageAvailable = true;
      return output('pulled\n');
    }
    if (command[0] === 'image' && command[1] === 'inspect') {
      if (!this.imageAvailable) throw new Error('image not found');
      return output('sha256:image-id\n');
    }
    if (['network', 'volume'].includes(command[0]) && command[1] === 'create') {
      return this.create(command[0] as 'network' | 'volume', command);
    }
    if (command[0] === 'container' && command[1] === 'create') return this.create('container', command);
    if (command[0] === 'container' && ['start', 'exec'].includes(command[1])) return output('ok\n');
    if (['container', 'network', 'volume'].includes(command[0]) && command[1] === 'inspect') {
      const object = this.objects.get(command[2]);
      if (!object || object.removed) throw new Error('not found');
      return output(JSON.stringify([inspection(object)]));
    }
    if (['container', 'network', 'volume'].includes(command[0]) && command[1] === 'ls') {
      const expected = command.filter((value, index) => command[index - 1] === '--filter')
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
      const id = command.at(-1)!;
      const object = this.objects.get(id);
      if (!object || object.removed) throw new Error('not found');
      object.removed = true;
      return output(`${id}\n`);
    }
    throw new Error(`Unexpected fake OCI command: ${argv.join(' ')}`);
  };

  private create(kind: FakeObject['kind'], command: string[]) {
    const id = `${kind}-${++this.sequence}`;
    const name = kind === 'container'
      ? command[command.indexOf('--name') + 1]
      : command.at(-1)!;
    const labels = Object.fromEntries(
      command.filter((value, index) => command[index - 1] === '--label').map((entry) => {
        const separator = entry.indexOf('=');
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      })
    );
    const published = command.filter((value, index) => command[index - 1] === '--publish');
    const ports = Object.fromEntries(published.map((entry, index) => {
      const match = /^127\.0\.0\.1::(\d+)\/(tcp|udp)$/.exec(entry)!;
      return [`${match[1]}/${match[2]}`, [{ HostIp: '127.0.0.1', HostPort: String(41_000 + this.sequence + index) }]];
    }));
    this.objects.set(id, { id, kind, name, labels, ports, removed: false });
    return output(`${id}\n`);
  }
}

function inspection(object: FakeObject) {
  if (object.kind === 'container') {
    return {
      Id: object.id,
      Name: `/${object.name}`,
      Config: { Labels: object.labels },
      NetworkSettings: { Ports: object.ports }
    };
  }
  return { Id: object.id, Name: object.name, Labels: object.labels };
}

function output(stdout: string) {
  return { stdout, stderr: '' };
}
