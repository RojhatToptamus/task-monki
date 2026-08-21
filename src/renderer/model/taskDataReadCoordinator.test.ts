import { describe, expect, it, vi } from 'vitest';
import type {
  BoardSnapshot,
  TaskDetailSnapshot
} from '../../shared/contracts';
import { createTaskDataReadCoordinator } from './taskDataReadCoordinator';

describe('createTaskDataReadCoordinator', () => {
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
    await secondRead;
    taskA.resolve(detail('task-a'));
    await firstRead;

    expect(applyTaskDetail).toHaveBeenCalledTimes(1);
    expect(applyTaskDetail).toHaveBeenCalledWith(detail('task-b'));
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
    schemaVersion: 20,
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
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}
