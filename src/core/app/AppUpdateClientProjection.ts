import type { AppUpdateEvent } from '../../shared/contracts';

const DIRECT_CLIENT_PAYLOAD_EVENTS = new Set<AppUpdateEvent['type']>([
  'preview.recipe-generation.updated',
  'discourse.delta'
]);

export function projectAppUpdateEventForClient(
  event: AppUpdateEvent
): AppUpdateEvent {
  return {
    type: event.type,
    scope: event.scope,
    taskId: event.taskId,
    iterationId: event.iterationId,
    runId: event.runId,
    worktreeId: event.worktreeId,
    previewGenerationId: event.previewGenerationId,
    payload: DIRECT_CLIENT_PAYLOAD_EVENTS.has(event.type) ? event.payload : null,
    at: event.at
  };
}
