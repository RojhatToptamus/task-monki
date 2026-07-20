import { describe, expect, it } from 'vitest';
import { createInitialProjection, type Board, type Task } from '../../shared/contracts';
import { selectBoardTasks, shouldShowTaskRepository } from './boards';

describe('selectBoardTasks', () => {
  it('derives membership from repository and workflow filters without changing tasks', () => {
    const tasks = [
      taskFixture('one', 'repository-a', 'READY'),
      taskFixture('two', 'repository-a', 'REVIEW'),
      taskFixture('three', 'repository-b', 'REVIEW')
    ];
    const board = boardFixture({
      repositoryIds: ['repository-a'],
      workflowPhases: ['REVIEW']
    });

    expect(selectBoardTasks(tasks, board).map((task) => task.id)).toEqual(['two']);
    expect(tasks.map((task) => task.id)).toEqual(['one', 'two', 'three']);
  });

  it('treats empty filters and the built-in board as all tasks', () => {
    const tasks = [taskFixture('one', 'repository-a', 'READY')];
    expect(selectBoardTasks(tasks, boardFixture())).toEqual(tasks);
    expect(selectBoardTasks(tasks, undefined)).toEqual(tasks);
  });
});

describe('shouldShowTaskRepository', () => {
  it('shows repository identity in the global All tasks view', () => {
    expect(shouldShowTaskRepository(undefined)).toBe(true);
  });

  it('hides repository identity in a saved view restricted to one repository', () => {
    expect(
      shouldShowTaskRepository(boardFixture({ repositoryIds: ['repository-a'] }))
    ).toBe(false);
  });

  it('shows repository identity in multi-repository saved views', () => {
    expect(
      shouldShowTaskRepository(
        boardFixture({ repositoryIds: ['repository-a', 'repository-b'] })
      )
    ).toBe(true);
    expect(shouldShowTaskRepository(boardFixture({ repositoryIds: [] }))).toBe(true);
  });
});

function boardFixture(overrides: Partial<Board> = {}): Board {
  return {
    id: 'board-1',
    name: 'Review A',
    color: 'NEUTRAL',
    repositoryIds: [],
    workflowPhases: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

function taskFixture(
  id: string,
  repositoryId: string,
  workflowPhase: Task['workflowPhase']
): Task {
  return {
    id,
    title: id,
    prompt: 'Do it.',
    repositoryId,
    runtimeId: 'codex',
    workflowPhase,
    resolution: 'NONE',
    completionPolicy: 'LOCAL_ACCEPTANCE',
    phaseVersion: 1,
    forkedAlternativeTaskIds: [],
    agentSettings: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    projection: createInitialProjection('2026-01-01T00:00:00.000Z')
  };
}
