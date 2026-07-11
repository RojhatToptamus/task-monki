import { describe, expect, it } from 'vitest';
import type { PreviewExecutionPlan, PreviewJobPlan } from '../../shared/contracts';
import { PreviewGraph, reverseDependencyOrder } from './PreviewGraph';

describe('PreviewGraph', () => {
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
      markerDigest: 'marker', plan, async updateGenerationState() {}
    });
    expect(starts).toEqual(['install', 'build']);
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
      markerDigest: 'marker', plan, async updateGenerationState() {}
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
      markerDigest: 'marker', plan, async updateGenerationState() {}
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
      markerDigest: 'marker', plan, async updateGenerationState() {}
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
      markerDigest: 'marker', plan, async updateGenerationState() {}
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
        critical: false, restart: { mode: 'never', maxRestarts: 0, backoffMs: 250 }
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
      markerDigest: 'marker', plan, async updateGenerationState() {}
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
});

function graphPlan(
  input: Pick<PreviewExecutionPlan, 'jobs' | 'services' | 'workers' | 'routes'>
): PreviewExecutionPlan {
  return {
    version: 1,
    ...input,
    resources: [],
    scenarios: [{ id: 'default', jobs: [], resources: [] }],
    selectedScenarioId: 'default'
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
