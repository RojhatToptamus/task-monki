import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  AgentItemRecord, AgentPlanRevisionRecord, AgentSessionRecord, InteractionRequestRecord,
  AgentInteractionDecision, RunRecord, Task, TaskInstruction
} from '../../shared/contracts';
import { TASK_INSTRUCTION_MAX_LENGTH, isImplementationRunMode } from '../../shared/contracts';
import { getPostRunActionState } from '../model/postRunActions';
import { canStopTaskRun } from '../model/runProgress';
import { sessionEntries } from '../model/agentSession';
import { humanizeEnum } from './display';
import { MessageContent } from './MessageContent';
import { StatusGlyph } from './StatusBadge';
import { MessageMarkdown } from './MessageMarkdown';
import { InteractionPanel } from './InteractionPanel';
import { RunActivityTimeline } from './RunActivityTimeline';
import { PlanList } from './Plan';
import { ActionMenu } from './ActionMenu';
import { DisclosureChevron } from './DisclosureChevron';
import { ArrowDown, ArrowUp, ChevronDown, CornerDownRight, Info, ListOrdered, MoreHorizontal, Pencil, Play, RotateCcw, Square, X } from 'lucide-react';

export interface AgentSessionProps {
  task: Task;
  header?: ReactNode;
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
  request: ReactNode;
  preRunAction: ReactNode;
  capture(run: RunRecord): ReactNode;
  attentionRequested: number;
}

type SendMode = 'QUEUE' | 'STEER' | 'CONTINUE' | 'RETRY';

