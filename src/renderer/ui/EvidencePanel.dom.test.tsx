import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ArtifactRecord,
  CiRollupRecord,
  GitSnapshotRecord,
  PullRequestSnapshotRecord
} from '../../shared/contracts';
import { EvidencePanel } from './EvidencePanel';

const api = vi.hoisted(() => ({
  readArtifact: vi.fn()
}));

vi.mock('../api/taskManagerClient', () => ({
  taskManagerApi: {
    readArtifact: api.readArtifact
  }
}));

describe('EvidencePanel captured diff states', () => {
  beforeEach(() => {
    api.readArtifact.mockReset();
  });

  it('does not report no changes when the captured diff cannot be read', async () => {
    api.readArtifact.mockRejectedValueOnce(new Error('artifact unavailable'));
    render(
      <EvidencePanel
        gitSnapshot={gitSnapshotFixture()}
        artifacts={[artifactFixture()]}
      />
    );

    expect(
      await screen.findByText(/Could not read captured diff: artifact unavailable/)
    ).toBeDefined();
    expect(screen.getByText('Captured diff unavailable.')).toBeDefined();
    expect(screen.queryByText('No file changes in the captured diff.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse file panel' }));
    expect(screen.getByText('Captured diff unavailable.')).toBeDefined();
    expect(screen.queryByText('No changes in this snapshot.')).toBeNull();
    expect(screen.queryByText('No files in this scope')).toBeNull();
  });

  it('does not turn an incomplete capture without parsed paths into a complete empty state', async () => {
    api.readArtifact.mockResolvedValueOnce(
      '# Git diff evidence\n\n## Committed diff unavailable\n\ngit failed\n'
    );
    render(
      <EvidencePanel
        gitSnapshot={gitSnapshotFixture()}
        artifacts={[artifactFixture()]}
      />
    );

    expect(await screen.findByText(/Incomplete captured diff/)).toBeDefined();
    expect(
      screen.getByText('No paths could be confirmed from the incomplete captured diff.')
    ).toBeDefined();
    expect(screen.queryByText('No file changes in the captured diff.')).toBeNull();
  });

  it('does not claim an empty scope when the overall capture is incomplete', async () => {
    api.readArtifact.mockResolvedValueOnce(`${diffEvidenceFor('src/observed.ts')}
## Additional section unavailable

git failed
`);
    render(
      <EvidencePanel
        gitSnapshot={gitSnapshotFixture()}
        artifacts={[artifactFixture()]}
      />
    );

    expect(await screen.findByText(/Incomplete captured diff/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Uncommitted' }));

    expect(
      screen.getByText('No paths confirmed in this scope; coverage is unknown.')
    ).toBeDefined();
    expect(screen.queryByText('No uncommitted changes in this snapshot.')).toBeNull();
  });

  it('uses the empty state only after a complete captured diff is read', async () => {
    api.readArtifact.mockResolvedValueOnce(emptyDiffEvidence());
    render(
      <EvidencePanel
        gitSnapshot={gitSnapshotFixture()}
        artifacts={[artifactFixture()]}
      />
    );

    expect(await screen.findByText('No file changes in the captured diff.')).toBeDefined();
    expect(screen.queryByText(/Actual changes are Unknown/)).toBeNull();
  });

  it('does not show paths from a previous artifact while the next artifact loads', async () => {
    const secondArtifact = deferred<string>();
    api.readArtifact
      .mockResolvedValueOnce(diffEvidenceFor('src/first.ts'))
      .mockReturnValueOnce(secondArtifact.promise);
    const { rerender } = render(
      <EvidencePanel
        gitSnapshot={gitSnapshotFixture()}
        artifacts={[artifactFixture()]}
      />
    );

    expect(await screen.findByText('first.ts')).toBeDefined();

    rerender(
      <EvidencePanel
        gitSnapshot={gitSnapshotFixture({ id: 'git-2', diffArtifactId: 'diff-2' })}
        artifacts={[artifactFixture({ id: 'diff-2' })]}
      />
    );

    expect(screen.queryByText('first.ts')).toBeNull();
    expect(screen.getByText('Loading diff...')).toBeDefined();

    await act(async () => {
      secondArtifact.resolve(diffEvidenceFor('src/second.ts'));
      await secondArtifact.promise;
    });

    expect(screen.getByText('second.ts')).toBeDefined();
    expect(screen.queryByText('first.ts')).toBeNull();
  });

  it('labels a historical capture and hides current delivery evidence', async () => {
    api.readArtifact.mockResolvedValueOnce(emptyDiffEvidence());
    render(
      <EvidencePanel
        gitSnapshot={gitSnapshotFixture()}
        historicalCapture
        pullRequest={pullRequestFixture()}
        artifacts={[artifactFixture()]}
      />
    );

    expect(await screen.findByText('Historical Git capture')).toBeDefined();
    expect(screen.getByText(/Head aaaaaaaaaaaa/)).toBeDefined();
    expect(screen.getByText('Historical Git evidence')).toBeDefined();
    expect(screen.queryByText('https://github.com/example/repo/pull/7')).toBeNull();
    expect(screen.queryByText(/PR Open/)).toBeNull();
  });

  it('labels current records as observed and marks mismatched CI evidence stale', async () => {
    api.readArtifact.mockResolvedValueOnce(emptyDiffEvidence());
    render(
      <EvidencePanel
        gitSnapshot={gitSnapshotFixture()}
        pullRequest={pullRequestFixture({ headRefOid: 'current-head' })}
        ciRollup={ciRollupFixture({ headSha: 'old-head', status: 'PASSING' })}
        artifacts={[artifactFixture()]}
      />
    );

    expect(await screen.findByText('No file changes in the captured diff.')).toBeDefined();
    expect(screen.getByText('Observed evidence')).toBeDefined();
    expect(screen.getByText(/PR Open$/)).toBeDefined();
    expect(screen.queryByText(/PR Open ready/)).toBeNull();
    expect(screen.getByText('Stale')).toBeDefined();
    expect(screen.queryByText('Verified evidence')).toBeNull();
  });
});

function gitSnapshotFixture(overrides: Partial<GitSnapshotRecord> = {}): GitSnapshotRecord {
  return {
    id: 'git-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    worktreePath: '/tmp/worktree',
    repoRoot: '/tmp/repository',
    gitCommonDir: '/tmp/repository/.git',
    headSha: 'a'.repeat(40),
    branch: 'codex/task-1',
    baseRef: 'main',
    baseSha: 'b'.repeat(40),
    aheadCount: 0,
    behindCount: 0,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    conflictedCount: 0,
    commitsAheadOfBase: 0,
    committedDiffFileCount: 0,
    workingDiffFileCount: 0,
    diffStat: 'No diff stat.',
    dirtyFingerprint: 'clean',
    status: 'CLEAN',
    capturedAt: '2026-07-07T10:10:00.000Z',
    diffArtifactId: 'diff-1',
    ...overrides
  };
}

function artifactFixture(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id: 'diff-1',
    taskId: 'task-1',
    kind: 'diff',
    path: '/tmp/diff-1.md',
    byteCount: 256,
    createdAt: '2026-07-07T10:10:00.000Z',
    updatedAt: '2026-07-07T10:10:00.000Z',
    ...overrides
  };
}

