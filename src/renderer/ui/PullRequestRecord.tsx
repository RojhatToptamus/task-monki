import { useId, useLayoutEffect, useRef, useState } from 'react';
import { CircleMinus, ExternalLink, MessageSquare, RefreshCw, RotateCw } from 'lucide-react';
import { remoteProviderName, remoteWorkLabel, remoteWorkNoun, type PullRequestCheckLog } from '../../shared/contracts';
import { discussionAuthor, discussionSummary, type DiscussionView } from '../model/pullRequestFeedback';
import type { PullRequestRecordCheckRow, PullRequestRecordView, RecordTone } from '../model/pullRequestRecord';
import { DisclosureChevron } from './DisclosureChevron';
import { PullRequestStateIcon } from './PullRequestIcon';
import { StatusGlyph } from './StatusBadge';
import { OverviewSection, PropRow } from './TaskOverview';
import { Tooltip } from './Tooltip';

/**
 * When the pull request was last read, and the control that reads it again.
 * While the control is disabled, its reason takes the time's place, tied to
 * the control so the keyboard reaches it too; a reason the card already states
 * elsewhere is tied by its id instead.
 */
export function PullRequestRefresh({ updated, reason, describedBy, disabled, noun, onRefresh }: {
  updated?: string;
  reason?: string;
  /** The id of the disabled reason when the card states it beside another action. */
  describedBy?: string;
  disabled?: boolean;
  noun: string;
  onRefresh(): void;
}) {
  const reasonId = useId();
  const why = disabled ? reason : undefined;
  return (
    <span className="tm-prstatus__refreshline">
      {why ? <span id={reasonId} className="tm-prstatus__refreshtext" title={why}>{why}</span>
        : updated ? <span className="tm-prstatus__refreshtext">{updated}</span> : null}
      <Tooltip label={`Refresh ${noun}`}>
        <button type="button" className="tm-prstatus__refresh" disabled={disabled} aria-label={`Refresh ${noun}`}
          aria-describedby={why ? reasonId : disabled ? describedBy : undefined} onClick={onRefresh}>
          <RefreshCw aria-hidden="true" size={13} />
        </button>
      </Tooltip>
    </span>
  );
}

/**
 * The task's pull request in its record: where it goes, and each gate a merge
 * waits on, from Task Monki's evidence for its current head. It sits beside
 * the step the Now panel asks for and asks nothing itself.
 */
export function PullRequestRecord({
  view,
  refresh,
  onOpenThreads,
  onAskAgain
}: {
  view: PullRequestRecordView;
  refresh?: { updated?: string; disabled: boolean; reason?: string; onRefresh(): void };
  /** Opens the discussions where they are read and answered. */
  onOpenThreads(): void;
  /** Asks a reviewer to review again, as beside their name on the platform; rejects with its reason. */
  onAskAgain?(reviewer: string): Promise<void>;
}) {
  const [checksOpen, setChecksOpen] = useState(false);
  const [asking, setAsking] = useState<string>();
  const [askError, setAskError] = useState<string>();
  const checksId = useId();
  const askAgain = async (reviewer: string) => {
    if (!onAskAgain || asking) return;
    setAsking(reviewer);
    setAskError(undefined);
    try {
      await onAskAgain(reviewer);
    } catch (caught) {
      setAskError(caught instanceof Error ? caught.message : `Could not ask ${reviewer} to review again.`);
    } finally {
      setAsking(undefined);
    }
  };
  const noun = remoteWorkNoun(view.provider, 'PULL_REQUEST');
  const rows = view.checks?.rows ?? [];
  return (
    <OverviewSection
      title={remoteWorkLabel(view.provider, 'PULL_REQUEST')}
      inset
      className="tm-prrecord"
      aside={refresh ? <PullRequestRefresh {...refresh} noun={noun} /> : undefined}
    >
      {view.url ? (
        <a className="tm-prrecord__identity" href={view.url} target="_blank" rel="noreferrer">
          <Identity view={view} link />
        </a>
      ) : (
        <p className="tm-prrecord__identity"><Identity view={view} /></p>
      )}
      {view.head || view.base ? (
        <p className="tm-prrecord__branches">
          {view.head ? <code title={view.head}>{view.head}</code> : null}
          {view.head && view.base ? <span aria-hidden="true">→</span> : null}
          {view.base ? <code>{view.base}</code> : null}
        </p>
      ) : null}
      {/* The gates share one label column; the checks open under their own row. */}
      <div className="tm-prrecord__gates">
        {view.checks ? (
          <dl className="tm-props">
            <PropRow label="Checks" value={rows.length > 0 ? (
              <button type="button" className="tm-prrecord__toggle" aria-expanded={checksOpen} aria-controls={checksId}
                onClick={() => setChecksOpen((open) => !open)}>
                <span className="tm-prrecord__word" data-tone={view.checks.tone}>{view.checks.summary}</span>
                <DisclosureChevron />
              </button>
            ) : (
              <span className="tm-prrecord__word" data-tone={view.checks.tone}>{view.checks.summary}</span>
            )} />
          </dl>
        ) : null}
        {rows.length > 0 && checksOpen ? (
          <ul id={checksId} className="tm-prrecord__checks" aria-label="Checks">
            {rows.map((check) => <CheckRow key={`${check.name}-${check.workflow ?? ''}-${check.link ?? ''}`} check={check} />)}
          </ul>
        ) : null}
        <dl className="tm-props">
        {view.reviewers.length > 0 ? (
          <PropRow label="Reviews" value={<>
            <ul className="tm-prrecord__people">
              {view.reviewers.map((reviewer) => (
                <li key={reviewer.name}>
                  <span className="tm-prrecord__person">{reviewer.name}</span>
                  <span className="tm-prrecord__word" data-tone={reviewer.tone}>{reviewer.word}</span>
                  {/* A person who reviewed can be asked again; one already asked, or an app, cannot. */}
                  {onAskAgain && !reviewer.waiting && !reviewer.bot ? (
                    <Tooltip label={`Ask ${reviewer.name} to review again`}>
                      <button type="button" className="tm-iconbtn tm-prrecord__iconbtn tm-prrecord__ask" aria-label={`Ask ${reviewer.name} to review again`}
                        disabled={Boolean(asking)} onClick={() => void askAgain(reviewer.name)}>
                        <RotateCw aria-hidden="true" size={13} />
                      </button>
                    </Tooltip>
                  ) : null}
                </li>
              ))}
            </ul>
            {askError ? <p className="form-error" role="alert">{askError}</p> : null}
          </>} />
        ) : view.review ? (
          <PropRow label="Review" value={<span className="tm-prrecord__word" data-tone={view.review.tone}>{view.review.word}</span>} />
        ) : null}
        {view.threads ? (
          <PropRow label="Threads" value={view.threads.unresolved > 0 ? (
            <button type="button" className="tm-osection__link tm-prrecord__link" onClick={onOpenThreads}>{view.threads.word}</button>
          ) : (
            <span className="tm-prrecord__word">{view.threads.word}</span>
          )} />
        ) : null}
        {view.merge ? (
          <PropRow label="Merge" value={<span className="tm-prrecord__word" data-tone={view.merge.tone}>{view.merge.word}</span>} />
        ) : null}
        </dl>
      </div>
    </OverviewSection>
  );
}

