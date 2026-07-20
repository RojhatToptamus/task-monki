import type { KeyboardEvent } from 'react';

export function nextTabIndex(
  currentIndex: number,
  tabCount: number,
  key: string
): number | undefined {
  if (tabCount <= 0) {
    return undefined;
  }
  switch (key) {
    case 'ArrowLeft':
      return (currentIndex - 1 + tabCount) % tabCount;
    case 'ArrowRight':
      return (currentIndex + 1) % tabCount;
    case 'Home':
      return 0;
    case 'End':
      return tabCount - 1;
    default:
      return undefined;
  }
}

function activateAdjacentTab(event: KeyboardEvent<HTMLButtonElement>): void {
  const tabList = event.currentTarget.closest('[role="tablist"]');
  const tabs = tabList
    ? Array.from(tabList.querySelectorAll<HTMLButtonElement>('[role="tab"]')).filter(
        (tab) => !tab.disabled
      )
    : [];
  const currentIndex = tabs.indexOf(event.currentTarget);
  const targetIndex = nextTabIndex(currentIndex, tabs.length, event.key);
  if (targetIndex === undefined) {
    return;
  }
  event.preventDefault();
  tabs[targetIndex]?.focus();
  tabs[targetIndex]?.click();
}

export function AccessibleTab({
  id,
  panelId,
  label,
  selected,
  onSelect,
  badge,
  badgeAccessibleLabel
}: {
  id: string;
  panelId: string;
  label: string;
  selected: boolean;
  onSelect(): void;
  badge?: string;
  badgeAccessibleLabel?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      className={`tm-tab ${selected ? 'tm-tab--active' : ''}`}
      role="tab"
      aria-selected={selected}
      aria-controls={panelId}
      aria-label={badgeAccessibleLabel ? `${label}, ${badgeAccessibleLabel}` : undefined}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      onKeyDown={activateAdjacentTab}
    >
      {label}
      {badge ? (
        <span className="tm-tab__badge" aria-hidden="true">
          {badge}
        </span>
      ) : null}
    </button>
  );
}
