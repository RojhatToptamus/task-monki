import { useEffect, useMemo, useState } from 'react';
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
  TestRunRecord,
  WorktreeRecord
} from '../../shared/contracts';
import {
  filterDiffFiles,
  parseGitDiffEvidence,
  parseGitDiffEvidenceForScope,
  type DiffFile,
  type DiffEvidenceScope,
  type DiffFileStatusFilter,
  type DiffLine
} from '../model/diffEvidence';
import { taskManagerApi } from '../api/taskManagerClient';
import { StatusChip } from './StatusBadge';
import { humanizeEnum } from './display';

interface EvidencePanelProps {
  run?: RunRecord;
  worktree?: WorktreeRecord;
  gitSnapshot?: GitSnapshotRecord;
  testRun?: TestRunRecord;
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
  test: string;
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

export function EvidencePanel({
  run,
  worktree,
  gitSnapshot,
  testRun,
  githubRepository,
  branchPublication,
  pullRequest,
  ciRollup,
  reviewRollup,
  mergeSnapshot,
  artifacts
}: EvidencePanelProps) {
  const [artifactText, setArtifactText] = useState<LoadedArtifacts>({ diff: '', test: '' });
  const [artifactError, setArtifactError] = useState<string | undefined>();
  const [loadingArtifacts, setLoadingArtifacts] = useState(false);
  const [selectedFileId, setSelectedFileId] = useState<string | undefined>();
  const [diffScope, setDiffScope] = useState<DiffEvidenceScope>('all');
  const [fileFilter, setFileFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<DiffFileStatusFilter>('all');
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);

  const diffArtifact = gitSnapshot?.diffArtifactId
    ? artifacts.find((artifact) => artifact.id === gitSnapshot.diffArtifactId)
    : undefined;
  const testStdoutArtifact = testRun
    ? artifacts.find((artifact) => artifact.id === testRun.stdoutArtifactId)
    : undefined;

  useEffect(() => {
    let canceled = false;

    async function loadArtifacts() {
      setArtifactError(undefined);
      setArtifactText({ diff: '', test: '' });
      setLoadingArtifacts(Boolean(diffArtifact || testStdoutArtifact));

      const next: LoadedArtifacts = { diff: '', test: '' };
      const errors: string[] = [];

      await Promise.all([
        diffArtifact
          ? taskManagerApi
              .readArtifact({ artifactId: diffArtifact.id })
              .then((text) => {
                next.diff = text;
              })
              .catch((error: unknown) => {
                errors.push(error instanceof Error ? error.message : 'Could not read diff.');
              })
          : Promise.resolve(),
        testStdoutArtifact
          ? taskManagerApi
              .readArtifact({ artifactId: testStdoutArtifact.id })
              .then((text) => {
                next.test = text;
              })
              .catch((error: unknown) => {
                errors.push(error instanceof Error ? error.message : 'Could not read test output.');
              })
          : Promise.resolve()
      ]);

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
    testStdoutArtifact?.id,
    testStdoutArtifact?.byteCount,
    testStdoutArtifact?.updatedAt
  ]);

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

  return (
    <>
      {artifactError ? <p className="form-error">{artifactError}</p> : null}

      <section className="tm-diffbrowser" aria-label="Changed files">
        <aside className="tm-diffbrowser__files">
          <div className="tm-diffbrowser__files-head">
            <h3>Changed files</h3>
            <span>{fileCountLabel(diffFiles.length, filteredDiffFiles.length, filterActive)}</span>
          </div>
          {diffArtifact ? (
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
                  <div className="tm-filefilter__menuwrap">
                    <button
                      type="button"
                      className={`tm-filefilter__button ${
                        statusFilter !== 'all' ? 'tm-filefilter__button--active' : ''
                      }`}
                      aria-label="Filter changed files by status"
                      aria-expanded={filterMenuOpen}
                      onClick={() => setFilterMenuOpen((open) => !open)}
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
                      <div className="tm-filefilter__menu" role="menu">
                        <div className="tm-filefilter__menu-title">File status</div>
                        {DIFF_STATUS_FILTERS.map((option) => (
                          <button
                            key={option.value}
                            type="button"
                            role="menuitemradio"
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
                  <div className="tm-diffbrowser__groups" role="listbox" aria-label="Changed files">
                    <div className="tm-diffgroup__head">
                      <svg
                        className="tm-diffgroup__chevron"
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
                      <span className={`tm-diffsource-dot tm-diffsource-dot--${diffScope}`} />
                      <strong>{diffContext.groupLabel}</strong>
                      <span>{filteredDiffFiles.length} files</span>
                      <span className="tm-diffgroup__stat">
                        <span>+{visibleTotals.additions}</span>
                        <span>-{visibleTotals.deletions}</span>
                      </span>
                    </div>
                    {filteredDiffFiles.map((file) => (
                      <DiffFileListItem
                        key={file.id}
                        file={file}
                        selected={selectedFile?.id === file.id}
                        onSelectFile={setSelectedFileId}
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
          ) : (
            <p className="tm-diffbrowser__empty">Refresh evidence to capture a diff artifact.</p>
          )}
        </aside>

        <div className="tm-diffviewer">
          {selectedFile ? (
            <DiffFileView file={selectedFile} context={diffContext} />
          ) : (
            <div className="tm-diffviewer__empty">
              <strong>{filterActive ? 'No matching files' : 'No files in this scope'}</strong>
              <span>
                {filterActive
                  ? 'Adjust the file filter to inspect the captured diff.'
                  : diffEmptyMessage(diffScope, false)}
              </span>
            </div>
          )}
        </div>
      </section>

      <section className="tm-evidence-summary" aria-label="Verified evidence">
        <div className="tm-evidence-summary__head">
          <div>
            <h3>Verified evidence</h3>
          </div>
          {run ? <span className="tm-evidence-summary__run">Run {run.id.slice(0, 8)}</span> : null}
        </div>

        {run || worktree || gitSnapshot || testRun || pullRequest ? (
          <div className="tm-evidence-summary__body">
            <div className="evidence-grid">
              {worktree ? <StatusChip label="Worktree" value={worktree.status} /> : null}
              {gitSnapshot ? <StatusChip label="Git" value={gitSnapshot.status} /> : null}
              {testRun ? <StatusChip label="Tests" value={testRun.status} /> : null}
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
                label="Tests"
                value={
                  testRun
                    ? `${humanizeEnum(testRun.status)} · exit ${
                        testRun.exitCode === undefined ? 'unknown' : String(testRun.exitCode)
                      }`
                    : 'not run'
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
          <p className="muted">Prepare a worktree to capture Git, diff, and test evidence.</p>
        )}
      </section>

      {testStdoutArtifact ? (
        <details className="tm-evidence-test">
          <summary>
            <span>Test output</span>
            <small>{testStdoutArtifact.byteCount.toLocaleString()} bytes</small>
          </summary>
          <pre>{artifactText.test || (loadingArtifacts ? 'Loading test output...' : 'No test output.')}</pre>
        </details>
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

function DiffFileListItem({
  file,
  selected,
  onSelectFile
}: {
  file: DiffFile;
  selected: boolean;
  onSelectFile(fileId: string): void;
}) {
  const { name, directory } = splitFilePath(file.path);
  return (
    <button
      type="button"
      className={`tm-difffile ${selected ? 'tm-difffile--selected' : ''}`}
      role="option"
      aria-selected={selected}
      onClick={() => onSelectFile(file.id)}
    >
      <span className={`tm-difffile__status tm-difffile__status--${file.status}`}>
        {statusShortLabel(file.status)}
      </span>
      <span className="tm-difffile__text">
        <span className="tm-difffile__name">{name}</span>
        <span className="tm-difffile__path">{directory}</span>
      </span>
      <span className="tm-difffile__sources" aria-hidden="true">
        {file.blocks.some((block) => block.source === 'committed') ? (
          <span className="tm-diffsource-dot tm-diffsource-dot--committed" />
        ) : null}
        {file.blocks.some((block) => block.source === 'staged' || block.source === 'unstaged') ? (
          <span className="tm-diffsource-dot tm-diffsource-dot--uncommitted" />
        ) : null}
      </span>
      <span className="tm-difffile__stat">
        <span>+{file.additions}</span>
        <span>-{file.deletions}</span>
      </span>
    </button>
  );
}

function DiffFileView({ file, context }: { file: DiffFile; context: DiffScopeContext }) {
  return (
    <>
      <div className="tm-diffviewer__head">
        <div className="tm-diffviewer__title">
          <span className={`tm-difffile__status tm-difffile__status--${file.status}`}>
            {statusShortLabel(file.status)}
          </span>
          <strong>{file.path}</strong>
          {file.oldPath ? <small>renamed from {file.oldPath}</small> : null}
        </div>
        <span className="tm-diffviewer__stat">
          <span>+{file.additions}</span>
          <span>-{file.deletions}</span>
        </span>
      </div>
      <div className="tm-diffviewer__compare">
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M8 7h12M8 7l3-3M8 7l3 3M16 17H4M16 17l-3-3M16 17l-3 3" />
        </svg>
        <strong>{context.label}</strong>
        <span>{context.comparison}</span>
      </div>
      <div className="tm-diffviewer__body">
        {file.blocks.map((block) => (
          <section className="tm-diffblock" key={block.id}>
            <div className={`tm-diffblock__label tm-diffblock__label--${block.source}`}>
              <span className={`tm-diffsource-dot tm-diffsource-dot--${block.source}`} />
              <strong>{blockTitle(block.source)}</strong>
              <span>{blockComparison(block.source, context)}</span>
            </div>
            <div className="tm-difflines">
              {block.lines
                .filter((line) => line.kind !== 'meta')
                .map((line, index) =>
                  line.kind === 'hunk' ? (
                    <DiffHunkRow key={`${block.id}:${index}`} line={line} />
                  ) : (
                    <DiffLineRow key={`${block.id}:${index}`} line={line} />
                  )
                )}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}

function DiffHunkRow({ line }: { line: DiffLine }) {
  return (
    <div className="tm-diffhunk">
      <code>{line.content}</code>
    </div>
  );
}

function DiffLineRow({ line }: { line: DiffLine }) {
  const { sign, code } = diffLineParts(line);
  return (
    <div className={`tm-diffline tm-diffline--${line.kind}`}>
      <span className="tm-diffline__num">{line.oldLine ?? ''}</span>
      <span className="tm-diffline__num">{line.newLine ?? ''}</span>
      <span className="tm-diffline__sign">{sign}</span>
      <code>{code || ' '}</code>
    </div>
  );
}

function diffLineParts(line: DiffLine): { sign: string; code: string } {
  if (line.kind === 'addition' && line.content.startsWith('+')) {
    return { sign: '+', code: line.content.slice(1) };
  }
  if (line.kind === 'deletion' && line.content.startsWith('-')) {
    return { sign: '-', code: line.content.slice(1) };
  }
  if (line.kind === 'context' && line.content.startsWith(' ')) {
    return { sign: '', code: line.content.slice(1) };
  }
  return { sign: '', code: line.content };
}

function fileCountLabel(total: number, visible: number, filterActive: boolean): string {
  if (filterActive) {
    return `${visible} of ${total} changes`;
  }
  return `${total} ${total === 1 ? 'change' : 'changes'}`;
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
  groupLabel: string;
  baseLabel: string;
  comparison: string;
}

function getDiffScopeContext(scope: DiffEvidenceScope, worktree?: WorktreeRecord): DiffScopeContext {
  const baseLabel = worktree?.baseRef ?? worktree?.baseSha.slice(0, 7) ?? 'base';
  switch (scope) {
    case 'committed':
      return {
        label: 'Committed',
        groupLabel: 'COMMITTED',
        baseLabel,
        comparison: `${baseLabel} → HEAD`
      };
    case 'uncommitted':
      return {
        label: 'Uncommitted',
        groupLabel: 'UNCOMMITTED',
        baseLabel,
        comparison: 'HEAD → local'
      };
    case 'all':
      return {
        label: 'All changes',
        groupLabel: 'ALL CHANGES',
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

function splitFilePath(path: string): { name: string; directory: string } {
  const slash = path.lastIndexOf('/');
  if (slash === -1) {
    return { name: path, directory: 'Root' };
  }
  return {
    name: path.slice(slash + 1),
    directory: path.slice(0, slash)
  };
}

function blockTitle(source: DiffLineBlockSource): string {
  switch (source) {
    case 'committed':
      return 'COMMITTED';
    case 'staged':
      return 'STAGED';
    case 'unstaged':
      return 'UNSTAGED';
    case 'local':
      return 'LOCAL';
  }
}

type DiffLineBlockSource = DiffFile['blocks'][number]['source'];

function blockComparison(source: DiffLineBlockSource, context: DiffScopeContext): string {
  switch (source) {
    case 'committed':
      return `${context.baseLabel} → HEAD`;
    case 'staged':
      return 'HEAD → staged';
    case 'unstaged':
      return 'staged → local';
    case 'local':
      return context.comparison;
  }
}
