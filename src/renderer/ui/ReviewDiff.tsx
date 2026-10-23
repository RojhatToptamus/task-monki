import { ReviewBands } from './ReviewBands';
import { ReviewBrief, ReviewCommitBrief } from './ReviewBrief';
import { ReviewFileUnit } from './ReviewFileUnit';
import type { ReviewModel } from './useReviewModel';

const NO_FEEDBACK: readonly never[] = [];

/**
 * The Diff: the complete review, file by file in the order that matters. The
 * brief states the facts first, or a commit's own when the Diff reads one;
 * feedback without a place in the files sits above them, framed as a file is.
 */
export function ReviewDiff({ model }: { model: ReviewModel }) {
  const { anchors, focusedFile, commentDraft, selection } = model;
  const general = { findings: anchors.findings.general, discussions: anchors.discussions.general };
  const worktree = model.props.historical ? undefined : model.props.worktree;
  const askable = Boolean(model.props.onAskAboutFile) && !model.props.historical;
  return (
    <div className="tm-review__diff">
      {model.commit ? <ReviewCommitBrief {...model.commit} /> : null}
      {model.brief ? <ReviewBrief content={model.brief} folded={model.briefFolded} onFoldedChange={model.actions.foldBrief} /> : null}
      {model.emptyText ? <p className="tm-review__empty">{model.emptyText}</p> : null}
      {general.findings.length > 0 || general.discussions.length > 0 ? (
        <section className="tm-review-general" aria-label="Feedback without a location">
          <ReviewBands place="general" findings={general.findings} discussions={general.discussions} />
        </section>
      ) : null}
      {model.ordered.map((entry) => {
        const { id } = entry.file;
        return (
          <ReviewFileUnit
            key={id}
            file={entry.file}
            collapsed={model.isCollapsed(entry)}
            viewed={model.history ? undefined : model.viewedIds.has(id)}
            findings={model.openFindingsByFile.get(id) ?? NO_FEEDBACK}
            discussions={model.openDiscussionsByFile.get(id) ?? NO_FEEDBACK}
            anchors={anchors}
            wholeFile={model.wholeFile(id)}
            composer={commentDraft && !commentDraft.editingId && commentDraft.fileId === id ? commentDraft.key : undefined}
            selection={selection?.fileId === id ? selection : undefined}
            canComment={model.canComment}
            exactChanges={model.exactChanges}
            worktree={worktree}
            askable={askable}
            fullScreen={focusedFile === id}
            hidden={Boolean(focusedFile) && focusedFile !== id}
          />
        );
      })}
    </div>
  );
}
