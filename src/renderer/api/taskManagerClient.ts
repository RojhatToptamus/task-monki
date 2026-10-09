import type {
  AcceptPreviewRecipeDraftRequest,
  AddDesignReferencesRequest,
  AppUpdateEvent,
  Board,
  BoardSnapshot,
  CancelRunRequest,
  CancelDesignTurnRequest,
  CancelPromptRefinementRequest,
  ContinueRunRequest,
  CreateDesignRequest,
  BranchPublicationRecord,
  CreateDeliveryCommitRequest,
  CreateTaskRequest,
  ExistingWorktree,
  ImportTaskRequest,
  ImportPreview,
  PreviewImportRequest,
  ReconnectWorktreeRequest,
  UpdateWorktreeComparisonRequest,
  CreatePullRequestRequest,
  DeleteTaskRequest,
  DeleteDesignDraftRequest,
  DeleteTaskResult,
  DesignDetailSnapshot,
  DesignConversationPage,
  DesignDraftRecord,
  DesignListItem,
  DiscardPreviewRecipeDraftRequest,
  ExecuteOpenTargetActionRequest,
  GitSnapshotRecord,
  SendPreviewAgentMessageRequest,
  StopPreviewAgentRequest,
  GetPreviewRecipeGenerationRequest,
  GitHubPreflightRequest,
  GitHubRepositoryRecord,
  InspectOpenTargetRequest,
  ImportDesignReferenceAssetRequest,
  OpenTargetActionResult,
  OpenTargetInspection,
  OpenPreviewRequest,
  OpenPreviewResult,
  PrepareWorktreeRequest,
  InspectWorktreePreparationRequest,
  PrepareWorktreeResult,
  PublishBranchRequest,
  PullRequestSnapshotRecord,
  ReadArtifactRequest,
  Repository,
  RepositoryImpact,
  ReadDesignDraftAttachmentRequest,
  RunRecord,
  StartRunRequest,
  Task,
  TaskDetailSnapshot,
  TaskManagerApi,
  TransitionTaskRequest,
  WorktreeRecord,
  WorktreePreparationInspection,
  RefreshEvidenceRequest,
  RefreshGitHubRequest,
  RefinePromptRequest,
  RemoveDesignReferenceRequest,
  RefinePromptResponse,
  RespondToInteractionRequest,
  RetryRunRequest,
  RestartDesignPreviewRequest,
  RestoreDesignRevisionRequest,
  DuplicateDesignRequest,
  RenameDesignRequest,
  ArchiveDesignRequest,
  ListDesignConversationRequest,
  SaveDesignDraftRequest,
  SubmitDesignTurnRequest,
  SyncAgentGoalRequest,
  ReadProtocolMessageRequest,
  StartReviewRequest,
  TaskInstruction,
  QueueTaskInstructionRequest,
  EditTaskInstructionRequest,
  SendTaskInstructionRequest,
  SaveTaskAgentDraftRequest,
  SaveTaskPromptRequest,
  SteerRunRequest,
  TestExternalToolRequest,
  UpdateAgentNativeSessionRequest,
  UpdateAppSettingsRequest,
  ValidatePreviewRecipeDraftRequest
} from '../../shared/contracts';
import type {
  AttachmentContent,
  AttachmentDraftSnapshot,
  DiscardTaskAttachmentDraftRequest,
  ReadTaskAttachmentRequest,
  StageTaskAttachmentBatchRequest,
} from '../../shared/attachments';
import type {
  DiscourseConversationAggregateRecord,
  DiscourseConversationPage,
  DiscourseConversationRecord,
  DiscourseContextPreview,
  DiscourseDraftRecord,
  DiscourseMentionCatalogSnapshot,
  DiscourseMessagePage,
  DiscourseMessageRecord,
  DiscourseResponseWaveRecord,
  SendDiscourseMessageResult
} from '../../shared/discourse';

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
      taskId: '__browser_poll__',
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
    eventSource.addEventListener('open', stopFallbackPolling);
    eventSource.addEventListener('error', () => {
      ensureFallbackPolling();
    });
  };

  return {
    chooseRepositoryFolder: async () => {
      const selectedPath = await post<string | null>(baseUrl, '/api/repository/chooseFolder', {});
      return selectedPath ?? undefined;
    },
    addRepository: (path) =>
      post<Repository>(baseUrl, '/api/repositories', { path }),
    getRepositoryImpact: (repositoryId) =>
      get<RepositoryImpact>(baseUrl, `/api/repositories/${encodeURIComponent(repositoryId)}/impact`),
    disconnectRepository: (input) =>
      post<Repository>(
        baseUrl,
        `/api/repositories/${encodeURIComponent(input.repositoryId)}/disconnect`,
        input
      ),
    reconnectRepository: (input) =>
      post<Repository>(
        baseUrl,
        `/api/repositories/${encodeURIComponent(input.repositoryId)}/reconnect`,
        input
      ),
    refreshRepository: (repositoryId) =>
      post<Repository>(
        baseUrl,
        `/api/repositories/${encodeURIComponent(repositoryId)}/refresh`,
        {}
      ),
    createBoard: (input) => post<Board>(baseUrl, '/api/boards', input),
    updateBoard: (input) =>
      post<Board>(baseUrl, `/api/boards/${encodeURIComponent(input.boardId)}`, input),
    deleteBoard: (boardId) =>
      post<void>(baseUrl, `/api/boards/${encodeURIComponent(boardId)}/delete`, {}),
    saveAgentProfile: (input) => post(baseUrl, '/api/agent-profiles/save', input),
    deleteAgentProfile: (profileId) => post(baseUrl, '/api/agent-profiles/delete', { profileId }),
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
  getAgentRuntimeCatalog: () => get(baseUrl, '/api/agent/runtimes'),
    discoverAgentRuntimeModels: (runtimeId) =>
      post(baseUrl, '/api/agent/runtimes/discover', { runtimeId }),
    updateAgentNativeSession: (input: UpdateAgentNativeSessionRequest) =>
      post(baseUrl, '/api/agent/session/native', input),
    getBoardSnapshot: () => get<BoardSnapshot>(baseUrl, '/api/board'),
    getTaskDetail: (taskId) =>
      get<TaskDetailSnapshot>(
        baseUrl,
        `/api/tasks/${encodeURIComponent(taskId)}`
      ),
    listDiscourseConversations: (input = {}) => {
      const query = new URLSearchParams();
      if (input.status) query.set('status', input.status);
      if (input.cursor) query.set('cursor', input.cursor);
      if (input.limit !== undefined) query.set('limit', String(input.limit));
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      return get<DiscourseConversationPage>(
        baseUrl,
        `/api/discourse/conversations${suffix}`
      );
    },
    getDiscourseConversation: (conversationId) =>
      get<DiscourseConversationAggregateRecord>(
        baseUrl,
        `/api/discourse/conversations/${encodeURIComponent(conversationId)}`
      ),
    listDiscourseMessages: (input) => {
      const query = new URLSearchParams({ conversationId: input.conversationId });
      if (input.beforeCursor) query.set('beforeCursor', input.beforeCursor);
      if (input.limit !== undefined) query.set('limit', String(input.limit));
      return get<DiscourseMessagePage>(
        baseUrl,
        `/api/discourse/messages?${query.toString()}`
      );
    },
    getDiscourseMessageByClientId: (input) => {
      const query = new URLSearchParams({
        conversationId: input.conversationId,
        clientMessageId: input.clientMessageId
      });
      return get<DiscourseMessageRecord | null>(
        baseUrl,
        `/api/discourse/messages/by-client-id?${query.toString()}`
      );
    },
    getDiscourseMentionCatalog: () =>
      get<DiscourseMentionCatalogSnapshot>(baseUrl, '/api/discourse/mentions'),
    createDiscourseConversation: (input) =>
      post<DiscourseConversationRecord>(baseUrl, '/api/discourse/conversations', input),
    appendHumanDiscourseMessage: (input) =>
      post<DiscourseMessageRecord>(baseUrl, '/api/discourse/messages', input),
    sendDiscourseMessage: (input) =>
      post<SendDiscourseMessageResult>(baseUrl, '/api/discourse/messages/send', input),
    resumeDiscourseAcceptedSend: (input) =>
      post<SendDiscourseMessageResult>(baseUrl, '/api/discourse/messages/resume', input),
    cancelDiscourseAcceptedSend: (input) =>
      post<DiscourseConversationAggregateRecord>(
        baseUrl,
        '/api/discourse/messages/cancel-response',
        input
      ),
    tombstoneDiscourseMessage: (input) =>
      post<DiscourseConversationRecord>(baseUrl, '/api/discourse/messages/tombstone', input),
    setPinnedDiscourseContext: (input) =>
      post<DiscourseConversationAggregateRecord>(baseUrl, '/api/discourse/context/pin', input),
    previewDiscourseContext: (input) =>
      post<DiscourseContextPreview>(baseUrl, '/api/discourse/context/preview', input),
    saveDiscourseDraft: (input) =>
      post<DiscourseDraftRecord>(baseUrl, '/api/discourse/drafts', input),
    getDiscourseDraft: (draftId) =>
      get<DiscourseDraftRecord | undefined>(
        baseUrl,
        `/api/discourse/drafts/${encodeURIComponent(draftId)}`
      ),
    listDiscourseDrafts: () =>
      get<DiscourseDraftRecord[]>(baseUrl, '/api/discourse/drafts'),
    deleteDiscourseDraft: (input) =>
      post<void>(baseUrl, '/api/discourse/drafts/delete', input),
    renameDiscourseConversation: (input) =>
      post<DiscourseConversationRecord>(baseUrl, '/api/discourse/conversations/rename', input),
    setDiscourseConversationRead: (input) =>
      post<DiscourseConversationRecord>(baseUrl, '/api/discourse/conversations/read', input),
    setDiscourseConversationArchived: (input) =>
      post<DiscourseConversationRecord>(baseUrl, '/api/discourse/conversations/archive', input),
    deleteDiscourseConversation: (input) =>
      post<void>(baseUrl, '/api/discourse/conversations/delete', input),
    stopDiscourseWave: (input) =>
      post<DiscourseResponseWaveRecord>(baseUrl, '/api/discourse/waves/stop', input),
    confirmDiscourseWaveContext: (input) =>
      post<DiscourseResponseWaveRecord>(
        baseUrl,
        '/api/discourse/waves/confirm-context',
        input
      ),
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
    getAttachmentDraft: (draftId: string) => get<AttachmentDraftSnapshot>(baseUrl, `/api/attachments/drafts/${encodeURIComponent(draftId)}`),
    readTaskAttachment: (input: ReadTaskAttachmentRequest) =>
      readAttachment(
        baseUrl,
        `/api/attachments/content?${new URLSearchParams({ attachmentId: input.attachmentId, ...(input.draftId ? { draftId: input.draftId } : {}), ...(input.conversationId ? { conversationId: input.conversationId } : {}) }).toString()}`
      ),
    readClipboardImage: async () => undefined,
    createTask: (input: CreateTaskRequest) => post<Task>(baseUrl, '/api/tasks', input),
    importTask: (input: ImportTaskRequest) => post<Task>(baseUrl, '/api/tasks/import', input),
    previewImport: (input: PreviewImportRequest) => post<ImportPreview>(baseUrl, '/api/tasks/import/preview', input),
    listExistingWorktrees: (repositoryId: string) =>
      get<ExistingWorktree[]>(baseUrl, `/api/worktrees?${new URLSearchParams({ repositoryId })}`),
    reconnectWorktree: (input: ReconnectWorktreeRequest) =>
      post<WorktreeRecord>(baseUrl, '/api/worktrees/reconnect', input),
    updateWorktreeComparison: (input: UpdateWorktreeComparisonRequest) =>
      post<WorktreeRecord>(baseUrl, '/api/worktrees/comparison', input),
    listDesigns: () => get<DesignListItem[]>(baseUrl, '/api/designs'),
    getDesign: (designId: string) =>
      get<DesignDetailSnapshot>(baseUrl, `/api/designs/${encodeURIComponent(designId)}`),
    listDesignConversation: (input: ListDesignConversationRequest) => {
      const query = new URLSearchParams();
      if (input.beforeCursor) query.set('beforeCursor', input.beforeCursor);
      if (input.limit !== undefined) query.set('limit', String(input.limit));
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      return get<DesignConversationPage>(
        baseUrl,
        `/api/designs/${encodeURIComponent(input.designId)}/conversation${suffix}`
      );
    },
    getDesignDraft: (designId: string) =>
      get<DesignDraftRecord | null>(
        baseUrl,
        `/api/designs/${encodeURIComponent(designId)}/draft`
      ),
    readDesignDraftAttachment: (input: ReadDesignDraftAttachmentRequest) =>
      readAttachment(
        baseUrl,
        `/api/designs/${encodeURIComponent(input.designId)}/draft/attachments/${encodeURIComponent(input.attachmentId)}`
      ),
    saveDesignDraft: (input: SaveDesignDraftRequest) =>
      post<DesignDraftRecord>(
        baseUrl,
        `/api/designs/${encodeURIComponent(input.designId)}/draft`,
        input
      ),
    deleteDesignDraft: (input: DeleteDesignDraftRequest) =>
      post<void>(
        baseUrl,
        `/api/designs/${encodeURIComponent(input.designId)}/draft/delete`,
        input
      ),
    inspectDesignRepository: (input: import('../../shared/design').InspectDesignRepositoryRequest) => post<import('../../shared/contracts').DesignRepositoryInspection>(baseUrl, '/api/designs/repository/inspect', input),
    updateDesignPreviewTarget: (input: import('../../shared/design').UpdateDesignPreviewTargetRequest) => post<DesignDetailSnapshot>(baseUrl, '/api/designs/target', input),
    startDesign: (input: import('../../shared/design').StartDesignRequest) => post<DesignDetailSnapshot>(baseUrl, '/api/designs/start', input),
    createDesign: (input: CreateDesignRequest) =>
      post<DesignDetailSnapshot>(baseUrl, '/api/designs', input),
    submitDesignTurn: (input: SubmitDesignTurnRequest) =>
      post<DesignDetailSnapshot>(
        baseUrl,
        `/api/designs/${encodeURIComponent(input.designId)}/turns`,
        input
      ),
    addDesignReferences: (input: AddDesignReferencesRequest) =>
      post<DesignDetailSnapshot>(
        baseUrl,
        `/api/designs/${encodeURIComponent(input.designId)}/references`,
        input
      ),
    removeDesignReference: (input: RemoveDesignReferenceRequest) =>
      post<DesignDetailSnapshot>(
        baseUrl,
        `/api/designs/${encodeURIComponent(input.designId)}/references/${encodeURIComponent(input.referenceId)}/remove`,
        input
      ),
    importDesignReferenceAsset: (input: ImportDesignReferenceAssetRequest) =>
      post<DesignDetailSnapshot>(
        baseUrl,
        `/api/designs/${encodeURIComponent(input.designId)}/references/${encodeURIComponent(input.referenceId)}/import`,
        input
      ),
    cancelDesignTurn: (input: CancelDesignTurnRequest) =>
      post<DesignDetailSnapshot>(
        baseUrl,
        `/api/designs/${encodeURIComponent(input.designId)}/turns/${encodeURIComponent(input.turnId)}/cancel`,
        input
      ),
    restartDesignPreview: (input: RestartDesignPreviewRequest) =>
      post<DesignDetailSnapshot>(
        baseUrl,
        `/api/designs/${encodeURIComponent(input.designId)}/preview/restart`,
        input
      ),
    restoreDesignRevision: (input: RestoreDesignRevisionRequest) =>
      post<DesignDetailSnapshot>(
        baseUrl,
        `/api/designs/${encodeURIComponent(input.designId)}/revisions/${encodeURIComponent(input.revisionId)}/restore`,
        input
      ),
    duplicateDesign: (input: DuplicateDesignRequest) =>
      post<DesignDetailSnapshot>(
        baseUrl,
        `/api/designs/${encodeURIComponent(input.designId)}/revisions/${encodeURIComponent(input.revisionId)}/duplicate`,
        input
      ),
    renameDesign: (input: RenameDesignRequest) =>
      post<DesignDetailSnapshot>(
        baseUrl,
        `/api/designs/${encodeURIComponent(input.designId)}/rename`,
        input
      ),
    archiveDesign: (input: ArchiveDesignRequest) =>
      post<DesignDetailSnapshot>(
        baseUrl,
        `/api/designs/${encodeURIComponent(input.designId)}/archive`,
        input
      ),
    refinePrompt: (input: RefinePromptRequest) =>
      post<RefinePromptResponse>(baseUrl, '/api/prompt/refine', input),
    cancelPromptRefinement: (input: CancelPromptRefinementRequest) =>
      post<void>(baseUrl, '/api/prompt/refine/cancel', input),
    prepareWorktree: (input: PrepareWorktreeRequest) =>
      post<PrepareWorktreeResult>(baseUrl, '/api/worktrees/prepare', input),
    inspectWorktreePreparation: (input: InspectWorktreePreparationRequest) =>
      post<WorktreePreparationInspection>(baseUrl, '/api/worktrees/inspect-preparation', input),
    startRun: (input: StartRunRequest) => post<RunRecord>(baseUrl, '/api/runs/start', input),
    queueTaskInstruction: (input: QueueTaskInstructionRequest) => post<TaskInstruction>(baseUrl, '/api/task-instructions/queue', input),
    editTaskInstruction: (input: EditTaskInstructionRequest) => post<void>(baseUrl, '/api/task-instructions/edit', input),
    sendTaskInstruction: (input: SendTaskInstructionRequest) => post<RunRecord>(baseUrl, '/api/task-instructions/send', input),
    saveTaskPrompt: (input: SaveTaskPromptRequest) => post<void>(baseUrl, '/api/tasks/prompt', input),
    saveTaskAgentDraft: (input: SaveTaskAgentDraftRequest) => post<void>(baseUrl, '/api/task-instructions/draft', input),
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
    listApplicationPreviews: () => post(baseUrl, '/api/application/listApplicationPreviews', {}),
    getApplicationPreview: input => post(baseUrl, '/api/application/getApplicationPreview', input),
    connectApplicationPreviewSource: input => post(baseUrl, '/api/application/connectApplicationPreviewSource', input),
    inspectApplicationPreviewSetup: input => post(baseUrl, '/api/application/inspectApplicationPreviewSetup', input),
    readApplicationPreviewFile: input => post(baseUrl, '/api/application/readApplicationPreviewFile', input),
    saveApplicationPreviewFile: input => post(baseUrl, '/api/application/saveApplicationPreviewFile', input),
    chooseApplicationPreviewFile: input => post(baseUrl, '/api/application/chooseApplicationPreviewFile', input),
    startRetainedApplicationPreview: input => post(baseUrl, '/api/application/startRetainedApplicationPreview', input),
    startApplicationPreview: input => post(baseUrl, '/api/application/startApplicationPreview', input),
    approveApplicationPreview: input => post(baseUrl, '/api/application/approveApplicationPreview', input),
    stopApplicationPreview: input => post(baseUrl, '/api/application/stopApplicationPreview', input),
    cancelApplicationPreview: input => post(baseUrl, '/api/application/cancelApplicationPreview', input),
    openApplicationPreview: input => post(baseUrl, '/api/application/openApplicationPreview', input),
    readApplicationPreviewLogs: input => post(baseUrl, '/api/application/readApplicationPreviewLogs', input),
    inspectApplicationPreviewConfiguration: input => post(baseUrl, '/api/application/inspectApplicationPreviewConfiguration', input),
    rerunApplicationPreviewJob: input => post(baseUrl, '/api/application/rerunApplicationPreviewJob', input),
    deleteApplicationPreviewData: input => post(baseUrl, '/api/application/deleteApplicationPreviewData', input),
    getPreviewRecipeGeneration: (input: GetPreviewRecipeGenerationRequest) =>
      post(baseUrl, '/api/preview/recipe-generation/get', input),
    sendPreviewAgentMessage: (input: SendPreviewAgentMessageRequest) =>
      post<TaskInstruction>(baseUrl, '/api/preview/agent/send', input),
    stopPreviewAgent: (input: StopPreviewAgentRequest) =>
      post<void>(baseUrl, '/api/preview/agent/stop', input),
    validatePreviewRecipeDraft: (input: ValidatePreviewRecipeDraftRequest) =>
      post(baseUrl, '/api/preview/recipe-generation/validate', input),
    acceptPreviewRecipeDraft: (input: AcceptPreviewRecipeDraftRequest) =>
      post(baseUrl, '/api/preview/recipe-generation/accept', input),
    discardPreviewRecipeDraft: (input: DiscardPreviewRecipeDraftRequest) =>
      post(baseUrl, '/api/preview/recipe-generation/discard', input),
    openDesignPreview: (input: OpenPreviewRequest) => post<OpenPreviewResult>(baseUrl, '/api/design/preview/open', input),
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
  resourcePath: string
): Promise<AttachmentContent> {
  const response = await fetch(`${baseUrl}${resourcePath}`);
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
  let body: T | StructuredApiError | undefined;
  try {
    body = (await response.json()) as T | StructuredApiError;
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
    throw new TaskManagerApiError(`HTTP ${response.status}`, response.status);
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
