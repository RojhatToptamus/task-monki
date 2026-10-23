import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Bug, CircleAlert, MoreHorizontal, Play, RotateCcw } from 'lucide-react';
import { CopyIconButton } from './CopyIconButton';
import type {
  AgentItemRecord, AgentPlanRevisionRecord, InteractionRequestRecord, RunRecord, TaskAttachmentRecord, TaskInstruction
} from '../../shared/contracts';
import type { AttachmentContent } from '../../shared/attachments';
import { formatElapsed, isActiveRunStatus, planMarker, sessionTurn, turnOutcomeLabel, workedMs, type PersonWait, type SessionTurn } from '../model/agentSession';
import type { RunFailureBannerViewModel } from '../model/taskView';
import { ActionMenu } from './ActionMenu';
import { ActivitySteps } from './ActivitySteps';
import { StoredAttachmentChip } from './AttachmentChip';
import { Message, MessageContent, MessageMeta, MessageTime } from './Message';
import { MessageMarkdown } from './MessageMarkdown';
import { PlanCard } from './Plan';
import { ReviewAnswers, ReviewRequestCard } from './ReviewRound';
import { UserInputSummary } from './UserInputSummary';
import { ReportedQuote } from './ReportedQuote';

/**
 * Projects each run into a turn. Task detail arrives as a fresh snapshot on
 * every refresh, so finished turns are reused by record revision; only the
 * live turn is re-projected while output streams. Callers pass the runs of one
 * conversation; `prompt` opens the earliest non-review turn when no authored
 * message does, and `openedFrom` names the issue it starts from when there is
 * no prompt.
 */