/** The pull request's mark, number and title; its state in words, and where it opens when it is a link. */
function Identity({ view, link = false }: { view: PullRequestRecordView; link?: boolean }) {
  return (
    <>
      <PullRequestStateIcon state={view.state} />
      <span className="tm-prrecord__number">{view.label}</span>
      {view.title ? <span className="tm-prrecord__title">{view.title}</span> : null}
      <span className="tm-visually-hidden">, {view.state}{link ? `, opens on ${remoteProviderName(view.provider)}` : null}</span>
    </>
  );
}

/** A check row's mark: verified, blocked, running, or nothing asked. */
function ToneGlyph({ tone }: { tone: RecordTone }) {
  return tone === 'success' ? <StatusGlyph kind="verified" />
    : tone === 'error' ? <StatusGlyph kind="blocked" />
      : tone === 'working' ? <StatusGlyph kind="working" />
        : <CircleMinus aria-hidden="true" size={13} className="tm-prrecord__idle" />;
}

const CHECK_TONES: Record<PullRequestRecordCheckRow['status'], RecordTone> = {
  passed: 'success',
  failed: 'error',
  pending: 'working',
  canceled: 'neutral',
  skipped: 'neutral'
};

const CHECK_WORDS: Record<PullRequestRecordCheckRow['status'], string> = {
  passed: 'Passed',
  failed: 'Failed',
  pending: 'Pending',
  canceled: 'Canceled',
  skipped: 'Skipped'
};

/** One check: its mark, its name, its state in words, how long it ran, and the platform's page for it. */
function CheckRow({ check }: { check: PullRequestRecordCheckRow }) {
  return (
    <li className="tm-prrecord__check" data-status={check.status}>
      <ToneGlyph tone={CHECK_TONES[check.status]} />
      <span className="tm-prrecord__checkname" title={check.workflow ? `${check.workflow}: ${check.name}` : check.name}>{check.name}</span>
      {/* In a list the mark carries the tone; the word beside it stays neutral. */}
      <span className="tm-prrecord__word">{CHECK_WORDS[check.status]}</span>
      {check.duration ? <span className="tm-prrecord__duration">{check.duration}</span> : null}
      {check.link ? (
        <Tooltip label={`Open ${check.name}`}>
          <a className="tm-iconbtn tm-prrecord__iconbtn" href={check.link} target="_blank" rel="noreferrer" aria-label={`Open ${check.name}`}>
            <ExternalLink aria-hidden="true" size={13} />
          </a>
        </Tooltip>
      ) : null}
    </li>
  );
}

/**
 * The checks a failed step names, each with the end of its log on request:
 * the shortest way from a red check to what failed. A row is its own
 * disclosure; the log is read from the platform when first opened, once per head.
 */
