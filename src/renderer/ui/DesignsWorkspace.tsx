import type { CustomAgentProfile } from '../../shared/agentProfiles';
import { AgentProfileSelect } from './AgentProfileSelect';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type SetStateAction
} from 'react';
import type {
  AgentInteractionDecision,
  AgentExecutionSettings,
  AgentModel,
  AgentRuntimeState,
  CreateDesignRequest,
  DesignDraftRecord,
  InteractionRequestRecord
} from '../../shared/contracts';
import {
  type AttachmentDraftSnapshot,
  type AttachmentContent,
  type ClipboardAttachmentImage,
  type DiscardTaskAttachmentDraftRequest,
  type StageTaskAttachmentBatchRequest
} from '../../shared/attachments';
import {
  designModelUnavailableReason,
  designProjectStatus,
  designRuntimeUnavailableReason,
  designStatusView,
  designWorkspaceLayout,
  formatDesignUpdatedAt,
  supportedDesignModels,
  visibleDesignProjects,
  type DesignHistoryFilter,
  type DesignProjectDetail,
  type DesignProjectSummary,
  type DesignProjectStatus,
  type DesignWorkspaceLayoutMode
} from '../model/designs';
import {
  DesignCanvas,
  type DesignCanvasHideRequest,
  type DesignCanvasRefreshRequest,
  type DesignCanvasShowRequest
} from './DesignCanvas';
import { DesignRepositorySetup } from './DesignRepositorySetup';
import { DesignConversation } from './DesignConversation';
import { DesignFilesDrawer } from './DesignFilesDrawer';
import { AttachmentComposerShell } from './AttachmentComposerShell';
import { RepositorySelect } from './RepositoryPicker';
import { buildRepositoryOptions } from '../model/repositories';
import { useDialogFocusBoundary } from './dialogFocus';
import { AgentModelSelector } from './AgentModelSelector';
import {
  resolveReasoningEffort,
  selectModel
} from '../model/agentExecutionSettings';
import { formatAttachmentBytes } from '../model/taskAttachmentDraft';
import { creationRequiresUnchangedRetry } from '../model/taskAttachmentComposer';
import { useTaskAttachments } from './useTaskAttachments';
import { DesignProjectMenu } from './DesignActionsMenu';
import { StatusGlyph } from './StatusBadge';
import { PanelResizeHandle } from './PanelResizeHandle';
import { PanelIcon } from './AppNavigation';
import {
  UiCloseIcon,
  UiFolderIcon,
  UiLayoutIcon,
  UiPlusIcon,
  UiSearchIcon
} from './UiIcons';
import {
  focusedPanelWidth,
  persistDesignLayout,
  persistFocusedPanelWidth,
  savedDesignLayout
} from '../model/workspaceLayout';

export type CreateDesignInput = Pick<
  CreateDesignRequest,
  | 'source'
  | 'brief'
  | 'agentProfileId'
  | 'creationToken'
  | 'runtimeId'
  | 'model'
  | 'modelProvider'
  | 'reasoningEffort'
  | 'attachmentDraftId'
>;

export interface DesignsWorkspaceProps {
  onUpdateProject?(project: DesignProjectDetail): void;
  repositories?: readonly import('../../shared/contracts').Repository[];
  onInspectRepository?(repositoryId: string): Promise<import('../../shared/contracts').DesignRepositoryInspection>;

  agentProfiles?: readonly CustomAgentProfile[];
  historyCollapsed?: boolean;
  onHistoryCollapsedChange?(collapsed: boolean): void;
  designs: readonly DesignProjectSummary[];
  selectedDesignId?: string;
  project?: DesignProjectDetail;
  draft?: DesignDraftRecord | null;
  models: AgentModel[];
  runtimes: AgentRuntimeState[];
  defaultAgentSettings?: AgentExecutionSettings;
  loading?: boolean;
  error?: string;
  desktopCanvasAvailable: boolean;
  canvasOccluded?: boolean;
  onSelectDesign(designId: string): void;
  onCreateDesign(input: CreateDesignInput): Promise<void>;
  onSubmitRefinement(
    designId: string,
    message: string,
    referenceIds: string[],
    attachmentDraftId?: string
  ): Promise<void>;
  onStageAttachmentBatch(input: StageTaskAttachmentBatchRequest): Promise<AttachmentDraftSnapshot>;
  onDiscardAttachmentDraft(input: DiscardTaskAttachmentDraftRequest): Promise<void>;
  onReadClipboardImage?(): Promise<ClipboardAttachmentImage | undefined>;
  onReadDesignDraftAttachment(
    designId: string,
    attachmentId: string
  ): Promise<AttachmentContent>;
  onReadAttachment?(attachmentId: string): Promise<AttachmentContent>;
  onAddReferences(designId: string, attachmentDraftId: string): Promise<string[]>;
  onRemoveReference(designId: string, referenceId: string): Promise<void>;
  onImportReferenceAsset(designId: string, referenceId: string): Promise<void>;
  onStopTurn(designId: string, turnId: string): Promise<void>;
  onLoadEarlier(designId: string): Promise<void>;
  onSaveDraft(
    designId: string,
    body: string,
    referenceIds: string[],
    attachmentDraftId: string | undefined,
    expectedRevision: number
  ): Promise<DesignDraftRecord>;
  onDeleteDraft(designId: string, expectedRevision: number): Promise<void>;
  onDiscoverAgentRuntimeModels?(runtimeId: string): Promise<void>;
  onRespondToInteraction(
    interaction: InteractionRequestRecord,
    decision: AgentInteractionDecision
  ): Promise<void>;
  onRefreshCanvas(request: DesignCanvasRefreshRequest): Promise<void>;
  onRestartCanvas(designId: string): Promise<void>;
  onSelectRevision(designId: string, revisionId: string): Promise<void>;
  onOpenCanvas?(taskId: string, generationId: string, routeId: string): Promise<void>;
  onOpenDesignLocation(designId: string, worktreeId: string): Promise<void>;
  onRestoreRevision(designId: string, revisionId: string): Promise<void>;
  onDuplicateDesign(designId: string, revisionId: string): Promise<void>;
  onRenameDesign(designId: string, title: string): Promise<void>;
  onArchiveDesign(designId: string): Promise<void>;
  onDeleteDesign(designId: string, removeWorktree?: boolean): Promise<void>;
  onShowCanvas?(request: DesignCanvasShowRequest): void | Promise<void>;
  onHideCanvas?(request: DesignCanvasHideRequest): void;
  onRetryLoad?(): void;
}

