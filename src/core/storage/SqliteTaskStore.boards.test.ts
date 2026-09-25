import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CreateBoardRequest } from '../../shared/contracts';
import { addTestRepository } from '../../testSupport/repositoryFixture';
import { SqliteTaskStore } from './SqliteTaskStore';
import { openTestPersistence } from '../../testSupport/persistenceFixture';
import type { ApplicationPersistence } from './sqlite/ApplicationPersistence';

const persistenceByTaskStore = new WeakMap<SqliteTaskStore, ApplicationPersistence>();

// Temporary Windows CI diagnostics; retain the real operations and their ordering.
async function traceBoardPhase<T>(phase: string, operation: () => Promise<T>): Promise<T> {
  const label = `${expect.getState().currentTestName}: ${phase}`;
  const startedAt = performance.now();
  console.log(`[boards phase] start ${label}`);
  try {
    return await operation();
  } finally {
    console.log(`[boards phase] end ${label}: ${(performance.now() - startedAt).toFixed(1)}ms`);
  }
}

async function createStore(profileRoot: string): Promise<SqliteTaskStore> {
  const persistence = await traceBoardPhase('profile open', () => openTestPersistence(profileRoot));
  const initialize = persistence.tasks['initialize'].bind(persistence.tasks);
  persistence.tasks['initialize'] = () => traceBoardPhase('lazy task init', initialize);
  const close = persistence.close.bind(persistence);
  persistence.close = () => traceBoardPhase('profile close', close);
  persistenceByTaskStore.set(persistence.tasks, persistence);
  return persistence.tasks;
}

function closeStore(store: SqliteTaskStore): Promise<void> {
  const persistence = persistenceByTaskStore.get(store);
  if (!persistence) throw new Error('Task store does not belong to this test fixture.');
  return persistence.close();
}

describe('SqliteTaskStore boards', () => {
  it('persists saved filters without storing task membership', async () => {
    const dir = await traceBoardPhase('temporary directory', () => fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-boards-')));
    const store = await createStore(dir);
    const repository = await traceBoardPhase('repository registration', () => addTestRepository(store, path.join(dir, 'repository')));
    const task = await traceBoardPhase('task creation', () => store.createTask({
      title: 'Authoritative task',
      prompt: 'Stay independent from boards.',
      repositoryId: repository.id
    }));

    const board = await traceBoardPhase('board creation', () => store.createBoard({
      name: ' Review work ',
      color: 'BLUE',
      repositoryIds: [repository.id],
      workflowPhases: ['REVIEW', 'IN_REVIEW']
    }));
    expect(board).toMatchObject({
      name: 'Review work',
      color: 'BLUE',
      repositoryIds: [repository.id],
      workflowPhases: ['REVIEW', 'IN_REVIEW']
    });
    expect(task).not.toHaveProperty('boardId');
    expect(task).not.toHaveProperty('boardIds');

    const updated = await traceBoardPhase('board update', () => store.updateBoard({
      boardId: board.id,
      name: 'Ready work',
      color: 'ROSE',
      repositoryIds: [],
      workflowPhases: ['READY']
    }));
    expect(updated).toMatchObject({ name: 'Ready work', color: 'ROSE', repositoryIds: [] });
    await closeStore(store);

    const reloaded = await createStore(dir);
    expect((await traceBoardPhase('reloaded snapshot', () => reloaded.snapshot())).boards).toEqual([updated]);
    await traceBoardPhase('board deletion', () => reloaded.deleteBoard(board.id));
    const snapshot = await traceBoardPhase('deleted snapshot', () => reloaded.snapshot());
    expect(snapshot.boards).toEqual([]);
    expect(snapshot.tasks.map((candidate) => candidate.id)).toContain(task.id);
    await closeStore(reloaded);
  });

  it('rejects filters that reference an unknown repository', async () => {
    const dir = await traceBoardPhase('temporary directory', () => fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-board-invalid-')));
    const store = await createStore(dir);
    await expect(
      traceBoardPhase('unknown repository validation', () => store.createBoard({
        name: 'Unknown repository',
        color: 'NEUTRAL',
        repositoryIds: ['missing'],
        workflowPhases: []
      }))
    ).rejects.toThrow('unknown repository');
  });

  it('rejects saved-view colors outside the fixed palette', async () => {
    const dir = await traceBoardPhase('temporary directory', () => fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-board-color-')));
    const store = await createStore(dir);
    const invalidInput = {
      name: 'Invalid color',
      color: 'ORANGE',
      repositoryIds: [],
      workflowPhases: []
    } as unknown as CreateBoardRequest;

    await expect(traceBoardPhase('invalid color validation', () => store.createBoard(invalidInput))).rejects.toThrow('Board filter is invalid.');
  });
});
