import { describe, expect, it } from 'vitest';
import { createInitialProjection } from '../../shared/contracts';
import type { DomainEvent, RunRecord, Task } from '../../shared/contracts';
import { applyEventToState, createEmptyState, reduceProjection, reduceRun } from './reducer';

const now = '2026-06-20T10:00:00.000Z';

describe('projection reducer', () => {
  it('separates agent completion from process exit', () => {
    const projection = createInitialProjection(now);
    const run = createRun();
    const event = createEvent('AGENT_RUN_COMPLETED', {
      terminalStatus: 'completed',
      finalArtifactId: 'artifact-1'
    });

    const next = reduceProjection(projection, event, run);

    expect(next.agentRun).toBe('COMPLETED');
    expect(next.artifact).toBe('FINAL_MESSAGE_PRESENT');
    expect(next.osProcess).toBe('UNKNOWN');
    expect(next.summary).toContain('independent Git evidence');
  });

  it('clears a started App Server turn process state on the authoritative terminal event', () => {
    const run = createRun();
    const started = reduceProjection(
      createInitialProjection(now),
      createEvent('AGENT_RUN_STARTED', { mode: 'IMPLEMENTATION' }),
      run
    );
    const completed = reduceProjection(
      started,
      createEvent('AGENT_RUN_COMPLETED', {
        terminalStatus: 'completed',
        finalArtifactId: 'artifact-1'
      }),
      { ...run, status: 'COMPLETED' }
    );

    expect(started.osProcess).toBe('SPAWNING');
    expect(completed.agentRun).toBe('COMPLETED');
    expect(completed.osProcess).toBe('EXITED');
  });

  it('preserves a completed review summary across matching Git and provider goal updates', () => {
    const projection = {
      ...createInitialProjection(now),
      agentReview: {
        status: 'PASSED' as const,
        reviewedHeadSha: 'abc',
        reviewedDirtyFingerprint: 'fp-1',
        summary: 'Review passed with no findings.'
      },
      summary: 'Review passed with no findings.'
    };
    const afterGit = reduceProjection(
      projection,
      createEvent('GIT_SNAPSHOT_CAPTURED', {
        headSha: 'abc',
        dirtyFingerprint: 'fp-1',
        status: 'DIRTY'
      })
    );
    const afterGoal = reduceProjection(
      afterGit,
      createEvent('AGENT_GOAL_UPDATED', { syncState: 'IN_SYNC' })
    );

    expect(afterGit.agentReview?.status).toBe('PASSED');
    expect(afterGit.summary).toBe('Review passed with no findings.');
    expect(afterGoal.summary).toBe('Review passed with no findings.');
  });

  it('promotes the completed review summary across the matching post-review Git snapshot', () => {
    const projection = {
      ...createInitialProjection(now),
      agentReview: {
        status: 'PASSED' as const,
        reviewedHeadSha: 'abc',
        reviewedDirtyFingerprint: 'fp-1',
        summary: 'Review passed with no findings.'
      },
      summary: 'Agent turn completed. Review the provider result and independent Git evidence.'
    };
    const afterGit = reduceProjection(
      projection,
      createEvent('GIT_SNAPSHOT_CAPTURED', {
        headSha: 'abc',
        dirtyFingerprint: 'fp-1',
        status: 'DIRTY'
      })
    );

    expect(afterGit.agentReview?.status).toBe('PASSED');
    expect(afterGit.summary).toBe('Review passed with no findings.');
  });

  it('surfaces review staleness when a Git snapshot differs from the reviewed diff', () => {
    const projection = {
      ...createInitialProjection(now),
      agentReview: {
        status: 'PASSED' as const,
        reviewedHeadSha: 'abc',
        reviewedDirtyFingerprint: 'fp-1',
        summary: 'Review passed with no findings.'
      },
      summary: 'Review passed with no findings.'
    };
    const next = reduceProjection(
      projection,
      createEvent('GIT_SNAPSHOT_CAPTURED', {
        headSha: 'abc',
        dirtyFingerprint: 'fp-2',
        status: 'DIRTY'
      })
    );

    expect(next.agentReview?.status).toBe('STALE');
    expect(next.summary).toBe('The current diff changed after this agent review.');
  });

  it('records non-zero process exits as errors', () => {
    const projection = createInitialProjection(now);
    const next = reduceProjection(projection, createEvent('PROCESS_EXITED', { exitCode: 2 }));

    expect(next.osProcess).toBe('EXITED');
    expect(next.health).toBe('ERROR');
    expect(next.findings.some((finding) => finding.code === 'PROCESS_NON_ZERO_EXIT')).toBe(true);
  });

  it('marks cancellation as waiting until a signal or terminal event arrives', () => {
    const projection = createInitialProjection(now);
    const next = reduceProjection(projection, createEvent('CANCEL_REQUESTED', {}));

    expect(next.requestedAction).toBe('CANCEL_REQUESTED');
    expect(next.osProcess).toBe('CANCELING');
    expect(next.summary).toContain('waiting');
  });

  it('does not let an old iteration event overwrite the current task projection', () => {
    const task: Task = {
      id: 'task-1',
      runtimeId: 'codex',
      title: 'Task',
      prompt: 'Prompt',
      repositoryPath: '/tmp/repo',
      workflowPhase: 'IN_PROGRESS',
      resolution: 'NONE',
      completionPolicy: 'LOCAL_ACCEPTANCE',
      phaseVersion: 2,
      forkedAlternativeTaskIds: [],
      currentIterationId: 'iteration-new',
      agentSettings: {},
      createdAt: now,
      updatedAt: now,
      projection: createInitialProjection(now)
    };
    const state = applyEventToState(
      { ...createEmptyState(), tasks: [task] },
      {
        ...createEvent('AGENT_RUN_COMPLETED', {
          terminalStatus: 'completed',
          finalArtifactId: 'artifact-old'
        }),
        iterationId: 'iteration-old'
      }
    );

    expect(state.tasks[0].projection.agentRun).toBe('IDLE');
    expect(state.tasks[0].workflowPhase).toBe('IN_PROGRESS');
  });

  it('keeps failed and interrupted implementation work in progress for retry', () => {
    const implementation = createRun({ mode: 'IMPLEMENTATION' });
    const task = createTask({
      workflowPhase: 'IN_PROGRESS',
      currentRunId: implementation.id
    });
    const initial = { ...createEmptyState(), tasks: [task], runs: [implementation] };

    const failed = applyEventToState(
      initial,
      createEvent('AGENT_RUN_FAILED', { error: 'Provider start failed.' })
    );
    const interrupted = applyEventToState(
      initial,
      createEvent('AGENT_RUN_INTERRUPTED', { terminalReason: 'Stopped by user.' })
    );

    expect(failed.tasks[0].workflowPhase).toBe('IN_PROGRESS');
    expect(failed.tasks[0].projection.agentRun).toBe('FAILED');
    expect(interrupted.tasks[0].workflowPhase).toBe('IN_PROGRESS');
    expect(interrupted.tasks[0].projection.agentRun).toBe('INTERRUPTED');
  });

  it('blocks review without rewriting a provider-completed run', () => {
    const implementation = createRun({
      mode: 'IMPLEMENTATION',
      status: 'COMPLETED'
    });
    const task = createTask({
      workflowPhase: 'REVIEW',
      currentRunId: implementation.id,
      projection: {
        ...createInitialProjection(now),
        requestedAction: 'SUCCEEDED',
        agentRun: 'COMPLETED'
      }
    });
    const next = applyEventToState(
      { ...createEmptyState(), tasks: [task], runs: [implementation] },
      createEvent('IMPLEMENTATION_OUTCOME_BLOCKED', {
        reason: 'A provider execution request was declined and this run produced no Git change.'
      })
    );

    expect(next.runs[0].status).toBe('COMPLETED');
    expect(next.tasks[0].workflowPhase).toBe('IN_PROGRESS');
    expect(next.tasks[0].projection).toMatchObject({
      requestedAction: 'FAILED',
      agentRun: 'COMPLETED',
      health: 'WARNING',
      implementationRetry: {
        runId: implementation.id,
        reason: expect.stringMatching(/declined.*no Git change/i)
      }
    });
    expect(next.tasks[0].projection.summary).toMatch(/declined.*no Git change/i);

    const afterTransition = applyEventToState(
      next,
      createEvent('TRANSITION_COMPLETED', { toPhase: 'IN_PROGRESS' })
    );
    expect(afterTransition.tasks[0].projection.implementationRetry?.runId).toBe(
      implementation.id
    );

    const replacement = createRun({
      id: 'run-2',
      mode: 'RETRY',
      status: 'STARTING'
    });
    const replacementTask = {
      ...afterTransition.tasks[0],
      currentRunId: replacement.id
    };
    const afterRetryStarted = applyEventToState(
      {
        ...afterTransition,
        tasks: [replacementTask],
        runs: [...afterTransition.runs, replacement]
      },
      {
        ...createEvent('AGENT_RUN_STARTED', { mode: 'RETRY' }),
        runId: replacement.id
      }
    );
    expect(afterRetryStarted.tasks[0].projection.implementationRetry).toBeUndefined();
  });

  it('enters review only when reconciliation proves implementation completed', () => {
    const implementation = createRun({
      mode: 'IMPLEMENTATION',
      status: 'RECOVERY_REQUIRED',
      recoveryState: 'RECONCILING'
    });
    const task = createTask({
      workflowPhase: 'IN_PROGRESS',
      currentRunId: implementation.id
    });
    const initial = { ...createEmptyState(), tasks: [task], runs: [implementation] };

    const failed = applyEventToState(
      initial,
      createEvent('AGENT_RUNTIME_RECONCILED', {
        terminal: true,
        status: 'FAILED',
        recoveryState: 'UNRECOVERABLE'
      })
    );
    const completed = applyEventToState(
      initial,
      createEvent('AGENT_RUNTIME_RECONCILED', {
        terminal: true,
        status: 'COMPLETED',
        recoveryState: 'RECOVERED'
      })
    );

    expect(failed.tasks[0].workflowPhase).toBe('IN_PROGRESS');
    expect(completed.tasks[0].workflowPhase).toBe('REVIEW');
  });

  it('does not promote analysis, compaction, or subagent completion to review', () => {
    for (const mode of ['ANALYSIS', 'COMPACTION', 'SUBAGENT'] as const) {
      const run = createRun({ mode });
      const task = createTask({
        workflowPhase: 'IN_PROGRESS',
        currentRunId: run.id
      });
      const initial = { ...createEmptyState(), tasks: [task], runs: [run] };

      const completed = applyEventToState(
        initial,
        createEvent('AGENT_RUN_COMPLETED', { terminalStatus: 'completed' })
      );
      const reconciled = applyEventToState(
        initial,
        createEvent('AGENT_RUNTIME_RECONCILED', {
          terminal: true,
          status: 'COMPLETED',
          recoveryState: 'RECOVERED'
        })
      );

      expect(completed.tasks[0].workflowPhase).toBe('IN_PROGRESS');
      expect(reconciled.tasks[0].workflowPhase).toBe('IN_PROGRESS');
    }
  });

  it('keeps Codex review runs in Review and records an inconclusive review result', () => {
    const task: Task = {
      id: 'task-1',
      runtimeId: 'codex',
      title: 'Task',
      prompt: 'Prompt',
      repositoryPath: '/tmp/repo',
      workflowPhase: 'REVIEW',
      resolution: 'NONE',
      completionPolicy: 'LOCAL_ACCEPTANCE',
      phaseVersion: 2,
      forkedAlternativeTaskIds: [],
      currentIterationId: 'iteration-1',
      currentRunId: 'implementation-run',
      agentSettings: {},
      createdAt: now,
      updatedAt: now,
      projection: {
        ...createInitialProjection(now),
        agentRun: 'COMPLETED',
        summary: 'Implementation completed.'
      }
    };
    const reviewRun = createRun({ id: 'review-run', mode: 'REVIEW' });
    const implementationRun = createRun({
      id: 'implementation-run',
      mode: 'IMPLEMENTATION',
      status: 'COMPLETED'
    });
    const started = applyEventToState(
      { ...createEmptyState(), tasks: [task], runs: [implementationRun, reviewRun] },
      {
        ...createEvent('TRANSITION_REQUESTED', {
          fromPhase: 'REVIEW',
          toPhase: 'IN_PROGRESS'
        }),
        runId: 'review-run'
      }
    );
    const running = applyEventToState(
      started,
      {
        ...createEvent('AGENT_RUN_STARTED', {
          mode: 'REVIEW',
          beforeGitSnapshotId: 'git-1',
          reviewedHeadSha: 'abc',
          reviewedDirtyFingerprint: 'fp-1'
        }),
        runId: 'review-run'
      }
    );
    const completed = applyEventToState(
      applyEventToState(running, {
        ...createEvent('PROCESS_STARTED', { pid: 123 }),
        runId: 'review-run'
      }),
      {
        ...createEvent('AGENT_RUN_COMPLETED', {
          terminalStatus: 'completed',
          finalArtifactId: 'artifact-review'
        }),
        runId: 'review-run'
      }
    );

    expect(started.tasks[0].workflowPhase).toBe('REVIEW');
    expect(started.tasks[0].currentRunId).toBe('implementation-run');
    expect(started.tasks[0].projection.agentRun).toBe('COMPLETED');
    expect(running.tasks[0].workflowPhase).toBe('REVIEW');
    expect(running.tasks[0].projection.agentReview?.status).toBe('RUNNING');
    expect(running.tasks[0].projection.agentRun).toBe('COMPLETED');
    expect(completed.tasks[0].workflowPhase).toBe('REVIEW');
    expect(completed.tasks[0].projection.agentReview?.status).toBe('INCONCLUSIVE');
    expect(completed.tasks[0].projection.agentReview?.finalArtifactId).toBe('artifact-review');
    expect(completed.tasks[0].projection.agentRun).toBe('COMPLETED');
  });

  it('stores structured Codex review findings and derives needs-changes status', () => {
    const task: Task = {
      id: 'task-1',
      runtimeId: 'codex',
      title: 'Task',
      prompt: 'Prompt',
      repositoryPath: '/tmp/repo',
      workflowPhase: 'REVIEW',
      resolution: 'NONE',
      completionPolicy: 'LOCAL_ACCEPTANCE',
      phaseVersion: 2,
      forkedAlternativeTaskIds: [],
      currentIterationId: 'iteration-1',
      currentRunId: 'implementation-run',
      agentSettings: {},
      createdAt: now,
      updatedAt: now,
      projection: {
        ...createInitialProjection(now),
        agentRun: 'COMPLETED',
        agentReview: { status: 'RUNNING', runId: 'review-run' }
      }
    };
    const completed = applyEventToState(
      {
        ...createEmptyState(),
        tasks: [task],
        runs: [
          createRun({ id: 'implementation-run', mode: 'IMPLEMENTATION', status: 'COMPLETED' }),
          createRun({ id: 'review-run', mode: 'REVIEW', status: 'RUNNING' })
        ]
      },
      {
        ...createEvent('AGENT_RUN_COMPLETED', {
          terminalStatus: 'completed',
          agentReviewResult: {
            schemaVersion: 'agent-review/v1',
            verdict: 'PASSED',
            summary: 'Found a blocker despite provider verdict.',
            findings: [
              {
                id: 'leak',
                severity: 'BLOCKER',
                title: 'Listener is not cleaned up',
                explanation: 'The handler is added repeatedly and never removed.',
                path: 'src/renderer/ui/App.tsx',
                line: 42
              }
            ]
          }
        }),
        runId: 'review-run'
      }
    );

    const review = completed.tasks[0].projection.agentReview;
    expect(completed.tasks[0].projection.agentRun).toBe('COMPLETED');
    expect(review?.status).toBe('NEEDS_CHANGES');
    expect(review?.summary).toBe('Found a blocker despite provider verdict.');
    expect(review?.result?.findings[0]?.severity).toBe('BLOCKER');
  });

  it('marks review results stale when the diff changes or follow-up work starts', () => {
    const task: Task = {
      id: 'task-1',
      runtimeId: 'codex',
      title: 'Task',
      prompt: 'Prompt',
      repositoryPath: '/tmp/repo',
      workflowPhase: 'REVIEW',
      resolution: 'NONE',
      completionPolicy: 'LOCAL_ACCEPTANCE',
      phaseVersion: 2,
      forkedAlternativeTaskIds: [],
      currentIterationId: 'iteration-1',
      currentRunId: 'review-run',
      agentSettings: {},
      createdAt: now,
      updatedAt: now,
      projection: {
        ...createInitialProjection(now),
        agentReview: {
          status: 'INCONCLUSIVE',
          runId: 'review-run',
          reviewedHeadSha: 'abc',
          reviewedDirtyFingerprint: 'fp-1'
        }
      }
    };
    const withNewDiff = applyEventToState(
      { ...createEmptyState(), tasks: [task], runs: [createRun({ id: 'review-run', mode: 'REVIEW' })] },
      {
        ...createEvent('GIT_SNAPSHOT_CAPTURED', {
          id: 'git-2',
          headSha: 'abc',
          dirtyFingerprint: 'fp-2',
          status: 'DIRTY'
        }),
        runId: undefined
      }
    );
    expect(withNewDiff.tasks[0].projection.agentReview?.status).toBe('STALE');

    const followUpTask = {
      ...task,
      projection: {
        ...task.projection,
        agentReview: {
          ...task.projection.agentReview!,
          status: 'INCONCLUSIVE' as const
        }
      }
    };
    const followUpState = applyEventToState(
      {
        ...createEmptyState(),
        tasks: [{ ...followUpTask, currentRunId: 'follow-up' }],
        runs: [createRun({ id: 'follow-up', mode: 'FOLLOW_UP' })]
      },
      {
        ...createEvent('AGENT_RUN_STARTED', { mode: 'FOLLOW_UP' }),
        runId: 'follow-up'
      }
    );
    expect(followUpState.tasks[0].workflowPhase).toBe('IN_PROGRESS');
    expect(followUpState.tasks[0].projection.agentReview?.status).toBe('STALE');

    const completedFollowUpState = applyEventToState(
      followUpState,
      {
        ...createEvent('AGENT_RUN_COMPLETED', { terminalStatus: 'completed' }),
        runId: 'follow-up'
      }
    );
    expect(completedFollowUpState.tasks[0].workflowPhase).toBe('REVIEW');
    expect(completedFollowUpState.tasks[0].projection.agentReview?.status).toBe('STALE');
  });

  it('keeps a current review result fresh when a delivery commit records the reviewed diff', () => {
    const task: Task = {
      id: 'task-1',
      runtimeId: 'codex',
      title: 'Task',
      prompt: 'Prompt',
      repositoryPath: '/tmp/repo',
      workflowPhase: 'REVIEW',
      resolution: 'NONE',
      completionPolicy: 'LOCAL_ACCEPTANCE',
      phaseVersion: 2,
      forkedAlternativeTaskIds: [],
      currentIterationId: 'iteration-1',
      currentRunId: 'implementation-run',
      agentSettings: {},
      createdAt: now,
      updatedAt: now,
      projection: {
        ...createInitialProjection(now),
        agentRun: 'COMPLETED',
        git: 'DIRTY',
        agentReview: {
          status: 'PASSED',
          runId: 'review-run',
          reviewedHeadSha: 'abc',
          reviewedDirtyFingerprint: 'fp-1'
        }
      }
    };

    const committed = applyEventToState(
      {
        ...createEmptyState(),
        tasks: [task],
        runs: [
          createRun({ id: 'implementation-run', mode: 'IMPLEMENTATION', status: 'COMPLETED' }),
          createRun({ id: 'review-run', mode: 'REVIEW', status: 'COMPLETED' })
        ]
      },
      {
        ...createEvent('DELIVERY_COMMIT_CREATED', {
          headSha: 'commit-1',
          branchName: 'task/task-1'
        }),
        runId: undefined
      }
    );

    const refreshed = applyEventToState(committed, {
      ...createEvent('GIT_SNAPSHOT_CAPTURED', {
        id: 'git-committed',
        headSha: 'commit-1',
        dirtyFingerprint: 'clean-fp',
        status: 'COMMITTED_UNPUSHED'
      }),
      runId: undefined
    });

    expect(committed.tasks[0].projection.agentReview).toMatchObject({
      status: 'PASSED',
      reviewedHeadSha: 'commit-1'
    });
    expect(committed.tasks[0].projection.agentReview?.reviewedDirtyFingerprint).toBeUndefined();
    expect(refreshed.tasks[0].projection.agentReview?.status).toBe('PASSED');
  });

  it('does not resurrect a stale review when a delivery commit follows a changed diff', () => {
    const staleTask: Task = {
      id: 'task-1',
      runtimeId: 'codex',
      title: 'Task',
      prompt: 'Prompt',
      repositoryPath: '/tmp/repo',
      workflowPhase: 'REVIEW',
      resolution: 'NONE',
      completionPolicy: 'LOCAL_ACCEPTANCE',
      phaseVersion: 2,
      forkedAlternativeTaskIds: [],
      currentIterationId: 'iteration-1',
      currentRunId: 'implementation-run',
      agentSettings: {},
      createdAt: now,
      updatedAt: now,
      projection: {
        ...createInitialProjection(now),
        agentRun: 'COMPLETED',
        agentReview: {
          status: 'STALE',
          runId: 'review-run',
          reviewedHeadSha: 'abc',
          reviewedDirtyFingerprint: 'fp-1'
        }
      }
    };

    const committed = applyEventToState(
      { ...createEmptyState(), tasks: [staleTask] },
      {
        ...createEvent('DELIVERY_COMMIT_CREATED', {
          headSha: 'commit-1',
          branchName: 'task/task-1'
        }),
        runId: undefined
      }
    );

    expect(committed.tasks[0].projection.agentReview).toMatchObject({
      status: 'STALE',
      reviewedHeadSha: 'abc',
      reviewedDirtyFingerprint: 'fp-1'
    });
  });

  it('keeps provider plans, usage, and goals separate from workflow evidence', () => {
    const task: Task = {
      id: 'task-1',
      runtimeId: 'codex',
      title: 'Task',
      prompt: 'Prompt',
      repositoryPath: '/tmp/repo',
      workflowPhase: 'IN_PROGRESS',
      resolution: 'NONE',
      completionPolicy: 'LOCAL_ACCEPTANCE',
      phaseVersion: 2,
      forkedAlternativeTaskIds: [],
      currentIterationId: 'iteration-1',
      currentRunId: 'run-1',
      agentSettings: {},
      createdAt: now,
      updatedAt: now,
      projection: createInitialProjection(now)
    };
    const initial = {
      ...createEmptyState(),
      tasks: [task],
      runs: [createRun()]
    };
    const withPlan = applyEventToState(initial, {
      ...createEvent('AGENT_PLAN_REVISED', { revision: 1, stepCount: 1 }),
      iterationId: 'iteration-1'
    });
    const withUsage = applyEventToState(withPlan, {
      ...createEvent('AGENT_USAGE_UPDATED', { totalTokens: 100 }),
      iterationId: 'iteration-1'
    });
    const withDivergence = applyEventToState(withUsage, {
      ...createEvent('AGENT_GOAL_UPDATED', { syncState: 'DIVERGED' }),
      iterationId: 'iteration-1'
    });

    expect(withDivergence.tasks[0].workflowPhase).toBe('IN_PROGRESS');
    expect(withDivergence.tasks[0].projection.health).toBe('WARNING');
  });

  it('records merged snapshots without treating incomplete event data as completion evidence', () => {
    const mergeEvent = createEvent('MERGE_SNAPSHOT_CAPTURED', { status: 'MERGED' });
    const mergePolicyTask = applyEventToState(
      {
        ...createEmptyState(),
        tasks: [
          createTask({
            completionPolicy: 'MERGED',
            projection: {
              ...createInitialProjection(now),
              ciChecks: 'FAILING',
              health: 'ERROR'
            }
          })
        ]
      },
      mergeEvent
    );

    expect(mergePolicyTask.tasks[0]).toMatchObject({
      workflowPhase: 'IN_REVIEW',
      resolution: 'NONE',
      projection: {
        merge: 'MERGED',
        health: 'ERROR',
        summary: 'GitHub reports the pull request merged.'
      }
    });
  });
});

