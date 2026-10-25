import { useId, useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useDialogFocusBoundary } from '../dialogFocus';
import { ModalFrame } from '../ModalFrame';
import { useOpenReport } from '../presence';
import { PendingLabel } from '../StableLabel';

/**
 * Confirms a bug action that cannot be undone. Keep comes first and takes focus; the confirm
 * button names the act.
 */
export function BugConfirmDialog({
  title,
  body,
  keepLabel,
  confirmLabel,
  busyLabel,
  busy,
  returnFocus,
  returnFocusRef,
  shouldReturnFocus,
  onOpenChange,
  onKeep,
  onConfirm
}: {
  title: string;
  body: string;
  keepLabel: string;
  confirmLabel: string;
  busyLabel: string;
  busy: boolean;
  /** The control that opened the dialog, where focus returns. */
  returnFocus?: HTMLElement | null;
  /** Where focus goes when the dialog closes and the control that opened it is gone. */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** False when the caller has already placed focus, after the act removed its control. */
  shouldReturnFocus?(): boolean;
  /** Told while the dialog is open, so the page behind it is inert. */
  onOpenChange?(open: boolean): void;
  onKeep(): void;
  onConfirm(): void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();
  useDialogFocusBoundary({ dialogRef: panelRef, returnFocus, fallbackReturnFocusRef: returnFocusRef, shouldReturnFocus, busy, onClose: onKeep });
  useOpenReport(onOpenChange);
  return createPortal(
    <ModalFrame labelledBy={titleId} describedBy={bodyId} pending={busy} onDismiss={onKeep}>
      <div ref={panelRef} className="tm-modal__panel tm-bugconfirm" tabIndex={-1}>
        <h3 id={titleId}>{title}</h3>
        <p id={bodyId}>{body}</p>
        <div className="tm-modal__actions">
          <button type="button" className="outline-button" disabled={busy} onClick={onKeep}>{keepLabel}</button>
          <button type="button" className="danger-button" disabled={busy} onClick={onConfirm}>
            <PendingLabel label={confirmLabel} pendingLabel={busyLabel} pending={busy} />
          </button>
        </div>
      </div>
    </ModalFrame>,
    document.body
  );
}
