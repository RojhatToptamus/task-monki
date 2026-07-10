import { beforeEach, describe, expect, it } from 'vitest';
import {
  createInitialProjection,
  type AgentRunMode,
  type DomainEvent,
  type RunRecord,
  type Task
} from '../../shared/contracts';
import {
  buildOverviewTaskActivityViewModel,
  buildTaskActivityLedger,
  projectDebugTaskActivity,
  projectOverviewTaskActivity
} from './taskActivity';

const baseAt = '2026-07-02T10:00:00.000Z';

describe('task activity model', () => {
  beforeEach(() => {
    sequence = 0;
  });

  it('hides brand-new tasks that only have creation activity', () => {
    const view = buildOverviewTaskActivityViewModel({
      task: taskFixture(),
      events: [event('TASK_CREATED', { title: 'Add activity timeline' })]
    });

    expect(view.items).toEqual([]);
    expect(view.hiddenCount).toBe(0);
  });

  it('uses one canonical ledger while Overview and Debug apply different visibility policies', () => {
    const events = [
      event('TASK_CREATED', { title: 'Add activity timeline' }),
      event('CI_ROLLUP_CAPTURED', {
        pullRequestNumber: 82,
        headSha: 'abc123456789',
        status: 'FAILING',
        pendingCount: 0,
        passingCount: 1,
        failingCount: 1,
        canceledCount: 0,
        checkDetails: [
          {
            name: 'lint-and-test',
            workflow: 'CI',
            status: 'failed',
            link: 'https://github.com/example/repo/actions/runs/1'
          }
        ]
      })
    ];

    const ledger = buildTaskActivityLedger({ task: taskFixture(), events });
    const overview = projectOverviewTaskActivity(ledger, { limit: 10 });
    const debug = projectDebugTaskActivity(ledger);

    expect(ledger.map((item) => item.title)).toEqual(['Task created', 'Checks failed']);
    expect(overview.items.map((item) => item.title)).toEqual(['Checks failed']);
    expect(debug.items.map((item) => item.title)).toEqual(['Task created', 'Checks failed']);
    expect(debug.items[1].evidence).toEqual(overview.items[0].evidence);
  });

  it('keeps GitHub verdict changes and drops no-op refresh captures', () => {
    const events = [
      event('PR_SNAPSHOT_CAPTURED', {
        id: 'pr-1',
        number: 82,
        status: 'OPEN_DRAFT',
        isDraft: true,
        headRefOid: 'abc123456789',
        baseRefName: 'main'
      }),
      event('CI_ROLLUP_CAPTURED', {
        id: 'ci-1',
        pullRequestNumber: 82,
        headSha: 'abc123456789',
        status: 'PENDING',
        pendingCount: 2,
        passingCount: 0,
        failingCount: 0,
        canceledCount: 0
      }),
      event('REVIEW_ROLLUP_CAPTURED', {
        id: 'review-1',
        pullRequestNumber: 82,
        headSha: 'abc123456789',
        status: 'REQUESTED'
      }),
      event('MERGE_SNAPSHOT_CAPTURED', {
        id: 'merge-1',
        pullRequestNumber: 82,
        headSha: 'abc123456789',
        status: 'NOT_MERGED'
      }),
      event('PR_SNAPSHOT_CAPTURED', {
        id: 'pr-2',
        number: 82,
        status: 'OPEN_DRAFT',
        isDraft: true,
        headRefOid: 'abc123456789',
        baseRefName: 'main'
      }),
      event('CI_ROLLUP_CAPTURED', {
        id: 'ci-2',
        pullRequestNumber: 82,
        headSha: 'abc123456789',
        status: 'PENDING',
        pendingCount: 2,
        passingCount: 0,
        failingCount: 0,
        canceledCount: 0
      }),
      event('REVIEW_ROLLUP_CAPTURED', {
        id: 'review-2',
        pullRequestNumber: 82,
        headSha: 'abc123456789',
        status: 'REQUESTED'
      })
    ];

    const view = buildOverviewTaskActivityViewModel({ task: taskFixture(), events, limit: 10 });

    expect(view.items.map((item) => item.title)).toEqual([
      'Draft PR available',
      'Checks running',
      'GitHub review requested'
    ]);
    expect(view.items.find((item) => item.title === 'Draft PR available')?.evidence).toBeUndefined();
    expect(allVisibleText(view.items)).not.toMatch(/sync|synced|refresh|refreshed/i);
  });

  it('records check status changes without repeating identical rollups', () => {
    const view = buildOverviewTaskActivityViewModel({
      task: taskFixture(),
      events: [
        ciEvent('PENDING', { pendingCount: 2 }),
        ciEvent('PENDING', { pendingCount: 2 }),
        ciEvent('FAILING', { failingCount: 1, passingCount: 1 }),
        ciEvent('PASSING', { passingCount: 2 })
      ],
      limit: 10
    });

    expect(view.items.map((item) => item.title)).toEqual([
      'Checks running',
      'Checks failed',
      'Checks passed'
    ]);
    expect(view.items.find((item) => item.title === 'Checks failed')?.evidence?.summary).toBe(
      '1 failed check blocks PR readiness.'
    );
  });

  it('collapses adjacent duplicate overview rows without hiding debug activity', () => {
    const ledger = buildTaskActivityLedger({
      task: taskFixture(),
      events: [
        event('AGENT_RUN_COMPLETED', {}),
        event('AGENT_RUN_COMPLETED', {})
      ]
    });
    const overview = projectOverviewTaskActivity(ledger, { limit: 10 });
    const debug = projectDebugTaskActivity(ledger);

    expect(debug.items.map((item) => item.title)).toEqual([
      'Implementation completed',
      'Implementation completed'
    ]);
    expect(overview.items.map((item) => item.title)).toEqual(['Implementation completed']);
  });

  it('shows exact failed check evidence and the decision it blocks', () => {
    const view = buildOverviewTaskActivityViewModel({
      task: taskFixture(),
      events: [
        event('CI_ROLLUP_CAPTURED', {
          pullRequestNumber: 82,
          headSha: 'abc123456789',
          status: 'FAILING',
          pendingCount: 0,
          passingCount: 2,
          failingCount: 1,
          canceledCount: 0,
          checkDetails: [
            {
              name: 'lint-and-test',
              workflow: 'CI',
              status: 'failed',
              link: 'https://github.com/example/repo/actions/runs/1'
            }
          ]
        })
      ],
      limit: 10
    });

    expect(view.items[0]).toMatchObject({
      title: 'Checks failed',
      evidence: {
        summary: '1 failed check blocks PR readiness.',
        rows: [
          {
            label: 'CI / lint-and-test',
            value: 'Blocks PR readiness',
            href: 'https://github.com/example/repo/actions/runs/1'
          }
        ]
      }
    });
  });

  it('replaces weaker check evidence when exact check rows arrive for the same verdict', () => {
    const view = buildOverviewTaskActivityViewModel({
      task: taskFixture(),
      events: [
        event('CI_ROLLUP_CAPTURED', {
          pullRequestNumber: 82,
          headSha: 'abc123456789',
          status: 'FAILING',
          pendingCount: 0,
          passingCount: 2,
          failingCount: 1,
          canceledCount: 0,
          checkDetails: []
        }),
        event('CI_ROLLUP_CAPTURED', {
          pullRequestNumber: 82,
          headSha: 'abc123456789',
          status: 'FAILING',
          pendingCount: 0,
          passingCount: 2,
          failingCount: 1,
          canceledCount: 0,
          checkDetails: [
            {
              name: 'typecheck',
              workflow: 'CI',
              status: 'failed',
              link: 'https://github.com/example/repo/actions/runs/2'
            }
          ]
        })
      ],
      limit: 10
    });

    expect(view.items.map((item) => item.title)).toEqual(['Checks failed']);
    expect(view.items[0].evidence).toMatchObject({
      summary: '1 failed check blocks PR readiness.',
      rows: [
        {
          label: 'CI / typecheck',
          value: 'Blocks PR readiness',
          href: 'https://github.com/example/repo/actions/runs/2'
        }
      ]
    });
  });

  it('keeps local review and GitHub review decisions separate', () => {
    const runs = [run({ id: 'review-run', mode: 'REVIEW' })];
    const view = buildOverviewTaskActivityViewModel({
      task: taskFixture(),
      runs,
      events: [
        event(
          'AGENT_RUN_COMPLETED',
          {
            codexReviewStatus: 'NEEDS_CHANGES',
            codexReviewResult: {
              schemaVersion: 'codex-review/v1',
              verdict: 'NEEDS_CHANGES',
              summary: 'Needs one fix.',
              findings: [{ id: 'finding-1' }]
            }
          },
          { runId: 'review-run' }
        ),
        event('REVIEW_ROLLUP_CAPTURED', {
          pullRequestNumber: 82,
          headSha: 'abc123456789',
          status: 'CHANGES_REQUESTED'
        })
      ],
      limit: 10
    });

    expect(view.items.map((item) => `${item.actor}: ${item.title}`)).toEqual([
      'Review: Requested changes',
      'GitHub: GitHub requested changes'
    ]);
    expect(view.items[0].evidence).toBeUndefined();
  });

  it('surfaces stale local review as current Task Monki state', () => {
    const task = taskFixture({
      projection: {
        ...createInitialProjection(timeAt(0)),
        codexReview: {
          status: 'STALE',
          runId: 'review-run',
          reviewedHeadSha: 'abc123456789',
          updatedAt: timeAt(4)
        },
        updatedAt: timeAt(4)
      }
    });

    const view = buildOverviewTaskActivityViewModel({
      task,
      events: [
        event(
          'AGENT_RUN_COMPLETED',
          {
            codexReviewStatus: 'PASSED',
            codexReviewResult: {
              schemaVersion: 'codex-review/v1',
              verdict: 'PASSED',
              summary: 'No issues.',
              findings: []
            }
          },
          { runId: 'review-run' }
        )
      ],
      runs: [run({ id: 'review-run', mode: 'REVIEW' })],
      limit: 10
    });

    expect(view.items[0]).toMatchObject({
      actor: 'Review',
      title: 'Passed'
    });
    expect(view.items[0].evidence).toBeUndefined();
    expect(view.items[1]).toMatchObject({
      actor: 'Task Monki',
      title: 'Review became stale',
      tone: 'action'
    });
    expect(view.items[1].evidence).toBeUndefined();
  });

  it('collapses repeated Git snapshots but keeps real Git state changes', () => {
    const view = buildOverviewTaskActivityViewModel({
      task: taskFixture(),
      events: [
        event('GIT_SNAPSHOT_CAPTURED', {
          status: 'DIRTY',
          dirtyFingerprint: 'dirty-1',
          workingDiffFileCount: 2
        }),
        event('GIT_SNAPSHOT_CAPTURED', {
          status: 'DIRTY',
          dirtyFingerprint: 'dirty-1',
          workingDiffFileCount: 2
        }),
        event('GIT_SNAPSHOT_CAPTURED', {
          status: 'DIRTY',
          dirtyFingerprint: 'dirty-2',
          workingDiffFileCount: 3
        }),
        event('GIT_SNAPSHOT_CAPTURED', {
          status: 'CLEAN',
          dirtyFingerprint: 'clean-1',
          workingDiffFileCount: 0
        })
      ],
      limit: 10
    });

    expect(view.items.map((item) => item.title)).toEqual([
      'Working changes captured',
      'Working changes captured',
      'Worktree clean'
    ]);
  });

  it('does not repeat pushed Git evidence when branch publication already explains delivery', () => {
    const view = buildOverviewTaskActivityViewModel({
      task: taskFixture(),
      events: [
        event('BRANCH_PUBLISHED', {
          branchName: 'task/demo',
          remoteRef: 'origin/task/demo',
          headSha: 'abc123456789'
        }),
        event('GIT_SNAPSHOT_CAPTURED', {
          status: 'PUSHED',
          headSha: 'abc123456789',
          dirtyFingerprint: 'pushed-1',
          committedDiffFileCount: 1,
          aheadCount: 0
        })
      ],
      limit: 10
    });

    expect(view.items.map((item) => item.title)).toEqual(['Branch pushed']);
    expect(view.items[0].evidence).toBeUndefined();
  });

  it('shows active starts, terminal failures, blocked transitions, failed pushes, and merges', () => {
    const view = buildOverviewTaskActivityViewModel({
      task: taskFixture(),
      runs: [
        run({ id: 'active-run', mode: 'IMPLEMENTATION', status: 'RUNNING' }),
        run({ id: 'failed-run', mode: 'FOLLOW_UP', status: 'FAILED' })
      ],
      events: [
        event('AGENT_RUN_STARTED', { mode: 'IMPLEMENTATION' }, { runId: 'active-run' }),
        event('AGENT_RUN_FAILED', { error: 'Command failed.' }, { runId: 'failed-run' }),
        event('TRANSITION_BLOCKED', { toPhase: 'DONE', reason: 'Merge evidence is missing.' }),
        event('BRANCH_PUBLISH_FAILED', {
          branchName: 'task/demo',
          remoteRef: 'origin/task/demo',
          error: 'Remote rejected the push.'
        }),
        event('MERGE_SNAPSHOT_CAPTURED', {
          pullRequestNumber: 82,
          headSha: 'abc123456789',
          status: 'MERGED',
          mergedAt: timeAt(5)
        })
      ],
      limit: 10
    });

    expect(view.items.map((item) => item.title)).toEqual([
      'Implementation started',
      'Follow-up implementation failed',
      'Transition blocked',
      'Branch push failed',
      'PR merged'
    ]);
    expect(view.items.find((item) => item.title === 'Transition blocked')?.evidence).toMatchObject({
      summary: 'Blocks marking the task done.',
      rows: [{ label: 'Reason', value: 'Merge evidence is missing.' }]
    });
  });

  it('does not show a run start as active when the run record is already terminal', () => {
    const view = buildOverviewTaskActivityViewModel({
      task: taskFixture(),
      runs: [run({ id: 'completed-run', mode: 'IMPLEMENTATION', status: 'COMPLETED' })],
      events: [event('AGENT_RUN_STARTED', { mode: 'IMPLEMENTATION' }, { runId: 'completed-run' })],
      limit: 10
    });

    expect(view.items).toEqual([]);
  });

  it('collapses duplicate PR terminal state observed through PR and merge snapshots', () => {
    const view = buildOverviewTaskActivityViewModel({
      task: taskFixture(),
      events: [
        event('PR_SNAPSHOT_CAPTURED', {
          number: 82,
          status: 'MERGED',
          isDraft: false,
          headRefOid: 'abc123456789',
          url: 'https://github.com/example/repo/pull/82'
        }),
        event('MERGE_SNAPSHOT_CAPTURED', {
          pullRequestNumber: 82,
          headSha: 'abc123456789',
          status: 'MERGED',
          mergedAt: timeAt(3)
        })
      ],
      limit: 10
    });

    expect(view.items.map((item) => item.title)).toEqual(['PR merged']);
    expect(view.hiddenCount).toBe(0);
  });

  it('shows the latest bounded window in chronological order', () => {
    const view = buildOverviewTaskActivityViewModel({
      task: taskFixture(),
      events: [
        event('WORKTREE_CREATED', { branchName: 'task/demo' }),
        event('AGENT_RUN_STARTED', { mode: 'IMPLEMENTATION' }, { runId: 'active-run' }),
        event('BRANCH_PUBLISHED', { remoteRef: 'origin/task/demo', headSha: 'abc123456789' })
      ],
      limit: 2
    });

    expect(view.items.map((item) => item.title)).toEqual([
      'Implementation started',
      'Branch pushed'
    ]);
    expect(view.hiddenCount).toBe(1);
  });
});

