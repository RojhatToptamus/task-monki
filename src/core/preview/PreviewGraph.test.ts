import { describe, expect, it } from 'vitest';
import type { PreviewExecutionPlan } from '../../shared/contracts';
import { topologicallyOrderJobs } from './PreviewGraph';

describe('PreviewGraph', () => {
  it('orders preparation jobs by declared success dependencies', () => {
    const plan: PreviewExecutionPlan = {
      version: 1,
      jobs: [
        { id: 'build', cwd: '.', command: ['node', 'build.mjs'], needs: { install: 'succeeded' } },
        { id: 'install', cwd: '.', command: ['node', 'install.mjs'], needs: {} }
      ],
      services: [],
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
      services: [], routes: []
    };
    expect(() => topologicallyOrderJobs(plan)).toThrow('cycle');
  });
});
