import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import {
  PULL_REQUEST_TITLE_MAX_LENGTH,
  type ExistingWorktree,
  type WorktreeRecord
} from '../../shared/contracts';
import {
  markDoneModalCopy,
  type FinishEvidenceState,
  type FinishRequirement
} from '../model/taskFinish';
import { useDialogFocusBoundary } from './dialogFocus';

export function ExistingWorkModal({
  mode, worktree, onListCheckouts, onSubmit, onCancel, fallbackReturnFocusRef
}: {
  mode: 'instruction' | 'comparison' | 'reconnect';
  worktree: WorktreeRecord;
  onListCheckouts(repositoryId: string): Promise<ExistingWorktree[]>;
  onSubmit(value: string): Promise<void>;
  onCancel(): void;
  fallbackReturnFocusRef: RefObject<HTMLElement | null>;
}) {
  // Work opened from a pull request runs in Task Monki's own copy; only an imported checkout is the person's own.
  const imported = worktree.ownership === 'EXTERNAL';
  const [value, setValue] = useState(mode === 'comparison' ? worktree.baseRef ?? '' : '');
  const [checkouts, setCheckouts] = useState<ExistingWorktree[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const panelRef = useRef<HTMLFormElement>(null);
  const submitting = useRef(false);
  useDialogFocusBoundary({ dialogRef: panelRef, fallbackReturnFocusRef, busy, onClose: onCancel });
  useEffect(() => {
    if (mode !== 'reconnect') return;
    let canceled = false;
    void onListCheckouts(worktree.repositoryId).then(
      (items) => { if (!canceled) setCheckouts(items); },
      (caught: unknown) => {
        if (!canceled) setError(caught instanceof Error ? caught.message : 'Could not list checkouts.');
      }
    );
    return () => { canceled = true; };
  }, [mode, onListCheckouts, worktree.repositoryId]);
  const label = mode === 'instruction' ? 'Start implementation' : mode === 'comparison' ? 'Change comparison' : 'Reconnect checkout';
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!value.trim() || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await onSubmit(value.trim());
      onCancel();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update this task.');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="tm-modal" role="dialog" aria-modal="true" aria-labelledby="existing-work-title">
      <div className="tm-modal__scrim" onClick={busy ? undefined : onCancel} />
      <form ref={panelRef} className="tm-modal__panel" tabIndex={-1} onSubmit={(event) => void submit(event)}>
        <h3 id="existing-work-title">{label}</h3>
        <div>
          {mode === 'instruction' ? (
            <label className="field"><span id="checkout-instruction-label">What should the agent do?</span>
              <textarea aria-labelledby="checkout-instruction-label"
                aria-describedby={imported ? 'checkout-instruction-help' : undefined}
                value={value} disabled={busy} onChange={(event) => setValue(event.target.value)} />
              {imported ? <small id="checkout-instruction-help">The agent will edit your original imported checkout.</small> : null}
            </label>
          ) : mode === 'comparison' ? (
            <label className="field"><span id="checkout-comparison-label">Compare against</span>
              <input aria-labelledby="checkout-comparison-label" aria-describedby="checkout-comparison-help"
                value={value} disabled={busy} placeholder="Branch, commit, or HEAD" onChange={(event) => setValue(event.target.value)} />
              <small id="checkout-comparison-help">A new comparison refreshes the diff and makes the previous review stale.</small>
            </label>
          ) : (
            <label className="field"><span id="checkout-reconnect-label">Checkout for {worktree.branchName}</span>
              <select aria-labelledby="checkout-reconnect-label" aria-describedby="checkout-reconnect-help"
                value={value} disabled={busy || !checkouts} onChange={(event) => setValue(event.target.value)}>
                <option value="">{checkouts ? 'Select a checkout' : 'Loading checkouts…'}</option>
                {checkouts?.filter((item) => item.branchName === worktree.branchName).map((item) => (
                  <option key={item.worktreePath} value={item.worktreePath} disabled={Boolean(item.unavailableReason)}>
                    {item.worktreePath}{item.unavailableReason ? ` — ${item.unavailableReason}` : ''}
                  </option>
                ))}
              </select>
              <small id="checkout-reconnect-help">Only a registered checkout in the same repository and branch can reconnect.</small>
            </label>
          )}
        </div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="tm-modal__actions">
          <button type="button" className="outline-button" disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary-button" disabled={busy || !value.trim()}>{busy ? 'Working…' : label}</button>
        </div>
      </form>
    </div>
  );
}

