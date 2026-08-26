import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Task, TaskIteration, WorktreeRecord } from '../../shared/contracts';
import type { PreviewExecutionPlan, PreviewPlanRecord } from '../../shared/preview';
import { canonicalJson } from './PreviewCanonicalDigest';
import { previewExecutionDigest } from './PreviewExecutionAuthority';

export const MANAGED_DESIGN_STATIC_ADAPTER_VERSION = 1 as const;
export const MANAGED_DESIGN_STATIC_ROUTE_ID = 'app' as const;
export const MANAGED_DESIGN_STATIC_PORT_ENV = 'TASK_MONKI_MANAGED_STATIC_PORT' as const;

export interface ManagedDesignStaticPreviewOptions {
  executablePath: string;
  serverPath: string;
}

export class ManagedDesignStaticPreview {
  private readonly executionPlan: PreviewExecutionPlan;
  private readonly executionDigest: string;

  constructor(private readonly options: ManagedDesignStaticPreviewOptions) {
    assertAbsoluteExecutablePath(options.executablePath, 'managed static executable');
    assertAbsoluteExecutablePath(options.serverPath, 'managed static server');
    this.executionPlan = createExecutionPlan(options);
    this.executionDigest = previewExecutionDigest(this.executionPlan);
  }

  createPlan(
    context: {
      task: Pick<Task, 'id' | 'kind'>;
      iteration: Pick<TaskIteration, 'id'>;
      worktree: Pick<WorktreeRecord, 'id'>;
    },
    now = new Date().toISOString()
  ): PreviewPlanRecord {
    if (context.task.kind !== 'DESIGN') {
      throw new Error('Managed static Preview is available only for DESIGN tasks.');
    }
    return {
      id: randomUUID(),
      taskId: context.task.id,
      iterationId: context.iteration.id,
      worktreeId: context.worktree.id,
      planSource: {
        type: 'MANAGED_DESIGN_STATIC',
        adapterVersion: MANAGED_DESIGN_STATIC_ADAPTER_VERSION
      },
      executionDigest: this.executionDigest,
      executionPlan: structuredClone(this.executionPlan),
      warnings: [
        'This app-owned server exposes only the captured Design source on a loopback Preview route.'
      ],
      createdAt: now
    };
  }

  assertPlan(plan: PreviewPlanRecord): void {
    if (
      plan.planSource.type !== 'MANAGED_DESIGN_STATIC' ||
      plan.planSource.adapterVersion !== MANAGED_DESIGN_STATIC_ADAPTER_VERSION ||
      plan.executionDigest !== this.executionDigest ||
      canonicalJson(plan.executionPlan) !== canonicalJson(this.executionPlan)
    ) {
      throw new Error('Managed static Preview plan does not match the app-owned execution plan.');
    }
  }
}

function createExecutionPlan(options: ManagedDesignStaticPreviewOptions): PreviewExecutionPlan {
  return {
    version: 1,
    adapter: 'NATIVE',
    inputs: [],
    attachments: [],
    jobs: [],
    resources: [],
    services: [
      {
        id: 'static',
        cwd: '.',
        command: [options.executablePath, options.serverPath],
        needs: {},
        env: { ELECTRON_RUN_AS_NODE: '1' },
        ports: { http: { env: MANAGED_DESIGN_STATIC_PORT_ENV } },
        critical: true,
        restart: { mode: 'never', maxRestarts: 0, backoffMs: 0 },
        ready: { type: 'http', port: 'http', path: '/', timeoutSeconds: 15 }
      }
    ],
    workers: [],
    routes: [
      {
        id: MANAGED_DESIGN_STATIC_ROUTE_ID,
        service: 'static',
        port: 'http',
        primary: true
      }
    ],
    scenarios: [{ id: 'default', jobs: [], resources: [] }],
    selectedScenarioId: 'default'
  };
}

function assertAbsoluteExecutablePath(value: string, label: string): void {
  if (!path.isAbsolute(value) || value.includes('\0')) {
    throw new Error(`The ${label} path must be absolute.`);
  }
}
