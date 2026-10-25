import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react';
import type {
  PullRequestMergeMethod,
  PullRequestMergeOptions,
  PullRequestReply,
  ReplyToPullRequestResult
} from '../../shared/contracts';
import type { ReplyDraft } from '../model/pullRequestFeedback';
import { REVIEW_OUTCOME_LABELS } from '../model/reviewRounds';
import { useDialogFocusBoundary } from './dialogFocus';
import { ModalFrame } from './ModalFrame';
import { AnswerQuote } from './ReviewRound';
import { PendingLabel } from './StableLabel';
import { StatusGlyph } from './StatusBadge';

/** A method's segment and the verb its merge button says, in the platform's words. */
const METHOD_WORDS: Record<'GitHub' | 'GitLab', Record<PullRequestMergeMethod, { segment: string; action: string }>> = {
  GitHub: {
    MERGE: { segment: 'Merge commit', action: 'Merge' },
    SQUASH: { segment: 'Squash', action: 'Squash and merge' },
    REBASE: { segment: 'Rebase', action: 'Rebase and merge' }
  },
  GitLab: {
    MERGE: { segment: 'Merge', action: 'Merge' },
    SQUASH: { segment: 'Squash', action: 'Squash and merge' },
    REBASE: { segment: 'Rebase', action: 'Rebase and merge' }
  }
};

/**
 * Merging is the person's step, confirmed here with the method the
 * repository allows. The merge is of the head shown: the platform refuses it
 * when the pull request moved since.
 */
