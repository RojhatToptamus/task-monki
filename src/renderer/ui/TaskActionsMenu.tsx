import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  align?: 'start' | 'end';
}

export function TaskActionsMenu({
  taskId,
  title,
  archived,
  openTarget,
  onArchive,
  onRequestDelete,
  className,
  align = 'end'
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
    setGeometry(taskMenuGeometry(
      trigger.getBoundingClientRect(),
      { width: window.innerWidth, height: window.innerHeight },
      hasOpenTarget ? 214 : 152,
      align
    ));
  };

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    if (hasOpenTarget && initialFocusRef.current === 'first') {
      menuRef.current?.focus({ preventScroll: true });
    } else {
      focusMenuItem(menuRef.current, initialFocusRef.current);
    }

    const onPointerDown = (event: PointerEvent) => {
      if (
        !rootRef.current?.contains(event.target as Node) &&
        !menuRef.current?.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onScroll = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onResize = () => setOpen(false);

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
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
      {open && geometry ? createPortal(
        <div
          ref={menuRef}
          className="tm-taskmenu__menu tm-taskmenu__menu--floating"
          style={geometry}
          role="menu"
          tabIndex={-1}
          aria-label={`Task options for ${title}`}
          onKeyDown={(event) =>
            handleMenuKeyDown(event, {
              onClose: () => setOpen(false),
              returnFocus: triggerRef.current
            })
          }
          onBlur={(event) => {
            if (event.relatedTarget !== triggerRef.current) {
              handleMenuBlur(event, () => setOpen(false));
            }
          }}
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
              triggerRef.current?.focus({ preventScroll: true });
              onRequestDelete(taskId);
            }}
          >
            Delete...
          </button>
        </div>,
        rootRef.current?.closest('.app-shell') ?? document.body
      ) : null}
    </div>
  );
}

export interface TaskMenuGeometry {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
}

export function taskMenuGeometry(
  trigger: Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>,
  viewport: { width: number; height: number },
  menuWidth = 214,
  align: 'start' | 'end' = 'end'
): TaskMenuGeometry {
  const edgeGap = 12;
  const anchorGap = 6;
  const maxMenuHeight = 420;
  const width = Math.min(menuWidth, Math.max(0, viewport.width - edgeGap * 2));
  const spaceAbove = Math.max(0, trigger.top - anchorGap - edgeGap);
  const spaceBelow = Math.max(0, viewport.height - trigger.bottom - anchorGap - edgeGap);
  const placement = spaceBelow >= Math.min(360, spaceAbove) ? 'bottom' : 'top';
  const available = placement === 'bottom' ? spaceBelow : spaceAbove;
  return {
    left: Math.max(edgeGap, Math.min(
      align === 'start' ? trigger.left : trigger.right - width,
      viewport.width - width - edgeGap
    )),
    ...(placement === 'bottom'
      ? { top: trigger.bottom + anchorGap }
      : { bottom: viewport.height - trigger.top + anchorGap }),
    width,
    maxHeight: Math.min(maxMenuHeight, available)
  };
}

function KebabIcon() {
  return <MoreHorizontal aria-hidden="true" absoluteStrokeWidth size={16} strokeWidth={1.5} />;
}
