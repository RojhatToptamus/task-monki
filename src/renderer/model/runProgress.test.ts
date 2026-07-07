import { describe, expect, it } from 'vitest';
import type {
  AgentItemRecord,
  AgentPlanRevisionRecord,
  GitSnapshotRecord,
  RunRecord
} from '../../shared/contracts';
import { buildRunProgressViewModel } from './runProgress';

describe('run progress model', () => {
  it('shows a running plan with one visible working-now line', () => {
    const implementationRun = runFixture({ id: 'run-impl', mode: 'IMPLEMENTATION' });
    const reviewRun = runFixture({ id: 'run-review', mode: 'REVIEW', startedAt: '2026-07-07T10:05:00.000Z' });

    const view = buildRunProgressViewModel({
      preferredRun: implementationRun,
      runs: [reviewRun, implementationRun],
      planRevisions: [
        planFixture({
          runId: 'run-review',
          observedAt: '2026-07-07T10:06:00.000Z',
          explanation: 'Review plan',
          steps: [{ step: 'Inspect diff', status: 'IN_PROGRESS' }]
        }),
        planFixture({
          runId: 'run-impl',
          observedAt: '2026-07-07T10:04:00.000Z',
          explanation: 'Implementation in progress',
          steps: [
            { step: 'Trace state', status: 'COMPLETED' },
            { step: 'Show progress fallback', status: 'IN_PROGRESS' }
          ]
        })
      ],
      items: [
        itemFixture({
          runId: 'run-impl',
          providerItemId: 'command-1',
          type: 'COMMAND_EXECUTION',
          status: 'IN_PROGRESS',
          payload: { command: 'npm test' },
          providerStartedAt: '2026-07-07T10:05:00.000Z'
        }),
        itemFixture({
          runId: 'run-impl',
          providerItemId: 'message-1',
          type: 'AGENT_MESSAGE',
          status: 'COMPLETED',
          payload: { text: 'Progress: Editing src/renderer/model/runProgress.ts.' },
          providerCompletedAt: '2026-07-07T10:06:00.000Z'
        })
      ]
    });

    expect(view).toMatchObject({
      runId: 'run-impl',
      state: 'RUNNING',
      headerLabel: 'Current run'
    });
    expect(view?.steps.map((step) => step.step)).toEqual([
      'Trace state',
      'Show progress fallback'
    ]);
    expect(view?.workingNow).toMatchObject({
      label: 'Editing src/renderer/model/runProgress.ts.',
      tone: 'neutral'
    });
    expect(view?.activityDetails.map((activity) => activity.label)).toEqual([
      'Running verification.'
    ]);
    expect(view?.activityDetails.map((activity) => activity.tone)).toEqual(['action']);
  });

  it('shows a waiting state for active runs before a provider plan exists', () => {
    const run = runFixture({ id: 'run-1', status: 'RUNNING' });

    const view = buildRunProgressViewModel({
      preferredRun: run,
      runs: [run],
      planRevisions: [],
      items: []
    });

    expect(view).toMatchObject({
      runId: 'run-1',
      state: 'RUNNING',
      headerLabel: 'Current run',
      steps: [
        {
          step: 'Waiting for provider plan...',
          status: 'IN_PROGRESS'
        }
      ],
      activityDetails: []
    });
    expect(view?.workingNow).toBeUndefined();
    expect(view?.footer).toBeUndefined();
  });

  it('caps running activity details and keeps them out of plan rows', () => {
    const run = runFixture({ id: 'run-1', status: 'RUNNING' });

    const view = buildRunProgressViewModel({
      preferredRun: run,
      runs: [run],
      planRevisions: [],
      items: Array.from({ length: 12 }, (_, index) =>
        itemFixture({
          id: `message-${index}`,
          providerItemId: `message-${index}`,
          payload: { text: `Progress: Reading src/file-${index}.ts.` },
          providerCompletedAt: `2026-07-07T10:${String(index).padStart(2, '0')}:00.000Z`
        })
      )
    });

    expect(view?.steps).toEqual([
      {
        step: 'Waiting for provider plan...',
        status: 'IN_PROGRESS'
      }
    ]);
    expect(view?.activityDetails).toHaveLength(6);
    expect(view?.workingNow?.label).toBe('Reading src/file-11.ts.');
    expect(view?.activityDetails.map((activity) => activity.label)).toEqual([
      'Reading src/file-10.ts.',
      'Reading src/file-9.ts.',
      'Reading src/file-8.ts.',
      'Reading src/file-7.ts.',
      'Reading src/file-6.ts.',
      'Reading src/file-5.ts.'
    ]);
    expect(view?.activityDetails.map((activity) => activity.tone)).toEqual([
      'neutral',
      'neutral',
      'neutral',
      'neutral',
      'neutral',
      'neutral'
    ]);
  });

  it('does not expose raw command text in overview activity', () => {
    const run = runFixture({ id: 'run-1', status: 'RUNNING' });

    const view = buildRunProgressViewModel({
      preferredRun: run,
      runs: [run],
      planRevisions: [],
      items: [
        itemFixture({
          id: 'command',
          providerItemId: 'command',
          type: 'COMMAND_EXECUTION',
          status: 'IN_PROGRESS',
          payload: { command: "/bin/zsh -lc 'npm test -- --runInBand'" },
          providerStartedAt: '2026-07-07T10:04:00.000Z'
        })
      ]
    });

    const serialized = JSON.stringify(view);
    expect(view?.workingNow?.label).toBe('Running verification.');
    expect(serialized).not.toContain('/bin/zsh');
    expect(serialized).not.toContain('npm test');
    expect(serialized).not.toContain('--runInBand');
  });

  it('excludes working now from expanded activity and tones ordinary rows neutrally', () => {
    const run = runFixture({ id: 'run-1', status: 'RUNNING' });

    const view = buildRunProgressViewModel({
      preferredRun: run,
      runs: [run],
      planRevisions: [],
      items: [
        itemFixture({
          id: 'message-new',
          providerItemId: 'message-new',
          payload: {
            text: 'Progress: The app and HTML pages are in place. Switching to verification.'
          },
          providerCompletedAt: '2026-07-07T10:06:00.000Z'
        }),
        itemFixture({
          id: 'message-duplicate',
          providerItemId: 'message-duplicate',
          payload: {
            text: 'Progress: The app and HTML pages are in place. Switching to verification.'
          },
          providerCompletedAt: '2026-07-07T10:05:00.000Z'
        }),
        itemFixture({
          id: 'file-change',
          providerItemId: 'file-change',
          type: 'FILE_CHANGE',
          status: 'IN_PROGRESS',
          payload: {},
          providerStartedAt: '2026-07-07T10:04:00.000Z'
        }),
        itemFixture({
          id: 'verification',
          providerItemId: 'verification',
          type: 'COMMAND_EXECUTION',
          status: 'COMPLETED',
          payload: { command: 'npm test' },
          providerCompletedAt: '2026-07-07T10:03:00.000Z'
        })
      ]
    });

    expect(view?.workingNow).toMatchObject({
      label: 'The app and HTML pages are in place. Switching to verification.',
      tone: 'neutral'
    });
    expect(view?.activityDetails.map((activity) => activity.label)).toEqual([
      'Editing files.',
      'Verification finished.'
    ]);
    expect(view?.activityDetails.map((activity) => activity.tone)).toEqual([
      'neutral',
      'success'
    ]);
  });

  it('omits completed generic telemetry and maps only useful command intent', () => {
    const run = runFixture({ id: 'run-1', status: 'RUNNING' });

    const view = buildRunProgressViewModel({
      preferredRun: run,
      runs: [run],
      planRevisions: [],
      items: [
        itemFixture({
          id: 'unknown-command',
          providerItemId: 'unknown-command',
          type: 'COMMAND_EXECUTION',
          status: 'COMPLETED',
          payload: { command: 'node scripts/generated-helper.mjs' },
          providerCompletedAt: '2026-07-07T10:06:00.000Z'
        }),
        itemFixture({
          id: 'completed-file-change',
          providerItemId: 'completed-file-change',
          type: 'FILE_CHANGE',
          status: 'COMPLETED',
          payload: {},
          providerCompletedAt: '2026-07-07T10:05:00.000Z'
        }),
        itemFixture({
          id: 'read-command',
          providerItemId: 'read-command',
          type: 'COMMAND_EXECUTION',
          status: 'COMPLETED',
          payload: { command: 'rg "Agent progress" src' },
          providerCompletedAt: '2026-07-07T10:04:00.000Z'
        }),
        itemFixture({
          id: 'git-command',
          providerItemId: 'git-command',
          type: 'COMMAND_EXECUTION',
          status: 'IN_PROGRESS',
          payload: { command: 'git status --short' },
          providerStartedAt: '2026-07-07T10:03:00.000Z'
        })
      ]
    });

    expect(view?.workingNow).toMatchObject({
      label: 'Checking local Git state.',
      tone: 'neutral'
    });
    expect(view?.activityDetails).toEqual([]);
    expect(JSON.stringify(view)).not.toContain('Command finished');
    expect(JSON.stringify(view)).not.toContain('File changes captured');
    expect(JSON.stringify(view)).not.toContain('Project context read');
  });

  it('shows the final provider plan with a compact local-evidence footer', () => {
    const run = runFixture({
      id: 'run-1',
      status: 'COMPLETED',
      endedAt: '2026-07-07T10:10:00.000Z',
      finalMessage: 'Implemented [the panel](/Users/rojhat/project/src/file.ts) and verified tests.'
    });

    const view = buildRunProgressViewModel({
      preferredRun: run,
      runs: [run],
      planRevisions: [
        planFixture({
          runId: 'run-1',
          steps: [
            { step: 'Read design docs', status: 'COMPLETED' },
            { step: 'Update overview panel', status: 'COMPLETED' },
            { step: 'Run focused checks', status: 'COMPLETED' }
          ]
        })
      ],
      items: [
        itemFixture({
          runId: 'run-1',
          type: 'AGENT_MESSAGE',
          payload: { text: 'Progress: Running final verification.' },
          providerCompletedAt: '2026-07-07T10:09:00.000Z'
        })
      ],
      gitSnapshot: gitSnapshotFixture({ committedDiffFileCount: 3 }),
      ciStatus: 'PASSING'
    });

    expect(view).toMatchObject({
      state: 'COMPLETED',
      headerLabel: 'Final plan',
      activityDetails: [],
      footer: {
        title: 'Completed',
        detail: '3 files changed · verification passed',
        tone: 'success'
      }
    });
    expect(view?.workingNow).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain('/Users/rojhat');
    expect(JSON.stringify(view)).not.toContain('Implemented [the panel]');
  });

  it('shows failed, interrupted, and recovery terminal footers below the last known plan', () => {
    const cases: Array<[RunRecord['status'], string, string, string]> = [
      ['FAILED', 'FAILED', 'Failed', 'Command exited near src/app.ts.'],
      ['INTERRUPTED', 'INTERRUPTED', 'Interrupted', 'User canceled the run.'],
      ['RECOVERY_REQUIRED', 'RECOVERY_REQUIRED', 'Recovery required', 'Provider state could not be reconciled.'],
      ['LOST', 'RECOVERY_REQUIRED', 'Recovery required', 'Provider process was lost.']
    ];

    for (const [status, state, title, reason] of cases) {
      const run = runFixture({
        id: `run-${status}`,
        status,
        terminalReason: reason.replace('src/app.ts', '/Users/rojhat/project/src/app.ts'),
        endedAt: '2026-07-07T10:10:00.000Z'
      });

      const view = buildRunProgressViewModel({
        preferredRun: run,
        runs: [run],
        planRevisions: [
          planFixture({
            runId: run.id,
            steps: [{ step: 'Last known step', status: 'IN_PROGRESS' }]
          })
        ],
        items: []
      });

      expect(view).toMatchObject({
        state,
        headerLabel: 'Last known plan',
        activityDetails: [],
        footer: {
          title
        }
      });
      expect(view?.footer?.detail).not.toContain('/Users/rojhat');
      expect(view?.workingNow).toBeUndefined();
    }
  });

  it('does not show stale plan revisions from a previous run as current progress', () => {
    const previousRun = runFixture({
      id: 'run-old',
      status: 'COMPLETED',
      startedAt: '2026-07-07T09:00:00.000Z'
    });
    const currentRun = runFixture({
      id: 'run-current',
      status: 'RUNNING',
      startedAt: '2026-07-07T10:00:00.000Z'
    });

    const view = buildRunProgressViewModel({
      preferredRun: currentRun,
      runs: [previousRun, currentRun],
      planRevisions: [
        planFixture({
          runId: 'run-old',
          steps: [{ step: 'Old run step', status: 'COMPLETED' }]
        })
      ],
      items: []
    });

    expect(view).toMatchObject({
      runId: 'run-current',
      state: 'RUNNING',
      steps: [
        {
          step: 'Waiting for provider plan...',
          status: 'IN_PROGRESS'
        }
      ]
    });
  });

  it('caps provider plan rows to six around the active step', () => {
    const run = runFixture({ id: 'run-1', status: 'RUNNING' });

    const view = buildRunProgressViewModel({
      preferredRun: run,
      runs: [run],
      planRevisions: [
        planFixture({
          steps: [
            { step: 'Trace source state', status: 'COMPLETED' },
            { step: 'Read design guidance', status: 'COMPLETED' },
            { step: 'Update model helper', status: 'COMPLETED' },
            { step: 'Update model helper', status: 'COMPLETED' },
            { step: 'Render compact panel', status: 'COMPLETED' },
            { step: 'Wire current activity', status: 'IN_PROGRESS' },
            { step: 'Add regression tests', status: 'PENDING' },
            { step: 'Verify rendered app', status: 'PENDING' }
          ]
        })
      ],
      items: []
    });

    expect(view?.steps.map((step) => step.step)).toEqual([
      'Read design guidance',
      'Update model helper',
      'Render compact panel',
      'Wire current activity',
      'Add regression tests',
      'Verify rendered app'
    ]);
  });

  it('returns no progress section for tasks with no run history', () => {
    expect(
      buildRunProgressViewModel({
        runs: [],
        planRevisions: [],
        items: []
      })
    ).toBeUndefined();
  });

  it('chooses the latest non-review run when the preferred run is detached review', () => {
    const reviewRun = runFixture({ id: 'run-review', mode: 'REVIEW', startedAt: '2026-07-07T10:05:00.000Z' });
    const implementationRun = runFixture({ id: 'run-impl', mode: 'FOLLOW_UP', startedAt: '2026-07-07T10:01:00.000Z' });

    const view = buildRunProgressViewModel({
      preferredRun: reviewRun,
      runs: [reviewRun, implementationRun],
      planRevisions: [
        planFixture({
          runId: 'run-impl',
          steps: [{ step: 'Apply requested changes', status: 'IN_PROGRESS' }]
        })
      ],
      items: []
    });

    expect(view?.runId).toBe('run-impl');
    expect(view?.steps[0]?.step).toBe('Apply requested changes');
  });
});