export function useSessionTurns(input: {
  runs: RunRecord[];
  items: AgentItemRecord[];
  instructions: TaskInstruction[];
  plans: AgentPlanRevisionRecord[];
  interactions: InteractionRequestRecord[];
  cwd?: string;
  prompt?: string;
  openedFrom?: string;
}): SessionTurn[] {
  const { runs, items, instructions, plans, interactions, cwd, prompt, openedFrom } = input;
  const cache = useRef(new Map<string, { fingerprint: string; turn: SessionTurn }>());
  return useMemo(() => {
    const ordered = [...runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const first = ordered.find((item) => item.mode !== 'REVIEW');
    const itemsByRun = groupByRun(items);
    const instructionsByRun = groupByRun(instructions);
    const plansByRun = groupByRun(plans);
    const interactionsByRun = groupByRun(interactions);
    const next = new Map<string, { fingerprint: string; turn: SessionTurn }>();
    const turns = ordered.map((turnRun) => {
      const runItems = itemsByRun.get(turnRun.id) ?? [];
      const runInstructions = instructionsByRun.get(turnRun.id) ?? [];
      const runPlans = plansByRun.get(turnRun.id) ?? [];
      const runInteractions = interactionsByRun.get(turnRun.id) ?? [];
      const turnPrompt = turnRun === first ? prompt : undefined;
      const turnOpenedFrom = turnRun === first ? openedFrom : undefined;
      const fingerprint = isActiveRunStatus(turnRun.status) ? '' : [
        turnRun.status, turnRun.endedAt, turnRun.lastEventAt, turnRun.eventCount, turnRun.finalMessage, turnRun.terminalReason,
        turnPrompt, turnOpenedFrom, cwd,
        ...runItems.map((record) => `${record.id}@${record.updatedAt}`),
        ...runInstructions.map((record) => `${record.id}@${record.updatedAt}`),
        ...runInteractions.map((record) => `${record.id}@${record.status}@${record.respondedAt}@${record.resolvedAt}`),
        ...runPlans.map((record) => `${record.id}@${record.revision}`)
      ].join('\u0000');
      const cached = cache.current.get(turnRun.id);
      const turn = fingerprint && cached?.fingerprint === fingerprint ? cached.turn
        : sessionTurn(turnRun, runItems, runInstructions, { prompt: turnPrompt, openedFrom: turnOpenedFrom, cwd, plans: runPlans, interactions: runInteractions });
      if (fingerprint) next.set(turnRun.id, { fingerprint, turn });
      return turn;
    });
    cache.current = next;
    return turns;
  }, [prompt, openedFrom, runs, items, instructions, plans, interactions, cwd]);
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

type ReadAttachment = (id: string) => Promise<AttachmentContent>;

/** One run as the person sees it: the opener, the agent's messages and steps, then the outcome. */
/** The recorded bug a turn carried to the agent, shown with its message as an attachment is. */
export interface TurnBug {
  title: string;
  onOpen(): void;
}

export function Turn({ turn, clip = 0, failure, sourceName, capture, onReadArtifact, onShowDebug, attachments = [], onReadAttachment, bug }: {
  turn: SessionTurn;
  bug?: TurnBug;
  clip?: number;
  failure?: RunFailureBannerViewModel;
  /** Who recorded the run's own reason, so it is quoted under that name. */
  sourceName?: string;
  capture?: ReactNode;
  onReadArtifact?: (id: string) => Promise<string>;
  onShowDebug?(): void;
  attachments?: TaskAttachmentRecord[];
  onReadAttachment?: ReadAttachment;
}) {
  const entries = clip ? turn.entries.slice(clip) : turn.entries;
  const live = turn.state === 'active';
  return <div className="tm-turn">
    {turn.opener && !clip ? turn.opener.kind === 'prompt'
      ? turn.opener.reviewRequest
        ? <ReviewRequestCard request={turn.opener.reviewRequest} time={turn.opener.at} />
        : <UserMessage text={turn.opener.text} time={turn.opener.at} attachments={attachments} onReadAttachment={onReadAttachment} bug={bug} />
      : <Message from="user" className="tm-message--action">
        <span className="tm-message__action">{turn.opener.label === 'Retried'
          ? <RotateCcw size={13} aria-hidden="true" />
          : <Play size={13} aria-hidden="true" />}{turn.opener.label}</span>
        <MessageMeta><MessageTime value={turn.opener.at} /></MessageMeta>
      </Message> : null}
    {entries.map((entry, index) => {
      if (entry.kind === 'message') return entry.author === 'You'
        ? <UserMessage key={entry.key} text={entry.text} time={entry.at} status={entry.status} />
        : <Message key={entry.key} from="agent" label="Agent response"><MessageContent>
          {entry.text ? <MessageMarkdown text={entry.text} /> : null}
          {entry.answers && turn.opener?.kind === 'prompt' && turn.opener.reviewRequest
            ? <ReviewAnswers request={turn.opener.reviewRequest} answers={entry.answers} /> : null}
        </MessageContent></Message>;
      if (entry.kind === 'interaction') return <UserInputSummary key={entry.key} interaction={entry.interaction} />;
      if (entry.kind === 'steps') return <ActivitySteps key={entry.key} steps={entry.steps} live={live && index === entries.length - 1} />;
      return <PlanCard key={entry.key} steps={entry.plan.steps} marker={planMarker(turn.run, entry.plan)} live={live} />;
    })}
    {failure ? <div className="tm-notice tm-turn__notice" data-tone={failure.status === 'LOST' || failure.status === 'RECOVERY_REQUIRED' ? 'waiting' : undefined}>
      <CircleAlert size={16} aria-hidden="true" />
      <div><strong className="tm-notice__title">{failure.title}</strong>{failure.detail ? <p>{failure.detail}</p> : null}
        {failure.reportedReason ? <ReportedQuote className="tm-turn__reported" source={sourceName ?? 'Agent'}>{failure.reportedReason}</ReportedQuote> : null}</div>
    </div> : null}
    {capture ? <div className="tm-turn__changes">{capture}</div> : null}
    {live ? null : <TurnFooter turn={turn} noticeShown={Boolean(failure)} onReadArtifact={onReadArtifact} onShowDebug={onShowDebug} />}
  </div>;
}

export function UserMessage({ text, time, status, attachments, onReadAttachment, bug }: {
  text: string; time: string; status?: string; attachments?: TaskAttachmentRecord[]; onReadAttachment?: ReadAttachment; bug?: TurnBug;
}) {
  return <Message from="user" label="Your message">
    <MessageContent user><p>{text}</p></MessageContent>
    {attachments?.length || bug ? <ul className="task-attachments" aria-label="Message attachments">
      {bug ? <li className="task-attachment">
        <span className="task-attachment__preview" aria-hidden="true"><Bug size={16} /></span>
        <span className="task-attachment__body">
          <button type="button" className="task-attachment__name task-attachment__open" onClick={bug.onOpen}>{bug.title}</button>
          <span className="task-attachment__meta">Recorded bug</span>
        </span>
      </li> : null}
      {attachments?.map((file) => <StoredAttachmentChip key={file.id} attachment={file} onRead={onReadAttachment ? () => onReadAttachment(file.id) : undefined} />)}
    </ul> : null}
    <MessageMeta className={status ? 'tm-message__meta--status' : undefined}>
      <MessageTime value={time} />{status ? <span role="status">{status}</span> : null}
    </MessageMeta>
  </Message>;
}

function TurnFooter({ turn, noticeShown, onReadArtifact, onShowDebug }: {
  turn: SessionTurn;
  /** The notice above already names how the run ended; only a duration adds to it. */
  noticeShown: boolean;
  onReadArtifact?: (id: string) => Promise<string>;
  onShowDebug?(): void;
}) {
  const [prompt, setPrompt] = useState<{ open: boolean; text?: string; error?: string }>({ open: false });
  const end = turn.run.endedAt ?? turn.run.lastEventAt;
  const outcome = noticeShown && (turn.durationMs ?? 0) < 1000 ? undefined : turnOutcomeLabel(turn);
  const promptArtifactId = turn.run.promptArtifactId;
  const showPrompt = () => {
    if (prompt.open) { setPrompt((current) => ({ ...current, open: false })); return; }
    setPrompt((current) => ({ ...current, open: true, error: undefined }));
    if (prompt.text !== undefined || !onReadArtifact || !promptArtifactId) return;
    void onReadArtifact(promptArtifactId)
      .then((text) => setPrompt((current) => ({ ...current, text })))
      .catch((caught: unknown) => setPrompt((current) => ({ ...current, error: caught instanceof Error ? caught.message : String(caught) })));
  };
  const details = [
    ...(onReadArtifact && promptArtifactId ? [{ label: prompt.open ? 'Hide sent prompt' : 'View sent prompt', description: 'The exact instructions the agent received', onSelect: showPrompt }] : []),
    ...(onShowDebug ? [{ label: 'Open in Debug', description: 'Raw events and run records', onSelect: onShowDebug }] : [])
  ];
  return <>
    <div className="tm-turn__footer">
      {outcome ? <span className="tm-turn__outcome" data-state={turn.state} title={turn.state === 'completed' ? undefined : turn.run.terminalReason}>{outcome}</span> : null}
      {end ? <MessageTime value={end} /> : null}
      {turn.answer ? <CopyIconButton value={turn.answer} label="Copy response" size={13} className="tm-iconbtn tm-turn__action" /> : null}
      {details.length ? <ActionMenu className="tm-turn-menu" label="Response details" tooltip="Response details" trigger={<MoreHorizontal size={13} aria-hidden="true" />} items={details} /> : null}
    </div>
    {prompt.open ? <section className="tm-turn__prompt" aria-label="Sent prompt">
      {prompt.error ? <p role="alert">{prompt.error}</p> : prompt.text === undefined ? <p>Loading prompt…</p> : <pre>{prompt.text}</pre>}
    </section> : null}
  </>;
}

/**
 * Messages no run carries yet: still sending, delivery uncertain, or refused
 * before a run was admitted. A panel shows them after its turns.
 */
export function unattachedInstructions(instructions: readonly TaskInstruction[], runs: readonly { id: string }[]): TaskInstruction[] {
  return instructions.filter((item) =>
    !runs.some((run) => run.id === item.runId) && (item.status === 'SENDING' || item.status === 'UNCERTAIN' || (item.status === 'FAILED' && !item.runId))
  );
}

/** Those messages, each with its delivery state. */
export function UnattachedMessages({ instructions }: { instructions: readonly TaskInstruction[] }) {
  return <>
    {instructions.map((item) => (
      <UserMessage
        key={item.id}
        text={item.text}
        time={item.createdAt}
        status={item.status === 'FAILED' ? item.detail ?? 'Not sent' : item.status === 'UNCERTAIN' ? 'Delivery uncertain' : 'Sending…'}
      />
    ))}
  </>;
}

/** The one live line while an agent works: what it is doing, and for how long. */
export function WorkingLine({ label, since }: { label: string; since: string }) {
  return (
    <div className="tm-side-conversation__working">
      <span role="status" className="tm-shimmer">{label}</span>
      <Elapsed since={since} />
    </div>
  );
}

/** How long the work has run; time spent waiting on the person (`waits`) does not count. */
export function Elapsed({ since, waits }: { since: string; waits?: readonly PersonWait[] }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const worked = workedMs(since, now, waits);
  return worked !== undefined ? <span className="tm-agent-session__elapsed" aria-hidden="true">{formatElapsed(worked)}</span> : null;
}
