import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import type {
  ConversationContextReferenceSnapshot,
  DiscourseConversationAggregateRecord,
  DiscourseConversationSummary,
  DiscourseContextPreview,
  DiscourseDraftRecord,
  DiscourseDefaultPolicy,
  DiscourseAgentSelectionInput,
  BuiltInAgentProfileId,
  DiscourseMessageRecord,
  DiscourseMentionCatalogSnapshot
} from '../../shared/discourse';
import { taskManagerApi } from '../api/taskManagerClient';
import { listDiscourseConversationSnapshot } from '../api/discoursePaging';
import {
  composerTokensFromDraft,
  canDeleteAbandonedDiscourseShell,
  currentDiscourseParticipantRevisions,
  currentPinnedContext,
  defaultDiscourseResponderRoster,
  defaultDiscourseAgentSelection,
  discourseClientMessageWasPersisted,
  discourseDraftsAlreadySent,
  discourseAcceptedSendForClientMessage,
  discourseMentionCandidates,
  discourseResponsePolicyLabel,
  discourseResponseReadiness,
  draftTokensFromComposer,
  discourseAgentSelectionFromCurrentRevision,
  discoursePendingSendFingerprint,
  eligibleDiscourseRuntimeCatalog,
  findReplyTarget,
  interruptedDiscourseAcceptedSends,
  isNearScrollBottom,
  messageAuthorLabel,
  messageContext,
  recoverPendingDiscourseCreateForReplacement,
  shouldShowNewResponses,
  visibleDiscourseResponseWavePlacements,
  visibleConversationSummaries
} from '../model/discourse';
import type { DiscourseComposerMentionState } from '../model/discourseMentions';
import { createDiscourseComposerMentionState } from '../model/discourseMentions';
import { DiscourseDraftAutosaveCoordinator } from '../model/discourseDraftAutosave';
import { DiscourseActionMenu } from './DiscourseActionMenu';
import { DiscourseAgentConfigurationBar } from './DiscourseAgentConfigurationBar';
import { DiscourseConversationRail } from './DiscourseConversationRail';
import { DiscourseMessage } from './DiscourseMessage';
import { DiscourseMentionInput } from './DiscourseMentionInput';
import { DiscourseResponseGroup } from './DiscourseResponseGroup';
import {
  DiscoursePinIcon as PinIcon,
  DiscourseRepositoryIcon as RepositoryIcon,
  DiscourseTaskIcon as TaskIcon
} from './DiscourseIcons';
import {
  ConfirmDialog,
  ContextPreview,
  InspectorDrawer,
  InspectorSection
} from './DiscourseOverlays';
import { useDialogFocusBoundary } from './dialogFocus';

interface DiscourseWorkspaceProps {
  onNotify(message: string, tone?: 'info' | 'success' | 'error'): void;
  onError(error: unknown, fallback: string): void;
}

type ConfirmAction =
  | { type: 'delete-conversation' }
  | { type: 'delete-message'; message: DiscourseMessageRecord }
  | undefined;

interface DraftPersistenceInput {
  scope: ReturnType<DiscourseDraftAutosaveCoordinator['currentScope']>;
  conversationId?: string;
  snapshot: DiscourseComposerMentionState;
  policy: DiscourseDefaultPolicy;
  selections: DiscourseAgentSelectionInput[];
  replyToMessageId?: string;
  supersedesMessageId?: string;
  sourceMessageIds?: string[];
  pendingClientMessageId?: string;
  required?: boolean;
  quiet?: boolean;
}

interface PendingNewConversation {
  conversationId?: string;
  createFingerprint: string;
  clientOperationId: string;
  supersededConversationIds?: string[];
  createRequest: {
    title: string;
    defaultPolicy: DiscourseDefaultPolicy;
    agents: DiscourseAgentSelectionInput[];
  };
}