export function AgentSession(props: AgentSessionProps) {
  const { task, run, draft } = props;
  const [choice, setChoice] = useState<{ runId: string; mode: SendMode }>();
  const [pendingAction, setPendingAction] = useState<'submit' | 'other'>();
  const busy = pendingAction !== undefined;
  const [error, setError] = useState<{ runId?: string; text: string }>();
  const currentError = error?.runId === run?.id ? error?.text : undefined;
  const [reading] = useState(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem('task-monki:agent-reading') ?? 'null');
      return saved?.taskId === task.id && typeof saved.top === 'number' && Number.isFinite(saved.top) ? saved as { taskId: string; top: number; firstKey: string; following: boolean } : undefined;
    } catch { return undefined; }
  });
  const [following, setFollowing] = useState(reading?.following ?? true);
  const prepend = useRef<{ height: number; top: number } | undefined>(undefined);
  const [editing, setEditing] = useState<{ id: string; text: string }>();
  const inFlight = useRef(false);
  const messageId = useRef<{ text: string; mode: SendMode; runId: string; id: string } | undefined>(undefined);
  const history = useRef<HTMLDivElement>(null);
  const historyContent = useRef<HTMLDivElement>(null);
  const attention = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const followRef = useRef(reading?.following ?? true);
  const turns = useMemo(() => props.runs.filter((item) => isImplementationRunMode(item.mode) || item.mode === 'REVIEW')
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt)), [props.runs]);
  const pending = props.instructions.filter((item) => ['QUEUED', 'HELD'].includes(item.status)).sort((a, b) => a.order - b.order);
  const queuedCount = pending.filter((item) => item.status === 'QUEUED').length;
  const heldCount = pending.length - queuedCount;
  const attentionPending = props.interactions.some((item) => ['PENDING', 'RESPONDING'].includes(item.status));
  const activeReview = props.runs.find((item) => item.mode === 'REVIEW' && ['QUEUED', 'STARTING', 'RUNNING', 'AWAITING_APPROVAL', 'AWAITING_USER_INPUT', 'INTERRUPTING'].includes(item.status));
  const displayedRun = activeReview ?? run;
  const active = Boolean(displayedRun && ['QUEUED', 'STARTING', 'RUNNING', 'AWAITING_APPROVAL', 'AWAITING_USER_INPUT', 'INTERRUPTING'].includes(displayedRun.status));
  const actions = run ? getPostRunActionState(run, props.requiresRecovery) : undefined;
  const queueable = Boolean(run && run.status === 'RUNNING' && !activeReview);
  const allowed: SendMode[] = queueable
    ? ['QUEUE', ...(run?.status === 'RUNNING' && props.steeringSupported ? ['STEER' as const] : [])]
    : actions?.primaryRecoveryAction === 'retry' ? ['RETRY', 'CONTINUE']
    : actions?.canFollowUp || actions?.canContinue ? ['CONTINUE', ...(actions.canRetry ? ['RETRY' as const] : [])] : [];
  const mode = choice && choice.runId === run?.id && allowed.includes(choice.mode) ? choice.mode : allowed[0];
  const needsText = mode === 'QUEUE' || mode === 'STEER' || (run?.status === 'COMPLETED' && !props.requiresRecovery);
  const labels: Record<SendMode, string> = { QUEUE: 'Queue', STEER: 'Send now', CONTINUE: run?.status === 'COMPLETED' && !props.requiresRecovery ? 'Send' : 'Continue', RETRY: 'Retry' };
  const blocked = props.runtimeUnavailable ?? (activeReview ? 'Wait for the review to finish.'
    : attentionPending ? 'Answer the agent request before sending an instruction.'
    : run?.status === 'INTERRUPTING' ? 'Waiting for the agent to stop.'
    : ['DONE', 'CANCELED', 'ARCHIVED'].includes(task.workflowPhase) ? 'Reopen the task to continue work.'
    : !mode ? 'The agent is not ready for another instruction.' : undefined);
  const conversation = useMemo(() => turns.flatMap((turn) => {
    const entries = turn.mode === 'REVIEW' ? [] : sessionEntries(turn, props.items, props.instructions, props.worktreePath, props.plans);
    return [...entries.map((entry) => ({ ...entry, run: turn })),
      { key: `${turn.id}:outcome`, at: turn.endedAt ?? turn.startedAt, kind: 'outcome' as const, run: turn }];
  }), [turns, props.items, props.instructions, props.worktreePath, props.plans]);
  const lastResponseKeys = useMemo(() => {
    const keys = new Map<string, string>();
    for (const entry of conversation) if (entry.kind === 'message' && entry.author === 'Agent') keys.set(entry.run.id, entry.key);
    return keys;
  }, [conversation]);
  const [firstEntry, setFirstEntry] = useState(() => {
    const saved = reading ? conversation.findIndex((entry) => entry.key === reading.firstKey) : -1;
    return saved >= 0 ? saved : Math.max(0, conversation.length - 80);
  });
  const visible = conversation.slice(firstEntry);
  const firstKey = useRef(visible[0]?.key);
  firstKey.current = visible[0]?.key;
  const workingLabel = displayedRun?.status === 'INTERRUPTING' ? 'Stopping…'
    : attentionPending ? 'Waiting for your answer' : displayedRun?.status === 'STARTING' || displayedRun?.status === 'QUEUED' ? 'Starting…'
    : activeReview ? 'Reviewing…' : 'Working…';
  // Loading older messages is a prepend, not a request to follow new output.
  useLayoutEffect(() => {
    if (prepend.current && history.current) {
      history.current.scrollTop = prepend.current.top + history.current.scrollHeight - prepend.current.height;
      prepend.current = undefined;
    }
  }, [firstEntry]);

  const focusAttention = () => {
    attention.current?.scrollIntoView({ block: 'nearest' });
    const input = attention.current?.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled), button:not(:disabled)');
    (input ?? attention.current)?.focus();
  };
  useEffect(() => {
    if (props.attentionRequested) focusAttention();
  }, [props.attentionRequested]);
  // Follow content growth only while the user is already at the bottom. Never steal focus.
  useEffect(() => {
    const viewport = history.current;
    const content = historyContent.current;
    if (!viewport || !content) return;
    const observer = new ResizeObserver(() => {
      if (followRef.current) viewport.scrollTop = viewport.scrollHeight;
    });
    observer.observe(content);
    observer.observe(viewport);
    viewport.scrollTop = reading && !reading.following ? reading.top : viewport.scrollHeight;
    const remember = () => {
      try { sessionStorage.setItem('task-monki:agent-reading', JSON.stringify({ taskId: task.id, top: viewport.scrollTop, firstKey: firstKey.current, following: followRef.current })); } catch { /* Optional local reading position. */ }
    };
    window.addEventListener('pagehide', remember);
    return () => { remember(); observer.disconnect(); window.removeEventListener('pagehide', remember); };
  }, []);

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
      followRef.current = true; setFollowing(true);
      composer.current?.focus();
    }, 'submit');
  }

  const pauseFollowing = () => { followRef.current = false; setFollowing(false); };
  const cancelEdit = () => { setEditing(undefined); setError(undefined); composer.current?.focus(); };
  const saveEdit = () => {
    if (!editing?.text.trim() || busy) return;
    void act(async () => { await props.onEditQueue(editing.id, editing.text); cancelEdit(); });
  };

  return <section className="tm-agent-session" aria-label="Agent session">
    <div className="tm-agent-session__conversation">
      <div ref={history} className="tm-agent-session__history" tabIndex={0} aria-label="Session history"
        onClickCapture={(event) => { if ((event.target as HTMLElement).closest('summary')) pauseFollowing(); }}
        onScroll={() => {
          const el = history.current!;
          const nearEnd = el.scrollHeight - el.clientHeight - el.scrollTop < 64;
          followRef.current = nearEnd; setFollowing(nearEnd);
        }}>
        <div ref={historyContent}>
          {props.header}
          <div className="tm-agent-session__messages">
          {run ? <ConversationMessage user text={task.prompt} time={task.createdAt} /> : <div className="tm-agent-session__empty">{props.request}{props.preRunAction}</div>}
          {firstEntry > 0 ? <button className="ghost-button tm-agent-session__earlier" onClick={() => {
            pauseFollowing();
            if (history.current) prepend.current = { height: history.current.scrollHeight, top: history.current.scrollTop };
            setFirstEntry((index) => Math.max(0, index - 80));
          }}>Load earlier messages</button> : null}
          {visible.map((entry) => {
            if (entry.kind === 'message') return <ConversationMessage key={entry.key} user={entry.author === 'You'} text={entry.text} time={entry.at} status={entry.status}
              details={lastResponseKeys.get(entry.run.id) === entry.key && entry.run.endedAt ? <SessionDetails run={entry.run} onReadArtifact={props.onReadArtifact} onShowDebug={props.onShowDebug} /> : undefined} />;
            if (entry.kind === 'activity') return <RunActivityTimeline key={entry.key} rows={entry.rows} live={false} compact onShowDebug={props.onShowDebug} />;
            if (entry.kind === 'reasoning') return <details key={entry.key} className="tm-agent-session__support" onClick={pauseFollowing}>
              <summary><DisclosureChevron />Reasoning</summary><MessageMarkdown text={entry.text} />
            </details>;
            if (entry.kind === 'plan') return <details key={entry.key} className="tm-agent-session__support" onClick={pauseFollowing}>
              <summary><DisclosureChevron />Plan <span>{entry.plan.steps.filter((step) => step.status === 'COMPLETED').length} / {entry.plan.steps.length}</span></summary>
              <PlanList steps={entry.plan.steps} marker={['COMPLETED', 'FAILED', 'INTERRUPTED', 'LOST', 'RECOVERY_REQUIRED'].includes(entry.run.status)
                ? { index: entry.plan.steps.findIndex((step) => step.status === 'IN_PROGRESS'), kind: entry.run.status === 'COMPLETED' ? 'unfinished' : entry.run.status === 'INTERRUPTED' ? 'stopped' : 'failed' } : undefined} />
            </details>;
            if (entry.run.mode === 'REVIEW') return <div key={entry.key} className="tm-agent-session__outcome"><button className="ghost-button" onClick={props.onShowReview}>View agent review</button></div>;
            if (['QUEUED', 'STARTING', 'RUNNING', 'AWAITING_APPROVAL', 'AWAITING_USER_INPUT', 'INTERRUPTING'].includes(entry.run.status)) return null;
            return <div key={entry.key} className="tm-agent-session__outcome">
              {entry.run.status !== 'COMPLETED' ? <span className="tm-agent-session__outcome-label" data-failed={entry.run.status !== 'INTERRUPTED'}>
                {entry.run.status === 'INTERRUPTED' ? 'Stopped' : 'The agent could not finish.'}
              </span> : null}
              <div className="tm-agent-session__capture">{props.capture(entry.run)}</div>
              {!lastResponseKeys.has(entry.run.id) ? <SessionDetails run={entry.run} onReadArtifact={props.onReadArtifact} onShowDebug={props.onShowDebug} /> : null}
            </div>;
          })}
          {props.instructions.filter((item) => !props.runs.some((turn) => turn.id === item.runId) && ['FAILED', 'UNCERTAIN'].includes(item.status)).map((item) =>
            <ConversationMessage key={item.id} user text={item.text} time={item.createdAt} status={item.status === 'UNCERTAIN' ? 'Delivery uncertain' : 'Not sent'} />)}
          {active ? <div className="tm-agent-session__working" role="status">
            <StatusGlyph kind={attentionPending ? 'waiting' : 'working'} /><span>{workingLabel}</span>
          </div> : null}
          <div ref={attention} tabIndex={-1} className="tm-agent-session__requests">
            <InteractionPanel interactions={props.interactions} sessions={props.sessions} onRespond={props.onRespond} />
          </div>
          </div>
        </div>
      </div>
      {!following ? <button className="tm-agent-session__latest" onClick={() => {
        followRef.current = true; setFollowing(true);
        if (history.current) history.current.scrollTop = history.current.scrollHeight;
      }}><ArrowDown size={13} strokeWidth={1.5} aria-hidden="true" />Jump to latest</button> : null}
    </div>
    {run ? <div className="tm-agent-session__footer">
      <form className="tm-composer tm-agent-session__composer" aria-busy={busy} onSubmit={(event) => { event.preventDefault(); if (editing) saveEdit(); else void submit(); }}>
        {pending.length ? <details className="tm-agent-session__queue" open>
          <summary><DisclosureChevron /><ListOrdered size={16} strokeWidth={1.5} aria-hidden="true" />
            <span>{pending.length} {heldCount ? 'pending' : 'queued'}</span>
            <span className="tm-agent-session__hint">{heldCount ? (queuedCount ? `${queuedCount} queued · ${heldCount} paused` : 'Paused · Continue when ready') : 'After this response'}</span>
          </summary>
          <ol aria-label="Pending instructions">{pending.map((item, index) => <li key={item.id} aria-current={editing?.id === item.id ? true : undefined}>
            <span className="tm-agent-session__queue-order" aria-hidden="true">{index + 1}</span>
            <span className="tm-agent-session__queued-text" title={item.text}>{item.text}</span>
            <div className="tm-agent-session__queue-actions">
              {heldCount > 0 && queuedCount > 0 && item.status === 'HELD' ? <span className="tm-agent-session__hint">Paused</span> : null}
              {item.status === 'HELD' && !active ? <button type="button" className="tm-iconbtn" aria-label={`Continue instruction ${index + 1}`} disabled={busy || Boolean(blocked)} title={blocked ?? 'Continue with this instruction'}
                onClick={() => void act(async () => { await props.onSendQueue(item.id, run.id); if (editing?.id === item.id) cancelEdit(); composer.current?.focus(); })}><Play size={16} strokeWidth={1.5} aria-hidden="true" /></button> : null}
              <button type="button" className="tm-iconbtn" aria-label={`Edit instruction ${index + 1}`} title="Edit instruction" disabled={busy} onClick={() => { setEditing({ id: item.id, text: item.text }); setError(undefined); composer.current?.focus(); }}><Pencil size={16} strokeWidth={1.5} aria-hidden="true" /></button>
              <button type="button" className="tm-iconbtn" aria-label={`Remove instruction ${index + 1}`} title="Remove instruction" disabled={busy} onClick={() => void act(async () => { await props.onEditQueue(item.id); if (editing?.id === item.id) cancelEdit(); composer.current?.focus(); })}><X size={16} strokeWidth={1.5} aria-hidden="true" /></button>
            </div>
          </li>)}</ol>
        </details> : null}
        {editing ? <div className="tm-agent-session__edit-label"><Pencil size={13} strokeWidth={1.5} aria-hidden="true" />Editing queued message <button type="button" className="ghost-button" onClick={cancelEdit} disabled={busy}>Cancel</button></div> : null}
        <label className="tm-visually-hidden" htmlFor={`agent-draft-${task.id}`}>{editing ? 'Edit queued instruction' : 'Instruction'}</label>
        <textarea ref={composer} id={`agent-draft-${task.id}`} rows={2} value={editing?.text ?? draft} readOnly={busy}
          aria-describedby={`agent-composer-note-${task.id}`} maxLength={TASK_INSTRUCTION_MAX_LENGTH} placeholder={queueable ? 'What should the agent do next?' : 'Continue the work…'}
          onChange={(event) => { if (editing) setEditing({ ...editing, text: event.target.value }); else props.onDraftChange(event.target.value); }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (editing && event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); cancelEdit(); }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (editing) saveEdit(); else void submit(); }
          }} />
        <div className="tm-agent-session__compose-actions">
          <span className="tm-agent-session__model" title={displayedRun?.observedSettings?.model ?? displayedRun?.requestedSettings.model}>
            {props.runtimeName ?? task.runtimeId}<span>{displayedRun?.observedSettings?.model ?? displayedRun?.requestedSettings.model}</span>
          </span>
          <span id={`agent-composer-note-${task.id}`} className="tm-visually-hidden">{editing ? '⌘/Ctrl Enter to save' : blocked ?? '⌘/Ctrl Enter to send'}</span>
          {editing ? <button className="primary-button" type="submit" disabled={busy || !editing.text.trim()}>{busy ? 'Saving…' : 'Save'}</button> : <>
            {displayedRun && canStopTaskRun(displayedRun) ? <button type="button" className="ghost-button tm-composer-action" aria-label="Stop" title="Stop response" disabled={busy} onClick={() => void act(() => props.onStop(displayedRun.id))}><Square size={14} strokeWidth={1.5} aria-hidden="true" /></button> : null}
            {!active && actions?.canForkAlternative ? <ActionMenu label="More session actions" disabled={busy}
              trigger={<MoreHorizontal size={16} strokeWidth={1.5} aria-hidden="true" />}
              items={[{ label: 'Fork alternative', description: 'Start from the recorded base. Local changes are not included.', disabled: Boolean(blocked), disabledReason: blocked,
                onSelect: () => void act(() => props.onRetry(run.id, 'FORK', draft || undefined)) }]} /> : null}
            <div className="tm-agent-session__send">
              {allowed.length > 1 ? <ActionMenu label="Instruction delivery" selection="single" disabled={busy || Boolean(blocked)}
                trigger={<>{mode === 'QUEUE' ? 'After response' : mode === 'STEER' ? 'Send now' : labels[mode]}<ChevronDown size={13} strokeWidth={1.5} aria-hidden="true" /></>}
                items={allowed.map((item) => ({ label: item === 'QUEUE' ? 'Queue after run' : labels[item], pressed: mode === item,
                  description: item === 'STEER' ? 'Apply to the active response' : item === 'QUEUE' ? 'Send when the current work finishes' : undefined,
                  onSelect: () => setChoice({ runId: run.id, mode: item }) }))} /> : mode === 'QUEUE' ? <span className="tm-agent-session__hint">After response</span> : null}
              <button className="primary-button tm-composer-action" type="submit" aria-label={mode ? labels[mode] : 'Send'}
                disabled={busy || Boolean(blocked) || (needsText && !draft.trim())}
                title={blocked ?? (needsText && !draft.trim() ? 'Write a message first' : `${mode ? labels[mode] : 'Send'} · ⌘/Ctrl Enter`)}>
                {pendingAction === 'submit' ? <StatusGlyph kind="working" /> : mode === 'QUEUE' ? <CornerDownRight size={16} strokeWidth={1.5} aria-hidden="true" />
                  : mode === 'RETRY' ? <RotateCcw size={16} strokeWidth={1.5} aria-hidden="true" />
                  : mode === 'CONTINUE' && !needsText ? <Play size={16} strokeWidth={1.5} aria-hidden="true" /> : <ArrowUp size={16} strokeWidth={1.5} aria-hidden="true" />}
              </button>
            </div>
          </>}
        </div>
      </form>
      {currentError || props.draftError ? <p className="tm-error" role="alert">{currentError ?? props.draftError}</p> : null}
    </div> : null}
  </section>;
}

