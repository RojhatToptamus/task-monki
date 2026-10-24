import type { ReactNode } from 'react';
import { useLayerProps } from './presence';

/**
 * The frame every modal shares (DESIGN.md §10): the fixed layer and the scrim behind the panel
 * the caller renders inside it, with `useDialogFocusBoundary` on that panel. It enters with the
 * modal motion and, rendered under a `Presence`, leaves faster than it came (§12).
 */
export function ModalFrame({
  className,
  labelledBy,
  describedBy,
  role = 'dialog',
  pending,
  onDismiss,
  children
}: {
  /** Added to `tm-modal`, such as `tm-modal--top`. */
  className?: string;
  labelledBy?: string;
  describedBy?: string;
  /** `presentation` when the panel itself is the dialog. */
  role?: 'dialog' | 'presentation';
  /** The modal's action is running: its controls keep their look through the pending delay (§6.1), and a stray click on the scrim cannot close it. */
  pending?: boolean;
  /** A click on the scrim, while no action runs. */
  onDismiss?: () => void;
  children: ReactNode;
}) {
  const layer = useLayerProps();
  return (
    <div
      {...layer}
      className={className ? `tm-modal ${className}` : 'tm-modal'}
      role={role}
      aria-modal={role === 'dialog' ? true : undefined}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      data-pending={pending || undefined}
    >
      <div className="tm-modal__scrim" onClick={pending ? undefined : onDismiss} />
      {children}
    </div>
  );
}
