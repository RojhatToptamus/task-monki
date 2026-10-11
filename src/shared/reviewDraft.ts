/**
 * The person's unsent review of a task: comments on lines, ranges and files, the
 * Minor and Nit findings they chose to send, and a note. It is saved with the
 * task as it is written, so switching tasks or restarting loses nothing, and it
 * is cleared once the request is sent.
 */
export interface ReviewComment {
  id: string;
  path: string;
  /** NEW anchors to added and unchanged lines, OLD to removed ones. */
  side: 'NEW' | 'OLD';
  /** The first line; absent for a comment on the whole file. */
  line?: number;
  /** The last line of a range. */
  endLine?: number;
  text: string;
}

export interface TaskReviewDraft {
  comments: ReviewComment[];
  /** The review the included findings belong to; inclusions from another review do not apply. */
  reviewRunId?: string;
  /** Minor and Nit findings the person added to the request; Blocker and Major go by default. */
  includedFindingIds: string[];
  note: string;
}

export interface SaveTaskReviewDraftRequest {
  taskId: string;
  draft: TaskReviewDraft;
}

export const REVIEW_DRAFT_COMMENT_LIMIT = 200;
export const REVIEW_COMMENT_MAX_LENGTH = 4_000;
export const REVIEW_NOTE_MAX_LENGTH = 8_000;

export const EMPTY_REVIEW_DRAFT: TaskReviewDraft = { comments: [], includedFindingIds: [], note: '' };

export function isEmptyReviewDraft(draft: TaskReviewDraft): boolean {
  return draft.comments.length === 0 && draft.includedFindingIds.length === 0 && !draft.note.trim();
}

/** Why a value is not a review draft, or undefined when it is one. */
export function reviewDraftProblem(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'A review draft must be an object.';
  const draft = value as Record<string, unknown>;
  if (typeof draft.note !== 'string' || draft.note.length > REVIEW_NOTE_MAX_LENGTH) {
    return `Keep the review note to at most ${REVIEW_NOTE_MAX_LENGTH} characters.`;
  }
  if (draft.reviewRunId !== undefined && !shortText(draft.reviewRunId)) return 'The review run ID is malformed.';
  if (!Array.isArray(draft.includedFindingIds) || draft.includedFindingIds.length > REVIEW_DRAFT_COMMENT_LIMIT ||
    !draft.includedFindingIds.every(shortText)) {
    return 'The included findings are malformed.';
  }
  if (!Array.isArray(draft.comments) || draft.comments.length > REVIEW_DRAFT_COMMENT_LIMIT) {
    return `A review holds at most ${REVIEW_DRAFT_COMMENT_LIMIT} comments.`;
  }
  for (const comment of draft.comments) {
    const problem = reviewCommentProblem(comment);
    if (problem) return problem;
  }
  return undefined;
}

function reviewCommentProblem(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'A review comment must be an object.';
  const comment = value as Record<string, unknown>;
  if (!shortText(comment.id)) return 'A review comment needs an ID.';
  if (typeof comment.path !== 'string' || !comment.path.trim() || comment.path.length > 4_096) {
    return 'A review comment needs a file path.';
  }
  if (comment.side !== 'NEW' && comment.side !== 'OLD') return 'A review comment is on the new or the old side.';
  if (comment.line !== undefined && !positiveInteger(comment.line)) return 'A review comment line is malformed.';
  if (comment.endLine !== undefined && (!positiveInteger(comment.endLine) || comment.line === undefined ||
    (comment.endLine as number) < (comment.line as number))) {
    return 'A review comment range is malformed.';
  }
  if (typeof comment.text !== 'string' || !comment.text.trim() || comment.text.length > REVIEW_COMMENT_MAX_LENGTH) {
    return `Keep each review comment to at most ${REVIEW_COMMENT_MAX_LENGTH} characters.`;
  }
  return undefined;
}

function shortText(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

function positiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}
