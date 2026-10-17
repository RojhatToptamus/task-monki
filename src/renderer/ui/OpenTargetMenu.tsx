import { useEffect, useState } from 'react';
import type { OpenTargetInspection, OpenTargetRef } from '../../shared/contracts';
import { taskManagerApi } from '../api/taskManagerClient';
import { buildOpenTargetMenuModel, type OpenTargetMenuItem } from '../model/openTargetMenu';
import { ActionContextMenu, type ActionMenuItem } from './ActionMenu';

/**
 * The open-target actions as menu items: Open, an Open with submenu, then Copy path and
 * Reveal. The target is inspected each time the menu opens; until that answer arrives the
 * same rows show, disabled, so the menu never changes shape. A failed action is reported
 * through `onError`.
 */
export function useOpenTargetMenuItems(
  target: OpenTargetRef | undefined,
  active: boolean,
  onError?: (message: string) => void
): ActionMenuItem[] {
  const targetKey = target ? JSON.stringify(target) : '';
  const [state, setState] = useState<{ key: string; inspection?: OpenTargetInspection; error?: string }>({ key: '' });
  useEffect(() => {
    if (!active || !target) return;
    let canceled = false;
    void taskManagerApi.inspectOpenTarget({ target }).then(
      (inspection) => { if (!canceled) setState({ key: targetKey, inspection }); },
      (cause: unknown) => { if (!canceled) setState({ key: targetKey, error: openTargetErrorMessage(cause, 'The path could not be inspected.') }); }
    );
    return () => { canceled = true; };
    // The key stands for the target object, which callers may recreate on every render.
  }, [active, targetKey]);
  if (!target) return [];

  const run = (item: OpenTargetMenuItem) => () => {
    void executeOpenTargetAction(target, item).catch((cause: unknown) =>
      onError?.(openTargetErrorMessage(cause, 'The action failed.')));
  };
  const inspection = state.key === targetKey ? state.inspection : undefined;
  if (!inspection) {
    const reason = state.key === targetKey ? state.error : undefined;
    return [
      { id: 'open', label: 'Open', disabled: true, disabledReason: reason },
      { id: 'open-with', label: 'Open with', disabled: true, items: [] },
      { id: 'copyPath', label: 'Copy path', separated: true, onSelect: run({ id: 'copyPath', label: 'Copy path', action: 'copyPath' }) },
      { id: 'reveal', label: revealLabel(), disabled: true }
    ];
  }
  const model = buildOpenTargetMenuModel(inspection);
  const toItem = (item: OpenTargetMenuItem): ActionMenuItem => ({
    id: item.id,
    label: item.label,
    meta: item.meta,
    disabled: item.disabled,
    disabledReason: item.disabled ? item.disabledReason : undefined,
    onSelect: run(item)
  });
  return [
    toItem(model.primary),
    { id: 'open-with', label: 'Open with', disabled: model.openWith.length === 0, items: model.openWith.map(toItem) },
    ...model.utilities.map((item, index) => ({ ...toItem(item), separated: index === 0 }))
  ];
}

/** The open-target menu at the pointer, for a right-click on a path. */
export function OpenTargetContextMenu({ target, position, onClose, onError }: {
  target: OpenTargetRef;
  position: { x: number; y: number };
  onClose(): void;
  onError?(message: string): void;
}) {
  const items = useOpenTargetMenuItems(target, true, onError);
  return <ActionContextMenu label="Open target" position={position} items={items} onClose={onClose} />;
}

async function executeOpenTargetAction(target: OpenTargetRef, item: OpenTargetMenuItem): Promise<void> {
  const result = await taskManagerApi.executeOpenTargetAction({ target, action: item.action, appId: item.appId });
  if (!result.ok) throw new Error(result.message ?? 'The action failed.');
  if (result.clipboardText !== undefined) await writeClipboard(result.clipboardText);
}

/** The platform's word for showing a file in its folder, until the inspection says it. */
function revealLabel(): string {
  if (typeof navigator === 'undefined') return 'Reveal in folder';
  return /Mac/u.test(navigator.userAgent) ? 'Reveal in Finder' : /Windows/u.test(navigator.userAgent) ? 'Show in Explorer' : 'Reveal in folder';
}

function openTargetErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
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
    throw new Error('The clipboard is unavailable.');
  }
}
