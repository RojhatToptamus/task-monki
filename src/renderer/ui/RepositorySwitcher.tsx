import { useEffect, useRef, useState } from 'react';
import type { RepositoryOption } from '../model/repositories';

interface RepositorySwitcherProps {
  activeRepositoryPath: string;
  options: RepositoryOption[];
  collapsed: boolean;
  adding: boolean;
  onSelect(repositoryPath: string): void;
  onAddRepository(): Promise<boolean>;
}

export function RepositorySwitcher({
  activeRepositoryPath,
  options,
  collapsed,
  adding,
  onSelect,
  onAddRepository
}: RepositorySwitcherProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const activeOption = options.find((option) => option.path === activeRepositoryPath);
  const triggerLabel = activeOption?.displayPath ?? 'Add repository';

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !rootRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const addRepository = async () => {
    const added = await onAddRepository();
    if (added) {
      setOpen(false);
    }
  };

  return (
    <div
      className={`tm-repo-switcher ${collapsed ? 'tm-repo-switcher--collapsed' : ''}`}
      ref={rootRef}
    >
      <button
        type="button"
        className={`tm-nav__repo ${activeRepositoryPath ? '' : 'tm-nav__repo--empty'}`}
        data-tip={collapsed ? triggerLabel : undefined}
        aria-label="Repository menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="tm-nav__repo-dot" />
        <span className="tm-nav__repo-text">
          <span className="tm-nav__repo-label">Repository</span>
          <span className="tm-nav__repo-name">{triggerLabel}</span>
        </span>
        <ChevronIcon open={open} />
      </button>

      {open ? (
        <div className="tm-repo-menu" role="menu" aria-label="Repositories">
          <div className="tm-repo-menu__head">
            <span>Repositories</span>
            <strong>{options.length}</strong>
          </div>
          <div className="tm-repo-menu__list">
            {options.length > 0 ? (
              options.map((option) => {
                const active = option.path === activeRepositoryPath;
                return (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    className={`tm-repo-menu__item ${
                      active ? 'tm-repo-menu__item--active' : ''
                    }`}
                    key={option.path}
                    onClick={() => {
                      onSelect(option.path);
                      setOpen(false);
                    }}
                  >
                    <span className="tm-repo-menu__status" />
                    <span className="tm-repo-menu__text">
                      <span className="tm-repo-menu__name">{option.name}</span>
                      <span className="tm-repo-menu__path">{option.path}</span>
                    </span>
                    <span className="tm-repo-menu__meta">
                      {option.isDefault ? <span>Default</span> : null}
                      <strong>{formatTaskCount(option.taskCount)}</strong>
                    </span>
                  </button>
                );
              })
            ) : (
              <div className="tm-repo-menu__empty">No repositories added yet.</div>
            )}
          </div>
          <div className="tm-repo-menu__footer">
            <button
              type="button"
              className="tm-repo-menu__add"
              disabled={adding}
              onClick={() => void addRepository()}
            >
              <span aria-hidden="true">+</span>
              {adding ? 'Adding repository...' : 'Add repository'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function formatTaskCount(count: number): string {
  return `${count} task${count === 1 ? '' : 's'}`;
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className="tm-nav__repo-chevron"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points={open ? '6 15 12 9 18 15' : '6 9 12 15 18 9'} />
    </svg>
  );
}
