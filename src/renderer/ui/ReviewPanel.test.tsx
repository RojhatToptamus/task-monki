import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  AgentReviewGateProjection,
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
          reviewedGitSnapshotId: 'git-1',
          reviewedHeadSha: 'abc1234567890',
          reviewedDirtyFingerprint: 'fingerprint-current',
          updatedAt: '2026-07-07T10:00:00.000Z'
        }}
        reviewRun={runFixture({ id: 'review-run', mode: 'REVIEW', status: 'RUNNING' })}
        gitSnapshot={gitSnapshotFixture()}
        reviewedSnapshot={gitSnapshotFixture()}
        reviewActivity={{ label: 'Reading src/renderer/ui/TaskDetail.tsx.' }}
        actionBusy={false}
        reviewPending={false}
        onStopReview={() => {}}
      />
    );

    expect(html).toContain('Agent review');
    // What the review reads: the commit and the worktree's uncommitted changes, never a fingerprint.
    expect(html).toContain('abc1234 and uncommitted changes');
    expect(html).not.toContain('fingerprint-current');
    // Review activity comes from the provider, so it is attributed.
    expect(html).toContain('Reviewer reported');
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
            schemaVersion: 'agent-review/v1',
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

    // One state word; the old verdict is context, never the current state.
    expect(html).toContain('Needs re-review');
    expect(html).not.toContain('>Needs changes<');
    expect(html).toContain('The diff changed after this review, which asked for changes on the earlier version.');
    // The reviewed commit is named; the dirty-tree fingerprint stays in Debug.
    // Without the snapshot it read, the worktree's changes now are not claimed for it.
    expect(html).toContain('Reviewed <code>feedfac</code>, ');
    expect(html).not.toContain('fingerprint-old');
    // The Overview names what the earlier review found; the findings live in the Review tab.
    expect(html).toContain('Earlier: ');
    expect(html).toContain('1 blocker');
    expect(html).not.toContain('Request can hang');
    expect(html).not.toContain('Re-review<');
    expect(html).not.toMatch(/major|minor|nit/i);
  });

  it('names the uncommitted changes a finished review read with its commit', () => {
    const reviewed = (snapshot: GitSnapshotRecord) => renderToStaticMarkup(
      <ReviewPanel
        reviewGate={{ ...reviewGateFixture(), reviewedGitSnapshotId: snapshot.id, reviewedHeadSha: 'f390644aa' }}
        gitSnapshot={{ ...gitSnapshotFixture(), id: 'git-now', stagedCount: 0, unstagedCount: 0, untrackedCount: 0 }}
        reviewedSnapshot={snapshot}
        actionBusy={false}
        reviewPending={false}
        onStopReview={() => {}}
      />
    );

    expect(reviewed(gitSnapshotFixture())).toContain('Reviewed <code>f390644</code> and uncommitted changes, ');
    expect(reviewed({ ...gitSnapshotFixture(), stagedCount: 0, unstagedCount: 0, untrackedCount: 0 })).toContain('Reviewed <code>f390644</code>, ');
  });

  it('keeps the pending review scope without an empty result row', () => {
    const html = renderToStaticMarkup(
      <ReviewPanel
        reviewGate={{ status: 'NOT_RUN' }}
        gitSnapshot={gitSnapshotFixture()}
        actionBusy={false}
        reviewPending={false}
        onStopReview={() => {}}
      />
    );

    expect(html).toContain('Will review <code>abc1234</code> and uncommitted changes');
    expect(html).not.toContain('Run a review before marking done or shipping this diff.');
    expect(html).not.toContain('Last result');
    expect(html).not.toContain('>none<');
  });

  it('labels bounded review excerpts and their lazy artifact states truthfully', () => {
    const excerpt = {
      collection: 'runs' as const,
      recordId: 'review-run',
      fieldPath: 'finalMessage',
      originalByteCount: 186_130,
      displayedByteCount: 131_072,
      availableContent: {
        kind: 'BOUNDED_ARTIFACT' as const,
        artifactId: 'artifact-1'
      }
    };
    const baseProps = {
      reviewGate: reviewGateFixture(),
      reviewRun: runFixture({
        id: 'review-run',
        mode: 'REVIEW',
        finalMessage: 'Excerpt with an omission marker.'
      }),
      gitSnapshot: gitSnapshotFixture(),
      actionBusy: false,
      reviewPending: false,
      onStopReview: () => {}
    };
    const excerptHtml = renderToStaticMarkup(
      <ReviewPanel
        {...baseProps}
        textExcerpt={excerpt}
        reviewOutputLoading
        reviewOutputError="Artifact read failed."
      />
    );

    expect(excerptHtml).toContain('Raw review output excerpt');
    expect(excerptHtml).toContain('Displayed 131,072 of 186,130 bytes.');
    expect(excerptHtml).toContain('Loading review artifact…');
    expect(excerptHtml).toContain('Artifact read failed.');

    const loadedHtml = renderToStaticMarkup(
      <ReviewPanel
        {...baseProps}
        textExcerpt={excerpt}
        loadedReviewOutput="Retained bounded artifact body."
      />
    );
    expect(loadedHtml).toContain('Retained review artifact');
    expect(loadedHtml).toContain('Retained bounded artifact body.');
    expect(loadedHtml).not.toContain('Load available review artifact');

    const unavailableHtml = renderToStaticMarkup(
      <ReviewPanel
        {...baseProps}
        textExcerpt={{
          ...excerpt,
          availableContent: { kind: 'NOT_AVAILABLE' }
        }}
      />
    );
    expect(unavailableHtml).toContain(
      'Additional content is not available from retained evidence.'
    );
  });
});

function reviewGateFixture(): AgentReviewGateProjection {
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
    ...overrides,
    attachmentSelection: overrides.attachmentSelection ?? []
  };
}
