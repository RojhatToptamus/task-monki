import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  AgentItemRecord, AgentPlanRevisionRecord, AgentSessionRecord, InteractionRequestRecord,
  AgentInteractionDecision, RunRecord, Task, TaskInstruction
} from '../../shared/contracts';
import { TASK_INSTRUCTION_MAX_LENGTH, isImplementationRunMode } from '../../shared/contracts';
import { getPostRunActionState } from '../model/postRunActions';
import { canStopTaskRun } from '../model/runProgress';
import type { RunFailureBannerViewModel } from '../model/taskView';
import {
  clampClip, earlierHistory, formatElapsed, isActiveRunStatus, planMarker, sessionTurn, turnOutcomeLabel,
  type HistoryWindow, type SessionTurn
} from '../model/agentSession';
import { ActionMenu } from './ActionMenu';
import { ActivitySteps } from './ActivitySteps';
import { Conversation, useConversationScroll } from './Conversation';
import { InteractionPanel } from './InteractionPanel';
import { Message, MessageContent, MessageMeta, MessageTime } from './Message';
import { MessageMarkdown } from './MessageMarkdown';
import { MessageQueue } from './MessageQueue';
import { PlanCard } from './Plan';
import { StatusGlyph } from './StatusBadge';
import {
  ArrowUp, Check, ChevronDown, CircleAlert, Copy, CornerDownRight, MoreHorizontal, Pencil, Play, RotateCcw, ShieldCheck
} from 'lucide-react';

