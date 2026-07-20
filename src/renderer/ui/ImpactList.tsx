export type ImpactKind = 'deleted' | 'kept' | 'untouched';

export interface ImpactGroup {
  kind: ImpactKind;
  items: string[];
}

const IMPACT_LABELS: Record<ImpactKind, string> = {
  deleted: 'Deleted',
  kept: 'Kept',
  untouched: 'Untouched'
};

export function ImpactList({
  groups,
  ariaLabel = 'Impact'
}: {
  groups: ImpactGroup[];
  ariaLabel?: string;
}) {
  return (
    <div className="tm-impact-list" role="group" aria-label={ariaLabel}>
      {groups.map((group) => (
        <section
          key={group.kind}
          className="tm-impact-list__group"
          data-impact-kind={group.kind}
        >
          <h4>{IMPACT_LABELS[group.kind]}</h4>
          <ul>
            {group.items.map((item, index) => (
              <li key={`${index}-${item}`}>{item}</li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
