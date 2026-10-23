import type { AskSubject, PullRequestDiscussion, TaskInstruction } from '../../shared/contracts';
import type { SessionTurn } from './agentSession';
import { formatCommentLocation, pluralize } from './formatting';
import { discussionAuthor, discussionSummary } from './pullRequestFeedback';

/** The questions asked in one side thread, in the order they were asked. */
export function sideThreadQuestions(instructions: readonly TaskInstruction[], threadId: string | undefined): TaskInstruction[] {
  if (!threadId) return [];
  return instructions
    .filter((instruction) => instruction.role === 'SIDE' && instruction.threadId === threadId)
    .sort((a, b) => a.order - b.order);
}

/** What the task's subjects are called: its findings' titles, the walkthrough's intents, its discussions. */
export interface AskSubjectNames {
  findings: ReadonlyMap<string, string>;
  /** The intents of the walkthrough a review wrote, by section. */
  walkthrough?: { reviewRunId: string; titles: readonly string[] };
  discussions: ReadonlyMap<string, string>;
}

/** A discussion as a question names it: who started it, and its first line. */
export function discussionSubjectName(discussion: Pick<PullRequestDiscussion, 'comments'>): string {
  return `${discussionAuthor(discussion) ?? 'Unknown'}: ${discussionSummary(discussion)}`;
}

/**
 * What a question is about, as its line in Ask reads: the finding's title, the
 * lines' or the file's location, the intent's title, or the discussion. One
 * no longer the task's says what it was.
 */
export function askSubjectLabel(subject: AskSubject, names: AskSubjectNames): string {
  switch (subject.kind) {
    case 'FINDING': return names.findings.get(subject.findingId) ?? 'A finding from an earlier review';
    case 'LINES': return formatCommentLocation(subject);
    case 'FILE': return subject.path;
    case 'STAGE': return (names.walkthrough?.reviewRunId === subject.reviewRunId ? names.walkthrough.titles[subject.section] : undefined)
      ?? 'An intent of an earlier walkthrough';
    case 'THREAD': return names.discussions.get(subject.discussionId) ?? 'A discussion on the pull request';
  }
}

/** The field's placeholder, which also names it: what the next question is about. */
export function askPlaceholder(subject: AskSubject | undefined): string {
  switch (subject?.kind) {
    case 'FINDING': return 'Ask about this finding';
    case 'LINES': return subject.endLine && subject.endLine > subject.line ? 'Ask about these lines' : 'Ask about this line';
    case 'FILE': return 'Ask about this file';
    case 'STAGE': return 'Ask about this intent';
    case 'THREAD': return 'Ask about this discussion';
    default: return 'Ask about the work';
  }
}

/**
 * What "Use in follow-up" puts in the main composer: the answer, introduced by
 * the question it answers, so the implementation agent reads it in context.
 * A turn without an answer offers nothing.
 */
export function sideQuestionFollowUp(turn: Pick<SessionTurn, 'opener' | 'answer'>): string | undefined {
  const answer = turn.answer?.trim();
  if (!answer) return undefined;
  const question = turn.opener?.kind === 'prompt' ? turn.opener.text.replace(/\s+/gu, ' ').trim() : '';
  return question ? `From a side question, “${question}”:\n\n${answer}` : answer;
}

/** Appends follow-up text to a draft, a blank line apart. */
export function appendToDraft(draft: string, text: string): string {
  const current = draft.trimEnd();
  return current ? `${current}\n\n${text}` : text;
}

/**
 * When an answer read a snapshot rather than the live worktree: how fresh it is,
 * and how many untracked files were too large to include.
 */
export function sideQuestionSnapshotNote(question: Pick<TaskInstruction, 'snapshotTakenAt' | 'snapshotOmittedFileCount'> | undefined): string | undefined {
  if (!question?.snapshotTakenAt) return undefined;
  const taken = new Date(question.snapshotTakenAt);
  if (Number.isNaN(taken.getTime())) return undefined;
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(taken);
  const omitted = question.snapshotOmittedFileCount ?? 0;
  return `Read a snapshot from ${time}${omitted > 0 ? `, without ${pluralize(omitted, 'large untracked file')}` : ''}`;
}
