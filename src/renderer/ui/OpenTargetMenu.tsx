import { useEffect, useMemo, useRef, useState } from 'react';
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

interface OpenTargetContextMenuProps {
  target: OpenTargetRef;
  position: { x: number; y: number };
  onClose(): void;
}

interface OpenTargetMenuItemsProps {
  target: OpenTargetRef;
  onActionComplete?(): void;
}

export function OpenTargetContextMenu({
  target,
  position,
  onClose
}: OpenTargetContextMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const style = {
    left: position.x,
    top: position.y
  };

  return (
    <div className="tm-pathmenu tm-pathmenu--floating" role="menu" style={style} ref={rootRef}>
      <OpenTargetMenuItems target={target} onActionComplete={onClose} />
    </div>
  );
}

export function OpenTargetMenuItems({
  target,
  onActionComplete
}: OpenTargetMenuItemsProps) {
  const targetKey = useMemo(() => JSON.stringify(target), [target]);
  const [inspection, setInspection] = useState<OpenTargetInspection>();
  const [error, setError] = useState<string>();
  const [busyAction, setBusyAction] = useState<string>();

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

  const runAction = async (item: OpenTargetMenuItem) => {
    if (item.disabled || busyAction) {
      return;
    }
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
    return <div className="tm-pathmenu__message">{error}</div>;
  }
  if (!inspection) {
    return <div className="tm-pathmenu__message">Loading...</div>;
  }

  const model = buildOpenTargetMenuModel(inspection);
  const menuBusy = Boolean(busyAction);

  return (
    <>
      <MenuButton
        item={model.primary}
        busy={busyAction === model.primary.id}
        disabled={menuBusy}
        onRun={runAction}
      />
      {model.openWith.length > 0 ? (
        <details className="tm-pathmenu__submenu">
          <summary>Open with</summary>
          <div className="tm-pathmenu__submenu-body" role="group" aria-label="Open with">
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
        </details>
      ) : null}
      <div className="tm-pathmenu__separator" />
      {model.utilities.map((item) => (
        <MenuButton
          key={item.id}
          item={item}
          busy={busyAction === item.id}
          disabled={menuBusy}
          onRun={runAction}
        />
      ))}
      {error ? <div className="tm-pathmenu__message tm-pathmenu__message--error">{error}</div> : null}
    </>
  );
}

function MenuButton({
  item,
  busy,
  disabled,
  onRun
}: {
  item: OpenTargetMenuItem;
  busy: boolean;
  disabled: boolean;
  onRun(item: OpenTargetMenuItem): void;
}) {
  const title = item.disabled ? item.disabledReason : item.label;
  return (
    <button
      type="button"
      role="menuitem"
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
