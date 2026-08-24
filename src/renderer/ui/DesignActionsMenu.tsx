import { useEffect, useRef, useState } from 'react';
import {
  focusMenuItem,
  handleMenuBlur,
  handleMenuKeyDown,
  menuTriggerFocusTarget,
  type MenuFocusTarget
} from './menuKeyboard';

interface DesignMenuItem {
  label: string;
  disabled?: boolean;
  danger?: boolean;
  action(): void;
}

export function DesignProjectMenu({
  title,
  canDuplicate,
  canArchive,
  canDelete,
  onDuplicate,
  onRename,
  onArchive,
  onDelete
}: {
  title: string;
  canDuplicate: boolean;
  canArchive: boolean;
  canDelete: boolean;
  onDuplicate(): void;
  onRename(): void;
  onArchive(): void;
  onDelete(): void;
}) {
  return (
    <DesignMenu
      label={`Design options for ${title}`}
      items={[
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

function DesignMenu({
  label,
  items,
  compact = false
}: {
  label: string;
  items: readonly DesignMenuItem[];
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const initialFocusRef = useRef<MenuFocusTarget>('first');

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() =>
      focusMenuItem(menuRef.current, initialFocusRef.current)
    );
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', closeOutside);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('pointerdown', closeOutside);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={`tm-taskmenu ${compact ? 'tm-design-ready-menu' : 'tm-design-project-menu'}`}
    >
      <button
        ref={triggerRef}
        type="button"
        className="tm-taskmenu__trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title="More options"
        onKeyDown={(event) => {
          const target = menuTriggerFocusTarget(event.key);
          if (!target) return;
          event.preventDefault();
          initialFocusRef.current = target;
          if (open) focusMenuItem(menuRef.current, target);
          else setOpen(true);
        }}
        onClick={() => {
          initialFocusRef.current = 'first';
          setOpen((current) => !current);
        }}
      >
        <KebabIcon />
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="tm-taskmenu__menu"
          role="menu"
          tabIndex={-1}
          aria-label={label}
          onKeyDown={(event) =>
            handleMenuKeyDown(event, {
              onClose: () => setOpen(false),
              returnFocus: triggerRef.current
            })
          }
          onBlur={(event) => handleMenuBlur(event, () => setOpen(false))}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={`tm-taskmenu__item ${item.danger ? 'tm-taskmenu__item--danger' : ''}`}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.action();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function KebabIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <circle cx="3" cy="8" r="1.4" />
      <circle cx="8" cy="8" r="1.4" />
      <circle cx="13" cy="8" r="1.4" />
    </svg>
  );
}
