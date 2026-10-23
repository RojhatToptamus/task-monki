import { memo, useState, type ReactNode } from 'react';
import { ChevronRight, MoreHorizontal } from 'lucide-react';
import { isBlockingFinding, type WorktreeRecord } from '../../shared/contracts';
import type { DiffBlock, DiffFile } from '../model/diffEvidence';
import { discussionAuthor, discussionSummary, type DiscussionView } from '../model/pullRequestFeedback';
import type { WholeFileState } from '../model/reviewContext';
import type { ReviewAnchors } from '../model/reviewReading';
import { buildReviewDiffRows, lineAnchorKey, reviewRowRange, selectionRange, type ReviewFindingView } from '../model/reviewWorkspace';
import { ActionMenu, type ActionMenuItem } from './ActionMenu';
import { DiffStat } from './DiffStat';
import { ExpandToggle } from './ExpandToggle';
import { useOpenTargetMenuItems } from './OpenTargetMenu';
import { ReviewBands } from './ReviewBands';
import { severityLabel } from './ReviewFindingThread';
import { ReviewGap } from './ReviewGap';
import { ReviewLine } from './ReviewLine';
import { Tooltip } from './Tooltip';
import { useDiffSyntax } from './useSyntaxLines';
import { useReviewActions, type LineSelection } from './useReviewModel';

/** A run of one block's rows shown on its own, by line identity (`diffLineId`), under its caption. */
export interface ReviewFileSegment {
  blockId: string;
  /** The run's first and last lines. */
  start: string;
  end: string;
  /** What the run is, above it, such as a walkthrough's caption. */
  caption?: ReactNode;
  /** The person just opened it: it fades in. */
  entering?: boolean;
}

export interface ReviewFileUnitProps {
  file: DiffFile;
  /** Folded to its head; what asks for something stays as one row each. */
  collapsed: boolean;
  viewed: boolean;
  /** Open findings anywhere in the file: in words on its head, and a row each while it is collapsed. */
  findings: readonly ReviewFindingView[];
  /** Open discussions anywhere in the file: a row each while it is collapsed. */
  discussions: readonly DiscussionView[];
  anchors: ReviewAnchors;
  wholeFile: WholeFileState;
  /** The composer's place, while it is in this file. */
  composer?: string;
  /** The gutter's choice, while it is in this file. */
  selection?: LineSelection;
  canComment: boolean;
  /** The removed lines are the reviewed code's, not the base's, so they take no comments. */
  exactChanges: boolean;
  /** The checkout the file opens from; absent for an earlier capture. */
  worktree?: Pick<WorktreeRecord, 'id' | 'taskId'>;
  /** The file's menu offers Ask about it. */
  askable?: boolean;
  /** A new file read as plain code: every line is added, which the head's New says once. */
  plain?: boolean;
  /** These runs, in this order, instead of every block. */
  segments?: readonly ReviewFileSegment[];
  /** A gap-style row after the runs that opens what they leave out, such as "3 more changes". */
  more?: { label: string; onOpen(): void };
  /** Whether the file is shown alone; absent, the head has no full-screen control. */
  fullScreen?: boolean;
  /** Another file is shown alone. */
  hidden?: boolean;
}

/**
 * A file of the change: a sticky head at table-row scale over its rows, with
 * what is said about it where it belongs. A viewed or generated file starts
 * collapsed, but its open findings and discussions stay as one-line rows:
 * Viewed never hides them. It renders again only when its own inputs change.
 */
