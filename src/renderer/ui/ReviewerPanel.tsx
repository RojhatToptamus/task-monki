import { useMemo, useState, type RefObject } from 'react';
import { CornerUpLeft, X } from 'lucide-react';
import type { ReviewFindingDecision } from '../../shared/agentReviewFindings';
import type { AgentConversationRecords } from '../model/agentRecords';
import { isActiveRunStatus, type SessionTurn } from '../model/agentSession';
import { reviewerProse, reviewerRevisionLines, reviewQuestions } from '../model/reviewerConversation';
import type { ReviewFindingView } from '../model/reviewWorkspace';
import { canStopTaskRun } from '../model/runProgress';
import { ConversationPanel } from './ConversationPanel';
import { Tooltip } from './Tooltip';
import { Turn, UnattachedMessages, unattachedInstructions, useSessionTurns, WorkingLine } from './SessionTurns';

export interface ReviewerConversation {
  records: AgentConversationRecords;
  ask(input: { reviewRunId: string; text: string; messageId: string; findingId?: string }): Promise<void>;
  stop(runId: string): Promise<void>;
  readArtifact?(id: string): Promise<string>;
}

/**
 * Questions about one review, answered by a fresh read-only reviewer session.
 * A question can be about one finding; the reviewer can revise findings only
 * through its structured block, and each revision shows as one line under the
 * answer. A stale review stays readable but takes no new questions.
 */
export function ReviewerPanel({ conversation, reviewerName, reviewRunId, stale, findings, decisions, focusFinding, onClearFocus, draft, onDraftChange, onRunReviewAgain, onClose, returnFocusRef, docked, autoFocus }: {
  conversation: ReviewerConversation;
  /** The runtime that wrote the review, which also answers questions about it. */
  reviewerName: string;
  reviewRunId: string;
  stale: boolean;
  findings: ReviewFindingView[];
  decisions: ReviewFindingDecision[];
  /** The finding the next question is about, chosen with Ask on its thread. */
  focusFinding?: ReviewFindingView;
  onClearFocus(): void;
  draft: string;
  onDraftChange(text: string): void;
  onRunReviewAgain?(): void;
  onClose(): void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  docked?: boolean;
  autoFocus?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const questions = useMemo(() => reviewQuestions(conversation.records.instructions, reviewRunId), [conversation.records.instructions, reviewRunId]);
  const questionIds = useMemo(() => new Set(questions.map((question) => question.id)), [questions]);
  const runs = useMemo(
    () => conversation.records.runs.filter((run) => run.continuedFromRunId === reviewRunId || questions.some((question) => question.runId === run.id)),
    [conversation.records.runs, questions, reviewRunId]
  );
  const rawTurns = useSessionTurns({
    runs,
    items: conversation.records.items,
    instructions: questions,
    plans: conversation.records.plans,
    interactions: conversation.records.interactions
  });
  // The reviewer's answer is shown as prose; its revision block becomes the lines below it.
  const turns = useMemo(() => rawTurns.map(withReviewerProse), [rawTurns]);
  const findingTitle = new Map(findings.map((finding) => [finding.id, finding.title]));
  const aboutByInstruction = new Map(questions.map((question) => [question.id, question.findingId ? findingTitle.get(question.findingId) : undefined]));
  const active = runs.find((run) => isActiveRunStatus(run.status));
  const unattached = unattachedInstructions(questions, runs);

  // The working line says when the reviewer is answering; the hint only says why a question cannot be asked.
  const disabledReason = stale ? 'Review out of date' : undefined;
  const send = async (text: string) => {
    await conversation.ask({ reviewRunId, text, messageId: crypto.randomUUID(), findingId: focusFinding?.id });
    onClearFocus();
  };

  return (
    <ConversationPanel
      title="Reviewer"
      meta={reviewerName}
      label="Questions for the reviewer"
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      docked={docked}
      autoFocus={autoFocus}
      composer={{
        placeholder: focusFinding ? 'Ask about this finding' : 'Ask about this review',
        hint: disabledReason ?? '',
        disabled: stale || Boolean(active),
        draft,
        onDraftChange,
        onSubmit: send,
        secondary: active && canStopTaskRun(active)
          ? { label: 'Stop', disabled: busy || active.status === 'INTERRUPTING', onClick: async () => {
              setBusy(true);
              try { await conversation.stop(active.id); } finally { setBusy(false); }
            } }
          : stale && onRunReviewAgain
            ? { label: 'Run review again', onClick: async () => onRunReviewAgain() }
            : undefined,
        above: focusFinding && !stale ? (
          <div className="tm-reviewer__about">
            <CornerUpLeft size={13} aria-hidden="true" />
            <span>{focusFinding.title}</span>
            <Tooltip label="Ask about the whole review instead">
              <button type="button" className="tm-iconbtn" aria-label="Ask about the whole review instead" onClick={onClearFocus}>
                <X size={13} aria-hidden="true" />
              </button>
            </Tooltip>
          </div>
        ) : undefined
      }}
    >
      {turns.map((turn) => {
        const about = turn.opener ? aboutByInstruction.get(turn.opener.key) : undefined;
        const revisions = reviewerRevisionLines(decisions, findings, turn.run.id);
        return (
          <div key={turn.key} className="tm-side-conversation__exchange">
            {about ? <p className="tm-reviewer__about-line">{about}</p> : null}
            <Turn turn={turn} onReadArtifact={conversation.readArtifact} />
            {revisions.map((line) => (
              <p key={line.id} className="tm-reviewer__revision" role="status">
                <span className="tm-reviewer__revision-action">{line.action}</span> {line.title}
              </p>
            ))}
          </div>
        );
      })}
      <UnattachedMessages instructions={unattached} />
      {active && (active.status === 'QUEUED' || active.status === 'STARTING' || !turns.at(-1)?.entries.length) && questionIds.size > 0 ? (
        <WorkingLine label={active.status === 'INTERRUPTING' ? 'Stopping…' : 'Reading the review…'} since={active.startedAt} />
      ) : null}
    </ConversationPanel>
  );
}

function withReviewerProse(turn: SessionTurn): SessionTurn {
  const entries = turn.entries.flatMap((entry) => {
    if (entry.kind !== 'message' || entry.author !== 'Agent') return [entry];
    const text = reviewerProse(entry.text);
    return text ? [{ ...entry, text }] : [];
  });
  return { ...turn, entries, answer: turn.answer === undefined ? undefined : reviewerProse(turn.answer) };
}
