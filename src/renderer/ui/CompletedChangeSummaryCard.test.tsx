import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GitSnapshotRecord } from '../../shared/contracts';
import type { CompletedChangeSummary } from '../model/completedChangeSummary';
import { CompletedChangeSummaryCard } from './CompletedChangeSummaryCard';

describe('CompletedChangeSummaryCard', () => {
  it('renders a compact completed-run change summary with expandable remaining files', () => {
    const html = renderToStaticMarkup(
      <CompletedChangeSummaryCard
        summary={summaryFixture()}
        captureStatus="CAPTURED"
        snapshot={gitSnapshotFixture()}
        onViewDiff={() => {}}
      />
    );

    expect(html).toContain('Captured Git changes · 4 files');
    expect(html).toContain('+278');
    expect(html).toContain('-12');
    expect(html).toContain('src/core/app/TaskManagerService.progress.integration.test.ts');
    expect(html).toContain('src/dev/seedData.integration.test.ts');
    expect(html).toContain('src/renderer/model/overviewRunActivity.test.ts');
    expect(html).toContain('Show 1 more file');
    expect(html).toContain('src/renderer/ui/TaskDetail.tsx');
    expect(html).toContain('aria-label="modified"');
    expect(html).toContain('Head aaaaaaaaaaaa');
    expect(html).toContain('dateTime="2026-07-07T10:10:00.000Z"');
    expect(html).toContain('View diff');
    expect(html).not.toContain('Undo');
  });

  it('omits the disclosure when the preview contains every changed file', () => {
    const html = renderToStaticMarkup(
      <CompletedChangeSummaryCard
        summary={{
          fileCount: 1,
          title: 'Captured Git changes · 1 file',
          additions: 2,
          deletions: 1,
          previewFiles: [
            {
              path: 'src/app.ts',
              additions: 2,
              deletions: 1,
              status: 'modified'
            }
          ],
          hiddenFiles: [],
          hiddenFileCount: 0
        }}
        captureStatus="CAPTURED"
        onViewDiff={() => {}}
      />
    );

    expect(html).toContain('Captured Git changes · 1 file');
    expect(html).not.toContain('Show 0 more files');
  });

  it('renders missing, unavailable, loading, read-failure, empty, and uninterpretable states honestly', () => {
    const states = [
      ['NOT_CAPTURED', 'No post-run Git capture. Changes are unknown.'],
      [
        'DIFF_UNAVAILABLE',
        'Capture recorded, but its diff is unavailable.'
      ],
      ['LOADING', 'Loading captured Git changes…'],
      ['READ_FAILED', 'Could not read the captured diff. Changes are unknown.'],
      ['NO_CHANGES', 'No file changes were captured.'],
      ['UNINTERPRETABLE', 'Could not interpret the captured diff. Changes are unknown.']
    ] as const;

    for (const [captureStatus, expected] of states) {
      const html = renderToStaticMarkup(
        <CompletedChangeSummaryCard captureStatus={captureStatus} />
      );
      expect(html).toContain(expected);
    }
  });

  it('keeps partial paths but disclaims absence and marks a later worktree state as historical', () => {
    const html = renderToStaticMarkup(
      <CompletedChangeSummaryCard
        summary={summaryFixture()}
        captureStatus="CAPTURED"
        snapshot={gitSnapshotFixture()}
        incomplete
        historical
        onViewDiff={() => {}}
      />
    );

    expect(html).toContain('Incomplete captured diff · 4 observed files');
    expect(html).toContain('Other files or changes may be missing.');
    expect(html).toContain('Historical capture — the worktree changed later.');
    expect(html).not.toMatch(/out of scope|violation|owned by/i);
  });
});

function summaryFixture(): CompletedChangeSummary {
  return {
    fileCount: 4,
    title: 'Captured Git changes · 4 files',
    additions: 278,
    deletions: 12,
    previewFiles: [
      {
        path: 'src/core/app/TaskManagerService.progress.integration.test.ts',
        additions: 6,
        deletions: 6,
        status: 'modified'
      },
      {
        path: 'src/dev/seedData.integration.test.ts',
        additions: 4,
        deletions: 4,
        status: 'modified'
      },
      {
        path: 'src/renderer/model/overviewRunActivity.test.ts',
        additions: 228,
        deletions: 0,
        status: 'modified'
      }
    ],
    hiddenFiles: [
      {
        path: 'src/renderer/ui/TaskDetail.tsx',
        additions: 40,
        deletions: 2,
        status: 'modified'
      }
    ],
    hiddenFileCount: 1
  };
}

function gitSnapshotFixture(
  overrides: Partial<GitSnapshotRecord> = {}
): GitSnapshotRecord {
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
    committedDiffFileCount: 4,
    workingDiffFileCount: 0,
    diffStat: '4 files changed',
    dirtyFingerprint: 'clean',
    status: 'COMMITTED_UNPUSHED',
    capturedAt: '2026-07-07T10:10:00.000Z',
    ...overrides
  };
}
