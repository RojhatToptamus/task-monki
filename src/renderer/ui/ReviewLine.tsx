import { memo } from 'react';
import { Plus } from 'lucide-react';
import { diffLineCode, type DiffLine } from '../model/diffEvidence';
import { lineAnchor } from '../model/reviewWorkspace';
import type { TokenLine } from '../model/syntaxHighlight';
import { SyntaxCode } from './SyntaxCode';
import { useReviewActions } from './useReviewModel';

/**
 * One row of a file's diff: the line number (the old side's on a removed line),
 * which is the comment control, the marker, and the code in its syntax colour.
 * It renders again only when its own inputs change, and carries its place
 * (`data-line-anchor`) for what points at a line.
 */
export const ReviewLine = memo(function ReviewLine({ path, fileId, blockId, line, index, selected, commentable, plain, tokens }: {
  path: string;
  fileId: string;
  blockId: string;
  line: DiffLine;
  /** The line's position in its block. */
  index: number;
  /** In the range chosen in the gutter. */
  selected: boolean;
  /** Pressing the number comments on the line. */
  commentable: boolean;
  /** A new file's line, read as plain code: every line is added, which its file's head says once. */
  plain?: boolean;
  /** The code's syntax colour, once its side is tokenized. */
  tokens?: TokenLine;
}) {
  const actions = useReviewActions();
  const removed = line.kind === 'deletion';
  const number = removed ? line.oldLine : line.newLine;
  const kind = plain ? 'context' : line.kind;
  return (
    <div
      className={`tm-diffline tm-diffline--${kind} tm-diffline--annotated${selected ? ' tm-diffline--selected' : ''}`}
      data-line-anchor={number === undefined ? undefined : lineAnchor(path, removed ? 'OLD' : 'NEW', number)}
      onContextMenu={(event) => actions.openPathMenu(path, event, line.newLine ?? line.oldLine)}
    >
      {/* The number is the comment control: press or drag across numbers to comment on a range. */}
      <span
        className="tm-diffline__num"
        onPointerDown={commentable ? (event) => actions.beginSelect(fileId, blockId, index, event) : undefined}
        onPointerEnter={() => actions.extendSelect(fileId, blockId, index)}
      >
        {commentable ? (
          <button
            type="button"
            className="tm-review-line__comment"
            aria-label={`Comment on ${removed ? 'removed ' : ''}line ${number}`}
            // A pointer comments through the gutter press; this handles the keyboard.
            onClick={(event) => { if (event.detail === 0) actions.commentOnLine(fileId, blockId, index); }}
          >
            <Plus size={12} aria-hidden="true" />
          </button>
        ) : null}
        {number ?? ''}
      </span>
      <span className="tm-diffline__marker" aria-hidden="true">
        {kind === 'addition' ? '+' : removed ? '−' : ''}
      </span>
      <SyntaxCode text={diffLineCode(line)} tokens={tokens} kind={kind} />
    </div>
  );
});
