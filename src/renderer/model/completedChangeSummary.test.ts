import { describe, expect, it } from 'vitest';
import type { AgentItemRecord, GitSnapshotRecord, RunRecord } from '../../shared/contracts';
import type { DiffFile } from './diffEvidence';
import {
  buildCompletedChangeSummary,
  selectCompletedRunChangeSnapshot
} from './completedChangeSummary';

describe('completed change summary model', () => {
  it('builds compact totals and a bounded file preview from parsed diff evidence', () => {
    const summary = buildCompletedChangeSummary([
      diffFile({ path: 'src/core/app/TaskManagerService.progress.test.ts', additions: 6, deletions: 6 }),
      diffFile({ path: 'src/dev/seedData.test.ts', additions: 4, deletions: 4 }),
      diffFile({ path: 'src/renderer/model/overviewRunActivity.test.ts', additions: 228, deletions: 0 }),
      diffFile({ path: 'src/renderer/ui/TaskDetail.tsx', additions: 40, deletions: 2 })
    ]);

    expect(summary).toEqual({
      fileCount: 4,
      title: 'Edited 4 files',
      additions: 278,
      deletions: 12,
      previewFiles: [
        {
          path: 'src/core/app/TaskManagerService.progress.test.ts',
          additions: 6,
          deletions: 6,
          status: 'modified'
        },
        {
          path: 'src/dev/seedData.test.ts',
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
    });
  });

  it('returns no summary when the captured diff has no file entries', () => {
    expect(buildCompletedChangeSummary([])).toBeUndefined();
  });

  it('selects only the completed run after-snapshot as the authoritative source', () => {
    const run = runFixture({
      status: 'COMPLETED',
      iterationId: 'iteration-previous',
      afterGitSnapshotId: 'after-run'
    });
    const latestTaskSnapshot = gitSnapshotFixture({
      id: 'latest-task-snapshot',
      capturedAt: '2026-07-07T10:12:00.000Z',
      diffArtifactId: 'latest-diff'
    });
    const afterRunSnapshot = gitSnapshotFixture({
      id: 'after-run',
      iterationId: 'iteration-previous',
      capturedAt: '2026-07-07T10:10:00.000Z',
      diffArtifactId: 'after-run-diff'
    });

    expect(selectCompletedRunChangeSnapshot(run, [latestTaskSnapshot, afterRunSnapshot])).toBe(
      afterRunSnapshot
    );
  });

  it('ignores running runs, mismatched snapshots, and provider file-change telemetry alone', () => {
    const running = runFixture({ status: 'RUNNING', afterGitSnapshotId: 'after-run' });
    const completedWithoutAfterSnapshot = runFixture({ status: 'COMPLETED' });
    const completedWithMismatchedSnapshot = runFixture({
      status: 'COMPLETED',
      afterGitSnapshotId: 'other-task-snapshot'
    });
    const providerFileChange = itemFixture({
      type: 'FILE_CHANGE',
      status: 'COMPLETED',
      payload: {
        changes: [
          {
            path: 'src/renderer/ui/TaskDetail.tsx',
            kind: { type: 'update' },
            diff: '--- a/src/renderer/ui/TaskDetail.tsx\n+++ b/src/renderer/ui/TaskDetail.tsx\n-old\n+new\n'
          }
        ]
      }
    });

    expect(providerFileChange.type).toBe('FILE_CHANGE');
    expect(selectCompletedRunChangeSnapshot(running, [gitSnapshotFixture({ id: 'after-run' })])).toBeUndefined();
    expect(selectCompletedRunChangeSnapshot(completedWithoutAfterSnapshot, [])).toBeUndefined();
    expect(
      selectCompletedRunChangeSnapshot(completedWithMismatchedSnapshot, [
        gitSnapshotFixture({ id: 'other-task-snapshot', taskId: 'task-2' })
      ])
    ).toBeUndefined();
  });
});

function diffFile(overrides: Partial<DiffFile>): DiffFile {
  return {
    id: overrides.path ?? 'src/app.ts',
    path: overrides.path ?? 'src/app.ts',
    status: overrides.status ?? 'modified',
    additions: overrides.additions ?? 0,
    deletions: overrides.deletions ?? 0,
    blocks: overrides.blocks ?? []
  };
}

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
    promptArtifactId: 'prompt',
    outputArtifactId: 'output',
    diagnosticArtifactId: 'diagnostic',
    startedAt: '2026-07-07T10:00:00.000Z',
    eventCount: 0,
    ...overrides
  };
}

function gitSnapshotFixture(overrides: Partial<GitSnapshotRecord> = {}): GitSnapshotRecord {
  return {
    id: 'git-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    worktreePath: '/tmp/worktree',
    repoRoot: '/tmp/repo',
    gitCommonDir: '/tmp/repo/.git',
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
    dirtyFingerprint: 'fingerprint',
    status: 'COMMITTED_UNPUSHED',
    capturedAt: '2026-07-07T10:10:00.000Z',
    ...overrides
  };
}

function itemFixture(overrides: Partial<AgentItemRecord>): AgentItemRecord {
  return {
    id: 'item-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    runId: 'run-1',
    sessionId: 'session-1',
    providerItemId: 'provider-item-1',
    type: 'AGENT_MESSAGE',
    status: 'COMPLETED',
    payload: {},
    rawMessage: {
      serverInstanceId: 'server-1',
      sequence: 1,
      direction: 'INBOUND',
      recordedAt: '2026-07-07T10:00:00.000Z',
      byteOffset: 0,
      byteLength: 1,
      sha256: 'hash'
    },
    createdAt: '2026-07-07T10:00:00.000Z',
    updatedAt: '2026-07-07T10:00:00.000Z',
    ...overrides
  };
}
