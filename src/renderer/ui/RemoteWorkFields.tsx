import { useEffect, useRef } from 'react';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import {
  formatRemoteWorkNumber,
  remoteWorkLabel,
  sameRemoteRepository,
  type RemoteProvider,
  type RemoteRepositoryRef,
  type RemoteWorkKind,
  type RemoteWorkListing,
  type RemoteWorkSummary
} from '../../shared/contracts';
import { ActionMenu } from './ActionMenu';
import { StatusGlyph } from './StatusBadge';
import { Tooltip } from './Tooltip';
import { formatStatusValue } from './display';
import { formatShortAge } from '../model/timeAgo';

/**
 * Open issues or pull requests of the checkout's remote repository: one list,
 * searched on the platform, that also takes a pasted link or number.
 */
export function RemoteWorkFields({
  kind, provider: checkoutProvider, listing, loading, error, selected, locked, query, onQuery, onSelect, onRemote, onRetry, repositoryName
}: {
  kind: RemoteWorkKind;
  /** The checkout's platform, which names things while the list loads. */
  provider: RemoteProvider;
  listing?: RemoteWorkListing;
  loading: boolean;
  /** The request itself failed; a platform problem arrives as `listing.unavailable`. */
  error?: string;
  selected?: RemoteWorkSummary;
  locked: boolean;
  query: string;
  onQuery(value: string): void;
  onSelect(item: RemoteWorkSummary | undefined): void;
  onRemote(remote: RemoteRepositoryRef): void;
  onRetry(): void;
  repositoryName?: string;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const existingButtonRef = useRef<HTMLButtonElement>(null);
  const provider = listing?.remote?.provider ?? checkoutProvider;
  const label = remoteWorkLabel(provider, kind);
  const items = listing?.items ?? [];
  const problem = error ?? listing?.unavailable?.message;
  const code = error ? 'FAILED' : listing?.unavailable?.code;
  // A query names another item or repository: searching again is the way out.
  const queryProblem = code === 'OTHER_REPOSITORY' || code === 'WRONG_KIND' || code === 'NOT_FOUND';
  const retryable = Boolean(problem) && !queryProblem && code !== 'NO_REMOTE';
  // A problem no search can fix holds the field; a failed request may be the query's own, so the field stays open.
  const searchCannotHelp = code === 'NO_REMOTE' || code === 'CLI_MISSING' || code === 'SIGNED_OUT';
  const signIn = code === 'SIGNED_OUT' ? `${provider === 'GITLAB' ? 'glab' : 'gh'} auth login` : undefined;
  useEffect(() => {
    if (selected?.existingTaskId) existingButtonRef.current?.focus();
  }, [selected?.existingTaskId]);

  if (selected?.existingTaskId) {
    return <div className="import-work__existing">
      <span className="import-work__existing-label"><Check size={16} />This {label.toLowerCase()} already has a task</span>
      <strong>{selected.existingTaskTitle ?? 'Existing task'}</strong>
      <span className="import-work__meta">
        {selected.existingTaskPhase ? <span>{formatStatusValue(selected.existingTaskPhase)}</span> : null}
        <span>{repositoryName}</span>
      </span>
      <code>{selected.ref.repository.path}{formatRemoteWorkNumber(provider, kind, selected.ref.number)}</code>
      <div className="import-work__existing-actions">
        <button ref={existingButtonRef} type="submit" className="primary-button" disabled={locked}>Open existing task</button>
        <button type="button" className="outline-button" disabled={locked}
          onClick={() => { onSelect(undefined); searchRef.current?.focus(); }}>Pick another {label.toLowerCase()}</button>
      </div>
    </div>;
  }

  const repositories = listing?.repositories ?? [];
  const remote = listing?.remote;
  return <div className="field import-work__checkouts">
    <span className="field__header remote-work__header">
      <span>{label}</span>
      {remote && repositories.length > 1 ? (
        <ActionMenu className="tm-composer-chip" selection="single" side="bottom" align="end" label="Remote repository"
          disabled={locked}
          trigger={<><span>{remote.path}</span><ChevronDown size={13} aria-hidden="true" /></>}
          items={repositories.map((option) => ({
            id: `${option.host}/${option.path}`,
            label: option.path,
            meta: option.remoteName,
            pressed: sameRemoteRepository(option, remote),
            onSelect: () => onRemote(option)
          }))} />
      ) : remote ? <small>{remote.path}</small> : null}
    </span>
    <div className="import-work__picker">
      <div className="import-work__search">
        <Search size={16} aria-hidden="true" />
        <input ref={searchRef} value={query} aria-label={`Search ${label.toLowerCase()}s`} placeholder="Search or paste a link"
          disabled={locked || searchCannotHelp} onChange={(event) => onQuery(event.target.value)} onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              listRef.current?.querySelector<HTMLButtonElement>('[role="option"]')?.focus();
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              if (items.length === 1) onSelect(items[0]);
            }
          }} />
        {query ? <Tooltip label="Clear search">
          <button type="button" className="tm-iconbtn" aria-label="Clear search" disabled={locked}
            onClick={() => { onQuery(''); searchRef.current?.focus(); }}><X size={13} aria-hidden="true" /></button>
        </Tooltip> : null}
      </div>
      {/* A listbox like the checkout list: arrows move focus; Space, Enter or a click selects. */}
      <div ref={listRef} className="import-work__list" role="listbox" aria-label={label} aria-busy={loading}
        onKeyDown={(event) => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'));
          const index = rows.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
            : (index + (event.key === 'ArrowUp' ? -1 : 1) + rows.length) % rows.length;
          rows[next]?.focus();
        }}>
        {items.map((item, index) => {
          const number = formatRemoteWorkNumber(provider, kind, item.ref.number);
          const forkOwner = item.crossRepository ? item.headRepositoryPath?.split('/')[0] : undefined;
          const isSelected = Boolean(selected && sameRemoteRepository(selected.ref.repository, item.ref.repository) && selected.ref.number === item.ref.number);
          return <button key={`${item.ref.repository.path}${number}`} type="button" role="option"
            className="import-work__checkout" aria-selected={isSelected}
            aria-label={`${number} ${item.title}${item.checks ? `, ${CHECK_WORDS[item.checks].toLowerCase()}` : ''}`} disabled={locked}
            tabIndex={selected ? (isSelected ? 0 : -1) : index === 0 ? 0 : -1}
            onClick={() => onSelect(item)}>
            <span className="import-work__radio" aria-hidden="true" />
            <span className="remote-work__identity">
              <span className="remote-work__title" title={item.title}><span className="remote-work__number">{number}</span>{item.title}</span>
              <small className="remote-work__meta">
                {/* A fork's head reads as the platform writes it, owner:branch; that names the fork. */}
                {kind === 'PULL_REQUEST' && item.headRefName ? <code>{forkOwner ? `${forkOwner}:` : ''}{item.headRefName}</code> : null}
                {item.author ? <span>{item.author}</span> : null}
                {item.updatedAt ? <span>{formatShortAge(item.updatedAt)}</span> : null}
                {/* How its head's checks ended, as a mark among its facts: the word at the row's end is for its reviews. */}
                {item.checks ? <span className="remote-work__checks">
                  <StatusGlyph kind={item.checks === 'FAILING' ? 'blocked' : item.checks === 'PENDING' ? 'working' : 'verified'} />
                </span> : null}
              </small>
            </span>
            <span className="import-work__kind" data-tone={!item.existingTaskId && !item.draft ? REVIEW_TONES[item.review ?? ''] : undefined}>
              {item.existingTaskId ? 'Has task' : item.draft ? 'Draft' : item.review && item.review !== 'REVIEW_REQUIRED' ? REVIEW_WORDS[item.review]
                : item.crossRepository && !forkOwner ? 'Fork' : ''}
            </span>
          </button>;
        })}
        {problem ? <div className="tm-error remote-work__problem" role="alert">
          <span>{problem}{signIn ? <> Run <code>{signIn}</code>.</> : null}</span>
          {retryable ? <button type="button" className="ghost-button button--sm" disabled={locked} onClick={onRetry}>Retry</button> : null}
        </div>
          : loading && items.length === 0 ? <p className="import-work__empty" role="status">Loading {label.toLowerCase()}s…</p>
          : !loading && items.length === 0 ? <p className="import-work__empty">{query.trim() ? `No ${label.toLowerCase()} matches` : `No open ${label.toLowerCase()}s`}</p>
          : null}
      </div>
    </div>
  </div>;
}

const CHECK_WORDS: Record<NonNullable<RemoteWorkSummary['checks']>, string> = {
  FAILING: 'Checks failed',
  PENDING: 'Checks pending',
  PASSING: 'Checks passed'
};
const REVIEW_WORDS: Record<NonNullable<RemoteWorkSummary['review']>, string> = {
  CHANGES_REQUESTED: 'Changes requested',
  APPROVED: 'Approved',
  REVIEW_REQUIRED: 'Review required'
};
const REVIEW_TONES: Record<string, string | undefined> = { CHANGES_REQUESTED: 'error', APPROVED: 'success' };
