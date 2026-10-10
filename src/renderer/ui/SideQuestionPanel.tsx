import { useMemo, useState, type RefObject } from 'react';
import { CornerDownLeft } from 'lucide-react';
import type { AgentConversationRecords } from '../model/agentRecords';
import { isActiveRunStatus } from '../model/agentSession';
import { sideQuestionFollowUp, sideQuestionSnapshotNote, sideThreadQuestions } from '../model/sideQuestions';
import { canStopTaskRun } from '../model/runProgress';
import { ConversationPanel } from './ConversationPanel';
import { Elapsed, Turn, UserMessage, useSessionTurns } from './SessionTurns';

export interface SideConversation {
  records: AgentConversationRecords;
  ask(input: { threadId: string; text: string; messageId: string }): Promise<void>;
  stop(runId: string): Promise<void>;
  /** Ends the thread: its read-only snapshot is removed; its runs stay in Debug. */
  end(threadId: string): Promise<void>;
  readArtifact?(id: string): Promise<string>;
}

/**
 * A side question to the task's agent: asked of a fresh read-only session on
 * the same runtime and model, so the implementation keeps working. Nothing here
 * reaches the main conversation unless the person uses an answer in a
 * follow-up. While the agent works, questions read a snapshot of the worktree.
 */
export function SideQuestionPanel({ conversation, agentName, threadId, implementationActive, runtimeUnavailable, draft, onDraftChange, onUseInFollowUp, onClose, returnFocusRef, docked, autoFocus }: {
  conversation: SideConversation;
  /** The runtime that answers, the task's own agent. */
  agentName: string;
  threadId: string;
  /** The implementation agent is working, so answers read a snapshot taken when asked. */
  implementationActive: boolean;
  /** Why the task's runtime cannot answer now, stated where the question is written. */
  runtimeUnavailable?: string;
  draft: string;
  onDraftChange(text: string): void;
  onUseInFollowUp(text: string): void;
  onClose(): void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  docked?: boolean;
  autoFocus?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const questions = useMemo(() => sideThreadQuestions(conversation.records.instructions, threadId), [conversation.records.instructions, threadId]);
  const runs = useMemo(
    () => conversation.records.runs.filter((run) => questions.some((question) => question.runId === run.id)),
    [conversation.records.runs, questions]
  );
  const turns = useSessionTurns({
    runs,
    items: conversation.records.items,
    instructions: questions,
    plans: conversation.records.plans,
    interactions: conversation.records.interactions
  });
  const active = runs.find((run) => isActiveRunStatus(run.status));
  const unattached = questions.filter((question) =>
    !runs.some((run) => run.id === question.runId) && (question.status === 'SENDING' || question.status === 'UNCERTAIN' || (question.status === 'FAILED' && !question.runId))
  );

  return (
    <ConversationPanel
      title="Side question"
      meta={agentName}
      label="Side question"
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      docked={docked}
      autoFocus={autoFocus}
      composer={{
        placeholder: `Ask ${agentName} without interrupting it`,
        hint: runtimeUnavailable ?? '',
        disabled: Boolean(active || runtimeUnavailable),
        draft,
        onDraftChange,
        onSubmit: (text) => conversation.ask({ threadId, text, messageId: crypto.randomUUID() }),
        secondary: active && canStopTaskRun(active)
          ? { label: 'Stop', disabled: busy || active.status === 'INTERRUPTING', onClick: async () => {
              setBusy(true);
              try { await conversation.stop(active.id); } finally { setBusy(false); }
            } }
          : undefined
      }}
    >
      {turns.length === 0 && unattached.length === 0 ? (
        <p className="tm-side-conversation__empty">
          Ask about the work while {agentName} keeps going.
        </p>
      ) : null}
      {turns.map((turn) => {
        const followUp = turn.state === 'completed' ? sideQuestionFollowUp(turn) : undefined;
        const snapshot = sideQuestionSnapshotNote(questions.find((question) => question.id === turn.opener?.key));
        return (
          <div key={turn.key} className="tm-side-conversation__exchange">
            <Turn turn={turn} onReadArtifact={conversation.readArtifact} />
            {snapshot ? <p className="tm-side-conversation__note">{snapshot}</p> : null}
            {followUp ? (
              <button type="button" className="ghost-button" onClick={() => onUseInFollowUp(followUp)}>
                <CornerDownLeft size={14} aria-hidden="true" />
                Use in follow-up
              </button>
            ) : null}
          </div>
        );
      })}
      {unattached.map((question) => (
        <UserMessage
          key={question.id}
          text={question.text}
          time={question.createdAt}
          status={question.status === 'FAILED' ? question.detail ?? 'Not sent' : question.status === 'UNCERTAIN' ? 'Delivery uncertain' : 'Sending…'}
        />
      ))}
      {active && (active.status === 'QUEUED' || active.status === 'STARTING' || !turns.at(-1)?.entries.length) ? (
        <div className="tm-side-conversation__working">
          <span role="status" className="tm-shimmer">{active.status === 'INTERRUPTING' ? 'Stopping…' : implementationActive ? 'Reading a snapshot…' : 'Reading the task…'}</span>
          <Elapsed since={active.startedAt} />
        </div>
      ) : null}
    </ConversationPanel>
  );
}
