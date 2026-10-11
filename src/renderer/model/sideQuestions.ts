import type { AskSubject, TaskInstruction } from '../../shared/contracts';
import type { SessionTurn } from './agentSession';
import { formatCommentLocation } from './reviewFollowUp';

/** The questions asked in one side thread, in the order they were asked. */
export function sideThreadQuestions(instructions: readonly TaskInstruction[], threadId: string | undefined): TaskInstruction[] {
  if (!threadId) return [];
  return instructions
    .filter((instruction) => instruction.role === 'SIDE' && instruction.threadId === threadId)
    .sort((a, b) => a.order - b.order);
}

/** What a question is about, as its line in Ask reads: the finding's title, or the lines' location. */
export function askSubjectLabel(subject: AskSubject, findingTitles: ReadonlyMap<string, string>): string {
  if (subject.kind === 'FINDING') return findingTitles.get(subject.findingId) ?? 'A finding from an earlier review';
  return formatCommentLocation(subject);
}

/** The field's placeholder, which also names it: what the next question is about. */
export function askPlaceholder(subject: AskSubject | undefined): string {
  if (subject?.kind === 'FINDING') return 'Ask about this finding';
  if (subject?.kind === 'LINES') return subject.endLine && subject.endLine > subject.line ? 'Ask about these lines' : 'Ask about this line';
  return 'Ask about the work';
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
  return `Read a snapshot from ${time}${omitted > 0 ? `, without ${omitted} large untracked file${omitted === 1 ? '' : 's'}` : ''}`;
}
