import { useRef, useState, type CSSProperties } from 'react';
import { ChevronDown, RefreshCw, SlidersHorizontal } from 'lucide-react';
import type { AgentReviewGateStatus } from '../../shared/contracts';
import type { ReviewMode } from '../model/reviewNavigation';
import { ActionMenu, type ActionMenuItem } from './ActionMenu';
import { MessageTime } from './Message';
import { OpenTargetContextMenu } from './OpenTargetMenu';
import { ReviewDiff } from './ReviewDiff';
import { ReviewGuide } from './ReviewGuide';
import { ReviewNavigator, type ReviewRail } from './ReviewNavigator';
import { ReviewOutcome } from './ReviewRequest';
import { Tooltip } from './Tooltip';
import { useReviewKeys } from './useReviewKeys';
import { ReviewActionsProvider, ReviewBandsProvider, SCOPE_LABELS, useReviewModel, type ReviewWorkspaceProps } from './useReviewModel';

export type { ReviewWorkspaceProps } from './useReviewModel';

const MODES: ReadonlyArray<{ mode: ReviewMode; label: string }> = [{ mode: 'guide', label: 'Guide' }, { mode: 'diff', label: 'Diff' }];

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
 * The bar holds the mode, the review's state and, in the Diff, what is compared;
 * the mode reads the change in the one scroller both share (the Guide stage by
 * stage, the Diff beside its navigator); the foot holds the request and the
 * tab's one decision.
 */
export function ReviewWorkspace(props: ReviewWorkspaceProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const model = useReviewModel(props, scrollerRef);
  const onKeyDown = useReviewKeys(model);
  const [rail, setRail] = useState<ReviewRail>('files');
  const { review, plan, draft } = props;
  const { actions, effectiveScope, sinceReviewLabel, mode, guide } = model;
  const diffMode = mode === 'diff';

  const scopeItems: ActionMenuItem[] = [
    ...(['all', 'committed', 'uncommitted'] as const).map((value) => ({
      id: value, label: SCOPE_LABELS[value], pressed: !model.diffFilter && effectiveScope === value, onSelect: () => actions.setScope(value)
    })),
    ...(model.sinceReviewAvailable ? [{
      id: 'since-review', label: sinceReviewLabel, pressed: !model.diffFilter && effectiveScope === 'since-review', onSelect: () => actions.setScope('since-review')
    }] : []),
    // A stage opened from the Guide narrows the Diff to its files; another choice shows them all again.
    ...(model.diffFilter ? [{ id: 'stage', label: model.diffFilter.title, pressed: true, separated: true }] : []),
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
  // A finished review that still matches the code needs no call to run again.
  const rerunSettled = Boolean(review && !review.working && (review.status === 'PASSED' || review.status === 'NEEDS_CHANGES' || review.status === 'INCONCLUSIVE'));
  // Without a walkthrough, the Guide states why, and the review that writes one, where the walkthrough would be.
  // An earlier one is the review's: the bar says the review is out of date, with the review that refreshes it.
  const guideHoldsRun = !diffMode && (guide.status === 'none' || guide.status === 'unavailable');
  const requestChanges = props.requestChanges && { ...props.requestChanges, onSubmit: actions.submitRequest };
  const run = props.runReview;

  return (
    <ReviewActionsProvider value={actions}>
      <ReviewBandsProvider value={model.bands}>
        <section className="tm-review" aria-label="Review" data-review-mode={mode} data-file-full-screen={model.focusedFile ? '' : undefined} onKeyDown={onKeyDown}>
          <div className="tm-review__bar">
            {props.historical ? null : (
              <div className="segmented tm-review__modes" role="group" aria-label="Read as">
                {MODES.map(({ mode: value, label }) => (
                  <Tooltip key={value} label={label} shortcut="G">
                    <button type="button" className="segmented__btn" aria-pressed={mode === value} aria-keyshortcuts="G" onClick={() => actions.setMode(value)}>
                      {label}
                    </button>
                  </Tooltip>
                ))}
              </div>
            )}
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
                    {rerunSettled && run && !run.disabledReason && !guideHoldsRun ? (
                      <Tooltip label={run.label}>
                        <button type="button" className="tm-iconbtn" aria-label={run.label} disabled={run.busy} onClick={run.onRun}>
                          <RefreshCw size={16} aria-hidden="true" />
                        </button>
                      </Tooltip>
                    ) : null}
                  </>
                )}
                <span className="tm-review__bar-end" />
                {diffMode ? (
                  <>
                    <ActionMenu
                      className="tm-review__scope"
                      label="Changes to show"
                      selection="single"
                      side="bottom"
                      trigger={<>
                        <span className="tm-review__scope-label">{model.diffFilter?.title ?? (effectiveScope === 'since-review' ? sinceReviewLabel : SCOPE_LABELS[effectiveScope])}</span>
                        <ChevronDown size={13} aria-hidden="true" />
                      </>}
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
                  </>
                ) : null}
                {run && !rerunSettled && !guideHoldsRun ? (
                  <span className="tm-actiontitle" title={run.disabledReason}>
                    <button
                      type="button"
                      className={model.stale ? 'primary-button button--sm' : 'outline-button button--sm'}
                      disabled={Boolean(run.disabledReason) || run.busy}
                      onClick={run.onRun}
                    >
                      {run.label}
                    </button>
                  </span>
                ) : null}
              </>
            )}
          </div>

          {diffMode && model.incomplete ? (
            <p className="tm-review__notice" role="status">The captured diff is incomplete. Listed files are real; missing ones are not established.</p>
          ) : null}
          <div className="tm-review__work">
            {diffMode ? <ReviewNavigator model={model} rail={rail} onRailChange={setRail} /> : null}
            {/* One scroller for the code, whichever mode reads it; heads stick at its --review-sticky-top. */}
            <div ref={scrollerRef} className="tm-review__scroller" tabIndex={-1} style={{ '--review-num': `${model.gutterWidth}px` } as CSSProperties}>
              {diffMode ? <ReviewDiff model={model} /> : <ReviewGuide model={model} />}
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