export function FailingChecks({
  rows,
  logs,
  onLoadLogs
}: {
  rows: PullRequestRecordCheckRow[];
  logs?: { status: 'loading' | 'ready' | 'error'; logs: PullRequestCheckLog[] };
  onLoadLogs(): void;
}) {
  const [open, setOpen] = useState<string>();
  const logId = useId();
  const logRef = useRef<HTMLPreElement>(null);
  const shown = rows.slice(0, 3);
  const openCheck = shown.find((check) => checkKey(check) === open);
  // Two checks can share a name across workflows; a log is the check's by its page when it has one.
  const log = openCheck ? logs?.logs.find((candidate) => (candidate.link ?? candidate.name) === checkKey(openCheck)) : undefined;
  // The failure is at the end, so a log opens there; a re-render keeps where the person scrolled.
  useLayoutEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log?.text]);
  return (
    <div className="tm-prstep__checks">
      <ul className="tm-prstep__checklist" aria-label="Failed checks">
        {shown.map((check) => {
          const key = checkKey(check);
          return (
            <li key={`${check.name}-${check.workflow ?? ''}-${check.link ?? ''}`} className="tm-prstep__check">
              <button type="button" className="tm-prstep__checktoggle" aria-expanded={open === key} aria-controls={logId}
                aria-label={`${check.name} log`}
                onClick={() => {
                  const next = open === key ? undefined : key;
                  setOpen(next);
                  if (next && logs?.status !== 'ready' && logs?.status !== 'loading') onLoadLogs();
                }}>
                <ToneGlyph tone={CHECK_TONES[check.status]} />
                <span className="tm-prstep__checkname" title={check.workflow ? `${check.workflow}: ${check.name}` : check.name}>{check.name}</span>
                <DisclosureChevron />
                {check.duration ? <span className="tm-prrecord__duration">{check.duration}</span> : null}
              </button>
              {check.link ? (
                <Tooltip label={`Open ${check.name}`}>
                  <a className="tm-iconbtn tm-prrecord__iconbtn" href={check.link} target="_blank" rel="noreferrer" aria-label={`Open ${check.name}`}>
                    <ExternalLink aria-hidden="true" size={13} />
                  </a>
                </Tooltip>
              ) : null}
            </li>
          );
        })}
      </ul>
      {rows.length > shown.length ? <p className="tm-slot__meta">{rows.length - shown.length} more failed</p> : null}
      {openCheck ? (
        logs?.status === 'loading' ? (
          // Reading holds the open log's height, so nothing below moves when it arrives.
          <div id={logId} className="tm-prstep__log tm-prstep__log--loading">
            <p className="tm-prstep__lognote">Reading the log…</p>
          </div>
        ) : logs?.status === 'error' ? (
          <p id={logId} className="tm-prstep__lognote">Log could not be read</p>
        ) : log ? (
          <>
            {log.truncated ? <p className="tm-prstep__lognote">Earlier lines left out</p> : null}
            <div id={logId} className="tm-prstep__log">
              <pre ref={logRef} tabIndex={0} aria-label={`End of the ${openCheck.name} log`}>{log.text}</pre>
            </div>
          </>
        ) : <p id={logId} className="tm-prstep__lognote">No log for this check</p>
      ) : null}
    </div>
  );
}

/** Comments listed under a step before the rest wait in Review. */
const ASKED_COMMENTS_SHOWN = 4;

/**
 * The comments a step asks about, each by who wrote it and where: read before
 * they go to the agent. A row opens its discussion in Review, where it is
 * answered.
 */
export function AskedComments({ discussions, onShow }: {
  discussions: readonly DiscussionView[];
  onShow(discussionId: string): void;
}) {
  const shown = discussions.slice(0, ASKED_COMMENTS_SHOWN);
  return (
    <div className="tm-prstep__comments">
      <ul className="tm-prstep__commentlist" aria-label="Comments">
        {shown.map((discussion) => {
          // A place is a file and line, set in mono; a review's own words have none.
          const file = discussion.path?.split('/').at(-1);
          const where = file ? `${file}${discussion.line ? `:${discussion.line}` : ''}` : undefined;
          return (
            <li key={discussion.id}>
              <button type="button" className="tm-prstep__comment" onClick={() => onShow(discussion.id)}>
                <MessageSquare aria-hidden="true" size={13} />
                <span className="tm-prstep__commentauthor">{discussionAuthor(discussion) ?? 'Unknown'}</span>
                <span className="tm-prstep__commenttext">{discussionSummary(discussion)}</span>
                {where ? <span className="tm-prstep__commentwhere" title={discussion.path}>{where}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
      {discussions.length > shown.length ? <p className="tm-slot__meta">{discussions.length - shown.length} more</p> : null}
    </div>
  );
}

/** A check by its page when it has one, else by its name. */
function checkKey(check: PullRequestRecordCheckRow): string {
  return check.link ?? check.name;
}
