import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
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
  const [geometry, setGeometry] = useState<TaskMenuGeometry>();
  const hasOpenTarget = Boolean(openTarget);

  const prepareMenu = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    setGeometry(taskMenuGeometry(trigger.getBoundingClientRect(), window.innerHeight));
  };

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
            prepareMenu();
            setOpen(true);
          }
        }}
        onClick={(event) => {
          event.stopPropagation();
          initialFocusRef.current = 'first';
          prepareMenu();
          setOpen((current) => !current);
        }}
      >
        <KebabIcon />
      </button>
      {open ? (
        <div
          ref={menuRef}
          className={`tm-taskmenu__menu ${
            geometry?.placement === 'top' ? 'tm-taskmenu__menu--top' : ''
          }`}
          style={{ maxHeight: geometry ? `${geometry.maxHeight}px` : undefined }}
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
              triggerRef.current?.focus();
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

export interface TaskMenuGeometry {
  maxHeight: number;
  placement: 'bottom' | 'top';
}

export function taskMenuGeometry(
  trigger: Pick<DOMRect, 'top' | 'bottom'>,
  viewportHeight: number
): TaskMenuGeometry {
  const edgeGap = 12;
  const maxMenuHeight = 420;
  const spaceAbove = Math.max(0, trigger.top - edgeGap);
  const spaceBelow = Math.max(0, viewportHeight - trigger.bottom - edgeGap);
  const placement = spaceBelow >= Math.min(360, spaceAbove) ? 'bottom' : 'top';
  const available = placement === 'bottom' ? spaceBelow : spaceAbove;
  return {
    placement,
    maxHeight: Math.max(120, Math.min(maxMenuHeight, available))
  };
}

function KebabIcon() {
  return <MoreHorizontal aria-hidden="true" absoluteStrokeWidth size={16} strokeWidth={1.5} />;
}
