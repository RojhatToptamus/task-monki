import { describe, expect, it } from 'vitest';
import type { AgentPlanRevisionRecord, RunRecord } from '../../shared/contracts';
import {
  makeAgentItemRecord as itemFixture,
  makeGitSnapshotRecord as gitSnapshotFixture,
  makeRawMessage,
  makeRunRecord as runFixture
} from '../../testSupport/rendererRecords';
import { buildRunProgressViewModel, canStopTaskRun } from './runProgress';

describe('run progress model', () => {
  it('offers Stop only before submission or after provider acknowledgement', () => {
    expect(canStopTaskRun(runFixture({ status: 'QUEUED', providerTurnId: undefined }))).toBe(
      true
    );
    expect(canStopTaskRun(runFixture({ status: 'STARTING', providerTurnId: undefined }))).toBe(
      false
    );
    expect(canStopTaskRun(runFixture({ status: 'STARTING', providerTurnId: 'turn-sending' }))).toBe(
      false
    );
    expect(canStopTaskRun(runFixture({ status: 'RUNNING', providerTurnId: 'turn-1' }))).toBe(
      true
    );
    expect(canStopTaskRun(runFixture({ status: 'INTERRUPTING', providerTurnId: 'turn-1' }))).toBe(
      false
    );
  });

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
    rawMessage: makeRawMessage(),
    observedAt: '2026-07-07T10:01:00.000Z',
    ...overrides
  };
}
