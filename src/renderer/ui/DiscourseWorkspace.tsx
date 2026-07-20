import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import type {
  ConversationContextReferenceSnapshot,
  DiscourseConversationAggregateRecord,
  DiscourseConversationSummary,
  DiscourseContextPreview,
  DiscourseDraftRecord,
  DiscourseDefaultPolicy,
  DiscourseWavePolicy,
  DiscourseMessageRecord,
  DiscourseMentionCatalogSnapshot
} from '../../shared/discourse';
import { taskManagerApi } from '../api/taskManagerClient';
import { listDiscourseConversationSnapshot } from '../api/discoursePaging';
import {
  composerTokensFromDraft,
  currentPinnedContext,
  discourseConcernResolutionLabel,
  discourseJobStatusLabel,
  discourseMentionCandidates,
  discourseReviewResultLabel,
  discourseTeamCompletionSummary,
  discourseTerminalJobDetail,
  draftTokensFromComposer,
  findReplyTarget,
  isNearScrollBottom,
  messageAuthorLabel,
  messageContext,
  shouldShowNewResponses,
  visibleDiscourseResponseWavePlacements,
  visibleConversationSummaries
} from '../model/discourse';
import type { DiscourseComposerMentionState } from '../model/discourseMentions';
import { createDiscourseComposerMentionState } from '../model/discourseMentions';
import { DiscourseDraftAutosaveCoordinator } from '../model/discourseDraftAutosave';
import { DiscourseMarkdown } from './DiscourseMarkdown';
import { DiscourseMentionInput } from './DiscourseMentionInput';

interface DiscourseWorkspaceProps {
  onNotify(message: string, tone?: 'info' | 'success' | 'error'): void;
  onError(error: unknown, fallback: string): void;
}

type ConfirmAction = 'delete-conversation' | undefined;

