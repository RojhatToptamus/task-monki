import { useEffect, useRef, useState } from 'react';
import { Check, GitCompareArrows, Search, X } from 'lucide-react';
import type { ExistingWorktree, ImportPreview } from '../../shared/contracts';
import { abbreviateHomePath } from '../model/repositories';
import { Tooltip } from './Tooltip';
import { formatStatusValue } from './display';

export function branchTaskTitle(branch?: string): string {
  return (branch?.split('/').at(-1) ?? '').replace(/[-_]+/g, ' ');
}

export function ImportWorkFields({
  checkouts, selected, locked, onSelect, query, onQuery, comparison, onComparison, commitRef, onCommitRef,
  preview, previewError, title, onTitle, repositoryName, onRetry
}: {
  checkouts?: { items: ExistingWorktree[]; error?: string };
  selected?: ExistingWorktree;
  locked: boolean;
  onSelect(path: string): void;
  query: string;
  onQuery(value: string): void;
  comparison: 'local' | 'head' | 'commit';
  onComparison(value: 'local' | 'head' | 'commit'): void;
  commitRef: string;
  onCommitRef(value: string): void;
  preview?: ImportPreview;
  previewError?: string;
  title: string;
  onTitle(value: string): void;
  repositoryName?: string;
  onRetry(): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const commitInputRef = useRef<HTMLInputElement>(null);
  const existingButtonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = checkouts?.items.filter((item) => item.worktreePath === selected?.worktreePath ||
    `${item.branchName ?? ''} ${item.worktreePath}`.toLowerCase().includes(normalizedQuery)) ?? [];
  const firstAvailablePath = filtered.find((item) => !item.unavailableReason)?.worktreePath;
  useEffect(() => {
    if (checkouts && checkouts.items.length > 4) searchRef.current?.focus();
  }, [checkouts]);
  useEffect(() => {
    if (comparison === 'commit') commitInputRef.current?.focus();
  }, [comparison]);
  useEffect(() => {
    const list = listRef.current;
    if (!list || !selected) return;
    const revealSelection = () => {
      const row = list.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!row) return;
      const bounds = list.getBoundingClientRect();
      const selectedBounds = row.getBoundingClientRect();
      if (selectedBounds.top < bounds.top) list.scrollTop += selectedBounds.top - bounds.top;
      else if (selectedBounds.bottom > bounds.bottom) list.scrollTop += selectedBounds.bottom - bounds.bottom;
    };
    revealSelection();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(revealSelection);
    observer.observe(list);
    return () => observer.disconnect();
  }, [query, selected, checkouts]);
  useEffect(() => {
    if (selected?.existingTaskId) existingButtonRef.current?.focus();
    return () => { searchRef.current?.focus(); };
  }, [selected?.existingTaskId]);

  if (selected?.existingTaskId) {
    return <div className="import-work__existing">
      <span className="import-work__existing-label"><Check size={16} />This checkout already has a task</span>
      <strong>{selected.existingTask?.title ?? 'Existing task'}</strong>
      <span className="import-work__meta">
        {selected.existingTask ? <span>{formatStatusValue(selected.existingTask.workflowPhase)}</span> : null}
        <span>{repositoryName}</span>
      </span>
      <code>{selected.branchName}</code>
      <code title={selected.worktreePath}>{selected.worktreePath}</code>
      <div className="import-work__existing-actions">
        <button ref={existingButtonRef} type="submit" className="primary-button" disabled={locked}>Open existing task</button>
        <button type="button" className="outline-button" disabled={locked}
          onClick={() => { onQuery(''); onSelect(''); }}>Pick another checkout</button>
      </div>
    </div>;
  }

  const previewMessage = !selected ? 'Choose a checkout to see its changes.'
    : comparison === 'commit' && !commitRef.trim() ? 'Enter a branch or commit to compare.'
    : previewError ?? preview?.unavailableReason
    ?? (preview ? preview.commitCount || preview.fileCount
      ? `${preview.commitCount} ${preview.commitCount === 1 ? 'commit' : 'commits'} and ${preview.fileCount} uncommitted ${preview.fileCount === 1 ? 'file' : 'files'}`
      : 'No commits or uncommitted files.' : 'Checking changes…');

  return <>
    <div className="field import-work__checkouts">
      <span className="field__header"><span>Checkout</span><small>{checkouts ? `${filtered.length} of ${checkouts.items.length}` : ''}</small></span>
      <div className="import-work__picker">
        <div className="import-work__search">
          <Search size={16} aria-hidden="true" />
          <input ref={searchRef} value={query} aria-label="Filter checkouts" placeholder="Filter by branch or folder"
            disabled={locked} onChange={(event) => onQuery(event.target.value)} onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault(); listRef.current?.querySelector<HTMLButtonElement>('[role="option"]:not(:disabled)')?.focus();
              }
              if (event.key === 'Enter') {
                event.preventDefault();
                const available = filtered.filter((item) => !item.unavailableReason &&
                  `${item.branchName ?? ''} ${item.worktreePath}`.toLowerCase().includes(normalizedQuery));
                if (available.length === 1) onSelect(available[0]!.worktreePath);
              }
            }} />
          {query ? <Tooltip label="Clear filter">
            <button type="button" className="tm-iconbtn" aria-label="Clear filter" disabled={locked}
              onClick={() => { onQuery(''); searchRef.current?.focus(); }}><X size={13} aria-hidden="true" /></button>
          </Tooltip> : null}
        </div>
        {/* A listbox, not a radio group: selecting a checkout loads its
            comparison and can open an existing task, so arrows only move focus
            and Space, Enter or a click selects. */}
        <div ref={listRef} className="import-work__list" role="listbox" aria-label="Checkout" onKeyDown={(event) => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)'));
          const index = rows.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
            : (index + (event.key === 'ArrowUp' ? -1 : 1) + rows.length) % rows.length;
          rows[next]?.focus();
        }}>
          {filtered.map((item) => <button key={item.worktreePath} type="button" role="option"
            className="import-work__checkout" aria-selected={selected?.worktreePath === item.worktreePath}
            aria-label={`${item.branchName ?? 'Detached HEAD'} · ${item.worktreePath}`}
            disabled={locked || Boolean(item.unavailableReason)}
            tabIndex={selected ? selected.worktreePath === item.worktreePath ? 0 : -1 : item.worktreePath === firstAvailablePath ? 0 : -1}
            title={item.unavailableReason ?? item.worktreePath} onClick={() => onSelect(item.worktreePath)}>
            <span className="import-work__radio" aria-hidden="true" />
            <span className="import-work__identity"><code>{item.branchName ?? 'Detached HEAD'}</code><small dir="ltr">{abbreviateHomePath(item.worktreePath)}</small></span>
            <span className="import-work__kind">{item.unavailableReason ? 'Unavailable' : item.isPrimary ? 'Primary' : 'Worktree'}</span>
            {item.unavailableReason ? <small className="import-work__unavailable">{item.unavailableReason}</small> : null}
          </button>)}
          {!checkouts ? <p className="import-work__empty" role="status">Loading checkouts…</p> : checkouts.error ?
            <p className="import-work__empty form-error" role="alert">{checkouts.error}</p> : !filtered.length ?
              <p className="import-work__empty">{checkouts.items.length ? 'No checkout matches. Registered worktrees only.' : 'No registered checkouts are available.'}</p> : null}
        </div>
      </div>
      {checkouts?.error ? <button type="button" className="ghost-button" disabled={locked} onClick={onRetry}>Retry</button> : null}
      <small>Import attaches this folder. Later agent work runs in it rather than a new copy.</small>
    </div>
    <div className="field">
      <span>Compare against</span>
      <div className="segmented import-work__comparison" role="group" aria-label="Compare against" onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (index + (event.key === 'ArrowLeft' ? -1 : 1) + buttons.length) % buttons.length;
        buttons[next]?.focus(); buttons[next]?.click();
      }}>
        {(['local', 'head', 'commit'] as const).map((value) => <button type="button" key={value}
          className="segmented__btn" aria-pressed={comparison === value} disabled={locked}
          onClick={() => onComparison(value)}>{value === 'local' ? 'Local branch' : value === 'head' ? 'HEAD' : 'A commit'}</button>)}
      </div>
      {comparison === 'commit' ? <input ref={commitInputRef} aria-label="Branch or commit" className="import-work__commit"
        placeholder="Branch or commit id" value={commitRef} disabled={locked}
        aria-invalid={Boolean(previewError)} onChange={(event) => onCommitRef(event.target.value)} /> : null}
      <div className="import-work__preview" aria-busy={Boolean(selected && !preview && !previewError && (comparison !== 'commit' || commitRef.trim()))}>
        <div className="import-work__preview-summary">
          <GitCompareArrows size={16} aria-hidden="true" />
          <div><p role={previewError || preview?.unavailableReason ? 'alert' : 'status'}>{previewMessage}</p>
            {preview ? <code title={preview.baseSha}>{preview.baseRef.replace(/^refs\/heads\//, '')} {preview.baseSha.slice(0, 8)} → {preview.headSha.slice(0, 8)}</code> : null}</div>
          {preview?.unavailableReason ? <button className="ghost-button" type="button" disabled={locked} onClick={onRetry}>Refresh</button> :
            preview && (preview.commitCount > 0 || preview.fileCount > 0) ? <button className="ghost-button" type="button"
            aria-expanded={expanded} aria-controls="import-change-list" onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Hide changes' : 'Show changes'}</button> : previewError ?
              <button className="ghost-button" type="button" disabled={locked} onClick={onRetry}>Retry</button> : null}
        </div>
        {expanded && preview ? <div className="import-work__changes" id="import-change-list">
          {preview.commits.map((commit) => <div className="import-work__change" key={commit.sha}>
            <code>{commit.sha.slice(0, 8)}</code><span>{commit.subject}</span></div>)}
          {!preview.commitCount ? <p>{preview.baseSha === preview.headSha
            ? 'No commits. The starting version is this checkout’s current commit.'
            : 'No commits after this comparison.'}</p> : null}
          {preview.files.map((file) => <div className="import-work__change" key={file.path}>
            <code>{file.status}</code><code>{file.path}</code>
            {file.additions !== undefined ? <code className="import-work__diffstat"><span>+{file.additions}</span><span>−{file.deletions}</span></code> : null}</div>)}
          {preview.commitCount > preview.commits.length || preview.fileCount > preview.files.length ?
            <p>Showing the first {preview.commits.length} commits and {preview.files.length} files.</p> : null}
        </div> : null}
      </div>
    </div>
    <div className="field">
      <span className="field__header"><label htmlFor="import-task-title">Title</label>{title !== branchTaskTitle(selected?.branchName) && selected?.branchName ?
        <button type="button" className="field__restore" disabled={locked} onClick={() => onTitle(branchTaskTitle(selected.branchName))}>Use branch</button> : null}</span>
      <input id="import-task-title" value={title} disabled={locked} placeholder="Short imperative summary" onChange={(event) => onTitle(event.target.value)} />
    </div>
  </>;
}
