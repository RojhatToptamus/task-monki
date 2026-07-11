import type { PreviewGenerationRecord, PreviewResourceRecord } from '../../shared/contracts';
import { FileTaskStore } from '../storage/FileTaskStore';
import { PreviewGateway } from './PreviewGateway';
import { PreviewSourcePreparer } from './PreviewSourcePreparer';
import { NativeServiceRuntime } from './runtime/NativeServiceRuntime';

const TERMINAL_GENERATIONS: PreviewGenerationRecord['state'][] = ['STOPPED'];
const TERMINAL_RESOURCES: PreviewResourceRecord['state'][] = ['STOPPED', 'EXITED', 'FAILED'];

export class PreviewReconciler {
  constructor(
    private readonly store: FileTaskStore,
    private readonly gateway: PreviewGateway,
    private readonly nativeRuntime: NativeServiceRuntime,
    private readonly sourcePreparer: PreviewSourcePreparer
  ) {}

  async reconcile(): Promise<void> {
    this.gateway.clearRoutes();
    const generations = await this.store.getPreviewGenerations();
    for (const generation of generations) {
      if (TERMINAL_GENERATIONS.includes(generation.state)) continue;
      await this.reconcileGeneration(generation);
    }
    for (const taskId of new Set(generations.map((generation) => generation.taskId))) {
      await this.store.prunePreviewHistory(taskId);
    }
  }

  private async reconcileGeneration(generation: PreviewGenerationRecord): Promise<void> {
    let cleanupIncomplete = false;
    const resources = await this.store.getPreviewResources(generation.id);
    for (const resource of resources) {
      if (TERMINAL_RESOURCES.includes(resource.state)) continue;
      if (resource.adapterKind !== 'NATIVE_PROCESS') {
        cleanupIncomplete = true;
        continue;
      }
      const result = await this.nativeRuntime.stop(resource).catch(() => 'REFUSED' as const);
      if (result === 'REFUSED') cleanupIncomplete = true;
    }
    if (!cleanupIncomplete) {
      try {
        await this.sourcePreparer.cleanupOwnedGeneration({
          taskId: generation.taskId,
          generationId: generation.id
        });
      } catch {
        cleanupIncomplete = true;
      }
    }
    await this.store.savePreviewGeneration({
      ...generation,
      routes: generation.routes.map((route) => ({ ...route, state: 'DETACHED' as const })),
      routingState: 'RETIRED',
      state:
        cleanupIncomplete ? 'CLEANUP_INCOMPLETE'
        : generation.state === 'FAILED' ? 'FAILED'
        : 'STOPPED',
      cleanupReason: cleanupIncomplete
        ? 'Restart reconciliation found an unverified process or workspace identity.'
        : 'Stopped and cleaned during Task Monki restart reconciliation.',
      updatedAt: new Date().toISOString(),
      stoppedAt:
        cleanupIncomplete || generation.state === 'FAILED' ? undefined : new Date().toISOString()
    });
  }
}
