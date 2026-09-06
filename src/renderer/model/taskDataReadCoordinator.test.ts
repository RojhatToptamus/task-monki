import { describe, expect, it, vi } from 'vitest';
import type {
  BoardSnapshot,
  TaskDetailSnapshot
} from '../../shared/contracts';
import { createTaskDataReadCoordinator } from './taskDataReadCoordinator';

describe('createTaskDataReadCoordinator', () => {
  it('reports failed navigation as unsuccessful and accepts an explicit open retry', async () => {
    const applyTaskDetail = vi.fn();
    const reportTaskDetailError = vi.fn();
    const coordinator = createTaskDataReadCoordinator({
      readBoard: vi.fn(),
      readTaskDetail: vi.fn().mockRejectedValueOnce(new Error('Temporarily unavailable'))
        .mockResolvedValue(detail('task-a')),
      applyBoard: vi.fn(), applyTaskDetail,
      reportBoardError: vi.fn(), reportTaskDetailError
    });
    expect(await coordinator.openTask('task-a')).toBe('failed');
    expect(reportTaskDetailError).toHaveBeenCalledWith('task-a', expect.any(Error));
    expect(applyTaskDetail).not.toHaveBeenCalled();
    expect(await coordinator.openTask('task-a')).toBe('opened');
    expect(applyTaskDetail).toHaveBeenCalledWith(detail('task-a'));
  });

  it('does not let an older board read replace a newer result', async () => {
    const first = deferred<BoardSnapshot>();
    const second = deferred<BoardSnapshot>();
    const applyBoard = vi.fn();
    const coordinator = createTaskDataReadCoordinator({
      readBoard: vi.fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
      readTaskDetail: vi.fn(),
      applyBoard,
      applyTaskDetail: vi.fn(),
      reportBoardError: vi.fn(),
      reportTaskDetailError: vi.fn()
    });

    const firstRead = coordinator.refreshBoard();
    const secondRead = coordinator.refreshBoard();
    second.resolve(board('new'));
    await secondRead;
    first.resolve(board('old'));
    await firstRead;

    expect(applyBoard).toHaveBeenCalledTimes(1);
    expect(applyBoard).toHaveBeenCalledWith(board('new'));
  });

  it('keeps rapid task switches on the newest selected task', async () => {
    const taskA = deferred<TaskDetailSnapshot>();
    const taskB = deferred<TaskDetailSnapshot>();
    const applyTaskDetail = vi.fn();
    const coordinator = createTaskDataReadCoordinator({
      readBoard: vi.fn(),
      readTaskDetail: vi.fn((taskId: string) =>
        taskId === 'task-a' ? taskA.promise : taskB.promise
      ),
      applyBoard: vi.fn(),
      applyTaskDetail,
      reportBoardError: vi.fn(),
      reportTaskDetailError: vi.fn()
    });

    const firstRead = coordinator.openTask('task-a');
    const secondRead = coordinator.openTask('task-b');
    taskB.resolve(detail('task-b'));
    expect(await secondRead).toBe('opened');
    taskA.resolve(detail('task-a'));
    expect(await firstRead).toBe('superseded');

    expect(applyTaskDetail).toHaveBeenCalledTimes(1);
    expect(applyTaskDetail).toHaveBeenCalledWith(detail('task-b'));
  });

  it.each(['opened', 'failed'] as const)('follows a superseding same-task refresh when navigation is %s', async (result) => {
    const opening = deferred<TaskDetailSnapshot>();
    const refreshing = deferred<TaskDetailSnapshot>();
    const applyTaskDetail = vi.fn();
    const reportTaskDetailError = vi.fn();
    const coordinator = createTaskDataReadCoordinator({
      readBoard: vi.fn(), readTaskDetail: vi.fn()
        .mockReturnValueOnce(opening.promise).mockReturnValueOnce(refreshing.promise),
      applyBoard: vi.fn(), applyTaskDetail, reportBoardError: vi.fn(), reportTaskDetailError
    });
    const navigation = coordinator.openTask('task-a');
    const refresh = coordinator.refreshSelectedTask();
    opening.resolve(detail('task-a'));
    if (result === 'opened') refreshing.resolve(detail('task-a'));
    else refreshing.reject(new Error('Refresh unavailable'));
    await refresh;
    expect(await navigation).toBe(result);
    expect(applyTaskDetail).toHaveBeenCalledTimes(result === 'opened' ? 1 : 0);
    expect(reportTaskDetailError).toHaveBeenCalledTimes(result === 'failed' ? 1 : 0);
  });

  it('does not let an older activity detail read replace a terminal result', async () => {
    const activity = deferred<TaskDetailSnapshot>();
    const terminal = deferred<TaskDetailSnapshot>();
    const applyTaskDetail = vi.fn();
    const coordinator = createTaskDataReadCoordinator({
      readBoard: vi.fn(),
      readTaskDetail: vi.fn()
        .mockReturnValueOnce(activity.promise)
        .mockReturnValueOnce(terminal.promise),
      applyBoard: vi.fn(),
      applyTaskDetail,
      reportBoardError: vi.fn(),
      reportTaskDetailError: vi.fn()
    });

    const activityRead = coordinator.openTask('task-a');
    const terminalRead = coordinator.refreshSelectedTask();
    terminal.resolve(detail('task-a', { runState: 'COMPLETED' }));
    await terminalRead;
    activity.resolve(detail('task-a', { runState: 'RUNNING' }));
    await activityRead;

    expect(applyTaskDetail).toHaveBeenCalledTimes(1);
    expect(applyTaskDetail).toHaveBeenCalledWith(
      detail('task-a', { runState: 'COMPLETED' })
    );
  });

  it('reads current scoped detail when a previously hidden task opens', async () => {
    const latestDetail = detail('task-a', {
      runs: [{ id: 'run-latest', status: 'RUNNING' }],
      agentItems: [{ id: 'item-latest' }],
      agentPlanRevisions: [{ id: 'plan-latest' }],
      agentUsageSnapshots: [{ id: 'usage-latest' }],
      interactionRequests: [{ id: 'interaction-latest' }]
    });
    const readTaskDetail = vi.fn(async () => latestDetail);
    const applyTaskDetail = vi.fn();
    const coordinator = createTaskDataReadCoordinator({
      readBoard: vi.fn(),
      readTaskDetail,
      applyBoard: vi.fn(),
      applyTaskDetail,
      reportBoardError: vi.fn(),
      reportTaskDetailError: vi.fn()
    });

    await coordinator.refreshSelectedTask();
    expect(readTaskDetail).not.toHaveBeenCalled();

    await coordinator.openTask('task-a');
    expect(readTaskDetail).toHaveBeenCalledWith('task-a');
    expect(applyTaskDetail).toHaveBeenCalledWith(latestDetail);
  });

  it('ignores a selected-task read after detail closes', async () => {
    const pending = deferred<TaskDetailSnapshot>();
    const applyTaskDetail = vi.fn();
    const coordinator = createTaskDataReadCoordinator({
      readBoard: vi.fn(),
      readTaskDetail: vi.fn(() => pending.promise),
      applyBoard: vi.fn(),
      applyTaskDetail,
      reportBoardError: vi.fn(),
      reportTaskDetailError: vi.fn()
    });

    const read = coordinator.openTask('task-a');
    coordinator.closeTask();
    pending.resolve(detail('task-a'));
    await read;

    expect(applyTaskDetail).not.toHaveBeenCalled();
  });
});

