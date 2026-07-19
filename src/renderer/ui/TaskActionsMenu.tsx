import { useEffect, useRef, useState } from 'react';
import type { OpenTargetRef } from '../../shared/contracts';
import { OpenTargetMenuItems } from './OpenTargetMenu';
import {
  focusMenuItem,
  handleMenuBlur,
  handleMenuKeyDown,
  menuTriggerFocusTarget,
  type MenuFocusTarget
} from './menuKeyboard';

interface TaskActionsMenuProps {
  taskId: string;
  title: string;
  archived: boolean;
  openTarget?: OpenTargetRef;
  onArchive(taskId: string): void;
  onRequestDelete(taskId: string): void;
  className?: string;
}

export function TaskActionsMenu({
  taskId,
  title,
  archived,
  openTarget,
  onArchive,
  onRequestDelete,
  className
}: TaskActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const initialFocusRef = useRef<MenuFocusTarget>('first');
  const hasOpenTarget = Boolean(openTarget);

  useEffect(() => {
    if (!open) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      if (hasOpenTarget && initialFocusRef.current === 'first') {
        menuRef.current?.focus();
      } else {
        focusMenuItem(menuRef.current, initialFocusRef.current);
      }
    });

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [hasOpenTarget, open]);

  return (
    <div className={`tm-taskmenu ${className ?? ''}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="tm-taskmenu__trigger"
        aria-label={`Task options for ${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Task options"
        onKeyDown={(event) => {
          const target = menuTriggerFocusTarget(event.key);
          if (!target) {
            return;
          }
          event.preventDefault();
          initialFocusRef.current = target;
          if (open) {
            focusMenuItem(menuRef.current, target);
          } else {
            setOpen(true);
          }
        }}
        onClick={(event) => {
          event.stopPropagation();
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
          aria-label={`Task options for ${title}`}
          onKeyDown={(event) =>
            handleMenuKeyDown(event, {
              onClose: () => setOpen(false),
              returnFocus: triggerRef.current
            })
          }
          onBlur={(event) => handleMenuBlur(event, () => setOpen(false))}
        >
          {openTarget ? (
            <>
              <OpenTargetMenuItems
                target={openTarget}
                onActionComplete={() => setOpen(false)}
                autoFocusFirst
              />
              <div className="tm-pathmenu__separator" role="separator" />
            </>
          ) : null}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="tm-taskmenu__item"
            disabled={archived}
            onClick={() => {
              setOpen(false);
              onArchive(taskId);
            }}
          >
            Archive
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="tm-taskmenu__item tm-taskmenu__item--danger"
            onClick={() => {
              setOpen(false);
              onRequestDelete(taskId);
            }}
          >
            Delete...
          </button>
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
