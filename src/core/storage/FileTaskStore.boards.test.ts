import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CreateBoardRequest } from '../../shared/contracts';
import { addTestRepository } from '../../testSupport/repositoryFixture';
import { FileTaskStore } from './FileTaskStore';

describe('FileTaskStore boards', () => {
  it('persists saved filters without storing task membership', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-boards-'));
    const store = new FileTaskStore(dir);
    const repository = await addTestRepository(store, path.join(dir, 'repository'));
    const task = await store.createTask({
      title: 'Authoritative task',
      prompt: 'Stay independent from boards.',
      repositoryId: repository.id
    });

    const board = await store.createBoard({
      name: ' Review work ',
      color: 'BLUE',
      repositoryIds: [repository.id],
      workflowPhases: ['REVIEW', 'IN_REVIEW']
    });
    expect(board).toMatchObject({
      name: 'Review work',
      color: 'BLUE',
      repositoryIds: [repository.id],
      workflowPhases: ['REVIEW', 'IN_REVIEW']
    });
    expect(task).not.toHaveProperty('boardId');
    expect(task).not.toHaveProperty('boardIds');

    const updated = await store.updateBoard({
      boardId: board.id,
      name: 'Ready work',
      color: 'ROSE',
      repositoryIds: [],
      workflowPhases: ['READY']
    });
    expect(updated).toMatchObject({ name: 'Ready work', color: 'ROSE', repositoryIds: [] });
    await store.close();

    const reloaded = new FileTaskStore(dir);
    expect((await reloaded.snapshot()).boards).toEqual([updated]);
    await reloaded.deleteBoard(board.id);
    const snapshot = await reloaded.snapshot();
    expect(snapshot.boards).toEqual([]);
    expect(snapshot.tasks.map((candidate) => candidate.id)).toContain(task.id);
    await reloaded.close();
  });

  it('rejects filters that reference an unknown repository', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-board-invalid-'));
    const store = new FileTaskStore(dir);
    await expect(
      store.createBoard({
        name: 'Unknown repository',
        color: 'NEUTRAL',
        repositoryIds: ['missing'],
        workflowPhases: []
      })
    ).rejects.toThrow('unknown repository');
  });

  it('rejects saved-view colors outside the fixed palette', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-board-color-'));
    const store = new FileTaskStore(dir);
    const invalidInput = {
      name: 'Invalid color',
      color: 'ORANGE',
      repositoryIds: [],
      workflowPhases: []
    } as unknown as CreateBoardRequest;

    await expect(store.createBoard(invalidInput)).rejects.toThrow('Board filter is invalid.');
  });
});
