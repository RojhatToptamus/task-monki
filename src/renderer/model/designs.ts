import type {
  AgentModel,
  AgentRuntimeState,
  AppUpdateEvent,
  AgentRuntimeCatalog,
  DesignCanvasTarget,
  DesignConversationPage,
  DesignConversationEntry,
  DesignDetailSnapshot,
  DesignListItem,
  DesignStatus
} from '../../shared/contracts';
import type { DesignCanvasBounds } from '../../shared/designCanvas';
import { projectAgentExecutionSupport } from '../../shared/agentExecutionSupport';
import { buildOverviewRunActivityRows, type OverviewActivityRow } from './overviewRunActivity';
import { buildRunActivityProjection } from './runActivity';

export type DesignProjectStatus = DesignStatus | 'RUNNING';

export type DesignTurnStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'READY'
  | 'NO_CHANGE'
  | 'CANCELED'
  | 'FAILED';

export type DesignProjectSummary = DesignListItem;

export type DesignProjectDetail = DesignDetailSnapshot;

export interface DesignTurnView {
  status: DesignTurnStatus;
  statusLabel: string;
  tone: DesignStatusTone;
  detail?: string;
}

export type DesignStatusTone = 'idle' | 'working' | 'waiting' | 'verified' | 'blocked';

export interface DesignStatusView {
  label: string;
  detail: string;
  tone: DesignStatusTone;
}

export type DesignWorkspaceLayoutMode = 'chat' | 'split' | 'canvas';
export type DesignHistoryFilter = 'all' | 'active' | 'archived';

export interface DesignWorkspaceLayoutView {
  availableModes: readonly DesignWorkspaceLayoutMode[];
  splitAvailable: boolean;
  mainWidth: number;
}

export type DesignCanvasPresentation =
  | { kind: 'DESKTOP_ONLY'; title: string; detail: string }
  | { kind: 'HIDDEN'; title: string; detail: string }
  | { kind: 'PLACEHOLDER'; title: string; detail: string; restart: boolean }
  | { kind: 'NATIVE'; target: DesignCanvasTarget; progress: boolean };

export interface DesignCanvasExternalLinkRequest {
  designId: string;
  pendingId: string;
  destinationHost: string;
}

export type DesignCanvasClientEvent =
  | { kind: 'EXTERNAL_LINK_REQUESTED'; request: DesignCanvasExternalLinkRequest }
  | { kind: 'LOAD_FAILED'; designId: string; generationId: string };

const STATUS_VIEWS: Record<DesignProjectStatus, DesignStatusView> = {
  STARTING: {
    label: 'Starting',
    detail: 'Task Monki is preparing the Design workspace.',
    tone: 'working'
  },
  RUNNING: {
    label: 'Running',
    detail: 'The Design agent is building the first ready preview.',
    tone: 'working'
  },
  UPDATING: {
    label: 'Updating',
    detail: 'The Design agent is refining the Design. The ready preview stays visible.',
    tone: 'working'
  },
  READY: {
    label: 'Ready',
    detail: 'The latest preview passed its readiness checks.',
    tone: 'verified'
  },
  NEEDS_INPUT: {
    label: 'Blocked',
    detail: 'The Design agent needs your response before it can continue.',
    tone: 'waiting'
  },
  NEEDS_ATTENTION: {
    label: 'Needs attention',
    detail: 'The latest update needs attention. Review the issue before you continue.',
    tone: 'blocked'
  },
  ARCHIVED: {
    label: 'Archived',
    detail: 'This Design is read-only. You can duplicate or delete it.',
    tone: 'idle'
  }
};

export function designStatusView(status: DesignProjectStatus): DesignStatusView {
  return STATUS_VIEWS[status];
}

export function designProjectStatus(project: DesignProjectDetail): DesignProjectStatus {
  if (
    project.design.status === 'STARTING' &&
    project.currentRun &&
    ['QUEUED', 'STARTING', 'RUNNING'].includes(project.currentRun.status)
  ) {
    return 'RUNNING';
  }
  return project.design.status;
}

export function sortedDesignProjects(
  projects: readonly DesignProjectSummary[]
): DesignProjectSummary[] {
  return [...projects].sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || left.title.localeCompare(right.title)
  );
}

