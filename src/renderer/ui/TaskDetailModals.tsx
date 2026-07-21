import { useRef, type FormEvent, type RefObject } from 'react';
import {
  PULL_REQUEST_TITLE_MAX_LENGTH,
  type AgentReviewFinding,
  type Task,
  type WorktreeRecord
} from '../../shared/contracts';
import type { FinishEvidenceState, FinishRequirement } from '../model/taskFinish';
import { findingLevel, shortFindingRef } from '../model/findings';
import { formatShortId } from '../model/selectors';
import { markDoneModalCopy } from '../model/taskView';
import { FindingRow } from './Findings';
import { useDialogFocusBoundary } from './dialogFocus';

export function CreateDraftPrModal({
  title,
  worktree,
  busy,
  disabled,
  disabledReason,
  onTitleChange,
  onCancel,
  onSubmit,
  fallbackReturnFocusRef
}: {
  title: string;
  worktree?: WorktreeRecord;
  busy: boolean;
  disabled: boolean;
  disabledReason?: string;
  onTitleChange(value: string): void;
  onCancel(): void;
  onSubmit(): void;
  fallbackReturnFocusRef: RefObject<HTMLElement | null>;
}) {
  const cleanTitle = title.replace(/\s+/g, ' ').trim();
  const confirmDisabled = busy || disabled || !cleanTitle;
  const panelRef = useRef<HTMLFormElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  useDialogFocusBoundary({
    dialogRef: panelRef,
    initialFocusRef: titleInputRef,
    fallbackReturnFocusRef,
    busy,
    onClose: onCancel
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!confirmDisabled) {
      onSubmit();
    }
  };

  return (
    <div className="tm-modal" role="dialog" aria-modal="true" aria-labelledby="draft-pr-title">
      <div className="tm-modal__scrim" onClick={busy ? undefined : onCancel} />
      <form
        ref={panelRef}
        className="tm-modal__panel tm-draftpr-modal"
        tabIndex={-1}
        onSubmit={submit}
      >
        <h3 id="draft-pr-title">Create draft PR</h3>
        <p>Review the title before Task Monki opens the draft pull request.</p>

        <label className="field tm-draftpr-modal__field">
          <span className="field__label">PR title</span>
          <input
            ref={titleInputRef}
            type="text"
            value={title}
            maxLength={PULL_REQUEST_TITLE_MAX_LENGTH}
            disabled={busy}
            onChange={(event) => onTitleChange(event.target.value)}
          />
          <small>{cleanTitle.length} / {PULL_REQUEST_TITLE_MAX_LENGTH}</small>
        </label>

        {worktree ? (
          <div className="tm-draftpr-modal__context">
            <div>
              <span>Head</span>
              <strong>{worktree.branchName}</strong>
            </div>
            <div>
              <span>Base</span>
              <strong>{worktree.baseRef ?? 'main'}</strong>
            </div>
          </div>
        ) : null}

        {disabled && disabledReason ? <p className="form-warning">{disabledReason}</p> : null}

        <div className="tm-modal__actions">
          <button type="button" className="outline-button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={confirmDisabled}>
            {busy ? 'Creating...' : 'Create draft PR'}
          </button>
        </div>
      </form>
    </div>
  );
}

export function ReviewRequestDrawer({
  task,
  findings,
  selectedFindingIds,
  note,
  instruction,
  busy,
  onToggleFinding,
  onNoteChange,
  onInstructionChange,
  onCancel,
  onSubmit,
  fallbackReturnFocusRef
}: {
  task: Task;
  findings: AgentReviewFinding[];
  selectedFindingIds: string[];
  note: string;
  instruction: string;
  busy: boolean;
  onToggleFinding(findingId: string): void;
  onNoteChange(value: string): void;
  onInstructionChange(value: string): void;
  onCancel(): void;
  onSubmit(): void;
  fallbackReturnFocusRef: RefObject<HTMLElement | null>;
}) {
  const selectedCount = selectedFindingIds.length;
  const panelRef = useRef<HTMLElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  useDialogFocusBoundary({
    dialogRef: panelRef,
    initialFocusRef: noteRef,
    fallbackReturnFocusRef,
    busy,
    onClose: onCancel
  });
  return (
    <div className="tm-reviewdrawer" role="dialog" aria-modal="true" aria-label="Request changes">
      <div className="tm-reviewdrawer__scrim" onClick={busy ? undefined : onCancel} />
      <aside ref={panelRef} className="tm-reviewdrawer__panel" tabIndex={-1}>
        <header className="tm-reviewdrawer__header">
          <div>
            <h3>Request changes</h3>
            <p>Start a follow-up run with the selected findings for #{formatShortId(task.id)}.</p>
          </div>
          <button
            type="button"
            className="tm-reviewdrawer__close"
            disabled={busy}
            aria-label="Close request changes"
            onClick={onCancel}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className="tm-reviewdrawer__body" inert={busy ? true : undefined}>
          <section className="tm-reviewdrawer__section">
            <h4>Findings to attach · {selectedCount} selected</h4>
            {findings.length > 0 ? (
              <div className="tm-reviewdrawer__findings tm-reviewfindings__list">
                {findings.map((finding) => {
                  const level = findingLevel(finding.severity);
                  return (
                    <FindingRow
                      key={finding.id}
                      tone={level.tone}
                      severityLabel={level.label}
                      title={finding.title}
                      reference={shortFindingRef(finding)}
                      selection={{
                        checked: selectedFindingIds.includes(finding.id),
                        onToggle: () => onToggleFinding(finding.id)
                      }}
                    />
                  );
                })}
              </div>
            ) : (
              <p className="tm-reviewdrawer__empty">
                No structured findings were returned. The instruction includes the review summary.
              </p>
            )}
          </section>

          <label className="tm-reviewdrawer__section">
            <h4>Optional note</h4>
            <textarea
              ref={noteRef}
              className="tm-reviewdrawer__note"
              value={note}
              disabled={busy}
              placeholder="Add context for the follow-up"
              onChange={(event) => onNoteChange(event.target.value)}
              rows={3}
            />
          </label>

          <details className="tm-reviewdrawer__instruction">
            <summary>Full instruction</summary>
            <label>
              <span>Instruction to agent</span>
              <textarea
                value={instruction}
                disabled={busy}
                onChange={(event) => onInstructionChange(event.target.value)}
                rows={11}
              />
              <small>Generated from the selected findings and optional note. Editable.</small>
            </label>
          </details>
        </div>

        <footer className="tm-reviewdrawer__footer">
          <span>Returns to Review when the follow-up finishes.</span>
          <div>
            <button type="button" className="outline-button" disabled={busy} onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={busy || !instruction.trim()}
              onClick={onSubmit}
            >
              {busy ? 'Sending...' : 'Send to agent'}
            </button>
          </div>
        </footer>
      </aside>
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
          <div className="tm-modal__requirements">
            <div className="tm-modal__requirements-title">Unresolved</div>
            {requirements.map((requirement) => (
              <div
                className={`tm-modal__requirement tm-modal__requirement--${requirement.tone}`}
                key={requirement.label}
              >
                <span className="tm-modal__requirement-dot" aria-hidden="true" />
                <span>
                  <strong>{requirement.label}</strong> — {requirement.detail}
                </span>
              </div>
            ))}
          </div>
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
