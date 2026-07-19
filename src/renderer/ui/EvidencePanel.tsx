import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import type {
  ArtifactRecord,
  BranchPublicationRecord,
  CiRollupRecord,
  GitSnapshotRecord,
  GitHubRepositoryRecord,
  MergeSnapshotRecord,
  PullRequestSnapshotRecord,
  ReviewRollupRecord,
  RunRecord,
  WorktreeRecord
} from '../../shared/contracts';
import {
  buildDiffFileTree,
  filterDiffFiles,
  parseGitDiffEvidence,
  parseGitDiffEvidenceForScope,
  type DiffFile,
  type DiffEvidenceScope,
  type DiffFileStatusFilter,
  type DiffLine,
  type DiffTreeNode
} from '../model/diffEvidence';
import { taskManagerApi } from '../api/taskManagerClient';
import { openTargetMenuPosition } from '../model/openTargetMenu';
import { StatusChip } from './StatusBadge';
import { humanizeEnum } from './display';
import { OpenTargetContextMenu } from './OpenTargetMenu';
import type { OpenTargetRef } from '../../shared/contracts';
import {
  focusMenuItem,
  handleMenuBlur,
  handleMenuKeyDown,
  menuTriggerFocusTarget,
  type MenuFocusTarget
} from './menuKeyboard';

interface EvidencePanelProps {
  run?: RunRecord;
  worktree?: WorktreeRecord;
  gitSnapshot?: GitSnapshotRecord;
  githubRepository?: GitHubRepositoryRecord;
  branchPublication?: BranchPublicationRecord;
  pullRequest?: PullRequestSnapshotRecord;
  ciRollup?: CiRollupRecord;
  reviewRollup?: ReviewRollupRecord;
  mergeSnapshot?: MergeSnapshotRecord;
  artifacts: ArtifactRecord[];
}

interface LoadedArtifacts {
  diff: string;
}

const DIFF_STATUS_FILTERS: Array<{ value: DiffFileStatusFilter; label: string }> = [
  { value: 'all', label: 'All files' },
  { value: 'modified', label: 'Modified' },
  { value: 'added', label: 'Added' },
  { value: 'deleted', label: 'Deleted' },
  { value: 'renamed', label: 'Renamed' }
];

const DIFF_SCOPE_TABS: Array<{ value: DiffEvidenceScope; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'committed', label: 'Committed' },
  { value: 'uncommitted', label: 'Uncommitted' }
];

const DEFAULT_DIFF_BROWSER_HEIGHT = 640;
const MIN_DIFF_BROWSER_HEIGHT = 420;
const MAX_DIFF_BROWSER_HEIGHT = 1100;

