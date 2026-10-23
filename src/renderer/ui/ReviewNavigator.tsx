import { useCallback, useState, type ReactElement, type RefObject } from 'react';
import { ChevronRight, Search, X } from 'lucide-react';
import { remoteProviderName, type AgentReviewResolvedFinding, type ReviewComment } from '../../shared/contracts';
import { discussionAuthor, discussionSummary, type DiscussionView } from '../model/pullRequestFeedback';
import type { ReviewRequestPlan } from '../model/reviewFollowUp';
import { matchesFileQuery } from '../model/reviewNavigation';
import { discussionStateWord } from '../model/reviewRounds';
import type { ReviewFindingView } from '../model/reviewWorkspace';
import { ReviewFileList, ReviewFileRow } from './ReviewFileRow';
import { settledLabel, severityLabel } from './ReviewFindingThread';
import type { ReviewModel } from './useReviewModel';

export type ReviewRail = 'files' | 'feedback';

/**
 * The Diff's navigator: its switch on top, then the files in reading order
 * under a filter, with the current one under the `--sel` plane, or every
 * finding, comment and discussion by what happens to it. The workspace keeps
 * the choice, so a trip to the Guide and back finds it as it was.
 */
export function ReviewNavigator({ model, rail, onRailChange, filterRef }: {
  model: ReviewModel;
  rail: ReviewRail;
  onRailChange(rail: ReviewRail): void;
  /** The filter's field, which / puts the caret in. */
  filterRef: RefObject<HTMLInputElement | null>;
}) {
  const { actions, props } = model;
  const comments = props.draft.comments;
  const { notes } = model;
  const [query, setQuery] = useState('');
  const openFile = useCallback((fileId: string) => actions.showFile(fileId, { open: true }), [actions]);
  const viewedCount = model.ordered.filter(({ file }) => model.viewedIds.has(file.id)).length;
  const fileCount = model.ordered.length;
  const feedbackCount = (props.findingsSendable ? props.plan.send.length + props.plan.suggestions.length : model.openFindings.length) +
    comments.length + model.discussions.filter((discussion) => !discussion.resolved).length;
  const matches = query.trim() ? model.ordered.filter(({ file }) => matchesFileQuery(file.path, query)) : model.ordered;
  return (
    <div className="tm-review__rail">
      <div className="segmented segmented--fill tm-review__rail-switch" role="group" aria-label="Show">
        <button type="button" className="segmented__btn" aria-pressed={rail === 'files'} onClick={() => onRailChange('files')}>
          Files<span className="tm-review__rail-count">
            {viewedCount ? <><span aria-hidden="true">{viewedCount}/{fileCount}</span><span className="tm-visually-hidden">{viewedCount} of {fileCount} viewed</span></> : fileCount}
          </span>
        </button>
        <button type="button" className="segmented__btn" aria-pressed={rail === 'feedback'} onClick={() => onRailChange('feedback')}>
          Feedback<span className="tm-review__rail-count">{feedbackCount}</span>
        </button>
      </div>
      {rail === 'files' ? (
        <>
          <div className="tm-filefilter__search tm-review__filter">
            <Search size={13} className="tm-filefilter__search-icon" aria-hidden="true" />
            <input
              ref={filterRef}
              type="search"
              value={query}
              placeholder="Filter files"
              aria-label="Filter files"
              aria-keyshortcuts="/"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                // Enter goes to the first file that matches; Escape clears the filter, then hands the keys back to the code.
                if (event.key === 'Enter' && matches[0]) { event.preventDefault(); openFile(matches[0].file.id); }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  if (query) setQuery('');
                  else actions.scroller()?.focus({ preventScroll: true });
                }
              }}
            />
            {query ? (
              <button type="button" className="tm-iconbtn tm-review__mini" aria-label="Clear filter" onClick={() => { setQuery(''); filterRef.current?.focus(); }}>
                <X size={13} aria-hidden="true" />
              </button>
            ) : null}
          </div>
          <nav className="tm-review__index" aria-label="Files">
            {matches.length ? (
              <ReviewFileList current={model.activeFileId}>
                {matches.map(({ file }) => (
                  <ReviewFileRow
                    key={file.id}
                    file={file}
                    current={model.activeFileId === file.id}
                    viewed={model.viewedIds.has(file.id)}
                    feedback={notes.get(file.id)?.count ?? 0}
                    blocking={notes.get(file.id)?.blocking ?? false}
                    onSelect={openFile}
                  />
                ))}
              </ReviewFileList>
            ) : fileCount ? <p className="tm-review__index-empty">No files match</p> : null}
          </nav>
        </>
      ) : (
        <nav className="tm-review__index" aria-label="Feedback">
          <FeedbackList
            plan={props.plan}
            findingsSendable={props.findingsSendable}
            findings={props.findings}
            comments={comments}
            discussions={model.discussions}
            moreDiscussionsUrl={props.moreDiscussionsUrl}
            resolved={props.resolvedFindings ?? []}
            focusedFindingId={model.focusedFindingId}
            focusedDiscussionId={model.focusedDiscussionId}
            onShowFinding={actions.showFinding}
            onShowComment={actions.showComment}
            onShowDiscussion={actions.showDiscussion}
          />
        </nav>
      )}
    </div>
  );
}

