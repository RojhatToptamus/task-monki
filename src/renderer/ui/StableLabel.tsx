/**
 * A control label that changes ("Save" to "Saving…") without changing the control's width
 * (DESIGN.md 6.3): every label it can show is stacked in one grid cell and only the current one
 * is visible, so the widest decides the width.
 */
export function StableLabel({ label, reserve }: { label: string; reserve: readonly string[] }) {
  return (
    <span className="tm-stable-label">
      {reserve.filter((other) => other !== label).map((other) => (
        <span key={other} className="tm-stable-label__reserve" aria-hidden="true">{other}</span>
      ))}
      <span>{label}</span>
    </span>
  );
}

/**
 * The label of a control whose action can take a while: "Save", and "Saving…" while it runs.
 * Both share one cell, so the control keeps its width (DESIGN.md 6.3), and the pending label
 * replaces the resting one only once the action has run for `--pending-delay` (6.1), so an
 * action that ends almost at once never flashes it. Mark the control, or the surface whose
 * controls the action holds, with `data-pending` so their disabled look waits too. Assistive
 * technology hears the current label at once.
 */
export function PendingLabel({ label, pendingLabel, pending }: { label: string; pendingLabel: string; pending: boolean }) {
  return (
    <span className="tm-stable-label tm-pending-label" data-pending={pending || undefined}>
      <span aria-hidden={pending || undefined}>{label}</span>
      <span aria-hidden={!pending || undefined}>{pendingLabel}</span>
    </span>
  );
}