export interface AgentSessionProps {
  task: Task;
  worktreePath?: string;
  runtimeName?: string;
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
  onQueue(runId: string, text: string, id: string): Promise<void>;
  onEditQueue(id: string, text?: string): Promise<void>;
  onSendQueue(id: string, runId: string): Promise<void>;
  onSteer(runId: string, text: string, id?: string): Promise<void>;
  onContinue(runId: string, text?: string, id?: string): Promise<void>;
  onRetry(runId: string, strategy: 'SAME_SESSION' | 'FORK', text?: string, id?: string): Promise<void>;
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
  const currentError = error?.runId === run?.id ? error?.text : undefined;
  const [reading] = useState(() => savedReading(task.id));
  const scroller = useConversationScroll({ startAtBottom: !reading || reading.following });
  const prepend = useRef<{ height: number; top: number } | undefined>(undefined);
  const [editing, setEditing] = useState<{ id: string; text: string }>();
  const inFlight = useRef(false);
  const messageId = useRef<{ text: string; mode: SendMode; runId: string; id: string } | undefined>(undefined);
  const attention = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);

  const turns = useSessionTurns(task.prompt, props.runs, props.items, props.instructions, props.plans, props.worktreePath);
  const pending = props.instructions.filter((item) => ['QUEUED', 'HELD'].includes(item.status)).sort((a, b) => a.order - b.order);
  const attentionPending = props.interactions.some((item) => ['PENDING', 'RESPONDING'].includes(item.status));
  const activeReview = props.runs.find((item) => item.mode === 'REVIEW' && isActiveRunStatus(item.status));
  const displayedRun = activeReview ?? run;
  const active = Boolean(displayedRun && isActiveRunStatus(displayedRun.status));
  const actions = run ? getPostRunActionState(run, props.requiresRecovery) : undefined;
  const queueable = Boolean(run && ['RUNNING', 'AWAITING_APPROVAL', 'AWAITING_USER_INPUT'].includes(run.status) && !activeReview);
  const allowed: SendMode[] = queueable
    ? ['QUEUE', ...(run?.status === 'RUNNING' && props.steeringSupported ? ['STEER' as const] : [])]
    : actions?.primaryRecoveryAction === 'retry' ? ['RETRY', 'CONTINUE']
    : actions?.canFollowUp || actions?.canContinue ? ['CONTINUE', ...(actions.canRetry ? ['RETRY' as const] : [])] : [];
  const mode = choice && choice.runId === run?.id && allowed.includes(choice.mode) ? choice.mode : allowed[0];
  const followUp = run?.status === 'COMPLETED' && !props.requiresRecovery;
  const needsText = mode === 'QUEUE' || mode === 'STEER' || followUp;
  const delivery: Record<SendMode, { label: string; description: string; placeholder: string }> = {
    QUEUE: { label: 'Queue', description: 'Send after the current response', placeholder: 'Queue a message for after this response' },
    STEER: { label: 'Send now', description: 'Add to the current response', placeholder: 'Guide the current response' },
    CONTINUE: followUp
      ? { label: 'Send', description: 'Follow up in this session', placeholder: 'Ask for follow-up changes' }
      : { label: 'Continue', description: 'Resume the unfinished work', placeholder: 'Add guidance (optional)' },
    RETRY: { label: 'Retry', description: 'Start the implementation again from the current worktree', placeholder: 'Add guidance for the retry (optional)' }
  };
  const sessionBlocked = activeReview ? 'Wait for the review to finish.'
    : attentionPending ? 'Answer the agent request before sending an instruction.'
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
    && ['SENDING', 'FAILED', 'UNCERTAIN'].includes(item.status));
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

  async function act(action: () => Promise<void>, kind: 'submit' | 'other' = 'other') {
    if (inFlight.current) return;
    inFlight.current = true;
    setPendingAction(kind); setError(undefined);
    try { await action(); }
    catch (caught) { setError({ runId: run?.id, text: caught instanceof Error ? caught.message : String(caught) }); }
    finally { inFlight.current = false; setPendingAction(undefined); }
  }
  async function submit() {
    if (!run || !mode || blocked || busy || (needsText && !draft.trim())) return;
    const text = draft;
    const sentRun = run.id;
    const selectedMode = mode;
    await act(async () => {
      await props.onFlushDraft();
      if (messageId.current?.text !== text || messageId.current.mode !== selectedMode || messageId.current.runId !== sentRun) {
        messageId.current = { text, mode: selectedMode, runId: sentRun, id: crypto.randomUUID() };
      }
      const id = messageId.current.id;
      if (selectedMode === 'QUEUE') await props.onQueue(sentRun, text, id);
      else if (selectedMode === 'STEER') await props.onSteer(sentRun, text, id);
      else if (selectedMode === 'RETRY') await props.onRetry(sentRun, 'SAME_SESSION', text, id);
      else await props.onContinue(sentRun, text, id);
      props.onDraftChange('');
      await props.onFlushDraft();
      messageId.current = undefined;
      void scroller.scrollToBottom();
      composer.current?.focus();
    }, 'submit');
  }

  const cancelEdit = () => { setEditing(undefined); setError(undefined); composer.current?.focus(); };
  const saveEdit = () => {
    if (!editing?.text.trim() || busy) return;
    void act(async () => { await props.onEditQueue(editing.id, editing.text); cancelEdit(); });
  };
  const loadEarlier = () => {
    const viewport = scroller.scrollRef.current;
    if (viewport) prepend.current = { height: viewport.scrollHeight, top: viewport.scrollTop };
    setHistoryWindow((current) => earlierHistory(turns, current));
  };
  const workingLabel = displayedRun?.status === 'INTERRUPTING' ? 'Stopping…'
    : attentionPending ? 'Waiting for your answer'
    : displayedRun?.status === 'STARTING' || displayedRun?.status === 'QUEUED' ? 'Starting…'
    : activeReview ? 'Reviewing…' : 'Working…';
  const canSend = !busy && !blocked && !(needsText && !draft.trim());
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
            failure={turn === lastImplementation && turn.state !== 'active' ? props.failure : undefined}
            capture={turn.state === 'completed' ? props.capture(turn.run) : null}
            onReadArtifact={props.onReadArtifact} onShowDebug={props.onShowDebug} />)}
        {unattached.map((item) => <UserMessage key={item.id} text={item.text} time={item.createdAt}
          status={item.status === 'SENDING' ? 'Sending…' : item.status === 'UNCERTAIN' ? 'Delivery uncertain' : 'Not sent'} />)}
        {active && displayedRun && (attentionPending || displayedRun.status === 'INTERRUPTING'
          || displayedRun.status === 'STARTING' || displayedRun.status === 'QUEUED' || !liveWorkVisible)
          ? <div className="tm-agent-session__working">
            <StatusGlyph kind={attentionPending ? 'waiting' : 'working'} />
            <span role="status">{workingLabel}</span>
            <Elapsed since={displayedRun.startedAt} />
          </div> : null}
        <div ref={attention} tabIndex={-1} className="tm-agent-session__requests">
          <InteractionPanel interactions={props.interactions} sessions={props.sessions} onRespond={props.onRespond} />
        </div>
      </div>
    </Conversation>
    {run ? <div className="tm-agent-session__footer">
      <form className="tm-composer tm-agent-session__composer" aria-busy={busy} onSubmit={(event) => { event.preventDefault(); if (editing) saveEdit(); else void submit(); }}>
        <MessageQueue items={pending.map((item) => ({ id: item.id, text: item.text, held: item.status === 'HELD' }))}
          editingId={editing?.id} disabled={busy} continueDisabledReason={blocked}
          onContinue={!active ? (id) => void act(async () => {
            await props.onSendQueue(id, run.id); if (editing?.id === id) cancelEdit(); composer.current?.focus();
          }) : undefined}
          onEdit={(id) => {
            const item = pending.find((candidate) => candidate.id === id);
            if (item) { setEditing({ id, text: item.text }); setError(undefined); composer.current?.focus(); }
          }}
          onRemove={(id) => void act(async () => {
            await props.onEditQueue(id); if (editing?.id === id) cancelEdit(); composer.current?.focus();
          })} />
        {editing ? <div className="tm-agent-session__editing">
          <Pencil size={13} strokeWidth={1.25} absoluteStrokeWidth aria-hidden="true" />Editing queued message
          <button type="button" className="ghost-button" onClick={cancelEdit} disabled={busy}>Cancel</button>
        </div> : null}
        <label className="tm-visually-hidden" htmlFor={`agent-draft-${task.id}`}>{editing ? 'Edit queued instruction' : 'Instruction'}</label>
        <textarea ref={composer} id={`agent-draft-${task.id}`} rows={3} value={editing?.text ?? draft} readOnly={busy}
          aria-describedby={hint ? `agent-composer-note-${task.id}` : undefined} maxLength={TASK_INSTRUCTION_MAX_LENGTH}
          placeholder={mode ? delivery[mode].placeholder : 'Continue the work…'}
          onChange={(event) => { if (editing) setEditing({ ...editing, text: event.target.value }); else props.onDraftChange(event.target.value); }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (editing && event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); cancelEdit(); }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (editing) saveEdit(); else void submit(); }
          }} />
        <div className="tm-composer__toolbar">
          <span className="tm-agent-session__model" title={model}>{props.runtimeName ?? task.runtimeId}{model ? <span>{model}</span> : null}</span>
          {hint ? <span id={`agent-composer-note-${task.id}`} className="tm-composer__hint">{hint}</span> : null}
          {editing ? <button className="primary-button tm-composer__primary" type="submit" disabled={busy || !editing.text.trim()}>{busy ? 'Saving…' : 'Save'}</button> : <>
            {!active && actions?.canForkAlternative ? <ActionMenu label="More session actions" disabled={busy}
              trigger={<MoreHorizontal size={16} strokeWidth={1.5} aria-hidden="true" />}
              items={[{ label: 'Fork alternative', description: 'Start from the recorded base. Local changes are not included.', disabled: Boolean(blocked), disabledReason: blocked,
                onSelect: () => void act(() => props.onRetry(run.id, 'FORK', draft || undefined)) }]} /> : null}
            {displayedRun && canStopTaskRun(displayedRun) ? <button type="button" className="outline-button tm-composer__secondary" disabled={busy}
              title="Stop the current response" onClick={() => void act(() => props.onStop(displayedRun.id))}>Stop</button> : null}
            {mode ? <div className={`tm-composer__send${allowed.length > 1 ? ' tm-composer__send--split' : ''}`}>
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
        </div>
      </form>
      {currentError || props.draftError ? <p className="tm-error" role="alert">{currentError ?? props.draftError}</p> : null}
    </div> : null}
  </section>;
}