export const ReviewFileUnit = memo(function ReviewFileUnit(props: ReviewFileUnitProps) {
  const { file, collapsed, viewed, findings, discussions, anchors, composer, selection, fullScreen } = props;
  const actions = useReviewActions();
  const parts = file.path.split('/');
  const name = parts.pop() ?? file.path;
  const fileKey = `file:${file.id}`;
  const top = {
    findings: anchors.findings.byFile.get(file.id),
    discussions: anchors.discussions.byFile.get(file.id),
    comments: anchors.comments.byFile.get(file.id)
  };
  const blockRows = (block: DiffBlock, segment?: ReviewFileSegment) => (
    <ReviewRows
      file={file}
      block={block}
      segment={segment}
      anchors={anchors}
      composer={composer}
      selection={selection?.blockId === block.id ? selection : undefined}
      canComment={props.canComment}
      exactChanges={props.exactChanges}
      plain={props.plain}
    />
  );
  return (
    <section
      className={`tm-review-file${collapsed ? ' tm-review-file--collapsed' : ''}`}
      data-file-id={file.id}
      data-expanded={fullScreen ? '' : undefined}
      hidden={props.hidden}
      aria-label={file.path}
    >
      <header className="tm-review-file__head" onContextMenu={(event) => actions.openPathMenu(file.path, event)}>
        <Tooltip label={collapsed ? 'Expand' : 'Collapse'} shortcut="⌥ all files">
          <button
            type="button"
            className="tm-review-file__toggle"
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${file.path}`}
            onClick={(event) => actions.toggleCollapsed(file.id, event.altKey)}
          >
            <ChevronRight size={13} aria-hidden="true" />
            <span className="tm-review-file__path">
              {parts.length ? <span className="tm-review-file__dir">{parts.join('/')}/</span> : null}
              <span className="tm-review-file__name">{name}</span>
            </span>
          </button>
        </Tooltip>
        {file.oldPath ? <span className="tm-review-file__word">from <code>{file.oldPath}</code></span>
          : file.status === 'added' || file.status === 'deleted' ? <span className="tm-review-file__word">{file.status === 'added' ? 'New' : 'Deleted'}</span> : null}
        {file.invisibleCharacters ? <span className="tm-review-file__word" data-tone="waiting">Invisible characters</span> : null}
        <span className="tm-review-file__spacer" />
        {findings.length ? (
          <span className="tm-review-file__count" data-tone={findings.some(isBlockingFinding) ? 'blocked' : undefined}>{findingWords(findings)}</span>
        ) : null}
        <DiffStat additions={file.additions} deletions={file.deletions} />
        <Tooltip label="Viewed" shortcut="V">
          {/* The 16px mark sits in a 24px target, like every control in the head. */}
          <label className="tm-review-file__viewed">
            <input type="checkbox" aria-label="Viewed" checked={viewed} onChange={() => actions.setFileViewed(file.id, !viewed)} />
          </label>
        </Tooltip>
        <FileMenu file={file} worktree={props.worktree} canComment={props.canComment} askable={Boolean(props.askable)} wholeFile={props.wholeFile} />
        {/* The head's Expand and Collapse are the chevron's, so this control names full screen. */}
        {fullScreen === undefined ? null : (
          <ExpandToggle
            compact
            className="tm-review__mini"
            expanded={fullScreen}
            labels={{ expand: 'Full screen', collapse: 'Exit full screen' }}
            ariaLabel={fullScreen ? 'Exit full screen' : `Show ${file.path} full screen`}
            onToggle={(animate) => actions.showFullScreen(fullScreen ? undefined : file.id, animate)}
          />
        )}
      </header>
      {collapsed ? (
        <>
          {findings.map((finding) => (
            <button key={finding.id} type="button" className="tm-review-checkpoint" onClick={() => actions.showFinding(finding.id)}>
              <span className="tm-review__severity" data-severity={finding.severity}>{severityLabel(finding)}</span>
              <span className="tm-review-checkpoint__title">{finding.title}</span>
            </button>
          ))}
          {discussions.map((discussion) => (
            <button key={discussion.id} type="button" className="tm-review-checkpoint" onClick={() => actions.showDiscussion(discussion.id)}>
              <span className="tm-review-checkpoint__who">{discussionAuthor(discussion) ?? 'Unknown'}</span>
              <span className="tm-review-checkpoint__title">{discussionSummary(discussion)}</span>
            </button>
          ))}
        </>
      ) : (
        <>
          {top.findings || top.discussions || top.comments || composer === fileKey ? <ReviewBands place="file" at={fileKey} file={file} {...top} /> : null}
          {props.segments ? props.segments.map((segment) => {
            const block = file.blocks.find((candidate) => candidate.id === segment.blockId);
            return block ? (
              <div key={`${segment.blockId}:${segment.start}`} className="tm-review-block" data-entering={segment.entering ? '' : undefined}>
                {segment.caption}
                {blockRows(block, segment)}
              </div>
            ) : null;
          }) : file.blocks.map((block) => (
            <div key={block.id} className="tm-review-block">
              {file.blocks.length > 1 ? <div className="tm-review-block__label">{block.label}</div> : null}
              {blockRows(block)}
            </div>
          ))}
          {props.more ? (
            <div className="tm-review-gap tm-review-gap--open">
              <button type="button" className="tm-review-gap__all" onClick={props.more.onOpen}><span>{props.more.label}</span></button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
});

/**
 * The rows of one block, or of one run of it, with each row's bands under it.
 * Unchanged lines between hunks are gap rows; the range chosen in the gutter is
 * found once per render. The whole block is coloured, so a run shown on its own
 * reads a comment or string opened above it.
 */
const ReviewRows = memo(function ReviewRows({ file, block, segment, anchors, composer, selection, canComment, exactChanges, plain }: {
  file: DiffFile;
  block: DiffBlock;
  segment?: ReviewFileSegment;
  anchors: ReviewAnchors;
  composer?: string;
  selection?: LineSelection;
  canComment: boolean;
  exactChanges: boolean;
  plain?: boolean;
}) {
  const actions = useReviewActions();
  const syntax = useDiffSyntax(file.path, block.lines, file.oldPath);
  const rows = buildReviewDiffRows(block.lines);
  const range = segment ? reviewRowRange(rows, segment.start, segment.end) : { from: 0, to: rows.length - 1 };
  if (!range) return null;
  const chosen = selection ? selectionRange(block, selection) : undefined;
  return rows.slice(range.from, range.to + 1).map((row, offset) => {
    if (row.kind === 'gap') {
      if (row.hidden === 0 && !row.heading) return null;
      // Keyed by the hunk it leads into, so it keeps focus while lines open above it.
      return <ReviewGap key={`gap-${row.reveal ? row.raw : range.from + offset}`} row={row} onReveal={(from, to) => actions.revealLines(block.id, from, to)} />;
    }
    const { line, index } = row;
    const key = lineAnchorKey(file.id, block.id, line, index);
    const findings = anchors.findings.byLine.get(key);
    const discussions = anchors.discussions.byLine.get(key);
    const comments = anchors.comments.byLine.get(key);
    const number = line.kind === 'deletion' ? line.oldLine : line.newLine;
    const commentable = canComment && number !== undefined && !(exactChanges && line.kind === 'deletion');
    return (
      <div key={key} className="tm-review-line-group">
        <ReviewLine
          path={file.path}
          fileId={file.id}
          blockId={block.id}
          line={line}
          index={index}
          selected={Boolean(chosen && index >= chosen.start && index <= chosen.end)}
          commentable={commentable}
          plain={plain}
          tokens={syntax[index]}
        />
        {findings || discussions || comments || composer === key
          ? <ReviewBands place="line" at={key} file={file} row={{ blockId: block.id, index, commentable }}
            findings={findings} discussions={discussions} comments={comments} />
          : null}
      </div>
    );
  });
});

/** A file's "…" menu: comment on the whole file, ask about it, read it whole, then where it opens. */
function FileMenu({ file, worktree, canComment, askable, wholeFile }: {
  file: DiffFile;
  worktree?: Pick<WorktreeRecord, 'id' | 'taskId'>;
  canComment: boolean;
  askable: boolean;
  wholeFile: WholeFileState;
}) {
  const actions = useReviewActions();
  const [open, setOpen] = useState(false);
  const target = worktree ? { type: 'worktreeFile' as const, taskId: worktree.taskId, worktreeId: worktree.id, relativePath: file.path } : undefined;
  const openTargetItems = useOpenTargetMenuItems(target, open, actions.notifyError);
  const whole: ActionMenuItem | undefined = wholeFile.kind === 'unavailable'
    ? { id: 'whole-file', label: 'Show whole file', disabled: true, disabledReason: wholeFile.reason }
    : wholeFile.kind === 'partial' ? { id: 'whole-file', label: 'Show whole file', onSelect: () => actions.setWholeFile(file.id, true) }
      : wholeFile.kind === 'whole' ? { id: 'whole-file', label: 'Show changes only', onSelect: () => actions.setWholeFile(file.id, false) }
        : undefined;
  const items: ActionMenuItem[] = [
    ...(canComment ? [{ id: 'comment', label: 'Comment on file', onSelect: () => actions.commentOnFile(file.id) }] : []),
    ...(askable ? [{ id: 'ask', label: 'Ask about this file', onSelect: () => actions.askAboutFile(file.id) }] : []),
    ...(whole ? [whole] : []),
    ...openTargetItems.map((item, index) => (index === 0 && (canComment || askable || whole) ? { ...item, separated: true } : item))
  ];
  if (!items.length) return null;
  return (
    <ActionMenu
      className="tm-review-file__menu"
      label={`Options for ${file.path}`}
      tooltip="File options"
      side="bottom"
      open={open}
      onOpenChange={setOpen}
      trigger={<MoreHorizontal size={16} aria-hidden="true" />}
      items={items}
    />
  );
}

/** Open findings in words, most severe first: "1 major, 2 minor". */
function findingWords(findings: readonly ReviewFindingView[]): string {
  const counts = new Map<string, number>();
  for (const finding of findings) counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  return (['BLOCKER', 'MAJOR', 'MINOR', 'NIT'] as const)
    .filter((severity) => counts.has(severity))
    .map((severity) => `${counts.get(severity)} ${severityLabel({ severity }).toLowerCase()}`)
    .join(', ');
}
