import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, CircleAlert, Copy, MoreHorizontal, Play, RotateCcw } from 'lucide-react';
import type {
  AgentItemRecord, AgentPlanRevisionRecord, InteractionRequestRecord, RunRecord, TaskAttachmentRecord, TaskInstruction
} from '../../shared/contracts';
import type { AttachmentContent } from '../../shared/attachments';
import { formatElapsed, isActiveRunStatus, planMarker, sessionTurn, turnOutcomeLabel, type SessionTurn } from '../model/agentSession';
import type { RunFailureBannerViewModel } from '../model/taskView';
import { ActionMenu } from './ActionMenu';
import { ActivitySteps } from './ActivitySteps';
import { StoredAttachmentChip } from './AttachmentChip';
import { Message, MessageContent, MessageMeta, MessageTime } from './Message';
import { MessageMarkdown } from './MessageMarkdown';
import { PlanCard } from './Plan';
import { UserInputSummary } from './UserInputSummary';

/**
 * Projects each run into a turn. Task detail arrives as a fresh snapshot on
 * every refresh, so finished turns are reused by record revision; only the
 * live turn is re-projected while output streams. Callers pass the runs of one
 * conversation; `prompt` opens the earliest non-review turn when no authored
 * message does.
 */
export function useSessionTurns(input: {
  runs: RunRecord[];
  items: AgentItemRecord[];
  instructions: TaskInstruction[];
  plans: AgentPlanRevisionRecord[];
  interactions: InteractionRequestRecord[];
  cwd?: string;
  prompt?: string;
}): SessionTurn[] {
  const { runs, items, instructions, plans, interactions, cwd, prompt } = input;
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
      const fingerprint = isActiveRunStatus(turnRun.status) ? '' : [
        turnRun.status, turnRun.endedAt, turnRun.lastEventAt, turnRun.eventCount, turnRun.finalMessage, turnRun.terminalReason,
        turnPrompt, cwd,
        ...runItems.map((record) => `${record.id}@${record.updatedAt}`),
        ...runInstructions.map((record) => `${record.id}@${record.updatedAt}`),
        ...runInteractions.map((record) => `${record.id}@${record.status}@${record.respondedAt}@${record.resolvedAt}`),
        ...runPlans.map((record) => `${record.id}@${record.revision}`)
      ].join('\u0000');
      const cached = cache.current.get(turnRun.id);
      const turn = fingerprint && cached?.fingerprint === fingerprint ? cached.turn
        : sessionTurn(turnRun, runItems, runInstructions, { prompt: turnPrompt, cwd, plans: runPlans, interactions: runInteractions });
      if (fingerprint) next.set(turnRun.id, { fingerprint, turn });
      return turn;
    });
    cache.current = next;
    return turns;
  }, [prompt, runs, items, instructions, plans, interactions, cwd]);
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
export function Turn({ turn, clip = 0, failure, capture, onReadArtifact, onShowDebug, attachments = [], onReadAttachment }: {
  turn: SessionTurn;
  clip?: number;
  failure?: RunFailureBannerViewModel;
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
      ? <UserMessage text={turn.opener.text} time={turn.opener.at} attachments={attachments} onReadAttachment={onReadAttachment} />
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
      if (entry.kind === 'interaction') return <UserInputSummary key={entry.key} interaction={entry.interaction} />;
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

export function UserMessage({ text, time, status, attachments, onReadAttachment }: {
  text: string; time: string; status?: string; attachments?: TaskAttachmentRecord[]; onReadAttachment?: ReadAttachment;
}) {
  return <Message from="user" label="Your message">
    <MessageContent user><p>{text}</p></MessageContent>
    {attachments?.length ? <ul className="task-attachments" aria-label="Message attachments">
      {attachments.map((file) => <StoredAttachmentChip key={file.id} attachment={file} onRead={onReadAttachment ? () => onReadAttachment(file.id) : undefined} />)}
    </ul> : null}
    <MessageMeta className={status ? 'tm-message__meta--status' : undefined}>
      <MessageTime value={time} />{status ? <span role="status">{status}</span> : null}
    </MessageMeta>
  </Message>;
}

function TurnFooter({ turn, onReadArtifact, onShowDebug }: {
  turn: SessionTurn; onReadArtifact?: (id: string) => Promise<string>; onShowDebug?(): void;
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
  const details = [
    ...(onReadArtifact && promptArtifactId ? [{ label: prompt.open ? 'Hide sent prompt' : 'View sent prompt', description: 'The exact instructions the agent received', onSelect: showPrompt }] : []),
    ...(onShowDebug ? [{ label: 'Open in Debug', description: 'Raw events and run records', onSelect: onShowDebug }] : [])
  ];
  return <>
    <div className="tm-turn__footer">
      <span className="tm-turn__outcome" data-state={turn.state} title={turn.state === 'completed' ? undefined : turn.run.terminalReason}>{turnOutcomeLabel(turn)}</span>
      {end ? <><span aria-hidden="true">·</span><MessageTime value={end} /></> : null}
      {turn.answer ? <button type="button" className="tm-iconbtn tm-turn__action" aria-label={copied ? 'Copied' : 'Copy response'} title={copied ? 'Copied' : 'Copy response'}
        onClick={() => void navigator.clipboard?.writeText(turn.answer!).then(() => setCopied(true))}>
        {copied ? <Check size={14} strokeWidth={1.5} aria-hidden="true" /> : <Copy size={14} strokeWidth={1.5} aria-hidden="true" />}
      </button> : null}
      {details.length ? <ActionMenu className="tm-turn-menu" label="Response details" trigger={<MoreHorizontal size={16} strokeWidth={1.5} aria-hidden="true" />} items={details} /> : null}
    </div>
    {prompt.open ? <section className="tm-turn__prompt" aria-label="Sent prompt">
      {prompt.error ? <p role="alert">{prompt.error}</p> : prompt.text === undefined ? <p>Loading prompt…</p> : <pre>{prompt.text}</pre>}
    </section> : null}
  </>;
}

export function Elapsed({ since }: { since: string }) {
  const start = Date.parse(since);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return Number.isFinite(start) ? <span className="tm-agent-session__elapsed" aria-hidden="true">{formatElapsed(now - start)}</span> : null;
}