/**
 * Every finding, comment and pull request discussion, grouped by what happens
 * to it: sent with the request, offered as a suggestion, still on the platform,
 * or, for an out-of-date review, its findings as context. What is settled
 * (dismissed, accepted, resolved) folds into one last group.
 */
function FeedbackList({ plan, findingsSendable, findings, comments, discussions, moreDiscussionsUrl, resolved, focusedFindingId, focusedDiscussionId, onShowFinding, onShowComment, onShowDiscussion }: {
  plan: ReviewRequestPlan;
  findingsSendable: boolean;
  findings: readonly ReviewFindingView[];
  comments: readonly ReviewComment[];
  discussions: readonly DiscussionView[];
  moreDiscussionsUrl?: string;
  resolved: readonly AgentReviewResolvedFinding[];
  focusedFindingId?: string;
  focusedDiscussionId?: string;
  onShowFinding(findingId: string): void;
  onShowComment(commentId: string): void;
  onShowDiscussion(discussionId: string): void;
}) {
  const [settledOpen, setSettledOpen] = useState(false);
  const findingRow = (finding: ReviewFindingView, state?: string) => (
    <FeedbackRow
      key={finding.id}
      text={finding.title}
      lead={{ label: severityLabel(finding), tone: finding.severity === 'BLOCKER' || finding.severity === 'MAJOR' ? 'blocked' : undefined }}
      state={state}
      place={placeOf(finding)}
      current={focusedFindingId === finding.id}
      onSelect={() => onShowFinding(finding.id)}
    />
  );
  const commentRow = (comment: ReviewComment) => (
    <FeedbackRow key={comment.id} text={comment.text} lead={{ label: 'You' }} place={placeOf(comment)} onSelect={() => onShowComment(comment.id)} />
  );
  // Other people's words lead with what they said; who said it follows with its state and place.
  const discussionRow = (discussion: DiscussionView) => {
    const state = discussionStateWord(discussion);
    return (
      <FeedbackRow
        key={discussion.id}
        text={discussionSummary(discussion)}
        lead={{ label: discussionAuthor(discussion) ?? 'Unknown' }}
        state={state}
        stateTone={discussion.sent?.outcome === 'NEEDS_DECISION' && !discussion.resolved ? 'waiting' : undefined}
        place={placeOf(discussion)}
        current={focusedDiscussionId === discussion.id}
        onSelect={() => onShowDiscussion(discussion.id)}
      />
    );
  };
  // A resolved finding is no longer in the code, so it has nowhere to go to.
  const resolvedRow = (finding: AgentReviewResolvedFinding) => (
    <FeedbackRow key={finding.previousFindingId} text={finding.title} lead={{ label: 'Resolved' }} state={finding.note} />
  );
  const platform = discussions[0] ? remoteProviderName(discussions[0].provider) : undefined;
  const added = new Set(plan.discussions.map((discussion) => discussion.id));
  // On the platform: what still asks for something and was not sent, then what was sent, then remarks.
  const onPlatform = discussions
    .filter((discussion) => !discussion.resolved && !added.has(discussion.id))
    .sort((left, right) => discussionRank(left) - discussionRank(right));
  // A bounded read says so where the discussions are listed, with the way to the rest.
  const more = platform && moreDiscussionsUrl
    ? <a className="tm-review__index-more" href={moreDiscussionsUrl} target="_blank" rel="noreferrer">More on {platform}</a>
    : undefined;
  const onPlatformGroup = platform ? [{ label: `On ${platform}`, rows: onPlatform.map(discussionRow), end: more }] : [];
  const groups: Array<{ label: string; rows: ReactElement[]; end?: ReactElement }> = findingsSendable
    ? [
      { label: 'To send', rows: [...plan.send.map((finding) => findingRow(finding)), ...plan.discussions.map(discussionRow), ...comments.map(commentRow)] },
      { label: 'Suggestions', rows: plan.suggestions.map((finding) => findingRow(finding)) },
      ...onPlatformGroup
    ]
    : [
      { label: 'To send', rows: [...plan.discussions.map(discussionRow), ...comments.map(commentRow)] },
      ...onPlatformGroup,
      { label: 'From the earlier review', rows: findings.map((finding) => findingRow(finding, finding.state === 'OPEN' ? undefined : settledLabel(finding))) }
    ];
  const settled = [
    ...(findingsSendable ? [...plan.settled.map((finding) => findingRow(finding, settledLabel(finding))), ...resolved.map(resolvedRow)] : []),
    ...discussions.filter((discussion) => discussion.resolved).map(discussionRow)
  ];
  const shown = groups.filter((group) => group.rows.length > 0 || group.end);
  if (!shown.length && !settled.length) return <p className="tm-review__index-empty">No feedback</p>;
  return (
    <>
      {shown.map((group) => (
        <section key={group.label} className="tm-review__index-group" aria-label={group.label}>
          <h3 className="tm-review__index-label">{group.label}<span className="tm-review__index-count">{group.rows.length}</span></h3>
          {group.rows}
          {group.end}
        </section>
      ))}
      {settled.length ? (
        <section className="tm-review__index-group" aria-label="Settled">
          <button type="button" className="tm-review__index-label tm-review__index-fold" aria-expanded={settledOpen} onClick={() => setSettledOpen(!settledOpen)}>
            <ChevronRight size={13} aria-hidden="true" />
            Settled<span className="tm-review__index-count">{settled.length}</span>
          </button>
          {settledOpen ? settled : null}
        </section>
      ) : null}
    </>
  );
}

