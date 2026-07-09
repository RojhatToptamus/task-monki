import { describe, expect, it } from 'vitest';
import type { AgentItemRecord, RunRecord } from '../../shared/contracts';
import { buildReviewActivityViewModel } from './reviewActivity';

describe('review activity model', () => {
  it('shows the latest useful review progress message while review is running', () => {
    const reviewRun = runFixture({ id: 'review-run', mode: 'REVIEW', status: 'RUNNING' });
    const implementationRun = runFixture({
      id: 'implementation-run',
      mode: 'IMPLEMENTATION',
      status: 'RUNNING'
    });

    const view = buildReviewActivityViewModel({
      reviewRun,
      reviewRunning: true,
      useRunActivity: true,
      items: [
        itemFixture({
          runId: implementationRun.id,
          payload: { text: 'Progress: Editing implementation files.' },
          providerCompletedAt: '2026-07-07T10:05:00.000Z'
        }),
        itemFixture({
          runId: reviewRun.id,
          payload: { text: 'Progress: Inspecting changed files for regressions.' },
          providerCompletedAt: '2026-07-07T10:06:00.000Z'
        }),
        itemFixture({
          runId: reviewRun.id,
          payload: { text: 'Progress: Preparing review findings.' },
          providerCompletedAt: '2026-07-07T10:07:00.000Z'
        })
      ]
    });

    expect(view).toEqual({ label: 'Preparing review findings.' });
  });

  it('does not expose raw command or protocol text in review activity', () => {
    const reviewRun = runFixture({ id: 'review-run', mode: 'REVIEW', status: 'RUNNING' });

    const view = buildReviewActivityViewModel({
      reviewRun,
      reviewRunning: true,
      useRunActivity: true,
      items: [
        itemFixture({
          runId: reviewRun.id,
          payload: {
            text: "Command completed /bin/zsh -lc 'git diff -- src/app.ts'"
          },
          providerCompletedAt: '2026-07-07T10:06:00.000Z'
        })
      ]
    });

    expect(view).toEqual({ label: 'Preparing review context.' });
    expect(JSON.stringify(view)).not.toContain('/bin/zsh');
    expect(JSON.stringify(view)).not.toContain('git diff');
  });

  it('uses structured review telemetry when the provider emits no progress prose', () => {
    const reviewRun = runFixture({ id: 'review-run', mode: 'REVIEW', status: 'RUNNING' });

    const view = buildReviewActivityViewModel({
      reviewRun,
      reviewRunning: true,
      useRunActivity: true,
      items: [
        itemFixture({
          id: 'read-command',
          runId: reviewRun.id,
          type: 'COMMAND_EXECUTION',
          payload: {
            command: "sed -n '1,80p' src/renderer/ui/TaskDetail.tsx",
            commandActions: [
              {
                type: 'read',
                command: "sed -n '1,80p' src/renderer/ui/TaskDetail.tsx",
                path: '/Users/rojhat/project/src/renderer/ui/TaskDetail.tsx'
              }
            ]
          },
          providerCompletedAt: '2026-07-07T10:06:00.000Z'
        }),
        itemFixture({
          id: 'search-command',
          runId: reviewRun.id,
          type: 'COMMAND_EXECUTION',
          payload: {
            command: 'rg review src/renderer',
            commandActions: [
              { type: 'search', query: 'review', path: 'src/renderer' }
            ]
          },
          providerCompletedAt: '2026-07-07T10:07:00.000Z'
        })
      ]
    });

    expect(view).toEqual({ label: 'Searching review · src/renderer.' });
    expect(JSON.stringify(view)).not.toContain('/Users/rojhat/project');
  });

  it('maps structured review file and verification activity without raw shell wrappers', () => {
    const reviewRun = runFixture({ id: 'review-run', mode: 'REVIEW', status: 'RUNNING' });

    const fileView = buildReviewActivityViewModel({
      reviewRun,
      reviewRunning: true,
      useRunActivity: true,
      items: [
        itemFixture({
          id: 'file-change',
          runId: reviewRun.id,
          type: 'FILE_CHANGE',
          payload: {
            changes: [
              {
                path: 'src/renderer/model/reviewActivity.ts',
                kind: { type: 'patch' },
                diff: '--- a/src/renderer/model/reviewActivity.ts\n+++ b/src/renderer/model/reviewActivity.ts\n-old\n+new\n'
              }
            ]
          },
          providerCompletedAt: '2026-07-07T10:06:00.000Z'
        })
      ]
    });
    const verifyView = buildReviewActivityViewModel({
      reviewRun,
      reviewRunning: true,
      useRunActivity: true,
      items: [
        itemFixture({
          id: 'verify-command',
          runId: reviewRun.id,
          type: 'COMMAND_EXECUTION',
          status: 'IN_PROGRESS',
          payload: {
            command: "/bin/zsh -lc 'npm test -- reviewActivity'",
            commandActions: [{ type: 'unknown' }]
          },
          providerStartedAt: '2026-07-07T10:07:00.000Z'
        })
      ]
    });

    expect(fileView).toEqual({
      label: 'Inspecting file changes in src/renderer/model/reviewActivity.ts.'
    });
    expect(verifyView).toEqual({ label: 'Running verification.' });
    expect(JSON.stringify(verifyView)).not.toContain('/bin/zsh');
  });

  it('does not reuse implementation telemetry for the running review card', () => {
    const reviewRun = runFixture({ id: 'review-run', mode: 'REVIEW', status: 'RUNNING' });

    const view = buildReviewActivityViewModel({
      reviewRun,
      reviewRunning: true,
      useRunActivity: true,
      items: [
        itemFixture({
          id: 'implementation-command',
          runId: 'implementation-run',
          type: 'COMMAND_EXECUTION',
          payload: {
            command: 'npm run typecheck',
            commandActions: [{ type: 'unknown' }]
          },
          providerCompletedAt: '2026-07-07T10:07:00.000Z'
        })
      ]
    });

    expect(view).toEqual({ label: 'Preparing review context.' });
  });

  it('maps final review JSON to a compact activity label instead of raw output', () => {
    const reviewRun = runFixture({ id: 'review-run', mode: 'REVIEW', status: 'RUNNING' });

    const view = buildReviewActivityViewModel({
      reviewRun,
      reviewRunning: true,
      useRunActivity: true,
      items: [
        itemFixture({
          runId: reviewRun.id,
          payload: {
            text: '```json\n{"schemaVersion":"codex-review/v1","verdict":"NEEDS_CHANGES","findings":[]}\n```'
          },
          providerCompletedAt: '2026-07-07T10:06:00.000Z'
        })
      ]
    });

    expect(view).toEqual({ label: 'Preparing review findings.' });
    expect(JSON.stringify(view)).not.toContain('schemaVersion');
    expect(JSON.stringify(view)).not.toContain('codex-review/v1');
  });

  it('returns no activity outside a running review', () => {
    const reviewRun = runFixture({ id: 'review-run', mode: 'REVIEW', status: 'COMPLETED' });

    expect(
      buildReviewActivityViewModel({
        reviewRun,
        reviewRunning: false,
        useRunActivity: true,
        items: [
          itemFixture({
            runId: reviewRun.id,
            payload: { text: 'Progress: Preparing review findings.' }
          })
        ]
      })
    ).toBeUndefined();
  });

  it('falls back while a review is starting before a run item exists', () => {
    expect(
      buildReviewActivityViewModel({
        reviewRunning: true,
        useRunActivity: false,
        items: []
      })
    ).toEqual({ label: 'Preparing review context.' });
  });

  it('does not reuse activity from a terminal previous review while a new review starts', () => {
    const previousReviewRun = runFixture({
      id: 'review-run',
      mode: 'REVIEW',
      status: 'COMPLETED'
    });

    expect(
      buildReviewActivityViewModel({
        reviewRun: previousReviewRun,
        reviewRunning: true,
        useRunActivity: false,
        items: [
          itemFixture({
            runId: previousReviewRun.id,
            payload: { text: 'Progress: Preparing old review findings.' }
          })
        ]
      })
    ).toEqual({ label: 'Preparing review context.' });
  });
});

function runFixture(input: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    sessionId: 'session-1',
    mode: 'REVIEW',
    origin: 'USER',
    status: 'RUNNING',
    recoveryState: 'NONE',
    requestedSettings: {},
    promptArtifactId: 'prompt-1',
    outputArtifactId: 'output-1',
    diagnosticArtifactId: 'diagnostic-1',
    startedAt: '2026-07-07T10:00:00.000Z',
    eventCount: 1,
    ...input
  } as RunRecord;
}

function itemFixture(input: Partial<AgentItemRecord> = {}): AgentItemRecord {
  return {
    id: input.providerItemId ?? 'item-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    runId: 'review-run',
    sessionId: 'session-1',
    providerItemId: 'item-1',
    type: 'AGENT_MESSAGE',
    status: 'COMPLETED',
    payload: { text: 'Progress: Inspecting changed files for regressions.' },
    createdAt: '2026-07-07T10:00:00.000Z',
    updatedAt: '2026-07-07T10:00:00.000Z',
    ...input
  };
}
