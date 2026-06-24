import { useState } from 'react';
import type {
  AgentRetryStrategy,
  InteractionRequestRecord,
  RunRecord
} from '../../shared/contracts';
import { humanizeEnum } from './display';

type ComposerMode = 'STEER' | 'CONTINUE' | 'RETRY_SAME' | 'RETRY_FORK';

interface AgentControlPanelProps {
  run?: RunRecord;
  interactions: InteractionRequestRecord[];
  onSteer(runId: string, instruction: string): Promise<void>;
  onInterrupt(runId: string): Promise<void>;
  onContinue(runId: string, instruction?: string): Promise<void>;
  onRetry(
    runId: string,
    strategy: AgentRetryStrategy,
    instruction?: string
  ): Promise<void>;
  onReview(runId: string): Promise<void>;
}

const TERMINAL_OR_RECOVERY = new Set<RunRecord['status']>([
  'COMPLETED',
  'FAILED',
  'INTERRUPTED',
  'RECOVERY_REQUIRED',
  'LOST'
]);

export function AgentControlPanel({
  run,
  interactions,
  onSteer,
  onInterrupt,
  onContinue,
  onRetry,
  onReview
}: AgentControlPanelProps) {
  const [mode, setMode] = useState<ComposerMode>();
  const [instruction, setInstruction] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!run) {
    return null;
  }

  const isRunning = run.status === 'RUNNING';
  const canFollowUp = TERMINAL_OR_RECOVERY.has(run.status);
  const staleInteractions = interactions.filter((interaction) =>
    ['STALE', 'ABORTED_SERVER_LOST'].includes(interaction.status)
  );
  const recoveryVisible =
    run.status === 'RECOVERY_REQUIRED' ||
    run.status === 'LOST' ||
    run.recoveryState === 'REQUIRES_USER_ACTION' ||
    run.recoveryState === 'UNRECOVERABLE';

  const submit = async () => {
    if (!mode) {
      return;
    }
    const value = instruction.trim();
    if (mode === 'STEER' && !value) {
      return;
    }
    setSubmitting(true);
    try {
      if (mode === 'STEER') {
        await onSteer(run.id, value);
      } else if (mode === 'CONTINUE') {
        await onContinue(run.id, value || undefined);
      } else {
        await onRetry(
          run.id,
          mode === 'RETRY_FORK' ? 'FORK' : 'SAME_SESSION',
          value || undefined
        );
      }
      setInstruction('');
      setMode(undefined);
    } catch {
      // The application shell presents the operation error and keeps this
      // composer open so the user can adjust the instruction.
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="card agent-controls" aria-label="Agent controls">
      <div className="card__header">
        <div>
          <h3>Agent controls</h3>
          <p className="agent-controls__subtitle">
            Turn {run.providerTurnId ?? 'not confirmed'} · {humanizeEnum(run.status)}
          </p>
        </div>
      </div>

      {recoveryVisible ? (
        <div className="recovery-banner" role="status">
          <strong>Recovery requires review</strong>
          <span>
            {run.terminalReason ??
              'The prior runtime could not prove the final turn state. Git evidence was refreshed independently.'}
          </span>
          <span>
            Task Monki does not automatically resubmit ambiguous provider mutations.
          </span>
        </div>
      ) : null}

      {staleInteractions.length > 0 ? (
        <div className="recovery-banner recovery-banner--muted">
          <strong>Prior requests are closed</strong>
          <span>
            {staleInteractions.length} approval or input request
            {staleInteractions.length === 1 ? ' is' : 's are'} stale or aborted and
            cannot be answered.
          </span>
        </div>
      ) : null}

      <div className="agent-controls__actions">
        {isRunning ? (
          <>
            <button type="button" className="outline-button" onClick={() => setMode('STEER')}>
              Add instruction
            </button>
            <button
              type="button"
              className="outline-button outline-button--danger"
              onClick={() => void onInterrupt(run.id)}
            >
              Interrupt turn
            </button>
          </>
        ) : null}
        {canFollowUp ? (
          <>
            <button type="button" className="primary-button" onClick={() => setMode('CONTINUE')}>
              Continue
            </button>
            <details className="agent-controls__more">
              <summary>More actions</summary>
              <div className="agent-controls__more-menu">
                <button
                  type="button"
                  className="outline-button"
                  onClick={(event) => {
                    closeParentDetails(event.currentTarget);
                    setMode('RETRY_SAME');
                  }}
                >
                  Retry in session
                </button>
                <button
                  type="button"
                  className="outline-button"
                  onClick={(event) => {
                    closeParentDetails(event.currentTarget);
                    setMode('RETRY_FORK');
                  }}
                >
                  Fork alternative
                </button>
                <button
                  type="button"
                  className="outline-button"
                  onClick={(event) => {
                    closeParentDetails(event.currentTarget);
                    void onReview(run.id);
                  }}
                >
                  Review changes
                </button>
              </div>
            </details>
          </>
        ) : null}
      </div>

      {mode ? (
        <div className="agent-controls__composer">
          <label htmlFor={`agent-control-${run.id}`}>
            {mode === 'STEER' ? 'Instruction for the active turn' : 'Optional follow-up instruction'}
          </label>
          <textarea
            id={`agent-control-${run.id}`}
            rows={4}
            value={instruction}
            autoFocus
            onChange={(event) => setInstruction(event.target.value)}
            placeholder={placeholderFor(mode)}
          />
          <div className="agent-controls__composer-actions">
            <button
              type="button"
              className="outline-button"
              disabled={submitting}
              onClick={() => {
                setMode(undefined);
                setInstruction('');
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={submitting || (mode === 'STEER' && !instruction.trim())}
              onClick={() => void submit()}
            >
              {submitting ? 'Submitting…' : submitLabel(mode)}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function closeParentDetails(element: HTMLElement): void {
  element.closest('details')?.removeAttribute('open');
}

function placeholderFor(mode: ComposerMode): string {
  if (mode === 'STEER') {
    return 'Example: Focus on the failing tests before changing more files.';
  }
  if (mode === 'RETRY_FORK') {
    return 'Describe the alternative approach for the forked session.';
  }
  return 'Add context or constraints for the next turn.';
}

function submitLabel(mode: ComposerMode): string {
  switch (mode) {
    case 'STEER':
      return 'Send instruction';
    case 'CONTINUE':
      return 'Start continuation';
    case 'RETRY_SAME':
      return 'Retry in session';
    case 'RETRY_FORK':
      return 'Fork and retry';
  }
}
