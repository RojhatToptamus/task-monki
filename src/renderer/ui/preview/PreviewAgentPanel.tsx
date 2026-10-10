import { useMemo, useState, type RefObject } from 'react';
import { Pencil } from 'lucide-react';
import type { PreviewRecipeGenerationDraft, TaskInstruction } from '../../../shared/contracts';
import { isActiveRunStatus } from '../../model/agentSession';
import { proposalSummary } from '../../model/previewAgentRequests';
import { previewAgentUnavailableReason, type PreviewAgentSelection } from '../../model/previewAgentSelection';
import { canStopTaskRun } from '../../model/runProgress';
import { AgentModelSelector } from '../AgentModelSelector';
import { ConversationPanel } from '../ConversationPanel';
import { InteractionPanel } from '../InteractionPanel';
import { MessageQueue } from '../MessageQueue';
import { Elapsed, Turn, UserMessage, useSessionTurns } from '../SessionTurns';
import { StatusGlyph } from '../StatusBadge';
import type { PreviewAgentConversation } from './PreviewAgentProps';

/**
 * The Preview conversation: the same turns, steps, questions and queue as the task agent, on a
 * detached read-only session the person can point at any runtime and model. Every change the
 * agent wants comes back as a proposal. Chat and Configuration use the same save and review
 * flow; approval stays in the Preview controls.
 */
