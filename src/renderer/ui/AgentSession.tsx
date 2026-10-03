import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  AgentItemRecord, AgentPlanRevisionRecord, AgentSessionRecord, InteractionRequestRecord,
  AgentInteractionDecision, RunRecord, Task, TaskInstruction
} from '../../shared/contracts';
import { TASK_INSTRUCTION_MAX_LENGTH, isImplementationRunMode } from '../../shared/contracts';
import { getPostRunActionState } from '../model/postRunActions';
import { canStopTaskRun } from '../model/runProgress';
import { sessionEntries } from '../model/agentSession';
import { humanizeEnum } from './display';
import { MessageHeader } from './MessageHeader';
import { MessageMarkdown } from './MessageMarkdown';
import { InteractionPanel } from './InteractionPanel';
import { RunActivityTimeline } from './RunActivityTimeline';
import { RunHeader } from './RunHeader';
import { PlanList } from './Plan';

export interface AgentSessionProps {
  task: Task;
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ runId?: string; text: string }>();
  const currentError = error?.runId === run?.id ? error?.text : undefined;
  const [following, setFollowing] = useState(true);
  const [visibleTurns, setVisibleTurns] = useState(12);
  const [editing, setEditing] = useState<{ id: string; text: string }>();
  const inFlight = useRef(false);
  const messageId = useRef<{ text: string; mode: SendMode; runId: string; id: string } | undefined>(undefined);
  const history = useRef<HTMLDivElement>(null);
  const historyContent = useRef<HTMLDivElement>(null);
  const attention = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const followRef = useRef(true);
  const turns = useMemo(() => props.runs.filter((item) => isImplementationRunMode(item.mode) || item.mode === 'REVIEW')
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt)), [props.runs]);
  const pending = props.instructions.filter((item) => ['QUEUED', 'HELD'].includes(item.status)).sort((a, b) => a.order - b.order);
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
  const labels: Record<SendMode, string> = { QUEUE: 'Queue after run', STEER: 'Send now', CONTINUE: actions?.continuationLabel ?? 'Follow up', RETRY: 'Retry implementation' };
  const blocked = props.runtimeUnavailable ?? (activeReview ? 'Wait for the review to finish.'
    : attentionPending ? 'Answer the agent request before sending an instruction.'
    : run?.status === 'INTERRUPTING' ? 'Waiting for the agent to stop.'
    : ['DONE', 'CANCELED', 'ARCHIVED'].includes(task.workflowPhase) ? 'Reopen the task to continue work.'
    : !mode ? 'The agent is not ready for another instruction.' : undefined);
  const plan = useMemo(() => props.plans.filter((item) => item.runId === displayedRun?.id)
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0], [props.plans, displayedRun?.id]);

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
    viewport.scrollTop = viewport.scrollHeight;
    return () => observer.disconnect();
  }, []);

  async function act(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError(undefined);
    try { await action(); }
    catch (caught) { setError({ runId: run?.id, text: caught instanceof Error ? caught.message : String(caught) }); }
    finally { inFlight.current = false; setBusy(false); }
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
    });
  }

  return <section className="tm-agent-session" aria-label="Agent session">
    <div className="tm-agent-session__toolbar">
      <RunHeader running={active} tone={active ? 'neutral' : props.requiresRecovery ? 'error' : 'neutral'}
        operationName={props.runtimeName ?? task.runtimeId} scope={displayedRun?.observedSettings?.model ?? displayedRun?.requestedSettings.model ?? task.agentSettings.model}
        startedAt={displayedRun?.startedAt} trailingLabel={displayedRun ? humanizeEnum(displayedRun.status) : 'Not started'}
        onStop={displayedRun && canStopTaskRun(displayedRun) ? () => void act(() => props.onStop(displayedRun.id)) : undefined}
        stopDisabled={busy} />
      {active ? <span className="tm-agent-session__state" role="status">{humanizeEnum(displayedRun!.status)}</span> : null}
    </div>
    {run ? <div className="tm-agent-session__disclosures">
      <details><summary>Original request</summary><div className="tm-agent-session__original-request">{props.request}</div></details>
      {plan?.steps.length ? <details><summary>Plan {plan.steps.filter((step) => step.status === 'COMPLETED').length} / {plan.steps.length}</summary>
        <PlanList steps={plan.steps} marker={displayedRun && ['FAILED', 'INTERRUPTED', 'LOST', 'RECOVERY_REQUIRED'].includes(displayedRun.status)
          ? { index: plan.steps.findIndex((step) => step.status === 'IN_PROGRESS'), kind: displayedRun.status === 'INTERRUPTED' ? 'stopped' : 'failed' } : undefined} />
      </details> : null}
    </div> : null}
    <div ref={history} className="tm-agent-session__history" tabIndex={0} aria-label="Session history"
      onScroll={() => {
        const el = history.current!;
        const nearEnd = el.scrollHeight - el.clientHeight - el.scrollTop < 64;
        followRef.current = nearEnd; setFollowing(nearEnd);
      }}>
      <div ref={historyContent}>
        {!run ? <div className="tm-agent-session__empty">{props.request}{props.preRunAction}</div> : null}
        {turns.length > visibleTurns ? <button className="outline-button" onClick={() => {
          followRef.current = false; setFollowing(false); setVisibleTurns((count) => count + 12);
        }}>Show earlier turns ({turns.length - visibleTurns})</button> : null}
        {turns.slice(-visibleTurns).map((turn, index) => <SessionTurn key={turn.id} run={turn}
          ordinal={turns.length - Math.min(visibleTurns, turns.length) + index + 1}
          current={turn.id === displayedRun?.id} first={turn.id === turns[0]?.id}
          sessionBoundary={turns[turns.indexOf(turn) - 1]?.sessionId !== turn.sessionId}
          task={task} items={props.items} instructions={props.instructions} onShowDebug={props.onShowDebug}
          onReadArtifact={props.onReadArtifact} onShowReview={props.onShowReview} capture={props.capture} />)}
        {props.instructions.filter((item) => !props.runs.some((turn) => turn.id === item.runId) && ['FAILED', 'UNCERTAIN'].includes(item.status)).map((item) =>
          <div className="tm-agent-session__message" key={item.id}><MessageHeader author="You" time={item.createdAt} status="Not sent" tone="blocked" />
            <MessageMarkdown text={item.text} /><p className="tm-agent-session__hint">{item.detail}</p></div>)}
        <div ref={attention} tabIndex={-1} className="tm-agent-session__requests">
          <InteractionPanel interactions={props.interactions} sessions={props.sessions} onRespond={props.onRespond} />
          {props.requiresRecovery ? <p role="status">This run needs attention. Review its outcome before continuing or retrying.</p> : null}
        </div>
      </div>
    </div>
    {run ? <div className="tm-agent-session__footer">
      {!following ? <button className="outline-button" onClick={() => {
        followRef.current = true; setFollowing(true);
        if (history.current) history.current.scrollTop = history.current.scrollHeight;
      }}>Jump to latest</button> : null}
      {attentionPending ? <button className="outline-button" onClick={focusAttention}>Needs your answer</button> : null}
      {pending.length ? <details className="tm-agent-session__queue" open>
        <summary>{pending.length} {pending.some((item) => item.status === 'HELD') ? 'pending' : 'queued'} {pending.length === 1 ? 'instruction' : 'instructions'}</summary>
        <ol>{pending.map((item) => <li key={item.id}>
          {editing?.id === item.id ? <>
            <textarea aria-label="Edit queued instruction" autoFocus value={editing.text} maxLength={TASK_INSTRUCTION_MAX_LENGTH}
              onChange={(event) => setEditing({ id: item.id, text: event.target.value })} />
            <button className="outline-button" disabled={busy || !editing.text.trim()} onClick={() => void act(async () => {
              await props.onEditQueue(item.id, editing.text); setEditing(undefined); composer.current?.focus();
            })}>Save</button><button className="outline-button" onClick={() => setEditing(undefined)}>Cancel</button>
          </> : <><span className="tm-agent-session__queued-text">{item.text}</span>
            {item.status === 'HELD' ? <span className="tm-agent-session__hint">{item.detail}</span> : null}
            <div className="tm-agent-session__queue-actions">
              <button className="outline-button" disabled={busy} onClick={() => setEditing({ id: item.id, text: item.text })}>Edit</button>
              <button className="outline-button" disabled={busy} onClick={() => void act(() => props.onEditQueue(item.id))}>Remove</button>
              {item.status === 'HELD' && run && !active ? <button className="outline-button" disabled={busy || Boolean(blocked)} title={blocked}
                onClick={() => void act(() => props.onSendQueue(item.id, run.id))}>Continue with this instruction</button> : null}
            </div></>}
        </li>)}</ol>
      </details> : null}
      {run ? <form className="tm-agent-session__composer" aria-busy={busy} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <label className="tm-visually-hidden" htmlFor={`agent-draft-${task.id}`}>Instruction</label>
        <textarea ref={composer} id={`agent-draft-${task.id}`} rows={3} value={draft} readOnly={busy}
          aria-describedby={`agent-composer-note-${task.id}`} maxLength={TASK_INSTRUCTION_MAX_LENGTH} placeholder={queueable ? 'What should the agent do next?' : 'Continue the work…'}
          onChange={(event) => props.onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
              event.preventDefault(); void submit();
            }
          }} />
        <div className="tm-agent-session__compose-actions">
          <span id={`agent-composer-note-${task.id}`} className="tm-agent-session__hint">{blocked ?? (mode === 'QUEUE' ? 'Next turn after this run' : mode === 'STEER' ? 'Applies to the active turn' : 'Starts a new turn')} · ⌘/Ctrl Enter</span>
          {allowed.length > 1 ? <select aria-label="Instruction delivery" value={mode} disabled={busy || Boolean(blocked)}
            onChange={(event) => setChoice({ runId: run.id, mode: event.target.value as SendMode })}>
            {allowed.map((item) => <option key={item} value={item}>{labels[item]}</option>)}
          </select> : null}
          <button className="primary-button" type="submit" disabled={busy || Boolean(blocked) || (needsText && !draft.trim())} title={blocked}>
            {busy ? 'Sending…' : mode ? labels[mode] : 'Send instruction'}
          </button>
        </div>
      </form> : null}
      {currentError || props.draftError ? <p className="tm-error" role="alert">{currentError ?? props.draftError}</p> : null}
      {!active && actions?.canForkAlternative ? <details className="tm-agent-session__more"><summary>More actions</summary>
        <p className="tm-agent-session__hint">Fork from the recorded base. Current local changes are not included.</p>
        <button className="outline-button" disabled={busy || Boolean(blocked)} title={blocked}
          onClick={() => void act(() => props.onRetry(run!.id, 'FORK', draft || undefined))}>Fork alternative</button>
      </details> : null}
    </div> : null}
  </section>;
}

