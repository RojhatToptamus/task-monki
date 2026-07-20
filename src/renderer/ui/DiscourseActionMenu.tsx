import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  focusMenuItem,
  handleMenuBlur,
  handleMenuKeyDown,
  menuTriggerFocusTarget,
  type MenuFocusTarget
} from './menuKeyboard';

export interface DiscourseActionMenuItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  pressed?: boolean;
  onSelect(): void;
}

export function DiscourseActionMenu({
  className,
  label,
  trigger,
  items
}: {
  className: string;
  label: string;
  trigger: ReactNode;
  items: DiscourseActionMenuItem[];
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<'above' | 'below'>('above');
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const initialFocusRef = useRef<MenuFocusTarget>('first');

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const root = rootRef.current;
      const menu = menuRef.current;
      if (root && menu) {
        const triggerRect = root.getBoundingClientRect();
        const boundary = root.closest('.tm-discourse-transcript');
        const boundaryRect = boundary?.getBoundingClientRect();
        const top = boundaryRect?.top ?? 8;
        const bottom = boundaryRect?.bottom ?? window.innerHeight - 8;
        const spaceAbove = triggerRect.top - top;
        const spaceBelow = bottom - triggerRect.bottom;
        setPlacement(spaceBelow >= menu.offsetHeight || spaceBelow >= spaceAbove
          ? 'below'
          : 'above');
      }
      focusMenuItem(menuRef.current, initialFocusRef.current);
    });
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeForViewportChange = () => setOpen(false);
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', closeForViewportChange);
    document.addEventListener('scroll', closeForViewportChange, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', closeForViewportChange);
      document.removeEventListener('scroll', closeForViewportChange, true);
    };
  }, [open]);

  return (
    <div className={className} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`${className}__trigger`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          initialFocusRef.current = 'first';
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          const target = menuTriggerFocusTarget(event.key);
          if (!target) return;
          event.preventDefault();
          initialFocusRef.current = target;
          if (open) focusMenuItem(menuRef.current, target);
          else setOpen(true);
        }}
      >
        {trigger}
      </button>
      {open ? (
        <div
          ref={menuRef}
          className={`${className}__popover ${className}__popover--${placement}`}
          role="menu"
          tabIndex={-1}
          aria-label={label}
          onKeyDown={(event) => handleMenuKeyDown(event, {
            onClose: () => setOpen(false),
            returnFocus: triggerRef.current
          })}
          onBlur={(event) => handleMenuBlur(event, () => setOpen(false))}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role={item.pressed === undefined ? 'menuitem' : 'menuitemcheckbox'}
              tabIndex={-1}
              aria-checked={item.pressed === undefined ? undefined : item.pressed}
              disabled={item.disabled}
              title={item.disabled ? item.disabledReason : undefined}
              className={item.danger ? 'tm-discourse-menu__danger' : undefined}
              onClick={() => {
                triggerRef.current?.focus({ preventScroll: true });
                setOpen(false);
                item.onSelect();
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
