import { useCallback, useEffect, useId, useRef, type RefObject } from 'react';
import { ChevronUp, X } from 'lucide-react';
import type { ReviewComment } from '../../shared/contracts';
import { formatFindingLocation } from '../model/findings';
import { isBlockingFinding, remoteProviderName } from '../../shared/contracts';
import { formatCommentLocation } from '../model/formatting';
import { discussionAuthor, discussionSummary, formatDiscussionLocation } from '../model/pullRequestFeedback';
import type { ReviewRequestPlan } from '../model/reviewFollowUp';
import { DisclosureChevron } from './DisclosureChevron';
import { Presence, useLayerProps, useLeaving } from './presence';
import { settledLabel, severityLabel } from './ReviewFindingThread';
import { SUBMIT_SHORTCUT, Tooltip } from './Tooltip';

export interface ReviewRequestAction {
  disabledReason?: string;
  busy: boolean;
  onSubmit(): void;
  /** The exact text the implementation agent will receive. */
  instruction(): string;
}

export interface ReviewFinishAction {
  label: string;
  disabledReason?: string;
  onRun(): void;
}

export interface ReviewOutcomeProps {
  plan: ReviewRequestPlan;
  comments: readonly ReviewComment[];
  note: string;
  onNoteChange(note: string): void;
  request?: ReviewRequestAction;
  /** With nothing to send, the step that finishes the task: the Overview's next action. */
  finish?: ReviewFinishAction;
  sheetOpen: boolean;
  onSheetOpenChange(open: boolean): void;
  onIncludeFinding(findingId: string, included: boolean): void;
  onIncludeDiscussion(discussionId: string, included: boolean): void;
  /** A blocking finding leaves the request only by being dismissed. */
  onDismissFinding(findingId: string): void;
  onDeleteComment(commentId: string): void;
  onShowFinding(findingId: string): void;
  onShowComment(commentId: string): void;
  onShowDiscussion(discussionId: string): void;
}

function count(value: number, one: string, many: string): string {
  return `${value} ${value === 1 ? one : many}`;
}

/**
 * The foot of the Review tab: what the request holds, a note for the agent, and
 * the tab's one decision. It is always here while a decision is possible, so it
 * never appears under the reader; it changes its words. With something queued
 * the decision is Request changes; with nothing, it is the step that finishes
 * the task. The summary opens the request sheet.
 */
export function ReviewOutcome(props: ReviewOutcomeProps) {
  const { plan, comments, request, finish } = props;
  const sheetId = useId();
  const reasonId = useId();
  const summaryRef = useRef<HTMLButtonElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  // A sheet that closes on its own, once sent or emptied, takes the focus it held with it; the note gets it back.
  const sheetWasOpen = useRef(props.sheetOpen);
  useEffect(() => {
    if (sheetWasOpen.current && !props.sheetOpen && (!document.activeElement || document.activeElement === document.body)) {
      noteRef.current?.focus();
    }
    sheetWasOpen.current = props.sheetOpen;
  }, [props.sheetOpen]);
  const findings = plan.send;
  const queued = plan.queued;
  const discussions = plan.discussions;
  const platform = discussions[0] ? remoteProviderName(discussions[0].provider) : '';
  const verb = requestVerb(plan, comments);
  const summary = findings.length || discussions.length || comments.length
    ? [
      findings.length ? count(findings.length, 'fix', 'fixes') : '',
      discussions.length ? count(discussions.length, `${platform} comment`, `${platform} comments`) : '',
      comments.length ? count(comments.length, 'comment', 'comments') : ''
    ].filter(Boolean).join(', ')
    : plan.reviewNotes ? 'Review notes' : 'Note';
  const primary = queued && request ? (
    <>
      {request.disabledReason ? <span id={reasonId} className="tm-review__request-reason">{request.disabledReason}</span> : null}
      <Tooltip label={verb} shortcut={SUBMIT_SHORTCUT} side="top">
        <button
          type="button"
          className="primary-button"
          disabled={Boolean(request.disabledReason) || request.busy}
          aria-describedby={request.disabledReason ? reasonId : undefined}
          onClick={request.onSubmit}
        >
          {verb}
        </button>
      </Tooltip>
    </>
  ) : !queued && finish ? (
    <>
      {finish.disabledReason ? <span id={reasonId} className="tm-review__request-reason">{finish.disabledReason}</span> : null}
      <button
        type="button"
        className="primary-button"
        disabled={Boolean(finish.disabledReason)}
        aria-describedby={finish.disabledReason ? reasonId : undefined}
        onClick={finish.onRun}
      >
        {finish.label}
      </button>
    </>
  ) : null;

  return (
    <div className="tm-review__foot">
      <div className="tm-review__request">
        <label className="tm-review__note">
          <span className="tm-visually-hidden">A note for the agent</span>
          <textarea
            ref={noteRef}
            rows={1}
            value={props.note}
            placeholder="Add a note"
            onChange={(event) => props.onNoteChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && queued && request && !request.disabledReason && !request.busy) {
                event.preventDefault();
                request.onSubmit();
              }
            }}
          />
        </label>
        {/* The summary sits by the decision, so the note's edge never moves. */}
        {queued ? (
          <button
            ref={summaryRef}
            type="button"
            className="tm-review__request-summary"
            aria-expanded={props.sheetOpen}
            aria-controls={props.sheetOpen ? sheetId : undefined}
            onClick={() => props.onSheetOpenChange(!props.sheetOpen)}
          >
            {summary}
            <ChevronUp size={13} aria-hidden="true" />
          </button>
        ) : null}
        {primary}
      </div>
      <Presence>{props.sheetOpen ? <ReviewRequestSheet {...props} id={sheetId} reasonId={reasonId} summaryRef={summaryRef} /> : null}</Presence>
    </div>
  );
}

