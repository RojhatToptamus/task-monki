import { useCallback, type ReactElement } from 'react';
import { Check } from 'lucide-react';
import { remoteProviderName, type AgentReviewResolvedFinding, type ReviewComment } from '../../shared/contracts';
import { formatFindingLocation } from '../model/findings';
import { formatCommentLocation } from '../model/formatting';
import { discussionAuthor, discussionSummary, formatDiscussionLocation, type DiscussionView } from '../model/pullRequestFeedback';
import type { ReviewRequestPlan } from '../model/reviewFollowUp';
import { discussionStateWord } from '../model/reviewRounds';
import type { ReviewFindingView } from '../model/reviewWorkspace';
import { ReviewFileList, ReviewFileRow, useFileNotes } from './ReviewFileRow';
import { settledLabel, severityLabel } from './ReviewFindingThread';
import type { ReviewModel } from './useReviewModel';

export type ReviewRail = 'files' | 'feedback';

/**
 * The Diff's navigator: its switch on top, then the files in reading order,
 * with the current one under the `--sel` plane, or every finding, comment and
 * discussion by what happens to it. The workspace keeps the choice, so a trip
 * to the Guide and back finds it as it was.
 */
export function ReviewNavigator({ model, rail, onRailChange }: { model: ReviewModel; rail: ReviewRail; onRailChange(rail: ReviewRail): void }) {
  const { actions, props } = model;
  const comments = props.draft.comments;
  const notes = useFileNotes(model);
  const openFile = useCallback((fileId: string) => actions.showFile(fileId, { open: true }), [actions]);
  const viewedCount = model.ordered.filter(({ file }) => model.viewedIds.has(file.id)).length;
  const fileCount = model.ordered.length;
  const feedbackCount = (props.findingsSendable ? props.plan.send.length + props.plan.suggestions.length : model.openFindings.length) +
    comments.length + model.discussions.filter((discussion) => !discussion.resolved).length;
  return (
    <div className="tm-review__rail">
      <div className="segmented segmented--fill tm-review__rail-switch" role="group" aria-label="Show">
        <button type="button" className="segmented__btn" aria-pressed={rail === 'files'} onClick={() => onRailChange('files')}>
          Files<span className="tm-review__rail-count" aria-label={viewedCount ? `${viewedCount} of ${fileCount} viewed` : undefined}>{viewedCount ? `${viewedCount}/${fileCount}` : `${fileCount}`}</span>
        </button>
        <button type="button" className="segmented__btn" aria-pressed={rail === 'feedback'} onClick={() => onRailChange('feedback')}>
          Feedback<span className="tm-review__rail-count">{feedbackCount}</span>
        </button>
      </div>
      <nav className="tm-review__index" aria-label={rail === 'files' ? 'Files' : 'Feedback'}>
        {rail === 'files' ? (
          <ReviewFileList current={model.activeFileId}>
            {model.ordered.map(({ file }) => (
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
        ) : (
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
        )}
      </nav>
    </div>
  );
}

/**
 * Every finding, comment and pull request discussion, grouped by what happens
 * to it: sent with the request, offered as a suggestion, still on the platform,
 * or settled. A finding of an out-of-date review is only context, so those are
 * listed apart.
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
  const findingRow = (finding: ReviewFindingView, state?: string) => (
    <button
      key={finding.id}
      type="button"
      className={`tm-review__index-finding${focusedFindingId === finding.id ? ' tm-review__index-finding--active' : ''}`}
      data-state={finding.state}
      onClick={() => onShowFinding(finding.id)}
    >
      <span className="tm-review__severity" data-severity={finding.severity}>{severityLabel(finding)}</span>
      <span className="tm-review__index-title">{finding.title}</span>
      <span className="tm-review__index-loc">{state ?? formatFindingLocation(finding)}</span>
    </button>
  );
  const commentRow = (comment: ReviewComment) => (
    <button key={comment.id} type="button" className="tm-review__index-finding" onClick={() => onShowComment(comment.id)}>
      <span className="tm-review__severity">You</span>
      <span className="tm-review__index-title">{comment.text}</span>
      <span className="tm-review__index-loc">{formatCommentLocation(comment)}</span>
    </button>
  );
  // Other people's words lead with who wrote them; the state and place follow.
  const discussionRow = (discussion: DiscussionView) => {
    const state = discussion.resolved ? undefined : discussionStateWord(discussion);
    const location = formatDiscussionLocation(discussion);
    return (
      <button
        key={discussion.id}
        type="button"
        className={`tm-review__index-finding tm-review__index-discussion${focusedDiscussionId === discussion.id ? ' tm-review__index-finding--active' : ''}`}
        data-state={discussion.resolved ? 'RESOLVED' : undefined}
        onClick={() => onShowDiscussion(discussion.id)}
      >
        <span className="tm-review__index-who">{discussionAuthor(discussion) ?? 'Unknown'}</span>
        <span className="tm-review__index-title">{discussionSummary(discussion)}</span>
        {state || location ? (
          <span className="tm-review__index-meta">
            {state ? <span>{state}</span> : null}
            {location ? <span className="tm-review__index-place">{location}</span> : null}
          </span>
        ) : null}
      </button>
    );
  };
  // A resolved finding is no longer in the code, so it has nowhere to go to.
  const resolvedRow = (finding: AgentReviewResolvedFinding) => (
    <div key={finding.previousFindingId} className="tm-review__index-finding tm-review__index-finding--resolved">
      <Check size={13} aria-hidden="true" />
      <span className="tm-review__index-title">{finding.title}</span>
      {finding.note ? <span className="tm-review__index-note">{finding.note}</span> : null}
    </div>
  );
  const platform = discussions[0] ? remoteProviderName(discussions[0].provider) : undefined;
  const added = new Set(plan.discussions.map((discussion) => discussion.id));
  // On the platform: what still asks for something and was not sent, then what was sent, then remarks.
  const onPlatform = discussions
    .filter((discussion) => !discussion.resolved && !added.has(discussion.id))
    .sort((left, right) => discussionRank(left) - discussionRank(right));
  // A bounded read says so where the discussions are listed, with the way to the rest.
  const more = platform && moreDiscussionsUrl ? [
    <a key="more" className="tm-review__index-more" href={moreDiscussionsUrl} target="_blank" rel="noreferrer">More on {platform}</a>
  ] : [];
  const onPlatformGroup = platform ? [{ label: `On ${platform}`, rows: [...onPlatform.map(discussionRow), ...more] }] : [];
  const resolvedOnPlatformGroup = platform
    ? [{ label: `Resolved on ${platform}`, rows: discussions.filter((discussion) => discussion.resolved).map(discussionRow) }]
    : [];
  const groups: Array<{ label: string; rows: ReactElement[] }> = findingsSendable
    ? [
      { label: 'To send', rows: [...plan.send.map((finding) => findingRow(finding)), ...plan.discussions.map(discussionRow), ...comments.map(commentRow)] },
      { label: 'Suggestions', rows: plan.suggestions.map((finding) => findingRow(finding)) },
      ...onPlatformGroup,
      { label: 'Settled', rows: plan.settled.map((finding) => findingRow(finding, settledLabel(finding))) },
      { label: 'Resolved', rows: resolved.map(resolvedRow) },
      ...resolvedOnPlatformGroup
    ]
    : [
      { label: 'To send', rows: [...plan.discussions.map(discussionRow), ...comments.map(commentRow)] },
      ...onPlatformGroup,
      { label: 'From the earlier review', rows: findings.map((finding) => findingRow(finding)) },
      ...resolvedOnPlatformGroup
    ];
  const shown = groups.filter((group) => group.rows.length > 0);
  if (!shown.length) return <p className="tm-review__index-empty">No findings or comments yet.</p>;
  return (
    <>
      {shown.map((group) => (
        <div key={group.label} className="tm-review__index-group">
          <h3 className="tm-review__index-label">{group.label}</h3>
          {group.rows}
        </div>
      ))}
    </>
  );
}

/** Open and unsent first, then sent, then remarks that ask for nothing. */
function discussionRank(discussion: DiscussionView): number {
  return discussion.open ? (discussion.sent ? 1 : 0) : 2;
}
