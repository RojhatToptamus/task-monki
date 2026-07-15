import type {
  AppUpdateEvent,
  CancelRunRequest,
  ContinueRunRequest,
  BranchPublicationRecord,
  CreateDeliveryCommitRequest,
  CreateTaskRequest,
  CreatePullRequestRequest,
  DeleteTaskRequest,
  DeleteTaskResult,
  ExecuteOpenTargetActionRequest,
  GitSnapshotRecord,
  GitHubPreflightRequest,
  GitHubRepositoryRecord,
  InspectOpenTargetRequest,
  OpenTargetActionResult,
  OpenTargetInspection,
  PrepareWorktreeRequest,
  PublishBranchRequest,
  PullRequestSnapshotRecord,
  ReadArtifactRequest,
  RunRecord,
  StartRunRequest,
  Task,
  TaskManagerApi,
  TaskSnapshot,
  TransitionTaskRequest,
  WorktreeRecord,
  RefreshEvidenceRequest,
  RefreshGitHubRequest,
  RefinePromptRequest,
  RefinePromptResponse,
  RespondToInteractionRequest,
  RetryRunRequest,
  SyncAgentGoalRequest,
  ReadProtocolMessageRequest,
  StartReviewRequest,
  SteerRunRequest,
  TestExternalToolRequest,
  UpdateAppSettingsRequest
} from '../../shared/contracts';
import type {
  AttachmentContent,
  AttachmentDraftSnapshot,
  DiscardTaskAttachmentDraftRequest,
  ReadTaskAttachmentRequest,
  StageTaskAttachmentBatchRequest,
} from '../../shared/attachments';

const apiBase = '';
const FALLBACK_UPDATE_POLL_INTERVAL_MS = 2_000;

interface StructuredApiError {
  error: {
    code?: string;
    message?: string;
    retryable?: boolean;
    requestId?: string;
  };
}

export class TaskManagerApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryable = false,
    readonly requestId?: string
  ) {
    super(message);
    this.name = 'TaskManagerApiError';
  }
}

export const taskManagerApi: TaskManagerApi =
  (typeof window === 'undefined' ? undefined : window.taskManager) ??
  createBrowserTaskManagerApi(apiBase);