export function DesignsWorkspace({
  onUpdateProject,
  repositories = [],
  onInspectRepository,
  agentProfiles = [],
  historyCollapsed = false,
  onHistoryCollapsedChange,
  designs,
  selectedDesignId,
  project,
  draft = null,
  models,
  runtimes,
  defaultAgentSettings,
  loading = false,
  error,
  desktopCanvasAvailable,
  canvasOccluded = false,
  onSelectDesign,
  onCreateDesign,
  onSubmitRefinement,
  onStageAttachmentBatch,
  onDiscardAttachmentDraft,
  onReadClipboardImage,
  onReadDesignDraftAttachment,
  onReadAttachment,
  onAddReferences,
  onRemoveReference,
  onImportReferenceAsset,
  onStopTurn,
  onLoadEarlier,
  onSaveDraft,
  onDeleteDraft,
  onDiscoverAgentRuntimeModels,
  onRespondToInteraction,
  onRefreshCanvas,
  onRestartCanvas,
  onSelectRevision,
  onOpenCanvas,
  onOpenDesignLocation,
  onRestoreRevision,
  onDuplicateDesign,
  onRenameDesign,
  onArchiveDesign,
  onDeleteDesign,
  onShowCanvas,
  onHideCanvas,
  onRetryLoad
}: DesignsWorkspaceProps) {
  const workspaceRef = useRef<HTMLElement>(null);
  const historyRailRef = useRef<HTMLElement>(null);
  const historySearchRef = useRef<HTMLInputElement>(null);
  const [creatingBlank, setCreatingBlank] = useState(false);
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const [layout, setLayout] = useState<DesignWorkspaceLayoutMode>(() => savedDesignLayout());
  const [historyWidth, setHistoryWidth] = useState(() =>
    focusedPanelWidth('design-history', 268, 220, 360)
  );
  const [conversationWidth, setConversationWidth] = useState(() =>
    focusedPanelWidth('design-conversation', 380, 320, 640)
  );
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyFilter, setHistoryFilter] = useState<DesignHistoryFilter>('active');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [previewSetupModalOpen, setPreviewSetupModalOpen] = useState(false);
  const [attachmentPreviewOpen, setAttachmentPreviewOpen] = useState(false);
  const [referenceSelection, setReferenceSelection] = useState(() => ({
    designId: project?.design.id,
    draftRevision: draft?.recordRevision,
    ids: draft?.referenceIds ?? []
  }));
  if (
    referenceSelection.designId !== project?.design.id ||
    referenceSelection.draftRevision !== draft?.recordRevision
  ) {
    if (referenceSelection.designId !== project?.design.id) setFilesOpen(false);
    setReferenceSelection({
      designId: project?.design.id,
      draftRevision: draft?.recordRevision,
      ids: draft?.referenceIds ?? []
    });
  }
  const selectedReferenceIds = referenceSelection.ids.filter((id) =>
    project?.references.some((reference) => reference.id === id && reference.state === 'ACTIVE')
  );
  const setSelectedReferenceIds = (update: SetStateAction<string[]>) => {
    setReferenceSelection((current) => ({
      ...current,
      ids: typeof update === 'function' ? update(current.ids) : update
    }));
  };
  const projectModelDiscoveryRef = useRef<string | undefined>(undefined);
  const visibleDesigns = visibleDesignProjects(designs, historyQuery, historyFilter);
  const activeDesignId = project?.design.id ?? selectedDesignId;
  const layoutView = designWorkspaceLayout(workspaceWidth, historyCollapsed, historyWidth);
  const filesWidth = filesOpen ? 300 : 0;
  const contentLayout = designWorkspaceLayout(layoutView.mainWidth - filesWidth, true);
  const renderedLayout = contentLayout.availableModes.includes(layout) ? layout : filesOpen ? 'canvas' : 'chat';
  const compact = workspaceWidth > 0 && !layoutView.splitAvailable;
  const maxConversationWidth = Math.max(320, contentLayout.mainWidth - 485);
  const renderedConversationWidth = Math.min(conversationWidth, maxConversationWidth);
  const historyModalOpen = compact && !historyCollapsed;
  const projectRuntime = project
    ? runtimes.find(
        (runtime) => runtime.preflight.runtime.id === project.task.runtimeId
      )
    : undefined;
  const projectModel = project
    ? models.find(
        (model) =>
          model.runtimeId === project.task.runtimeId &&
          model.model === project.task.agentSettings.model &&
          (project.task.agentSettings.modelProvider === undefined ||
            model.modelProvider === project.task.agentSettings.modelProvider)
      )
    : undefined;
  const refineUnavailableReason = project
    ? !projectRuntime
      ? 'The agent for this Design is not available.'
      : !projectRuntime.preflight.readiness.canStart
        ? projectRuntime.preflight.readiness.detail ||
          projectRuntime.preflight.readiness.summary
        : !projectModel
          ? 'The selected Design model is not available from this provider.'
          : designModelUnavailableReason(projectRuntime, projectModel)
    : undefined;
  const latestEntry = project?.conversation.at(-1);
  const retryEntry =
    project?.actions.canRefine && !refineUnavailableReason && latestEntry &&
    ['FAILED', 'NEEDS_ATTENTION', 'CANCELED'].includes(latestEntry.turn.outcome ?? '')
      ? latestEntry
      : undefined;

  useEffect(() => {
    if (!project || !projectRuntime) return;

    const discoveryKey = `${project.design.id}:${projectRuntime.preflight.runtime.id}`;
    if (projectModel) {
      if (projectModelDiscoveryRef.current === discoveryKey) {
        projectModelDiscoveryRef.current = undefined;
      }
      return;
    }

    if (
      !projectRuntime.preflight.readiness.canStart ||
      projectRuntime.preflight.capabilities.modelCatalog.activation !== 'EXPLICIT' ||
      !onDiscoverAgentRuntimeModels
    ) {
      return;
    }
    if (projectModelDiscoveryRef.current === discoveryKey) return;
    projectModelDiscoveryRef.current = discoveryKey;
    void onDiscoverAgentRuntimeModels(projectRuntime.preflight.runtime.id).catch(
      () => {
        if (projectModelDiscoveryRef.current === discoveryKey) {
          projectModelDiscoveryRef.current = undefined;
        }
      }
    );
  }, [
    onDiscoverAgentRuntimeModels,
    project?.design.id,
    projectModel?.id,
    projectRuntime
  ]);

  useDialogFocusBoundary({
    dialogRef: historyRailRef,
    initialFocusRef: historySearchRef,
    busy: false,
    onClose: () => onHistoryCollapsedChange?.(true),
    active: historyModalOpen
  });

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const update = () => {
      setWorkspaceWidth(workspace.getBoundingClientRect().width);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    workspace.style.setProperty('--design-history-width', `${historyWidth}px`);
    workspace.style.setProperty('--design-conversation-width', `${renderedConversationWidth}px`);
    workspace.style.setProperty('--design-files-width', `${filesWidth}px`);
  }, [historyWidth, renderedConversationWidth, filesWidth]);

  const showCreate =
    creatingBlank || (!loading && !error && designs.length === 0 && !project);

  return (
    <main
      ref={workspaceRef}
      className={`tm-designs ${compact ? 'tm-designs--compact' : ''} ${
        historyCollapsed ? 'tm-designs--history-collapsed' : ''
      }`}
      aria-label="Designs workspace"
    >
      {historyModalOpen ? (
        <button
          type="button"
          className="tm-designs-rail__scrim"
          aria-label="Dismiss Design history"
          onClick={() => onHistoryCollapsedChange?.(true)}
        />
      ) : null}
      {!historyCollapsed ? <aside
        id="design-history-panel"
        ref={historyRailRef}
        className={`tm-designs-rail ${historyModalOpen ? 'tm-designs-rail--open' : ''}`}
        aria-label="Designs"
        aria-modal={historyModalOpen ? true : undefined}
        role={historyModalOpen ? 'dialog' : undefined}
        tabIndex={historyModalOpen ? -1 : undefined}
      >
        <header className="tm-designs-rail__head">
          <div>
            <h2>Designs</h2>
            <p>Build and refine working previews.</p>
          </div>
          <div className="tm-designs-rail__head-actions">
            <button
              type="button"
              className="tm-designs-rail__new"
              onClick={() => {
                setCreatingBlank(true);
                if (historyModalOpen) onHistoryCollapsedChange?.(true);
              }}
            >
              <UiPlusIcon />
              <span>New</span>
            </button>
            {historyModalOpen ? (
              <button
                type="button"
                className="tm-iconbtn tm-designs-rail__close"
                aria-label="Close Design history"
                title="Close Design history"
                onClick={() => onHistoryCollapsedChange?.(true)}
              >
                <PanelIcon />
              </button>
            ) : null}
          </div>
        </header>

        <label className="tm-designs-rail__search">
          <UiSearchIcon />
          <span className="tm-visually-hidden">Search Designs</span>
          <input
            ref={historySearchRef}
            type="search"
            value={historyQuery}
            placeholder="Search Designs"
            onChange={(event) => setHistoryQuery(event.target.value)}
          />
        </label>
        <div className="tm-designs-rail__filter" role="group" aria-label="Design status">
          {(['active', 'all', 'archived'] as const).map((filter) => (
            <button
              type="button"
              key={filter}
              aria-pressed={historyFilter === filter}
              onClick={() => setHistoryFilter(filter)}
            >
              {filter === 'active' ? 'Recent' : filter === 'all' ? 'All' : 'Archive'}
            </button>
          ))}
        </div>

        <nav className="tm-designs-rail__list" aria-label="Recent Designs">
          {visibleDesigns.length === 0 ? (
            <p className="tm-designs-rail__empty">
              {designs.length === 0 ? 'No Designs yet' : 'No Designs match this view'}
            </p>
          ) : (
            visibleDesigns.map((design) => {
              const displayStatus: DesignProjectStatus =
                project?.design.id === design.id ? designProjectStatus(project) : design.status;
              const status = designStatusView(displayStatus);
              const selected = !showCreate && activeDesignId === design.id;
              return (
                <button
                  type="button"
                  className={`tm-designs-rail__item ${selected ? 'tm-designs-rail__item--active' : ''}`}
                  aria-current={selected ? 'page' : undefined}
                  key={design.id}
                  onClick={() => {
                    setCreatingBlank(false);
                    onSelectDesign(design.id);
                    if (historyModalOpen) onHistoryCollapsedChange?.(true);
                  }}
                >
                  <span className="tm-designs-rail__item-title">{design.title}</span>
                  <span className="tm-designs-rail__item-meta">
                    <span data-tone={status.tone}>{status.label}</span>
                    <time dateTime={design.updatedAt}>
                      {formatDesignUpdatedAt(design.updatedAt)}
                    </time>
                  </span>
                </button>
              );
            })
          )}
        </nav>
      </aside> : null}
      {!historyCollapsed && !compact ? (
        <PanelResizeHandle
          label="Resize Design history"
          value={historyWidth}
          min={220}
          max={360}
          defaultValue={268}
          controls="design-history-panel"
          onChange={(width) => {
            setHistoryWidth(width);
            persistFocusedPanelWidth('design-history', width);
          }}
        />
      ) : null}

      <section className="tm-designs-main" inert={historyModalOpen ? true : undefined}>
        {showCreate ? (
          <NewDesignForm
            repositories={repositories}
            onInspectRepository={onInspectRepository}
            agentProfiles={agentProfiles}
            historyCollapsed={historyCollapsed}
            canCancel={designs.length > 0}
            models={models}
            runtimes={runtimes}
            defaultAgentSettings={defaultAgentSettings}
            onDiscoverAgentRuntimeModels={onDiscoverAgentRuntimeModels}
            onStageAttachmentBatch={onStageAttachmentBatch}
            onDiscardAttachmentDraft={onDiscardAttachmentDraft}
            onReadClipboardImage={onReadClipboardImage}
            onHistoryCollapsedChange={onHistoryCollapsedChange}
            onCancel={() => setCreatingBlank(false)}
            onCreate={async (input) => {
              await onCreateDesign(input);
              setCreatingBlank(false);
            }}
          />
        ) : error ? (
          <WorkspaceState
            title="Could not load this Design"
            detail={error}
            historyCollapsed={historyCollapsed}
            onHistoryCollapsedChange={onHistoryCollapsedChange}
            action={onRetryLoad ? { label: 'Try again', onClick: onRetryLoad } : undefined}
          />
        ) : loading ? (
          <div className="tm-designs-loading" role="status" aria-busy="true" aria-label="Loading Design">
            <header className="tm-designs-header">
              <DesignHistoryToggle collapsed={historyCollapsed} onChange={onHistoryCollapsedChange} />
            </header>
            <div className="tm-designs-loading__body">
              <div className="tm-workspace-loading">
                <StatusGlyph kind="working" />
                <span>Loading Design</span>
              </div>
            </div>
          </div>
        ) : !project ? (
          <WorkspaceState
            title="Select a Design"
            detail="Choose a Design from the list or create a blank Design."
            historyCollapsed={historyCollapsed}
            onHistoryCollapsedChange={onHistoryCollapsedChange}
          />
        ) : (
          <>
            <DesignHeader
              project={project}
              historyCollapsed={historyCollapsed}
              layout={renderedLayout}
              availableLayouts={contentLayout.availableModes}
              filesOpen={filesOpen}
              onHistoryCollapsedChange={onHistoryCollapsedChange}
              onLayoutChange={(nextLayout) => {
                setLayout(nextLayout);
                persistDesignLayout(nextLayout);
              }}
              onToggleFiles={() => setFilesOpen((open) => !open)}
              onOpenInFinder={() => {
                if (project.currentWorktree) {
                  void onOpenDesignLocation(
                    project.design.id,
                    project.currentWorktree.id
                  ).catch(() => undefined);
                }
              }}
              onDuplicate={() => {
                const revision = project.revisions.at(-1);
                if (revision) {
                  void onDuplicateDesign(project.design.id, revision.id).catch(() => undefined);
                }
              }}
              onRename={() => setRenameOpen(true)}
              onArchive={() =>
                void onArchiveDesign(project.design.id).catch(() => undefined)
              }
              onDelete={() => setDeleteOpen(true)}
            />
            <div className="tm-designs-content">
            <div
              className={`tm-designs-split tm-designs-split--${renderedLayout}`}
            >
              {renderedLayout !== 'canvas' ? (
                <div
                  className="tm-designs-split__conversation"
                  id="design-conversation-panel"
                >
                  <DesignConversation
                    key={project.design.id}
                    project={project}
                    draft={draft}
                    model={projectModel}
                    refineUnavailableReason={refineUnavailableReason}
                    selectedReferenceIds={selectedReferenceIds}
                    onSelectionChange={setSelectedReferenceIds}
                    onSubmit={(message, referenceIds, attachmentDraftId) =>
                      onSubmitRefinement(
                        project.design.id,
                        message,
                        referenceIds,
                        attachmentDraftId
                      )
                    }
                    onStageAttachmentBatch={onStageAttachmentBatch}
                    onDiscardAttachmentDraft={(draftId) =>
                      onDiscardAttachmentDraft({ draftId })
                    }
                    onReadClipboardImage={onReadClipboardImage}
                    onReadAttachment={onReadAttachment}
                    onPreviewOpenChange={setAttachmentPreviewOpen}
                    onReadDraftAttachment={(attachmentId) =>
                      onReadDesignDraftAttachment(project.design.id, attachmentId)
                    }
                    onStop={(turnId) => onStopTurn(project.design.id, turnId)}
                    onLoadEarlier={() => onLoadEarlier(project.design.id)}
                    onSaveDraft={(body, referenceIds, attachmentDraftId, expectedRevision) =>
                      onSaveDraft(
                        project.design.id,
                        body,
                        referenceIds,
                        attachmentDraftId,
                        expectedRevision
                      )
                    }
                    onDeleteDraft={(expectedRevision) =>
                      onDeleteDraft(project.design.id, expectedRevision)
                    }
                    onRespond={onRespondToInteraction}
                    onRestore={(revisionId) =>
                      onRestoreRevision(project.design.id, revisionId)
                    }
                    onDuplicate={(revisionId) =>
                      onDuplicateDesign(project.design.id, revisionId)
                    }
                    onOpenReferences={() => setFilesOpen(true)}
                  />
                </div>
              ) : null}
              {renderedLayout === 'split' ? (
                <PanelResizeHandle
                  label="Resize Design conversation"
                  value={renderedConversationWidth}
                  min={320}
                  max={maxConversationWidth}
                  defaultValue={380}
                  controls="design-conversation-panel design-canvas-panel"
                  onChange={(width) => {
                    setConversationWidth(width);
                    persistFocusedPanelWidth('design-conversation', width);
                  }}
                />
              ) : null}
              {renderedLayout !== 'chat' ? (
                <div
                  className="tm-designs-split__canvas"
                  id="design-canvas-panel"
                >
                  <DesignCanvas
                    key={project.design.id}
                    project={project}
                    setup={project.repository.kind === 'USER_REGISTERED' && project.task.workflowPhase !== 'ARCHIVED' && onUpdateProject ? (
                      <DesignRepositorySetup project={project} onUpdate={onUpdateProject}
                        onOpenLocation={() => project.currentWorktree ? onOpenDesignLocation(project.design.id, project.currentWorktree.id) : Promise.resolve()}
                        onModalOpenChange={setPreviewSetupModalOpen} />
                    ) : undefined}
                    setupRequired={Boolean(project.repositorySetup?.blocker) || (project.revisions.length === 0 && project.turns.some((turn) => !turn.runId && !turn.outcome))}
                    desktopAvailable={desktopCanvasAvailable}
                    occluded={canvasOccluded || historyModalOpen || deleteOpen || renameOpen || previewSetupModalOpen || attachmentPreviewOpen}
                    onShowCanvas={onShowCanvas}
                    onHideCanvas={onHideCanvas}
                    onRefresh={onRefreshCanvas}
                    onRestart={onRestartCanvas}
                    onRetryUpdate={retryEntry ? () => onSubmitRefinement(
                      project.design.id,
                      retryEntry.userMessage,
                      retryEntry.turn.referenceIds.filter((referenceId) =>
                        project.references.some((reference) =>
                          reference.id === referenceId && reference.state === 'ACTIVE'
                        )
                      )
                    ) : undefined}
                    onSelectRevision={(revisionId) =>
                      onSelectRevision(project.design.id, revisionId)
                    }
                    onRestore={(revisionId) =>
                      onRestoreRevision(project.design.id, revisionId)
                    }
                    onOpen={onOpenCanvas}
                  />
                </div>
              ) : null}
            </div>
            {filesOpen ? (
              <DesignFilesDrawer
                project={project}
                models={models}
                selectedReferenceIds={selectedReferenceIds}
                onSelectionChange={setSelectedReferenceIds}
                onClose={() => setFilesOpen(false)}
                onPreviewOpenChange={setAttachmentPreviewOpen}
                onStageAttachmentBatch={onStageAttachmentBatch}
                onDiscardAttachmentDraft={onDiscardAttachmentDraft}
                onReadClipboardImage={onReadClipboardImage}
                onAddReferences={async (draftId) => {
                  const referenceIds = await onAddReferences(project.design.id, draftId);
                  setSelectedReferenceIds((current) => [
                    ...current,
                    ...referenceIds.filter((referenceId) => !current.includes(referenceId))
                  ]);
                }}
                onRemoveReference={(referenceId) =>
                  onRemoveReference(project.design.id, referenceId)
                }
                onImportReferenceAsset={(referenceId) =>
                  onImportReferenceAsset(project.design.id, referenceId)
                }
              />
            ) : null}
            </div>
          </>
        )}
      </section>

      {deleteOpen && project ? (
        <DeleteDesignDialog
          designTitle={project.design.title}
          retainedWorkspace={project.repository.kind === 'USER_REGISTERED' ? project.currentWorktree?.worktreePath : undefined}
          onCancel={() => setDeleteOpen(false)}
          onDelete={async (removeWorktree) => {
            await onDeleteDesign(project.design.id, removeWorktree);
            setDeleteOpen(false);
          }}
        />
      ) : null}
      {renameOpen && project ? (
        <RenameDesignDialog
          designTitle={project.design.title}
          onCancel={() => setRenameOpen(false)}
          onRename={async (title) => {
            await onRenameDesign(project.design.id, title);
            setRenameOpen(false);
          }}
        />
      ) : null}
    </main>
  );
}

