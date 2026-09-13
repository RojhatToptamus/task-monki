import type { TaskManagerApi, WorktreeRecord } from '../shared/contracts';

/** Choose the fixture checkout's current commit through the same API as the UI. */
export async function prepareTestWorktree(
  service: Pick<TaskManagerApi, 'inspectWorktreePreparation' | 'prepareWorktree'>,
  taskId: string
): Promise<WorktreeRecord> {
  const inspection = await service.inspectWorktreePreparation({ taskId });
  const base = inspection.mode === 'CREATE'
    ? inspection.bases.find((candidate) => candidate.current)
    : undefined;
  if (inspection.mode === 'CREATE' && !base) {
    throw new Error('Fixture repository has no current base.');
  }
  const result = await service.prepareWorktree(base
    ? { taskId, intent: 'CREATE', baseRef: base.refName, expectedBaseSha: base.sha }
    : { taskId, intent: 'RECOVER' });
  if (result.outcome === 'BASE_CHANGED') {
    throw new Error('Fixture base changed during preparation.');
  }
  return result.worktree;
}