export function createBrowserTaskManagerApi(baseUrl: string): TaskManagerApi {
  let eventSource: EventSource | undefined;
  let fallbackPollTimer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<(event: AppUpdateEvent) => void>();

  const emitSyntheticUpdate = () => {
    const event: AppUpdateEvent = {
      type: 'projection.updated',
      scope: { kind: 'APP' },
      payload: { source: 'fallback-poll' },
      at: new Date().toISOString()
    };
    for (const listener of listeners) {
      listener(event);
    }
  };

  const ensureFallbackPolling = () => {
    if (fallbackPollTimer) {
      return;
    }
    fallbackPollTimer = setInterval(emitSyntheticUpdate, FALLBACK_UPDATE_POLL_INTERVAL_MS);
  };

  const stopFallbackPolling = () => {
    if (!fallbackPollTimer) {
      return;
    }
    clearInterval(fallbackPollTimer);
    fallbackPollTimer = undefined;
  };

  const ensureEventSource = () => {
    if (eventSource) {
      return;
    }
    if (typeof EventSource === 'undefined') {
      ensureFallbackPolling();
      return;
    }

    eventSource = new EventSource(`${baseUrl}/api/events`);
    eventSource.addEventListener('update', (message) => {
      const event = JSON.parse((message as MessageEvent).data) as AppUpdateEvent;
      for (const listener of listeners) {
        listener(event);
      }
    });
    eventSource.addEventListener('error', () => {
      eventSource?.close();
      eventSource = undefined;
      ensureFallbackPolling();
    });
  };

  return {
    getRepositoryCatalog: () => get(baseUrl, '/api/repositories'),
    selectRepository: (input) => post(baseUrl, '/api/repositories/select', input),
    addRepository: (input) => post(baseUrl, '/api/repositories/add', input),
    removeRepository: (input) => post(baseUrl, '/api/repositories/remove', input),
    relinkRepository: (input) => post(baseUrl, '/api/repositories/relink', input),
    getAppSettings: () => get(baseUrl, '/api/settings'),
    updateAppSettings: (input: UpdateAppSettingsRequest) =>
      post(baseUrl, '/api/settings', input),
    getExternalToolStatus: () => get(baseUrl, '/api/settings/tools'),
    testExternalTool: (input: TestExternalToolRequest) =>
      post(baseUrl, '/api/settings/tools/test', input),
    inspectOpenTarget: (input: InspectOpenTargetRequest) =>
      post<OpenTargetInspection>(baseUrl, '/api/open-target/inspect', input),
    executeOpenTargetAction: (input: ExecuteOpenTargetActionRequest) =>
      post<OpenTargetActionResult>(baseUrl, '/api/open-target/execute', input),
    getAgentProviderState: () => get(baseUrl, '/api/agent/provider'),
    listTasks: () => get<TaskSnapshot>(baseUrl, '/api/tasks'),
    listDiscourseConversations: (input = {}) =>
      get(baseUrl, `/api/discourse/conversations${queryString(input)}`),
    getDiscourseConversation: (conversationId) =>
      get(baseUrl, `/api/discourse/conversation${queryString({ conversationId })}`),
    listDiscourseMessages: (input) =>
      get(baseUrl, `/api/discourse/messages${queryString(input)}`),
    getDiscourseMentionCatalog: () => get(baseUrl, '/api/discourse/catalog'),
    createDiscourseConversation: (input) =>
      post(baseUrl, '/api/discourse/conversations', input),
    appendHumanDiscourseMessage: (input) =>
      post(baseUrl, '/api/discourse/messages', input),
    sendDiscourseMessage: (input) =>
      post(baseUrl, '/api/discourse/messages/send', input),
    tombstoneDiscourseMessage: (input) =>
      post(baseUrl, '/api/discourse/messages/tombstone', input),
    setPinnedDiscourseContext: (input) =>
      post(baseUrl, '/api/discourse/context/pinned', input),
    previewDiscourseContext: (input) =>
      post(baseUrl, '/api/discourse/context/preview', input),
    saveDiscourseDraft: (input) => post(baseUrl, '/api/discourse/drafts', input),
    getDiscourseDraft: (draftId) =>
      get(baseUrl, `/api/discourse/draft${queryString({ draftId })}`),
    listDiscourseDrafts: () => get(baseUrl, '/api/discourse/drafts'),
    deleteDiscourseDraft: (input) =>
      post<void>(baseUrl, '/api/discourse/drafts/delete', input),
    renameDiscourseConversation: (input) =>
      post(baseUrl, '/api/discourse/conversations/rename', input),
    setDiscourseConversationRead: (input) =>
      post(baseUrl, '/api/discourse/conversations/read', input),
    setDiscourseConversationArchived: (input) =>
      post(baseUrl, '/api/discourse/conversations/archive', input),
    deleteDiscourseConversation: (input) =>
      post<void>(baseUrl, '/api/discourse/conversations/delete', input),
    stopDiscourseWave: (input) =>
      post(baseUrl, '/api/discourse/waves/stop', input),
    confirmDiscourseWaveContext: (input) =>
      post(baseUrl, '/api/discourse/waves/confirm-context', input),
    stageTaskAttachmentBatch: (input: StageTaskAttachmentBatchRequest) =>
      post<AttachmentDraftSnapshot>(baseUrl, '/api/attachments/stage-batch', {
        attachments: input.attachments.map((attachment) => ({
          clientToken: attachment.clientToken,
          displayName: attachment.displayName,
          declaredMediaType: attachment.declaredMediaType,
          bytesBase64: arrayBufferToBase64(attachment.bytes)
        }))
      }),
    discardTaskAttachmentDraft: (input: DiscardTaskAttachmentDraftRequest) =>
      post<void>(baseUrl, '/api/attachments/drafts/discard', input),
    readTaskAttachment: (input: ReadTaskAttachmentRequest) =>
      readAttachment(baseUrl, input),
    readClipboardImage: async () => undefined,
    createTask: (input: CreateTaskRequest) => post<Task>(baseUrl, '/api/tasks', input),
    refinePrompt: (input: RefinePromptRequest) =>
      post<RefinePromptResponse>(baseUrl, '/api/prompt/refine', input),
    prepareWorktree: (input: PrepareWorktreeRequest) =>
      post<WorktreeRecord>(baseUrl, '/api/worktrees/prepare', input),
    startRun: (input: StartRunRequest) => post<RunRecord>(baseUrl, '/api/runs/start', input),
    steerRun: (input: SteerRunRequest) => post<void>(baseUrl, '/api/runs/steer', input),
    continueRun: (input: ContinueRunRequest) =>
      post<RunRecord>(baseUrl, '/api/runs/continue', input),
    retryRun: (input: RetryRunRequest) =>
      post<RunRecord>(baseUrl, '/api/runs/retry', input),
    startReview: (input: StartReviewRequest) =>
      post<RunRecord>(baseUrl, '/api/runs/review', input),
    syncAgentGoal: (input: SyncAgentGoalRequest) =>
      post(baseUrl, '/api/agent/goal/sync', input),
    cancelRun: (input: CancelRunRequest) => post<void>(baseUrl, '/api/runs/cancel', input),
    respondToInteraction: (input: RespondToInteractionRequest) =>
      post(baseUrl, '/api/interactions/respond', input),
    refreshEvidence: (input: RefreshEvidenceRequest) =>
      post<GitSnapshotRecord>(baseUrl, '/api/evidence/refresh', input),
    createDeliveryCommit: (input: CreateDeliveryCommitRequest) =>
      post<GitSnapshotRecord>(baseUrl, '/api/git/delivery-commit', input),
    preflightGitHub: (input: GitHubPreflightRequest) =>
      post<GitHubRepositoryRecord>(baseUrl, '/api/github/preflight', input),
    publishBranch: (input: PublishBranchRequest) =>
      post<BranchPublicationRecord>(baseUrl, '/api/github/publish', input),
    createPullRequest: (input: CreatePullRequestRequest) =>
      post<PullRequestSnapshotRecord>(baseUrl, '/api/github/pr/create', input),
    refreshGitHub: (input: RefreshGitHubRequest) =>
      post<PullRequestSnapshotRecord | undefined>(baseUrl, '/api/github/refresh', input),
    transitionTask: (input: TransitionTaskRequest) =>
      post<Task>(baseUrl, '/api/tasks/transition', input),
    deleteTask: (input: DeleteTaskRequest) =>
      post<DeleteTaskResult>(baseUrl, '/api/tasks/delete', input),
    readArtifact: (input: ReadArtifactRequest) => post<string>(baseUrl, '/api/artifact/read', input),
    readProtocolMessage: (input: ReadProtocolMessageRequest) =>
      post(baseUrl, '/api/agent/protocol/read', input),
    onUpdate: (listener) => {
      listeners.add(listener);
      ensureEventSource();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          eventSource?.close();
          eventSource = undefined;
          stopFallbackPolling();
        }
      };
    }
  };
}