export function visibleDesignProjects(
  projects: readonly DesignProjectSummary[],
  query: string,
  filter: DesignHistoryFilter
): DesignProjectSummary[] {
  const normalized = query.trim().toLocaleLowerCase();
  return sortedDesignProjects(projects).filter((project) => {
    const matchesQuery = !normalized || project.title.toLocaleLowerCase().includes(normalized);
    const matchesFilter = filter === 'all' ||
      (filter === 'archived' ? project.status === 'ARCHIVED' : project.status !== 'ARCHIVED');
    return matchesQuery && matchesFilter;
  });
}

export function designCanvasPresentation(input: {
  project: DesignProjectDetail;
  desktopAvailable: boolean;
  occluded: boolean;
}): DesignCanvasPresentation {
  const { canvas } = input.project;
  const displayStatus = designProjectStatus(input.project);
  if (!input.desktopAvailable) {
    return {
      kind: 'DESKTOP_ONLY',
      title: 'Canvas is available in the desktop app',
      detail: 'Open this Design in Task Monki for macOS to view its isolated preview.'
    };
  }
  if (input.occluded) {
    return {
      kind: 'HIDDEN',
      title: 'Canvas hidden',
      detail: 'Close the dialog to return to the preview.'
    };
  }
  if (
    (canvas.state === 'READY' || canvas.state === 'PREVIEWING') &&
    canvas.target
  ) {
    return {
      kind: 'NATIVE',
      target: canvas.target,
      progress: canvas.state === 'PREVIEWING'
    };
  }
  if (canvas.state === 'RESTART_REQUIRED') {
    return {
      kind: 'PLACEHOLDER',
      title: 'Preview stopped',
      detail: canvas.detail ?? 'Restart the last ready preview to continue.',
      restart: input.project.actions.canRestart
    };
  }
  if (canvas.state === 'UPDATING') {
    return {
      kind: 'PLACEHOLDER',
      title: 'Updating preview',
      detail: canvas.detail ?? 'Task Monki is switching to the checked revision.',
      restart: false
    };
  }
  if (displayStatus === 'NEEDS_ATTENTION') {
    return {
      kind: 'PLACEHOLDER',
      title: 'No ready preview',
      detail: canvas.detail ?? 'Resolve the current issue, then try the update again.',
      restart: input.project.actions.canRestart
    };
  }
  return {
    kind: 'PLACEHOLDER',
    title: displayStatus === 'STARTING' ? 'Preparing workspace' : 'Building first preview',
    detail: canvas.detail ?? 'The canvas will appear after the first preview passes its checks.',
    restart: false
  };
}

export function designCanvasClientEvent(
  event: AppUpdateEvent
): DesignCanvasClientEvent | undefined {
  if (event.type !== 'design.updated' || event.scope.kind !== 'DESIGN') {
    return undefined;
  }
  const payload = objectRecord(event.payload);
  const canvasEvent = objectRecord(payload?.canvasEvent);
  if (
    !payload ||
    !canvasEvent ||
    payload.reason !== canvasEvent.type ||
    canvasEvent.designId !== event.scope.designId ||
    event.taskId !== event.scope.designId
  ) {
    return undefined;
  }
  if (canvasEvent.type === 'external-link-requested') {
    const pendingId = boundedNonEmptyString(canvasEvent.pendingId, 128);
    const destinationHost = boundedNonEmptyString(canvasEvent.destinationHost, 512);
    if (!pendingId || !destinationHost) return undefined;
    return {
      kind: 'EXTERNAL_LINK_REQUESTED',
      request: {
        designId: event.scope.designId,
        pendingId,
        destinationHost
      }
    };
  }
  if (canvasEvent.type === 'load-failed') {
    const generationId = boundedNonEmptyString(canvasEvent.generationId, 128);
    const failureReason = boundedNonEmptyString(canvasEvent.reason, 2_000);
    if (
      !generationId ||
      !failureReason ||
      event.previewGenerationId !== generationId
    ) {
      return undefined;
    }
    return {
      kind: 'LOAD_FAILED',
      designId: event.scope.designId,
      generationId
    };
  }
  return undefined;
}