function ciEvent(
  status: 'PENDING' | 'PASSING' | 'FAILING',
  counts: Partial<{
    pendingCount: number;
    passingCount: number;
    failingCount: number;
    canceledCount: number;
  }>
): DomainEvent {
  return event('CI_ROLLUP_CAPTURED', {
    pullRequestNumber: 82,
    headSha: 'abc123456789',
    status,
    pendingCount: counts.pendingCount ?? 0,
    passingCount: counts.passingCount ?? 0,
    failingCount: counts.failingCount ?? 0,
    canceledCount: counts.canceledCount ?? 0
  });
}

let sequence = 0;

function event(
  type: DomainEvent['type'],
  payload: unknown,
  options: { runId?: string } = {}
): DomainEvent {
  sequence += 1;
  const at = timeAt(sequence);
  return {
    id: `${type}-${sequence}`,
    type,
    taskId: 'task-1',
    runId: options.runId,
    source: 'ui',
    sourceEventId: `${type}-${sequence}`,
    occurredAt: at,
    receivedAt: at,
    payload
  };
}

function taskFixture(input: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Add task activity',
    prompt: 'Build a useful overview history.',
    repositoryPath: '/repo',
    workflowPhase: 'REVIEW',
    resolution: 'NONE',
    completionPolicy: 'LOCAL_ACCEPTANCE',
    phaseVersion: 1,
    forkedAlternativeTaskIds: [],
    agentSettings: {},
    createdAt: baseAt,
    updatedAt: baseAt,
    projection: createInitialProjection(baseAt),
    ...input
  };
}

function run(input: {
  id: string;
  mode: AgentRunMode;
  status?: RunRecord['status'];
}): RunRecord {
  return {
    id: input.id,
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    sessionId: 'session-1',
    mode: input.mode,
    origin: 'TASK_MONKI',
    status: input.status ?? 'COMPLETED',
    recoveryState: 'NONE',
    requestedSettings: {},
    promptArtifactId: 'prompt',
    outputArtifactId: 'output',
    diagnosticArtifactId: 'diagnostic',
    startedAt: baseAt,
    eventCount: 0
  };
}

function timeAt(minutes: number): string {
  return new Date(Date.parse(baseAt) + minutes * 60_000).toISOString();
}

function allVisibleText(items: Array<{
  title: string;
  evidence?: { summary: string; rows?: Array<{ label: string; value?: string }> };
}>): string {
  return items
    .map((item) =>
      [
        item.title,
        item.evidence?.summary,
        ...(item.evidence?.rows ?? []).flatMap((row) => [row.label, row.value])
      ]
        .filter(Boolean)
        .join(' ')
    )
    .join(' ');
}
