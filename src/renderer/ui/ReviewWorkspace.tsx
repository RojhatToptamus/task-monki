import { useRef, useState, type CSSProperties } from 'react';
import { ChevronDown, RefreshCw, SlidersHorizontal } from 'lucide-react';
import type { AgentReviewGateStatus } from '../../shared/contracts';
import { ActionMenu, type ActionMenuItem } from './ActionMenu';
import { MessageTime } from './Message';
import { OpenTargetContextMenu } from './OpenTargetMenu';
import { ReviewDiff } from './ReviewDiff';
import { ReviewNavigator } from './ReviewNavigator';
import { ReviewOutcome } from './ReviewRequest';
import { Tooltip } from './Tooltip';
import { useReviewKeys } from './useReviewKeys';
import { ReviewActionsProvider, ReviewBandsProvider, SCOPE_LABELS, useReviewModel, type ReviewWorkspaceProps } from './useReviewModel';

export type { ReviewWorkspaceProps } from './useReviewModel';

/**
 * The agent review's state in the Review bar. Where people already reviewed
 * the pull request, no agent review is not "not reviewed".
 */
function reviewHeadline(status: AgentReviewGateStatus | undefined, openCount: number, working?: boolean, peopleReviewed?: boolean): { label: string; tone?: 'blocked' | 'waiting' | 'verified' } {
  if (working && status !== 'RUNNING') return { label: 'Fixing review feedback' };
  switch (status) {
    case 'RUNNING': return { label: 'Reviewing' };
    // The diff changed after the review.
    case 'STALE': return { label: 'Review out of date', tone: 'waiting' };
    case 'PASSED': return { label: 'Review passed', tone: 'verified' };
    case 'NEEDS_CHANGES': return openCount > 0 ? { label: 'Needs changes', tone: 'blocked' } : { label: 'No open findings', tone: 'verified' };
    case 'INCONCLUSIVE': return { label: 'Review inconclusive', tone: 'waiting' };
    case 'FAILED': return { label: 'Review failed', tone: 'waiting' };
    case 'CANCELED': return { label: 'Review stopped', tone: 'waiting' };
    default: return { label: peopleReviewed ? 'No agent review' : 'Not reviewed' };
  }
}

/**
 * The Review tab: what changed, read in the order that matters, with the
 * reviewer's findings and the person's own comments on the code they are about.
 * The bar states the review and what is compared; the mode under it reads the
 * change in the one scroller every mode shares (the Diff: its navigator beside
 * the code); the foot holds the request and the tab's one decision.
 */
