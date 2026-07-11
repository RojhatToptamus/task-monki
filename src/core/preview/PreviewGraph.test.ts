import { describe, expect, it } from 'vitest';
import type { PreviewExecutionPlan } from '../../shared/contracts';
import { PreviewGraph, reverseDependencyOrder, topologicallyOrderJobs } from './PreviewGraph';

describe('PreviewGraph', () => {
  it('orders preparation jobs by declared success dependencies', () => {
    const plan: PreviewExecutionPlan = {
      version: 1,
      jobs: [
        { id: 'build', cwd: '.', command: ['node', 'build.mjs'], needs: { install: 'succeeded' } },
        { id: 'install', cwd: '.', command: ['node', 'install.mjs'], needs: {} }
      ],
      services: [],
      workers: [],
      routes: []
    };
    expect(topologicallyOrderJobs(plan).map((job) => job.id)).toEqual(['install', 'build']);
  });

  it('fails closed for a cycle even if a malformed plan bypasses recipe validation', () => {
    const plan: PreviewExecutionPlan = {
      version: 1,
      jobs: [
        { id: 'a', cwd: '.', command: ['node'], needs: { b: 'succeeded' } },
        { id: 'b', cwd: '.', command: ['node'], needs: { a: 'succeeded' } }
      ],
      services: [], workers: [], routes: []
    };
    expect(() => topologicallyOrderJobs(plan)).toThrow('cycle');
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
    const plan: PreviewExecutionPlan = {
      version: 1,
      jobs: Array.from({ length: 8 }, (_, index) => ({
        id: `job-${index}`,
        cwd: '.',
        command: ['node'],
        needs: {}
      })),
      services: [],
      workers: [],
      routes: []
    };
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
    const plan: PreviewExecutionPlan = {
      version: 1,
      jobs: [
        { id: 'fail', cwd: '.', command: ['node'], needs: {} },
        { id: 'slow', cwd: '.', command: ['node'], needs: {} }
      ],
      services: [], workers: [], routes: []
    };
    await expect(graph.start({
      taskId: 'task', generationId: 'generation', generationRoot: '/tmp', sourcePath: '/tmp',
      markerDigest: 'marker', plan, async updateGenerationState() {}
    })).rejects.toThrow('injected failure');
    expect(slowSettled).toBe(true);
  });

  it('computes reverse dependency shutdown with consumers before providers', () => {
    const plan: PreviewExecutionPlan = {
      version: 1,
      jobs: [{ id: 'install', cwd: '.', command: ['npm', 'install'], needs: {} }],
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
    };
    const order = reverseDependencyOrder(plan);
    expect(order.indexOf('web')).toBeLessThan(order.indexOf('api'));
    expect(order.indexOf('indexer')).toBeLessThan(order.indexOf('api'));
    expect(order.indexOf('api')).toBeLessThan(order.indexOf('install'));
  });
});
