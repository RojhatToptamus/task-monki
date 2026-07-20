import { useEffect, useId, useRef, useState } from 'react';
import {
  filterRepositoryOptions,
  type RepositoryOption
} from '../model/repositories';

interface RepositoryPickerProps {
  options: RepositoryOption[];
  selectedIds: readonly string[];
  disabled?: boolean;
  ariaLabel: string;
  onChange(selectedIds: string[]): void;
}

interface RepositorySelectProps {
  options: RepositoryOption[];
  selectedId: string;
  disabled?: boolean;
  ariaLabel: string;
  onChange(repositoryId: string): void;
}

export function RepositorySelect({
  options,
  selectedId,
  disabled = false,
  ariaLabel,
  onChange
}: RepositorySelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const popupId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectedOption = options.find((option) => option.id === selectedId);
  const filteredOptions = filterRepositoryOptions(options, query);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    if (disabled) {
      setOpen(false);
      setQuery('');
      return undefined;
    }

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
    };
  }, [disabled, open]);

  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const triggerName = selectedOption?.name ?? 'No repositories available';

  return (
    <div
      className="tm-repository-select"
      ref={rootRef}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (open && !(nextTarget instanceof Node && event.currentTarget.contains(nextTarget))) {
          close();
        }
      }}
      onKeyDown={(event) => {
        if (open && event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
          triggerRef.current?.focus();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="tm-repository-select__trigger"
        aria-label={
          selectedOption
            ? `${ariaLabel}: ${selectedOption.name}, ${selectedOption.path}`
            : `${ariaLabel}: No repositories available`
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        disabled={disabled || options.length === 0}
        onClick={() => {
          setQuery('');
          setOpen((current) => !current);
        }}
      >
        <span className="tm-repository-picker__identity">
          <strong>{triggerName}</strong>
          {selectedOption ? (
            <span className="tm-repository-picker__path" title={selectedOption.path}>
              {selectedOption.displayPath}
            </span>
          ) : null}
        </span>
        <ChevronIcon open={open} />
      </button>

      {open ? (
        <div
          className="tm-repository-select__popover"
          id={popupId}
          role="dialog"
          aria-label={`${ariaLabel} options`}
        >
          <RepositorySearch query={query} disabled={disabled} autoFocus onQueryChange={setQuery} />
          <div className="tm-repository-select__list">
            {filteredOptions.length > 0 ? (
              filteredOptions.map((option) => {
                const selected = option.id === selectedId;
                return (
                  <button
                    type="button"
                    className={`tm-repository-select__option ${
                      selected ? 'tm-repository-select__option--selected' : ''
                    }`}
                    key={option.id}
                    aria-label={`${option.name}, ${option.path}`}
                    aria-pressed={selected}
                    disabled={disabled}
                    onClick={() => {
                      onChange(option.id);
                      close();
                      triggerRef.current?.focus();
                    }}
                  >
                    <span className="tm-repository-picker__identity">
                      <strong>{option.name}</strong>
                      <span className="tm-repository-picker__path" title={option.path}>
                        {option.displayPath}
                      </span>
                    </span>
                    <span className="tm-repository-select__check" aria-hidden="true">
                      {selected ? <CheckIcon /> : null}
                    </span>
                  </button>
                );
              })
            ) : (
              <span className="tm-repository-picker__empty" role="status">
                No repositories found.
              </span>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function RepositoryPicker({
  options,
  selectedIds,
  disabled = false,
  ariaLabel,
  onChange
}: RepositoryPickerProps) {
  const [query, setQuery] = useState('');
  const filteredOptions = filterRepositoryOptions(options, query);
  const selected = new Set(selectedIds);

  const toggle = (repositoryId: string) => {
    onChange(
      selected.has(repositoryId)
        ? selectedIds.filter((candidate) => candidate !== repositoryId)
        : [...selectedIds, repositoryId]
    );
  };

  return (
    <div className="tm-repository-picker">
      <RepositorySearch query={query} disabled={disabled} onQueryChange={setQuery} />
      <div className="tm-repository-picker__list" role="group" aria-label={ariaLabel}>
        {filteredOptions.length > 0 ? (
          filteredOptions.map((option) => {
            const checked = selected.has(option.id);
            return (
              <label className="tm-repository-picker__option" key={option.id}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => toggle(option.id)}
                />
                <span className="tm-repository-picker__identity">
                  <strong>{option.name}</strong>
                  <span className="tm-repository-picker__path" title={option.path}>
                    {option.displayPath}
                  </span>
                </span>
                {option.status !== 'AVAILABLE' ? (
                  <span
                    className={`tm-repository-picker__availability tm-repository-picker__availability--${option.status.toLowerCase()}`}
                  >
                    <span aria-hidden="true" />
                    {formatRepositoryStatus(option.status)}
                  </span>
                ) : null}
              </label>
            );
          })
        ) : (
          <span className="tm-repository-picker__empty" role="status">
            No repositories found.
          </span>
        )}
      </div>
    </div>
  );
}

function RepositorySearch({
  query,
  disabled,
  autoFocus = false,
  onQueryChange
}: {
  query: string;
  disabled: boolean;
  autoFocus?: boolean;
  onQueryChange(query: string): void;
}) {
  return (
    <div className="tm-filefilter__search tm-repository-picker__search">
      <SearchIcon />
      <input
        type="search"
        value={query}
        placeholder="Search repositories"
        aria-label="Search repositories"
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
          }
        }}
      />
      {query ? (
        <button
          type="button"
          className="tm-filefilter__clear"
          aria-label="Clear repository search"
          disabled={disabled}
          onClick={() => onQueryChange('')}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

function formatRepositoryStatus(status: RepositoryOption['status']): string {
  return status.charAt(0) + status.slice(1).toLocaleLowerCase();
}

function SearchIcon() {
  return (
    <svg
      className="tm-filefilter__search-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`tm-repository-select__chevron ${
        open ? 'tm-repository-select__chevron--open' : ''
      }`}
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
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m5 12 4 4L19 6" />
    </svg>
  );
}
