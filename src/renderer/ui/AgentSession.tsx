import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  AgentItemRecord, AgentPlanRevisionRecord, AgentSessionRecord, InteractionRequestRecord,
  AgentInteractionDecision, RunRecord, Task, TaskInstruction, InstructionAttachments, TaskAttachmentRecord
} from '../../shared/contracts';
import { TASK_INSTRUCTION_MAX_LENGTH, isImplementationRunMode } from '../../shared/contracts';
import { getPostRunActionState } from '../model/postRunActions';
import { canStopTaskRun } from '../model/runProgress';
import type { RunFailureBannerViewModel } from '../model/taskView';
import { clampClip, earlierHistory, isActiveRunStatus, type HistoryWindow, type SessionTurn } from '../model/agentSession';
import { ActionMenu } from './ActionMenu';
import { AttachmentComposerShell } from './AttachmentComposerShell';
import { StoredAttachmentChip } from './AttachmentChip';
import { useTaskAttachments, type UseTaskAttachmentsOptions } from './useTaskAttachments';
import { Conversation, useConversationScroll } from './Conversation';
import { InteractionPanel } from './InteractionPanel';
import { MessageQueue } from './MessageQueue';
import { Elapsed, Turn, UserMessage, useSessionTurns } from './SessionTurns';
import { StatusGlyph } from './StatusBadge';
import { ArrowUp, ChevronDown, CornerDownRight, MoreHorizontal, Pencil, Play, RotateCcw, ShieldCheck } from 'lucide-react';

export interface AgentSessionProps {
  task: Task;
  worktreePath?: string;
  runtimeName?: string;
  attachmentOptions: Omit<UseTaskAttachmentsOptions, 'blocked' | 'preserveDraftOnClose'>;
  attachments: TaskAttachmentRecord[];
  onReadAttachment(id: string): Promise<import('../../shared/attachments').AttachmentContent>;
  run?: RunRecord;
  runs: RunRecord[];
  sessions: AgentSessionRecord[];
  items: AgentItemRecord[];
  plans: AgentPlanRevisionRecord[];
  interactions: InteractionRequestRecord[];
  instructions: TaskInstruction[];
  requiresRecovery: boolean;
  steeringSupported: boolean;
  runtimeUnavailable?: string;
  /** Curated explanation of why the current implementation needs attention. */
  failure?: RunFailureBannerViewModel;
  draft: string;
  draftError?: string;
  onDraftChange(text: string): void;
  onFlushDraft(): Promise<void>;
  onQueue(runId: string, text: string, id: string, files?: InstructionAttachments): Promise<void>;
  onEditQueue(id: string, text?: string, files?: InstructionAttachments): Promise<void>;
  onSendQueue(id: string, runId: string): Promise<void>;
  onSteer(runId: string, text: string, id?: string): Promise<void>;
  onContinue(runId: string, text?: string, id?: string, files?: InstructionAttachments): Promise<void>;
  onRetry(runId: string, strategy: 'SAME_SESSION' | 'FORK', text?: string, id?: string, files?: InstructionAttachments): Promise<void>;
  onStop(runId: string): Promise<void>;
  onRespond(interaction: InteractionRequestRecord, decision: AgentInteractionDecision): Promise<void>;
  onReadArtifact?(id: string): Promise<string>;
  onShowDebug(): void;
  onShowReview(): void;
  preRun?: ReactNode;
  capture(run: RunRecord): ReactNode;
  attentionRequested: number;
  header?: ReactNode;
}

type SendMode = 'QUEUE' | 'STEER' | 'CONTINUE' | 'RETRY';
interface ReadingPosition { taskId: string; top: number; firstTurnKey?: string; clip: number; following: boolean }

const READING_KEY = 'task-monki:agent-reading';
const SHORTCUT = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/u.test(navigator.userAgent) ? '⌘↵' : 'Ctrl+Enter';