function SessionTurn({ run, current, first, ordinal, sessionBoundary, task, items, instructions, onShowDebug, onReadArtifact, onShowReview, capture }: {
  run: RunRecord; current: boolean; first: boolean; ordinal: number; sessionBoundary: boolean; task: Task;
  items: AgentItemRecord[]; instructions: TaskInstruction[]; onShowDebug(): void;
  onReadArtifact?: (id: string) => Promise<string>; onShowReview(): void; capture(run: RunRecord): ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [limit, setLimit] = useState(80);
  const [prompt, setPrompt] = useState<string>();
  const [promptError, setPromptError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const entries = useMemo(() => current || expanded ? sessionEntries(run, items, instructions) : [], [run, items, instructions, current, expanded]);
  const instruction = instructions.find((item) => item.runId === run.id && item.mode !== 'STEER');
  const label = run.mode === 'REVIEW' ? 'Agent review' : `Turn ${ordinal} · ${humanizeEnum(run.mode)}`;
  return <section className="tm-agent-session__turn">
    {sessionBoundary && !first ? <div className="tm-agent-session__boundary">{run.mode === 'REVIEW' ? 'Separate review session' : 'New agent session'}</div> : null}
    <button className="tm-agent-session__turn-heading" aria-expanded={current || expanded}
      onClick={() => setExpanded(!expanded)} disabled={current}>
      <span>{label}</span><span>{humanizeEnum(run.status)}</span>
    </button>
    {current || expanded ? <>
      {run.mode === 'REVIEW' ? <button className="outline-button" onClick={onShowReview}>View review result</button> : <>
        {first && !instruction ? <div className="tm-agent-session__message"><MessageHeader author="You" time={task.createdAt} /><MessageMarkdown text={task.prompt} /></div> : null}
        {!first && !instruction ? <p className="tm-agent-session__hint">Original instruction is available in the sent prompt.</p> : null}
        {entries.length > limit ? <button className="outline-button" onClick={() => setLimit((count) => count + 80)}>Show earlier activity ({entries.length - limit})</button> : null}
        {entries.slice(-limit).map((entry) => entry.kind === 'message'
          ? <div className="tm-agent-session__message" key={entry.key}><MessageHeader author={entry.author} time={entry.at} status={entry.status} />
              <MessageMarkdown text={entry.text} /></div>
          : <RunActivityTimeline key={entry.key} rows={entry.rows} live={false} onShowDebug={onShowDebug} />)}
        {capture(run)}
      </>}
      {run.terminalReason && ['FAILED', 'LOST', 'RECOVERY_REQUIRED'].includes(run.status) ? <p className="tm-error">{run.terminalReason}</p> : null}
      {onReadArtifact && run.promptArtifactId ? <details className="tm-agent-session__prompt" onToggle={(event) => {
        if (!event.currentTarget.open || prompt !== undefined || loading) return;
        setLoading(true); setPromptError(undefined);
        void onReadArtifact(run.promptArtifactId!).then(setPrompt).catch((caught: unknown) => setPromptError(String(caught))).finally(() => setLoading(false));
      }}><summary>View sent prompt</summary>{loading ? <p>Loading prompt…</p> : promptError ? <p role="alert">{promptError}</p> : <pre>{prompt}</pre>}</details> : null}
    </> : <p className="tm-agent-session__turn-preview">{instruction?.text ?? (first ? task.prompt : 'View recorded activity')}</p>}
  </section>;
}