function runFixture(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    sessionId: 'session-1',
    mode: 'IMPLEMENTATION',
    origin: 'TASK_MONKI',
    status: 'RUNNING',
    recoveryState: 'NONE',
    requestedSettings: {},
    promptArtifactId: 'prompt-1',
    outputArtifactId: 'output-1',
    diagnosticArtifactId: 'diagnostic-1',
    startedAt: '2026-07-07T10:00:00.000Z',
    eventCount: 0,
    ...overrides
  };
}

function planFixture(
  overrides: Partial<AgentPlanRevisionRecord> = {}
): AgentPlanRevisionRecord {
  return {
    id: 'plan-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    runId: 'run-1',
    sessionId: 'session-1',
    provider: 'codex',
    revision: 1,
    explanation: 'Plan',
    steps: [{ step: 'Implement', status: 'IN_PROGRESS' }],
    rawMessage: rawMessageFixture(),
    observedAt: '2026-07-07T10:01:00.000Z',
    ...overrides
  };
}

function itemFixture(overrides: Partial<AgentItemRecord> = {}): AgentItemRecord {
  return {
    id: 'item-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    runId: 'run-1',
    sessionId: 'session-1',
    providerItemId: 'provider-item-1',
    type: 'AGENT_MESSAGE',
    status: 'COMPLETED',
    payload: { text: 'Progress: Working.' },
    rawMessage: rawMessageFixture(),
    createdAt: '2026-07-07T10:00:00.000Z',
    updatedAt: '2026-07-07T10:00:00.000Z',
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
    committedDiffFileCount: 0,
    workingDiffFileCount: 0,
    diffStat: '',
    dirtyFingerprint: '',
    status: 'CLEAN',
    capturedAt: '2026-07-07T10:10:00.000Z',
    ...overrides
  };
}

function rawMessageFixture() {
  return {
    serverInstanceId: 'server-1',
    sequence: 1,
    direction: 'INBOUND' as const,
    recordedAt: '2026-07-07T10:00:00.000Z',
    byteOffset: 0,
    byteLength: 1,
    sha256: 'hash'
  };
}
