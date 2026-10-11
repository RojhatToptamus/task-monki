import { useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import type { OpenTargetRef } from '../../shared/contracts';
import { ActionMenu, type ActionMenuItem } from './ActionMenu';
import { useNotify } from './NotifyContext';
import { useOpenTargetMenuItems } from './OpenTargetMenu';

interface TaskActionsMenuProps {
  taskId: string;
  title: string;
  archived: boolean;
  openTarget?: OpenTargetRef;
  onArchive(taskId: string): void;
  onRequestDelete(taskId: string): void;
  /** On the task page: opens the raw run, event and provider records. */
  onOpenDebug?(): void;
  className?: string;
  align?: 'start' | 'end';
}

/** A task's "…" menu: where its files open, then Debug, Archive and Delete. */
export function TaskActionsMenu({
  taskId,
  title,
  archived,
  openTarget,
  onArchive,
  onRequestDelete,
  onOpenDebug,
  className = '',
  align = 'end'
}: TaskActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const notify = useNotify();
  const openTargetItems = useOpenTargetMenuItems(openTarget, open, (message) => notify(message, 'error'));
  const items: ActionMenuItem[] = [
    ...openTargetItems,
    ...(onOpenDebug ? [{ id: 'debug', label: 'Debug', separated: true, onSelect: onOpenDebug }] : []),
    { id: 'archive', label: 'Archive', separated: true, disabled: archived, onSelect: () => onArchive(taskId) },
    { id: 'delete', label: 'Delete…', danger: true, separated: true, onSelect: () => onRequestDelete(taskId) }
  ];
  return (
    <ActionMenu
      className={`tm-taskmenu ${className}`.trim()}
      label={`Task options for ${title}`}
      tooltip="Task options"
      side="bottom"
      align={align}
      open={open}
      onOpenChange={setOpen}
      trigger={<MoreHorizontal aria-hidden="true" size={16} />}
      items={items}
    />
  );
}
