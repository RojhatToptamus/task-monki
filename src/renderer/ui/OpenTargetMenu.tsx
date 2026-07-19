import { useEffect, useMemo, useRef, useState, type Ref } from 'react';
import { createPortal } from 'react-dom';
import type {
  OpenTargetAction,
  OpenTargetAppIcon,
  OpenTargetInspection,
  OpenTargetRef
} from '../../shared/contracts';
import { taskManagerApi } from '../api/taskManagerClient';
import {
  buildOpenTargetMenuModel,
  type OpenTargetMenuItem
} from '../model/openTargetMenu';
import {
  focusMenuItem,
  focusOwningMenu,
  handleMenuBlur,
  handleMenuKeyDown
} from './menuKeyboard';

interface OpenTargetContextMenuProps {
  target: OpenTargetRef;
  position: { x: number; y: number };
  onClose(): void;
}

interface OpenTargetMenuItemsProps {
  target: OpenTargetRef;
  onActionComplete?(): void;
  autoFocusFirst?: boolean;
}

export function OpenTargetContextMenu({
  target,
  position,
  onClose
}: OpenTargetContextMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)
  );

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => focusMenuItem(rootRef.current));
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        returnFocusRef.current?.focus();
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const style = {
    left: position.x,
    top: position.y
  };

  return (
    <div
      className="tm-pathmenu tm-pathmenu--floating"
      role="menu"
      tabIndex={-1}
      aria-label="Open target"
      style={style}
      ref={rootRef}
      onKeyDown={(event) =>
        handleMenuKeyDown(event, {
          onClose,
          returnFocus: returnFocusRef.current
        })
      }
      onBlur={(event) => handleMenuBlur(event, onClose)}
    >
      <OpenTargetMenuItems target={target} onActionComplete={onClose} autoFocusFirst />
    </div>
  );
}

export function OpenTargetMenuItems({
  target,
  onActionComplete,
  autoFocusFirst = false
}: OpenTargetMenuItemsProps) {
  const targetKey = useMemo(() => JSON.stringify(target), [target]);
  const [inspection, setInspection] = useState<OpenTargetInspection>();
  const [error, setError] = useState<string>();
  const [busyAction, setBusyAction] = useState<string>();
  const firstItemRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let canceled = false;
    setInspection(undefined);
    setError(undefined);
    setBusyAction(undefined);
    void taskManagerApi
      .inspectOpenTarget({ target })
      .then((next) => {
        if (!canceled) {
          setInspection(next);
        }
      })
      .catch((caught: unknown) => {
        if (!canceled) {
          setError(caught instanceof Error ? caught.message : 'Could not inspect path.');
        }
      });
    return () => {
      canceled = true;
    };
  }, [targetKey]);

  useEffect(() => {
    if (!autoFocusFirst || !inspection) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const firstItem = firstItemRef.current;
      const menu = firstItem?.closest<HTMLElement>('[role="menu"]');
      if (firstItem && menu && document.activeElement === menu) {
        firstItem.focus();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocusFirst, inspection]);

  const runAction = async (item: OpenTargetMenuItem) => {
    if (item.disabled || busyAction) {
      return;
    }
    const activeItem =
      document.activeElement instanceof Element ? document.activeElement : firstItemRef.current;
    focusOwningMenu(activeItem);
    setBusyAction(item.id);
    setError(undefined);
    try {
      const result = await taskManagerApi.executeOpenTargetAction({
        target,
        action: item.action,
        appId: item.appId
      });
      if (!result.ok) {
        throw new Error(result.message ?? 'Action failed.');
      }
      if (result.clipboardText !== undefined) {
        await writeClipboard(result.clipboardText);
      }
      onActionComplete?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Action failed.');
    } finally {
      setBusyAction(undefined);
    }
  };

  if (error && !inspection) {
    return (
      <>
        <div className="tm-pathmenu__message" role="menuitem" aria-disabled="true">
          {error}
        </div>
        <OpenTargetLiveAnnouncement tone="error">{error}</OpenTargetLiveAnnouncement>
      </>
    );
  }
  if (!inspection) {
    return (
      <>
        <div className="tm-pathmenu__message" role="menuitem" aria-disabled="true">
          Loading...
        </div>
        <OpenTargetLiveAnnouncement>Loading open target.</OpenTargetLiveAnnouncement>
      </>
    );
  }

  const model = buildOpenTargetMenuModel(inspection);
  const menuBusy = Boolean(busyAction);

  return (
    <>
      <MenuButton
        buttonRef={firstItemRef}
        item={model.primary}
        busy={busyAction === model.primary.id}
        disabled={menuBusy}
        onRun={runAction}
      />
      {model.openWith.length > 0 ? (
        <div className="tm-pathmenu__submenu" role="group" aria-label="Open with">
          <span className="tm-pathmenu__submenu-label" aria-hidden="true">Open with</span>
          <div className="tm-pathmenu__submenu-body">
            {model.openWith.map((item) => (
              <MenuButton
                key={item.id}
                item={item}
                busy={busyAction === item.id}
                disabled={menuBusy}
                onRun={runAction}
              />
            ))}
          </div>
        </div>
      ) : null}
      <div className="tm-pathmenu__separator" role="separator" />
      {model.utilities.map((item) => (
        <MenuButton
          key={item.id}
          item={item}
          busy={busyAction === item.id}
          disabled={menuBusy}
          onRun={runAction}
        />
      ))}
      {error ? (
        <>
          <div
            className="tm-pathmenu__message tm-pathmenu__message--error"
            role="menuitem"
            aria-disabled="true"
          >
            {error}
          </div>
          <OpenTargetLiveAnnouncement tone="error">{error}</OpenTargetLiveAnnouncement>
        </>
      ) : null}
    </>
  );
}

function OpenTargetLiveAnnouncement({
  tone = 'status',
  children
}: {
  tone?: 'status' | 'error';
  children: string;
}) {
  if (typeof document === 'undefined') {
    return null;
  }
  return createPortal(
    <span className="tm-visually-hidden" role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </span>,
    document.body
  );
}

function MenuButton({
  buttonRef,
  item,
  busy,
  disabled,
  onRun
}: {
  buttonRef?: Ref<HTMLButtonElement>;
  item: OpenTargetMenuItem;
  busy: boolean;
  disabled: boolean;
  onRun(item: OpenTargetMenuItem): void;
}) {
  const title = item.disabled ? item.disabledReason : item.label;
  return (
    <button
      ref={buttonRef}
      type="button"
      role="menuitem"
      tabIndex={-1}
      className="tm-taskmenu__item tm-pathmenu__item"
      disabled={item.disabled || disabled}
      title={title}
      onClick={() => void onRun(item)}
    >
      {item.app?.icon ? <AppIcon icon={item.app.icon} /> : null}
      <span>{busy ? busyLabel(item.action) : item.label}</span>
    </button>
  );
}

function AppIcon({ icon }: { icon: OpenTargetAppIcon }) {
  return <img className="tm-pathmenu__appicon" src={icon.dataUrl} alt="" />;
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);
  if (!copied) {
    throw new Error('Clipboard is unavailable.');
  }
}

function busyLabel(action: OpenTargetAction): string {
  switch (action) {
    case 'copyPath':
    case 'copyFileContents':
      return 'Copying...';
    case 'reveal':
      return 'Revealing...';
    case 'open':
    case 'openTerminal':
      return 'Opening...';
  }
}
