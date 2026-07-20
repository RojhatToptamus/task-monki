import { useEffect, useRef, useState } from 'react';
import type { DiscourseDefaultPolicy } from '../../shared/discourse';
import {
  DISCOURSE_RESPONSE_MODE_OPTIONS,
  discourseResponsePolicyLabel
} from '../model/discourse';
import { DiscourseCheckIcon, DiscourseChevronDownIcon } from './DiscourseIcons';
import {
  focusMenuItem,
  handleMenuBlur,
  handleMenuKeyDown,
  menuTriggerFocusTarget,
  type MenuFocusTarget
} from './menuKeyboard';

export function DiscourseModeMenu({
  value,
  detail,
  disabled,
  teamReady,
  onChange
}: {
  value: DiscourseDefaultPolicy;
  detail: string;
  disabled: boolean;
  teamReady: boolean;
  onChange(policy: DiscourseDefaultPolicy): void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<MenuFocusTarget>('selected');

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      focusMenuItem(menuRef.current, initialFocusRef.current);
    });
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeForViewportChange = () => setOpen(false);
    window.addEventListener('pointerdown', closeOutside);
    window.addEventListener('resize', closeForViewportChange);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('resize', closeForViewportChange);
    };
  }, [open]);

  const select = (policy: DiscourseDefaultPolicy) => {
    if (policy === 'TEAM' && !teamReady) return;
    triggerRef.current?.focus({ preventScroll: true });
    setOpen(false);
    onChange(policy);
  };

  return (
    <div className="tm-discourse-mode-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="tm-discourse-mode-menu__trigger"
        aria-label={`Response mode: ${discourseResponsePolicyLabel(value)}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          initialFocusRef.current = 'selected';
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
        <span>
          <strong>{discourseResponsePolicyLabel(value)}</strong>
          <small>{detail}</small>
        </span>
        <DiscourseChevronDownIcon />
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="tm-discourse-mode-menu__popover"
          role="menu"
          tabIndex={-1}
          aria-label="Response mode"
          onKeyDown={(event) => handleMenuKeyDown(event, {
            onClose: () => setOpen(false),
            returnFocus: triggerRef.current
          })}
          onBlur={(event) => handleMenuBlur(event, () => setOpen(false))}
        >
          {DISCOURSE_RESPONSE_MODE_OPTIONS.map((option) => {
            const unavailable = option.policy === 'TEAM' && !teamReady;
            return (
              <button
                key={option.policy}
                type="button"
                role="menuitemradio"
                tabIndex={-1}
                aria-checked={value === option.policy}
                aria-disabled={unavailable || undefined}
                title={unavailable
                  ? 'Team requires Lead, Skeptic, and Verifier to be available.'
                  : undefined}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  event.stopPropagation();
                  select(option.policy);
                }}
                onClick={() => select(option.policy)}
              >
                <span className="tm-discourse-mode-menu__copy">
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                  {unavailable ? (
                    <em>Lead, Skeptic, and Verifier must all be available.</em>
                  ) : null}
                </span>
                <span className="tm-discourse-mode-menu__check">
                  {value === option.policy ? <DiscourseCheckIcon /> : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