function board(title: string): BoardSnapshot {
  return {
    schemaVersion: 24,
    repositories: [],
    boards: [],
    tasks: [{
      id: title,
      title,
      repositoryId: 'repository',
      workflowPhase: 'READY',
      completionPolicy: 'LOCAL_ACCEPTANCE',
      updatedAt: '2026-07-26T00:00:00.000Z',
      projection: {
        agentRun: 'IDLE',
        worktree: 'NOT_CREATED',
        git: 'UNKNOWN',
        githubPullRequest: 'NOT_CREATED',
        ciChecks: 'NOT_APPLICABLE',
        reviews: 'NOT_APPLICABLE',
        merge: 'NOT_APPLICABLE',
        health: 'INFO',
        summary: title,
        updatedAt: '2026-07-26T00:00:00.000Z',
        agentReview: {
          status: 'NOT_RUN',
          hasResult: false,
          findingCounts: {}
        }
      }
    }],
    interactionRequests: []
  };
}

function detail(
  taskId: string,
  extra: Record<string, unknown> = {}
): TaskDetailSnapshot {
  return {
    task: { id: taskId },
    ...extra
  } as unknown as TaskDetailSnapshot;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolver, rejecter) => {
    resolve = resolver;
    reject = rejecter;
  });
  return { promise, resolve, reject };
}