function DesignHeader({
  project,
  historyCollapsed,
  layout,
  availableLayouts,
  filesOpen,
  onHistoryCollapsedChange,
  onLayoutChange,
  onToggleFiles,
  onOpenInFinder,
  onDuplicate,
  onRename,
  onArchive,
  onDelete
}: {
  project: DesignProjectDetail;
  historyCollapsed: boolean;
  layout: DesignWorkspaceLayoutMode;
  availableLayouts: readonly DesignWorkspaceLayoutMode[];
  filesOpen: boolean;
  onHistoryCollapsedChange?(collapsed: boolean): void;
  onLayoutChange(layout: DesignWorkspaceLayoutMode): void;
  onToggleFiles(): void;
  onOpenInFinder(): void;
  onDuplicate(): void;
  onRename(): void;
  onArchive(): void;
  onDelete(): void;
}) {
  const status = designStatusView(designProjectStatus(project));
  const revision = project.revisions.at(-1)?.ordinal;
  return (
    <header className="tm-designs-header">
      <div className="tm-designs-header__leading">
        <DesignHistoryToggle
          collapsed={historyCollapsed}
          onChange={onHistoryCollapsedChange}
        />
        <div className="tm-designs-header__identity">
          <h1>{project.design.title}</h1>
          <p>
            <span className="tm-design-status" data-tone={status.tone}>
              <StatusGlyph kind={status.tone} />
              {status.label}{revision ? ` · revision ${revision}` : ''}
            </span>
          </p>
        </div>
      </div>
      <div className="tm-designs-header__actions">
        <div className="tm-design-layout" role="group" aria-label="Design layout">
          {availableLayouts.map((option) => (
            <button
              type="button"
              key={option}
              aria-pressed={layout === option}
              aria-label={layoutLabel(option)}
              title={layoutLabel(option)}
              onClick={() => onLayoutChange(option)}
            >
              <UiLayoutIcon layout={option} />
            </button>
          ))}
        </div>
        <button
          type="button"
          className="tm-designs-header__files"
          aria-expanded={filesOpen}
          aria-controls="design-files-drawer"
          onClick={onToggleFiles}
        >
          <UiFolderIcon />
          References
          <span>{project.references.filter((reference) => reference.state === 'ACTIVE').length}</span>
        </button>
        <DesignProjectMenu
          title={project.design.title}
          canOpenInFinder={project.currentWorktree?.status === 'PRESENT'}
          canDuplicate={project.actions.canDuplicate}
          canArchive={project.actions.canArchive}
          canDelete={project.actions.canDelete}
          onOpenInFinder={onOpenInFinder}
          onDuplicate={onDuplicate}
          onRename={onRename}
          onArchive={onArchive}
          onDelete={onDelete}
        />
      </div>
    </header>
  );
}

