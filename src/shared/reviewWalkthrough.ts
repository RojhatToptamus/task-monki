/**
 * The walkthrough of a change: the review agent tells the change it read as a
 * few sections, one per intent, each with its files, the lines to read first,
 * and the phrases of its explanation that point at code. The agent writes it
 * with its findings, from the same captured code, so both describe one
 * revision. Task Monki checks it against that change before keeping it as the
 * review run's `review-walkthrough` artifact: a part that fails a check is
 * dropped, files no section claims join a last Other changes section, and the
 * counts and lengths the prompt asks for are held.
 */

export const REVIEW_WALKTHROUGH_SCHEMA = 'task-monki/review-walkthrough/v2';
/** The stored document; a walkthrough past it is not kept. */
export const REVIEW_WALKTHROUGH_MAX_BYTES = 2 * 1024 * 1024;

export interface ReviewWalkthrough {
  schema: typeof REVIEW_WALKTHROUGH_SCHEMA;
  reviewRunId: string;
  /** The change it describes: from the base commit the review compared against to the tree it read. */
  base: string;
  tree: string;
  summary: string;
  /** At most three. */
  attention: ReviewWalkthroughAttention[];
  /** In reading order. The last is Other changes when the agent left a changed file out. */
  sections: ReviewWalkthroughSection[];
}

/** A fact that deserves attention, in its section; it may name the review's finding it is about, or a file of its section. */
export interface ReviewWalkthroughAttention {
  text: string;
  /** The section it belongs to, as an index into `sections`. */
  section: number;
  /** The id of one of the review's own findings. */
  finding?: string;
  /** A file of its section. */
  path?: string;
}

export interface ReviewWalkthroughSection {
  title: string;
  /** Empty for Other changes. */
  explanation: string;
  /** The paths of its files: every changed file sits in exactly one section, the most important first. */
  files: string[];
  /** The lines to read first; at most three. */
  excerpts: ReviewWalkthroughExcerpt[];
  /** Phrases of the explanation tied to the lines that implement them; at most three. */
  terms: ReviewWalkthroughTerm[];
}

/**
 * Lines inside one hunk of a file of their own section: NEW lines are the code
 * the review read, OLD lines the base, which only a deleted file uses.
 */
export interface ReviewWalkthroughLines {
  path: string;
  side: 'NEW' | 'OLD';
  line: number;
  /** The last line of a range. */
  endLine?: number;
}

export interface ReviewWalkthroughExcerpt extends ReviewWalkthroughLines {
  /** What the lines decide, in a few words. */
  caption?: string;
}

export interface ReviewWalkthroughTerm extends ReviewWalkthroughLines {
  /** An exact phrase of its section's explanation. */
  text: string;
}

/**
 * Why a completed review has no walkthrough: it wrote none (NOT_WRITTEN); no
 * section held a changed file (NO_SECTIONS); the code it read was not kept, so
 * nothing could be checked (NOT_RECORDED); the change or the walkthrough is past
 * its limit (TOO_LARGE); or the change could no longer be read (UNREADABLE).
 */
export const REVIEW_WALKTHROUGH_UNAVAILABLE_REASONS = [
  'NOT_WRITTEN',
  'NO_SECTIONS',
  'NOT_RECORDED',
  'TOO_LARGE',
  'UNREADABLE'
] as const;
export type ReviewWalkthroughUnavailableReason = (typeof REVIEW_WALKTHROUGH_UNAVAILABLE_REASONS)[number];

/**
 * The review gate's walkthrough. A stored one names its review: while a newer
 * review runs, and after one that ends without an outcome, it stays as earlier
 * context.
 */
export type ReviewWalkthroughState =
  | {
      status: 'STORED';
      reviewRunId: string;
      /** The review run's `review-walkthrough` artifact. */
      artifactId: string;
    }
  | { status: 'UNAVAILABLE'; reason: ReviewWalkthroughUnavailableReason };

/** Reads a stored walkthrough; a document of another schema or review reads as nothing. */
export function parseReviewWalkthrough(text: string, reviewRunId: string): ReviewWalkthrough | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.schema !== REVIEW_WALKTHROUGH_SCHEMA || record.reviewRunId !== reviewRunId) return undefined;
  if (!Array.isArray(record.sections) || !Array.isArray(record.attention)) return undefined;
  return value as ReviewWalkthrough;
}