export function AgentSession(props: AgentSessionProps) {
  const { task, run, draft } = props;
  const [choice, setChoice] = useState<{ runId: string; mode: SendMode }>();
  const [pendingAction, setPendingAction] = useState<'submit' | 'other'>();
  const busy = pendingAction !== undefined;
  const [error, setError] = useState<{ runId?: string; text: string }>();
  const [reading] = useState(() => savedReading(task.id));
  const scroller = useConversationScroll({ startAtBottom: !reading || reading.following });
  const prepend = useRef<{ height: number; top: number } | undefined>(undefined);
  const [editing, setEditing] = useState<{ id: string; text: string; attachmentIds: string[] }>();
  const currentError = editing || error?.runId === run?.id ? error?.text : undefined;
  const inFlight = useRef(false);
  const messageId = useRef<{ text: string; mode: SendMode; runId: string; id: string; attachmentDraftId?: string; attachmentClientIds: string[] } | undefined>(undefined);
  const attention = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const questionPending = !editing && props.interactions.some((item) => item.type === 'USER_INPUT' && ['PENDING', 'RESPONDING'].includes(item.status));
  const questionPrompt = props.interactions.some((item) => item.type === 'USER_INPUT' && item.status === 'PENDING')
    ? 'Answer above to continue' : 'Waiting for confirmation…';
  const files = useTaskAttachments({ ...props.attachmentOptions, enabled: Boolean(run) && props.attachmentOptions.enabled,
    initialDraft: run ? props.attachmentOptions.initialDraft : undefined, blocked: busy || Boolean(editing) || questionPending, preserveDraftOnClose: true });
  const editFiles = useTaskAttachments({ ...props.attachmentOptions, enabled: Boolean(editing) && props.attachmentOptions.enabled,
    blocked: busy, initialDraft: undefined, onPersistDraft: undefined, preserveDraftOnClose: false });
  const composerFiles = editing ? editFiles : files;
  const fileError = composerFiles.modelError ?? composerFiles.overflowError ?? composerFiles.draftError;
  const hasFiles = files.activeItems.length > 0;

  const conversationRuns = useMemo(
    () => props.runs.filter((item) => isImplementationRunMode(item.mode) || item.mode === 'REVIEW'),
    [props.runs]
  );
  const turns = useSessionTurns({
    prompt: task.prompt, runs: conversationRuns, items: props.items, instructions: props.instructions,
    plans: props.plans, interactions: props.interactions, cwd: props.worktreePath
  });
  const pending = props.instructions.filter((item) => ['QUEUED', 'HELD'].includes(item.status)
    || (item.status === 'FAILED' && item.mode !== 'STEER' && item.runId && !props.runs.some((turn) => turn.id === item.runId)))
    .sort((a, b) => a.order - b.order);
  const answerPending = props.interactions.some((item) => item.status === 'PENDING');
  const attentionPending = answerPending || props.interactions.some((item) => item.status === 'RESPONDING');
  const activeReview = props.runs.find((item) => item.mode === 'REVIEW' && isActiveRunStatus(item.status));
  const displayedRun = activeReview ?? run;
  const active = Boolean(displayedRun && isActiveRunStatus(displayedRun.status));
  const actions = run ? getPostRunActionState(run, props.requiresRecovery) : undefined;
  const queueable = Boolean(run && ['RUNNING', 'AWAITING_APPROVAL', 'AWAITING_USER_INPUT'].includes(run.status) && !activeReview);
  const allowed: SendMode[] = queueable
    ? ['QUEUE', ...(run?.status === 'RUNNING' && props.steeringSupported && !hasFiles ? ['STEER' as const] : [])]
    : actions?.primaryRecoveryAction === 'retry' ? ['RETRY', 'CONTINUE']
    : actions?.canFollowUp || actions?.canContinue ? ['CONTINUE', ...(actions.canRetry ? ['RETRY' as const] : [])] : [];
  const mode = choice && choice.runId === run?.id && allowed.includes(choice.mode) ? choice.mode : allowed[0];
  const followUp = run?.status === 'COMPLETED' && !props.requiresRecovery;
  const needsText = mode === 'QUEUE' || mode === 'STEER' || followUp || hasFiles;
  const delivery: Record<SendMode, { label: string; description: string; placeholder: string }> = {
    QUEUE: { label: 'Queue', description: 'Send after the current response', placeholder: 'Queue a message for after this response' },
    STEER: { label: 'Send now', description: 'Add to the current response', placeholder: 'Guide the current response' },
    CONTINUE: followUp
      ? { label: 'Send', description: 'Follow up in this session', placeholder: 'Ask for follow-up changes' }
      : { label: 'Continue', description: 'Resume the unfinished work', placeholder: 'Add guidance (optional)' },
    RETRY: { label: 'Retry', description: 'Start the implementation again from the current worktree', placeholder: 'Add guidance for the retry (optional)' }
  };
  const sessionBlocked = activeReview ? 'Wait for the review to finish.'
    : answerPending ? 'Answer the agent request before sending an instruction.'
    : attentionPending ? 'Waiting for confirmation before sending an instruction.'
    : run?.status === 'INTERRUPTING' ? 'Waiting for the agent to stop.'
    : ['DONE', 'CANCELED', 'ARCHIVED'].includes(task.workflowPhase) ? 'Reopen the task to continue work.'
    : !mode ? 'The agent is not ready for another instruction.' : undefined;
  const blocked = sessionBlocked ?? props.runtimeUnavailable;
  const [historyWindow, setHistoryWindow] = useState<HistoryWindow>(() => {
    const saved = reading?.firstTurnKey ? turns.findIndex((turn) => turn.key === reading.firstTurnKey) : -1;
    return saved >= 0 ? { first: saved, clip: clampClip(turns[saved], reading!.clip) }
      : earlierHistory(turns, { first: turns.length, clip: 0 });
  });
  const visibleTurns = turns.slice(historyWindow.first);
  const lastImplementation = [...turns].reverse().find((turn) => turn.run.mode !== 'REVIEW');
  const lastVisible = visibleTurns.at(-1);
  const lastLiveEntry = lastVisible?.state === 'active' ? lastVisible.entries.at(-1) : undefined;
  const liveWorkVisible = lastLiveEntry?.kind === 'steps' && lastLiveEntry.steps.some((step) =>
    step.kind === 'reasoning' ? step.active : step.row.status === 'active');
  const unattached = props.instructions.filter((item) => item.mode !== 'STEER' && !props.runs.some((turn) => turn.id === item.runId)
    && (['SENDING', 'UNCERTAIN'].includes(item.status) || (item.status === 'FAILED' && !item.runId)));
  const position = useRef({ firstTurnKey: visibleTurns[0]?.key, clip: historyWindow.clip });
  position.current = { firstTurnKey: visibleTurns[0]?.key, clip: historyWindow.clip };

  // Loading older turns is a prepend: keep the reader on the same line.
  useLayoutEffect(() => {
    const viewport = scroller.scrollRef.current;
    if (prepend.current && viewport) {
      viewport.scrollTop = prepend.current.top + viewport.scrollHeight - prepend.current.height;
      prepend.current = undefined;
    }
  }, [historyWindow]);

  // The reading position is local view state; it is restored once per mount.
  useLayoutEffect(() => {
    const viewport = scroller.scrollRef.current;
    if (!viewport) return;
    if (reading && !reading.following) viewport.scrollTop = reading.top;
    const remember = () => {
      try {
        sessionStorage.setItem(READING_KEY, JSON.stringify({
          taskId: task.id, top: viewport.scrollTop, ...position.current, following: scroller.state.isAtBottom
        } satisfies ReadingPosition));
      } catch { /* Reading position is optional. */ }
    };
    window.addEventListener('pagehide', remember);
    return () => { remember(); window.removeEventListener('pagehide', remember); };
  }, []);

  const focusAttention = () => {
    attention.current?.scrollIntoView({ block: 'nearest' });
    const input = attention.current?.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled), button:not(:disabled)');
    (input ?? attention.current)?.focus();
  };
  useEffect(() => {
    if (props.attentionRequested) focusAttention();
  }, [props.attentionRequested]);

  // A failed response can arrive after the instruction has taken ownership of its files.
  useEffect(() => {
    const submitted = messageId.current;
    if (busy || !submitted || submitted.mode === 'STEER') return;
    const receipt = props.instructions.find((item) => item.id === submitted.id);
    if (!receipt || receipt.attachmentDraftId !== submitted.attachmentDraftId) return;
    messageId.current = undefined;
    if (draft === submitted.text) props.onDraftChange('');
    void files.finishAdoption({ draftId: submitted.attachmentDraftId, clientIds: submitted.attachmentClientIds })
      .then(() => props.onFlushDraft())
      .catch((caught) => {
        if (!files.closedRef.current) setError({ runId: run?.id, text: caught instanceof Error ? caught.message : String(caught) });
      });
  }, [busy, props.instructions, draft, props.onDraftChange, props.onFlushDraft, files.finishAdoption, files.closedRef, run?.id]);

  async function act(action: () => Promise<void>, kind: 'submit' | 'other' = 'other') {
    if (inFlight.current) return;
    inFlight.current = true;
    setPendingAction(kind); setError(undefined);
    try { await action(); }
    catch (caught) { setError({ runId: run?.id, text: caught instanceof Error ? caught.message : String(caught) }); }
    finally { inFlight.current = false; setPendingAction(undefined); }
  }
  async function submit() {
    if (!run || !mode || blocked || busy || files.busy || files.hasErrors || files.modelError || (needsText && !draft.trim())) return;
    const text = draft;
    const sentRun = run.id;
    const selectedMode = mode;
    await act(async () => {
      await props.onFlushDraft();
      const attachmentDraftId = await files.flushDraft();
      if (messageId.current?.attachmentDraftId !== attachmentDraftId || messageId.current?.text !== text || messageId.current.mode !== selectedMode || messageId.current.runId !== sentRun) {
        messageId.current = { text, mode: selectedMode, runId: sentRun, id: crypto.randomUUID(), attachmentDraftId, attachmentClientIds: files.activeItems.map((item) => item.clientId) };
      }
      const id = messageId.current.id;
      const selection = attachmentDraftId ? { attachmentDraftId } : undefined;
      if (selectedMode === 'QUEUE') await props.onQueue(sentRun, text, id, selection);
      else if (selectedMode === 'STEER') await props.onSteer(sentRun, text, id);
      else if (selectedMode === 'RETRY') await props.onRetry(sentRun, 'SAME_SESSION', text, id, selection);
      else await props.onContinue(sentRun, text, id, selection);
      await files.finishAdoption();
      props.onDraftChange('');
      await props.onFlushDraft();
      messageId.current = undefined;
      void scroller.scrollToBottom();
      composer.current?.focus();
    }, 'submit');
  }

  const cancelEdit = () => {
    void editFiles.markCreateFailed(false).then(() => editFiles.finishAdoption());
    setEditing(undefined); setError(undefined); composer.current?.focus();
  };
  const saveEdit = () => {
    if (!editing?.text.trim() || busy || editFiles.busy || editFiles.hasErrors || editFiles.modelError) return;
    void act(async () => {
      const attachmentDraftId = await editFiles.prepareForCreate();
      await props.onEditQueue(editing.id, editing.text, { attachmentIds: editing.attachmentIds, attachmentDraftId });
      await editFiles.finishAdoption();
      setEditing(undefined); composer.current?.focus();
    });
  };
  const loadEarlier = () => {
    const viewport = scroller.scrollRef.current;
    if (viewport) prepend.current = { height: viewport.scrollHeight, top: viewport.scrollTop };
    setHistoryWindow((current) => earlierHistory(turns, current));
  };
  const workingLabel = displayedRun?.status === 'INTERRUPTING' ? 'Stopping…'
    : answerPending ? 'Waiting for your answer'
    : attentionPending ? 'Waiting for confirmation'
    : displayedRun?.status === 'STARTING' || displayedRun?.status === 'QUEUED' ? 'Starting…'
    : activeReview ? 'Reviewing…' : 'Working…';
  const canSend = !busy && !blocked && !files.busy && !files.hasErrors && !files.modelError && !(needsText && !draft.trim());
  const hint = editing ? `${SHORTCUT} to save` : blocked;
  const model = displayedRun?.observedSettings?.model ?? displayedRun?.requestedSettings.model;

  return <section className="tm-agent-session" aria-label="Agent session">
    <Conversation instance={scroller} label="Session history" className="tm-agent-session__conversation" header={props.header}>
      <div className="tm-agent-session__column">
        {!run ? props.preRun : null}
        {historyWindow.first > 0 || historyWindow.clip > 0
          ? <button type="button" className="ghost-button tm-agent-session__earlier" data-disclosure="" onClick={loadEarlier}>Load earlier messages</button>
          : null}
        {visibleTurns.map((turn, index) => turn.run.mode === 'REVIEW'
          ? <ReviewTurn key={turn.key} turn={turn} onShowReview={props.onShowReview} />
          : <Turn key={turn.key} turn={turn} clip={index === 0 ? historyWindow.clip : 0}
            attachments={props.attachments.filter((file) => (props.instructions.find((item) => item.id === turn.opener?.key)?.attachmentIds ?? (turn.opener?.key === `${turn.run.id}:prompt` ? task.initialAttachmentIds : []))?.includes(file.id))}
            onReadAttachment={props.onReadAttachment}
            failure={turn === lastImplementation && turn.state !== 'active' ? props.failure : undefined}
            capture={turn.state === 'completed' ? props.capture(turn.run) : null}
            onReadArtifact={props.onReadArtifact} onShowDebug={props.onShowDebug} />)}
        {unattached.map((item) => <UserMessage key={item.id} text={item.text} time={item.createdAt}
          attachments={props.attachments.filter((file) => item.attachmentIds?.includes(file.id))} onReadAttachment={props.onReadAttachment}
          status={item.status === 'SENDING' ? 'Sending…' : item.status === 'UNCERTAIN' ? 'Delivery uncertain' : 'Not sent'} />)}
        {active && displayedRun && (attentionPending || displayedRun.status === 'INTERRUPTING'
          || displayedRun.status === 'STARTING' || displayedRun.status === 'QUEUED' || !liveWorkVisible)
          ? <div className="tm-agent-session__working">
            <StatusGlyph kind={attentionPending ? 'waiting' : 'working'} />
            <span role="status">{workingLabel}</span>
            <Elapsed since={displayedRun.startedAt} />
          </div> : null}
        <div ref={attention} tabIndex={-1} className="tm-agent-session__requests">
          <InteractionPanel interactions={props.interactions} sessions={props.sessions} onRespond={async (interaction, decision) => {
            await props.onRespond(interaction, decision);
            if (interaction.type === 'USER_INPUT') composer.current?.focus();
          }} />
        </div>
      </div>
    </Conversation>
    {run ? <div className="tm-agent-session__footer">
      <form className="tm-agent-session__composer" aria-busy={busy} onSubmit={(event) => { event.preventDefault(); if (editing) saveEdit(); else void submit(); }}>
        <AttachmentComposerShell compact={questionPending} attachments={composerFiles} attachmentLabel="Message attachments" addButtonTitle="Attach images or text files"
          hint={<span id={`agent-composer-note-${task.id}`}>{hint ?? model}</span>}
          toolbarAction={<>
            {editing ? <button className="primary-button tm-composer__primary" type="submit" disabled={busy || editFiles.busy || !editing.text.trim() || editFiles.hasErrors || Boolean(editFiles.modelError)}>{busy ? 'Saving…' : 'Save'}</button> : <>
              {!active && actions?.canForkAlternative ? <ActionMenu label="More session actions" disabled={busy || hasFiles}
                trigger={<MoreHorizontal size={16} strokeWidth={1.5} aria-hidden="true" />}
                items={[{ label: 'Fork alternative', description: 'Start from the recorded base. Local changes are not included.', disabled: Boolean(blocked), disabledReason: blocked,
                  onSelect: () => void act(() => props.onRetry(run.id, 'FORK', draft || undefined)) }]} /> : null}
              {displayedRun && canStopTaskRun(displayedRun) ? <button type="button" className="outline-button tm-composer__secondary" disabled={busy}
                title="Stop the current response" onClick={() => void act(() => props.onStop(displayedRun.id))}>Stop</button> : null}
              {mode && !questionPending ? <div className={`tm-composer__send${allowed.length > 1 ? ' tm-composer__send--split' : ''}`}>
                <button className={`primary-button tm-composer__primary${sendUsesIcon(mode, followUp) ? ' tm-composer__primary--icon' : ''}`} type="submit" disabled={!canSend}
                  aria-label={delivery[mode].label}
                  title={blocked ?? (needsText && !draft.trim() ? 'Write a message first' : `${delivery[mode].description} · ${SHORTCUT}`)}>
                  {pendingAction === 'submit' ? <StatusGlyph kind="working" /> : sendControl(mode, followUp)}
                </button>
                {allowed.length > 1 ? <ActionMenu className="tm-send-menu" label="Instruction delivery" selection="single" disabled={busy || Boolean(blocked)}
                  trigger={<ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" />}
                  items={allowed.map((item) => ({ label: delivery[item].label, description: delivery[item].description, pressed: mode === item,
                    onSelect: () => setChoice({ runId: run.id, mode: item }) }))} /> : null}
              </div> : null}
            </>}
          </>}>
        <MessageQueue items={pending.map((item) => ({ id: item.id, text: item.text,
          detail: item.attachmentIds?.map((id) => props.attachments.find((file) => file.id === id)?.displayName).filter(Boolean).join(', '), held: item.status !== 'QUEUED' }))}
          editingId={editing?.id} disabled={busy || Boolean(editing)} continueDisabledReason={blocked}
          onContinue={!active ? (id) => void act(async () => {
            await props.onSendQueue(id, run.id); if (editing?.id === id) cancelEdit(); composer.current?.focus();
          }) : undefined}
          onEdit={(id) => {
            const item = pending.find((candidate) => candidate.id === id);
            if (item) { setEditing({ id, text: item.text, attachmentIds: item.attachmentIds ?? [] }); setError(undefined); composer.current?.focus(); }
          }}
          onRemove={(id) => void act(async () => {
            await props.onEditQueue(id); if (editing?.id === id) cancelEdit(); composer.current?.focus();
          })} />
        {editing ? <div className="tm-agent-session__editing">
          <Pencil size={13} strokeWidth={1.25} absoluteStrokeWidth aria-hidden="true" />Editing queued message
          <button type="button" className="ghost-button" onClick={cancelEdit} disabled={busy}>Cancel</button>
        </div> : null}
        <label className="tm-visually-hidden" htmlFor={`agent-draft-${task.id}`}>{editing ? 'Edit queued instruction' : 'Instruction'}</label>
        <textarea className="tm-composer__input" ref={composer} id={`agent-draft-${task.id}`} rows={3} value={editing?.text ?? draft} readOnly={busy || questionPending} aria-disabled={questionPending || undefined}
          aria-describedby={hint ? `agent-composer-note-${task.id}` : undefined} maxLength={TASK_INSTRUCTION_MAX_LENGTH}
          placeholder={questionPending ? questionPrompt : mode ? delivery[mode].placeholder : 'Continue the work…'}
          onPaste={composerFiles.paste}
          onChange={(event) => { if (editing) setEditing({ ...editing, text: event.target.value }); else props.onDraftChange(event.target.value); }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (editing && event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); cancelEdit(); }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (editing) saveEdit(); else void submit(); }
          }} />
        {editing?.attachmentIds.length ? <ul className="task-attachments" aria-label="Queued attachments">{editing.attachmentIds.map((id) => {
          const attachment = props.attachments.find((file) => file.id === id);
          return attachment ? <StoredAttachmentChip key={id} attachment={attachment} label="Attached" disabled={busy}
            onRead={() => props.onReadAttachment(id)}
            onRemove={() => setEditing({ ...editing, attachmentIds: editing.attachmentIds.filter((value) => value !== id) })} /> : null;
        })}</ul> : null}
        </AttachmentComposerShell>
      </form>
      {currentError || props.draftError || fileError ? <p className="tm-error" role="alert">{currentError ?? props.draftError ?? fileError}</p> : null}
    </div> : null}
  </section>;
}