export function EvidencePanel({
  run,
  worktree,
  gitSnapshot,
  githubRepository,
  branchPublication,
  pullRequest,
  ciRollup,
  reviewRollup,
  mergeSnapshot,
  artifacts
}: EvidencePanelProps) {
  const [artifactText, setArtifactText] = useState<LoadedArtifacts>({ diff: '' });
  const [artifactError, setArtifactError] = useState<string | undefined>();
  const [loadingArtifacts, setLoadingArtifacts] = useState(false);
  const [selectedFileId, setSelectedFileId] = useState<string | undefined>();
  const [diffScope, setDiffScope] = useState<DiffEvidenceScope>('all');
  const [fileFilter, setFileFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<DiffFileStatusFilter>('all');
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [pathMenu, setPathMenu] = useState<{
    target: OpenTargetRef;
    position: { x: number; y: number };
  }>();
  const [collapsedDirectoryIds, setCollapsedDirectoryIds] = useState<Set<string>>(() => new Set());
  const [filePanelCollapsed, setFilePanelCollapsed] = useState(false);
  const [diffBrowserHeight, setDiffBrowserHeight] = useState(DEFAULT_DIFF_BROWSER_HEIGHT);
  const resizeStateRef = useRef<{ startY: number; startHeight: number } | undefined>(undefined);
  const filterMenuRootRef = useRef<HTMLDivElement>(null);
  const filterMenuRef = useRef<HTMLDivElement>(null);
  const filterMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const filterMenuInitialFocusRef = useRef<MenuFocusTarget>('selected');

  const diffArtifact = gitSnapshot?.diffArtifactId
    ? artifacts.find((artifact) => artifact.id === gitSnapshot.diffArtifactId)
    : undefined;

  useEffect(() => {
    let canceled = false;

    async function loadArtifacts() {
      setArtifactError(undefined);
      setArtifactText({ diff: '' });

      setLoadingArtifacts(Boolean(diffArtifact));
      const next: LoadedArtifacts = { diff: '' };
      const errors: string[] = [];

      if (diffArtifact) {
        await taskManagerApi
          .readArtifact({ artifactId: diffArtifact.id })
          .then((text) => {
            next.diff = text;
          })
          .catch((error: unknown) => {
            errors.push(error instanceof Error ? error.message : 'Could not read diff.');
          });
      }

      if (!canceled) {
        setArtifactText(next);
        setArtifactError(errors.length ? errors.join('\n') : undefined);
        setLoadingArtifacts(false);
      }
    }

    void loadArtifacts();
    return () => {
      canceled = true;
    };
  }, [
    diffArtifact?.id,
    diffArtifact?.byteCount,
    diffArtifact?.updatedAt,
  ]);

  useEffect(() => {
    if (!filterMenuOpen) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      focusMenuItem(filterMenuRef.current, filterMenuInitialFocusRef.current);
    });
    const onPointerDown = (event: PointerEvent) => {
      if (!filterMenuRootRef.current?.contains(event.target as Node)) {
        setFilterMenuOpen(false);
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [filterMenuOpen]);

  const diffFilesByScope = useMemo(
    () => ({
      all: parseGitDiffEvidence(artifactText.diff),
      committed: parseGitDiffEvidenceForScope(artifactText.diff, 'committed'),
      uncommitted: parseGitDiffEvidenceForScope(artifactText.diff, 'uncommitted')
    }),
    [artifactText.diff]
  );
  const diffFiles = diffFilesByScope[diffScope];
  const hasDiffFiles = diffFilesByScope.all.length > 0;
  const filteredDiffFiles = useMemo(
    () => filterDiffFiles(diffFiles, { query: fileFilter, status: statusFilter }),
    [diffFiles, fileFilter, statusFilter]
  );
  const filterActive = fileFilter.trim().length > 0 || statusFilter !== 'all';
  const selectedFile =
    filteredDiffFiles.find((file) => file.id === selectedFileId) ?? filteredDiffFiles[0];
  const diffContext = getDiffScopeContext(diffScope, worktree);
  const visibleTotals = getDiffTotals(filteredDiffFiles);
  const fileTree = useMemo(() => buildDiffFileTree(filteredDiffFiles), [filteredDiffFiles]);
  const diffBrowserClassName = `tm-diffbrowser ${
    filePanelCollapsed ? 'tm-diffbrowser--files-collapsed' : ''
  }`;
  const diffBrowserStyle = {
    '--tm-diffbrowser-height': `${diffBrowserHeight}px`
  } as CSSProperties;
  const filePanelToggleLabel = filePanelCollapsed ? 'Expand file panel' : 'Collapse file panel';
  const showDiffViewerEmpty = filePanelCollapsed;

  function toggleDirectory(directoryId: string) {
    setCollapsedDirectoryIds((current) => {
      const next = new Set(current);
      if (next.has(directoryId)) {
        next.delete(directoryId);
      } else {
        next.add(directoryId);
      }
      return next;
    });
  }

  function resizeDiffBrowser(nextHeight: number) {
    setDiffBrowserHeight(
      clamp(nextHeight, MIN_DIFF_BROWSER_HEIGHT, MAX_DIFF_BROWSER_HEIGHT)
    );
  }

  function openPathMenu(
    relativePath: string,
    event: MouseEvent,
    line?: number
  ) {
    if (!worktree) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setPathMenu({
      target: {
        type: 'worktreeFile',
        taskId: worktree.taskId,
        worktreeId: worktree.id,
        relativePath,
        line
      },
      position: openTargetMenuPosition(event.clientX, event.clientY)
    });
  }

  return (
    <>
      {artifactError ? <p className="form-error">{artifactError}</p> : null}

      <section className={diffBrowserClassName} aria-label="Changed files" style={diffBrowserStyle}>
        <aside className="tm-diffbrowser__files">
          <div className="tm-diffbrowser__files-head">
            {!filePanelCollapsed ? (
              <div className="tm-diffbrowser__files-title">
                <h3>Changed files</h3>
                <span className="tm-diffbrowser__files-summary">
                  <span>{fileCountLabel(diffFiles.length, filteredDiffFiles.length, filterActive)}</span>
                  {filteredDiffFiles.length > 0 ? (
                    <DiffStat additions={visibleTotals.additions} deletions={visibleTotals.deletions} />
                  ) : null}
                </span>
              </div>
            ) : null}
          </div>
          {!filePanelCollapsed && diffArtifact ? (
            loadingArtifacts && !artifactText.diff ? (
              <p className="tm-diffbrowser__empty">Loading diff...</p>
            ) : hasDiffFiles ? (
              <>
                <div className="tm-diffscope-tabs" role="tablist" aria-label="Diff scope">
                  {DIFF_SCOPE_TABS.map((tab) => (
                    <button
                      key={tab.value}
                      type="button"
                      role="tab"
                      aria-selected={diffScope === tab.value}
                      className={diffScope === tab.value ? 'tm-diffscope-tabs__tab--active' : ''}
                      onClick={() => {
                        setDiffScope(tab.value);
                        setSelectedFileId(undefined);
                        setFilterMenuOpen(false);
                      }}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <div className="tm-filefilter">
                  <div className="tm-filefilter__search">
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
                    <input
                      type="search"
                      value={fileFilter}
                      placeholder="Filter files..."
                      aria-label="Filter changed files"
                      onChange={(event) => setFileFilter(event.target.value)}
                    />
                    {fileFilter.trim().length > 0 ? (
                      <button
                        type="button"
                        className="tm-filefilter__clear"
                        aria-label="Clear file filter"
                        onClick={() => setFileFilter('')}
                      >
                        ×
                      </button>
                    ) : null}
                  </div>
                  <div className="tm-filefilter__menuwrap" ref={filterMenuRootRef}>
                    <button
                      ref={filterMenuTriggerRef}
                      type="button"
                      className={`tm-filefilter__button ${
                        statusFilter !== 'all' ? 'tm-filefilter__button--active' : ''
                      }`}
                      aria-label="Filter changed files by status"
                      aria-haspopup="menu"
                      aria-expanded={filterMenuOpen}
                      aria-controls="diff-status-filter-menu"
                      onKeyDown={(event) => {
                        const target = menuTriggerFocusTarget(event.key);
                        if (!target) {
                          return;
                        }
                        event.preventDefault();
                        filterMenuInitialFocusRef.current = target;
                        if (filterMenuOpen) {
                          focusMenuItem(filterMenuRef.current, target);
                        } else {
                          setFilterMenuOpen(true);
                        }
                      }}
                      onClick={() => {
                        filterMenuInitialFocusRef.current = 'selected';
                        setFilterMenuOpen((open) => !open);
                      }}
                    >
                      <svg
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        aria-hidden="true"
                      >
                        <line x1="4" y1="7" x2="20" y2="7" />
                        <line x1="7" y1="12" x2="17" y2="12" />
                        <line x1="10" y1="17" x2="14" y2="17" />
                      </svg>
                    </button>
                    {filterMenuOpen ? (
                      <div
                        ref={filterMenuRef}
                        id="diff-status-filter-menu"
                        className="tm-filefilter__menu"
                        role="menu"
                        tabIndex={-1}
                        aria-label="File status"
                        onKeyDown={(event) =>
                          handleMenuKeyDown(event, {
                            onClose: () => setFilterMenuOpen(false),
                            returnFocus: filterMenuTriggerRef.current
                          })
                        }
                        onBlur={(event) =>
                          handleMenuBlur(event, () => setFilterMenuOpen(false))
                        }
                      >
                        <div className="tm-filefilter__menu-title" role="presentation">
                          File status
                        </div>
                        {DIFF_STATUS_FILTERS.map((option) => (
                          <button
                            key={option.value}
                            type="button"
                            role="menuitemradio"
                            tabIndex={-1}
                            aria-checked={statusFilter === option.value}
                            onClick={() => {
                              setStatusFilter(option.value);
                              setFilterMenuOpen(false);
                            }}
                          >
                            <span className="tm-filefilter__status-label">
                              <span
                                className={`tm-filefilter__status-dot tm-filefilter__status-dot--${option.value}`}
                                aria-hidden="true"
                              />
                              <span>{option.label}</span>
                            </span>
                            {statusFilter === option.value ? (
                              <svg
                                className="tm-filefilter__check"
                                width="13"
                                height="13"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.4"
                                aria-hidden="true"
                              >
                                <path d="M5 12l5 5L20 6" />
                              </svg>
                            ) : null}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>

                {filteredDiffFiles.length > 0 ? (
                  <div className="tm-diffbrowser__tree" role="tree" aria-label="Changed files">
                    {fileTree.children.map((node) => (
                      <DiffTreeRow
                        key={node.id}
                        node={node}
                        depth={0}
                        selectedFileId={selectedFile?.id}
                        collapsedDirectoryIds={collapsedDirectoryIds}
                        onToggleDirectory={toggleDirectory}
                        onSelectFile={setSelectedFileId}
                        onOpenPathMenu={openPathMenu}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="tm-diffbrowser__empty">
                    {diffEmptyMessage(diffScope, filterActive)}
                  </p>
                )}
              </>
            ) : (
              <p className="tm-diffbrowser__empty">No file changes in the captured diff.</p>
            )
          ) : !filePanelCollapsed ? (
            <p className="tm-diffbrowser__empty">Refresh evidence to capture a diff artifact.</p>
          ) : null}
        </aside>

        <div className="tm-diffviewer">
          {selectedFile ? (
            <DiffFileView
              file={selectedFile}
              context={diffContext}
              filePanelCollapsed={filePanelCollapsed}
              filePanelToggleLabel={filePanelToggleLabel}
              onToggleFilePanel={() => setFilePanelCollapsed((collapsed) => !collapsed)}
              onOpenPathMenu={openPathMenu}
            />
          ) : (
            <>
              <div className="tm-diffviewer__head tm-diffviewer__head--empty">
                <FilePanelToggleButton
                  collapsed={filePanelCollapsed}
                  label={filePanelToggleLabel}
                  onToggle={() => setFilePanelCollapsed((collapsed) => !collapsed)}
                />
              </div>
              {showDiffViewerEmpty ? (
                <div className="tm-diffviewer__empty">
                  <strong>{filterActive ? 'No matching files' : 'No files in this scope'}</strong>
                  <span>
                    {filterActive
                      ? 'Adjust the file filter to inspect the captured diff.'
                      : diffEmptyMessage(diffScope, false)}
                  </span>
                </div>
              ) : null}
            </>
          )}
        </div>
        <div
          className="tm-diffbrowser__resize"
          role="separator"
          aria-label="Resize diff browser"
          aria-orientation="horizontal"
          aria-valuemin={MIN_DIFF_BROWSER_HEIGHT}
          aria-valuemax={MAX_DIFF_BROWSER_HEIGHT}
          aria-valuenow={diffBrowserHeight}
          tabIndex={0}
          title="Resize diff browser"
          onPointerDown={(event) => {
            resizeStateRef.current = {
              startY: event.clientY,
              startHeight: diffBrowserHeight
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const resizeState = resizeStateRef.current;
            if (!resizeState) {
              return;
            }
            resizeDiffBrowser(resizeState.startHeight + event.clientY - resizeState.startY);
          }}
          onPointerUp={(event) => {
            resizeStateRef.current = undefined;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
          onPointerCancel={(event) => {
            resizeStateRef.current = undefined;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              resizeDiffBrowser(diffBrowserHeight + 32);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              resizeDiffBrowser(diffBrowserHeight - 32);
            } else if (event.key === 'Home') {
              event.preventDefault();
              resizeDiffBrowser(MIN_DIFF_BROWSER_HEIGHT);
            } else if (event.key === 'End') {
              event.preventDefault();
              resizeDiffBrowser(MAX_DIFF_BROWSER_HEIGHT);
            }
          }}
        >
          <span aria-hidden="true" />
        </div>
      </section>

      <details className="tm-evidence-summary" aria-label="Verified evidence">
        <summary className="tm-evidence-summary__head">
          <span className="tm-evidence-summary__title">
            <span className="tm-evidence-summary__caret" aria-hidden="true">›</span>
            <h3>Verified evidence</h3>
          </span>
          <span className="tm-evidence-summary__strip">
            {buildEvidenceStrip({ worktree, gitSnapshot, pullRequest })}
          </span>
          {run ? <span className="tm-evidence-summary__run">Run {run.id.slice(0, 8)}</span> : null}
        </summary>

        {run || worktree || gitSnapshot || pullRequest ? (
          <div className="tm-evidence-summary__body">
            <div className="evidence-grid">
              {worktree ? <StatusChip label="Worktree" value={worktree.status} /> : null}
              {gitSnapshot ? <StatusChip label="Git" value={gitSnapshot.status} /> : null}
              {githubRepository ? <StatusChip label="GitHub" value={githubRepository.status} /> : null}
              {branchPublication ? <StatusChip label="Publish" value={branchPublication.status} /> : null}
              {pullRequest ? <StatusChip label="PR" value={pullRequest.status} /> : null}
              {ciRollup ? <StatusChip label="Checks" value={ciRollup.status} /> : null}
              {reviewRollup ? <StatusChip label="Reviews" value={reviewRollup.status} /> : null}
              {mergeSnapshot ? <StatusChip label="Merge" value={mergeSnapshot.status} /> : null}
            </div>

            <div className="tm-evidence-facts">
              <EvidenceFact label="Head" value={gitSnapshot?.headSha?.slice(0, 12) ?? 'unknown'} />
              <EvidenceFact
                label="Dirty fingerprint"
                value={gitSnapshot?.dirtyFingerprint.slice(0, 12) ?? 'unknown'}
              />
              <EvidenceFact
                label="Changed files"
                value={
                  gitSnapshot
                    ? `committed ${gitSnapshot.committedDiffFileCount}, working ${gitSnapshot.workingDiffFileCount}`
                    : 'unknown'
                }
              />
              <EvidenceFact
                label="Remote"
                value={
                  githubRepository?.owner && githubRepository.repo
                    ? `${githubRepository.owner}/${githubRepository.repo}`
                    : githubRepository?.status
                      ? humanizeEnum(githubRepository.status)
                      : 'not checked'
                }
              />
              <EvidenceFact
                label="Pull request"
                value={pullRequest?.url ?? pullRequest?.status ?? 'not created'}
              />
            </div>
          </div>
        ) : (
          <p className="muted">Prepare a worktree to capture Git and diff evidence.</p>
        )}
      </details>
      {pathMenu ? (
        <OpenTargetContextMenu
          target={pathMenu.target}
          position={pathMenu.position}
          onClose={() => setPathMenu(undefined)}
        />
      ) : null}
    </>
  );
}

function EvidenceFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="tm-evidence-fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

/**
 * One-line evidence summary shown on the collapsed strip (audit §03 Evidence):
 * the panel is ~200px of mostly-static facts, so the closed state carries just
 * the load-bearing ones and the full grid expands on demand.
 */
function buildEvidenceStrip({
  worktree,
  gitSnapshot,
  pullRequest
}: {
  worktree?: WorktreeRecord;
  gitSnapshot?: GitSnapshotRecord;
  pullRequest?: PullRequestSnapshotRecord;
}): string {
  const parts: string[] = [];
  if (worktree) {
    parts.push(`Worktree ${humanizeEnum(worktree.status)}`);
  }
  if (gitSnapshot) {
    parts.push(`Git ${humanizeEnum(gitSnapshot.status)}`);
  }
  if (gitSnapshot?.headSha) {
    parts.push(`Head ${gitSnapshot.headSha.slice(0, 7)}`);
  }
  parts.push(pullRequest?.status ? `PR ${humanizeEnum(pullRequest.status)}` : 'PR not created');
  return parts.join(' · ');
}

function DiffTreeRow({
  node,
  depth,
  selectedFileId,
  collapsedDirectoryIds,
  onToggleDirectory,
  onSelectFile,
  onOpenPathMenu
}: {
  node: DiffTreeNode;
  depth: number;
  selectedFileId?: string;
  collapsedDirectoryIds: Set<string>;
  onToggleDirectory(directoryId: string): void;
  onSelectFile(fileId: string): void;
  onOpenPathMenu?(relativePath: string, event: MouseEvent): void;
}) {
  const rowStyle = {
    '--tm-difftree-indent': `${depth * 14}px`
  } as CSSProperties;

  if (node.type === 'directory') {
    const collapsed = collapsedDirectoryIds.has(node.id);
    return (
      <div className="tm-difftree__group" role="none">
        <button
          type="button"
          className="tm-difftree__row tm-difftree__row--directory"
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded={!collapsed}
          style={rowStyle}
          onClick={() => onToggleDirectory(node.id)}
          onContextMenu={(event) => onOpenPathMenu?.(node.path, event)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' && collapsed) {
              event.preventDefault();
              onToggleDirectory(node.id);
            } else if (event.key === 'ArrowLeft' && !collapsed) {
              event.preventDefault();
              onToggleDirectory(node.id);
            }
          }}
        >
          <ChevronIcon className="tm-difftree__chevron" />
          <span className="tm-difftree__folder" aria-hidden="true" />
          <span className="tm-difftree__name">{node.name}</span>
          <span className="tm-difftree__count">{fileCountShortLabel(node.fileCount)}</span>
          <DiffStat additions={node.additions} deletions={node.deletions} />
        </button>
        {!collapsed ? (
          <div role="group">
            {node.children.map((child) => (
              <DiffTreeRow
                key={child.id}
                node={child}
                depth={depth + 1}
                selectedFileId={selectedFileId}
                collapsedDirectoryIds={collapsedDirectoryIds}
                onToggleDirectory={onToggleDirectory}
                onSelectFile={onSelectFile}
                onOpenPathMenu={onOpenPathMenu}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  const selected = selectedFileId === node.file.id;
  return (
    <button
      type="button"
      className={`tm-difftree__row tm-difftree__row--file ${
        selected ? 'tm-difftree__row--selected' : ''
      }`}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected}
      style={rowStyle}
      title={node.path}
      onClick={() => onSelectFile(node.file.id)}
      onContextMenu={(event) => onOpenPathMenu?.(node.file.path, event)}
    >
      <span className="tm-difftree__spacer" aria-hidden="true" />
      <StatusIcon status={node.file.status} />
      <span className="tm-difftree__name tm-difftree__name--file">{node.name}</span>
      <span className="tm-difftree__count" aria-hidden="true" />
      <DiffStat additions={node.additions} deletions={node.deletions} />
    </button>
  );
}

function DiffFileView({
  file,
  context,
  filePanelCollapsed,
  filePanelToggleLabel,
  onToggleFilePanel,
  onOpenPathMenu
}: {
  file: DiffFile;
  context: DiffScopeContext;
  filePanelCollapsed: boolean;
  filePanelToggleLabel: string;
  onToggleFilePanel(): void;
  onOpenPathMenu?(relativePath: string, event: MouseEvent, line?: number): void;
}) {
  return (
    <>
      <div className="tm-diffviewer__head">
        <FilePanelToggleButton
          collapsed={filePanelCollapsed}
          label={filePanelToggleLabel}
          onToggle={onToggleFilePanel}
        />
        <div className="tm-diffviewer__identity">
          <StatusIcon status={file.status} />
          <span
            className="tm-diffviewer__titletext"
            onContextMenu={(event) => onOpenPathMenu?.(file.path, event)}
          >
            <strong>{file.path}</strong>
            <small>
              {context.label} · {context.comparison}
              {file.oldPath ? ` · renamed from ${file.oldPath}` : ''}
            </small>
          </span>
        </div>
        <div className="tm-diffviewer__actions">
          <DiffStat additions={file.additions} deletions={file.deletions} />
        </div>
      </div>
      <div className="tm-diffviewer__body">
        {file.blocks.map((block) => (
          <section className="tm-diffblock" key={block.id}>
            <div className={`tm-diffblock__label tm-diffblock__label--${block.source}`}>
              <span className={`tm-diffsource-dot tm-diffsource-dot--${block.source}`} />
              <strong>{blockTitle(block.source)}</strong>
              <span>{diffBlockLineCount(block.lines)}</span>
            </div>
            <div className="tm-difflines">
              {block.lines
                .filter((line) => line.kind !== 'meta')
                .map((line, index) =>
                  line.kind === 'hunk' ? (
                    <DiffHunkRow key={`${block.id}:${index}`} line={line} />
                  ) : (
                    <DiffLineRow
                      key={`${block.id}:${index}`}
                      line={line}
                      file={file}
                      onOpenPathMenu={onOpenPathMenu}
                    />
                  )
                )}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}

function FilePanelToggleButton({
  collapsed,
  label,
  onToggle
}: {
  collapsed: boolean;
  label: string;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      className="tm-diffbrowser__pane-toggle tm-diffbrowser__pane-toggle--viewer"
      aria-label={label}
      aria-expanded={!collapsed}
      title={label}
      onClick={onToggle}
    >
      <PanelToggleIcon collapsed={collapsed} />
    </button>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function PanelToggleIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M10 5v14" />
      <path d={collapsed ? 'M14 9l3 3-3 3' : 'M17 9l-3 3 3 3'} />
    </svg>
  );
}

function StatusIcon({ status }: { status: DiffFile['status'] }) {
  return (
    <span className={`tm-difffile__status tm-difffile__status--${status}`}>
      {statusShortLabel(status)}
    </span>
  );
}

function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="tm-diffstat">
      <span>+{additions}</span>
      <span>-{deletions}</span>
    </span>
  );
}

function DiffHunkRow({ line }: { line: DiffLine }) {
  return (
    <div className="tm-diffhunk">
      <code>{line.content}</code>
    </div>
  );
}

function DiffLineRow({
  line,
  file,
  onOpenPathMenu
}: {
  line: DiffLine;
  file: DiffFile;
  onOpenPathMenu?(relativePath: string, event: MouseEvent, line?: number): void;
}) {
  const code = diffLineCode(line);
  const targetLine = line.newLine ?? line.oldLine;
  return (
    <div
      className={`tm-diffline tm-diffline--${line.kind}`}
      onContextMenu={(event) => onOpenPathMenu?.(file.path, event, targetLine)}
    >
      <span className="tm-diffline__num">{line.oldLine ?? ''}</span>
      <span className="tm-diffline__num">{line.newLine ?? ''}</span>
      <code>{code || ' '}</code>
    </div>
  );
}

function diffLineCode(line: DiffLine): string {
  if (line.kind === 'addition' && line.content.startsWith('+')) {
    return line.content.slice(1);
  }
  if (line.kind === 'deletion' && line.content.startsWith('-')) {
    return line.content.slice(1);
  }
  if (line.kind === 'context' && line.content.startsWith(' ')) {
    return line.content.slice(1);
  }
  return line.content;
}

function fileCountLabel(total: number, visible: number, filterActive: boolean): string {
  if (filterActive) {
    return `${visible} / ${total} files`;
  }
  return fileCountShortLabel(total);
}

function fileCountShortLabel(count: number): string {
  return `${count} ${count === 1 ? 'file' : 'files'}`;
}

function diffEmptyMessage(scope: DiffEvidenceScope, filterActive: boolean): string {
  if (filterActive) {
    return 'No files match the current filter.';
  }
  switch (scope) {
    case 'committed':
      return 'No committed changes in this snapshot.';
    case 'uncommitted':
      return 'No uncommitted changes in this snapshot.';
    case 'all':
      return 'No file changes in this snapshot.';
  }
}

function statusShortLabel(status: DiffFile['status']): string {
  switch (status) {
    case 'added':
      return 'A';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'modified':
      return 'M';
  }
}

interface DiffScopeContext {
  label: string;
  baseLabel: string;
  comparison: string;
}

function getDiffScopeContext(scope: DiffEvidenceScope, worktree?: WorktreeRecord): DiffScopeContext {
  const baseLabel = worktree?.baseRef ?? worktree?.baseSha.slice(0, 7) ?? 'base';
  switch (scope) {
    case 'committed':
      return {
        label: 'Committed',
        baseLabel,
        comparison: `${baseLabel} → HEAD`
      };
    case 'uncommitted':
      return {
        label: 'Uncommitted',
        baseLabel,
        comparison: 'HEAD → local'
      };
    case 'all':
      return {
        label: 'All changes',
        baseLabel,
        comparison: `${baseLabel} → local`
      };
  }
}

function getDiffTotals(files: DiffFile[]): { additions: number; deletions: number } {
  return files.reduce(
    (total, file) => ({
      additions: total.additions + file.additions,
      deletions: total.deletions + file.deletions
    }),
    { additions: 0, deletions: 0 }
  );
}

function blockTitle(source: DiffLineBlockSource): string {
  switch (source) {
    case 'committed':
      return 'Committed';
    case 'staged':
      return 'Staged';
    case 'unstaged':
      return 'Unstaged';
    case 'local':
      return 'Local';
  }
}

type DiffLineBlockSource = DiffFile['blocks'][number]['source'];

function diffBlockLineCount(lines: DiffLine[]): string {
  const changedLineCount = lines.filter(
    (line) => line.kind === 'addition' || line.kind === 'deletion'
  ).length;
  return `${changedLineCount} ${changedLineCount === 1 ? 'change' : 'changes'}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