function ConversationMessage({ user = false, text, time, status, details }: { user?: boolean; text: string; time: string; status?: string; details?: ReactNode }) {
  return <article className={`tm-agent-session__message ${user ? 'tm-agent-session__message--user' : ''}`} aria-label={user ? 'Your message' : 'Agent response'}>
    <MessageContent user={user}>{user ? <p>{text}</p> : <MessageMarkdown text={text} />}</MessageContent>
    <footer><time dateTime={time} title={new Date(time).toLocaleString()}>{new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(time))}</time>{status ? <span role="status">{status}</span> : null}{details}</footer>
  </article>;
}

function SessionDetails({ run, onReadArtifact, onShowDebug }: {
  run: RunRecord; onReadArtifact?: (id: string) => Promise<string>; onShowDebug(): void;
}) {
  const [prompt, setPrompt] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  return <details className="tm-agent-session__details">
    <summary title="Run details" aria-label="Run details"><Info size={13} strokeWidth={1.5} aria-hidden="true" /></summary>
    <div className="tm-agent-session__details-body">
      <p>{humanizeEnum(run.mode)} · {humanizeEnum(run.status)} · <code>{run.id}</code></p>
      {run.terminalReason ? <p>{run.terminalReason}</p> : null}
      <button type="button" className="ghost-button" onClick={onShowDebug}>Open Debug</button>
      {onReadArtifact && run.promptArtifactId ? <details className="tm-agent-session__prompt" onToggle={(event) => {
        if (!event.currentTarget.open || prompt !== undefined || loading) return;
        setLoading(true); setError(undefined);
        void onReadArtifact(run.promptArtifactId).then(setPrompt).catch((caught: unknown) => setError(String(caught))).finally(() => setLoading(false));
      }}><summary><DisclosureChevron />View sent prompt</summary>{loading ? <p>Loading prompt…</p> : error ? <p role="alert">{error}</p> : <pre>{prompt}</pre>}</details> : null}
    </div>
  </details>;
}