export function ReviewWorkspace(props: ReviewWorkspaceProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const model = useReviewModel(props, scrollerRef);
  const onKeyDown = useReviewKeys(model, { files: model.fileIds });
  const [rail, setRail] = useState<'files' | 'feedback'>('files');
  const { review, plan, draft } = props;
  const { actions, effectiveScope, sinceReviewLabel } = model;

  const scopeItems: ActionMenuItem[] = [
    ...(['all', 'committed', 'uncommitted'] as const).map((value) => ({
      id: value, label: SCOPE_LABELS[value], pressed: effectiveScope === value, onSelect: () => actions.setScope(value)
    })),
    ...(model.sinceReviewAvailable ? [{ id: 'since-review', label: sinceReviewLabel, pressed: effectiveScope === 'since-review', onSelect: () => actions.setScope('since-review') }] : []),
    ...(props.comparison ? [{
      id: 'comparison', label: 'Change comparison…', meta: props.comparison.label, separated: true,
      disabled: Boolean(props.comparison.disabledReason), disabledReason: props.comparison.disabledReason, onSelect: props.comparison.onChange
    }] : [])
  ];
  const viewItems: ActionMenuItem[] = [
    { id: 'importance', label: 'By importance', description: 'Findings first, then code with its tests', pressed: model.order === 'importance', onSelect: () => actions.setOrder('importance') },
    { id: 'path', label: 'By path', pressed: model.order === 'path', onSelect: () => actions.setOrder('path') },
    { id: 'expand', label: 'Expand all files', separated: true, onSelect: () => actions.setAllCollapsed(false) },
    { id: 'collapse', label: 'Collapse all files', onSelect: () => actions.setAllCollapsed(true) }
  ];

  const headline = reviewHeadline(review?.status, model.openFindings.length, review?.working, model.discussions.length > 0);
  // A review that finished and still matches the code needs no call to run again.
  const rerunSettled = Boolean(review && !review.working && (review.status === 'PASSED' || review.status === 'NEEDS_CHANGES' || review.status === 'INCONCLUSIVE'));
  const viewedCount = model.viewedIds.size;
  const fileCount = model.files.length;
  const feedbackCount = (props.findingsSendable ? plan.send.length + plan.suggestions.length : model.openFindings.length) + draft.comments.length +
    model.discussions.filter((discussion) => !discussion.resolved).length;
  const requestChanges = props.requestChanges && { ...props.requestChanges, onSubmit: actions.submitRequest };

  return (
    <ReviewActionsProvider value={actions}>
      <ReviewBandsProvider value={model.bands}>
        <section className="tm-review" aria-label="Review" data-file-full-screen={model.focusedFile ? '' : undefined} onKeyDown={onKeyDown}>
          <div className="tm-review__bar">
            <div className="segmented segmented--fill tm-review__rail-switch" role="group" aria-label="Show">
              <button type="button" className="segmented__btn" aria-pressed={rail === 'files'} onClick={() => setRail('files')}>
                Files<span className="tm-review__rail-count" aria-label={viewedCount ? `${viewedCount} of ${fileCount} viewed` : undefined}>{viewedCount ? `${viewedCount}/${fileCount}` : `${fileCount}`}</span>
              </button>
              <button type="button" className="segmented__btn" aria-pressed={rail === 'feedback'} onClick={() => setRail('feedback')}>
                Feedback<span className="tm-review__rail-count">{feedbackCount}</span>
              </button>
            </div>
            {props.historical ? (
              <>
                <span className="tm-review__headline">{props.historical.capturedAt ? 'Earlier capture' : 'Earlier capture unavailable'}</span>
                {props.historical.capturedAt ? (
                  <span className="tm-review__meta">
                    {props.historical.headSha ? <code>{props.historical.headSha.slice(0, 8)}</code> : null}
                    <MessageTime value={props.historical.capturedAt} />
                  </span>
                ) : null}
                <button type="button" className="ghost-button tm-review__bar-end" onClick={props.historical.onBack}>Back to current changes</button>
              </>
            ) : (
              <>
                {props.agentRequest ? (
                  <>
                    <span className="tm-review__headline" data-tone="waiting">{props.agentRequest.label}</span>
                    <button type="button" className="ghost-button button--sm" onClick={props.agentRequest.onOpen}>{props.agentRequest.action}</button>
                  </>
                ) : (
                  <>
                    <span className={`tm-review__headline${review?.status === 'RUNNING' || review?.working ? ' tm-shimmer' : ''}`} data-tone={headline.tone}>
                      {headline.label}
                    </span>
                    {review?.reviewedAt && review.status !== 'RUNNING' && review.status !== 'NOT_RUN' && !review.working ? (
                      <span className="tm-review__meta"><MessageTime value={review.reviewedAt} /></span>
                    ) : null}
                    {/* A finished, current review can run again from beside its time. */}
                    {rerunSettled && props.runReview && !props.runReview.disabledReason ? (
                      <Tooltip label={props.runReview.label}>
                        <button type="button" className="tm-iconbtn" aria-label={props.runReview.label} disabled={props.runReview.busy} onClick={props.runReview.onRun}>
                          <RefreshCw size={16} aria-hidden="true" />
                        </button>
                      </Tooltip>
                    ) : null}
                  </>
                )}
                <ActionMenu
                  className="tm-review__scope tm-review__bar-end"
                  label="Changes to show"
                  selection="single"
                  side="bottom"
                  trigger={<>{effectiveScope === 'since-review' ? sinceReviewLabel : SCOPE_LABELS[effectiveScope]}<ChevronDown size={13} aria-hidden="true" /></>}
                  items={scopeItems}
                />
                <ActionMenu
                  className="tm-review__view"
                  label="View options"
                  tooltip="View"
                  side="bottom"
                  trigger={<SlidersHorizontal size={16} aria-hidden="true" />}
                  items={viewItems}
                />
                {props.runReview && !rerunSettled ? (
                  <span className="tm-actiontitle" title={props.runReview.disabledReason}>
                    <button
                      type="button"
                      className={model.stale ? 'primary-button button--sm' : 'outline-button button--sm'}
                      disabled={Boolean(props.runReview.disabledReason) || props.runReview.busy}
                      onClick={props.runReview.onRun}
                    >
                      {props.runReview.label}
                    </button>
                  </span>
                ) : null}
              </>
            )}
          </div>

          {model.incomplete ? (
            <p className="tm-review__notice" role="status">The captured diff is incomplete. Listed files are real; missing ones are not established.</p>
          ) : null}

          <div className="tm-review__work">
            <ReviewNavigator model={model} rail={rail} />
            {/* One scroller for the code, whichever mode reads it; heads stick at its --review-sticky-top. */}
            <div ref={scrollerRef} className="tm-review__scroller" tabIndex={-1} style={{ '--review-num': `${model.gutterWidth}px` } as CSSProperties}>
              <ReviewDiff model={model} />
            </div>
          </div>

          {props.historical ? null : (
            <ReviewOutcome
              plan={plan}
              comments={draft.comments}
              note={draft.note}
              onNoteChange={actions.setNote}
              request={requestChanges}
              finish={props.finish}
              sheetOpen={model.sheetOpen}
              onSheetOpenChange={actions.setSheetOpen}
              onIncludeFinding={actions.setIncluded}
              onIncludeDiscussion={actions.setDiscussionIncluded}
              onShowDiscussion={(discussionId) => { actions.setSheetOpen(false); actions.showDiscussion(discussionId); }}
              onDismissFinding={actions.openDismiss}
              onDeleteComment={actions.deleteComment}
              onShowFinding={(findingId) => { actions.setSheetOpen(false); actions.showFinding(findingId); }}
              onShowComment={(commentId) => { actions.setSheetOpen(false); actions.showComment(commentId); }}
            />
          )}

          {model.pathMenu ? (
            <OpenTargetContextMenu target={model.pathMenu.target} position={model.pathMenu.position} onClose={actions.closePathMenu} onError={actions.notifyError} />
          ) : null}
        </section>
      </ReviewBandsProvider>
    </ReviewActionsProvider>
  );
}