/**
 * Projects each run into a turn. Task detail arrives as a fresh snapshot on
 * every refresh, so finished turns are reused by record revision; only the
 * live turn is re-projected while output streams.
 */
function useSessionTurns(prompt: string, runs: RunRecord[], items: AgentItemRecord[], instructions: TaskInstruction[],
  plans: AgentPlanRevisionRecord[], cwd?: string): SessionTurn[] {
  const cache = useRef(new Map<string, { fingerprint: string; turn: SessionTurn }>());
  return useMemo(() => {
    const ordered = runs.filter((item) => isImplementationRunMode(item.mode) || item.mode === 'REVIEW')
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const first = ordered.find((item) => item.mode !== 'REVIEW');
    const itemsByRun = groupByRun(items);
    const instructionsByRun = groupByRun(instructions);
    const plansByRun = groupByRun(plans);
    const next = new Map<string, { fingerprint: string; turn: SessionTurn }>();
    const turns = ordered.map((turnRun) => {
      const runItems = itemsByRun.get(turnRun.id) ?? [];
      const runInstructions = instructionsByRun.get(turnRun.id) ?? [];
      const runPlans = plansByRun.get(turnRun.id) ?? [];
      const turnPrompt = turnRun === first ? prompt : undefined;
      const fingerprint = isActiveRunStatus(turnRun.status) ? '' : [
        turnRun.status, turnRun.endedAt, turnRun.lastEventAt, turnRun.eventCount, turnRun.finalMessage, turnRun.terminalReason,
        turnPrompt, cwd,
        ...runItems.map((record) => `${record.id}@${record.updatedAt}`),
        ...runInstructions.map((record) => `${record.id}@${record.updatedAt}`),
        ...runPlans.map((record) => `${record.id}@${record.revision}`)
      ].join('\u0000');
      const cached = cache.current.get(turnRun.id);
      const turn = fingerprint && cached?.fingerprint === fingerprint ? cached.turn
        : sessionTurn(turnRun, runItems, runInstructions, { prompt: turnPrompt, cwd, plans: runPlans });
      if (fingerprint) next.set(turnRun.id, { fingerprint, turn });
      return turn;
    });
    cache.current = next;
    return turns;
  }, [prompt, runs, items, instructions, plans, cwd]);
}