describe('run reducer', () => {
  it('updates run event counts and terminal agent state', () => {
    const run = createRun();
    const next = reduceRun(
      run,
      createEvent('AGENT_ACTIVITY_RECEIVED', {
        eventType: 'turn.completed',
        terminalStatus: 'completed',
        messageText: 'done'
      })
    );

    expect(next.eventCount).toBe(1);
    expect(next.status).toBe('COMPLETED');
    expect(next.finalMessage).toBe('done');
  });

  it('waits for authoritative progress after an interaction resolves', () => {
    const waiting = { ...createRun(), status: 'AWAITING_APPROVAL' as const };
    const resolved = reduceRun(
      waiting,
      createEvent('AGENT_INTERACTION_RESOLVED', { status: 'RESOLVED' })
    );
    const resumed = reduceRun(
      resolved,
      createEvent('AGENT_ACTIVITY_RECEIVED', { eventType: 'item/started' })
    );
    const unrelated = reduceRun(
      resolved,
      createEvent('AGENT_ACTIVITY_RECEIVED', { eventType: 'thread/name/updated' })
    );

    expect(resolved.status).toBe('AWAITING_APPROVAL');
    expect(resumed.status).toBe('RUNNING');
    expect(unrelated.status).toBe('AWAITING_APPROVAL');
  });
});

function createRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    taskId: 'task-1',
    iterationId: 'iteration-1',
    worktreeId: 'worktree-1',
    sessionId: 'session-1',
    mode: 'ANALYSIS',
    origin: 'TASK_MONKI',
    status: 'RUNNING',
    recoveryState: 'NONE',
    requestedSettings: {},
    promptArtifactId: 'prompt',
    outputArtifactId: 'output',
    diagnosticArtifactId: 'diagnostic',
    startedAt: now,
    eventCount: 0,
    ...overrides,
    runtimeId: overrides.runtimeId ?? 'codex'
  };
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Task',
    prompt: 'Prompt',
    repositoryPath: '/tmp/repo',
    workflowPhase: 'IN_REVIEW',
    resolution: 'NONE',
    completionPolicy: 'LOCAL_ACCEPTANCE',
    phaseVersion: 1,
    forkedAlternativeTaskIds: [],
    currentIterationId: 'iteration-1',
    agentSettings: {},
    createdAt: now,
    updatedAt: now,
    projection: createInitialProjection(now),
    ...overrides,
    runtimeId: overrides.runtimeId ?? 'codex'
  };
}

function createEvent(type: DomainEvent['type'], payload: unknown): DomainEvent {
  return {
    id: `event-${type}`,
    type,
    taskId: 'task-1',
    runId: 'run-1',
    source: 'process',
    sourceEventId: `source-${type}`,
    occurredAt: now,
    receivedAt: now,
    payload
  };
}
