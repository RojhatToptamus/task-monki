import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { CircleMinus, ExternalLink, MessageSquare, RefreshCw, RotateCw } from 'lucide-react';
import type { PullRequestCheckLog } from '../../shared/contracts';
import { discussionAuthor, discussionSummary, type DiscussionView } from '../model/pullRequestFeedback';
import type { PullRequestRecordCheckRow, PullRequestRecordView, RecordTone } from '../model/pullRequestRecord';
import { DisclosureChevron } from './DisclosureChevron';
import { PullRequestStateIcon } from './PullRequestIcon';
import { StatusGlyph } from './StatusBadge';
import { OverviewSection } from './TaskOverview';
import { Tooltip } from './Tooltip';

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
  onOpenThreads?(): void;
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
  const noun = view.platform === 'GitLab' ? 'merge request' : 'pull request';
  const rows = view.checks?.rows ?? [];
  return (
    <OverviewSection
      title={view.platform === 'GitLab' ? 'Merge request' : 'Pull request'}
      inset
      className="tm-prrecord"
      aside={refresh ? (
        <span className="tm-prstatus__refreshline">
          {refresh.updated ? <span>{refresh.updated}</span> : null}
          <Tooltip label={refresh.reason ?? `Refresh ${noun}`}>
            <button type="button" className="tm-prstatus__refresh" disabled={refresh.disabled}
              aria-label={`Refresh ${noun}`} onClick={refresh.onRefresh}>
              <RefreshCw aria-hidden="true" size={13} />
            </button>
          </Tooltip>
        </span>
      ) : undefined}
    >
      {view.url ? (
        <a className="tm-prrecord__identity" href={view.url} target="_blank" rel="noreferrer">
          <Identity view={view} />
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
      <dl className="tm-props tm-prrecord__gates">
        {view.checks ? (
          <Row label="Checks">
            {rows.length > 0 ? (
              <button type="button" className="tm-prrecord__toggle" aria-expanded={checksOpen} aria-controls={checksId}
                onClick={() => setChecksOpen((open) => !open)}>
                <ToneGlyph tone={view.checks.tone} />
                <span>{view.checks.summary}</span>
                <DisclosureChevron />
              </button>
            ) : (
              <span className="tm-prrecord__value"><ToneGlyph tone={view.checks.tone} /><span>{view.checks.summary}</span></span>
            )}
          </Row>
        ) : null}
        {view.reviewers.length > 0 ? (
          <Row label="Reviews">
            <ul className="tm-prrecord__people">
              {view.reviewers.map((reviewer) => (
                <li key={reviewer.name}>
                  <span className="tm-prrecord__person">{reviewer.name}</span>
                  <span className="tm-prrecord__word" data-tone={reviewer.tone}>{reviewer.word}</span>
                  {/* A person who reviewed can be asked again; one already asked, or an app, cannot. */}
                  {onAskAgain && !reviewer.waiting && !reviewer.bot ? (
                    <Tooltip label={`Ask ${reviewer.name} to review again`}>
                      <button type="button" className="tm-prrecord__ask" aria-label={`Ask ${reviewer.name} to review again`}
                        disabled={Boolean(asking)} onClick={() => void askAgain(reviewer.name)}>
                        <RotateCw aria-hidden="true" size={13} />
                      </button>
                    </Tooltip>
                  ) : null}
                </li>
              ))}
            </ul>
            {askError ? <p className="form-error" role="alert">{askError}</p> : null}
          </Row>
        ) : view.review ? (
          <Row label="Review"><span className="tm-prrecord__word" data-tone={view.review.tone}>{view.review.word}</span></Row>
        ) : null}
        {view.threads ? (
          <Row label="Threads">
            {onOpenThreads && view.threads.unresolved > 0 ? (
              <button type="button" className="tm-osection__link tm-prrecord__link" onClick={onOpenThreads}>{view.threads.word}</button>
            ) : (
              <span className="tm-prrecord__word">{view.threads.word}</span>
            )}
          </Row>
        ) : null}
        {view.merge ? (
          <Row label="Merge"><span className="tm-prrecord__word" data-tone={view.merge.tone}>{view.merge.word}</span></Row>
        ) : null}
      </dl>
      {rows.length > 0 && checksOpen ? (
        <ul id={checksId} className="tm-prrecord__checks" aria-label="Checks">
          {rows.map((check) => <CheckRow key={`${check.name}-${check.workflow ?? ''}-${check.link ?? ''}`} check={check} />)}
        </ul>
      ) : null}
    </OverviewSection>
  );
}

function Identity({ view }: { view: PullRequestRecordView }) {
  return (
    <>
      <PullRequestStateIcon state={view.state} />
      <span className="tm-prrecord__number">{view.label}</span>
      {view.title ? <span className="tm-prrecord__title">{view.title}</span> : null}
      <span className="tm-visually-hidden">, {view.state}, opens on {view.platform}</span>
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="tm-props__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ToneGlyph({ tone }: { tone: RecordTone }) {
  return tone === 'success' ? <StatusGlyph kind="verified" />
    : tone === 'error' ? <StatusGlyph kind="blocked" />
      : tone === 'action' ? <StatusGlyph kind="working" />
        : <CircleMinus aria-hidden="true" size={13} className="tm-prrecord__idle" />;
}

const CHECK_TONES: Record<PullRequestRecordCheckRow['status'], RecordTone> = {
  passed: 'success',
  failed: 'error',
  pending: 'action',
  canceled: 'neutral',
  skipped: 'neutral'
};

const CHECK_WORDS: Record<PullRequestRecordCheckRow['status'], string> = {
  passed: 'Passed',
  failed: 'Failed',
  pending: 'Running',
  canceled: 'Canceled',
  skipped: 'Skipped'
};

/** One check: its mark, its name, how long it ran, and the platform's page for it. */
export function CheckRow({ check, children }: { check: PullRequestRecordCheckRow; children?: ReactNode }) {
  return (
    <li className="tm-prrecord__check" data-status={check.status}>
      <ToneGlyph tone={CHECK_TONES[check.status]} />
      <span className="tm-visually-hidden">{CHECK_WORDS[check.status]}:</span>
      <span className="tm-prrecord__checkname" title={check.workflow ? `${check.workflow}: ${check.name}` : check.name}>{check.name}</span>
      {check.duration ? <span className="tm-prrecord__duration">{check.duration}</span> : null}
      {children}
      {check.link ? (
        <Tooltip label={`Open ${check.name}`}>
          <a className="tm-prrecord__open" href={check.link} target="_blank" rel="noreferrer" aria-label={`Open ${check.name}`}>
            <ExternalLink aria-hidden="true" size={13} />
          </a>
        </Tooltip>
      ) : null}
    </li>
  );
}

/**
 * The checks a failed step names, each with the end of its log on request:
 * the shortest way from a red check to what failed. The log is read from the
 * platform when first opened, once per head.
 */
export function FailingChecks({
  rows,
  logs,
  onLoadLogs
}: {
  rows: PullRequestRecordCheckRow[];
  logs?: { status: 'loading' | 'ready' | 'error'; logs: PullRequestCheckLog[] };
  onLoadLogs?(): void;
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
      <ul className="tm-prrecord__checks">
        {shown.map((check) => (
          <CheckRow key={`${check.name}-${check.workflow ?? ''}-${check.link ?? ''}`} check={check}>
            {onLoadLogs ? (
              <button type="button" className="ghost-button button--sm tm-prstep__logtoggle"
                aria-expanded={open === checkKey(check)} aria-controls={logId}
                onClick={() => {
                  const next = open === checkKey(check) ? undefined : checkKey(check);
                  setOpen(next);
                  if (next && logs?.status !== 'ready' && logs?.status !== 'loading') onLoadLogs();
                }}>
                Log
              </button>
            ) : null}
          </CheckRow>
        ))}
      </ul>
      {rows.length > shown.length ? <p className="tm-slot__meta">{rows.length - shown.length} more failed</p> : null}
      {openCheck ? (
        <div id={logId} className="tm-prstep__log">
          {logs?.status === 'loading' ? <p className="tm-prstep__lognote">Reading the log…</p>
            : logs?.status === 'error' ? <p className="tm-prstep__lognote">The log could not be read.</p>
              : log ? (
                <>
                  {log.truncated ? <p className="tm-prstep__lognote">Earlier lines left out</p> : null}
                  <pre ref={logRef} tabIndex={0} aria-label={`End of the ${openCheck.name} log`}>{log.text}</pre>
                </>
              ) : <p className="tm-prstep__lognote">No log for this check here; its page has it.</p>}
        </div>
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
          const file = discussion.path?.split('/').at(-1);
          const where = file ? `${file}${discussion.line ? `:${discussion.line}` : ''}` : discussion.kind === 'REVIEW' ? 'Review' : undefined;
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
