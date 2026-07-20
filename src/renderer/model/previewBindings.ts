import type {
  PreviewGenerationRecord,
  PreviewLocalAttachmentRequirement,
  PreviewPlanRecord,
  PreviewResolvedAttachmentTarget,
  Task
} from '../../shared/contracts';

export interface PreviewTaskRouteOption {
  taskId: string;
  taskTitle: string;
  routeId: string;
  available: boolean;
}

export interface PreviewAttachmentBindingDraft {
  mode: 'endpoint' | 'task-preview-route';
  scheme: '' | 'http' | 'https';
  host: string;
  port: string;
  basePath: string;
  database: string;
  username: string;
  tls: '' | 'disabled' | 'system-verified';
  targetTaskId: string;
  routeId: string;
}

export function selectPreviewTaskRouteOptions(
  tasks: readonly Task[],
  plans: readonly PreviewPlanRecord[],
  generations: readonly PreviewGenerationRecord[],
  consumerTaskId: string
): PreviewTaskRouteOption[] {
  const options: PreviewTaskRouteOption[] = [];
  for (const task of tasks) {
    if (task.id === consumerTaskId) continue;
    const plan = plans
      .filter(
        (candidate) =>
          candidate.taskId === task.id && candidate.iterationId === task.currentIterationId
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    if (!plan) continue;
    const activeGeneration = generations.find(
      (candidate) =>
        candidate.taskId === task.id &&
        candidate.iterationId === task.currentIterationId &&
        candidate.routingState === 'ACTIVE' &&
        candidate.state === 'READY'
    );
    for (const route of plan.executionPlan.routes) {
      options.push({
        taskId: task.id,
        taskTitle: task.title,
        routeId: route.id,
        available: Boolean(
          activeGeneration?.routes.some(
            (candidate) => candidate.id === route.id && candidate.state === 'ATTACHED'
          )
        )
      });
    }
  }
  return options.sort(
    (left, right) =>
      left.taskTitle.localeCompare(right.taskTitle) || left.routeId.localeCompare(right.routeId)
  );
}

export function createPreviewAttachmentBindingDraft(
  requirement: PreviewLocalAttachmentRequirement
): PreviewAttachmentBindingDraft {
  return {
    mode: 'endpoint',
    scheme: '',
    host: '',
    port: '',
    basePath: '/',
    database: '',
    username: '',
    tls: '',
    targetTaskId: '',
    routeId: ''
  };
}

export function materializePreviewAttachmentTarget(
  requirement: PreviewLocalAttachmentRequirement,
  draft: PreviewAttachmentBindingDraft
): PreviewResolvedAttachmentTarget {
  if (draft.mode === 'task-preview-route') {
    if (
      requirement.attachmentType !== 'http' ||
      !requirement.allowedTargetTypes.includes('task-preview-route') ||
      !draft.targetTaskId ||
      !draft.routeId
    ) {
      throw new Error('Select a valid Preview route.');
    }
    return {
      type: 'task-preview-route',
      targetTaskId: draft.targetTaskId,
      routeId: draft.routeId,
      basePath: normalizeBasePath(draft.basePath)
    };
  }
  const host = draft.host.trim();
  if (!host) throw new Error('Enter a host.');
  const port = parseInteger(draft.port, 'port', 1, 65_535);
  if (requirement.attachmentType === 'http') {
    if (!draft.scheme) throw new Error('Select HTTP or HTTPS.');
    return {
      type: 'endpoint',
      scheme: draft.scheme,
      host,
      port,
      basePath: normalizeBasePath(draft.basePath)
    };
  }
  if (requirement.attachmentType === 'tcp') return { type: 'endpoint', host, port };
  if (requirement.attachmentType === 'postgres') {
    const database = draft.database.trim();
    const username = draft.username.trim();
    if (!database || !username) throw new Error('Enter a database and username.');
    if (!draft.tls) throw new Error('Select a TLS mode.');
    return { type: 'endpoint', host, port, database, username, tls: draft.tls };
  }
  if (!draft.tls) throw new Error('Select a TLS mode.');
  return {
    type: 'endpoint',
    host,
    port,
    database: parseInteger(draft.database, 'database number', 0, 65_535),
    ...(draft.username.trim() ? { username: draft.username.trim() } : {}),
    tls: draft.tls
  };
}

function normalizeBasePath(value: string): string {
  const trimmed = value.trim() || '/';
  if (
    !trimmed.startsWith('/') || trimmed.startsWith('//') ||
    trimmed.includes('?') || trimmed.includes('#') || /[\0\r\n]/.test(trimmed) ||
    new TextEncoder().encode(trimmed).byteLength > 2_048
  ) {
    throw new Error('Base path must start with / and cannot contain a query or fragment.');
  }
  return trimmed;
}

function parseInteger(value: string, label: string, minimum: number, maximum: number): number {
  if (!/^\d+$/.test(value.trim())) throw new Error(`Enter a valid ${label}.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Enter a valid ${label}.`);
  }
  return parsed;
}