function queryString(input: object): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value !== undefined && value !== null && value !== '') {
      query.set(key, String(value));
    }
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : '';
}

function arrayBufferToBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  const chunkSize = 32 * 1024;
  for (let offset = 0; offset < view.length; offset += chunkSize) {
    binary += String.fromCharCode(...view.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function readAttachment(
  baseUrl: string,
  input: ReadTaskAttachmentRequest
): Promise<AttachmentContent> {
  const query = new URLSearchParams({ attachmentId: input.attachmentId });
  const response = await fetch(`${baseUrl}/api/attachments/content?${query.toString()}`);
  if (!response.ok) {
    return readResponse<never>(response);
  }
  const displayName = decodeAttachmentHeader(
    response.headers.get('x-task-monki-attachment-name'),
    'Attachment metadata is missing from the server response.'
  );
  const attachmentId = response.headers.get('x-task-monki-attachment-id');
  const kind = response.headers.get('x-task-monki-attachment-kind');
  if (!attachmentId || (kind !== 'image' && kind !== 'text')) {
    throw new TaskManagerApiError(
      'Attachment metadata is missing from the server response.',
      response.status
    );
  }
  const bytes = await response.arrayBuffer();
  return {
    attachmentId,
    displayName,
    kind,
    mediaType: response.headers.get('x-task-monki-attachment-media-type') ??
      response.headers.get('content-type') ??
      'application/octet-stream',
    byteCount: bytes.byteLength,
    bytes
  };
}

function decodeAttachmentHeader(value: string | null, missingMessage: string): string {
  if (!value) {
    throw new TaskManagerApiError(missingMessage, 200);
  }
  try {
    return decodeURIComponent(value);
  } catch {
    throw new TaskManagerApiError('Attachment metadata is invalid.', 200);
  }
}

async function get<T>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`);
  return readResponse<T>(response);
}

async function post<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return readResponse<T>(response);
}

async function readResponse<T>(response: Response): Promise<T> {
  let body: T | { error?: string } | StructuredApiError | undefined;
  try {
    body = (await response.json()) as T | { error?: string } | StructuredApiError;
  } catch {
    if (!response.ok) {
      throw new TaskManagerApiError(`HTTP ${response.status}`, response.status);
    }
    throw new TaskManagerApiError('The server returned an invalid response.', response.status);
  }
  if (!response.ok) {
    const structured = structuredError(body);
    if (structured) {
      throw new TaskManagerApiError(
        structured.message ?? `HTTP ${response.status}`,
        response.status,
        structured.code,
        structured.retryable ?? false,
        structured.requestId
      );
    }
    const legacyMessage =
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof body.error === 'string'
        ? body.error
        : undefined;
    throw new TaskManagerApiError(
      legacyMessage ?? `HTTP ${response.status}`,
      response.status
    );
  }
  return body as T;
}

function structuredError(body: unknown): StructuredApiError['error'] | undefined {
  if (!body || typeof body !== 'object' || !('error' in body)) {
    return undefined;
  }
  const error = (body as { error?: unknown }).error;
  return error && typeof error === 'object'
    ? (error as StructuredApiError['error'])
    : undefined;
}