function NewDesignForm({
  repositories,
  onInspectRepository,
  agentProfiles,
  historyCollapsed,
  canCancel,
  models,
  runtimes,
  defaultAgentSettings,
  onDiscoverAgentRuntimeModels,
  onStageAttachmentBatch,
  onDiscardAttachmentDraft,
  onReadClipboardImage,
  onHistoryCollapsedChange,
  onCancel,
  onCreate
}: {
  repositories: readonly import('../../shared/contracts').Repository[];
  onInspectRepository?: DesignsWorkspaceProps['onInspectRepository'];
  agentProfiles: readonly CustomAgentProfile[];
  historyCollapsed: boolean;
  canCancel: boolean;
  models: AgentModel[];
  runtimes: AgentRuntimeState[];
  defaultAgentSettings?: AgentExecutionSettings;
  onDiscoverAgentRuntimeModels?(runtimeId: string): Promise<void>;
  onStageAttachmentBatch(input: StageTaskAttachmentBatchRequest): Promise<AttachmentDraftSnapshot>;
  onDiscardAttachmentDraft(input: DiscardTaskAttachmentDraftRequest): Promise<void>;
  onReadClipboardImage?(): Promise<ClipboardAttachmentImage | undefined>;
  onHistoryCollapsedChange?(collapsed: boolean): void;
  onCancel(): void;
  onCreate(input: CreateDesignInput): Promise<void>;
}) {
  const [brief, setBrief] = useState('');
  const [sourceKind, setSourceKind] = useState<'BLANK' | 'EXISTING_REPOSITORY'>('BLANK');
  const [repositoryId, setRepositoryId] = useState('');
  const [inspection, setInspection] = useState<import('../../shared/contracts').DesignRepositoryInspection>();
  const [baseKey, setBaseKey] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const repositoryOptions = useMemo(() => buildRepositoryOptions({
    repositories: repositories.filter((item) => item.kind === 'USER_REGISTERED' && item.status === 'AVAILABLE'),
    tasks: []
  }), [repositories]);
  const inspectionRequest = useRef(0);
  const base = inspection?.bases.find((item) => (item.refName ?? 'HEAD') === baseKey);
  const inspectRepository = async (id: string) => {
    const request = ++inspectionRequest.current;
    setRepositoryId(id);
    setInspection(undefined);
    setBaseKey('');
    setInspecting(true);
    setError(undefined);
    try {
      const next = await onInspectRepository?.(id);
      if (request !== inspectionRequest.current) return;
      setInspection(next);
      setBaseKey(next?.bases[0]?.refName ?? 'HEAD');
    } catch (caught) {
      if (request === inspectionRequest.current) setError(caught instanceof Error ? caught.message : 'Could not inspect the repository.');
    } finally {
      if (request === inspectionRequest.current) setInspecting(false);
    }
  };

  const [agentProfileId, setAgentProfileId] = useState<string>();
  const [creationToken] = useState(() => crypto.randomUUID());
  const selectableModels = supportedDesignModels(runtimes, models);
  const preferredRuntimeId = defaultAgentSettings?.runtimeId;
  const initialRuntimeId =
    (selectableModels.some((model) => model.runtimeId === preferredRuntimeId)
      ? preferredRuntimeId
      : undefined) ??
    selectableModels[0]?.runtimeId ??
    runtimes[0]?.preflight.runtime.id ??
    '';
  const initialModel = selectModel(
    selectableModels,
    defaultAgentSettings?.model,
    initialRuntimeId,
    defaultAgentSettings?.modelProvider
  );
  const [runtimeId, setRuntimeId] = useState(initialRuntimeId);
  const [modelId, setModelId] = useState(initialModel?.id ?? '');
  const [reasoningEffort, setReasoningEffort] = useState<string | undefined>(() =>
    initialModel
      ? resolveReasoningEffort(
          initialModel,
          initialModel.designSupport?.defaultReasoningEffort ??
            defaultAgentSettings?.reasoningEffort
        )
      : undefined
  );
  const [submitting, setSubmitting] = useState(false);
  const [creationOutcomeUnknown, setCreationOutcomeUnknown] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const submittingRef = useRef(false);
  const availableRuntimeIds = new Set(
    runtimes.map((runtime) => runtime.preflight.runtime.id)
  );
  const selectedRuntimeId = availableRuntimeIds.has(runtimeId)
    ? runtimeId
    : defaultAgentSettings?.runtimeId &&
        availableRuntimeIds.has(defaultAgentSettings.runtimeId)
      ? defaultAgentSettings.runtimeId
      : runtimes[0]?.preflight.runtime.id ?? '';
  const selectedModel =
    selectableModels.find(
      (model) => model.id === modelId && model.runtimeId === selectedRuntimeId
    ) ?? selectModel(
      selectableModels,
      defaultAgentSettings?.model,
      selectedRuntimeId,
      defaultAgentSettings?.modelProvider
    );
  const selectedModelId = selectedModel?.id ?? '';
  const selectedReasoningEffort =
    resolveReasoningEffort(
      selectedModel,
      reasoningEffort ??
        selectedModel?.designSupport?.defaultReasoningEffort ??
        defaultAgentSettings?.reasoningEffort
    ) ?? '';
  const selectedRuntime = runtimes.find(
    (runtime) => runtime.preflight.runtime.id === selectedRuntimeId
  );
  const selectedRuntimeUnavailableReason = selectedRuntime
    ? designRuntimeUnavailableReason(selectedRuntime, models)
    : undefined;
  const attachmentsEnabled = Boolean(
    selectedRuntime &&
      selectedRuntime.preflight.capabilities.attachmentDelivery.maturity !== 'unsupported'
  );
  const composerLocked = submitting || creationOutcomeUnknown;
  const attachments = useTaskAttachments({
    enabled: attachmentsEnabled,
    blocked: composerLocked,
    model: selectedModel,
    onStageBatch: onStageAttachmentBatch,
    onDiscard: (draftId) => onDiscardAttachmentDraft({ draftId }),
    onReadClipboardImage
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const nextBrief = brief.trim();
    if (
      !nextBrief ||
      (sourceKind === 'EXISTING_REPOSITORY' && (!base || inspecting)) ||
      !selectedRuntimeId ||
      !selectedModel ||
      selectedRuntimeUnavailableReason ||
      submittingRef.current
    ) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(undefined);
    let unchangedRetry = false;
    try {
      const attachmentDraftId = await attachments.prepareForCreate();
      try {
        await onCreate({
          brief: nextBrief,
          ...(sourceKind === 'EXISTING_REPOSITORY' && base ? { source: { kind: sourceKind, repositoryId, baseRef: base.refName, expectedBaseSha: base.sha } } : {}),
          ...(agentProfileId ? { agentProfileId } : {}),
          creationToken,
          runtimeId: selectedRuntimeId,
          model: selectedModel.model,
          ...(selectedModel.modelProvider
            ? { modelProvider: selectedModel.modelProvider }
            : {}),
          reasoningEffort: selectedReasoningEffort || undefined,
          ...(attachmentDraftId ? { attachmentDraftId } : {})
        });
      } catch (caught) {
        unchangedRetry = creationRequiresUnchangedRetry(caught);
        await attachments.markCreateFailed(unchangedRetry);
        if (unchangedRetry) setCreationOutcomeUnknown(true);
        throw caught;
      }
      await attachments.finishAdoption();
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : 'Could not create the Design.';
      setError(
        unchangedRetry
          ? `Design creation could not be confirmed. Retry unchanged to recover safely${
              canCancel ? ', or close and check the Design list' : ''
            }. ${detail}`
          : detail
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div className="tm-design-create">
      <form
        className="tm-design-create__form"
        onSubmit={(event) => void submit(event)}
      >
        <header className="tm-design-create__intro">
          <div className="tm-design-create__intro-leading">
            <DesignHistoryToggle
              collapsed={historyCollapsed}
              onChange={onHistoryCollapsedChange}
            />
            <h1>New Design</h1>
          </div>
          {canCancel ? (
            <button
              type="button"
              className="tm-iconbtn"
              aria-label="Close new Design"
              title="Close new Design"
              disabled={submitting}
              onClick={onCancel}
            >
              <UiCloseIcon />
            </button>
          ) : null}
        </header>

        <div className="tm-design-create__body">
          <div className="tm-design-create__content">
            <div className="field">
              <span>Source</span>
              <div className="segmented" role="group" aria-label="Design source" onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                const next = event.currentTarget.querySelector<HTMLButtonElement>('button[aria-pressed="false"]:not(:disabled)');
                next?.focus();
                next?.click();
              }}>
                {(['BLANK', 'EXISTING_REPOSITORY'] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className="segmented__btn"
                    aria-pressed={sourceKind === kind}
                    disabled={composerLocked}
                    onClick={() => setSourceKind(kind)}
                  >
                    {kind === 'BLANK' ? 'Blank' : 'Existing repository'}
                  </button>
                ))}
              </div>
            </div>
            {sourceKind === 'EXISTING_REPOSITORY' ? (
              <>
                <div className="field">
                  <span>Repository</span>
                  <RepositorySelect
                    options={repositoryOptions}
                    selectedId={repositoryId}
                    disabled={composerLocked}
                    ariaLabel="Design repository"
                    onChange={(id) => void inspectRepository(id)}
                  />
                </div>
                <div className="field">
                  <label className="field__label" htmlFor="design-base">Base branch</label>
                  <select id="design-base" aria-describedby="design-base-help" value={baseKey} disabled={composerLocked || inspecting || !inspection} onChange={(event) => setBaseKey(event.target.value)}>
                    {inspecting ? <option value="">Loading branches…</option> : null}
                    {!inspection && !inspecting ? <option value="">Select a repository first</option> : null}
                    {inspection?.bases.map((item) => <option key={item.refName ?? 'HEAD'} value={item.refName ?? 'HEAD'}>{item.refName?.replace('refs/heads/', '') ?? 'Detached HEAD'} · {item.sha.slice(0, 8)}</option>)}
                  </select>
                  <small id="design-base-help">Creates a separate worktree. Uncommitted changes are not included.</small>
                </div>
              </>
            ) : null}

            <div className="field field--prompt">
              <label className="field__label" htmlFor="new-design-brief">Brief</label>
              <AttachmentComposerShell
                attachments={attachments}
                className="tm-design-create__composer"
                attachmentLabel="Design references"
                toolbarAction={
                  <AgentProfileSelect
                    profiles={agentProfiles}
                    value={agentProfileId}
                    disabled={composerLocked}
                    onChange={setAgentProfileId}
                  />
                }
                removeDisabled={composerLocked}
                addButtonTitle={
                  attachmentsEnabled
                    ? 'Stored locally and shared read-only with the Design agent.'
                    : 'The selected agent runtime does not support references.'
                }
                hint={
                  !attachmentsEnabled
                    ? 'Unavailable for this runtime'
                    : attachments.isReadingClipboardImage
                      ? 'Reading clipboard image…'
                      : attachments.activeItems.length > 0
                        ? `${attachments.activeItems.length} ${
                            attachments.activeItems.length === 1 ? 'file' : 'files'
                          } · ${formatAttachmentBytes(attachments.byteCount)}`
                        : 'Paste or drop files'
                }
              >
                <textarea
                  id="new-design-brief"
                  value={brief}
                  rows={7}
                  placeholder="Describe what you want to design or change…"
                  disabled={composerLocked}
                  onChange={(event) => setBrief(event.target.value)}
                  onPaste={attachments.paste}
                />
              </AttachmentComposerShell>
            </div>

            {attachments.overflowError || attachments.modelError ? (
              <p className="task-attachment-message task-attachment-message--error" role="alert">
                {attachments.overflowError ?? attachments.modelError}
              </p>
            ) : null}

            <div className="tm-design-create__runtime" aria-label="Design agent settings">
              <AgentModelSelector
                label="Design"
                runtimeId={selectedRuntimeId}
                modelId={selectedModelId}
                reasoningEffort={selectedReasoningEffort}
                models={models}
                runtimes={runtimes}
                disabled={composerLocked}
                presentation="compact"
                selectionUnavailable={
                  !selectedRuntimeId ||
                  !selectedModelId ||
                  Boolean(selectedRuntimeUnavailableReason)
                }
                selectionUnavailableMessage={
                  selectedRuntimeUnavailableReason ??
                  'No ready agent supports Design Mode.'
                }
                runtimeUnavailableReason={(runtime) =>
                  designRuntimeUnavailableReason(runtime, models)
                }
                modelUnavailableReason={(model, runtime) =>
                  designModelUnavailableReason(runtime, model)
                }
                onDiscoverModels={onDiscoverAgentRuntimeModels}
                onSelectionChange={(nextRuntimeId, nextModelId) => {
                  setRuntimeId(nextRuntimeId);
                  setModelId(nextModelId);
                  const nextModel = selectableModels.find(
                    (model) =>
                      model.runtimeId === nextRuntimeId && model.id === nextModelId
                  );
                  setReasoningEffort(
                    nextModel?.designSupport?.defaultReasoningEffort ??
                      nextModel?.defaultReasoningEffort ??
                      ''
                  );
                }}
                onReasoningEffortChange={setReasoningEffort}
              />
            </div>

            {error ? <p className="tm-design-create__error" role="alert">{error}</p> : null}
          </div>
        </div>
        <footer className="tm-design-create__actions">
          {canCancel ? (
            <button type="button" className="outline-button" disabled={submitting} onClick={onCancel}>
              {creationOutcomeUnknown ? 'Close' : 'Cancel'}
            </button>
          ) : null}
          <button
            type="submit"
            className="primary-button"
            disabled={
              submitting ||
              brief.trim().length === 0 ||
              (sourceKind === 'EXISTING_REPOSITORY' && (!base || inspecting)) ||
              !selectedRuntimeId ||
              !selectedModelId ||
              Boolean(selectedRuntimeUnavailableReason) ||
              attachments.busy ||
              attachments.hasErrors ||
              Boolean(attachments.modelError)
            }
          >
            {submitting
              ? 'Creating…'
              : creationOutcomeUnknown
                ? 'Retry creation'
                : 'Create Design'}
          </button>
        </footer>
      </form>
    </div>
  );
}

