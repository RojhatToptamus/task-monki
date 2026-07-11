import type {
  PreviewExecutionPlan,
  PreviewGenerationState,
  PreviewNodeAttemptRecord,
  PreviewResourceRecord
} from '../../shared/contracts';
import { FileTaskStore } from '../storage/FileTaskStore';
import { PreviewReadinessService } from './PreviewReadinessService';
import { NativeJobRunner } from './runtime/NativeJobRunner';
import {
  NativeServiceRuntime,
  type RunningNativeService
} from './runtime/NativeServiceRuntime';
import { PreviewPortAllocator } from './runtime/PreviewPortAllocator';

export interface RunningPreviewGraph {
  service: RunningNativeService;
  ports: Record<string, number>;
  stop(): Promise<'STOPPED' | 'ALREADY_EXITED' | 'REFUSED'>;
}

export class PreviewGraph {
  constructor(
    private readonly store: FileTaskStore,
    private readonly jobs: NativeJobRunner,
    private readonly services: NativeServiceRuntime,
    private readonly readiness: PreviewReadinessService,
    private readonly ports: PreviewPortAllocator
  ) {}

  async start(input: {
    taskId: string;
    generationId: string;
    generationRoot: string;
    sourcePath: string;
    markerDigest: string;
    plan: PreviewExecutionPlan;
    updateGenerationState(state: PreviewGenerationState): Promise<void>;
    onUnexpectedServiceExit(reason: string): Promise<void>;
  }): Promise<RunningPreviewGraph> {
    const orderedJobs = topologicallyOrderJobs(input.plan);
    if (orderedJobs.length > 0) await input.updateGenerationState('RUNNING_JOBS');
    for (const job of orderedJobs) {
      await this.jobs.run({
        taskId: input.taskId,
        generationId: input.generationId,
        generationRoot: input.generationRoot,
        sourcePath: input.sourcePath,
        markerDigest: input.markerDigest,
        node: job
      });
    }

    const service = input.plan.services[0];
    if (!service) throw new Error('Preview plan has no Phase 1 service.');
    await input.updateGenerationState('STARTING_SERVICES');
    const portValues: Record<string, number> = {};
    try {
      for (const portId of Object.keys(service.ports)) portValues[portId] = await this.ports.allocate();
      const running = await this.services.start({
        taskId: input.taskId,
        generationId: input.generationId,
        generationRoot: input.generationRoot,
        sourcePath: input.sourcePath,
        markerDigest: input.markerDigest,
        node: service,
        portValues,
        onUnexpectedExit: async (receipt) => {
          for (const port of Object.values(portValues)) this.ports.release(port);
          await input.onUnexpectedServiceExit(
            `Preview service ${service.id} exited with ${receipt.exitCode ?? receipt.signal ?? receipt.state}.`
          );
        }
      });

      let attempt = await this.store.savePreviewNodeAttempt({
        ...running.attempt,
        state: 'WAITING_READY',
        readiness: { status: 'PENDING' }
      });
      await input.updateGenerationState('WAITING_READY');
      const readiness = await this.readiness.waitForHttp({
        port: portValues[service.ready.port],
        path: service.ready.path,
        timeoutMs: service.ready.timeoutSeconds * 1_000
      });
      if (readiness.status !== 'PASSED') {
        attempt = await this.store.savePreviewNodeAttempt({
          ...attempt,
          state: 'FAILED',
          endedAt: new Date().toISOString(),
          readiness
        });
        await this.services.stop(running.resource);
        throw new PreviewReadinessFailure(service.id, readiness.lastError, attempt, running.resource);
      }
      await this.store.savePreviewNodeAttempt({
        ...attempt,
        state: 'READY',
        readiness
      });

      let stopped = false;
      return {
        service: running,
        ports: portValues,
        stop: async () => {
          if (stopped) return 'ALREADY_EXITED';
          stopped = true;
          const result = await this.services.stop(running.resource);
          for (const port of Object.values(portValues)) this.ports.release(port);
          return result;
        }
      };
    } catch (error) {
      for (const port of Object.values(portValues)) this.ports.release(port);
      throw error;
    }
  }
}

export class PreviewReadinessFailure extends Error {
  constructor(
    serviceId: string,
    reason: string | undefined,
    readonly attempt: PreviewNodeAttemptRecord,
    readonly resource: PreviewResourceRecord
  ) {
    super(`Preview service ${serviceId} did not become ready: ${reason ?? 'readiness timed out'}`);
  }
}

export function topologicallyOrderJobs(plan: PreviewExecutionPlan) {
  const jobs = new Map(plan.jobs.map((job) => [job.id, job]));
  const ordered: typeof plan.jobs = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Preview job graph contains a cycle at ${id}.`);
    const job = jobs.get(id);
    if (!job) throw new Error(`Preview job dependency is missing: ${id}.`);
    visiting.add(id);
    for (const dependencyId of Object.keys(job.needs).sort()) visit(dependencyId);
    visiting.delete(id);
    visited.add(id);
    ordered.push(job);
  };
  for (const id of [...jobs.keys()].sort()) visit(id);
  return ordered;
}
