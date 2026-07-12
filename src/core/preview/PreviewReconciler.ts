import type { PreviewGenerationRecord } from '../../shared/contracts';
import { FileTaskStore } from '../storage/FileTaskStore';
import { PreviewGateway } from './PreviewGateway';
import { cleanupPreviewGenerationRuntime } from './PreviewGenerationCleanup';
import { PreviewSourcePreparer } from './PreviewSourcePreparer';
import { NativeServiceRuntime } from './runtime/NativeServiceRuntime';
import { OciResourceRuntime } from './runtime/OciResourceRuntime';

export class PreviewReconciler {
  constructor(
    private readonly store: FileTaskStore,
    private readonly gateway: PreviewGateway,
    private readonly nativeRuntime: NativeServiceRuntime,
    private readonly sourcePreparer: PreviewSourcePreparer,
    private readonly ociRuntime?: OciResourceRuntime
  ) {}

  async reconcile(): Promise<void> {
    this.gateway.clearRoutes();
    const generations = await this.store.getPreviewGenerations();
    for (const generation of generations) {
      if (generation.state === 'STOPPED') continue;
      await this.reconcileGeneration(generation);
    }
    await this.ociRuntime?.cleanupTaskResources();
    for (const taskId of new Set(generations.map((generation) => generation.taskId))) {
      await this.store.prunePreviewHistory(taskId);
    }
  }

  private async reconcileGeneration(generation: PreviewGenerationRecord): Promise<void> {
    const cleanupIncomplete = await cleanupPreviewGenerationRuntime({
      generation,
      store: this.store,
      nativeRuntime: this.nativeRuntime,
      sourcePreparer: this.sourcePreparer
    });
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