export function CreateDraftPrModal({
  noun,
  title,
  worktree,
  issueNumber,
  busy,
  disabled,
  disabledReason,
  onTitleChange,
  onCancel,
  onSubmit,
  fallbackReturnFocusRef
}: {
  /** PR on GitHub, MR on GitLab. */
  noun: 'PR' | 'MR';
  title: string;
  worktree?: WorktreeRecord;
  /** The issue the task was opened from, as the description writes it: `#42`. */
  issueNumber?: string;
  busy: boolean;
  disabled: boolean;
  disabledReason?: string;
  onTitleChange(value: string): void;
  onCancel(): void;
  onSubmit(baseBranch?: string, closeIssue?: boolean): Promise<void>;
  fallbackReturnFocusRef: RefObject<HTMLElement | null>;
}) {
  const cleanTitle = title.replace(/\s+/g, ' ').trim();
  const [baseBranch, setBaseBranch] = useState('');
  const [closeIssue, setCloseIssue] = useState(true);
  const [error, setError] = useState<string>();
  const external = worktree?.ownership === 'EXTERNAL';
  const confirmDisabled = busy || disabled || !cleanTitle || (external && !baseBranch.trim());
  const panelRef = useRef<HTMLFormElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  useDialogFocusBoundary({
    dialogRef: panelRef,
    initialFocusRef: titleInputRef,
    fallbackReturnFocusRef,
    busy,
    onClose: onCancel
  });
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!confirmDisabled) {
      setError(undefined);
      try {
        await onSubmit(external ? baseBranch.trim() : undefined, issueNumber ? closeIssue : undefined);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not create the pull request.');
      }
    }
  };

  return (
    <div className="tm-modal" role="dialog" aria-modal="true" aria-labelledby="draft-pr-title">
      <div className="tm-modal__scrim" onClick={busy ? undefined : onCancel} />
      <form
        ref={panelRef}
        className="tm-modal__panel tm-draftpr-modal"
        tabIndex={-1}
        onSubmit={(event) => void submit(event)}
      >
        <h3 id="draft-pr-title">Create draft {noun}</h3>
        <p>Review the title before Task Monki opens the draft {noun === 'MR' ? 'merge request' : 'pull request'}.</p>

        <label className="field tm-draftpr-modal__field">
          <span className="field__label">{noun} title</span>
          <input
            ref={titleInputRef}
            type="text"
            value={title}
            maxLength={PULL_REQUEST_TITLE_MAX_LENGTH}
            disabled={busy}
            onChange={(event) => onTitleChange(event.target.value)}
          />
          {/* The count matters only near the limit. */}
          {cleanTitle.length > PULL_REQUEST_TITLE_MAX_LENGTH * 0.8 ? <small>{cleanTitle.length} / {PULL_REQUEST_TITLE_MAX_LENGTH}</small> : null}
        </label>

        {/* The keyword is all Task Monki writes; the platform closes the issue when the change merges into the default branch. */}
        {issueNumber ? (
          <label className="tm-modal__check">
            <input type="checkbox" checked={closeIssue} disabled={busy} onChange={(event) => setCloseIssue(event.target.checked)} />
            <span>Add “Closes {issueNumber}” to the description</span>
          </label>
        ) : null}

        {external ? (
          <label className="field tm-draftpr-modal__field">
            <span className="field__label" id="pr-target-label">Target branch</span>
            <input aria-labelledby="pr-target-label" aria-describedby="pr-target-help"
              value={baseBranch} disabled={busy} placeholder="main"
              onChange={(event) => setBaseBranch(event.target.value)} />
            <small id="pr-target-help">Branch to merge into.</small>
          </label>
        ) : null}

        {worktree ? (
          <div className="tm-draftpr-modal__context">
            <div>
              <span>Head</span>
              <strong>{worktree.branchName}</strong>
            </div>
            {!external ? <div>
              <span>Base</span>
              <strong>{worktree.baseRef ?? 'main'}</strong>
            </div> : null}
          </div>
        ) : null}

        {disabled && disabledReason ? <p className="form-warning">{disabledReason}</p> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}

        <div className="tm-modal__actions">
          <button type="button" className="outline-button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={confirmDisabled}>
            {busy ? 'Creating…' : `Create draft ${noun}`}
          </button>
        </div>
      </form>
    </div>
  );
}

export function MarkDoneModal({
  withIssues,
  warnings,
  hasPullRequest,
  requirements,
  busy,
  onCancel,
  onConfirm,
  fallbackReturnFocusRef
}: {
  withIssues: boolean;
  warnings: FinishEvidenceState['warnings'];
  hasPullRequest: boolean;
  requirements: FinishRequirement[];
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
  fallbackReturnFocusRef: RefObject<HTMLElement | null>;
}) {
  const copy = markDoneModalCopy(withIssues, busy, { hasPullRequest });
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useDialogFocusBoundary({
    dialogRef: panelRef,
    initialFocusRef: cancelRef,
    fallbackReturnFocusRef,
    busy,
    onClose: onCancel
  });
  return (
    <div className="tm-modal" role="dialog" aria-modal="true" aria-labelledby="mark-done-title">
      <div className="tm-modal__scrim" onClick={busy ? undefined : onCancel} />
      <div ref={panelRef} className="tm-modal__panel" tabIndex={-1}>
        <h3 id="mark-done-title">{copy.title}</h3>
        <p>{copy.body}</p>
        {withIssues && requirements.length > 0 ? (
          <ul className="tm-modal__requirements" aria-label="Unresolved">
            {requirements.map((requirement) => (
              <li
                className={`tm-modal__requirement tm-modal__requirement--${requirement.tone}`}
                key={requirement.label}
              >
                {requirement.fact}
              </li>
            ))}
          </ul>
        ) : null}
        {withIssues && requirements.length === 0 ? (
          <div className="tm-modal__warning">
            <strong>{copy.fallbackWarningTitle}</strong>
            <span>{warnings[0]?.detail ?? copy.fallbackWarningDetail}</span>
          </div>
        ) : null}
        <div className="tm-modal__actions">
          <button
            ref={cancelRef}
            type="button"
            className="outline-button"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button type="button" className="primary-button" disabled={busy} onClick={onConfirm}>
            {copy.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
