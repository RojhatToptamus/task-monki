import { MoreHorizontal } from 'lucide-react';
import { ActionMenu } from './ActionMenu';

interface DesignMenuItem {
  label: string;
  disabled?: boolean;
  disabledReason?: string;
  danger?: boolean;
  action(): void;
}

export function DesignProjectMenu({
  title,
  canOpenInFinder,
  canDuplicate,
  canArchive,
  canDelete,
  onOpenInFinder,
  onDuplicate,
  onRename,
  onArchive,
  onDelete
}: {
  title: string;
  canOpenInFinder: boolean;
  canDuplicate: boolean;
  canArchive: boolean;
  canDelete: boolean;
  onOpenInFinder(): void;
  onDuplicate(): void;
  onRename(): void;
  onArchive(): void;
  onDelete(): void;
}) {
  return (
    <DesignMenu
      label={`Design options for ${title}`}
      items={[
        { label: 'Open in Finder', disabled: !canOpenInFinder, action: onOpenInFinder },
        { label: 'Duplicate current', disabled: !canDuplicate, action: onDuplicate },
        { label: 'Rename…', action: onRename },
        { label: 'Archive', disabled: !canArchive, action: onArchive },
        { label: 'Delete…', disabled: !canDelete, danger: true, action: onDelete }
      ]}
    />
  );
}

export function DesignReadyMenu({
  ordinal,
  isCurrent,
  canRestore,
  canDuplicate,
  onRestore,
  onDuplicate
}: {
  ordinal: number;
  isCurrent: boolean;
  canRestore: boolean;
  canDuplicate: boolean;
  onRestore(): void;
  onDuplicate(): void;
}) {
  return (
    <DesignMenu
      label={`Ready state ${ordinal} options`}
      compact
      items={[
        {
          label: 'Restore this version',
          disabled: isCurrent || !canRestore,
          disabledReason: isCurrent ? 'Already the current version.' : undefined,
          action: onRestore
        },
        {
          label: 'Duplicate from here',
          disabled: !canDuplicate,
          action: onDuplicate
        }
      ]}
    />
  );
}

function DesignMenu({ label, items, compact = false }: {
  label: string; items: readonly DesignMenuItem[]; compact?: boolean;
}) {
  return <ActionMenu className={compact ? 'tm-design-ready-menu' : 'tm-design-project-menu'} label={label}
    trigger={<MoreHorizontal aria-hidden="true" size={16} strokeWidth={1.5} />}
    items={items.map(({ action, ...item }) => ({ ...item, onSelect: action }))} />;
}