export function PreviewAgentPanel({ agent, selection, onSelectionChange, proposal, worktreePath, draft, onDraftChange, onReviewProposal, onSaveAndReview, savingProposal, onClose, returnFocusRef, docked, autoFocus }: {
  agent: PreviewAgentConversation;
  selection: PreviewAgentSelection;
  onSelectionChange(selection: PreviewAgentSelection): void;
  proposal?: PreviewRecipeGenerationDraft;
  worktreePath?: string;
  draft: string;
  onDraftChange(text: string): void;
  onReviewProposal(): void;
  onSaveAndReview(): void;
  savingProposal: boolean;
  onClose(): void;
  /** The control that toggles the panel. */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** Beside the Preview rather than over it; see ConversationPanel. */
  docked?: boolean;
  autoFocus?: boolean;
}) {
  const [editing, setEditing] = useState<{ id: string; text: string }>();
  const [busy, setBusy] = useState(false);
  const turns = useSessionTurns({
    runs: agent.runs, items: agent.items, instructions: agent.instructions, plans: agent.plans, interactions: agent.interactions, cwd: worktreePath
  });
  const active = agent.runs.find((run) => isActiveRunStatus(run.status));
  const questionPending = agent.interactions.some((item) => ['PENDING', 'RESPONDING'].includes(item.status));
  const pending = useMemo(
    () => agent.instructions
      .filter((item) => ['QUEUED', 'HELD'].includes(item.status) || (item.status === 'FAILED' && item.runId && !agent.runs.some((run) => run.id === item.runId)))
      .sort((a, b) => a.order - b.order),
    [agent.instructions, agent.runs]
  );
  const unattached = agent.instructions.filter((item) =>
    !agent.runs.some((run) => run.id === item.runId) && (['SENDING', 'UNCERTAIN'].includes(item.status) || (item.status === 'FAILED' && !item.runId))
  );
  const lastTurn = turns.at(-1);
  const lastLiveEntry = lastTurn?.state === 'active' ? lastTurn.entries.at(-1) : undefined;
  const liveWorkVisible = lastLiveEntry?.kind === 'steps' && lastLiveEntry.steps.some((step) => (step.kind === 'reasoning' ? step.active : step.row.status === 'active'));
  const workingLabel = active?.status === 'INTERRUPTING' ? 'Stopping…'
    : active?.status === 'STARTING' || active?.status === 'QUEUED' ? 'Starting…' : 'Working…';
  const model = agent.models.find((candidate) => candidate.model === selection.model && candidate.runtimeId === selection.runtimeId && (!selection.modelProvider || candidate.modelProvider === selection.modelProvider));
  const disabledReason = agent.disabledReason ?? previewAgentUnavailableReason(selection, agent.runtimes);
  // A provider may accept aliases absent from its catalog (for example, "sonnet").
  // Execution resolution validates the requested model; catalog display cannot reject it.
  const selectionUnavailable = !agent.runtimes.some((runtime) => runtime.preflight.runtime.id === selection.runtimeId);
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  const send = (text: string) => editing
    ? act(async () => {
        await agent.editQueued(editing.id, text);
        setEditing(undefined);
      })
    : agent.send(text, crypto.randomUUID(), selection);
  return (
    <ConversationPanel
      title="Preview agent"
      label="Preview agent conversation"
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      docked={docked}
      autoFocus={autoFocus}
      tools={
        <AgentModelSelector
          label="Preview agent model"
          presentation="compact"
          runtimeId={selection.runtimeId}
          modelId={model?.id ?? ''}
          fallbackSummary={selection.model}
          reasoningEffort={selection.reasoningEffort ?? ''}
          models={agent.models}
          runtimes={agent.runtimes}
          disabled={!!active}
          selectionUnavailable={selectionUnavailable}
          showSelectionError={false}
          showRuntimeLabel={false}
          onDiscoverModels={agent.onDiscoverModels}
          onSelectionChange={(runtimeId, modelId) => {
            const next = agent.models.find((candidate) => candidate.id === modelId && candidate.runtimeId === runtimeId);
            onSelectionChange({ runtimeId, model: next?.model, modelProvider: next?.modelProvider, reasoningEffort: next?.defaultReasoningEffort });
          }}
          onReasoningEffortChange={(reasoningEffort) => onSelectionChange({ ...selection, reasoningEffort: reasoningEffort || undefined })}
        />
      }
      composer={{
        placeholder: editing ? 'Edit the queued message' : active ? 'Queue a message for after this response' : turns.length ? 'Ask for a change or an explanation…' : 'Ask about the preview or request a configuration…',
        hint: disabledReason ?? '',
        sendLabel: editing ? 'Save' : active ? 'Queue' : 'Send',
        disabled: !!disabledReason || (!editing && questionPending),
        draft: editing?.text ?? draft,
        onDraftChange: (text) => (editing ? setEditing({ ...editing, text }) : onDraftChange(text)),
        onSubmit: send,
        secondary: active && canStopTaskRun(active)
          ? { label: 'Stop', title: 'Stop the current response', disabled: busy || active.status === 'INTERRUPTING', onClick: () => act(agent.stop) }
          : undefined,
        above: (
          <>
            <MessageQueue
              items={pending.map((item) => ({ id: item.id, text: item.text, detail: item.detail, held: item.status !== 'QUEUED' }))}
              editingId={editing?.id}
              disabled={busy || !!editing}
              continueDisabledReason={disabledReason ?? (active ? 'Wait for the current response.' : undefined)}
              onContinue={(id) => void act(async () => {
                const item = pending.find((candidate) => candidate.id === id);
                if (item) await agent.send(item.text, item.id, selection);
              })}
              onEdit={(id) => {
                const item = pending.find((candidate) => candidate.id === id);
                if (item) setEditing({ id, text: item.text });
              }}
              onRemove={(id) => void act(async () => {
                await agent.editQueued(id);
                if (editing?.id === id) setEditing(undefined);
              })}
            />
            {editing ? (
              <div className="tm-agent-session__editing">
                <Pencil size={13} strokeWidth={1.25} absoluteStrokeWidth aria-hidden="true" />Editing queued message
                <button type="button" className="ghost-button" onClick={() => setEditing(undefined)} disabled={busy}>Cancel</button>
              </div>
            ) : null}
          </>
        )
      }}
    >
      {turns.length === 0 && unattached.length === 0 ? (
        <p className="tm-preview-agent__intro">
          Set up your preview, change how it runs, or investigate a failure.
        </p>
      ) : null}
      {turns.map((turn) => (
        <Turn key={turn.key} turn={turn} onReadArtifact={agent.readArtifact} />
      ))}
      {unattached.map((item) => (
        <UserMessage key={item.id} text={item.text} time={item.createdAt} status={statusLabel(item)} />
      ))}
      {active && !questionPending && (active.status === 'INTERRUPTING' || active.status === 'STARTING' || active.status === 'QUEUED' || !liveWorkVisible) ? (
        <div className="tm-side-conversation__working">
          <StatusGlyph kind="working" />
          <span role="status">{workingLabel}</span>
          <Elapsed since={active.startedAt} />
        </div>
      ) : null}
      <InteractionPanel interactions={agent.interactions} sessions={agent.sessions} onRespond={agent.respond} />
      {proposal ? (
        <div className="tm-preview-agent__proposal" role="status">
          <strong>{proposal.replacesExistingFile ? `Proposed changes to ${proposal.fileName}` : `Proposed ${proposal.fileName}`}</strong>
          {proposalSummary(proposal.yaml) ? <span>{proposalSummary(proposal.yaml)}</span> : null}
          <div className="tm-preview-agent__proposal-actions">
            <button type="button" className="ghost-button" onClick={onReviewProposal}>View changes</button>
            <button type="button" className="primary-button" disabled={savingProposal || !!active} title={active ? 'Wait for the agent to finish before saving.' : undefined} onClick={onSaveAndReview}>Save and review</button>
          </div>
        </div>
      ) : null}
    </ConversationPanel>
  );
}

function statusLabel(item: TaskInstruction): string {
  return item.status === 'SENDING' ? 'Sending…' : item.status === 'UNCERTAIN' ? 'Delivery uncertain' : 'Not sent';
}