function pullRequestFixture(
  overrides: Partial<PullRequestSnapshotRecord> = {}
): PullRequestSnapshotRecord {
  return {
    id: 'pr-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    number: 7,
    url: 'https://github.com/example/repo/pull/7',
    status: 'OPEN_READY',
    observedAt: '2026-07-07T10:20:00.000Z',
    ...overrides
  };
}

function ciRollupFixture(overrides: Partial<CiRollupRecord> = {}): CiRollupRecord {
  return {
    id: 'ci-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    pullRequestNumber: 7,
    headSha: 'current-head',
    status: 'PASSING',
    requiredStatus: 'UNKNOWN',
    totalCount: 1,
    pendingCount: 0,
    passingCount: 1,
    failingCount: 0,
    skippedCount: 0,
    canceledCount: 0,
    checkDetails: [],
    observedAt: '2026-07-07T10:20:00.000Z',
    ...overrides
  };
}

function emptyDiffEvidence(): string {
  return `# Git diff evidence

## Committed diff

No committed diff.

## Staged diff

No staged diff.

## Unstaged diff

No unstaged diff.
`;
}

function diffEvidenceFor(relativePath: string): string {
  return `# Git diff evidence

## Committed diff

diff --git a/${relativePath} b/${relativePath}
--- a/${relativePath}
+++ b/${relativePath}
@@ -1 +1 @@
-old
+new

## Staged diff

No staged diff.

## Unstaged diff

No unstaged diff.
`;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
