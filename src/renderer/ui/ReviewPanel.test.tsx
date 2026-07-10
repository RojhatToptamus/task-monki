import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  CodexReviewGateProjection,
  GitSnapshotRecord,
  RunRecord
} from '../../shared/contracts';
import { ReviewPanel } from './ReviewPanel';

describe('ReviewPanel', () => {
  it('renders current review activity while the detached review is running', () => {
    const html = renderToStaticMarkup(
      <ReviewPanel
        reviewGate={{
          status: 'RUNNING',
          runId: 'review-run',
          sourceRunId: 'source-run',
          updatedAt: '2026-07-07T10:00:00.000Z'
        }}
        reviewRun={runFixture({ id: 'review-run', mode: 'REVIEW', status: 'RUNNING' })}
        gitSnapshot={gitSnapshotFixture()}
        reviewActivity={{ label: 'Reading src/renderer/ui/TaskDetail.tsx.' }}
        actionBusy={false}
        reviewPending={false}
        onStopReview={() => {}}
      />
    );

    expect(html).toContain('Reviewing');
    expect(html).toContain('abc12345');
    expect(html).toContain('Current activity');
    expect(html).toContain('Reading src/renderer/ui/TaskDetail.tsx.');
    expect(html).toContain('Stop');
  });

  it('renders stale review output as context without duplicating the next action', () => {
    const html = renderToStaticMarkup(
      <ReviewPanel
        reviewGate={{
          ...reviewGateFixture(),
          status: 'STALE',
          reviewedHeadSha: 'feedfacecafebeef',
          reviewedDirtyFingerprint: 'fingerprint-old',
          summary: 'Previous review found a blocker.',
          result: {
            schemaVersion: 'codex-review/v1',
            verdict: 'NEEDS_CHANGES',
            summary: 'Previous review found a blocker.',
            findings: [
              {
                id: 'finding-1',
                severity: 'BLOCKER',
                title: 'Request can hang',
                explanation: 'The stop path can stay in a pending state.',
                path: 'src/renderer/ui/TaskDetail.tsx',
                line: 12
              }
            ]
          }
        }}
        gitSnapshot={gitSnapshotFixture()}
        actionBusy={false}
        reviewPending={false}
        onStopReview={() => {}}
      />
    );

    expect(html).toContain('Reviewed diff no longer matches the worktree.');
    expect(html).toContain('Reviewed diff');
    expect(html).toContain('feedface');
    expect(html).toContain('Request can hang');
    expect(html).not.toContain('Run review again');
  });
});

function reviewGateFixture(): CodexReviewGateProjection {
  return {
    status: 'PASSED',
    runId: 'review-run',
    sourceRunId: 'source-run',
    updatedAt: '2026-07-07T10:00:00.000Z'
  };
}

function gitSnapshotFixture(): GitSnapshotRecord {
  return {
    id: 'git-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    worktreePath: '/tmp/task',
    repoRoot: '/tmp/repo',
    gitCommonDir: '/tmp/repo/.git',
    headSha: 'abc1234567890',
    branch: 'task/refactor',
    aheadCount: 0,
    behindCount: 0,
    stagedCount: 1,
    unstagedCount: 1,
    untrackedCount: 1,
    conflictedCount: 0,
    commitsAheadOfBase: 0,
    committedDiffFileCount: 0,
    workingDiffFileCount: 3,
    diffStat: '',
    dirtyFingerprint: 'fingerprint-current',
    status: 'DIRTY',
    capturedAt: '2026-07-07T10:00:00.000Z'
  };
}

function runFixture(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    sessionId: 'session-1',
    mode: 'IMPLEMENTATION',
    origin: 'TASK_MONKI',
    status: 'COMPLETED',
    recoveryState: 'NONE',
    requestedSettings: {
      model: 'gpt-5',
      reasoningEffort: 'medium',
      sandbox: 'WORKSPACE_WRITE',
      approvalPolicy: 'on-request',
      networkAccess: false
    },
    promptArtifactId: 'prompt-1',
    outputArtifactId: 'output-1',
    diagnosticArtifactId: 'diag-1',
    startedAt: '2026-07-07T10:00:00.000Z',
    eventCount: 1,
    ...overrides
  };
}