function groupByRun<T extends { runId?: string }>(records: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const record of records) {
    if (!record.runId) continue;
    const list = grouped.get(record.runId);
    if (list) list.push(record);
    else grouped.set(record.runId, [record]);
  }
  return grouped;
}

function Turn({ turn, clip, failure, capture, onReadArtifact, onShowDebug }: {
  turn: SessionTurn;
  clip: number;
  failure?: RunFailureBannerViewModel;
  capture: ReactNode;
  onReadArtifact?: (id: string) => Promise<string>;
  onShowDebug(): void;
}) {
  const entries = clip ? turn.entries.slice(clip) : turn.entries;
  const live = turn.state === 'active';
  return <div className="tm-turn">
    {turn.opener && !clip ? turn.opener.kind === 'prompt'
      ? <UserMessage text={turn.opener.text} time={turn.opener.at} />
      : <Message from="user" className="tm-message--action">
        <span className="tm-message__action">{turn.opener.label === 'Retried'
          ? <RotateCcw size={13} strokeWidth={1.25} absoluteStrokeWidth aria-hidden="true" />
          : <Play size={13} strokeWidth={1.25} absoluteStrokeWidth aria-hidden="true" />}{turn.opener.label}</span>
        <MessageMeta><MessageTime value={turn.opener.at} /></MessageMeta>
      </Message> : null}
    {entries.map((entry, index) => {
      if (entry.kind === 'message') return entry.author === 'You'
        ? <UserMessage key={entry.key} text={entry.text} time={entry.at} status={entry.status} />
        : <Message key={entry.key} from="agent" label="Agent response"><MessageContent><MessageMarkdown text={entry.text} /></MessageContent></Message>;
      if (entry.kind === 'steps') return <ActivitySteps key={entry.key} steps={entry.steps} live={live && index === entries.length - 1} />;
      return <PlanCard key={entry.key} steps={entry.plan.steps} marker={planMarker(turn.run, entry.plan)} live={live} />;
    })}
    {failure ? <div className="tm-turn__notice" data-status={failure.status}>
      <CircleAlert size={16} strokeWidth={1.5} absoluteStrokeWidth aria-hidden="true" />
      <div><strong>{failure.title}</strong><p>{failure.detail}</p></div>
    </div> : null}
    {capture ? <div className="tm-turn__changes">{capture}</div> : null}
    {live ? null : <TurnFooter turn={turn} onReadArtifact={onReadArtifact} onShowDebug={onShowDebug} />}
  </div>;
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

function UserMessage({ text, time, status }: { text: string; time: string; status?: string }) {
  return <Message from="user" label="Your message">
    <MessageContent user><p>{text}</p></MessageContent>
    <MessageMeta className={status ? 'tm-message__meta--status' : undefined}>
      <MessageTime value={time} />{status ? <span role="status">{status}</span> : null}
    </MessageMeta>
  </Message>;
}

function TurnFooter({ turn, onReadArtifact, onShowDebug }: {
  turn: SessionTurn; onReadArtifact?: (id: string) => Promise<string>; onShowDebug(): void;
}) {
  const [copied, setCopied] = useState(false);
  const [prompt, setPrompt] = useState<{ open: boolean; text?: string; error?: string }>({ open: false });
  const end = turn.run.endedAt ?? turn.run.lastEventAt;
  const promptArtifactId = turn.run.promptArtifactId;
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const showPrompt = () => {
    if (prompt.open) { setPrompt((current) => ({ ...current, open: false })); return; }
    setPrompt((current) => ({ ...current, open: true, error: undefined }));
    if (prompt.text !== undefined || !onReadArtifact || !promptArtifactId) return;
    void onReadArtifact(promptArtifactId)
      .then((text) => setPrompt((current) => ({ ...current, text })))
      .catch((caught: unknown) => setPrompt((current) => ({ ...current, error: caught instanceof Error ? caught.message : String(caught) })));
  };
  return <>
    <div className="tm-turn__footer">
      <span className="tm-turn__outcome" data-state={turn.state} title={turn.state === 'completed' ? undefined : turn.run.terminalReason}>{turnOutcomeLabel(turn)}</span>
      {end ? <><span aria-hidden="true">·</span><MessageTime value={end} /></> : null}
      {turn.answer ? <button type="button" className="tm-iconbtn tm-turn__action" aria-label={copied ? 'Copied' : 'Copy response'} title={copied ? 'Copied' : 'Copy response'}
        onClick={() => void navigator.clipboard?.writeText(turn.answer!).then(() => setCopied(true))}>
        {copied ? <Check size={14} strokeWidth={1.5} aria-hidden="true" /> : <Copy size={14} strokeWidth={1.5} aria-hidden="true" />}
      </button> : null}
      <ActionMenu className="tm-turn-menu" label="Response details" trigger={<MoreHorizontal size={16} strokeWidth={1.5} aria-hidden="true" />}
        items={[
          ...(onReadArtifact && promptArtifactId ? [{ label: prompt.open ? 'Hide sent prompt' : 'View sent prompt', description: 'The exact instructions the agent received', onSelect: showPrompt }] : []),
          { label: 'Open in Debug', description: 'Raw events and run records', onSelect: onShowDebug }
        ]} />
    </div>
    {prompt.open ? <section className="tm-turn__prompt" aria-label="Sent prompt">
      {prompt.error ? <p role="alert">{prompt.error}</p> : prompt.text === undefined ? <p>Loading prompt…</p> : <pre>{prompt.text}</pre>}
    </section> : null}
  </>;
}

function Elapsed({ since }: { since: string }) {
  const start = Date.parse(since);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return Number.isFinite(start) ? <span className="tm-agent-session__elapsed" aria-hidden="true">{formatElapsed(now - start)}</span> : null;
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
