import { beforeEach, describe, expect, it } from 'vitest';
import {
  createInitialProjection,
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

  it('records changed expectations and states the bug’s next result again, even when it repeats an earlier one', () => {
    const gate = (state: string) => ({ caseId: 'case-1', title: 'Cart total should read "$45.00"', state, updatedAt: baseAt });
    const events = [
      event('BUG_CAPTURED', { gate: gate('REPRODUCING'), withCheck: true }),
      event('BUG_REPLAY_RUN_SETTLED', { gate: gate('REPRODUCED') }),
      event('BUG_CASE_DECIDED', { gate: gate('REPRODUCING'), decision: 'APPROVED', revision: 'EXPECTATION_CHANGED', change: 'Cart total should read "$46.00"' }),
      event('BUG_REPLAY_RUN_SETTLED', { gate: gate('REPRODUCED') })
    ];

    const ledger = buildTaskActivityLedger({ provider: 'GITHUB', task: taskFixture(), events });

    expect(ledger.map((item) => item.title)).toEqual(['Bug recorded', 'Bug reproduced', 'Expectations changed', 'Bug reproduced']);
    expect(ledger[2].evidence?.summary).toBe('Cart total should read "$46.00"');
  });

  it('hides brand-new tasks that only have creation activity', () => {
    const view = buildOverviewTaskActivityViewModel({
      provider: 'GITHUB',
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

    const ledger = buildTaskActivityLedger({ provider: 'GITHUB', task: taskFixture(), events });
    const overview = projectOverviewTaskActivity(ledger, { limit: 10 });
    const debug = projectDebugTaskActivity(ledger);

    expect(ledger.map((item) => item.title)).toEqual(['Task created', 'Checks failed']);
    expect(overview.items.map((item) => item.title)).toEqual(['Checks failed']);
    expect(debug.items.map((item) => item.title)).toEqual(['Task created', 'Checks failed']);
    expect(debug.items[1].evidence).toEqual(overview.items[0].evidence);
  });

  it('names a pending approval as an approval and a question as input', () => {
    const ledger = buildTaskActivityLedger({
      provider: 'GITHUB',
      task: taskFixture(),
      events: [
        event('AGENT_INTERACTION_REQUESTED', { type: 'COMMAND_APPROVAL' }),
        event('AGENT_INTERACTION_REQUESTED', { type: 'USER_INPUT' })
      ]
    });

    expect(ledger.map((item) => item.title)).toEqual(['Needs approval', 'Needs input']);
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

    const view = buildOverviewTaskActivityViewModel({ provider: 'GITHUB', task: taskFixture(), events, limit: 10 });

    expect(view.items.map((item) => item.title)).toEqual([
      'Draft PR available',
      'Checks pending',
      'Review requested'
    ]);
    expect(view.items.find((item) => item.title === 'Draft PR available')?.evidence).toBeUndefined();
    expect(allVisibleText(view.items)).not.toMatch(/sync|synced|refresh|refreshed/i);
  });

  it('records check status changes without repeating identical rollups', () => {
    const view = buildOverviewTaskActivityViewModel({
      provider: 'GITHUB',
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
      'Checks pending',
      'Checks failed',
      'Checks passed'
    ]);
    expect(view.items.find((item) => item.title === 'Checks failed')?.evidence?.summary).toBe(
      '1 failed check blocks PR readiness.'
    );
  });

  it('collapses adjacent duplicate overview rows without hiding debug activity', () => {
    const ledger = buildTaskActivityLedger({
      provider: 'GITHUB',
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

  it('shows the Task Monki retry outcome after provider completion', () => {
    const view = buildOverviewTaskActivityViewModel({
      provider: 'GITHUB',
      task: taskFixture(),
      events: [
        event('AGENT_RUN_COMPLETED', {}),
        event('IMPLEMENTATION_OUTCOME_BLOCKED', {
          reason: 'A provider execution request was declined and this run produced no Git change.'
        })
      ],
      limit: 10
    });

    expect(view.items.map((item) => item.title)).toEqual([
      'Implementation completed',
      'Implementation needs another pass'
    ]);
    // History states the observed reason; what to do about it is the Now panel's job.
    expect(view.items[1].evidence).toEqual({
      summary: expect.stringMatching(/declined.*no Git change/i)
    });
  });

  it('shows exact failed check evidence and the decision it blocks', () => {
    const view = buildOverviewTaskActivityViewModel({
      provider: 'GITHUB',
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
      provider: 'GITHUB',
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
      provider: 'GITHUB',
      task: taskFixture(),
      runs,
      events: [
        event(
          'AGENT_RUN_COMPLETED',
          {
            agentReviewStatus: 'NEEDS_CHANGES',
            agentReviewResult: {
              schemaVersion: 'agent-review/v1',
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
          status: 'CHANGES_REQUESTED',
          feedback: { reviewers: [{ name: 'alice', state: 'CHANGES_REQUESTED' }, { name: 'bob', state: 'APPROVED' }] }
        })
      ],
      limit: 10
    });

    // A reviewer asked, not the platform: the platform is the actor, the reviewer is named.
    expect(view.items.map((item) => `${item.actor}: ${item.title}`)).toEqual([
      'Reviewer: Review requested changes',
      'GitHub: alice requested changes'
    ]);
    expect(view.items[0].evidence).toBeUndefined();
  });

  it('names the uncommitted changes a running review reads with its commit', () => {
    const snapshot = (id: string, untrackedCount: number) => event('GIT_SNAPSHOT_CAPTURED', {
      id, headSha: 'f390644aa', dirtyFingerprint: `fp-${id}`, status: untrackedCount ? 'DIRTY' : 'CLEAN',
      stagedCount: 0, unstagedCount: 0, untrackedCount
    });
    const started = (snapshotId: string, runId: string) => event('AGENT_RUN_STARTED',
      { mode: 'REVIEW', beforeGitSnapshotId: snapshotId, reviewedHeadSha: 'f390644aa' }, { runId });
    const ledger = buildTaskActivityLedger({
      provider: 'GITHUB',
      task: taskFixture(),
      events: [snapshot('dirty', 2), started('dirty', 'review-1'), snapshot('clean', 0), started('clean', 'review-2')]
    });

    expect(ledger.filter((item) => item.title === 'Review started').map((item) => item.evidence?.summary)).toEqual([
      'Reviewed f390644 and uncommitted changes',
      'Reviewed f390644'
    ]);
  });

  it('surfaces stale local review as current Task Monki state', () => {
    const task = taskFixture({
      projection: {
        ...createInitialProjection(timeAt(0)),
        agentReview: {
          status: 'STALE',
          runId: 'review-run',
          reviewedHeadSha: 'abc123456789',
          updatedAt: timeAt(4)
        },
        updatedAt: timeAt(4)
      }
    });

    const view = buildOverviewTaskActivityViewModel({
      provider: 'GITHUB',
      task,
      events: [
        event(
          'AGENT_RUN_COMPLETED',
          {
            agentReviewStatus: 'PASSED',
            agentReviewResult: {
              schemaVersion: 'agent-review/v1',
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
      actor: 'Reviewer',
      title: 'Review passed'
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
      provider: 'GITHUB',
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

  it('names one conflict once, however often its files are edited before it ends', () => {
    const conflicted = (fingerprint: string) => event('GIT_SNAPSHOT_CAPTURED', { status: 'CONFLICTED', dirtyFingerprint: fingerprint, conflictedCount: 1 });
    const view = buildOverviewTaskActivityViewModel({
      provider: 'GITHUB',
      task: taskFixture(),
      events: [
        conflicted('merge-started'),
        // The agent resolves the file; Git counts it as conflicted until the merge is committed.
        conflicted('agent-resolved'),
        event('GIT_SNAPSHOT_CAPTURED', { status: 'COMMITTED_UNPUSHED', dirtyFingerprint: 'merged', aheadCount: 2 }),
        conflicted('next-conflict')
      ],
      limit: 10
    });

    expect(view.items.map((item) => item.title).filter((title) => title === 'Git conflicts detected')).toHaveLength(2);
  });

  it('does not repeat pushed Git evidence when branch publication already explains delivery', () => {
    const view = buildOverviewTaskActivityViewModel({
      provider: 'GITHUB',
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
      provider: 'GITHUB',
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
    expect(view.items.find((item) => item.title === 'Transition blocked')?.evidence).toEqual({
      summary: 'Merge evidence is missing.'
    });
  });

  it('distinguishes recovery continuations and retries from ordinary follow-up activity', () => {
    const view = buildOverviewTaskActivityViewModel({
      provider: 'GITHUB',
      task: taskFixture(),
      runs: [
        run({ id: 'failed-source', mode: 'IMPLEMENTATION', status: 'FAILED' }),
        run({
          id: 'continuation-run',
          mode: 'FOLLOW_UP',
          status: 'RUNNING',
          continuedFromRunId: 'failed-source'
        }),
        run({
          id: 'retry-run',
          mode: 'RETRY',
          status: 'FAILED',
          retryOfRunId: 'failed-source'
        })
      ],
      events: [
        event('AGENT_RUN_STARTED', { mode: 'FOLLOW_UP' }, { runId: 'continuation-run' }),
        event('AGENT_RUN_FAILED', { error: 'Retry failed.' }, { runId: 'retry-run' })
      ],
      limit: 10
    });

    expect(view.items.map((item) => item.title)).toEqual([
      'Continuing unfinished work',
      'Retry failed'
    ]);
  });

  it('recognizes continuation after a locally blocked completed implementation', () => {
    const view = buildOverviewTaskActivityViewModel({
      provider: 'GITHUB',
      task: taskFixture(),
      runs: [
        run({ id: 'blocked-source', mode: 'IMPLEMENTATION', status: 'COMPLETED' }),
        run({
          id: 'continuation-run',
          mode: 'FOLLOW_UP',
          status: 'RUNNING',
          continuedFromRunId: 'blocked-source'
        })
      ],
      events: [
        event(
          'IMPLEMENTATION_OUTCOME_BLOCKED',
          { reason: 'No Git change.' },
          { runId: 'blocked-source' }
        ),
        event('AGENT_RUN_STARTED', { mode: 'FOLLOW_UP' }, { runId: 'continuation-run' })
      ],
      limit: 10
    });

    expect(view.items.map((item) => item.title)).toEqual([
      'Implementation needs another pass',
      'Continuing unfinished work'
    ]);
  });

  it('does not show a run start as active when the run record is already terminal', () => {
    const view = buildOverviewTaskActivityViewModel({
      provider: 'GITHUB',
      task: taskFixture(),
      runs: [run({ id: 'completed-run', mode: 'IMPLEMENTATION', status: 'COMPLETED' })],
      events: [event('AGENT_RUN_STARTED', { mode: 'IMPLEMENTATION' }, { runId: 'completed-run' })],
      limit: 10
    });

    expect(view.items).toEqual([]);
  });

  it('collapses duplicate PR terminal state observed through PR and merge snapshots', () => {
    const view = buildOverviewTaskActivityViewModel({
      provider: 'GITHUB',
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
      provider: 'GITHUB',
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

  it('names the platform the caller delivers on, before any merge request is recorded', () => {
    // A checkout whose only remotes are on GitLab: the task itself names no platform yet.
    const ledger = buildTaskActivityLedger({
      provider: 'GITLAB',
      task: taskFixture(),
      events: [event('GITHUB_SYNC_FAILED', { error: 'glab: 401 Unauthorized' })]
    });

    expect(ledger).toMatchObject([
      { actor: 'GitLab', title: 'Could not update GitLab evidence', evidence: { summary: 'glab: 401 Unauthorized' } }
    ]);
  });

  it('says its own words in GitLab\'s and leaves what the platform said as written', () => {
    const error = "unable to access 'https://gitlab.com/acme/PR-tools.git/': The requested URL returned error: 403";
    const ledger = buildTaskActivityLedger({
      provider: 'GITLAB',
      task: taskFixture(),
      events: [
        event('CI_ROLLUP_CAPTURED', {
          pullRequestNumber: 7,
          headSha: 'abc123456789',
          status: 'FAILING',
          pendingCount: 0,
          passingCount: 0,
          failingCount: 1,
          canceledCount: 0,
          checkDetails: [{ name: 'Mirror to GitHub', status: 'failed', link: 'https://gitlab.com/group/project/-/jobs/1' }]
        }),
        event('MERGE_SNAPSHOT_CAPTURED', { pullRequestNumber: 7, headSha: 'abc123456789', status: 'BLOCKED' }),
        event('BRANCH_PUBLISH_FAILED', { branchName: 'task/demo', remoteRef: 'origin/task/demo', error })
      ]
    });

    expect(ledger).toMatchObject([
      {
        actor: 'GitLab',
        title: 'Checks failed',
        evidence: {
          summary: '1 failed check blocks MR readiness.',
          rows: [{ label: 'Mirror to GitHub', value: 'Blocks MR readiness', href: 'https://gitlab.com/group/project/-/jobs/1' }]
        }
      },
      { actor: 'GitLab', title: 'Merge blocked', evidence: { summary: 'MR !7, Head abc1234' } },
      { actor: 'GitLab', title: 'Branch push failed', evidence: { summary: error } }
    ]);
  });

  it('records each merge Task Monki makes into the branch, with what it merged and at which commit', () => {
    const view = buildOverviewTaskActivityViewModel({
      provider: 'GITLAB',
      task: taskFixture(),
      events: [
        event('BRANCH_UPDATE_REQUESTED', { from: 'BASE', ref: 'main', sha: 'a'.repeat(40) }),
        event('BRANCH_UPDATE_REQUESTED', { from: 'PULL_REQUEST', ref: 'feature', sha: 'b'.repeat(40) })
      ],
      limit: 10
    });

    expect(view.items).toMatchObject([
      { actor: 'Git', title: 'Update with main requested', evidence: { summary: 'main at aaaaaaa' } },
      { actor: 'Git', title: 'Pull changes requested', evidence: { summary: 'feature at bbbbbbb' } }
    ]);
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
    kind: input.kind ?? 'NORMAL',
    runtimeId: 'codex',
    title: 'Add task activity',
    prompt: 'Build a useful overview history.',
    repositoryId: '/repo',
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

function run(
  input: Pick<RunRecord, 'id' | 'mode'> & Partial<RunRecord>
): RunRecord {
  const { id, mode, status = 'COMPLETED', ...overrides } = input;
  return {
    id,
    runtimeId: 'codex',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    sessionId: 'session-1',
    mode,
    origin: 'TASK_MONKI',
    status,
    recoveryState: 'NONE',
    requestedSettings: {},
    promptArtifactId: 'prompt',
    outputArtifactId: 'output',
    diagnosticArtifactId: 'diagnostic',
    startedAt: baseAt,
    eventCount: 0,
    ...overrides,
    attachmentSelection: overrides.attachmentSelection ?? []
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
