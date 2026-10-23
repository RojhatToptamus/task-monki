import { useMemo, useState, type RefObject } from 'react';
import { CornerDownLeft, CornerUpLeft, X } from 'lucide-react';
import type { AgentModel, AgentRuntimeState, AskSubject, SideQuestionModelChoice } from '../../shared/contracts';
import type { AgentConversationRecords } from '../model/agentRecords';
import { runtimeExecutionUnavailableReason } from '../model/runtimeReadiness';
import { AgentModelSelector } from './AgentModelSelector';
import { isActiveRunStatus } from '../model/agentSession';
import { askPlaceholder, askSubjectLabel, sideQuestionFollowUp, sideQuestionSnapshotNote, sideThreadQuestions, type AskSubjectNames } from '../model/sideQuestions';
import { canStopTaskRun } from '../model/runProgress';
import { ConversationPanel } from './ConversationPanel';
import { Tooltip } from './Tooltip';
import { Turn, UnattachedMessages, unattachedInstructions, useSessionTurns, WorkingLine } from './SessionTurns';

export interface AskConversation {
  records: AgentConversationRecords;
  /** Where a new thread's model starts: the Settings default for Ask. */
  defaultModel?: SideQuestionModelChoice;
  ask(input: { threadId: string; text: string; messageId: string; model?: SideQuestionModelChoice; subject?: AskSubject }): Promise<void>;
  stop(runId: string): Promise<void>;
  /** Ends the thread: its read-only snapshot is removed; its runs stay in Debug. */
  end(threadId: string): Promise<void>;
  readArtifact?(id: string): Promise<string>;
}

/**
 * Ask: questions about the task, answered by a fresh read-only session on the model
 * chosen here, the task's own by default, so the implementation keeps working. A
 * question can be about a finding, lines or a file of the diff, an intent of the
 * walkthrough, or a discussion. Nothing here reaches the agent unless the person
 * uses an answer; while the agent works, answers read a snapshot of the worktree.
 */
export function AskPanel({
  conversation, defaultModel, models, runtimes, onDiscoverModels, threadId, implementationActive, draft, onDraftChange,
  subject, onSubjectChange, subjectNames, answerAction, focusToken, onClose, returnFocusRef, docked, autoFocus
}: {
  conversation: AskConversation;
  /** The task's runtime and model, which answer until another is chosen. */
  defaultModel: SideQuestionModelChoice;
  models: AgentModel[];
  runtimes: AgentRuntimeState[];
  onDiscoverModels?(runtimeId: string): Promise<void>;
  threadId: string;
  /** The implementation agent is working, so answers read a snapshot taken when asked. */
  implementationActive: boolean;
  draft: string;
  onDraftChange(text: string): void;
  /** What the next question is about; cleared once it is asked. */
  subject?: AskSubject;
  onSubjectChange(subject: AskSubject | undefined): void;
  /** What the task's findings, intents and discussions are called, so a question names what it was about. */
  subjectNames: AskSubjectNames;
  /** What an answer can be used for where the panel is open: a follow-up, or the review request. */
  answerAction: { label: string; onUse(text: string): void };
  /** Changes when the person asks from elsewhere, such as a finding, so the field takes focus. */
  focusToken?: number;
  onClose(): void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  docked?: boolean;
  autoFocus?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState(defaultModel);
  const chosenModel = models.find((model) => model.runtimeId === choice.runtimeId && model.model === choice.model);
  const unavailable = runtimeExecutionUnavailableReason(
    runtimes.find((runtime) => runtime.preflight.runtime.id === choice.runtimeId), 'SIDE_QUESTION'
  );
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
  const unattached = unattachedInstructions(questions, runs);
  const placeholder = askPlaceholder(subject);

  return (
    <ConversationPanel
      title="Ask"
      label="Ask about the task"
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      docked={docked}
      autoFocus={autoFocus}
      focusToken={focusToken}
      tools={
        <AgentModelSelector
          label="Ask model"
          presentation="compact"
          runtimeId={choice.runtimeId}
          modelId={chosenModel?.id ?? ''}
          fallbackSummary={choice.model}
          reasoningEffort={choice.reasoningEffort ?? ''}
          models={models}
          runtimes={runtimes}
          disabled={Boolean(active)}
          showSelectionError={false}
          showRuntimeLabel={false}
          onDiscoverModels={onDiscoverModels}
          onSelectionChange={(runtimeId, modelId) => {
            const next = models.find((candidate) => candidate.id === modelId && candidate.runtimeId === runtimeId);
            setChoice({ runtimeId, model: next?.model, modelProvider: next?.modelProvider, reasoningEffort: next?.defaultReasoningEffort });
          }}
          onReasoningEffortChange={(reasoningEffort) => setChoice({ ...choice, reasoningEffort: reasoningEffort || undefined })}
        />
      }
      composer={{
        placeholder,
        hint: unavailable ?? '',
        disabled: Boolean(active || unavailable),
        draft,
        onDraftChange,
        onSubmit: async (text) => {
          await conversation.ask({ threadId, text, messageId: crypto.randomUUID(), model: choice, ...(subject ? { subject } : {}) });
          onSubjectChange(undefined);
        },
        secondary: active && canStopTaskRun(active)
          ? { label: 'Stop', disabled: busy || active.status === 'INTERRUPTING', onClick: async () => {
              setBusy(true);
              try { await conversation.stop(active.id); } finally { setBusy(false); }
            } }
          : undefined,
        above: subject ? (
          <div className="tm-ask__subject">
            <CornerUpLeft size={13} aria-hidden="true" />
            <span>{askSubjectLabel(subject, subjectNames)}</span>
            <Tooltip label="Ask about the whole task instead">
              <button type="button" className="tm-iconbtn" aria-label="Ask about the whole task instead" onClick={() => onSubjectChange(undefined)}>
                <X size={13} aria-hidden="true" />
              </button>
            </Tooltip>
          </div>
        ) : undefined
      }}
    >
      {turns.map((turn) => {
        const question = questions.find((candidate) => candidate.id === turn.opener?.key);
        const answer = turn.state === 'completed' ? sideQuestionFollowUp(turn) : undefined;
        const snapshot = sideQuestionSnapshotNote(question);
        return (
          <div key={turn.key} className="tm-side-conversation__exchange">
            {question?.subject ? <p className="tm-ask__about">{askSubjectLabel(question.subject, subjectNames)}</p> : null}
            <Turn turn={turn} onReadArtifact={conversation.readArtifact} />
            {snapshot ? <p className="tm-side-conversation__note">{snapshot}</p> : null}
            {answer ? (
              <button type="button" className="ghost-button" onClick={() => answerAction.onUse(answer)}>
                <CornerDownLeft size={13} aria-hidden="true" />
                {answerAction.label}
              </button>
            ) : null}
          </div>
        );
      })}
      <UnattachedMessages instructions={unattached} />
      {active && (active.status === 'QUEUED' || active.status === 'STARTING' || !turns.at(-1)?.entries.length) ? (
        <WorkingLine label={active.status === 'INTERRUPTING' ? 'Stopping…' : implementationActive ? 'Reading a snapshot…' : 'Reading the task…'} since={active.startedAt} />
      ) : null}
    </ConversationPanel>
  );
}