export function DiscourseWorkspace({ onNotify, onError }: DiscourseWorkspaceProps) {
  const [conversations, setConversations] = useState<DiscourseConversationSummary[]>([]);
  const [aggregate, setAggregate] = useState<DiscourseConversationAggregateRecord>();
  const [messages, setMessages] = useState<DiscourseMessageRecord[]>([]);
  const [previousCursor, setPreviousCursor] = useState<string>();
  const [catalog, setCatalog] = useState<DiscourseMentionCatalogSnapshot>();
  const [drafts, setDrafts] = useState<DiscourseDraftRecord[]>([]);
  const [durablySentDraftIds, setDurablySentDraftIds] = useState<Set<string>>(
    () => new Set()
  );
  const [selectedConversationId, setSelectedConversationId] = useState<string>();
  const [newConversation, setNewConversation] = useState(false);
  const [railQuery, setRailQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [workspaceLoadFailed, setWorkspaceLoadFailed] = useState(false);
  const [conversationLoadState, setConversationLoadState] = useState<
    { status: 'idle' | 'loading' | 'ready' | 'error'; detail?: string }
  >({ status: 'idle' });
  const [sending, setSending] = useState(false);
  const [composerVersion, setComposerVersion] = useState(0);
  const [composer, setComposer] = useState<DiscourseComposerMentionState>(() =>
    createDiscourseComposerMentionState()
  );
  const [agentSelectionOverrides, setAgentSelectionOverrides] = useState<
    Partial<Record<BuiltInAgentProfileId, DiscourseAgentSelectionInput>>
  >({});
  const [responsePolicy, setResponsePolicy] = useState<DiscourseDefaultPolicy>('NONE');
  const [replyTargetId, setReplyTargetId] = useState<string>();
  const [correctionTargetId, setCorrectionTargetId] = useState<string>();
  const [selectedSourceMessageIds, setSelectedSourceMessageIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<DiscourseContextPreview>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const [acceptedSendActionId, setAcceptedSendActionId] = useState<string>();
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [compactLayout, setCompactLayout] = useState(
    () => window.matchMedia('(max-width: 760px)').matches
  );
  const [agentConfigOpen, setAgentConfigOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>();
  const [newResponses, setNewResponses] = useState(false);
  const [streamDrafts, setStreamDrafts] = useState<Record<string, string>>({});
  const transcriptRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const railSearchRef = useRef<HTMLInputElement>(null);
  const railReturnFocusRef = useRef<HTMLButtonElement>(null);
  const messagesRef = useRef<DiscourseMessageRecord[]>([]);
  const draftsRef = useRef<DiscourseDraftRecord[]>([]);
  const draftAutosaveRef = useRef<DiscourseDraftAutosaveCoordinator | undefined>(undefined);
  draftAutosaveRef.current ??= new DiscourseDraftAutosaveCoordinator();
  const draftAutosave = draftAutosaveRef.current;
  const conversationLoadGeneration = useRef(0);
  const blockingConversationLoadRef = useRef(false);
  const workspaceLoadGeneration = useRef(0);
  const navigationGenerationRef = useRef(0);
  const selectedConversationIdRef = useRef<string | undefined>(undefined);
  const pendingNewConversationRef = useRef<PendingNewConversation | undefined>(undefined);
  const supersededConversationCleanupIdsRef = useRef<string[]>([]);
  const pendingConversationCleanupRef = useRef<Promise<void>>(Promise.resolve());
  const pendingSendIdentityRef = useRef<{
    fingerprint: string;
    clientMessageId: string;
  } | undefined>(undefined);
  const draftSaveTimerRef = useRef<number | undefined>(undefined);
  const latestDraftPersistenceRef = useRef<DraftPersistenceInput | undefined>(undefined);
  const persistDraftRef = useRef<
    ((input: DraftPersistenceInput) => Promise<void>) | undefined
  >(undefined);
  const eventRefreshTimerRef = useRef<number | undefined>(undefined);
  const eventRefreshConversationIdsRef = useRef(new Set<string>());

  const railModalOpen = railOpen && compactLayout;

  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const update = () => setCompactLayout(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (!compactLayout) setRailOpen(false);
  }, [compactLayout]);

  useDialogFocusBoundary({
    dialogRef: railRef,
    initialFocusRef: railSearchRef,
    fallbackReturnFocusRef: railReturnFocusRef,
    busy: false,
    onClose: () => setRailOpen(false),
    active: railModalOpen
  });

  const reportDiscourseError = useCallback((error: unknown, safeMessage: string) => {
    console.error(safeMessage, error);
    onError(undefined, safeMessage);
  }, [onError]);

  const refreshSummaries = useCallback(async () => {
    const next = await listDiscourseConversationSnapshot(taskManagerApi);
    setConversations(next);
    return next;
  }, []);

  const refreshDrafts = useCallback(async () => {
    const next = await taskManagerApi.listDiscourseDrafts();
    draftsRef.current = next;
    setDrafts(next);
    return next;
  }, []);

  const loadConversation = useCallback(async (
    conversationId: string,
    preserveScroll = false,
    mode: 'blocking' | 'background' = 'blocking'
  ) => {
    const loadGeneration = ++conversationLoadGeneration.current;
    if (mode === 'blocking') {
      blockingConversationLoadRef.current = true;
      setConversationLoadState({ status: 'loading' });
    }
    const container = transcriptRef.current;
    const wasNearBottom = container
      ? isNearScrollBottom(container)
      : true;
    const previousLatestOrdinal = messagesRef.current.at(-1)?.ordinal ?? 0;
    try {
      const [nextAggregate, page] = await Promise.all([
        taskManagerApi.getDiscourseConversation(conversationId),
        taskManagerApi.listDiscourseMessages({ conversationId, limit: 100 })
      ]);
      const conversationDrafts = draftsRef.current.filter(
        (draft) =>
          draft.conversationId === conversationId &&
          draft.pendingClientMessageId !== undefined
      );
      const lookupClientIds = new Set(
        conversationDrafts.flatMap((draft) =>
          draft.pendingClientMessageId ? [draft.pendingClientMessageId] : []
        )
      );
      const pendingClientMessageId = pendingSendIdentityRef.current?.clientMessageId;
      if (
        pendingClientMessageId &&
        !discourseClientMessageWasPersisted(nextAggregate, page.messages, pendingClientMessageId)
      ) {
        lookupClientIds.add(pendingClientMessageId);
      }
      const durableClientMessageIds = new Set(
        (await Promise.all(
          [...lookupClientIds].map((clientMessageId) =>
            taskManagerApi.getDiscourseMessageByClientId({
              conversationId,
              clientMessageId
            })
          )
        )).flatMap((message) => message?.clientMessageId ? [message.clientMessageId] : [])
      );
      if (loadGeneration !== conversationLoadGeneration.current) return;
      setDurablySentDraftIds((current) => {
        const next = new Set(current);
        for (const draft of conversationDrafts) next.delete(draft.id);
        for (const draft of conversationDrafts) {
          if (
            draft.pendingClientMessageId &&
            durableClientMessageIds.has(draft.pendingClientMessageId)
          ) {
            next.add(draft.id);
          }
        }
        return next;
      });
      setAggregate(nextAggregate);
      if (
        pendingNewConversationRef.current?.conversationId === conversationId &&
        nextAggregate.conversation.latestOrdinal > 0
      ) {
        pendingNewConversationRef.current = undefined;
      }
      if (
        pendingClientMessageId &&
        (
          discourseClientMessageWasPersisted(
            nextAggregate,
            page.messages,
            pendingClientMessageId
          ) || durableClientMessageIds.has(pendingClientMessageId)
        ) &&
        pendingSendIdentityRef.current?.clientMessageId === pendingClientMessageId
      ) {
        pendingSendIdentityRef.current = undefined;
      }
      setConversationLoadState({ status: 'ready' });
      const activeJobIds = new Set(
        nextAggregate.jobs
          .filter((job) => !['COMPLETED', 'FAILED', 'CANCELED', 'CONTEXT_STALE'].includes(job.status))
          .map((job) => job.id)
      );
      setStreamDrafts((current) => Object.fromEntries(
        Object.entries(current).filter(([jobId]) => activeJobIds.has(jobId))
      ));
      setMessages(page.messages);
      messagesRef.current = page.messages;
      setPreviousCursor(page.previousCursor);
      setNewResponses(
        shouldShowNewResponses({
          wasNearBottom,
          previousLatestOrdinal,
          nextLatestOrdinal: page.messages.at(-1)?.ordinal ?? 0
        })
      );
      if (
        nextAggregate.conversation.readOrdinal < nextAggregate.conversation.latestOrdinal
      ) {
        // Read acknowledgement is auxiliary. Fast provider updates can advance
        // the conversation revision between this snapshot and the mutation;
        // the next guarded load will reconcile it without replacing newer UI
        // state or surfacing a false conversation-load error.
        const read = await taskManagerApi.setDiscourseConversationRead({
          conversationId,
          readOrdinal: nextAggregate.conversation.latestOrdinal,
          expectedRevision: nextAggregate.conversation.recordRevision,
          clientOperationId: crypto.randomUUID()
        }).catch(() => undefined);
        if (read && loadGeneration === conversationLoadGeneration.current) {
          setAggregate((current) => current ? { ...current, conversation: read } : current);
        }
      }
      if (loadGeneration !== conversationLoadGeneration.current) return;
      if (!preserveScroll && wasNearBottom) {
        requestAnimationFrame(() => scrollTranscriptToBottom(transcriptRef.current));
      }
    } catch (error) {
      if (loadGeneration === conversationLoadGeneration.current && mode === 'blocking') {
        setConversationLoadState({
          status: 'error',
          detail: 'The latest conversation state could not be loaded.'
        });
      }
      throw error;
    } finally {
      if (loadGeneration === conversationLoadGeneration.current && mode === 'blocking') {
        blockingConversationLoadRef.current = false;
      }
    }
  }, []);

  const loadWorkspace = useCallback(async () => {
    const generation = ++workspaceLoadGeneration.current;
    setLoading(true);
    setWorkspaceLoadFailed(false);
    try {
      const [summaries, nextCatalog] = await Promise.all([
        refreshSummaries(),
        taskManagerApi.getDiscourseMentionCatalog(),
        refreshDrafts()
      ]);
      if (generation !== workspaceLoadGeneration.current) return;
      setCatalog(nextCatalog);
      if (summaries.length > 0) {
        const first = summaries.find((conversation) => conversation.status === 'OPEN') ?? summaries[0];
        selectedConversationIdRef.current = first?.id;
        setSelectedConversationId(first?.id);
        setNewConversation(false);
      } else {
        selectedConversationIdRef.current = undefined;
        setSelectedConversationId(undefined);
        setNewConversation(true);
      }
    } catch (error) {
      if (generation === workspaceLoadGeneration.current) {
        setWorkspaceLoadFailed(true);
        reportDiscourseError(error, 'Could not load Discourse.');
      }
    } finally {
      if (generation === workspaceLoadGeneration.current) setLoading(false);
    }
  }, [refreshDrafts, refreshSummaries, reportDiscourseError]);

  useEffect(() => {
    void loadWorkspace();
    return () => {
      workspaceLoadGeneration.current += 1;
    };
  }, [loadWorkspace]);

  useEffect(() => {
    if (!selectedConversationId) {
      conversationLoadGeneration.current += 1;
      setAggregate(undefined);
      setMessages([]);
      messagesRef.current = [];
      setPreviousCursor(undefined);
      setSelectedSourceMessageIds([]);
      setConversationLoadState({ status: 'idle' });
      return;
    }
    void loadConversation(selectedConversationId).catch((error) =>
      reportDiscourseError(error, 'Could not load the conversation.')
    );
    return () => {
      conversationLoadGeneration.current += 1;
    };
  }, [loadConversation, reportDiscourseError, selectedConversationId]);

  useEffect(() => {
    const unsubscribe = taskManagerApi.onUpdate((event) => {
      if (event.type === 'runtime.updated') {
        void taskManagerApi.getDiscourseMentionCatalog()
          .then(setCatalog)
          .catch((error) => reportDiscourseError(
            error,
            'Could not refresh agent availability.'
          ));
        return;
      }
      if (event.scope.kind !== 'DISCOURSE') return;
      if (event.type === 'discourse.delta') {
        const payload = event.payload as {
          jobId?: string;
          publication?: { kind?: string; text?: string };
        };
        if (payload.jobId && typeof payload.publication?.text === 'string') {
          setStreamDrafts((current) => ({
            ...current,
            [payload.jobId!]: payload.publication!.kind === 'SNAPSHOT'
              ? payload.publication!.text!
              : `${current[payload.jobId!] ?? ''}${payload.publication!.text!}`
          }));
        }
        return;
      }
      if (event.scope.conversationId) {
        eventRefreshConversationIdsRef.current.add(event.scope.conversationId);
      }
      if (eventRefreshTimerRef.current !== undefined) {
        window.clearTimeout(eventRefreshTimerRef.current);
      }
      const flushEventRefresh = () => {
        eventRefreshTimerRef.current = undefined;
        const activeConversationId = selectedConversationIdRef.current;
        const shouldRefreshActive = Boolean(
          activeConversationId &&
          eventRefreshConversationIdsRef.current.has(activeConversationId)
        );
        if (shouldRefreshActive && blockingConversationLoadRef.current) {
          eventRefreshTimerRef.current = window.setTimeout(flushEventRefresh, 75);
          return;
        }
        eventRefreshConversationIdsRef.current.clear();
        void refreshSummaries().catch((error) =>
          reportDiscourseError(error, 'Could not refresh Discourse conversations.')
        );
        if (activeConversationId && shouldRefreshActive) {
          void loadConversation(activeConversationId, true, 'background').catch((error) =>
            reportDiscourseError(error, 'Could not refresh the conversation.')
          );
        }
      };
      eventRefreshTimerRef.current = window.setTimeout(flushEventRefresh, 75);
    });
    return () => {
      unsubscribe();
      if (eventRefreshTimerRef.current !== undefined) {
        window.clearTimeout(eventRefreshTimerRef.current);
        eventRefreshTimerRef.current = undefined;
      }
      eventRefreshConversationIdsRef.current.clear();
    };
  }, [loadConversation, refreshSummaries, reportDiscourseError]);

  const activeDraft = useMemo(() => {
    if (selectedConversationId) {
      return drafts.find((draft) => draft.conversationId === selectedConversationId);
    }
    if (newConversation) return drafts.find((draft) => !draft.conversationId);
    return undefined;
  }, [drafts, newConversation, selectedConversationId]);
  const alreadySentDrafts = useMemo(
    () => {
      const visibleSentIds = new Set(
        aggregate
          ? discourseDraftsAlreadySent(aggregate, messages, drafts).map((draft) => draft.id)
          : []
      );
      return drafts.filter(
        (draft) => visibleSentIds.has(draft.id) || durablySentDraftIds.has(draft.id)
      );
    },
    [aggregate, drafts, durablySentDraftIds, messages]
  );
  const activeDraftAlreadySent = Boolean(
    activeDraft && alreadySentDrafts.some((draft) => draft.id === activeDraft.id)
  );

  useEffect(() => {
    draftAutosave.activate(selectedConversationId, activeDraft);
    setReplyTargetId(activeDraft?.replyToMessageId);
    setCorrectionTargetId(activeDraft?.supersedesMessageId);
    setSelectedSourceMessageIds(activeDraft?.sourceMessageIds ?? []);
    const next = {
      ...createDiscourseComposerMentionState(activeDraft?.body ?? ''),
      tokens: composerTokensFromDraft(activeDraft?.tokens ?? [])
    };
    const defaultPolicy = activeDraft?.policy ??
      conversations.find((conversation) => conversation.id === selectedConversationId)?.defaultPolicy ??
      'NONE';
    setResponsePolicy(defaultPolicy);
    setAgentConfigOpen(false);
    setAgentSelectionOverrides(Object.fromEntries(
      (activeDraft?.agentSelections ?? []).map((selection) => [
        selection.agentProfileId,
        selection
      ])
    ));
    setComposer(next);
    setComposerVersion((value) => value + 1);
  // Draft content is restored when navigation changes. Saving the first
  // revision must not remount the focused composer merely because it gained an id.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newConversation, selectedConversationId]);

  useEffect(() => {
    if (alreadySentDrafts.length === 0) return;
    const acceptedDraftIds = new Set(alreadySentDrafts.map((draft) => draft.id));
    setDrafts((current) => {
      const next = current.filter((draft) => !acceptedDraftIds.has(draft.id));
      draftsRef.current = next;
      return next;
    });
    for (const draft of alreadySentDrafts) {
      void taskManagerApi.deleteDiscourseDraft({
        draftId: draft.id,
        expectedRevision: draft.recordRevision
      }).catch((error) => {
        console.error('Could not remove a draft whose message was already accepted.', error);
      });
    }
    if (activeDraft && acceptedDraftIds.has(activeDraft.id)) {
      const scope = draftAutosave.currentScope();
      if (scope) draftAutosave.clear(scope);
      if (draftSaveTimerRef.current !== undefined) {
        window.clearTimeout(draftSaveTimerRef.current);
        draftSaveTimerRef.current = undefined;
      }
      setReplyTargetId(undefined);
      setCorrectionTargetId(undefined);
      setSelectedSourceMessageIds([]);
      setComposer(createDiscourseComposerMentionState());
      setAgentSelectionOverrides({});
      setComposerVersion((value) => value + 1);
      onNotify('Recovered the conversation without resending its saved message.', 'info');
    }
  }, [activeDraft, alreadySentDrafts, draftAutosave, onNotify]);

  const selectedAgentProfileIds = composer.tokens
    .filter((token) => token.kind === 'AGENT')
    .map((token) => token.entityId)
    .filter(isBuiltInAgentProfileId);
  const activeAgentProfileIds: BuiltInAgentProfileId[] = responsePolicy === 'TEAM'
    ? ['builtin.lead', 'builtin.skeptic', 'builtin.verifier']
    : responsePolicy === 'NONE'
      ? []
      : selectedAgentProfileIds;
  const activeAgentSelections = activeAgentProfileIds.map((agentProfileId) =>
    agentSelectionOverrides[agentProfileId] ??
    (catalog
      ? discourseAgentSelectionFromCurrentRevision(aggregate, catalog, agentProfileId) ??
        defaultDiscourseAgentSelection(catalog, agentProfileId)
      : { agentProfileId })
  );
  const draftAgentSelections = activeAgentSelections.map((selection) =>
    selection.runtimeId && selection.modelId
      ? selection
      : { agentProfileId: selection.agentProfileId }
  );

  const persistDraft = useCallback((input: DraftPersistenceInput) => {
    if (!input.scope) {
      return input.required
        ? Promise.reject(new Error('The message draft is not ready to send.'))
        : Promise.resolve();
    }
    return draftAutosave.enqueue(input.scope, async (existing) => {
      if (
        !input.snapshot.text &&
        input.snapshot.tokens.length === 0 &&
        !input.replyToMessageId &&
        !input.supersedesMessageId &&
        (input.sourceMessageIds?.length ?? 0) === 0 &&
        input.policy === 'NONE' &&
        input.selections.length === 0 &&
        !existing
      ) return;
      const conversationId =
        input.conversationId ?? input.scope?.conversationId ?? existing?.conversationId;
      return taskManagerApi.saveDiscourseDraft({
        ...(existing ? { draftId: existing.id, expectedRevision: existing.recordRevision } : {}),
        ...(conversationId ? { conversationId } : {}),
        body: input.snapshot.text,
        ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
        ...(input.supersedesMessageId
          ? { supersedesMessageId: input.supersedesMessageId }
          : {}),
        ...(input.sourceMessageIds?.length
          ? { sourceMessageIds: input.sourceMessageIds }
          : {}),
        policy: input.policy,
        agentSelections: input.selections,
        ...(input.pendingClientMessageId
          ? { pendingClientMessageId: input.pendingClientMessageId }
          : {}),
        tokens: draftTokensFromComposer(input.snapshot.tokens)
      });
    }).then(({ saved }) => {
      if (!saved || input.quiet) return;
      setDrafts((current) => {
        const next = [saved, ...current.filter((draft) => draft.id !== saved.id)];
        draftsRef.current = next;
        return next;
      });
    }).catch((error) => {
      if (input.required) throw error;
      if (!input.quiet) reportDiscourseError(error, 'Could not save the discourse draft.');
    });
  }, [draftAutosave, reportDiscourseError]);

  persistDraftRef.current = persistDraft;
  latestDraftPersistenceRef.current =
    selectedConversationId || newConversation
      ? {
          scope: draftAutosave.currentScope(),
          snapshot: composer,
          policy: responsePolicy,
          selections: draftAgentSelections,
          ...(pendingSendIdentityRef.current
            ? { pendingClientMessageId: pendingSendIdentityRef.current.clientMessageId }
            : {}),
          ...(replyTargetId ? { replyToMessageId: replyTargetId } : {}),
          ...(correctionTargetId ? { supersedesMessageId: correctionTargetId } : {}),
          ...(selectedSourceMessageIds.length > 0
            ? { sourceMessageIds: selectedSourceMessageIds }
            : {})
        }
      : undefined;

  useEffect(() => () => {
    if (draftSaveTimerRef.current !== undefined) {
      window.clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = undefined;
    }
    const latest = latestDraftPersistenceRef.current;
    if (latest) void persistDraftRef.current?.({ ...latest, quiet: true });
  }, []);

  useEffect(() => {
    if (!selectedConversationId && !newConversation) return;
    const scope = draftAutosave.currentScope();
    if (!scope) return;
    const timer = window.setTimeout(() => {
      if (draftSaveTimerRef.current === timer) draftSaveTimerRef.current = undefined;
      const snapshot = composer;
      void persistDraft({
        scope,
        snapshot,
        policy: responsePolicy,
        selections: draftAgentSelections,
        ...(pendingSendIdentityRef.current
          ? { pendingClientMessageId: pendingSendIdentityRef.current.clientMessageId }
          : {}),
        ...(replyTargetId ? { replyToMessageId: replyTargetId } : {}),
        ...(correctionTargetId ? { supersedesMessageId: correctionTargetId } : {}),
        ...(selectedSourceMessageIds.length > 0
          ? { sourceMessageIds: selectedSourceMessageIds }
          : {})
      });
    }, 500);
    draftSaveTimerRef.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (draftSaveTimerRef.current === timer) draftSaveTimerRef.current = undefined;
    };
  }, [agentSelectionOverrides, aggregate, catalog, composer, correctionTargetId, draftAutosave, newConversation, persistDraft, replyTargetId, responsePolicy, selectedConversationId, selectedSourceMessageIds]);

  const candidates = useMemo(
    () => catalog ? discourseMentionCandidates(catalog, activeDraft?.tokens) : [],
    [activeDraft?.tokens, catalog]
  );
  const selectedSummary = conversations.find(
    (conversation) => conversation.id === selectedConversationId
  );
  const conversationPending = Boolean(
    selectedConversationId && !aggregate && conversationLoadState.status === 'loading'
  );
  const conversationLoadFailed = Boolean(
    selectedConversationId && !aggregate && conversationLoadState.status === 'error'
  );
  const conversationRefreshFailed = Boolean(
    selectedConversationId && aggregate && conversationLoadState.status === 'error'
  );
  const conversationRefreshing = Boolean(
    selectedConversationId && aggregate && conversationLoadState.status === 'loading'
  );
  const conversationUnavailable =
    conversationPending || conversationLoadFailed || conversationRefreshFailed ||
    conversationRefreshing;
  const replyTarget = replyTargetId
    ? messages.find((message) => message.id === replyTargetId)
    : undefined;
  const correctionTarget = correctionTargetId
    ? messages.find((message) => message.id === correctionTargetId)
    : undefined;
  const pinned = currentPinnedContext(aggregate);
  const responseWavePlacements = aggregate
    ? visibleDiscourseResponseWavePlacements(aggregate, messages)
    : [];
  const unanchoredResponseWave = responseWavePlacements.find(
    (placement) => !placement.afterMessageId
  )?.wave;
  const interruptedAcceptedSends = useMemo(
    () => interruptedDiscourseAcceptedSends(aggregate),
    [aggregate]
  );
  const responseDecisionPending = interruptedAcceptedSends.length > 0;
  const composerUnavailable =
    conversationUnavailable || responseDecisionPending || activeDraftAlreadySent;
  const contextTokens = composer.tokens.filter((token) => token.kind !== 'AGENT');
  const availableAgentProfileIds = new Set(
    catalog?.agents
      .filter((entry) => entry.availability === 'AVAILABLE')
      .map((entry) => entry.profile.id) ?? []
  );
  const teamReady = (['builtin.lead', 'builtin.skeptic', 'builtin.verifier'] as const)
    .every((profileId) => availableAgentProfileIds.has(profileId));
  const selectedAgentsReady = selectedAgentProfileIds.every((profileId) =>
    availableAgentProfileIds.has(profileId)
  );
  const eligibleRuntimeCatalog = catalog
    ? eligibleDiscourseRuntimeCatalog(catalog)
    : undefined;
  const configuredAgentsReady = activeAgentSelections.every((selection) =>
    Boolean(
      selection.runtimeId &&
      selection.modelId &&
      eligibleRuntimeCatalog?.models.some(
        (model) =>
          model.runtimeId === selection.runtimeId && model.id === selection.modelId
      )
    )
  );
  const responseReadiness = discourseResponseReadiness({
    policy: responsePolicy,
    selectedAgentCount: selectedAgentProfileIds.length,
    teamReady,
    selectedAgentsReady,
    configuredAgentsReady
  });
  const safeResponseReady = responseReadiness.ready;
  const responseRequirement = responseReadiness.requirement;

  const updateComposer = (next: DiscourseComposerMentionState) => {
    setComposer(next);
    const agentCount = next.tokens.filter((token) => token.kind === 'AGENT').length;
    if (agentCount === 1) {
      setResponsePolicy('DIRECT');
    } else if (agentCount >= 2) {
      setResponsePolicy('PANEL');
    }
  };

  const changeResponsePolicy = (policy: DiscourseDefaultPolicy) => {
    setResponsePolicy(policy);
    if (policy === 'DIRECT') {
      setAgentRoster(defaultDiscourseResponderRoster({
        policy,
        selectedProfileIds: selectedAgentProfileIds,
        availableProfileIds: availableAgentProfileIds
      }));
      setAgentConfigOpen(true);
      return;
    }
    if (policy === 'PANEL') {
      setAgentRoster(defaultDiscourseResponderRoster({
        policy,
        selectedProfileIds: selectedAgentProfileIds,
        availableProfileIds: availableAgentProfileIds
      }));
      setAgentConfigOpen(true);
      return;
    }
    const next = {
      ...composer,
      tokens: composer.tokens.filter((token) => token.kind !== 'AGENT')
    };
    setComposer(next);
    setComposerVersion((value) => value + 1);
  };

  const setAgentRoster = (profileIds: readonly BuiltInAgentProfileId[]) => {
    const agentTokens = profileIds.flatMap((profileId) => {
      const entry = catalog?.agents.find((candidate) => candidate.profile.id === profileId);
      if (!entry) return [];
      return [{
        key: `AGENT:${profileId}`,
        kind: 'AGENT' as const,
        entityId: profileId,
        labelSnapshot: entry.profile.displayName,
        available: entry.availability === 'AVAILABLE'
      }];
    });
    setComposer((current) => ({
      ...current,
      tokens: [...current.tokens.filter((token) => token.kind !== 'AGENT'), ...agentTokens]
    }));
    setComposerVersion((value) => value + 1);
  };

  const toggleRespondingAgent = (profileId: BuiltInAgentProfileId) => {
    if (responsePolicy === 'DIRECT') {
      setAgentRoster([profileId]);
      return;
    }
    if (responsePolicy !== 'PANEL') return;
    const selected = selectedAgentProfileIds.includes(profileId)
      ? selectedAgentProfileIds.filter((candidate) => candidate !== profileId)
      : [...selectedAgentProfileIds, profileId].slice(0, 3);
    setAgentRoster(selected);
  };

  const updateAgentSelection = (selection: DiscourseAgentSelectionInput) => {
    setAgentSelectionOverrides((current) => ({
      ...current,
      [selection.agentProfileId]: selection
    }));
  };

  const discoverAgentModels = async (runtimeId: string) => {
    await taskManagerApi.discoverAgentRuntimeModels(runtimeId);
    setCatalog(await taskManagerApi.getDiscourseMentionCatalog());
  };

  const prepareAgentFollowUp = (
    message: DiscourseMessageRecord,
    mode: 'AUTHOR' | 'OTHERS'
  ) => {
    if (message.author.kind !== 'AGENT' || !catalog || !aggregate) return;
    const author = message.author;
    const authorRevision = aggregate.participantRevisions.find(
      (revision) => revision.id === author.participantRevisionId
    );
    if (!authorRevision) return;
    const profiles = catalog.agents
      .filter((entry) => entry.availability === 'AVAILABLE')
      .filter((entry) => mode === 'AUTHOR'
        ? entry.profile.id === authorRevision.agentProfileId
        : entry.profile.id !== authorRevision.agentProfileId)
      .slice(0, mode === 'AUTHOR' ? 1 : 2);
    if (profiles.length === 0) {
      onNotify('No suitable agent is currently available.', 'info');
      return;
    }
    const next = {
      ...composer,
      tokens: [
        ...composer.tokens.filter((token) => token.kind !== 'AGENT'),
        ...profiles.map((entry) => ({
          key: `AGENT:${entry.profile.id}`,
          kind: 'AGENT' as const,
          entityId: entry.profile.id,
          labelSnapshot: entry.profile.displayName,
          available: true
        }))
      ]
    };
    setReplyTargetId(message.replyToMessageId ?? message.id);
    setCorrectionTargetId(undefined);
    setResponsePolicy(profiles.length === 1 ? 'DIRECT' : 'PANEL');
    setComposer(next);
    setComposerVersion((value) => value + 1);
    onNotify(
      mode === 'AUTHOR'
        ? `Write a follow-up for ${profiles[0]!.profile.displayName}.`
        : 'Write a follow-up for the other agents.',
      'info'
    );
  };

  const prepareSynthesis = () => {
    if (selectedSourceMessageIds.length < 2 || !catalog) return;
    const lead = catalog.agents.find(
      (entry) => entry.profile.id === 'builtin.lead' && entry.availability === 'AVAILABLE'
    );
    if (!lead) {
      onNotify('Lead is not currently available to synthesize these messages.', 'info');
      return;
    }
    const text = 'Synthesize the selected messages into one concise answer. Preserve material disagreement, uncertainty, and any context limitations.';
    setComposer({
      ...createDiscourseComposerMentionState(text),
      tokens: [
        ...composer.tokens.filter((token) => token.kind !== 'AGENT'),
        {
          key: `AGENT:${lead.profile.id}`,
          kind: 'AGENT',
          entityId: lead.profile.id,
          labelSnapshot: lead.profile.displayName,
          available: true
        }
      ]
    });
    setResponsePolicy('DIRECT');
    setReplyTargetId(undefined);
    setCorrectionTargetId(undefined);
    setComposerVersion((value) => value + 1);
  };

  const flushCurrentDraft = (
    pendingClientMessageId?: string,
    conversationId?: string,
    required = false
  ) => {
    if (draftSaveTimerRef.current !== undefined) {
      window.clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = undefined;
    }
    return persistDraft({
      scope: draftAutosave.currentScope(),
      ...(conversationId ? { conversationId } : {}),
      snapshot: composer,
      policy: responsePolicy,
      selections: draftAgentSelections,
      ...(pendingClientMessageId ? { pendingClientMessageId } : {}),
      ...(required ? { required: true } : {}),
      ...(replyTargetId ? { replyToMessageId: replyTargetId } : {}),
      ...(correctionTargetId ? { supersedesMessageId: correctionTargetId } : {}),
      ...(selectedSourceMessageIds.length > 0
        ? { sourceMessageIds: selectedSourceMessageIds }
        : {})
    });
  };

  const cleanupSupersededConversations = async (conversationIds: readonly string[]) => {
    const candidates = [...new Set([
      ...supersededConversationCleanupIdsRef.current,
      ...conversationIds
    ])];
    supersededConversationCleanupIdsRef.current = candidates;
    if (candidates.length === 0) return;
    let summaries: DiscourseConversationSummary[];
    let savedDrafts: DiscourseDraftRecord[];
    try {
      [summaries, savedDrafts] = await Promise.all([
        refreshSummaries(),
        taskManagerApi.listDiscourseDrafts()
      ]);
    } catch (error) {
      console.error('Could not inspect superseded Discourse conversations.', error);
      return;
    }
    const remaining: string[] = [];
    for (const conversationId of candidates) {
      if (!summaries.some((summary) => summary.id === conversationId)) continue;
      try {
        const supersededAggregate = await taskManagerApi.getDiscourseConversation(
          conversationId
        );
        if (!canDeleteAbandonedDiscourseShell({
          conversationId,
          latestOrdinal: supersededAggregate.conversation.latestOrdinal,
          drafts: savedDrafts
        })) continue;
        await taskManagerApi.deleteDiscourseConversation({
          conversationId,
          expectedRevision: supersededAggregate.conversation.recordRevision,
          clientOperationId: crypto.randomUUID()
        });
      } catch (error) {
        remaining.push(conversationId);
        console.error('Could not clean up a superseded Discourse conversation.', error);
      }
    }
    supersededConversationCleanupIdsRef.current = remaining;
    await refreshSummaries().catch(() => undefined);
  };

  const abandonPendingNewConversation = async (draftFlush: Promise<void>) => {
    const pending = pendingNewConversationRef.current;
    if (!pending) return;
    pendingSendIdentityRef.current = undefined;
    try {
      await draftFlush;
    } catch (error) {
      if (pendingNewConversationRef.current === pending) {
        pendingNewConversationRef.current = undefined;
      }
      await refreshSummaries().catch(() => undefined);
      reportDiscourseError(
        error,
        'The draft could not be saved, so its conversation was kept.'
      );
      return;
    }
    let conversationId = pending.conversationId;
    if (!conversationId) {
      try {
        const recovered = await taskManagerApi.createDiscourseConversation({
          ...pending.createRequest,
          clientOperationId: pending.clientOperationId
        });
        conversationId = recovered.id;
      } catch (error) {
        reportDiscourseError(
          error,
          'Could not reconcile the empty conversation before leaving it.'
        );
        return;
      }
    }
    if (pendingNewConversationRef.current === pending) {
      pendingNewConversationRef.current = undefined;
    }
    await cleanupSupersededConversations(pending.supersededConversationIds ?? []);
    try {
      const [pendingAggregate, savedDrafts] = await Promise.all([
        taskManagerApi.getDiscourseConversation(conversationId),
        taskManagerApi.listDiscourseDrafts()
      ]);
      if (!canDeleteAbandonedDiscourseShell({
        conversationId,
        latestOrdinal: pendingAggregate.conversation.latestOrdinal,
        drafts: savedDrafts
      })) {
        await refreshSummaries();
        return;
      }
      await taskManagerApi.deleteDiscourseConversation({
        conversationId,
        expectedRevision: pendingAggregate.conversation.recordRevision,
        clientOperationId: crypto.randomUUID()
      });
      await refreshSummaries();
    } catch (error) {
      reportDiscourseError(error, 'Could not clean up the empty conversation.');
    }
  };

  const selectConversation = (conversationId: string) => {
    if (sending) return;
    const pendingShell = pendingNewConversationRef.current?.conversationId;
    const draftFlush = flushCurrentDraft(
      pendingSendIdentityRef.current?.clientMessageId,
      pendingShell,
      Boolean(pendingShell)
    );
    pendingConversationCleanupRef.current = pendingConversationCleanupRef.current.then(() =>
      pendingNewConversationRef.current
        ? abandonPendingNewConversation(draftFlush)
        : cleanupSupersededConversations([])
    );
    void pendingConversationCleanupRef.current;
    pendingSendIdentityRef.current = undefined;
    navigationGenerationRef.current += 1;
    conversationLoadGeneration.current += 1;
    selectedConversationIdRef.current = conversationId;
    setNewConversation(false);
    setSelectedConversationId(conversationId);
    setAggregate(undefined);
    setMessages([]);
    messagesRef.current = [];
    setPreviousCursor(undefined);
    setConversationLoadState({ status: 'loading' });
    setPreview(undefined);
    setNewResponses(false);
    setRailOpen(false);
  };

  const startNewConversation = () => {
    if (sending) return;
    const pendingShell = pendingNewConversationRef.current?.conversationId;
    const draftFlush = flushCurrentDraft(
      pendingSendIdentityRef.current?.clientMessageId,
      pendingShell,
      Boolean(pendingShell)
    );
    pendingConversationCleanupRef.current = pendingConversationCleanupRef.current.then(() =>
      pendingNewConversationRef.current
        ? abandonPendingNewConversation(draftFlush)
        : cleanupSupersededConversations([])
    );
    void pendingConversationCleanupRef.current;
    pendingSendIdentityRef.current = undefined;
    navigationGenerationRef.current += 1;
    conversationLoadGeneration.current += 1;
    selectedConversationIdRef.current = undefined;
    setSelectedConversationId(undefined);
    setNewConversation(true);
    setAggregate(undefined);
    setMessages([]);
    messagesRef.current = [];
    setPreview(undefined);
    setRailOpen(false);
  };

  const send = async (state = composer) => {
    const body = state.text.trim();
    if (!body || sending) return;
    const sendGeneration = navigationGenerationRef.current;
    const draftScope = draftAutosave.currentScope();
    const sentPolicy = responsePolicy;
    const sentSelections = activeAgentSelections.map((selection) => ({ ...selection }));
    const sentReplyTargetId = replyTargetId;
    const sentCorrectionTargetId = correctionTargetId;
    const sentSourceMessageIds = [...selectedSourceMessageIds];
    const agentProfileIds = sentSelections.map((selection) => selection.agentProfileId);
    if (sentPolicy === 'TEAM' && !teamReady) {
      onNotify('Team responses require all three agents to be available.', 'info');
      return;
    }
    if (sentPolicy === 'DIRECT' && agentProfileIds.length !== 1) {
      onNotify('Choose one agent for a Direct response.', 'info');
      return;
    }
    if (sentPolicy === 'PANEL' && (agentProfileIds.length < 2 || agentProfileIds.length > 3)) {
      onNotify('Choose two or three agents for a Panel response.', 'info');
      return;
    }
    if (!configuredAgentsReady) {
      onNotify('Choose an available provider and model for each responding agent.', 'info');
      return;
    }
    const messageContext = state.tokens.flatMap((token) =>
      token.kind === 'AGENT'
        ? []
        : [{ entityKind: token.kind, entityId: token.entityId }]
    );
    const sendFingerprint = discoursePendingSendFingerprint({
      body,
      ...(sentReplyTargetId ? { replyToMessageId: sentReplyTargetId } : {}),
      ...(sentCorrectionTargetId ? { supersedesMessageId: sentCorrectionTargetId } : {}),
      sourceMessageIds: sentSourceMessageIds,
      context: messageContext,
      policy: sentPolicy,
      agents: sentSelections
    });
    if (pendingSendIdentityRef.current?.fingerprint !== sendFingerprint) {
      pendingSendIdentityRef.current = {
        fingerprint: sendFingerprint,
        clientMessageId: crypto.randomUUID()
      };
    }
    const sendIdentity = pendingSendIdentityRef.current;
    if (!sendIdentity) return;
    let conversationId = selectedConversationId;
    let deliveryAttempted = false;
    let supersededConversationIds: string[] = [];
    setSending(true);
    try {
      await pendingConversationCleanupRef.current;
      await cleanupSupersededConversations([]);
      const title = deriveConversationTitle(body);
      const createFingerprint = pendingConversationFingerprint(
        title,
        sentPolicy,
        sentSelections
      );
      let pending = pendingNewConversationRef.current;
      supersededConversationIds = [...(pending?.supersededConversationIds ?? [])];
      if (!conversationId && pending && pending.createFingerprint !== createFingerprint) {
        if (!pending.conversationId) {
          supersededConversationIds = await recoverPendingDiscourseCreateForReplacement({
            pending,
            replay: (request) => taskManagerApi.createDiscourseConversation(request)
          });
          pendingNewConversationRef.current = undefined;
          pending = undefined;
        } else {
          const pendingAggregate = await taskManagerApi.getDiscourseConversation(
            pending.conversationId
          );
          if (pendingAggregate.conversation.latestOrdinal === 0) {
            supersededConversationIds = [...new Set([
              ...supersededConversationIds,
              pending.conversationId
            ])];
            if (pendingNewConversationRef.current?.conversationId === pending.conversationId) {
              pendingNewConversationRef.current = undefined;
            }
            pending = undefined;
          } else {
            conversationId = pending.conversationId;
          }
        }
      }
      conversationId ??= pending?.conversationId;
      if (!conversationId) {
        const clientOperationId = pending?.clientOperationId ?? crypto.randomUUID();
        const createRequest = {
          title,
          defaultPolicy: sentPolicy,
          agents: sentSelections
        };
        pendingNewConversationRef.current = {
          createFingerprint,
          clientOperationId,
          createRequest,
          ...(supersededConversationIds.length > 0
            ? { supersededConversationIds }
            : {})
        };
        const created = await taskManagerApi.createDiscourseConversation({
          ...createRequest,
          clientOperationId
        });
        conversationId = created.id;
        pendingNewConversationRef.current = {
          conversationId: created.id,
          createFingerprint,
          clientOperationId,
          createRequest,
          ...(supersededConversationIds.length > 0
            ? { supersededConversationIds }
            : {})
        };
        void refreshSummaries().catch((error) =>
          reportDiscourseError(error, 'Could not refresh Discourse conversations.')
        );
      }
      await flushCurrentDraft(
        sendIdentity.clientMessageId,
        conversationId,
        true
      );
      await cleanupSupersededConversations(supersededConversationIds);
      const currentPending = pendingNewConversationRef.current;
      if (
        currentPending?.conversationId === conversationId &&
        currentPending.supersededConversationIds
      ) {
        pendingNewConversationRef.current = {
          conversationId: currentPending.conversationId,
          createFingerprint: currentPending.createFingerprint,
          clientOperationId: currentPending.clientOperationId,
          createRequest: currentPending.createRequest
        };
      }
      const contextPreview = sentPolicy !== 'NONE'
        ? await taskManagerApi.previewDiscourseContext({
            conversationId,
            messageContext
          })
        : undefined;
      deliveryAttempted = true;
      await taskManagerApi.sendDiscourseMessage({
        conversationId,
        body,
        ...(sentReplyTargetId ? { replyToMessageId: sentReplyTargetId } : {}),
        ...(sentCorrectionTargetId ? { supersedesMessageId: sentCorrectionTargetId } : {}),
        ...(sentSourceMessageIds.length > 0
          ? { sourceMessageIds: sentSourceMessageIds }
          : {}),
        context: messageContext,
        clientMessageId: sendIdentity.clientMessageId,
        policy: sentPolicy,
        agents: sentSelections,
        ...(contextPreview ? { previewFingerprint: contextPreview.fingerprint } : {})
      });
      const savedDraft = draftScope ? draftAutosave.draftFor(draftScope) : undefined;
      if (savedDraft) {
        await taskManagerApi.deleteDiscourseDraft({
          draftId: savedDraft.id,
          expectedRevision: savedDraft.recordRevision
        }).catch(() => undefined);
      }
      if (draftScope) draftAutosave.clear(draftScope);
      if (pendingNewConversationRef.current?.conversationId === conversationId) {
        pendingNewConversationRef.current = undefined;
      }
      if (pendingSendIdentityRef.current?.clientMessageId === sendIdentity.clientMessageId) {
        pendingSendIdentityRef.current = undefined;
      }
      const isCurrent = sendGeneration === navigationGenerationRef.current;
      if (isCurrent) {
        const wasNewConversation = !selectedConversationId;
        setDrafts((current) => {
          const next = current.filter((draft) => draft.id !== savedDraft?.id);
          draftsRef.current = next;
          return next;
        });
        setReplyTargetId(undefined);
        setCorrectionTargetId(undefined);
        setSelectedSourceMessageIds([]);
        setComposer(createDiscourseComposerMentionState());
        setAgentSelectionOverrides({});
        setComposerVersion((value) => value + 1);
        setResponsePolicy(sentPolicy);
        if (wasNewConversation) {
          selectedConversationIdRef.current = conversationId;
          setSelectedConversationId(conversationId);
          setNewConversation(false);
        }
        onNotify(sentPolicy === 'NONE' ? 'Message added.' : 'Response queued.', 'success');
        const refreshResults = await Promise.allSettled([
          refreshSummaries(),
          wasNewConversation
            ? Promise.resolve()
            : loadConversation(conversationId)
        ]);
        const refreshFailure = refreshResults.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected'
        );
        if (refreshFailure) {
          reportDiscourseError(
            refreshFailure.reason,
            'The message was sent, but the conversation could not fully refresh.'
          );
        }
      } else {
        void refreshSummaries().catch((error) =>
          reportDiscourseError(error, 'Could not refresh Discourse conversations.')
        );
      }
    } catch (error) {
      if (conversationId && deliveryAttempted) {
        try {
          const recovered = await taskManagerApi.getDiscourseConversation(conversationId);
          const accepted = discourseAcceptedSendForClientMessage(
            recovered,
            sendIdentity.clientMessageId
          );
          const recoveredMessages = accepted
            ? []
            : (await taskManagerApi.listDiscourseMessages({
                conversationId,
                limit: 100
              })).messages;
          if (discourseClientMessageWasPersisted(
            recovered,
            recoveredMessages,
            sendIdentity.clientMessageId
          )) {
            console.error('Discourse delivery failed after the message was persisted.', error);
            const savedDraft = draftScope ? draftAutosave.draftFor(draftScope) : undefined;
            if (savedDraft) {
              await taskManagerApi.deleteDiscourseDraft({
                draftId: savedDraft.id,
                expectedRevision: savedDraft.recordRevision
              }).catch(() => undefined);
            }
            if (draftScope) draftAutosave.clear(draftScope);
            if (pendingNewConversationRef.current?.conversationId === conversationId) {
              pendingNewConversationRef.current = undefined;
            }
            if (pendingSendIdentityRef.current?.clientMessageId === sendIdentity.clientMessageId) {
              pendingSendIdentityRef.current = undefined;
            }
            if (sendGeneration === navigationGenerationRef.current) {
              setDrafts((current) => {
                const next = current.filter((draft) => draft.id !== savedDraft?.id);
                draftsRef.current = next;
                return next;
              });
              setReplyTargetId(undefined);
              setCorrectionTargetId(undefined);
              setSelectedSourceMessageIds([]);
              setComposer(createDiscourseComposerMentionState());
              setAgentSelectionOverrides({});
              setComposerVersion((value) => value + 1);
              setResponsePolicy(sentPolicy);
              selectedConversationIdRef.current = conversationId;
              setSelectedConversationId(conversationId);
              setNewConversation(false);
              setAggregate(recovered);
              const refreshResults = await Promise.allSettled([
                refreshSummaries(),
                loadConversation(conversationId, true)
              ]);
              const refreshFailure = refreshResults.find(
                (result): result is PromiseRejectedResult => result.status === 'rejected'
              );
              if (refreshFailure) {
                reportDiscourseError(
                  refreshFailure.reason,
                  'Your message was saved, but the conversation could not fully refresh.'
                );
              }
              if (!accepted) {
                onNotify('Message added.', 'success');
              } else {
                const responseWasPlanned = recovered.waves.some(
                  (wave) => wave.triggerMessageId === accepted.triggerMessageId
                );
                onNotify(
                  responseWasPlanned
                    ? 'Message saved and response queued.'
                    : 'Message saved. Choose Resume or Cancel for the interrupted response.',
                  responseWasPlanned ? 'success' : 'info'
                );
              }
            }
            return;
          }
        } catch (recoveryError) {
          console.error('Could not reconcile the Discourse send after failure.', recoveryError);
          if (sendGeneration === navigationGenerationRef.current) {
            selectedConversationIdRef.current = conversationId;
            setSelectedConversationId(conversationId);
            setNewConversation(false);
            setConversationLoadState({
              status: 'error',
              detail: 'Task Monki could not verify the latest conversation state.'
            });
          }
        }
      }
      reportDiscourseError(error, 'Could not send the message.');
    } finally {
      if (sendGeneration === navigationGenerationRef.current) setSending(false);
    }
  };

  const loadOlder = async () => {
    if (!selectedConversationId || !previousCursor || !transcriptRef.current) return;
    const container = transcriptRef.current;
    const beforeHeight = container.scrollHeight;
    try {
      const page = await taskManagerApi.listDiscourseMessages({
        conversationId: selectedConversationId,
        beforeCursor: previousCursor,
        limit: 100
      });
      setMessages((current) => {
        const next = dedupeMessages([...page.messages, ...current]);
        messagesRef.current = next;
        return next;
      });
      setPreviousCursor(page.previousCursor);
      requestAnimationFrame(() => {
        container.scrollTop += container.scrollHeight - beforeHeight;
      });
    } catch (error) {
      reportDiscourseError(error, 'Could not load older messages.');
    }
  };

  const resumeAcceptedSend = async (acceptedSendId: string) => {
    if (!aggregate || acceptedSendActionId) return;
    setAcceptedSendActionId(acceptedSendId);
    try {
      await taskManagerApi.resumeDiscourseAcceptedSend({
        conversationId: aggregate.conversation.id,
        acceptedSendId
      });
      onNotify('Agent response resumed.', 'success');
      const results = await Promise.allSettled([
        refreshSummaries(),
        loadConversation(aggregate.conversation.id, true)
      ]);
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      );
      if (failure) {
        reportDiscourseError(failure.reason, 'The response resumed, but the conversation could not fully refresh.');
      }
    } catch (error) {
      reportDiscourseError(error, 'Could not resume the agent response.');
    } finally {
      setAcceptedSendActionId(undefined);
    }
  };

  const cancelAcceptedSend = async (acceptedSendId: string) => {
    if (!aggregate || acceptedSendActionId) return;
    setAcceptedSendActionId(acceptedSendId);
    try {
      const next = await taskManagerApi.cancelDiscourseAcceptedSend({
        conversationId: aggregate.conversation.id,
        acceptedSendId,
        expectedConversationRevision: aggregate.conversation.recordRevision,
        clientOperationId: crypto.randomUUID()
      });
      setAggregate(next);
      await refreshSummaries().catch((error) =>
        reportDiscourseError(error, 'The response was canceled, but the conversation list could not refresh.')
      );
      onNotify('Agent response canceled. Your message remains in the conversation.', 'info');
    } catch (error) {
      reportDiscourseError(error, 'Could not cancel the interrupted agent response.');
    } finally {
      setAcceptedSendActionId(undefined);
    }
  };

  const showPreview = async () => {
    setPreviewLoading(true);
    try {
      setPreview(await taskManagerApi.previewDiscourseContext({
        ...(selectedConversationId ? { conversationId: selectedConversationId } : {}),
        messageContext: contextTokens.map((token) => ({
          entityKind: token.kind as 'TASK' | 'REPOSITORY',
          entityId: token.entityId
        }))
      }));
    } catch (error) {
      reportDiscourseError(error, 'Could not resolve the context preview.');
    } finally {
      setPreviewLoading(false);
    }
  };

  const pinContext = async (entityKind: 'TASK' | 'REPOSITORY', entityId: string) => {
    if (!aggregate) return;
    const selections = dedupeContextSelections([
      ...pinned.map((reference) => ({
        entityKind: reference.entityKind,
        entityId: reference.entityId
      })),
      { entityKind, entityId }
    ]);
    try {
      const next = await taskManagerApi.setPinnedDiscourseContext({
        conversationId: aggregate.conversation.id,
        context: selections,
        expectedRevision: aggregate.conversation.recordRevision,
        clientOperationId: crypto.randomUUID()
      });
      setAggregate(next);
      onNotify('Context pinned for future responses.', 'success');
    } catch (error) {
      reportDiscourseError(error, 'Could not pin context.');
    }
  };

  const unpinContext = async (reference: ConversationContextReferenceSnapshot) => {
    if (!aggregate) return;
    try {
      const next = await taskManagerApi.setPinnedDiscourseContext({
        conversationId: aggregate.conversation.id,
        context: pinned
          .filter((candidate) => candidate.contextLinkId !== reference.contextLinkId)
          .map((candidate) => ({
            entityKind: candidate.entityKind,
            entityId: candidate.entityId
          })),
        expectedRevision: aggregate.conversation.recordRevision,
        clientOperationId: crypto.randomUUID()
      });
      setAggregate(next);
    } catch (error) {
      reportDiscourseError(error, 'Could not remove pinned context.');
    }
  };

  const renameConversation = async () => {
    if (!aggregate || !renameValue.trim()) return;
    try {
      const conversation = await taskManagerApi.renameDiscourseConversation({
        conversationId: aggregate.conversation.id,
        title: renameValue.trim(),
        expectedRevision: aggregate.conversation.recordRevision,
        clientOperationId: crypto.randomUUID()
      });
      setAggregate((current) => current ? { ...current, conversation } : current);
      setRenameOpen(false);
      await refreshSummaries();
    } catch (error) {
      reportDiscourseError(error, 'Could not rename the conversation.');
    }
  };

  const setArchived = async (archived: boolean) => {
    if (!aggregate) return;
    try {
      const conversation = await taskManagerApi.setDiscourseConversationArchived({
        conversationId: aggregate.conversation.id,
        archived,
        expectedRevision: aggregate.conversation.recordRevision,
        clientOperationId: crypto.randomUUID()
      });
      setAggregate((current) => current ? { ...current, conversation } : current);
      await refreshSummaries();
      onNotify(archived ? 'Conversation archived.' : 'Conversation restored.', 'success');
    } catch (error) {
      reportDiscourseError(
        error,
        archived ? 'Could not archive the conversation.' : 'Could not restore the conversation.'
      );
    }
  };

  const deleteConversation = async () => {
    if (!aggregate) return;
    try {
      await taskManagerApi.deleteDiscourseConversation({
        conversationId: aggregate.conversation.id,
        expectedRevision: aggregate.conversation.recordRevision,
        clientOperationId: crypto.randomUUID()
      });
      const remaining = await refreshSummaries();
      const next = remaining.find((conversation) => conversation.status === 'OPEN') ?? remaining[0];
      setConfirmAction(undefined);
      if (next) selectConversation(next.id);
      else startNewConversation();
      onNotify('Conversation deleted.', 'success');
    } catch (error) {
      reportDiscourseError(error, 'Could not delete the conversation.');
    }
  };

  const tombstoneMessage = async (message: DiscourseMessageRecord) => {
    if (!aggregate) return;
    try {
      const conversation = await taskManagerApi.tombstoneDiscourseMessage({
        conversationId: aggregate.conversation.id,
        messageId: message.id,
        expectedConversationRevision: aggregate.conversation.recordRevision,
        clientOperationId: crypto.randomUUID()
      });
      setAggregate((current) => current ? { ...current, conversation } : current);
      await loadConversation(aggregate.conversation.id, true);
    } catch (error) {
      reportDiscourseError(error, 'Could not delete the message.');
    }
  };

  const stopWave = async (waveId: string) => {
    if (!aggregate) return;
    try {
      await taskManagerApi.stopDiscourseWave({
        conversationId: aggregate.conversation.id,
        waveId,
        clientOperationId: crypto.randomUUID(),
        reason: 'User stopped the discourse response.'
      });
      await loadConversation(aggregate.conversation.id, true);
      onNotify('Stopping the response.', 'info');
    } catch (error) {
      reportDiscourseError(error, 'Could not stop the response.');
    }
  };

  const confirmWaveContext = async (waveId: string) => {
    if (!aggregate) return;
    const wave = aggregate.waves.find((candidate) => candidate.id === waveId);
    if (!wave || wave.dispatchGate.status !== 'RECONFIRMATION_REQUIRED') return;
    try {
      await taskManagerApi.confirmDiscourseWaveContext({
        conversationId: aggregate.conversation.id,
        waveId,
        previewFingerprint: wave.dispatchGate.currentFingerprint,
        expectedWaveRevision: wave.recordRevision,
        clientOperationId: crypto.randomUUID()
      });
      await loadConversation(aggregate.conversation.id, true);
      onNotify('Response queued with the updated context.', 'success');
    } catch (error) {
      reportDiscourseError(error, 'Could not confirm the updated context.');
    }
  };

  const prepareWaveRetry = (waveId: string) => {
    if (!aggregate) return;
    const wave = aggregate.waves.find((candidate) => candidate.id === waveId);
    const trigger = wave
      ? messages.find((message) => message.id === wave.triggerMessageId)
      : undefined;
    const contextRevision = wave
      ? aggregate.contextRevisions.find((revision) => revision.id === wave.plannedContextRevisionId)
      : undefined;
    if (!wave || !trigger) return;
    const policy: DiscourseDefaultPolicy = ['DIRECT', 'PANEL', 'TEAM'].includes(wave.policy)
      ? wave.policy as DiscourseDefaultPolicy
      : 'DIRECT';
    const agentTokens = policy === 'TEAM'
      ? []
      : wave.assignments.map((assignment) => ({
          key: `AGENT:${assignment.agentProfileId}`,
          kind: 'AGENT' as const,
          entityId: assignment.agentProfileId,
          labelSnapshot: assignment.displayNameSnapshot,
          available: true
        }));
    const contextTokens = contextRevision?.references.map((reference) => ({
      key: `${reference.entityKind}:${reference.entityId}`,
      kind: reference.entityKind,
      entityId: reference.entityId,
      labelSnapshot: reference.labelSnapshot,
      available: reference.availability === 'AVAILABLE'
    })) ?? [];
    setComposer({
      ...createDiscourseComposerMentionState(trigger.body),
      tokens: [...agentTokens, ...contextTokens]
    });
    setResponsePolicy(policy);
    setSelectedSourceMessageIds(trigger.sourceMessageIds);
    setReplyTargetId(trigger.replyToMessageId);
    setCorrectionTargetId(undefined);
    setComposerVersion((value) => value + 1);
    onNotify('Review the refreshed context, then send when ready.', 'info');
  };

  const displayedConversations = visibleConversationSummaries(
    conversations.filter((conversation) =>
      (showArchived ? conversation.status === 'ARCHIVED' : conversation.status === 'OPEN') &&
      conversation.id !== pendingNewConversationRef.current?.conversationId
    ),
    railQuery
  );

  if (loading) {
    return <div className="tm-discourse tm-discourse--loading" aria-busy="true">Loading Discourse…</div>;
  }

  if (workspaceLoadFailed) {
    return (
      <div className="tm-discourse tm-discourse--loading" role="alert">
        <div className="tm-discourse-workspace-error">
          <strong>Discourse could not be loaded</strong>
          <span>Conversations, agents, and drafts are unavailable until the connection recovers.</span>
          <button type="button" className="tm-btn tm-btn--soft" onClick={() => void loadWorkspace()}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <main className="tm-discourse">
      <DiscourseConversationRail
        archived={showArchived}
        conversations={displayedConversations}
        modalOpen={railModalOpen}
        newConversation={newConversation}
        query={railQuery}
        railRef={railRef}
        searchRef={railSearchRef}
        selectedConversationId={selectedConversationId}
        sending={sending}
        onArchivedChange={setShowArchived}
        onClose={() => setRailOpen(false)}
        onNewConversation={startNewConversation}
        onQueryChange={setRailQuery}
        onSelectConversation={selectConversation}
      />

      <section className="tm-discourse-conversation">
        <header className="tm-discourse-header">
          <button
            ref={railReturnFocusRef}
            type="button"
            className="tm-iconbtn tm-discourse-rail-toggle"
            aria-label="Open conversations"
            aria-expanded={railModalOpen}
            onClick={() => setRailOpen(true)}
          >
            <SidebarIcon />
          </button>
          <div className="tm-discourse-header__title">
            {renameOpen && aggregate ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void renameConversation();
                }}
              >
                <input
                  autoFocus
                  value={renameValue}
                  aria-label="Conversation title"
                  onChange={(event) => setRenameValue(event.target.value)}
                  onBlur={() => setRenameOpen(false)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      setRenameOpen(false);
                    }
                  }}
                />
              </form>
            ) : (
              <button
                type="button"
                className="tm-discourse-title-button"
                disabled={!aggregate}
                onClick={() => {
                  if (!aggregate) return;
                  setRenameValue(aggregate.conversation.title);
                  setRenameOpen(true);
                }}
              >
                {aggregate?.conversation.title ?? selectedSummary?.title ?? 'New conversation'}
              </button>
            )}
            <div className="tm-discourse-header__meta">
              <span>{aggregate?.participants.length ? `${aggregate.participants.length} agent${aggregate.participants.length === 1 ? '' : 's'}` : 'No agents'}</span>
              {pinned.length > 0 ? <span>{pinned.length} pinned context</span> : <span>Context per message</span>}
              {aggregate?.conversation.status === 'ARCHIVED' ? <span>Archived</span> : null}
            </div>
          </div>
          <div className="tm-discourse-header__actions">
            <button
              type="button"
              className="tm-iconbtn"
              aria-label={inspectorOpen ? 'Close context inspector' : 'Open context inspector'}
              title="Context"
              onClick={() => setInspectorOpen((value) => !value)}
            >
              <ContextIcon />
            </button>
            {aggregate ? (
              <DiscourseActionMenu
                className="tm-discourse-menu"
                label="Conversation actions"
                trigger="•••"
                items={[
                  {
                    label: aggregate.conversation.status === 'ARCHIVED'
                      ? 'Restore conversation'
                      : 'Archive conversation',
                    onSelect: () => void setArchived(
                      aggregate.conversation.status !== 'ARCHIVED'
                    )
                  },
                  {
                    label: 'Delete conversation',
                    danger: true,
                    onSelect: () => setConfirmAction({ type: 'delete-conversation' })
                  }
                ]}
              />
            ) : null}
          </div>
        </header>

        <div className="tm-discourse-transcript-shell">
          <div
            className="tm-discourse-transcript"
            ref={transcriptRef}
            onScroll={(event) => {
              if (isNearScrollBottom(event.currentTarget)) setNewResponses(false);
            }}
          >
          {conversationRefreshFailed || conversationRefreshing ? (
            <div
              className={`tm-discourse-status-banner ${
                conversationRefreshFailed ? 'tm-discourse-status-banner--error' : ''
              }`}
              role={conversationRefreshFailed ? 'alert' : 'status'}
            >
              <span>
                <strong>
                  {conversationRefreshing ? 'Refreshing conversation…' : 'Conversation refresh paused'}
                </strong>
                {conversationRefreshing
                  ? 'Actions will be available when the latest state arrives.'
                  : conversationLoadState.detail ?? 'The latest conversation state could not be loaded.'}
              </span>
              {conversationRefreshFailed ? (
                <button
                  type="button"
                  onClick={() => selectedConversationId && void loadConversation(selectedConversationId, true)
                    .catch((error) => reportDiscourseError(error, 'Could not refresh the conversation.'))}
                >
                  Try again
                </button>
              ) : null}
            </div>
          ) : null}
          {interruptedAcceptedSends.length > 0 ? (
            <div className="tm-discourse-status-banner" role="status">
              <span>
                <strong>Agent response setup was interrupted</strong>
                Your message and agent choices are saved. Resume safely or cancel the response.
              </span>
              <div className="tm-discourse-status-banner__actions">
                <button
                  type="button"
                  disabled={Boolean(acceptedSendActionId)}
                  onClick={() => void resumeAcceptedSend(interruptedAcceptedSends[0]!.id)}
                >
                  {acceptedSendActionId === interruptedAcceptedSends[0]!.id ? 'Working…' : 'Resume'}
                </button>
                <button
                  type="button"
                  disabled={Boolean(acceptedSendActionId)}
                  onClick={() => void cancelAcceptedSend(interruptedAcceptedSends[0]!.id)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
          {aggregate && unanchoredResponseWave ? (
            <ol className="tm-discourse-messages tm-discourse-messages--unanchored-wave">
              <DiscourseResponseGroup
                aggregate={aggregate}
                wave={unanchoredResponseWave}
                streamDrafts={streamDrafts}
                onStop={(waveId) => void stopWave(waveId)}
                onConfirm={(waveId) => void confirmWaveContext(waveId)}
                onRetry={prepareWaveRetry}
              />
            </ol>
          ) : null}
          {previousCursor ? (
            <button type="button" className="tm-discourse-load-older" onClick={() => void loadOlder()}>
              Load earlier messages
            </button>
          ) : null}
          {conversationLoadFailed ? (
            <div className="tm-discourse-empty" role="alert">
              <span className="tm-discourse-empty__mark"><RoundtableIcon /></span>
              <h2>Conversation unavailable</h2>
              <p>{conversationLoadState.detail ?? 'The conversation could not be loaded.'}</p>
              <button
                type="button"
                className="tm-btn tm-btn--soft"
                onClick={() => selectedConversationId && void loadConversation(selectedConversationId)
                  .catch((error) => reportDiscourseError(error, 'Could not load the conversation.'))}
              >
                Try again
              </button>
            </div>
          ) : conversationPending ? (
            <div className="tm-discourse-empty tm-discourse-empty--loading" aria-busy="true">
              <span className="tm-discourse-empty__mark"><RoundtableIcon /></span>
              <h2>Loading conversation…</h2>
              <p>Restoring messages, participants, and their saved agent configurations.</p>
            </div>
          ) : messages.length === 0 ? (
            <div className="tm-discourse-empty">
              <span className="tm-discourse-empty__mark"><RoundtableIcon /></span>
              <h2>{newConversation ? 'Start a technical conversation' : 'Nothing has been said yet'}</h2>
              <p>Write a note, compare an approach, or attach a task or repository with <kbd>@</kbd>.</p>
            </div>
          ) : (
            <ol className="tm-discourse-messages">
              {messages.map((message) => (
                <Fragment key={message.id}>
                  <DiscourseMessage
                    message={message}
                    replyTarget={findReplyTarget(messages, message)}
                    context={messageContext(aggregate, message)}
                    job={aggregate?.jobs.find((job) => job.id === message.jobId)}
                    onNavigate={(messageId) => navigateToMessage(messageId)}
                    onReply={() => {
                      setReplyTargetId(message.replyToMessageId ?? message.id);
                      setCorrectionTargetId(undefined);
                    }}
                    onCorrect={() => {
                      setCorrectionTargetId(message.id);
                      setReplyTargetId(undefined);
                      setComposer({
                        ...createDiscourseComposerMentionState(message.body),
                        tokens: composer.tokens
                      });
                      setComposerVersion((value) => value + 1);
                    }}
                    onDelete={() => setConfirmAction({ type: 'delete-message', message })}
                    onAskAuthor={() => prepareAgentFollowUp(message, 'AUTHOR')}
                    onAskOthers={() => prepareAgentFollowUp(message, 'OTHERS')}
                    selectedAsSource={selectedSourceMessageIds.includes(message.id)}
                    onToggleSource={() => setSelectedSourceMessageIds((current) =>
                      current.includes(message.id)
                        ? current.filter((id) => id !== message.id)
                        : [...current, message.id]
                    )}
                  />
                  {aggregate ? responseWavePlacements
                    .filter((placement) => placement.afterMessageId === message.id)
                    .map(({ wave }) => (
                      <DiscourseResponseGroup
                        key={wave.id}
                        aggregate={aggregate}
                        wave={wave}
                        streamDrafts={streamDrafts}
                        onStop={(waveId) => void stopWave(waveId)}
                        onConfirm={(waveId) => void confirmWaveContext(waveId)}
                        onRetry={prepareWaveRetry}
                      />
                    )) : null}
                </Fragment>
              ))}
            </ol>
          )}
            <div aria-hidden="true" className="tm-discourse-transcript__end" />
          </div>
          {newResponses ? (
            <button
              type="button"
              className="tm-discourse-new-responses"
              onClick={() => {
                scrollTranscriptToBottom(transcriptRef.current);
                setNewResponses(false);
              }}
            >
              New responses ↓
            </button>
          ) : null}
        </div>

        <div className="tm-discourse-composer-wrap">
          {selectedSourceMessageIds.length > 0 ? (
            <div className="tm-discourse-selection-bar" role="status">
              <span>{selectedSourceMessageIds.length} message{selectedSourceMessageIds.length === 1 ? '' : 's'} selected</span>
              <div>
                <button type="button" disabled={selectedSourceMessageIds.length < 2} onClick={prepareSynthesis}>Synthesize selected</button>
                <button type="button" onClick={() => setSelectedSourceMessageIds([])}>Clear</button>
              </div>
            </div>
          ) : null}
          {replyTarget ? (
            <ComposerTarget label={`Replying to ${messageAuthorLabel(replyTarget)}`} message={replyTarget} onRemove={() => setReplyTargetId(undefined)} />
          ) : null}
          {correctionTarget ? (
            <ComposerTarget label="Correcting your earlier message" message={correctionTarget} onRemove={() => setCorrectionTargetId(undefined)} />
          ) : null}
          <div className="tm-discourse-composer">
            {responsePolicy !== 'NONE' && catalog ? (
              <DiscourseAgentConfigurationBar
                aggregate={aggregate}
                catalog={catalog}
                compact={compactLayout}
                disabled={sending || composerUnavailable || aggregate?.conversation.status === 'ARCHIVED'}
                expanded={agentConfigOpen}
                policy={responsePolicy}
                selections={activeAgentSelections}
                selectedProfileIds={activeAgentProfileIds}
                onDiscoverModels={discoverAgentModels}
                onExpandedChange={setAgentConfigOpen}
                onToggleAgent={toggleRespondingAgent}
                onSelectionChange={updateAgentSelection}
              />
            ) : null}
            <DiscourseMentionInput
              key={`${selectedConversationId ?? 'new'}:${composerVersion}`}
              candidates={candidates}
              initialText={composer.text}
              initialTokens={composer.tokens}
              showAgentTokens={false}
              autoFocus={messages.length === 0}
              disabled={sending || composerUnavailable || aggregate?.conversation.status === 'ARCHIVED'}
              label="Message"
              placeholder={conversationUnavailable
                ? conversationPending ? 'Loading conversation…' : 'Conversation unavailable'
                : activeDraftAlreadySent
                  ? 'Finishing message recovery…'
                  : responseDecisionPending
                  ? 'Resume or cancel the interrupted response first'
                : aggregate?.conversation.status === 'ARCHIVED'
                  ? 'Restore this conversation to add a message'
                  : 'Write a message… Type @ for agents, tasks, or repositories'}
              onChange={updateComposer}
              onSubmit={(state) => void send(state)}
            />
            {contextTokens.length > 0 && aggregate ? (
              <div className="tm-discourse-pin-actions" aria-label="Pin message context">
                {contextTokens.map((token) => {
                  const alreadyPinned = pinned.some(
                    (reference) => reference.entityKind === token.kind && reference.entityId === token.entityId
                  );
                  return alreadyPinned ? null : (
                    <button
                      key={token.key}
                      type="button"
                      onClick={() => void pinContext(token.kind as 'TASK' | 'REPOSITORY', token.entityId)}
                    >
                      <PinIcon /> Pin {token.labelSnapshot}
                    </button>
                  );
                })}
              </div>
            ) : null}
            <div className="tm-discourse-composer__actions">
              <div className="tm-discourse-policy">
                <span className="tm-discourse-policy__mark"><PersonIcon /></span>
                <span>
                  <label>
                    <span className="tm-visually-hidden">Response policy</span>
                    <select
                      value={responsePolicy}
                      disabled={sending || composerUnavailable || aggregate?.conversation.status === 'ARCHIVED'}
                      onChange={(event) => changeResponsePolicy(event.target.value as DiscourseDefaultPolicy)}
                    >
                      <option value="NONE">No agents</option>
                      <option value="DIRECT">Direct</option>
                      <option value="PANEL">Panel</option>
                      <option value="TEAM" disabled={!teamReady}>Team</option>
                    </select>
                  </label>
                  <small>{responseReadiness.detail}</small>
                </span>
              </div>
              <div className="tm-discourse-composer__buttons">
                <button
                  type="button"
                  className="tm-discourse-preview-button"
                  aria-label={previewLoading ? 'Resolving agent context' : 'What agents will see'}
                  disabled={previewLoading || composerUnavailable}
                  onClick={() => void showPreview()}
                >
                  <ContextIcon />
                  <span>{previewLoading ? 'Resolving…' : 'What agents will see'}</span>
                </button>
                <button
                  type="button"
                  className="tm-discourse-send"
                  disabled={!composer.text.trim() || !safeResponseReady || sending || composerUnavailable || aggregate?.conversation.status === 'ARCHIVED'}
                  aria-describedby={!safeResponseReady ? 'discourse-response-requirement' : undefined}
                  onClick={() => void send()}
                >
                  {sending ? 'Sending…' : 'Send'}
                  <kbd>⌘↵</kbd>
                </button>
              </div>
            </div>
            {!safeResponseReady && responsePolicy !== 'NONE' ? (
              <p id="discourse-response-requirement" className="tm-discourse-composer__requirement" role="status">
                {responseRequirement}
              </p>
            ) : null}
          </div>
        </div>
      </section>

      {inspectorOpen ? (
        <InspectorDrawer onClose={() => setInspectorOpen(false)}>
          <InspectorSection title="Pinned for future responses" count={pinned.length}>
            {pinned.length === 0 ? (
              <p className="tm-discourse-inspector__empty">Nothing is attached automatically. Mention a task or repository, then pin it explicitly.</p>
            ) : (
              <ul className="tm-discourse-context-list">
                {pinned.map((reference) => (
                  <li key={reference.contextLinkId}>
                    <span className={`tm-discourse-context-kind tm-discourse-context-kind--${reference.entityKind.toLowerCase()}`}>
                      {reference.entityKind === 'TASK' ? <TaskIcon /> : <RepositoryIcon />}
                    </span>
                    <span><strong>{reference.labelSnapshot}</strong><small>{reference.entityKind === 'TASK' ? 'Task context' : 'Repository context'} · {availabilityLabel(reference.availability)}</small></span>
                    <button type="button" aria-label={`Unpin ${reference.labelSnapshot}`} onClick={() => void unpinContext(reference)}>×</button>
                  </li>
                ))}
              </ul>
            )}
          </InspectorSection>
          <InspectorSection title="Response policy">
            <div className="tm-discourse-inspector__policy">
              <strong>{discourseResponsePolicyLabel(responsePolicy)}</strong>
              <p>{responsePolicyDescription(responsePolicy)}</p>
            </div>
          </InspectorSection>
          <InspectorSection title="Participants" count={aggregate?.participants.length ?? 0}>
            {currentDiscourseParticipantRevisions(aggregate).length ? (
              <ul className="tm-discourse-participants">
                {currentDiscourseParticipantRevisions(aggregate).map((participant) => {
                  const runtime = catalog?.runtimeCatalog.runtimes.find(
                    (candidate) => candidate.preflight.runtime.id === participant.runtimeId
                  );
                  return (
                    <li key={participant.id}>
                      <span>{participant.displayNameSnapshot.slice(0, 1)}</span>
                      <div>
                        <strong>{participant.displayNameSnapshot}</strong>
                        <small>
                          {capitalize(participant.configuredRole)} ·{' '}
                          {runtime?.preflight.runtime.displayName ?? 'Unavailable provider'} ·{' '}
                          {participant.model}
                        </small>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : <p className="tm-discourse-inspector__empty">No agents are bound to this human-only conversation.</p>}
          </InspectorSection>
          <InspectorSection title="Access policy">
            <dl className="tm-discourse-access-policy">
              <div><dt>Files</dt><dd>Read only</dd></div>
              <div><dt>Network</dt><dd>Off</dd></div>
              <div><dt>Tools & apps</dt><dd>Off</dd></div>
              <div><dt>Approvals</dt><dd>Never</dd></div>
            </dl>
          </InspectorSection>
        </InspectorDrawer>
      ) : null}

      {preview ? <ContextPreview preview={preview} onClose={() => setPreview(undefined)} /> : null}
      {confirmAction?.type === 'delete-conversation' ? (
        <ConfirmDialog
          title="Delete conversation?"
          body="This removes the transcript and its Task Monki discourse records. Referenced tasks and repositories are not changed."
          confirmLabel="Delete conversation"
          onCancel={() => setConfirmAction(undefined)}
          onConfirm={() => void deleteConversation()}
        />
      ) : null}
      {confirmAction?.type === 'delete-message' ? (
        <ConfirmDialog
          title="Delete message?"
          body="The message will remain as a deleted entry so replies and conversation history stay coherent."
          confirmLabel="Delete message"
          onCancel={() => setConfirmAction(undefined)}
          onConfirm={() => {
            const message = confirmAction.message;
            setConfirmAction(undefined);
            void tombstoneMessage(message);
          }}
        />
      ) : null}
    </main>
  );
}

function ComposerTarget({ label, message, onRemove }: { label: string; message: DiscourseMessageRecord; onRemove(): void }) {
  return (
    <div className="tm-discourse-composer-target">
      <span><strong>{label}</strong><small>{compactText(message.body, 120)}</small></span>
      <button type="button" aria-label="Remove reply target" onClick={onRemove}>×</button>
    </div>
  );
}

function navigateToMessage(messageId: string): void {
  const target = document.getElementById(`discourse-message-${messageId}`);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  target?.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
  target?.focus({ preventScroll: true });
  target?.classList.add('tm-discourse-message--highlight');
  window.setTimeout(() => target?.classList.remove('tm-discourse-message--highlight'), 1_200);
}

function scrollTranscriptToBottom(container: HTMLDivElement | null): void {
  if (container) container.scrollTop = container.scrollHeight;
}

function dedupeMessages(messages: DiscourseMessageRecord[]): DiscourseMessageRecord[] {
  return [...new Map(messages.map((message) => [message.id, message])).values()]
    .sort((left, right) => left.ordinal - right.ordinal);
}

function dedupeContextSelections<T extends { entityKind: string; entityId: string }>(values: T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.entityKind}:${value.entityId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function deriveConversationTitle(body: string): string {
  const first = body.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? 'New conversation';
  return first.length <= 72 ? first : `${first.slice(0, 69).trimEnd()}…`;
}

function pendingConversationFingerprint(
  title: string,
  policy: DiscourseDefaultPolicy,
  selections: DiscourseAgentSelectionInput[]
): string {
  return JSON.stringify({
    title,
    policy,
    agents: [...selections]
      .sort((left, right) => left.agentProfileId.localeCompare(right.agentProfileId))
      .map((selection) => ({
        agentProfileId: selection.agentProfileId,
        runtimeId: selection.runtimeId ?? '',
        modelId: selection.modelId ?? '',
        reasoningEffort: selection.reasoningEffort ?? ''
      }))
  });
}

function compactText(value: string, limit: number): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1).trimEnd()}…`;
}

function availabilityLabel(value: string): string {
  return value === 'AVAILABLE' ? 'Available' : value === 'TOMBSTONED' ? 'Historical only' : 'Unavailable';
}

function responsePolicyDescription(policy: DiscourseDefaultPolicy): string {
  switch (policy) {
    case 'NONE': return 'Messages persist without starting agent work.';
    case 'DIRECT': return 'One selected agent gives a focused response.';
    case 'PANEL': return 'Two or three selected agents answer independently from the same frozen context.';
    case 'TEAM': return 'Lead answers, Skeptic and Verifier review independently, and Lead corrects material concerns once.';
  }
}

function capitalize(value: string): string {
  return value.charAt(0) + value.slice(1).toLocaleLowerCase();
}

function isBuiltInAgentProfileId(
  value: string
): value is 'builtin.lead' | 'builtin.skeptic' | 'builtin.verifier' {
  return ['builtin.lead', 'builtin.skeptic', 'builtin.verifier'].includes(value);
}

const ICON = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
function ContextIcon() { return <svg {...ICON}><path d="M4 5h16v14H4zM9 5v14" /></svg>; }
function SidebarIcon() { return <svg {...ICON}><path d="M4 5h16v14H4zM9 5v14M6.5 8h.01M6.5 11h.01" /></svg>; }
function PersonIcon() { return <svg {...ICON}><circle cx="12" cy="8" r="3" /><path d="M5 20c.8-4 3.1-6 7-6s6.2 2 7 6" /></svg>; }
function RoundtableIcon() { return <svg {...ICON} width={28} height={28}><circle cx="12" cy="12" r="4" /><circle cx="5" cy="7" r="2" /><circle cx="19" cy="7" r="2" /><circle cx="5" cy="18" r="2" /><circle cx="19" cy="18" r="2" /></svg>; }