export function designTurnView(entry: DesignConversationEntry): DesignTurnView {
  const outcome = entry.turn.outcome;
  if (outcome === 'READY') {
    return { status: 'READY', statusLabel: 'Ready', tone: 'verified' };
  }
  if (outcome === 'NO_CHANGE') {
    return { status: 'NO_CHANGE', statusLabel: 'No visual change', tone: 'verified' };
  }
  if (outcome === 'CANCELED') {
    return { status: 'CANCELED', statusLabel: 'Stopped', tone: 'idle' };
  }
  if (outcome === 'FAILED' || outcome === 'NEEDS_ATTENTION') {
    return {
      status: 'FAILED',
      statusLabel: 'Update failed',
      tone: 'blocked',
      detail: entry.turn.failureReason
    };
  }
  if (
    entry.runStatus &&
    ['STARTING', 'RUNNING', 'AWAITING_APPROVAL', 'AWAITING_USER_INPUT'].includes(
      entry.runStatus
    )
  ) {
    return {
      status: 'RUNNING',
      statusLabel:
        entry.runStatus === 'AWAITING_APPROVAL' || entry.runStatus === 'AWAITING_USER_INPUT'
          ? 'Waiting for you'
          : 'Working',
      tone:
        entry.runStatus === 'AWAITING_APPROVAL' || entry.runStatus === 'AWAITING_USER_INPUT'
          ? 'waiting'
          : 'working'
    };
  }
  if (entry.runStatus === 'COMPLETED') {
    return { status: 'RUNNING', statusLabel: 'Preparing preview', tone: 'working' };
  }
  if (
    entry.runStatus &&
    ['FAILED', 'INTERRUPTED', 'RECOVERY_REQUIRED', 'LOST'].includes(entry.runStatus)
  ) {
    return {
      status: 'FAILED',
      statusLabel: 'Needs attention',
      tone: 'blocked',
      detail: entry.turn.failureReason
    };
  }
  return { status: 'QUEUED', statusLabel: 'Queued', tone: 'waiting' };
}

export function eligibleDesignRuntimeCatalog(
  catalog: AgentRuntimeCatalog
): AgentRuntimeCatalog {
  const runtimes = [...catalog.runtimes];
  const runtimeIds = new Set(
    runtimes.map((runtime) => runtime.preflight.runtime.id)
  );
  const models = catalog.models.filter((model) => runtimeIds.has(model.runtimeId));
  const qualifiedModels = qualifiedDesignModels(runtimes, models);
  const supportedModelRuntimeIds = new Set(
    qualifiedModels.map((model) => model.runtimeId)
  );
  return {
    ...catalog,
    runtimes,
    models,
    defaultRuntimeId: supportedModelRuntimeIds.has(catalog.defaultRuntimeId)
      ? catalog.defaultRuntimeId
      : runtimes.find((runtime) =>
          supportedModelRuntimeIds.has(runtime.preflight.runtime.id)
        )?.preflight.runtime.id ??
        (runtimeIds.has(catalog.defaultRuntimeId)
          ? catalog.defaultRuntimeId
          : runtimes[0]?.preflight.runtime.id ?? catalog.defaultRuntimeId)
  };
}

export function qualifiedDesignModels(
  runtimes: readonly AgentRuntimeState[],
  models: readonly AgentModel[]
): AgentModel[] {
  const runtimeById = new Map(
    runtimes.map((runtime) => [runtime.preflight.runtime.id, runtime] as const)
  );
  return models.filter((model) => {
    const runtime = runtimeById.get(model.runtimeId);
    return Boolean(
      runtime?.preflight.readiness.canStart &&
        projectAgentExecutionSupport(
          runtime.preflight.capabilities,
          'DESIGN',
          { model }
        ).supported
    );
  });
}

export function designModelUnavailableReason(
  runtime: AgentRuntimeState,
  model: AgentModel
): string | undefined {
  const support = projectAgentExecutionSupport(
    runtime.preflight.capabilities,
    'DESIGN',
    { model }
  );
  return support.supported ? undefined : support.reason;
}