/**
 * A row of the Feedback list, as every list rail's row: what was said, then
 * who said it (or the finding's severity), its state and where it is.
 */
function FeedbackRow({ text, lead, state, stateTone, place, current, onSelect }: {
  text: string;
  lead: { label: string; tone?: 'blocked' };
  state?: string;
  stateTone?: 'waiting';
  place?: { short: string; full: string };
  current?: boolean;
  onSelect?(): void;
}) {
  const content = (
    <>
      <span className="tm-listrail__item-title">{text}</span>
      <span className="tm-listrail__item-meta">
        <span className="tm-review__feedback-lead" data-tone={lead.tone}>{lead.label}</span>
        {state ? <span className="tm-review__feedback-state" data-tone={stateTone}>{state}</span> : null}
        {place ? <span className="tm-review__feedback-place" title={place.full}>{place.short}</span> : null}
      </span>
    </>
  );
  return onSelect ? (
    <button type="button" className={`tm-listrail__item tm-review__feedback${current ? ' tm-listrail__item--active' : ''}`} aria-current={current ? 'true' : undefined} onClick={onSelect}>
      {content}
    </button>
  ) : <div className="tm-listrail__item tm-review__feedback">{content}</div>;
}

/** Where an item is, short for the rail ("cli.js:69"), and whole for its title. */
function placeOf(item: { path?: string; line?: number; endLine?: number }): { short: string; full: string } | undefined {
  if (!item.path) return undefined;
  const lines = item.line ? `:${item.line}${item.endLine && item.endLine > item.line ? `–${item.endLine}` : ''}` : '';
  return { short: `${item.path.split('/').at(-1) ?? item.path}${lines}`, full: `${item.path}${lines}` };
}

/** Open and unsent first, then sent, then remarks that ask for nothing. */
function discussionRank(discussion: DiscussionView): number {
  return discussion.open ? (discussion.sent ? 1 : 0) : 2;
}