function ReviewTurn({ turn, onShowReview }: { turn: SessionTurn; onShowReview(): void }) {
  const state = { active: 'In progress', completed: 'Completed', stopped: 'Stopped', failed: 'Failed', interrupted: 'Interrupted' }[turn.state];
  return <div className="tm-turn tm-turn--review">
    <ShieldCheck size={13} strokeWidth={1.25} absoluteStrokeWidth aria-hidden="true" />
    <span>Agent review</span>
    <span className="tm-turn__review-state">{state}</span>
    <button type="button" className="ghost-button" onClick={onShowReview}>View review</button>
  </div>;
}

function sendUsesIcon(mode: SendMode, followUp: boolean): boolean {
  return mode === 'QUEUE' || mode === 'STEER' || (mode === 'CONTINUE' && followUp);
}

function sendControl(mode: SendMode, followUp: boolean) {
  if (mode === 'RETRY') return <><RotateCcw size={13} strokeWidth={1.5} absoluteStrokeWidth aria-hidden="true" />Retry</>;
  if (mode === 'CONTINUE' && !followUp) return <><Play size={13} strokeWidth={1.5} absoluteStrokeWidth aria-hidden="true" />Continue</>;
  if (mode === 'QUEUE') return <CornerDownRight size={16} strokeWidth={1.5} aria-hidden="true" />;
  return <ArrowUp size={16} strokeWidth={1.5} aria-hidden="true" />;
}

function savedReading(taskId: string): ReadingPosition | undefined {
  try {
    const saved = JSON.parse(sessionStorage.getItem(READING_KEY) ?? 'null') as Partial<ReadingPosition> | null;
    return saved?.taskId === taskId && typeof saved.top === 'number' && Number.isFinite(saved.top)
      ? { taskId, top: saved.top, firstTurnKey: saved.firstTurnKey, clip: typeof saved.clip === 'number' ? saved.clip : 0, following: saved.following !== false }
      : undefined;
  } catch { return undefined; }
}
