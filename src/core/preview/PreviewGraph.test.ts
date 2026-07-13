import { describe, expect, it } from 'vitest';
import type { PreviewExecutionPlan, PreviewJobPlan } from '../../shared/contracts';
import { PreviewGraph, reverseDependencyOrder } from './PreviewGraph';

describe('PreviewGraph', () => {
  it('does not check environment-only attachments and memoizes explicit checks per generation', async () => {
    let checks = 0;
    const runs: Array<Record<string, string>> = [];
    const plan = graphPlan({
      attachments: [{ id: 'smtp', type: 'tcp', target: { type: 'endpoint', host: '127.0.0.1', port: 2525 }, check: { timeoutSeconds: 1 } }],
      jobs: [
        { ...job('env-only', ['node']), env: { SMTP_HOST: { type: 'attached-tcp-host', attachment: 'smtp' } } },
        job('one', ['node'], { smtp: 'ready' }),
        job('two', ['node'], { smtp: 'ready' })
      ], services: [], workers: [], routes: []
    });
    const graph = new PreviewGraph(
      {} as never,
      { async run(input: { env: Record<string, string> }) { runs.push(input.env); } } as never,
      {} as never, {} as never, {} as never, {} as never,
      { async check() { checks += 1; return { status: 'PASSED', observedAt: new Date().toISOString() }; } } as never
    );
    const running = await graph.start({ taskId: 'task', generationId: 'generation', generationRoot: '/tmp', sourcePath: '/tmp', markerDigest: 'marker', plan, runSetup: false, async updateGenerationState() {} });
    expect(checks).toBe(1);
    expect(runs).toContainEqual({ SMTP_HOST: '127.0.0.1' });
    await running.stop();
  });

  it('runs preparation jobs after their declared success dependencies', async () => {
    const starts: string[] = [];
    const plan = graphPlan({
      jobs: [
        job('build', ['node', 'build.mjs'], { install: 'succeeded' }),
        job('install', ['node', 'install.mjs'])
      ],
      services: [], workers: [], routes: []
    });
    const graph = new PreviewGraph(
      {} as never,
      { async run(input: { node: { id: string } }) { starts.push(input.node.id); } } as never,
      {} as never, {} as never, {} as never, {} as never
    );
    const running = await graph.start({
      taskId: 'task', generationId: 'generation', generationRoot: '/tmp', sourcePath: '/tmp',
      markerDigest: 'marker', plan, runSetup: false, async updateGenerationState() {}
    });
    expect(starts).toEqual(['install', 'build']);
    await running.stop();
  });

  it('runs initial setup against preview-owned bindings and reports setup completion before application start', async () => {
    const starts: string[] = [];
    const jobEnvironments: Record<string, Record<string, string>> = {};
    const jobRedactions: Record<string, string[]> = {};
    const cacheUrl = 'redis://:generated@127.0.0.1:41234/0';
    const plan = graphPlan({
      resources: [{
        id: 'cache', type: 'redis', image: 'redis:7-alpine', limits: {}
      }],
      jobs: [
        {
          ...job('migrate', ['node', 'migrate.mjs'], { cache: 'ready' }),
          role: 'migration', retrySafe: false,
          env: { REDIS_URL: { type: 'redis-url', resource: 'cache' } }
        },
        {
          ...job('seed', ['node', 'seed.mjs'], { migrate: 'succeeded' }),
          role: 'seed', retrySafe: true
        }
      ],
      services: [], workers: [], routes: [],
      scenarios: [{ id: 'full', jobs: ['migrate', 'seed'], resources: ['cache'] }],
      selectedScenarioId: 'full'
    });
    const graph = new PreviewGraph(
      {} as never,
      {
        async run(input: { node: { id: string }; env: Record<string, string>; redactions: string[] }) {
          starts.push(input.node.id);
          jobEnvironments[input.node.id] = input.env;
          jobRedactions[input.node.id] = input.redactions;
        }
      } as never,
      {} as never, {} as never, {} as never, {} as never
    );
    const running = await graph.start({
      taskId: 'task', generationId: 'generation', generationRoot: '/tmp', sourcePath: '/tmp',
      markerDigest: 'marker', plan, runSetup: true,
      resourceBindings: {
        cache: {
          ports: { redis: 41234 }, redisUrl: cacheUrl
        },
        unrelated: {
          ports: { redis: 41235 }, redisUrl: 'redis://:credential-for-an-unrelated-resource@127.0.0.1:41235/0'
        }
      },
      async onSetupComplete() { starts.push('setup-complete'); },
      async updateGenerationState() {}
    });
    expect(starts).toEqual(['migrate', 'seed', 'setup-complete']);
    expect(jobEnvironments.migrate.REDIS_URL).toBe(cacheUrl);
    expect(jobRedactions.migrate).toEqual([cacheUrl, 'generated']);
    expect(jobRedactions.seed).toEqual([]);
    expect(jobRedactions.migrate).not.toContain('credential-for-an-unrelated-resource');
    await running.stop();
  });

  it('treats selected setup jobs as already satisfied during ordinary replacement', async () => {
    const events: string[] = [];
    const fixture = longRunningFixture(events);
    const plan = replacementPlan('safe');
    plan.workers = [];
    plan.resources = [{ id: 'cache', type: 'redis', image: 'redis:7-alpine', limits: {} }];
    plan.jobs = [{
      ...job('setup', ['node', 'setup.mjs'], { cache: 'ready' }),
      role: 'migration', retrySafe: true
    }];
    plan.services[0].needs = { cache: 'ready', setup: 'succeeded' };
    plan.scenarios = [{ id: 'full', jobs: ['setup'], resources: ['cache'] }];
    plan.selectedScenarioId = 'full';
    const graph = new PreviewGraph(
      fixture.store as never,
      fixture.jobs as never,
      fixture.services as never,
      fixture.readiness as never,
      fixture.ports as never,
      fixture.listeners as never
    );

    const running = await graph.start({
      taskId: 'task', generationId: 'replacement', generationRoot: '/tmp', sourcePath: '/tmp',
      markerDigest: 'marker', plan, runSetup: false,
      resourceBindings: {
        cache: { ports: { redis: 41_234 }, redisUrl: 'redis://stable' }
      },
      async updateGenerationState() {}
    });

    expect(events).toContain('start:web');
    expect(events).not.toContain('job:setup');
    await running.stop();
  });

  it('fails closed for a cycle even if a malformed plan bypasses recipe validation', async () => {
    const plan = graphPlan({
      jobs: [
        job('a', ['node'], { b: 'succeeded' }),
        job('b', ['node'], { a: 'succeeded' })
      ],
      services: [], workers: [], routes: []
    });
    const graph = new PreviewGraph(
      {} as never, {} as never, {} as never, {} as never, {} as never, {} as never
    );
    await expect(graph.start({
      taskId: 'task', generationId: 'generation', generationRoot: '/tmp', sourcePath: '/tmp',
      markerDigest: 'marker', plan, runSetup: false, async updateGenerationState() {}
    })).rejects.toThrow('cycle');
  });

  it('runs independent DAG nodes concurrently while capping native effects at four', async () => {
    let active = 0;
    let maximum = 0;
    const starts: string[] = [];
    const jobs = {
      async run(input: { node: { id: string } }) {
        active += 1;
        maximum = Math.max(maximum, active);
        starts.push(input.node.id);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
      }
    };
    const graph = new PreviewGraph(
      {} as never,
      jobs as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );
    const plan = graphPlan({
      jobs: Array.from({ length: 8 }, (_, index) => job(`job-${index}`, ['node'])),
      services: [],
      workers: [],
      routes: []
    });
    const running = await graph.start({
      taskId: 'task', generationId: 'generation', generationRoot: '/tmp', sourcePath: '/tmp',
      markerDigest: 'marker', plan, runSetup: false, async updateGenerationState() {}
    });
    expect(starts).toHaveLength(8);
    expect(maximum).toBe(4);
    await expect(running.stop()).resolves.toBe('ALREADY_EXITED');
  });

  it('waits for every in-flight DAG effect to settle before failed-start cleanup returns', async () => {
    let slowSettled = false;
    const graph = new PreviewGraph(
      {} as never,
      {
        async run(input: { node: { id: string } }) {
          if (input.node.id === 'fail') throw new Error('injected failure');
          await new Promise((resolve) => setTimeout(resolve, 25));
          slowSettled = true;
        }
      } as never,
      {} as never, {} as never, {} as never, {} as never
    );
    const plan = graphPlan({
      jobs: [
        job('fail', ['node']),
        job('slow', ['node'])
      ],
      services: [], workers: [], routes: []
    });
    await expect(graph.start({
      taskId: 'task', generationId: 'generation', generationRoot: '/tmp', sourcePath: '/tmp',
      markerDigest: 'marker', plan, runSetup: false, async updateGenerationState() {}
    })).rejects.toThrow('injected failure');
    expect(slowSettled).toBe(true);
  });

  it('does not launch queued native effects after a sibling fails', async () => {
    const starts: string[] = [];
    const graph = new PreviewGraph(
      {} as never,
      {
        async run(input: { node: { id: string } }) {
          starts.push(input.node.id);
          if (input.node.id === 'a-fail') throw new Error('injected queued failure');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } as never,
      {} as never, {} as never, {} as never, {} as never
    );
    const plan = graphPlan({
      jobs: ['a-fail', 'b-slow', 'c-slow', 'd-slow', 'e-queued', 'f-queued'].map(
        (id) => job(id, ['node'])
      ),
      services: [], workers: [], routes: []
    });
    await expect(graph.start({
      taskId: 'task', generationId: 'generation', generationRoot: '/tmp', sourcePath: '/tmp',
      markerDigest: 'marker', plan, runSetup: false, async updateGenerationState() {}
    })).rejects.toThrow('queued failure');
    expect(starts.sort()).toEqual(['a-fail', 'b-slow', 'c-slow', 'd-slow']);
  });

  it('computes reverse dependency shutdown with consumers before providers', () => {
    const plan = graphPlan({
      jobs: [job('install', ['npm', 'install'])],
      services: [
        {
          id: 'api', cwd: '.', command: ['node', 'api'], needs: { install: 'succeeded' }, env: {},
          ports: { http: { env: 'API_PORT' } }, ready: { type: 'tcp', port: 'http', timeoutSeconds: 5 },
          critical: true, restart: { mode: 'never', maxRestarts: 0, backoffMs: 250 }
        },
        {
          id: 'web', cwd: '.', command: ['node', 'web'], needs: { api: 'ready' }, env: {},
          ports: { http: { env: 'WEB_PORT' } }, ready: { type: 'tcp', port: 'http', timeoutSeconds: 5 },
          critical: true, restart: { mode: 'never', maxRestarts: 0, backoffMs: 250 }
        }
      ],
      workers: [{
        id: 'indexer', cwd: '.', command: ['node', 'worker'], needs: { api: 'ready' }, env: {}, ports: {},
        ready: { type: 'argv', cwd: '.', command: ['node', 'worker-ready'], timeoutSeconds: 5 },
        overlap: 'exclusive', critical: false, restart: { mode: 'never', maxRestarts: 0, backoffMs: 250 }
      }],
      routes: [{ id: 'app', service: 'web', port: 'http', primary: true }]
    });
    const order = reverseDependencyOrder(plan);
    expect(order.indexOf('web')).toBeLessThan(order.indexOf('api'));
    expect(order.indexOf('indexer')).toBeLessThan(order.indexOf('api'));
    expect(order.indexOf('api')).toBeLessThan(order.indexOf('install'));
  });

  it('keeps stop and port release pending until an active argv liveness probe settles', async () => {
    let resolveCompletion!: (value: {
      receipt: { state: 'EXITED'; exitCode: number; signal: null };
      wasStopping: boolean;
    }) => void;
    const completion = new Promise<{
      receipt: { state: 'EXITED'; exitCode: number; signal: null };
      wasStopping: boolean;
    }>((resolve) => { resolveCompletion = resolve; });
    let running = true;
    let markProbeStarted!: () => void;
    const probeStarted = new Promise<void>((resolve) => { markProbeStarted = resolve; });
    let markProbeCanceled!: () => void;
    const probeCanceled = new Promise<void>((resolve) => { markProbeCanceled = resolve; });
    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
    let probeSettled = false;
    let stopResolved = false;
    let duplicateStopResolved = false;
    let stopCalls = 0;
    const releasedPorts: number[] = [];
    const plan = graphPlan({
      jobs: [],
      services: [{
        id: 'web', cwd: '.', command: ['node', 'server.mjs'], needs: {}, env: {},
        ports: { http: { env: 'PORT' } },
        ready: { type: 'argv', cwd: '.', command: ['node', 'ready.mjs'], timeoutSeconds: 5 },
        critical: true,
        restart: { mode: 'never', maxRestarts: 0, backoffMs: 0 },
        liveness: {
          probe: { type: 'argv', cwd: '.', command: ['node', 'health.mjs'], timeoutSeconds: 5 },
          intervalSeconds: 0,
          failureThreshold: 1
        }
      }],
      workers: [],
      routes: []
    });
    const graph = new PreviewGraph(
      {
        async savePreviewNodeAttempt(value: unknown) { return value; },
        async prunePreviewProbeHistory() { return 0; }
      } as never,
      {
        async run(input: { kind?: string; attempt?: number; signal?: AbortSignal }) {
          if (input.kind !== 'PROBE') return;
          if (input.attempt === 1) return;
          markProbeStarted();
          await new Promise<void>((resolve) => {
            if (input.signal?.aborted) resolve();
            else input.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          markProbeCanceled();
          await probeGate;
          probeSettled = true;
          throw new Error('probe canceled');
        }
      } as never,
      {
        async start() {
          return {
            attempt: { id: 'attempt' },
            resource: { id: 'resource' },
            owned: {},
            stdoutArtifactId: 'stdout',
            stderrArtifactId: 'stderr',
            completion,
            isRunning: () => running
          };
        },
        async stop() {
          stopCalls += 1;
          running = false;
          resolveCompletion({
            receipt: { state: 'EXITED', exitCode: 0, signal: null },
            wasStopping: true
          });
          return 'STOPPED' as const;
        }
      } as never,
      {} as never,
      {
        async allocate() { return 41_001; },
        release(port: number) { releasedPorts.push(port); }
      } as never,
      {} as never
    );
    const active = await graph.start({
      taskId: 'task', generationId: 'generation', generationRoot: '/tmp', sourcePath: '/tmp',
      markerDigest: 'marker', plan, runSetup: false, async updateGenerationState() {}
    });
    await probeStarted;

    const stopping = active.stop().then((result) => {
      stopResolved = true;
      return result;
    });
    const duplicateStop = active.stop().then((result) => {
      duplicateStopResolved = true;
      return result;
    });
    await probeCanceled;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const beforeProbeSettlement = {
      stopResolved,
      duplicateStopResolved,
      releasedPorts: [...releasedPorts]
    };
    releaseProbe();

    await expect(stopping).resolves.toBe('STOPPED');
    await expect(duplicateStop).resolves.toBe('ALREADY_EXITED');
    expect(beforeProbeSettlement).toEqual({
      stopResolved: false,
      duplicateStopResolved: false,
      releasedPorts: []
    });
    expect(probeSettled).toBe(true);
    expect(stopCalls).toBe(1);
    expect(running).toBe(false);
    expect(releasedPorts).toEqual([41_001]);
  });

  it('starts routed services before exclusive handoff and restores the old exclusive worker with bounded readiness', async () => {
    const events: string[] = [];
    const fixture = longRunningFixture(events);
    const graph = new PreviewGraph(
      fixture.store as never,
      fixture.jobs as never,
      fixture.services as never,
      fixture.readiness as never,
      fixture.ports as never,
      fixture.listeners as never,
      { async check() { events.push('check:upstream'); return { status: 'PASSED', observedAt: new Date().toISOString() }; } } as never
    );
    const plan = replacementPlan('exclusive');
    plan.attachments = [{
      id: 'upstream', type: 'http',
      target: { type: 'endpoint', scheme: 'http', host: '127.0.0.1', port: 8080, basePath: '/' },
      check: { path: '/ready', timeoutSeconds: 5 }
    }];
    plan.workers[0].needs = { upstream: 'ready' };
    plan.workers[0].env = {
      UPSTREAM_ORIGIN: { type: 'attached-http-origin', attachment: 'upstream' }
    };
    const running = await graph.start({
      taskId: 'task', generationId: 'old', generationRoot: '/tmp', sourcePath: '/tmp',
      markerDigest: 'marker', plan, runSetup: false,
      async beforeExclusiveStart() { events.push('handoff-boundary'); },
      async updateGenerationState() {}
    });

    expect(events.indexOf('start:web')).toBeLessThan(events.indexOf('handoff-boundary'));
    expect(events.indexOf('check:upstream')).toBeLessThan(events.indexOf('handoff-boundary'));
    expect(events.indexOf('handoff-boundary')).toBeLessThan(events.indexOf('start:consumer'));
    expect(events.filter((event) => event === 'check:upstream')).toHaveLength(1);
    await expect(running.stopExclusive()).resolves.toBe('STOPPED');
    await expect(running.restoreExclusive()).resolves.toBe(true);
    expect(events.filter((event) => event === 'start:consumer')).toHaveLength(2);
    expect(fixture.readinessDeadlines).toEqual([5_000, 5_000, 5_000]);
    await running.stop();
  });

  it('allows an approval-bound safe worker to overlap without invoking exclusive handoff', async () => {
    const events: string[] = [];
    const fixture = longRunningFixture(events);
    const graph = new PreviewGraph(
      fixture.store as never,
      fixture.jobs as never,
      fixture.services as never,
      fixture.readiness as never,
      fixture.ports as never,
      fixture.listeners as never
    );
    let handoff = false;
    const running = await graph.start({
      taskId: 'task', generationId: 'candidate', generationRoot: '/tmp', sourcePath: '/tmp',
      markerDigest: 'marker', plan: replacementPlan('safe'), runSetup: false,
      async beforeExclusiveStart() { handoff = true; },
      async updateGenerationState() {}
    });
    expect(events).toEqual(expect.arrayContaining(['start:web', 'start:consumer']));
    expect(handoff).toBe(false);
    await expect(running.stopExclusive()).resolves.toBe('ALREADY_EXITED');
    await running.stop();
  });
});

function replacementPlan(overlap: 'exclusive' | 'safe'): PreviewExecutionPlan {
  return graphPlan({
    jobs: [],
    services: [{
      id: 'web', cwd: '.', command: ['node', 'web'], needs: {}, env: {},
      ports: { http: { env: 'PORT' } },
      ready: { type: 'tcp', port: 'http', timeoutSeconds: 5 },
      critical: true, restart: { mode: 'never', maxRestarts: 0, backoffMs: 0 }
    }],
    workers: [{
      id: 'consumer', cwd: '.', command: ['node', 'worker'], needs: {}, env: {}, ports: {},
      ready: { type: 'argv', cwd: '.', command: ['node', 'worker-ready'], timeoutSeconds: 5 },
      overlap, critical: true, restart: { mode: 'never', maxRestarts: 0, backoffMs: 0 }
    }],
    routes: [{ id: 'app', service: 'web', port: 'http', primary: true }]
  });
}

function longRunningFixture(events: string[]) {
  let port = 41_000;
  let sequence = 0;
  const processes = new Map<string, {
    running: boolean;
    resolve(value: { receipt: { state: 'EXITED'; exitCode: number; signal: null }; wasStopping: boolean }): void;
  }>();
  const readinessDeadlines: number[] = [];
  return {
    readinessDeadlines,
    store: {
      async savePreviewNodeAttempt<T>(attempt: T) { return attempt; },
      async prunePreviewProbeHistory() { return 0; }
    },
    jobs: {
      async run(input: { kind?: string; timeoutMs?: number; node: { id: string } }) {
        if (input.kind !== 'PROBE') events.push(`job:${input.node.id}`);
        if (input.kind === 'PROBE' && input.timeoutMs) readinessDeadlines.push(input.timeoutMs);
      }
    },
    services: {
      async start(input: { node: { id: string }; attempt: number }) {
        events.push(`start:${input.node.id}`);
        const id = `${input.node.id}-${input.attempt}-${++sequence}`;
        let resolve!: (value: {
          receipt: { state: 'EXITED'; exitCode: number; signal: null };
          wasStopping: boolean;
        }) => void;
        const completion = new Promise<{
          receipt: { state: 'EXITED'; exitCode: number; signal: null };
          wasStopping: boolean;
        }>((done) => { resolve = done; });
        processes.set(id, { running: true, resolve });
        return {
          attempt: { id: `attempt-${id}` },
          resource: {
            id,
            native: { target: { processGroupId: sequence } }
          },
          completion,
          isRunning: () => processes.get(id)?.running === true
        };
      },
      async stop(resource: { id: string }) {
        const process = processes.get(resource.id);
        if (!process?.running) return 'ALREADY_EXITED' as const;
        events.push(`stop:${resource.id.split('-')[0]}`);
        process.running = false;
        process.resolve({
          receipt: { state: 'EXITED', exitCode: 0, signal: null },
          wasStopping: true
        });
        return 'STOPPED' as const;
      }
    },
    readiness: {
      async waitForTcp(input: { timeoutMs: number }) {
        readinessDeadlines.push(input.timeoutMs);
        return { status: 'PASSED' as const, observedAt: new Date().toISOString() };
      }
    },
    ports: {
      async allocate() { return ++port; },
      release() {}
    },
    listeners: { async assertOwnedLoopback() {} }
  };
}

function graphPlan(
  input: Pick<PreviewExecutionPlan, 'jobs' | 'services' | 'workers' | 'routes'> &
    Partial<Pick<PreviewExecutionPlan, 'resources' | 'attachments' | 'scenarios' | 'selectedScenarioId'>>
): PreviewExecutionPlan {
  return {
    version: 1,
    jobs: input.jobs,
    services: input.services,
    workers: input.workers,
    routes: input.routes,
    resources: input.resources ?? [],
    attachments: input.attachments ?? [],
    scenarios: input.scenarios ?? [{ id: 'default', jobs: [], resources: [] }],
    selectedScenarioId: input.selectedScenarioId ?? 'default'
  };
}

function job(
  id: string,
  command: string[],
  needs: PreviewJobPlan['needs'] = {}
): PreviewJobPlan {
  return {
    id,
    cwd: '.',
    command,
    needs,
    env: {},
    role: 'generic',
    retrySafe: false
  };
}
