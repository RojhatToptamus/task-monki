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