export function MergePullRequestModal({
  platform,
  noun,
  headSha,
  ownBranch,
  loadOptions,
  onSubmit,
  onCancel,
  fallbackReturnFocusRef
}: {
  platform: 'GitHub' | 'GitLab';
  /** "pull request" or "merge request". */
  noun: string;
  headSha: string;
  /** Task Monki's own task branch: deleting it with the merge is the default. Someone else's branch is theirs to keep. */
  ownBranch: boolean;
  loadOptions(): Promise<PullRequestMergeOptions>;
  onSubmit(method: PullRequestMergeMethod, deleteBranch: boolean): Promise<void>;
  onCancel(): void;
  fallbackReturnFocusRef: RefObject<HTMLElement | null>;
}) {
  const [options, setOptions] = useState<PullRequestMergeOptions>();
  const [method, setMethod] = useState<PullRequestMergeMethod>();
  const [deleteBranch, setDeleteBranch] = useState(ownBranch);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const panelRef = useRef<HTMLFormElement>(null);
  useDialogFocusBoundary({ dialogRef: panelRef, fallbackReturnFocusRef, busy, onClose: onCancel });
  // Read once when the dialog opens; the merge itself is checked again by the platform.
  const load = useRef(loadOptions);
  useEffect(() => {
    let canceled = false;
    load.current().then(
      (loaded) => {
        if (canceled) return;
        setOptions(loaded);
        setMethod(loaded.defaultMethod);
      },
      (caught: unknown) => { if (!canceled) setError(caught instanceof Error ? caught.message : `Could not read how this ${noun} can merge.`); }
    );
    return () => { canceled = true; };
  }, [noun]);
  const words = METHOD_WORDS[platform];
  const offersDelete = Boolean(options?.canDeleteBranch && !options.deletesBranchOnMerge);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!method || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSubmit(method, offersDelete && deleteBranch);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Could not merge the ${noun}.`);
      setBusy(false);
    }
  };
  const moveMethod = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!options || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = method ? options.methods.indexOf(method) : 0;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.methods.length - 1
      : (index + (event.key === 'ArrowLeft' ? -1 : 1) + options.methods.length) % options.methods.length;
    setMethod(options.methods[next]);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
  };

  return (
    <ModalFrame labelledBy="merge-pr-title" pending={busy} onDismiss={onCancel}>
      <form ref={panelRef} className="tm-modal__panel tm-merge-modal" tabIndex={-1} onSubmit={(event) => void submit(event)}>
        <h3 id="merge-pr-title">Merge {noun}</h3>
        <p className="tm-merge-modal__branches">
          {options?.head ? <code>{options.head}</code> : null}
          {options?.head && options.base ? <span aria-hidden="true">→</span> : null}
          {options?.base ? <code>{options.base}</code> : null}
          <code className="tm-merge-modal__sha" title={headSha}>{headSha.slice(0, 7)}</code>
        </p>
        {options && options.methods.length > 1 ? (
          <div className="segmented tm-merge-modal__methods" role="group" aria-label="Merge method" onKeyDown={moveMethod}>
            {options.methods.map((candidate) => (
              <button key={candidate} type="button" className="segmented__btn" aria-pressed={method === candidate}
                disabled={busy} tabIndex={method === candidate ? 0 : -1} onClick={() => setMethod(candidate)}>
                {words[candidate].segment}
              </button>
            ))}
          </div>
        ) : null}
        {offersDelete && options?.head ? (
          <label className="tm-modal__check">
            <input type="checkbox" checked={deleteBranch} disabled={busy} onChange={(event) => setDeleteBranch(event.target.checked)} />
            <span>Delete <code>{options.head}</code></span>
          </label>
        ) : null}
        {error ? <p className="tm-notice tm-modal__notice" role="alert">{error}</p> : null}
        <div className="tm-modal__actions">
          <button type="button" className="outline-button" disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary-button" disabled={busy || !method}>
            <PendingLabel label={method ? words[method].action : 'Merge'} pendingLabel="Merging…" pending={busy} />
          </button>
        </div>
      </form>
    </ModalFrame>
  );
}

interface ReplyState {
  include: boolean;
  body: string;
  resolve: boolean;
}

/**
 * The discussions the agent answered, each with a reply the person writes and
 * posts where the discussion lives. A reply starts from the fact Task Monki
 * observed, or from nothing; the agent's own words are quoted above it for the
 * person alone and never posted. Nothing is posted until the person posts it,
 * every reply is theirs to edit or leave out, and resolving a thread is their
 * call, unchecked until they check it: the agent's "Fixed" is its own report,
 * not a verdict.
 */
export function ReplyToReviewersModal({
  platform,
  agent,
  drafts,
  reviewers,
  onSubmit,
  onCancel,
  fallbackReturnFocusRef
}: {
  platform: 'GitHub' | 'GitLab';
  /** Who answered: its name heads each quoted answer. */
  agent: string;
  drafts: ReplyDraft[];
  /** Reviewers who asked for changes, who can be asked to review again from here. */
  reviewers: string[];
  onSubmit(replies: PullRequestReply[], reviewers: string[]): Promise<ReplyToPullRequestResult>;
  onCancel(): void;
  fallbackReturnFocusRef: RefObject<HTMLElement | null>;
}) {
  const [replies, setReplies] = useState<Record<string, ReplyState>>(() => Object.fromEntries(
    drafts.map((draft) => [draft.discussionId, { include: true, body: draft.body, resolve: false }])
  ));
  const [asked, setAsked] = useState<Set<string>>(() => new Set(reviewers));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [failed, setFailed] = useState<ReplyToPullRequestResult['failed']>([]);
  const [posted, setPosted] = useState<Set<string>>(() => new Set());
  // The drafts as the dialog opened: a reply that lands leaves the live drafts, and what became of it stays in view here.
  const [shown] = useState(drafts);
  const panelRef = useRef<HTMLFormElement>(null);
  useDialogFocusBoundary({ dialogRef: panelRef, fallbackReturnFocusRef, busy, onClose: onCancel });
  const remaining = shown.filter((draft) => !posted.has(draft.discussionId));
  const chosen = remaining.filter((draft) => replies[draft.discussionId]?.include);
  const empty = chosen.some((draft) => !replies[draft.discussionId]?.body.trim());
  const count = chosen.length;
  // Every reply landed and no one is left to ask: nothing is left to post, so only Close stays.
  const done = remaining.length === 0 && asked.size === 0;
  // Why posting waits, said once: a chosen reply with no words, or nothing chosen.
  const reason = done ? undefined : empty ? 'Write each reply first' : count === 0 && asked.size === 0 ? 'Choose a reply first' : undefined;
  const update = (id: string, change: Partial<ReplyState>) => setReplies((current) => ({ ...current, [id]: { ...current[id]!, ...change } }));
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || done || reason) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await onSubmit(
        chosen.map((draft) => ({ discussionId: draft.discussionId, body: replies[draft.discussionId]!.body.trim(), resolve: replies[draft.discussionId]!.resolve })),
        [...asked]
      );
      if (result.failed.length === 0) {
        onCancel();
        return;
      }
      // What landed leaves the list; what the platform refused stays with its reason. A reply
      // whose thread stayed open landed too, and stays only to say so.
      const refused = new Set(result.failed.filter((failure) => !failure.replied).map((failure) => failure.discussionId).filter(Boolean));
      setPosted((current) => new Set([...current, ...chosen.map((draft) => draft.discussionId).filter((id) => !refused.has(id))]));
      if (result.requested.length > 0) setAsked(new Set());
      setFailed(result.failed);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not post the replies.');
    } finally {
      setBusy(false);
    }
  };
  const label = count === 0 ? (asked.size > 0 ? 'Ask for review' : 'Post replies')
    : `Post ${count} ${count === 1 ? 'reply' : 'replies'}`;

  return (
    <ModalFrame className="tm-modal--top" labelledBy="reply-pr-title" pending={busy} onDismiss={onCancel}>
      <form ref={panelRef} className="tm-modal__panel tm-reply-modal" tabIndex={-1} onSubmit={(event) => void submit(event)}>
        <h3 id="reply-pr-title">Reply on {platform}</h3>
        <div className="tm-reply-modal__list">
          {shown.map((draft) => {
            const state = replies[draft.discussionId]!;
            const failure = failed.find((candidate) => candidate.discussionId === draft.discussionId);
            const bodyId = `reply-${draft.discussionId}`;
            if (posted.has(draft.discussionId)) {
              return failure?.replied ? (
                <section key={draft.discussionId} className="tm-reply" data-included="false">
                  <div className="tm-reply__head">
                    <StatusGlyph kind="verified" className="tm-reply__mark" />
                    <span className="tm-reply__author">{draft.author ? `@${draft.author}` : 'Comment'}</span>
                    {draft.location ? <span className="tm-reply__where">{draft.location}</span> : null}
                    <span className="tm-reply__outcome">Replied</span>
                  </div>
                  <p className="form-error" role="alert">{failure.error}</p>
                </section>
              ) : null;
            }
            return (
              <section key={draft.discussionId} className="tm-reply" data-included={state.include}>
                <label className="tm-reply__head">
                  <input type="checkbox" checked={state.include} disabled={busy}
                    onChange={(event) => update(draft.discussionId, { include: event.target.checked })} />
                  <span className="tm-reply__author">{draft.author ? `@${draft.author}` : 'Comment'}</span>
                  {draft.location ? <span className="tm-reply__where">{draft.location}</span> : null}
                  <span className="tm-reply__outcome" data-outcome={draft.outcome}>{REVIEW_OUTCOME_LABELS[draft.outcome]}</span>
                </label>
                <p className="tm-reply__summary">{draft.summary}</p>
                {state.include ? (
                  <>
                    {draft.note ? <AnswerQuote agent={agent} at={draft.answeredAt} note={draft.note} /> : null}
                    <textarea id={bodyId} aria-label={`Reply to ${draft.author ? `@${draft.author}` : 'the comment'}`} rows={2}
                      value={state.body} disabled={busy} onChange={(event) => update(draft.discussionId, { body: event.target.value })} />
                    {draft.resolvable ? (
                      <label className="tm-resolve-check">
                        <input type="checkbox" checked={state.resolve} disabled={busy}
                          onChange={(event) => update(draft.discussionId, { resolve: event.target.checked })} />
                        <span>Resolve thread</span>
                      </label>
                    ) : null}
                  </>
                ) : null}
                {failure ? <p className="form-error" role="alert">{failure.error}</p> : null}
              </section>
            );
          })}
        </div>
        {reviewers.length > 0 ? (
          <div className="tm-reply-modal__reviewers">
            {reviewers.map((name) => (
              <label key={name} className="tm-resolve-check">
                <input type="checkbox" checked={asked.has(name)} disabled={busy} onChange={(event) => setAsked((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(name);
                  else next.delete(name);
                  return next;
                })} />
                <span>Ask @{name} to review again</span>
              </label>
            ))}
          </div>
        ) : null}
        {failed.filter((failure) => failure.reviewer).map((failure) => (
          <p key={failure.reviewer} className="tm-notice tm-modal__notice" role="alert">{failure.error}</p>
        ))}
        {error ? <p className="tm-notice tm-modal__notice" role="alert">{error}</p> : null}
        <div className="tm-modal__actions">
          <button type="button" className="outline-button" disabled={busy} onClick={onCancel}>{posted.size > 0 ? 'Close' : 'Cancel'}</button>
          {done ? null : (
            <button type="submit" className="primary-button" disabled={busy || Boolean(reason)}
              aria-describedby={reason ? 'reply-pr-reason' : undefined}>
              <PendingLabel label={label} pendingLabel="Posting…" pending={busy} />
            </button>
          )}
        </div>
        {reason ? <p id="reply-pr-reason" className="tm-slot__reason">{reason}</p> : null}
      </form>
    </ModalFrame>
  );
}
