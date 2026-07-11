import { useState } from 'react';
import type {
  AgentRetryStrategy,
  InteractionRequestRecord,
  RunRecord
} from '../../shared/contracts';
import {
  getAgentComposerCopy,
  getPostRunActionState,
  type AgentComposerMode
} from '../model/postRunActions';
import { humanizeEnum } from './display';

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
}

export function AgentControlPanel({
  run,
  interactions,
  onSteer,
  onInterrupt,
  onContinue,
  onRetry
}: AgentControlPanelProps) {
  const [mode, setMode] = useState<AgentComposerMode>();
  const [instruction, setInstruction] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!run || run.mode === 'REVIEW') {
    return null;
  }

  const isRunning = run.status === 'RUNNING';
  const { canFollowUp, canContinue, canRetry, continuationLabel, continuationKind } =
    getPostRunActionState(run);
  const composerCopy = mode ? getAgentComposerCopy(mode, continuationKind) : undefined;
  const staleInteractions = interactions.filter((interaction) =>
    ['STALE', 'ABORTED_SERVER_LOST'].includes(interaction.status)
  );
  const recoveryVisible =
    run.status === 'RECOVERY_REQUIRED' ||
    run.status === 'LOST' ||
    run.recoveryState === 'REQUIRES_USER_ACTION' ||
    run.recoveryState === 'UNRECOVERABLE';
  const hasAvailableControls =
    isRunning || canFollowUp || canContinue || canRetry || recoveryVisible || staleInteractions.length > 0;

  if (!hasAvailableControls) {
    return null;
  }

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
    <section className="card agent-controls" aria-label="Agent">
      <div className="card__header">
        <div>
          <h3>Agent</h3>
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
        {run.status === 'RECOVERY_REQUIRED' ? (
          <div className="agent-controls__button-row">
            <button
              type="button"
              className="outline-button outline-button--danger"
              disabled={submitting}
              onClick={() => void onInterrupt(run.id)}
            >
              Abandon recovery
            </button>
          </div>
        ) : null}
        {isRunning ? (
          <div className="agent-controls__button-row">
            <button
              type="button"
              className={actionButtonClass('outline-button', mode === 'STEER')}
              aria-pressed={mode === 'STEER'}
              onClick={() => setMode('STEER')}
            >
              Add instruction
            </button>
            <button
              type="button"
              className="outline-button outline-button--danger"
              onClick={() => void onInterrupt(run.id)}
            >
              Stop run
            </button>
          </div>
        ) : null}

        {canFollowUp || (canRetry && !canContinue) ? (
          <div className="agent-controls__button-row">
            {canFollowUp ? (
              <button
                type="button"
                className={actionButtonClass('outline-button', mode === 'CONTINUE')}
                aria-pressed={mode === 'CONTINUE'}
                onClick={() => setMode('CONTINUE')}
              >
                {continuationLabel}
              </button>
            ) : null}
            {canRetry ? (
              <>
                <button
                  type="button"
                  className={actionButtonClass('outline-button', mode === 'RETRY_SAME')}
                  aria-pressed={mode === 'RETRY_SAME'}
                  onClick={() => setMode('RETRY_SAME')}
                >
                  Retry in session
                </button>
                <button
                  type="button"
                  className={actionButtonClass('outline-button', mode === 'RETRY_FORK')}
                  aria-pressed={mode === 'RETRY_FORK'}
                  onClick={() => setMode('RETRY_FORK')}
                >
                  Fork alternative
                </button>
              </>
            ) : null}
          </div>
        ) : null}

        {canContinue ? (
          <div className="agent-controls__group agent-controls__group--recovery">
            <div className="agent-controls__group-copy">
              <strong>Unfinished work</strong>
              <span>Continues from the current worktree state.</span>
            </div>
            <div className="agent-controls__button-row">
              <button
                type="button"
                className={actionButtonClass('outline-button', mode === 'CONTINUE')}
                aria-pressed={mode === 'CONTINUE'}
                onClick={() => setMode('CONTINUE')}
              >
                {continuationLabel}
              </button>
              {canRetry ? (
                <>
                  <button
                    type="button"
                    className={actionButtonClass('outline-button', mode === 'RETRY_SAME')}
                    aria-pressed={mode === 'RETRY_SAME'}
                    onClick={() => setMode('RETRY_SAME')}
                  >
                    Retry in session
                  </button>
                  <button
                    type="button"
                    className={actionButtonClass('outline-button', mode === 'RETRY_FORK')}
                    aria-pressed={mode === 'RETRY_FORK'}
                    onClick={() => setMode('RETRY_FORK')}
                  >
                    Fork alternative
                  </button>
                </>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {mode && composerCopy ? (
        <div className="agent-controls__composer">
          <div className="agent-controls__composer-head">
            <strong>{composerCopy.title}</strong>
            {composerCopy.helperText ? <span>{composerCopy.helperText}</span> : null}
          </div>
          <label htmlFor={`agent-control-${run.id}`}>{composerCopy.fieldLabel}</label>
          <textarea
            id={`agent-control-${run.id}`}
            rows={4}
            value={instruction}
            autoFocus
            onChange={(event) => setInstruction(event.target.value)}
            placeholder={composerCopy.placeholder}
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
              {submitting ? 'Submitting...' : composerCopy.submitLabel}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function actionButtonClass(baseClass: string, active: boolean): string {
  return active ? `${baseClass} agent-controls__action--active` : baseClass;
}
