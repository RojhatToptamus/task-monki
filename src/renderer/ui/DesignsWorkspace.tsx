import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent
} from 'react';
import type {
  AgentInteractionDecision,
  AgentExecutionSettings,
  AgentModel,
  AgentRuntimeState,
  CreateBlankDesignRequest,
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
import { DesignConversation } from './DesignConversation';
import { DesignFilesDrawer } from './DesignFilesDrawer';
import { AttachmentComposerShell } from './AttachmentComposerShell';
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

export type CreateBlankDesignInput = Pick<
  CreateBlankDesignRequest,
  | 'brief'
  | 'creationToken'
  | 'runtimeId'
  | 'model'
  | 'modelProvider'
  | 'reasoningEffort'
  | 'attachmentDraftId'
>;

export interface DesignsWorkspaceProps {
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
  onCreateBlankDesign(input: CreateBlankDesignInput): Promise<void>;
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
  onDeleteDesign(designId: string): Promise<void>;
  onShowCanvas?(request: DesignCanvasShowRequest): void;
  onHideCanvas?(request: DesignCanvasHideRequest): void;
  onRetryLoad?(): void;
}

export function DesignsWorkspace({
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
  onCreateBlankDesign,
  onSubmitRefinement,
  onStageAttachmentBatch,
  onDiscardAttachmentDraft,
  onReadClipboardImage,
  onReadDesignDraftAttachment,
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
  const [selectedReferenceIds, setSelectedReferenceIds] = useState<string[]>([]);
  const referenceDesignId = useRef<string | undefined>(undefined);
  const restoredDraftRevision = useRef<number | undefined>(undefined);
  const projectModelDiscoveryRef = useRef<string | undefined>(undefined);
  const visibleDesigns = visibleDesignProjects(designs, historyQuery, historyFilter);
  const activeDesignId = project?.design.id ?? selectedDesignId;
  const layoutView = designWorkspaceLayout(workspaceWidth, historyCollapsed, historyWidth);
  const renderedLayout = layoutView.availableModes.includes(layout) ? layout : 'chat';
  const compact = workspaceWidth > 0 && !layoutView.splitAvailable;
  const maxConversationWidth = Math.max(320, layoutView.mainWidth - 485);
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

  useEffect(() => {
    if (!project) {
      setSelectedReferenceIds([]);
      referenceDesignId.current = undefined;
      restoredDraftRevision.current = undefined;
      return;
    }
    const activeSet = new Set(project.references
      .filter((reference) => reference.state === 'ACTIVE')
      .map((reference) => reference.id));
    if (referenceDesignId.current !== project.design.id) {
      referenceDesignId.current = project.design.id;
      restoredDraftRevision.current = draft?.recordRevision;
      setSelectedReferenceIds(
        (draft?.referenceIds ?? []).filter((referenceId) => activeSet.has(referenceId))
      );
      setFilesOpen(false);
      return;
    }
    if (draft && restoredDraftRevision.current !== draft.recordRevision) {
      restoredDraftRevision.current = draft.recordRevision;
      setSelectedReferenceIds(
        draft.referenceIds.filter((referenceId) => activeSet.has(referenceId))
      );
      return;
    }
    setSelectedReferenceIds((current) =>
      current.filter((referenceId) => activeSet.has(referenceId))
    );
  }, [draft, project?.design.id, project?.references]);

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
  }, [historyWidth, renderedConversationWidth]);

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
          <BlankDesignForm
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
              await onCreateBlankDesign(input);
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
        ) : loading || !project ? (
          <WorkspaceState
            title={loading ? 'Loading Design' : 'Select a Design'}
            detail={
              loading
                ? 'Task Monki is loading the conversation and canvas.'
                : 'Choose a Design from the list or create a blank Design.'
            }
            busy={loading}
            historyCollapsed={historyCollapsed}
            onHistoryCollapsedChange={onHistoryCollapsedChange}
          />
        ) : (
          <>
            <DesignHeader
              project={project}
              historyCollapsed={historyCollapsed}
              layout={renderedLayout}
              availableLayouts={layoutView.availableModes}
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
                    project={project}
                    desktopAvailable={desktopCanvasAvailable}
                    occluded={canvasOccluded || deleteOpen || renameOpen || filesOpen}
                    onShowCanvas={onShowCanvas}
                    onHideCanvas={onHideCanvas}
                    onRefresh={onRefreshCanvas}
                    onRestart={onRestartCanvas}
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
          </>
        )}
      </section>

      {deleteOpen && project ? (
        <DeleteDesignDialog
          designTitle={project.design.title}
          onCancel={() => setDeleteOpen(false)}
          onDelete={async () => {
            await onDeleteDesign(project.design.id);
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

function BlankDesignForm({
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
  onCreate(input: CreateBlankDesignInput): Promise<void>;
}) {
  const [brief, setBrief] = useState('');
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
            <div>
              <h1>New Design</h1>
              <p>Describe the page or interface the agent should build.</p>
            </div>
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
            <div className="tm-design-create__label-row">
              <label htmlFor="new-design-brief">Brief</label>
              <span>Reference images help most</span>
            </div>
            <AttachmentComposerShell
              attachments={attachments}
              className="tm-design-create__composer"
              attachmentLabel="Design references"
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
                placeholder="A focused landing page for…"
                disabled={composerLocked}
                onChange={(event) => setBrief(event.target.value)}
                onPaste={attachments.paste}
              />
            </AttachmentComposerShell>

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
  onCancel,
  onDelete
}: {
  designTitle: string;
  onCancel(): void;
  onDelete(): Promise<void>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const deletingRef = useRef(false);
  const [deleting, setDeleting] = useState(false);
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
      await onDelete();
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
        <p>Task Monki removes the Design. It removes the managed workspace when that action is safe.</p>
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
  busy = false,
  action,
  historyCollapsed,
  onHistoryCollapsedChange
}: {
  title: string;
  detail: string;
  busy?: boolean;
  action?: { label: string; onClick(): void };
  historyCollapsed: boolean;
  onHistoryCollapsedChange?(collapsed: boolean): void;
}) {
  return (
    <div className="tm-designs-state" role={busy ? 'status' : undefined}>
      {busy ? <StatusGlyph kind="working" /> : null}
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
