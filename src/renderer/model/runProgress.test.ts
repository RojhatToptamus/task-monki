import { describe, expect, it } from 'vitest';
import type {
  AgentItemRecord,
  AgentPlanRevisionRecord,
  GitSnapshotRecord,
  RunRecord
} from '../../shared/contracts';
import { buildRunProgressViewModel } from './runProgress';

describe('run progress model', () => {
  it('shows a running plan with a compact activity tail', () => {
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
          payload: { command: 'npm test', commandActions: [{ type: 'unknown', command: 'npm test' }] },
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
    expect(view?.activityTail).toMatchObject([
      {
        category: 'verify',
        label: 'Running',
        detail: 'npm test',
        tone: 'action',
        status: 'active'
      },
      {
        category: 'other',
        label: 'Editing src/renderer/model/runProgress.ts.',
        detail: undefined,
        tone: 'neutral',
        status: 'completed'
      }
    ]);
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
      activityTail: []
    });
    expect(view?.footer).toBeUndefined();
  });

  it('groups commandActions read/search/list into activity entries', () => {
    const run = runFixture({ id: 'run-1', status: 'RUNNING' });

    const view = buildRunProgressViewModel({
      preferredRun: run,
      runs: [run],
      planRevisions: [],
      items: [
        itemFixture({
          id: 'command-actions',
          providerItemId: 'command-actions',
          type: 'COMMAND_EXECUTION',
          status: 'COMPLETED',
          payload: {
            command: "/bin/zsh -lc 'sed -n 1,3p src/renderer/pages/Settings.tsx'",
            cwd: '/Users/rojhat/project',
            commandActions: [
              {
                type: 'read',
                command: 'sed -n 1,3p src/renderer/pages/Settings.tsx',
                name: 'Settings.tsx',
                path: '/Users/rojhat/project/src/renderer/pages/Settings.tsx'
              },
              {
                type: 'search',
                command: 'rg RunProgress src/renderer',
                query: 'RunProgress',
                path: 'src/renderer'
              },
              {
                type: 'listFiles',
                command: 'ls src/renderer',
                path: 'src/renderer'
              }
            ],
            aggregatedOutput: 'line 1\nline 2\nline 3'
          },
          providerCompletedAt: '2026-07-07T10:04:00.000Z'
        })
      ]
    });

    expect(view?.activityTail).toMatchObject([
      {
        category: 'read',
        label: 'Read',
        detail: 'src/renderer/pages/Settings.tsx',
        metric: '3 lines',
        status: 'completed'
      },
      {
        category: 'search',
        label: 'Searched',
        detail: 'RunProgress · src/renderer',
        status: 'completed'
      },
      {
        category: 'list',
        label: 'Listed',
        detail: 'src/renderer',
        status: 'completed'
      }
    ]);
    expect(view?.activityOutputSummary).toBe('show full output · 3 lines');
    expect(JSON.stringify(view)).not.toContain('/Users/rojhat/project');
    expect(JSON.stringify(view)).not.toContain('/bin/zsh');
  });

  it('does not expose shell wrappers or full absolute paths in command rows', () => {
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
          payload: {
            command: "/bin/zsh -lc 'npm test -- --runInBand /Users/rojhat/project/src/renderer/model/runProgress.ts'",
            commandActions: [{ type: 'unknown', command: 'npm test -- --runInBand' }]
          },
          providerStartedAt: '2026-07-07T10:04:00.000Z'
        })
      ]
    });

    const serialized = JSON.stringify(view);
    expect(view?.activityTail[0]).toMatchObject({
      category: 'verify',
      label: 'Running',
      detail: 'npm test -- --runInBand src/renderer/model/runProgress.ts'
    });
    expect(serialized).not.toContain('/bin/zsh');
    expect(serialized).not.toContain('/Users/rojhat/project');
  });

  it('maps file changes to write, edit, and delete rows with compact metrics', () => {
    const run = runFixture({ id: 'run-1', status: 'RUNNING' });

    const view = buildRunProgressViewModel({
      preferredRun: run,
      runs: [run],
      planRevisions: [],
      items: [
        itemFixture({
          id: 'file-changes',
          providerItemId: 'file-changes',
          type: 'FILE_CHANGE',
          status: 'COMPLETED',
          payload: {
            changes: [
              {
                path: 'src/renderer/pages/Home.tsx',
                kind: { type: 'add' },
                diff: '+++ b/src/renderer/pages/Home.tsx\n+one\n+two\n'
              },
              {
                path: 'src/renderer/router.tsx',
                kind: { type: 'update', move_path: null },
                diff: '--- a/src/renderer/router.tsx\n+++ b/src/renderer/router.tsx\n-old\n+new\n+extra\n'
              },
              {
                path: 'src/renderer/old.tsx',
                kind: { type: 'delete' },
                diff: '--- a/src/renderer/old.tsx\n-old\n'
              }
            ]
          },
          providerCompletedAt: '2026-07-07T10:04:00.000Z'
        })
      ]
    });

    expect(view?.activityTail).toMatchObject([
      {
        category: 'write',
        label: 'Wrote',
        detail: 'src/renderer/pages/Home.tsx',
        metric: '+2'
      },
      {
        category: 'edit',
        label: 'Edited',
        detail: 'src/renderer/router.tsx',
        metric: '+2 -1'
      },
      {
        category: 'edit',
        label: 'Deleted',
        detail: 'src/renderer/old.tsx',
        metric: '-1'
      }
    ]);
    expect(view?.activityTail.map((activity) => activity.tone)).toEqual(['neutral', 'neutral', 'neutral']);
  });

  it('maps verification and git commands cleanly', () => {
    const run = runFixture({ id: 'run-1', status: 'RUNNING' });

    const view = buildRunProgressViewModel({
      preferredRun: run,
      runs: [run],
      planRevisions: [],
      items: [
        itemFixture({
          id: 'git-command',
          providerItemId: 'git-command',
          type: 'COMMAND_EXECUTION',
          status: 'COMPLETED',
          payload: {
            command: 'git status --short',
            commandActions: [{ type: 'unknown', command: 'git status --short' }],
            durationMs: 120
          },
          providerCompletedAt: '2026-07-07T10:03:00.000Z'
        }),
        itemFixture({
          id: 'verification',
          providerItemId: 'verification',
          type: 'COMMAND_EXECUTION',
          status: 'COMPLETED',
          payload: {
            command: 'npm run typecheck',
            commandActions: [{ type: 'unknown', command: 'npm run typecheck' }],
            exitCode: 0,
            durationMs: 12_000
          },
          providerCompletedAt: '2026-07-07T10:04:00.000Z'
        })
      ]
    });

    expect(view?.activityTail).toMatchObject([
      {
        category: 'bash',
        label: 'Ran',
        detail: '2 commands',
        tone: 'neutral',
        status: 'completed',
        grouped: true,
        children: [
          {
            category: 'git',
            label: 'Ran',
            detail: 'git status --short',
            metric: 'for 120ms',
            status: 'completed'
          },
          {
            category: 'verify',
            label: 'Ran',
            detail: 'npm run typecheck',
            metric: 'for 12s',
            status: 'completed'
          }
        ]
      }
    ]);
  });

  it('omits completed generic commands but shows active and failed generic commands', () => {
    const run = runFixture({ id: 'run-1', status: 'RUNNING' });

    const view = buildRunProgressViewModel({
      preferredRun: run,
      runs: [run],
      planRevisions: [],
      items: [
        itemFixture({
          id: 'completed-generic',
          providerItemId: 'completed-generic',
          type: 'COMMAND_EXECUTION',
          status: 'COMPLETED',
          payload: { command: 'node scripts/generated-helper.mjs' },
          providerCompletedAt: '2026-07-07T10:06:00.000Z'
        }),
        itemFixture({
          id: 'active-generic',
          providerItemId: 'active-generic',
          type: 'COMMAND_EXECUTION',
          status: 'IN_PROGRESS',
          payload: { command: 'node scripts/generate-fixture.mjs' },
          providerStartedAt: '2026-07-07T10:04:00.000Z'
        }),
        itemFixture({
          id: 'failed-generic',
          providerItemId: 'failed-generic',
          type: 'COMMAND_EXECUTION',
          status: 'FAILED',
          payload: { command: 'node scripts/generate-fixture.mjs', exitCode: 1 },
          providerCompletedAt: '2026-07-07T10:05:00.000Z'
        })
      ]
    });

    expect(view?.activityTail).toMatchObject([
      {
        category: 'bash',
        label: 'Running',
        detail: 'node scripts/generate-fixture.mjs',
        status: 'active',
        tone: 'action'
      },
      {
        category: 'error',
        label: 'Command failed',
        detail: 'node scripts/generate-fixture.mjs',
        metric: 'exit 1',
        status: 'failed',
        tone: 'error'
      }
    ]);
    expect(JSON.stringify(view)).not.toContain('generated-helper');
  });

  it('caps the activity tail to the latest five entries in chronological order', () => {
    const run = runFixture({ id: 'run-1', status: 'RUNNING' });

    const view = buildRunProgressViewModel({
      preferredRun: run,
      runs: [run],
      planRevisions: [],
      items: Array.from({ length: 8 }, (_, index) =>
        itemFixture({
          id: `message-${index}`,
          providerItemId: `message-${index}`,
          payload: { text: `Progress: Reading src/file-${index}.ts.` },
          providerCompletedAt: `2026-07-07T10:0${index}:00.000Z`
        })
      )
    });

    expect(view?.steps).toEqual([
      {
        step: 'Waiting for provider plan...',
        status: 'IN_PROGRESS',
        pending: true
      }
    ]);
    expect(view?.activityTail).toHaveLength(5);
    expect(view?.activityTail.map((activity) => activity.label)).toEqual([
      'Reading src/file-3.ts.',
      'Reading src/file-4.ts.',
      'Reading src/file-5.ts.',
      'Reading src/file-6.ts.',
      'Reading src/file-7.ts.'
    ]);
  });

  it('summarizes raw command output without exposing it in overview activity', () => {
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
          status: 'COMPLETED',
          payload: {
            command: 'npm test',
            commandActions: [{ type: 'unknown', command: 'npm test' }],
            exitCode: 0,
            aggregatedOutput: 'secret output\nsecond line'
          },
          providerCompletedAt: '2026-07-07T10:04:00.000Z'
        })
      ]
    });

    expect(view?.activityOutputSummary).toBe('show full output · 2 lines');
    expect(JSON.stringify(view)).not.toContain('secret output');
    expect(JSON.stringify(view)).not.toContain('second line');
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
      activityTail: [],
      footer: {
        title: 'Completed',
        detail: '3 files changed · verification passed',
        tone: 'success'
      }
    });
    expect(view?.activityTail).toEqual([]);
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
        activityTail: [],
        footer: {
          title
        }
      });
      expect(view?.footer?.detail).not.toContain('/Users/rojhat');
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
    runtimeId: 'codex',
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
    runtimeId: 'codex',
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
