import { useEffect, useRef, useState } from 'react';

interface TaskActionsMenuProps {
  taskId: string;
  title: string;
  archived: boolean;
  onArchive(taskId: string): void;
  onRequestDelete(taskId: string): void;
  className?: string;
}

export function TaskActionsMenu({
  taskId,
  title,
  archived,
  onArchive,
  onRequestDelete,
  className
}: TaskActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className={`tm-taskmenu ${className ?? ''}`} ref={menuRef}>
      <button
        type="button"
        className="tm-taskmenu__trigger"
        aria-label={`Task options for ${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Task options"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <KebabIcon />
      </button>
      {open ? (
        <div className="tm-taskmenu__menu" role="menu">
          <button
            type="button"
            role="menuitem"
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