export function designRuntimeUnavailableReason(
  runtime: AgentRuntimeState,
  models: readonly AgentModel[]
): string | undefined {
  const runtimeId = runtime.preflight.runtime.id;
  if (!runtime.preflight.readiness.canStart) {
    return runtime.preflight.readiness.detail || runtime.preflight.readiness.summary;
  }
  const runtimeSupport = projectAgentExecutionSupport(
    runtime.preflight.capabilities,
    'DESIGN'
  );
  if (!runtimeSupport.supported) return runtimeSupport.reason;
  if (
    runtime.preflight.capabilities.modelCatalog.activation === 'EXPLICIT' &&
    runtime.preflight.readiness.checks.modelCatalog !== 'AVAILABLE'
  ) {
    return undefined;
  }
  const runtimeModels = models.filter((model) => model.runtimeId === runtimeId);
  const modelResults = runtimeModels.map((model) =>
    projectAgentExecutionSupport(runtime.preflight.capabilities, 'DESIGN', {
      model
    })
  );
  if (modelResults.some((result) => result.supported)) return undefined;
  const exactModelReason = modelResults.find(
    (result): result is { supported: false; reason: string } => !result.supported
  )?.reason;
  if (exactModelReason) return exactModelReason;
  for (const model of runtime.models) {
    const support = projectAgentExecutionSupport(
      runtime.preflight.capabilities,
      'DESIGN',
      { model }
    );
    if (!support.supported) return support.reason;
  }
  return 'This agent has no model that passed the required Design Mode technical qualification.';
}

export function mergeDesignConversationPage(
  project: DesignProjectDetail,
  page: DesignConversationPage
): DesignProjectDetail {
  const entries = new Map(
    [...page.entries, ...project.conversation].map((entry) => [entry.turn.id, entry])
  );
  const conversation = [...entries.values()].sort(
    (left, right) => left.turn.order - right.turn.order
  );
  return {
    ...project,
    conversation,
    turns: conversation.map((entry) => entry.turn),
    previousConversationCursor: page.previousCursor
  };
}

export function mergeDesignDetailHistory(
  current: DesignProjectDetail | undefined,
  next: DesignProjectDetail
): DesignProjectDetail {
  if (
    !current ||
    current.design.id !== next.design.id ||
    current.conversation.length <= next.conversation.length
  ) {
    return next;
  }
  const entries = new Map(
    [...current.conversation, ...next.conversation].map((entry) => [entry.turn.id, entry])
  );
  const conversation = [...entries.values()].sort(
    (left, right) => left.turn.order - right.turn.order
  );
  return {
    ...next,
    conversation,
    turns: conversation.map((entry) => entry.turn),
    previousConversationCursor: current.previousConversationCursor
  };
}

export function designActivityRows(project: DesignProjectDetail): OverviewActivityRow[] {
  return designDetailedActivityRows(project).slice(-5);
}

export function designDetailedActivityRows(
  project: DesignProjectDetail
): OverviewActivityRow[] {
  if (!project.currentRun) return [];
  const projection = buildRunActivityProjection({
    run: project.currentRun,
    items: project.items.filter((item) => item.runId === project.currentRun?.id)
  });
  return buildOverviewRunActivityRows(projection.rows);
}

export function finiteDesignCanvasBounds(
  rect: Pick<DOMRect, 'x' | 'y' | 'width' | 'height'>
): DesignCanvasBounds | undefined {
  const bounds = {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height
  };
  if (
    !Object.values(bounds).every(Number.isFinite) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    return undefined;
  }
  return bounds;
}

export function designWorkspaceLayout(
  width: number,
  historyCollapsed: boolean,
  historyWidth = 268
): DesignWorkspaceLayoutView {
  const safeWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const safeHistoryWidth = Number.isFinite(historyWidth)
    ? Math.min(360, Math.max(220, historyWidth))
    : 268;
  const mainWidth = Math.max(
    0,
    safeWidth - (historyCollapsed ? 0 : safeHistoryWidth + 5)
  );
  const splitAvailable = mainWidth >= 780;
  return {
    mainWidth,
    splitAvailable,
    availableModes: splitAvailable
      ? ['chat', 'split', 'canvas']
      : ['chat', 'canvas']
  };
}

export function designWorkspaceIsCompact(width: number): boolean {
  return Number.isFinite(width) && !designWorkspaceLayout(width, false).splitAvailable;
}

export function formatDesignUpdatedAt(value: string, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Recently';
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit'
    }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric'
  }).format(date);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedNonEmptyString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    return undefined;
  }
  return value.trim() === value ? value : undefined;
}
