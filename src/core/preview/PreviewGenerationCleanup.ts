import type { PreviewGenerationRecord } from '../../shared/contracts';
import type { FileTaskStore } from '../storage/FileTaskStore';
import type { RunningPreviewGraph } from './PreviewGraph';
import type { PreviewSourcePreparer } from './PreviewSourcePreparer';
import type { NativeServiceRuntime } from './runtime/NativeServiceRuntime';

export async function cleanupPreviewGenerationRuntime(input: {
  generation: PreviewGenerationRecord;
  store: FileTaskStore;
  nativeRuntime: NativeServiceRuntime;
  sourcePreparer: PreviewSourcePreparer;
  liveGraph?: RunningPreviewGraph;
}): Promise<boolean> {
  let cleanupIncomplete = false;
  if (input.liveGraph) {
    cleanupIncomplete =
      await input.liveGraph.stop().catch(() => 'REFUSED' as const) === 'REFUSED';
  } else {
    for (const resource of await input.store.getPreviewResources(input.generation.id)) {
      if (['STOPPED', 'EXITED', 'FAILED'].includes(resource.state)) continue;
      if (
        await input.nativeRuntime.stop(resource).catch(() => 'REFUSED' as const) ===
        'REFUSED'
      ) {
        cleanupIncomplete = true;
      }
    }
  }
  if (cleanupIncomplete) return true;

  try {
    await input.sourcePreparer.cleanupOwnedGeneration({
      taskId: input.generation.taskId,
      generationId: input.generation.id
    });
    return false;
  } catch {
    return true;
  }
}