/**
 * Exactly what Request changes sends, in send order: the findings to fix, the
 * person's comments, and what is left out on purpose, with the exact instruction
 * one disclosure away. It rises over the diff without blocking it.
 */
function ReviewRequestSheet(props: ReviewOutcomeProps & { id: string; reasonId: string; summaryRef: RefObject<HTMLButtonElement | null> }) {
  const { plan, comments, request, onSheetOpenChange, summaryRef } = props;
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const layer = useLayerProps();
  const leaving = useLeaving();
  const layerRef = layer.ref;
  const attachSheet = useCallback((element: HTMLDivElement | null) => {
    sheetRef.current = element;
    layerRef(element);
  }, [layerRef]);
  const findings = plan.send;
  const leftOut = [...plan.suggestions, ...plan.settled];
  const discussions = plan.discussions;
  const platform = [...discussions, ...plan.discussionsLeftOut][0];
  const platformName = platform ? remoteProviderName(platform.provider) : '';
  const instruction = request?.instruction() ?? '';
  const verb = requestVerb(plan, comments);

  // Escape and a click outside close the sheet; the summary toggles it itself.
  useEffect(() => {
    if (leaving) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (sheetRef.current?.contains(target) || summaryRef.current?.contains(target)) return;
      onSheetOpenChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onSheetOpenChange(false); summaryRef.current?.focus(); }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [leaving, onSheetOpenChange, summaryRef]);

  let position = 0;
  return (
    <div {...layer} ref={attachSheet} id={props.id} className="tm-review-sheet" role="dialog" aria-label={verb}>
      <div className="tm-review-sheet__head">
        <h2>{verb}</h2>
        <button type="button" className="tm-iconbtn" aria-label="Close" onClick={() => onSheetOpenChange(false)}><X size={13} aria-hidden="true" /></button>
      </div>
      <div className="tm-review-sheet__body">
        {findings.length ? (
          <section className="tm-review-sheet__group" aria-label="To fix">
            <h3>To fix</h3>
            {findings.map((finding) => (
              <div key={finding.id} className="tm-review-sheet__item">
                <span className="tm-review-sheet__n">{(position += 1)}</span>
                <span className="tm-review__severity" data-severity={finding.severity}>{severityLabel(finding)}</span>
                <button type="button" className="tm-review-sheet__title" onClick={() => props.onShowFinding(finding.id)}>{finding.title}</button>
                <code className="tm-review-sheet__loc">{formatFindingLocation(finding)}</code>
                <Tooltip label={isBlockingFinding(finding) ? 'Dismiss to leave it out' : 'Take out'}>
                  <button
                    type="button"
                    className="tm-iconbtn"
                    aria-label={isBlockingFinding(finding) ? `Dismiss ${finding.title}` : `Take ${finding.title} out of the request`}
                    onClick={() => (isBlockingFinding(finding) ? props.onDismissFinding(finding.id) : props.onIncludeFinding(finding.id, false))}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </Tooltip>
              </div>
            ))}
          </section>
        ) : null}
        {discussions.length ? (
          <section className="tm-review-sheet__group" aria-label={`From ${platformName}`}>
            <h3>From {platformName}</h3>
            {discussions.map((discussion) => {
              const location = formatDiscussionLocation(discussion);
              return (
                <div key={discussion.id} className="tm-review-sheet__item tm-review-sheet__item--discussion">
                  <span className="tm-review-sheet__n">{(position += 1)}</span>
                  <span className="tm-review-sheet__who">{discussionAuthor(discussion) ?? 'Unknown'}</span>
                  <button type="button" className="tm-review-sheet__title" onClick={() => props.onShowDiscussion(discussion.id)}>{discussionSummary(discussion)}</button>
                  {location ? <code className="tm-review-sheet__loc">{location}</code> : <span />}
                  <Tooltip label="Take out">
                    <button
                      type="button"
                      className="tm-iconbtn"
                      aria-label={`Take the comment by ${discussionAuthor(discussion) ?? 'unknown'} out of the request`}
                      onClick={() => props.onIncludeDiscussion(discussion.id, false)}
                    >
                      <X size={13} aria-hidden="true" />
                    </button>
                  </Tooltip>
                </div>
              );
            })}
          </section>
        ) : null}
        {comments.length ? (
          <section className="tm-review-sheet__group" aria-label="Your comments">
            <h3>Your comments</h3>
            {comments.map((comment) => (
              <div key={comment.id} className="tm-review-sheet__item tm-review-sheet__item--comment">
                <span className="tm-review-sheet__n">{(position += 1)}</span>
                <button type="button" className="tm-review-sheet__title" onClick={() => props.onShowComment(comment.id)}>{comment.text}</button>
                <code className="tm-review-sheet__loc">{formatCommentLocation(comment)}</code>
                <Tooltip label="Delete comment">
                  <button type="button" className="tm-iconbtn" aria-label="Delete comment" onClick={() => props.onDeleteComment(comment.id)}>
                    <X size={13} aria-hidden="true" />
                  </button>
                </Tooltip>
              </div>
            ))}
          </section>
        ) : null}
        {leftOut.length || plan.discussionsLeftOut.length ? (
          <section className="tm-review-sheet__group" aria-label="Left out">
            <h3>Left out</h3>
            {plan.discussionsLeftOut.map((discussion) => (
              <div key={discussion.id} className="tm-review-sheet__item tm-review-sheet__item--out tm-review-sheet__item--discussion-out">
                <span className="tm-review-sheet__who">{discussionAuthor(discussion) ?? 'Unknown'}</span>
                <button type="button" className="tm-review-sheet__title" onClick={() => props.onShowDiscussion(discussion.id)}>{discussionSummary(discussion)}</button>
                {formatDiscussionLocation(discussion) ? <code className="tm-review-sheet__loc">{formatDiscussionLocation(discussion)}</code> : <span />}
                <button type="button" className="ghost-button" onClick={() => props.onIncludeDiscussion(discussion.id, true)}>Add</button>
              </div>
            ))}
            {leftOut.map((finding) => (
              <div key={finding.id} className="tm-review-sheet__item tm-review-sheet__item--out">
                <span className="tm-review__severity" data-severity={finding.severity}>{severityLabel(finding)}</span>
                <button type="button" className="tm-review-sheet__title" onClick={() => props.onShowFinding(finding.id)}>{finding.title}</button>
                <span className="tm-review-sheet__state">{finding.state === 'OPEN' ? 'Suggestion' : settledLabel(finding)}</span>
                {finding.state === 'OPEN' ? (
                  <button type="button" className="ghost-button" onClick={() => props.onIncludeFinding(finding.id, true)}>Add</button>
                ) : <span />}
              </div>
            ))}
          </section>
        ) : null}
        {instruction ? (
          <details className="tm-review-sheet__instruction">
            <summary><DisclosureChevron />Instruction</summary>
            <pre>{instruction}</pre>
          </details>
        ) : null}
      </div>
      {/* A disabled send states its reason once, in the foot below. */}
      <div className="tm-review-sheet__foot">
        <span className="tm-review-sheet__spacer" />
        <button type="button" className="ghost-button" onClick={() => onSheetOpenChange(false)}>Cancel</button>
        {request ? (
          <button
            type="button"
            className="primary-button button--sm"
            disabled={Boolean(request.disabledReason) || request.busy || !plan.queued}
            aria-describedby={request.disabledReason && plan.queued ? props.reasonId : undefined}
            onClick={request.onSubmit}
          >
            {verb}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The request's verb. Only the pull request's comments queued is the Overview's
 * Address comments; on the platform, Request changes is a reviewer's verdict,
 * not the follow-up the agent is sent.
 */
function requestVerb(plan: ReviewOutcomeProps['plan'], comments: ReviewOutcomeProps['comments']): string {
  return plan.discussions.length > 0 && plan.send.length === 0 && comments.length === 0 ? 'Address comments' : 'Request changes';
}
