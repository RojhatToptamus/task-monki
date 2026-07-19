import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { RepositoryOption } from '../model/repositories';
import { openTargetMenuPosition } from '../model/openTargetMenu';
import { OpenTargetContextMenu } from './OpenTargetMenu';
import type { OpenTargetRef } from '../../shared/contracts';
import {
  focusMenuItem,
  handleMenuBlur,
  handleMenuKeyDown,
  menuTriggerFocusTarget,
  type MenuFocusTarget
} from './menuKeyboard';

interface RepositorySwitcherProps {
  activeRepositoryId: string;
  options: RepositoryOption[];
  collapsed: boolean;
  adding: boolean;
  onSelect(repositoryId: string): void;
  onAddRepository(): Promise<boolean>;
  onRefreshRepository(repositoryId: string): Promise<void>;
  onReconnectRepository(repositoryId: string): Promise<void>;
  onDisconnectRepository(repositoryId: string): Promise<void>;
}

export function RepositorySwitcher({
  activeRepositoryId,
  options,
  collapsed,
  adding,
  onSelect,
  onAddRepository,
  onRefreshRepository,
  onReconnectRepository,
  onDisconnectRepository
}: RepositorySwitcherProps) {
  const [open, setOpen] = useState(false);
  const [pathMenu, setPathMenu] = useState<{
    target: OpenTargetRef;
    position: { x: number; y: number };
  }>();
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const initialFocusRef = useRef<MenuFocusTarget>('selected');
  const activeOption = options.find((option) => option.id === activeRepositoryId);
  const triggerLabel = activeOption?.name ?? 'Add repository';

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const frame = window.requestAnimationFrame(() => {
      focusMenuItem(menuRef.current, initialFocusRef.current);
    });

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !rootRef.current?.contains(target)) {
        setOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [open]);

  const addRepository = async () => {
    const added = await onAddRepository();
    if (added) {
      setOpen(false);
    }
  };

  const openRepositoryMenu = (repositoryId: string, event: MouseEvent) => {
    if (!repositoryId) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setPathMenu({
      target: { type: 'repository', repositoryId },
      position: openTargetMenuPosition(event.clientX, event.clientY)
    });
  };

  return (
    <div
      className={`tm-repo-switcher ${collapsed ? 'tm-repo-switcher--collapsed' : ''}`}
      ref={rootRef}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`tm-nav__repo ${activeRepositoryId ? '' : 'tm-nav__repo--empty'}`}
        data-tip={collapsed ? triggerLabel : undefined}
        aria-label={`New task repository: ${triggerLabel}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onContextMenu={(event) => openRepositoryMenu(activeRepositoryId, event)}
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
            setOpen(true);
          }
        }}
        onClick={() => {
          initialFocusRef.current = 'selected';
          setOpen((current) => !current);
        }}
      >
        <span className="tm-nav__repo-icon" aria-hidden="true">
          <RepositoryIcon />
        </span>
        <span className="tm-nav__repo-text">
          <span className="tm-nav__repo-label">New task repository</span>
          <span className="tm-nav__repo-name">{triggerLabel}</span>
        </span>
        <ChevronIcon open={open} />
      </button>

      {open ? (
        <div
          ref={menuRef}
          className="tm-repo-menu"
          role="menu"
          tabIndex={-1}
          aria-label="Repositories"
          onKeyDown={(event) =>
            handleMenuKeyDown(event, {
              onClose: () => setOpen(false),
              returnFocus: triggerRef.current
            })
          }
          onBlur={(event) => handleMenuBlur(event, () => setOpen(false))}
        >
          <div className="tm-repo-menu__head" role="presentation">
            <span>Repositories</span>
            <strong>{options.length}</strong>
          </div>
          <div className="tm-repo-menu__list" role="group" aria-label="Repository choices">
            {options.length > 0 ? (
              options.map((option) => {
                const active = option.id === activeRepositoryId;
                return (
                  <button
                    type="button"
                    role="menuitemradio"
                    tabIndex={-1}
                    aria-checked={active}
                    className={`tm-repo-menu__item ${
                      active ? 'tm-repo-menu__item--active' : ''
                    }`}
                    key={option.id}
                    onContextMenu={(event) => openRepositoryMenu(option.id, event)}
                    onClick={() => {
                      onSelect(option.id);
                      setOpen(false);
                    }}
                  >
                    <span
                      className={`tm-repo-menu__status tm-repo-menu__status--${option.status.toLowerCase()}`}
                    />
                    <span className="tm-repo-menu__text">
                      <span className="tm-repo-menu__name">{option.name}</span>
                      <span className="tm-repo-menu__path" title={option.path}>
                        {option.displayPath}
                      </span>
                    </span>
                    <span className="tm-repo-menu__meta">
                      {active ? <span>Default for new tasks</span> : null}
                      {option.status !== 'AVAILABLE' ? <em>{option.status.toLowerCase()}</em> : null}
                      <strong>{formatTaskCount(option.taskCount)}</strong>
                    </span>
                  </button>
                );
              })
            ) : (
              <div className="tm-repo-menu__empty">No repositories added yet.</div>
            )}
          </div>
          <div className="tm-repo-menu__footer" role="group" aria-label="Repository actions">
            {activeOption ? (
              <div className="tm-repo-menu__manage" role="presentation">
                {activeOption.status !== 'DISCONNECTED' ? (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    onClick={() => void onRefreshRepository(activeOption.id)}
                  >
                    Refresh
                  </button>
                ) : null}
                {activeOption.status !== 'AVAILABLE' ? (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    onClick={() => void onReconnectRepository(activeOption.id)}
                  >
                    Reconnect
                  </button>
                ) : null}
                {activeOption.status !== 'DISCONNECTED' ? (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className="tm-repo-menu__disconnect"
                    onClick={() => void onDisconnectRepository(activeOption.id)}
                  >
                    Disconnect
                  </button>
                ) : null}
              </div>
            ) : null}
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
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
      {pathMenu ? (
        <OpenTargetContextMenu
          target={pathMenu.target}
          position={pathMenu.position}
          onClose={() => setPathMenu(undefined)}
        />
      ) : null}
    </div>
  );
}

function formatTaskCount(count: number): string {
  return `${count} task${count === 1 ? '' : 's'}`;
}

function RepositoryIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3h9a3 3 0 0 1 3 3v13.5" />
      <path d="M6 3a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h11a1 1 0 0 0 1-1v-1.5" />
      <path d="M6 16.5h11" />
    </svg>
  );
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
