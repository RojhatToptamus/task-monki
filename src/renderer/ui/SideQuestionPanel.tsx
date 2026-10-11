import { useMemo, useState, type RefObject } from 'react';
import { CornerDownLeft } from 'lucide-react';
import type { AgentModel, AgentRuntimeState, SideQuestionModelChoice } from '../../shared/contracts';
import type { AgentConversationRecords } from '../model/agentRecords';
import { runtimeExecutionUnavailableReason } from '../model/runtimeReadiness';
import { AgentModelSelector } from './AgentModelSelector';
import { isActiveRunStatus } from '../model/agentSession';
import { sideQuestionFollowUp, sideQuestionSnapshotNote, sideThreadQuestions } from '../model/sideQuestions';
import { canStopTaskRun } from '../model/runProgress';
import { ConversationPanel } from './ConversationPanel';
import { Turn, UnattachedMessages, unattachedInstructions, useSessionTurns, WorkingLine } from './SessionTurns';

export interface SideConversation {
  records: AgentConversationRecords;
  /** Where a new thread's model starts: the Settings default for side questions. */
  defaultModel?: SideQuestionModelChoice;
  ask(input: { threadId: string; text: string; messageId: string; model?: SideQuestionModelChoice }): Promise<void>;
  stop(runId: string): Promise<void>;
  /** Ends the thread: its read-only snapshot is removed; its runs stay in Debug. */
  end(threadId: string): Promise<void>;
  readArtifact?(id: string): Promise<string>;
}

/**
 * A side question about the task: asked of a fresh read-only session on the model
 * chosen here, the task's own by default, so the implementation keeps working.
 * Nothing here reaches the main conversation unless the person uses an answer in a
 * follow-up. While the agent works, questions read a snapshot of the worktree.
 */
export function SideQuestionPanel({ conversation, defaultModel, models, runtimes, onDiscoverModels, threadId, implementationActive, draft, onDraftChange, onUseInFollowUp, onClose, returnFocusRef, docked, autoFocus }: {
  conversation: SideConversation;
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
  onUseInFollowUp(text: string): void;
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

  return (
    <ConversationPanel
      title="Side question"
      label="Side question"
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      docked={docked}
      autoFocus={autoFocus}
      tools={
        <AgentModelSelector
          label="Side question model"
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
        placeholder: 'Ask about the work',
        hint: unavailable ?? '',
        disabled: Boolean(active || unavailable),
        draft,
        onDraftChange,
        onSubmit: (text) => conversation.ask({ threadId, text, messageId: crypto.randomUUID(), model: choice }),
        secondary: active && canStopTaskRun(active)
          ? { label: 'Stop', disabled: busy || active.status === 'INTERRUPTING', onClick: async () => {
              setBusy(true);
              try { await conversation.stop(active.id); } finally { setBusy(false); }
            } }
          : undefined
      }}
    >
      {turns.map((turn) => {
        const followUp = turn.state === 'completed' ? sideQuestionFollowUp(turn) : undefined;
        const snapshot = sideQuestionSnapshotNote(questions.find((question) => question.id === turn.opener?.key));
        return (
          <div key={turn.key} className="tm-side-conversation__exchange">
            <Turn turn={turn} onReadArtifact={conversation.readArtifact} />
            {snapshot ? <p className="tm-side-conversation__note">{snapshot}</p> : null}
            {followUp ? (
              <button type="button" className="ghost-button" onClick={() => onUseInFollowUp(followUp)}>
                <CornerDownLeft size={13} aria-hidden="true" />
                Use in follow-up
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