function RenameDesignDialog({
  designTitle,
  onCancel,
  onRename
}: {
  designTitle: string;
  onCancel(): void;
  onRename(title: string): Promise<void>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(designTitle);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  useDialogFocusBoundary({
    dialogRef,
    initialFocusRef: inputRef,
    busy: saving,
    onClose: onCancel
  });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      await onRename(title);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not rename the Design.');
      setSaving(false);
    }
  };
  return (
    <div
      ref={dialogRef}
      className="tm-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rename-design-title"
      tabIndex={-1}
    >
      <button
        type="button"
        className="tm-modal__scrim"
        aria-label="Cancel Design rename"
        disabled={saving}
        onClick={onCancel}
      />
      <form className="tm-modal__panel tm-design-delete tm-design-rename" onSubmit={(event) => void submit(event)}>
        <h3 id="rename-design-title">Rename Design</h3>
        <label className="tm-modal__field" htmlFor="rename-design-input">
          <span>Name</span>
          <input
            ref={inputRef}
            id="rename-design-input"
            value={title}
            maxLength={120}
            disabled={saving}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        {error ? <p className="tm-design-delete__error" role="alert">{error}</p> : null}
        <div className="tm-modal__actions">
          <button type="button" className="outline-button" disabled={saving} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={saving || !title.trim()}>
            {saving ? 'Saving…' : 'Rename'}
          </button>
        </div>
      </form>
    </div>
  );
}

