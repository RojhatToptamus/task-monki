import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactRecord, GitSnapshotRecord, RunRecord } from '../../shared/contracts';
import { CompletedChangeSummaryPanel } from './CompletedChangeSummaryCard';

const api = vi.hoisted(() => ({
  readArtifact: vi.fn()
}));

vi.mock('../api/taskManagerClient', () => ({
  taskManagerApi: {
    readArtifact: api.readArtifact
  }
}));

describe('CompletedChangeSummaryPanel', () => {
  beforeEach(() => {
    api.readArtifact.mockReset();
  });

  it('shows loading before rendering the exact captured diff', async () => {
    const pending = deferred<string>();
    api.readArtifact.mockReturnValueOnce(pending.promise);
    render(
      <CompletedChangeSummaryPanel
        run={runFixture()}
        gitSnapshots={[gitSnapshotFixture()]}
        artifacts={[artifactFixture()]}
        onViewDiff={() => undefined}
      />
    );

    expect(screen.getByText('Loading captured Git changes…')).toBeDefined();
    expect(screen.queryByText('No file changes were captured.')).toBeNull();

    await act(async () => {
      pending.resolve(diffEvidence());
      await pending.promise;
    });

    expect(screen.getByText('Captured Git changes · 1 file')).toBeDefined();
    expect(screen.getByText('app.ts')).toBeDefined();
    expect(screen.queryByText('Loading captured Git changes…')).toBeNull();
  });

  it('does not convert an artifact read failure into an empty capture', async () => {
    api.readArtifact.mockRejectedValueOnce(new Error('artifact unavailable'));
    render(
      <CompletedChangeSummaryPanel
        run={runFixture()}
        gitSnapshots={[gitSnapshotFixture()]}
        artifacts={[artifactFixture()]}
        onViewDiff={() => undefined}
      />
    );

    expect(
      await screen.findByText('Could not read the captured diff. Changes are unknown.')
    ).toBeDefined();
    expect(screen.queryByText('No file changes were captured.')).toBeNull();
  });

  it('shows a completed run whose post-run Git capture is missing', () => {
    render(
      <CompletedChangeSummaryPanel
        run={runFixture({ afterGitSnapshotId: undefined })}
        gitSnapshots={[]}
        artifacts={[]}
        onViewDiff={() => undefined}
      />
    );

    expect(
      screen.getByText('No post-run Git capture. Changes are unknown.')
    ).toBeDefined();
    expect(api.readArtifact).not.toHaveBeenCalled();
  });

  it('distinguishes an active post-run capture from missing evidence', () => {
    render(
      <CompletedChangeSummaryPanel
        run={runFixture({ afterGitSnapshotId: undefined })}
        capturePending
        gitSnapshots={[]}
        artifacts={[]}
        onViewDiff={() => undefined}
      />
    );

    expect(screen.getByText('Capturing Git changes…')).toBeDefined();
    expect(
      screen.queryByText('No post-run Git capture. Changes are unknown.')
    ).toBeNull();
  });
});

function runFixture(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    runtimeId: 'codex',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    sessionId: 'session-1',
    mode: 'IMPLEMENTATION',
    origin: 'TASK_MONKI',
    status: 'COMPLETED',
    recoveryState: 'NONE',
    requestedSettings: {
      model: 'gpt-5-codex',
      reasoningEffort: 'high',
      sandbox: 'WORKSPACE_WRITE',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      networkAccess: false
    },
    promptArtifactId: 'prompt-1',
    outputArtifactId: 'output-1',
    diagnosticArtifactId: 'diagnostic-1',
    afterGitSnapshotId: 'git-1',
    startedAt: '2026-07-07T10:00:00.000Z',
    endedAt: '2026-07-07T10:10:00.000Z',
    eventCount: 1,
    ...overrides,
    attachmentSelection: overrides.attachmentSelection ?? []
  };
}

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
    commitsAheadOfBase: 1,
    committedDiffFileCount: 1,
    workingDiffFileCount: 0,
    diffStat: '1 file changed',
    dirtyFingerprint: 'clean',
    status: 'COMMITTED_UNPUSHED',
    capturedAt: '2026-07-07T10:10:00.000Z',
    diffArtifactId: 'diff-1',
    ...overrides
  };
}

function artifactFixture(): ArtifactRecord {
  return {
    id: 'diff-1',
    taskId: 'task-1',
    runId: 'run-1',
    kind: 'diff',
    path: '/tmp/diff-1.md',
    byteCount: 256,
    createdAt: '2026-07-07T10:10:00.000Z',
    updatedAt: '2026-07-07T10:10:00.000Z'
  };
}

function diffEvidence(): string {
  return [
    '# Git diff evidence',
    '',
    '## Committed diff',
    '',
    'diff --git a/src/app.ts b/src/app.ts',
    'index 1111111..2222222 100644',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '',
    '## Staged diff',
    '',
    'No staged diff.',
    '',
    '## Unstaged diff',
    '',
    'No unstaged diff.',
    ''
  ].join('\n');
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