export function DiscourseWorkspace({ onNotify, onError }: DiscourseWorkspaceProps) {
  const [conversations, setConversations] = useState<DiscourseConversationSummary[]>([]);
  const [aggregate, setAggregate] = useState<DiscourseConversationAggregateRecord>();
  const [messages, setMessages] = useState<DiscourseMessageRecord[]>([]);
  const [previousCursor, setPreviousCursor] = useState<string>();
  const [catalog, setCatalog] = useState<DiscourseMentionCatalogSnapshot>();
  const [drafts, setDrafts] = useState<DiscourseDraftRecord[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string>();
  const [newConversation, setNewConversation] = useState(false);
  const [railQuery, setRailQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [sending, setSending] = useState(false);
  const [composerVersion, setComposerVersion] = useState(0);
  const [composer, setComposer] = useState<DiscourseComposerMentionState>(() =>
    createDiscourseComposerMentionState()
  );
  const [responsePolicy, setResponsePolicy] = useState<DiscourseDefaultPolicy>('NONE');
  const [replyTargetId, setReplyTargetId] = useState<string>();
  const [correctionTargetId, setCorrectionTargetId] = useState<string>();
  const [selectedSourceMessageIds, setSelectedSourceMessageIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<DiscourseContextPreview>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(() =>
    window.matchMedia('(min-width: 1181px)').matches
  );
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>();
  const [newResponses, setNewResponses] = useState(false);
  const [streamDrafts, setStreamDrafts] = useState<Record<string, string>>({});
  const transcriptRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<DiscourseMessageRecord[]>([]);
  const draftAutosaveRef = useRef<DiscourseDraftAutosaveCoordinator | undefined>(undefined);
  draftAutosaveRef.current ??= new DiscourseDraftAutosaveCoordinator();
  const draftAutosave = draftAutosaveRef.current;
  const conversationLoadGeneration = useRef(0);
  const selectedConversationIdRef = useRef<string | undefined>(undefined);

  const refreshSummaries = useCallback(async () => {
    const next = await listDiscourseConversationSnapshot(taskManagerApi);
    setConversations(next);
    return next;
  }, []);

  const refreshDrafts = useCallback(async () => {
    const next = await taskManagerApi.listDiscourseDrafts();
    setDrafts(next);
    return next;
  }, []);

  const loadConversation = useCallback(async (conversationId: string, preserveScroll = false) => {
    const loadGeneration = ++conversationLoadGeneration.current;
    setLoadingConversation(true);
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
      if (loadGeneration !== conversationLoadGeneration.current) return;
      setAggregate(nextAggregate);
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
      if (loadGeneration === conversationLoadGeneration.current) throw error;
    } finally {
      if (loadGeneration === conversationLoadGeneration.current) {
        setLoadingConversation(false);
      }
    }
  }, []);

  useEffect(() => {
    let canceled = false;
    void Promise.all([
      refreshSummaries(),
      taskManagerApi.getDiscourseMentionCatalog(),
      refreshDrafts()
    ]).then(([summaries, nextCatalog]) => {
      if (canceled) return;
      setCatalog(nextCatalog);
      if (summaries.length > 0) {
        const first = summaries.find((conversation) => conversation.status === 'OPEN') ?? summaries[0];
        selectedConversationIdRef.current = first?.id;
        setSelectedConversationId(first?.id);
      } else {
        setNewConversation(true);
      }
    }).catch((error) => {
      if (!canceled) onError(error, 'Could not load Discourse.');
    }).finally(() => {
      if (!canceled) setLoading(false);
    });
    return () => {
      canceled = true;
    };
  }, [onError, refreshDrafts, refreshSummaries]);

  useEffect(() => {
    if (!selectedConversationId) {
      conversationLoadGeneration.current += 1;
      setLoadingConversation(false);
      setAggregate(undefined);
      setMessages([]);
      messagesRef.current = [];
      setPreviousCursor(undefined);
      setSelectedSourceMessageIds([]);
      return;
    }
    void loadConversation(selectedConversationId).catch((error) =>
      onError(error, 'Could not load the conversation.')
    );
    return () => {
      conversationLoadGeneration.current += 1;
    };
  }, [loadConversation, onError, selectedConversationId]);

  useEffect(() => taskManagerApi.onUpdate((event) => {
    if (event.type === 'runtime.updated') {
      void taskManagerApi.getDiscourseMentionCatalog()
        .then(setCatalog)
        .catch((error) => onError(error, 'Could not refresh agent availability.'));
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
    void refreshSummaries().catch((error) =>
      onError(error, 'Could not refresh Discourse conversations.')
    );
    const activeConversationId = selectedConversationIdRef.current;
    if (event.scope.conversationId === activeConversationId) {
      void loadConversation(activeConversationId, true).catch((error) =>
        onError(error, 'Could not refresh the conversation.')
      );
    }
  }), [loadConversation, onError, refreshSummaries]);

  useEffect(() => {
    const compactLayout = window.matchMedia('(max-width: 1180px)');
    const closeOverlayInspector = (event: MediaQueryListEvent) => {
      if (event.matches) setInspectorOpen(false);
    };
    compactLayout.addEventListener('change', closeOverlayInspector);
    return () => compactLayout.removeEventListener('change', closeOverlayInspector);
  }, []);

  const activeDraft = useMemo(() => {
    if (selectedConversationId) {
      return drafts.find((draft) => draft.conversationId === selectedConversationId);
    }
    if (newConversation) return drafts.find((draft) => !draft.conversationId);
    return undefined;
  }, [drafts, newConversation, selectedConversationId]);

  useEffect(() => {
    draftAutosave.activate(selectedConversationId, activeDraft);
    setReplyTargetId(activeDraft?.replyToMessageId);
    setCorrectionTargetId(undefined);
    setSelectedSourceMessageIds([]);
    const next = {
      ...createDiscourseComposerMentionState(activeDraft?.body ?? ''),
      tokens: composerTokensFromDraft(activeDraft?.tokens ?? [])
    };
    const defaultPolicy = activeDraft?.policy ??
      conversations.find((conversation) => conversation.id === selectedConversationId)?.defaultPolicy ??
      'NONE';
    setResponsePolicy(defaultPolicy);
    setComposer(next);
    setComposerVersion((value) => value + 1);
  // Draft content is restored when navigation changes. Saving the first
  // revision must not remount the focused composer merely because it gained an id.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newConversation, selectedConversationId]);

  useEffect(() => {
    if (!selectedConversationId && !newConversation) return;
    const scope = draftAutosave.currentScope();
    if (!scope) return;
    const timer = window.setTimeout(() => {
      const snapshot = composer;
      void draftAutosave
        .enqueue(scope, async (existing) => {
          if (
            !snapshot.text &&
            snapshot.tokens.length === 0 &&
            !replyTargetId &&
            !existing
          ) return;
          const saved = await taskManagerApi.saveDiscourseDraft({
            ...(existing ? { draftId: existing.id, expectedRevision: existing.recordRevision } : {}),
            ...(scope.conversationId ? { conversationId: scope.conversationId } : {}),
            body: snapshot.text,
            ...(replyTargetId ? { replyToMessageId: replyTargetId } : {}),
            policy: responsePolicy,
            recipientParticipantIds: [],
            tokens: draftTokensFromComposer(snapshot.tokens)
          });
          return saved;
        })
        .then(({ saved }) => {
          if (!saved) return;
          setDrafts((current) => [
            saved,
            ...current.filter((draft) => draft.id !== saved.id)
          ]);
        })
        .catch((error) => onError(error, 'Could not save the discourse draft.'));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [composer, draftAutosave, newConversation, onError, replyTargetId, responsePolicy, selectedConversationId]);

  const candidates = useMemo(
    () => catalog ? discourseMentionCandidates(catalog, activeDraft?.tokens) : [],
    [activeDraft?.tokens, catalog]
  );
  const selectedSummary = conversations.find(
    (conversation) => conversation.id === selectedConversationId
  );
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
  const contextTokens = composer.tokens.filter((token) => token.kind !== 'AGENT');
  const selectedAgentProfileIds = composer.tokens
    .filter((token) => token.kind === 'AGENT')
    .map((token) => token.entityId)
    .filter(isBuiltInAgentProfileId);
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
  const responseReady = responsePolicy === 'NONE' || (responsePolicy === 'TEAM' && teamReady) ||
    (responsePolicy === 'DIRECT' && selectedAgentProfileIds.length === 1) ||
    (responsePolicy === 'PANEL' && selectedAgentProfileIds.length >= 2 && selectedAgentProfileIds.length <= 3);
  const safeResponseReady = responseReady && selectedAgentsReady;

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
    if (policy !== 'NONE' && policy !== 'TEAM') return;
    const next = {
      ...composer,
      tokens: composer.tokens.filter((token) => token.kind !== 'AGENT')
    };
    setComposer(next);
    setComposerVersion((value) => value + 1);
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

  const selectConversation = (conversationId: string) => {
    conversationLoadGeneration.current += 1;
    selectedConversationIdRef.current = conversationId;
    setNewConversation(false);
    setSelectedConversationId(conversationId);
    setPreview(undefined);
    setNewResponses(false);
  };

  const startNewConversation = () => {
    conversationLoadGeneration.current += 1;
    selectedConversationIdRef.current = undefined;
    setSelectedConversationId(undefined);
    setNewConversation(true);
    setAggregate(undefined);
    setMessages([]);
    messagesRef.current = [];
    setPreview(undefined);
  };

  const send = async (state = composer) => {
    const body = state.text.trim();
    if (!body || sending) return;
    const draftScope = draftAutosave.currentScope();
    const explicitlySelectedAgents = state.tokens
      .filter((token) => token.kind === 'AGENT')
      .map((token) => token.entityId)
      .filter(isBuiltInAgentProfileId);
    const agentProfileIds = responsePolicy === 'TEAM'
      ? ['builtin.lead', 'builtin.skeptic', 'builtin.verifier'] as const
      : responsePolicy === 'NONE'
        ? []
        : explicitlySelectedAgents;
    if (responsePolicy === 'TEAM' && !teamReady) {
      onNotify('Team responses require all three agents to be available.', 'info');
      return;
    }
    if (responsePolicy === 'DIRECT' && agentProfileIds.length !== 1) {
      onNotify('Choose one agent for a Direct response.', 'info');
      return;
    }
    if (responsePolicy === 'PANEL' && (agentProfileIds.length < 2 || agentProfileIds.length > 3)) {
      onNotify('Choose two or three agents for a Panel response.', 'info');
      return;
    }
    setSending(true);
    const sentPolicy = responsePolicy;
    try {
      let conversationId = selectedConversationId;
      if (!conversationId) {
        const created = await taskManagerApi.createDiscourseConversation({
          title: deriveConversationTitle(body),
          defaultPolicy: responsePolicy,
          participantProfileIds: [...agentProfileIds],
          clientOperationId: crypto.randomUUID()
        });
        conversationId = created.id;
        selectedConversationIdRef.current = created.id;
        setSelectedConversationId(created.id);
        setNewConversation(false);
      }
      const messageContext = state.tokens.flatMap((token) =>
        token.kind === 'AGENT'
          ? []
          : [{ entityKind: token.kind, entityId: token.entityId }]
      );
      const contextPreview = responsePolicy !== 'NONE'
        ? await taskManagerApi.previewDiscourseContext({
            conversationId,
            messageContext
          })
        : undefined;
      await taskManagerApi.sendDiscourseMessage({
        conversationId,
        body,
        ...(replyTargetId ? { replyToMessageId: replyTargetId } : {}),
        ...(correctionTargetId ? { supersedesMessageId: correctionTargetId } : {}),
        ...(selectedSourceMessageIds.length > 0
          ? { sourceMessageIds: selectedSourceMessageIds }
          : {}),
        context: messageContext,
        clientMessageId: crypto.randomUUID(),
        policy: responsePolicy,
        agentProfileIds: [...agentProfileIds],
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
      setDrafts((current) => current.filter((draft) => draft.id !== savedDraft?.id));
      setReplyTargetId(undefined);
      setCorrectionTargetId(undefined);
      setSelectedSourceMessageIds([]);
      setComposer(createDiscourseComposerMentionState());
      setComposerVersion((value) => value + 1);
      await Promise.all([refreshSummaries(), loadConversation(conversationId)]);
      setResponsePolicy(sentPolicy);
      onNotify(responsePolicy === 'NONE' ? 'Message added.' : 'Response queued.', 'success');
    } catch (error) {
      onError(error, 'Could not send the message.');
    } finally {
      setSending(false);
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
      onError(error, 'Could not load older messages.');
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
      onError(error, 'Could not resolve the context preview.');
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
      onError(error, 'Could not pin context.');
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
      onError(error, 'Could not remove pinned context.');
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
      onError(error, 'Could not rename the conversation.');
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
      onError(error, archived ? 'Could not archive the conversation.' : 'Could not restore the conversation.');
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
      onError(error, 'Could not delete the conversation.');
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
      onError(error, 'Could not delete the message.');
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
      onError(error, 'Could not stop the response.');
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
      onError(error, 'Could not confirm the updated context.');
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
      showArchived ? conversation.status === 'ARCHIVED' : conversation.status === 'OPEN'
    ),
    railQuery
  );

  if (loading) {
    return <div className="tm-discourse tm-discourse--loading" aria-busy="true">Loading Discourse…</div>;
  }

  return (
    <main className="tm-discourse">
      <aside className="tm-discourse-rail" aria-label="Discourse conversations">
        <div className="tm-discourse-rail__head">
          <div>
            <h1>Discourse</h1>
            <p>Technical conversations across tasks and repositories</p>
          </div>
          <button type="button" className="tm-discourse-new" onClick={startNewConversation}>
            <PlusIcon />
            <span>New</span>
          </button>
        </div>
        <label className="tm-discourse-search">
          <SearchIcon />
          <span className="sr-only">Search conversation titles</span>
          <input
            value={railQuery}
            placeholder="Search conversations"
            onChange={(event) => setRailQuery(event.target.value)}
          />
        </label>
        <div className="tm-discourse-rail__filter" role="group" aria-label="Conversation status">
          <button
            type="button"
            aria-pressed={!showArchived}
            onClick={() => setShowArchived(false)}
          >
            Recent
          </button>
          <button
            type="button"
            aria-pressed={showArchived}
            onClick={() => setShowArchived(true)}
          >
            Archive
          </button>
        </div>
        <div className="tm-discourse-rail__list">
          {newConversation && !showArchived ? (
            <button className="tm-discourse-thread tm-discourse-thread--active" type="button">
              <span className="tm-discourse-thread__title">New conversation</span>
              <small>Draft</small>
            </button>
          ) : null}
          {displayedConversations.map((conversation) => (
            <button
              type="button"
              key={conversation.id}
              className={`tm-discourse-thread ${
                conversation.id === selectedConversationId ? 'tm-discourse-thread--active' : ''
              }`}
              onClick={() => selectConversation(conversation.id)}
            >
              <span className="tm-discourse-thread__title">{conversation.title}</span>
              <span className="tm-discourse-thread__meta">
                {conversation.needsAttention ? <span className="tm-discourse-attention">Needs attention</span> : null}
                {conversation.unreadCount > 0 ? (
                  <span className="tm-discourse-unread" aria-label={`${conversation.unreadCount} unread`}>
                    {conversation.unreadCount}
                  </span>
                ) : (
                  <time>{formatCompactDate(conversation.lastMessageAt ?? conversation.updatedAt)}</time>
                )}
              </span>
            </button>
          ))}
          {displayedConversations.length === 0 && !newConversation ? (
            <p className="tm-discourse-rail__empty">
              {railQuery ? 'No titles match your search.' : showArchived ? 'No archived conversations.' : 'No conversations yet.'}
            </p>
          ) : null}
        </div>
      </aside>

      <section className="tm-discourse-conversation">
        <header className="tm-discourse-header">
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
                  onBlur={() => void renameConversation()}
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
                {aggregate?.conversation.title ?? 'New conversation'}
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
              <details className="tm-discourse-menu">
                <summary aria-label="Conversation actions">•••</summary>
                <div>
                  <button type="button" onClick={() => void setArchived(aggregate.conversation.status !== 'ARCHIVED')}>
                    {aggregate.conversation.status === 'ARCHIVED' ? 'Restore conversation' : 'Archive conversation'}
                  </button>
                  <button type="button" className="tm-discourse-menu__danger" onClick={() => setConfirmAction('delete-conversation')}>
                    Delete conversation
                  </button>
                </div>
              </details>
            ) : null}
          </div>
        </header>

        <div
          className="tm-discourse-transcript"
          ref={transcriptRef}
          onScroll={(event) => {
            if (isNearScrollBottom(event.currentTarget)) setNewResponses(false);
          }}
        >
          {previousCursor ? (
            <button type="button" className="tm-discourse-load-older" onClick={() => void loadOlder()}>
              Load earlier messages
            </button>
          ) : null}
          {loadingConversation ? <div className="tm-discourse-transcript__loading">Updating…</div> : null}
          {messages.length === 0 ? (
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
                    onDelete={() => void tombstoneMessage(message)}
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
            <DiscourseMentionInput
              key={`${selectedConversationId ?? 'new'}:${composerVersion}`}
              candidates={candidates}
              initialText={composer.text}
              initialTokens={composer.tokens}
              autoFocus={messages.length === 0}
              disabled={sending || aggregate?.conversation.status === 'ARCHIVED'}
              label="Message"
              placeholder={aggregate?.conversation.status === 'ARCHIVED' ? 'Restore this conversation to add a message' : 'Write a message… Type @ for agents, tasks, or repositories'}
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
                    <span className="sr-only">Response policy</span>
                    <select
                      value={responsePolicy}
                      disabled={sending || aggregate?.conversation.status === 'ARCHIVED'}
                      onChange={(event) => changeResponsePolicy(event.target.value as DiscourseDefaultPolicy)}
                    >
                      <option value="NONE">No agents</option>
                      <option value="DIRECT">Direct</option>
                      <option value="PANEL">Panel</option>
                      <option value="TEAM" disabled={!teamReady}>Team</option>
                    </select>
                  </label>
                  <small>{responsePolicyDetail(responsePolicy, selectedAgentProfileIds.length, teamReady)}</small>
                </span>
              </div>
              <div className="tm-discourse-composer__buttons">
                <button
                  type="button"
                  className="tm-discourse-preview-button"
                  disabled={previewLoading}
                  onClick={() => void showPreview()}
                >
                  {previewLoading ? 'Resolving…' : 'What agents will see'}
                </button>
                <button
                  type="button"
                  className="tm-discourse-send"
                  disabled={!composer.text.trim() || !safeResponseReady || sending || aggregate?.conversation.status === 'ARCHIVED'}
                  title={!safeResponseReady ? responsePolicyRequirement(responsePolicy, teamReady) : undefined}
                  onClick={() => void send()}
                >
                  {sending ? 'Sending…' : 'Send'}
                  <kbd>⌘↵</kbd>
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {inspectorOpen ? (
        <aside className="tm-discourse-inspector" aria-label="Conversation context and details">
          <div className="tm-discourse-inspector__head">
            <h2>Context</h2>
            <button type="button" className="tm-iconbtn" aria-label="Close context inspector" onClick={() => setInspectorOpen(false)}>×</button>
          </div>
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
              <strong>{responsePolicyLabel(responsePolicy)}</strong>
              <p>{responsePolicyDescription(responsePolicy)}</p>
            </div>
          </InspectorSection>
          <InspectorSection title="Participants" count={aggregate?.participants.length ?? 0}>
            {aggregate?.participantRevisions.length ? (
              <ul className="tm-discourse-participants">
                {aggregate.participantRevisions.map((participant) => (
                  <li key={participant.id}>
                    <span>{participant.displayNameSnapshot.slice(0, 1)}</span>
                    <div><strong>{participant.displayNameSnapshot}</strong><small>{capitalize(participant.configuredRole)} · {participant.model}</small></div>
                  </li>
                ))}
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
        </aside>
      ) : null}

      {preview ? <ContextPreview preview={preview} onClose={() => setPreview(undefined)} /> : null}
      {confirmAction === 'delete-conversation' ? (
        <ConfirmDialog
          title="Delete conversation?"
          body="This removes the transcript and its Task Monki discourse records. Referenced tasks and repositories are not changed."
          confirmLabel="Delete conversation"
          onCancel={() => setConfirmAction(undefined)}
          onConfirm={() => void deleteConversation()}
        />
      ) : null}
    </main>
  );
}

function DiscourseResponseGroup({
  aggregate,
  wave,
  streamDrafts,
  onStop,
  onConfirm,
  onRetry
}: {
  aggregate: DiscourseConversationAggregateRecord;
  wave: DiscourseConversationAggregateRecord['waves'][number];
  streamDrafts: Record<string, string>;
  onStop(waveId: string): void;
  onConfirm(waveId: string): void;
  onRetry(waveId: string): void;
}) {
  const queuedAfterCurrent = wave.status === 'SETTLED'
    ? 0
    : aggregate.waves.filter(
        (candidate) => candidate.status !== 'SETTLED' && candidate.id !== wave.id
      ).length;
  const jobs = aggregate.jobs.filter((job) => job.waveId === wave.id);
  const reviews = jobs.filter((job) => job.role === 'CRITIQUE');
  const concerns = aggregate.concerns.filter((concern) => concern.waveId === wave.id);
  const activeJobs = jobs.filter((job) => !['COMPLETED', 'FAILED', 'CANCELED', 'CONTEXT_STALE'].includes(job.status));
  const active = activeJobs[0];
  const activelyWorking = active && active.status !== 'RECOVERY_REQUIRED';
  const streamingJobs = jobs.filter(
    (job) => job.role === 'ANSWER' && Boolean(streamDrafts[job.id])
  );
  const completedTeam = wave.policy === 'TEAM' && wave.status === 'SETTLED' && wave.outcome === 'COMPLETE';
  const teamSummary = completedTeam
    ? discourseTeamCompletionSummary({ jobs, concerns })
    : undefined;
  const terminalDetail = discourseTerminalJobDetail(jobs);
  const label = wave.dispatchGate.status === 'RECONFIRMATION_REQUIRED'
    ? 'Context changed before dispatch'
    : teamSummary
      ? teamSummary.label
    : active
      ? active.role === 'CRITIQUE'
        ? 'Reviewing the lead answer'
        : active.role === 'CORRECT'
          ? 'Preparing a correction'
          : wave.policy === 'PANEL'
            ? 'Panel responding'
            : discourseJobStatusLabel(active.status)
      : wave.outcome === 'CANCELED'
        ? 'Response stopped'
        : wave.outcome === 'STALE'
          ? 'Context changed'
          : wave.outcome === 'FAILED' || wave.outcome === 'NO_RESPONSE'
            ? 'Response failed'
            : 'Partial response';
  const detail = wave.dispatchGate.status === 'RECONFIRMATION_REQUIRED'
    ? 'Review the latest context before asking the agent again.'
    : teamSummary
      ? teamSummary.detail
    : active?.status === 'RECOVERY_REQUIRED'
      ? 'Task Monki could not confirm whether this response started. Stop it before trying again.'
    : active
      ? activeJobs.length > 1
        ? `${activeJobs.length} agents are working independently.`
        : `${active.assignment.displayNameSnapshot} · ${active.assignment.model}`
      : terminalDetail ?? waveTerminalDetail(wave.outcome);
  const stoppable = ['PLANNED', 'SNAPSHOTTING', 'QUEUED', 'RUNNING', 'STOP_REQUESTED', 'STOPPING', 'RECOVERY_REQUIRED'].includes(wave.status);
  const retryable = wave.status === 'SETTLED' && wave.outcome !== 'COMPLETE' && wave.outcome !== 'CANCELED';
  return (
    <li
      className="tm-discourse-response"
      aria-live={wave.status === 'SETTLED' ? undefined : 'polite'}
      aria-label="Agent response status"
    >
      <header>
        <span className={`tm-discourse-response__pulse ${activelyWorking ? 'tm-discourse-response__pulse--active' : ''}`} />
        <span><strong>{label}</strong><small>{detail}</small></span>
        {wave.dispatchGate.status === 'RECONFIRMATION_REQUIRED' ? (
          <span className="tm-discourse-response__actions">
            <button type="button" onClick={() => onConfirm(wave.id)}>Continue</button>
            <button type="button" onClick={() => onStop(wave.id)}>Cancel</button>
          </span>
        ) : stoppable
          ? <button type="button" onClick={() => onStop(wave.id)}>Stop</button>
          : retryable
            ? <button type="button" onClick={() => onRetry(wave.id)}>Try again</button>
            : null}
      </header>
      {streamingJobs.length > 0 ? (
        <div className="tm-discourse-response__streams">
          {streamingJobs.map((job) => (
            <div key={job.id}>
              <strong>{job.assignment.displayNameSnapshot}</strong>
              <p>{streamDrafts[job.id]}</p>
            </div>
          ))}
        </div>
      ) : null}
      {reviews.length > 0 ? (
        <ul className="tm-discourse-response__reviews" aria-label="Team review results">
          {reviews.map((review) => (
            <li key={review.id}>
              <span>{review.assignment.displayNameSnapshot}</span>
              <strong>{discourseReviewResultLabel(review)}</strong>
            </li>
          ))}
        </ul>
      ) : null}
      {concerns.length > 0 ? (
        <div className="tm-discourse-response__concerns">
          {concerns.map((concern) => (
            <details key={concern.id}>
              <summary>
                <span>{capitalize(concern.severity)}</span>
                {concern.targetClaim}
                {concern.redundantOfConcernId
                  ? <small>Duplicate signal</small>
                  : discourseConcernResolutionLabel(concern)
                    ? <small>{discourseConcernResolutionLabel(concern)}</small>
                    : null}
              </summary>
              <div className="tm-discourse-response__concern-meta">
                <span>{capitalize(concern.category)}</span>
                <span>{capitalize(concern.evidenceStatus.replaceAll('_', ' '))}</span>
                <span>{capitalize(concern.confidence)} confidence</span>
              </div>
              <p><strong>Why it matters</strong>{concern.reason}</p>
              <p><strong>Evidence</strong>{concern.evidence}</p>
              <p><strong>Suggested resolution</strong>{concern.suggestedResolution}</p>
            </details>
          ))}
        </div>
      ) : null}
      <footer>
        {responsePolicyLabel(wave.policy)} · up to {wave.policy === 'TEAM' ? 4 : wave.assignments.length} agent turn{wave.policy === 'DIRECT' ? '' : 's'}
        {queuedAfterCurrent > 0 ? ` · ${queuedAfterCurrent} follow-up${queuedAfterCurrent === 1 ? '' : 's'} queued` : ''}
      </footer>
    </li>
  );
}

function waveTerminalDetail(
  outcome: DiscourseConversationAggregateRecord['waves'][number]['outcome']
): string {
  switch (outcome) {
    case 'CANCELED': return 'The response was stopped before all agent work completed.';
    case 'STALE': return 'Changed context prevented this response from being accepted.';
    case 'FAILED': return 'The agents did not complete this response.';
    case 'NO_RESPONSE': return 'No agent completed an answer.';
    case 'PARTIAL': return 'Some agent work completed; incomplete results remain visible.';
    case 'COMPLETE': return 'The response completed.';
    default: return 'Response status is unavailable.';
  }
}

function DiscourseMessage({
  message,
  replyTarget,
  context,
  job,
  onNavigate,
  onReply,
  onCorrect,
  onDelete,
  onAskAuthor,
  onAskOthers,
  selectedAsSource,
  onToggleSource
}: {
  message: DiscourseMessageRecord;
  replyTarget?: DiscourseMessageRecord;
  context: ConversationContextReferenceSnapshot[];
  job?: DiscourseConversationAggregateRecord['jobs'][number];
  onNavigate(messageId: string): void;
  onReply(): void;
  onCorrect(): void;
  onDelete(): void;
  onAskAuthor(): void;
  onAskOthers(): void;
  selectedAsSource: boolean;
  onToggleSource(): void;
}) {
  const user = message.author.kind === 'USER';
  return (
    <li id={`discourse-message-${message.id}`} className={`tm-discourse-message tm-discourse-message--${message.author.kind.toLowerCase()} ${message.status !== 'VISIBLE' ? `tm-discourse-message--${message.status.toLowerCase()}` : ''}`}>
      <div className="tm-discourse-message__rail">
        <span>{user ? 'Y' : message.author.kind === 'AGENT' ? message.author.displayNameSnapshot.slice(0, 1) : 'M'}</span>
      </div>
      <article>
        <header>
          <strong>{messageAuthorLabel(message)}</strong>
          <time dateTime={message.createdAt}>{formatMessageTime(message.createdAt)}</time>
          {message.status === 'SUPERSEDED' ? <span className="tm-discourse-message__state">Corrected</span> : null}
          {job ? (
            <span className="tm-discourse-message__state">
              {job.assignment.model} · {job.freshnessAtCompletion === 'FRESH' ? 'context fresh' : job.freshnessAtCompletion === 'CHANGED_DURING_JOB' ? 'context changed' : 'freshness unknown'}
            </span>
          ) : null}
        </header>
        {replyTarget ? (
          <button type="button" className="tm-discourse-reply-reference" onClick={() => onNavigate(replyTarget.id)}>
            <span>↳ {messageAuthorLabel(replyTarget)}</span>
            {replyTarget.status === 'TOMBSTONE' ? 'Deleted message' : compactText(replyTarget.body, 90)}
          </button>
        ) : null}
        {job?.freshnessAtCompletion === 'CHANGED_DURING_JOB' ? (
          <p className="tm-discourse-message__stale-note">
            Context changed while this response was running. It is preserved for history, not accepted as current evidence.
          </p>
        ) : null}
        {message.status === 'TOMBSTONE' ? (
          <p className="tm-discourse-message__tombstone">Message deleted</p>
        ) : message.author.kind === 'AGENT' ? (
          <DiscourseMarkdown text={message.body} />
        ) : (
          <p className="tm-discourse-message__body">{message.body}</p>
        )}
        {context.length > 0 ? (
          <div className="tm-discourse-message__context" aria-label="Message context">
            {context.map((reference) => (
              <span key={`${reference.scope}:${reference.contextLinkId}`}>
                {reference.scope === 'PINNED' ? <PinIcon /> : reference.entityKind === 'TASK' ? <TaskIcon /> : <RepositoryIcon />}
                {reference.labelSnapshot}
              </span>
            ))}
          </div>
        ) : null}
        {message.status !== 'TOMBSTONE' ? (
          <footer>
            <button type="button" onClick={onReply}>Reply</button>
            {!user && message.author.kind === 'AGENT' ? <button type="button" onClick={onAskAuthor}>Ask author</button> : null}
            {!user && message.author.kind === 'AGENT' ? <button type="button" onClick={onAskOthers}>Ask others</button> : null}
            <button type="button" aria-pressed={selectedAsSource} onClick={onToggleSource}>{selectedAsSource ? 'Selected' : 'Select'}</button>
            {user && message.status === 'VISIBLE' ? <button type="button" onClick={onCorrect}>Correct</button> : null}
            {user ? <button type="button" onClick={onDelete}>Delete</button> : null}
            <button type="button" onClick={() => void navigator.clipboard?.writeText(message.body)}>Copy</button>
          </footer>
        ) : null}
      </article>
    </li>
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

function ContextPreview({ preview, onClose }: { preview: DiscourseContextPreview; onClose(): void }) {
  return (
    <div className="tm-modal" role="dialog" aria-modal="true" aria-labelledby="discourse-preview-title">
      <div className="tm-modal__scrim" onClick={onClose} />
      <div className="tm-modal__panel tm-discourse-preview">
        <header>
          <div><h2 id="discourse-preview-title">What agents will see</h2><p>Provisional context manifest · valid until {formatMessageTime(preview.expiresAt)}</p></div>
          <button type="button" className="tm-iconbtn" aria-label="Close context preview" onClick={onClose}>×</button>
        </header>
        <section>
          <h3>Selected context</h3>
          {preview.references.length === 0 ? <p>No task or repository context. Only the message and bounded conversation history would be included.</p> : (
            <ul>
              {preview.references.map((reference) => (
                <li key={`${reference.entityKind}:${reference.entityId}`}>
                  <span className={`tm-discourse-context-kind tm-discourse-context-kind--${reference.entityKind.toLowerCase()}`}>{reference.entityKind === 'TASK' ? <TaskIcon /> : <RepositoryIcon />}</span>
                  <span><strong>{reference.labelSnapshot}</strong><small>{reference.scope === 'PINNED' ? 'Pinned' : 'This message'} · {accessModeLabel(reference.accessMode)}</small></span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section>
          <h3>Safety boundary</h3>
          <dl className="tm-discourse-preview__policy">
            <div><dt>Repository roots</dt><dd>{preview.filesystemRootCount} read-only</dd></div>
            <div><dt>Writes</dt><dd>Disabled</dd></div>
            <div><dt>Network</dt><dd>Disabled</dd></div>
            <div><dt>Tools & apps</dt><dd>Disabled</dd></div>
          </dl>
        </section>
        {preview.exclusions.length > 0 ? <section className="tm-discourse-preview__exclusions"><h3>Exclusions</h3><ul>{preview.exclusions.map((exclusion) => <li key={exclusion}>{exclusion}</li>)}</ul></section> : null}
        <footer><span className="tm-discourse-preview__hash">Manifest {preview.fingerprint.slice(0, 10)}</span><button type="button" className="primary-button" onClick={onClose}>Done</button></footer>
      </div>
    </div>
  );
}

function InspectorSection({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return <section className="tm-discourse-inspector__section"><h3>{title}{count !== undefined ? <span>{count}</span> : null}</h3>{children}</section>;
}

function ConfirmDialog({ title, body, confirmLabel, onCancel, onConfirm }: { title: string; body: string; confirmLabel: string; onCancel(): void; onConfirm(): void }) {
  return <div className="tm-modal" role="dialog" aria-modal="true" aria-labelledby="discourse-confirm-title"><div className="tm-modal__scrim" onClick={onCancel} /><div className="tm-modal__panel tm-discourse-confirm"><h2 id="discourse-confirm-title">{title}</h2><p>{body}</p><div className="tm-modal__actions"><button type="button" className="outline-button" onClick={onCancel}>Cancel</button><button type="button" className="danger-button" onClick={onConfirm}>{confirmLabel}</button></div></div></div>;
}

function navigateToMessage(messageId: string): void {
  const target = document.getElementById(`discourse-message-${messageId}`);
  target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
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

function compactText(value: string, limit: number): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1).trimEnd()}…`;
}

function formatCompactDate(value: string): string {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

function formatMessageTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

function availabilityLabel(value: string): string {
  return value === 'AVAILABLE' ? 'Available' : value === 'TOMBSTONED' ? 'Historical only' : 'Unavailable';
}

function accessModeLabel(value: string): string {
  return value === 'FILESYSTEM_READ' ? 'Read-only files' : value === 'METADATA_ONLY' ? 'Metadata only' : 'Unavailable';
}

function responsePolicyLabel(policy: DiscourseDefaultPolicy | DiscourseWavePolicy): string {
  switch (policy) {
    case 'NONE': return 'No agents';
    case 'DIRECT': return 'Direct';
    case 'PANEL': return 'Panel';
    case 'TEAM': return 'Team';
    case 'TARGETED_REVIEW': return 'Review';
    case 'TARGETED_REPLY': return 'Reply';
    case 'SYNTHESIS': return 'Synthesis';
  }
}

function responsePolicyDetail(
  policy: DiscourseDefaultPolicy,
  selectedAgents: number,
  teamReady: boolean
): string {
  switch (policy) {
    case 'NONE': return 'Human note · 0 agent turns';
    case 'DIRECT': return selectedAgents === 1
      ? 'One selected agent · 1 turn'
      : 'Choose one agent with @';
    case 'PANEL': return selectedAgents >= 2 && selectedAgents <= 3
      ? `${selectedAgents} independent agents · ${selectedAgents} turns`
      : 'Choose two or three agents with @';
    case 'TEAM': return teamReady
      ? 'Lead + 2 reviews + optional correction · up to 4 turns'
      : 'Team needs all three agents available';
  }
}

function responsePolicyRequirement(policy: DiscourseDefaultPolicy, teamReady: boolean): string {
  return policy === 'DIRECT'
    ? 'Choose one agent with @.'
    : policy === 'PANEL'
      ? 'Choose two or three agents with @.'
      : policy === 'TEAM' && !teamReady
        ? 'Team responses require all three agents to be available.'
        : '';
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
function PlusIcon() { return <svg {...ICON}><path d="M12 5v14M5 12h14" /></svg>; }
function SearchIcon() { return <svg {...ICON}><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>; }
function ContextIcon() { return <svg {...ICON}><path d="M4 5h16v14H4zM9 5v14" /></svg>; }
function PinIcon() { return <svg {...ICON} width={12} height={12}><path d="m14 4 6 6-4 1-4 4-1 5-2-2-5 2 4-4 1-4z" /></svg>; }
function PersonIcon() { return <svg {...ICON}><circle cx="12" cy="8" r="3" /><path d="M5 20c.8-4 3.1-6 7-6s6.2 2 7 6" /></svg>; }
function TaskIcon() { return <svg {...ICON} width={13} height={13}><rect x="4" y="3" width="16" height="18" rx="2" /><path d="m8 10 2 2 4-4M8 16h8" /></svg>; }
function RepositoryIcon() { return <svg {...ICON} width={13} height={13}><path d="M4 4h12a2 2 0 0 1 2 2v14H6a2 2 0 0 1-2-2z" /><path d="M8 4v16M18 8h2" /></svg>; }
function RoundtableIcon() { return <svg {...ICON} width={28} height={28}><circle cx="12" cy="12" r="4" /><circle cx="5" cy="7" r="2" /><circle cx="19" cy="7" r="2" /><circle cx="5" cy="18" r="2" /><circle cx="19" cy="18" r="2" /></svg>; }