function DeleteDesignDialog({
  designTitle,
  retainedWorkspace,
  onCancel,
  onDelete
}: {
  designTitle: string;
  retainedWorkspace?: string;
  onCancel(): void;
  onDelete(removeWorktree: boolean): Promise<void>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const deletingRef = useRef(false);
  const [deleting, setDeleting] = useState(false);
  const [removeWorktree, setRemoveWorktree] = useState(!retainedWorkspace);
  const [error, setError] = useState<string | undefined>();
  useDialogFocusBoundary({
    dialogRef,
    initialFocusRef: cancelRef,
    busy: deleting,
    onClose: onCancel
  });

  const remove = async () => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    setError(undefined);
    try {
      await onDelete(removeWorktree);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not delete the Design.');
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  };

  return (
    <div
      ref={dialogRef}
      className="tm-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-design-title"
      tabIndex={-1}
    >
      <button
        type="button"
        className="tm-modal__scrim"
        aria-label="Cancel Design deletion"
        disabled={deleting}
        onClick={onCancel}
      />
      <div className="tm-modal__panel tm-design-delete">
        <h3 id="delete-design-title">Delete “{designTitle}”?</h3>
        {retainedWorkspace ? <>
          <p>The repository and Design branch are kept. The workspace stays at <code>{retainedWorkspace}</code>.</p>
          <label><input type="checkbox" checked={removeWorktree} disabled={deleting} onChange={(event) => setRemoveWorktree(event.target.checked)} /> Also remove the workspace if it has no unsaved, untracked, or ignored files.</label>
        </> : <p>Task Monki removes the Design. It removes the managed workspace when that action is safe.</p>}
        {error ? <p className="tm-design-delete__error" role="alert">{error}</p> : null}
        <div className="tm-modal__actions">
          <button
            ref={cancelRef}
            type="button"
            className="outline-button"
            disabled={deleting}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button type="button" className="danger-button" disabled={deleting} onClick={() => void remove()}>
            {deleting ? 'Deleting…' : 'Delete Design'}
          </button>
        </div>
      </div>
    </div>
  );
}

function WorkspaceState({
  title,
  detail,
  action,
  historyCollapsed,
  onHistoryCollapsedChange
}: {
  title: string;
  detail: string;
  action?: { label: string; onClick(): void };
  historyCollapsed: boolean;
  onHistoryCollapsedChange?(collapsed: boolean): void;
}) {
  return (
    <div className="tm-designs-state">
      <div className="tm-designs-state__title">
        <DesignHistoryToggle
          collapsed={historyCollapsed}
          onChange={onHistoryCollapsedChange}
        />
        <strong>{title}</strong>
      </div>
      <p>{detail}</p>
      {action ? (
        <button type="button" className="outline-button" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

function DesignHistoryToggle({
  collapsed,
  onChange
}: {
  collapsed: boolean;
  onChange?(collapsed: boolean): void;
}) {
  const label = collapsed ? 'Show Design history' : 'Hide Design history';
  return (
    <button
      type="button"
      className="tm-iconbtn tm-mode-history-toggle"
      aria-label={label}
      aria-expanded={!collapsed}
      aria-controls="design-history-panel"
      title={label}
      onClick={() => onChange?.(!collapsed)}
    >
      <PanelIcon />
    </button>
  );
}

function layoutLabel(layout: DesignWorkspaceLayoutMode): string {
  if (layout === 'chat') return 'Conversation only';
  if (layout === 'canvas') return 'Canvas only';
  return 'Split view';
}
