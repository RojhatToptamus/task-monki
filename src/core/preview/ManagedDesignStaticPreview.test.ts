import { describe, expect, it } from 'vitest';
import type { PreviewTaskContext } from './PreviewManager';
import {
  MANAGED_DESIGN_STATIC_PORT_ENV,
  MANAGED_DESIGN_STATIC_ROUTE_ID,
  ManagedDesignStaticPreview
} from './ManagedDesignStaticPreview';

describe('ManagedDesignStaticPreview', () => {
  it('creates one fixed native static service without repository execution authority', () => {
    const owner = new ManagedDesignStaticPreview({
      executablePath: '/Applications/Task Monki.app/Contents/MacOS/Task Monki',
      serverPath: '/Applications/Task Monki.app/Contents/Resources/managed-design-static-server.mjs'
    });
    const plan = owner.createPlan(context());

    expect(plan.planSource).toEqual({ type: 'MANAGED_DESIGN_STATIC', adapterVersion: 1 });
    expect(plan.executionPlan).toMatchObject({
      adapter: 'NATIVE',
      jobs: [],
      resources: [],
      workers: [],
      selectedScenarioId: 'default',
      services: [
        {
          id: 'static',
          cwd: '.',
          env: { ELECTRON_RUN_AS_NODE: '1' },
          ports: { http: { env: MANAGED_DESIGN_STATIC_PORT_ENV } },
          critical: true,
          restart: { mode: 'never', maxRestarts: 0, backoffMs: 0 }
        }
      ],
      routes: [
        { id: MANAGED_DESIGN_STATIC_ROUTE_ID, service: 'static', port: 'http', primary: true }
      ]
    });
    expect('approvalId' in plan).toBe(false);
    expect(() => owner.assertPlan(plan)).not.toThrow();
  });

  it('rejects a normal task and every changed effective command', () => {
    const owner = new ManagedDesignStaticPreview({
      executablePath: '/usr/bin/node',
      serverPath: '/app/managed-design-static-server.mjs'
    });
    expect(() => owner.createPlan({ ...context(), task: { ...context().task, kind: 'NORMAL' } }))
      .toThrow('only for DESIGN');
    const plan = owner.createPlan(context());
    plan.executionPlan.services[0].command.push('/repository/controlled.js');
    expect(() => owner.assertPlan(plan)).toThrow('does not match');
  });

  it('requires app-owned absolute executable paths', () => {
    expect(
      () => new ManagedDesignStaticPreview({ executablePath: 'node', serverPath: '/server.mjs' })
    ).toThrow('must be absolute');
  });
});

function context(): PreviewTaskContext {
  const now = '2026-08-20T00:00:00.000Z';
  return {
    task: {
      id: 'task-design',
      kind: 'DESIGN',
      runtimeId: 'codex',
      title: 'Design',
      prompt: '',
      repositoryId: 'repository-design',
      workflowPhase: 'READY',
      resolution: 'NONE',
      completionPolicy: 'LOCAL_ACCEPTANCE',
      phaseVersion: 1,
      currentIterationId: 'iteration-design',
      currentWorktreeId: 'worktree-design',
      createdAt: now,
      updatedAt: now,
      forkedAlternativeTaskIds: [],
      agentSettings: {},
      projection: {} as never
    },
    iteration: {
      id: 'iteration-design',
      taskId: 'task-design',
      actionRequestId: 'turn-design',
      generationKey: 'turn-design',
      status: 'ACTIVE',
      branchName: 'design/task-design',
      baseSha: 'a'.repeat(40),
      createdAt: now,
      updatedAt: now
    },
    worktree: {
      id: 'worktree-design',
      taskId: 'task-design',
      iterationId: 'iteration-design',
      repositoryId: 'repository-design',
      worktreePath: '/tmp/design-worktree',
      branchName: 'design/task-design',
      baseSha: 'a'.repeat(40),
      status: 'PRESENT',
      createdAt: now,
      updatedAt: now
    }
  };
}
