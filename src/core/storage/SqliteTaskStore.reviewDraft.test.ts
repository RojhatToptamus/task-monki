import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskReviewDraft } from '../../shared/contracts';
import { addTestRepository } from '../../testSupport/repositoryFixture';
import { openTestPersistence } from '../../testSupport/persistenceFixture';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function openStore() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-review-draft-'));
  directories.push(directory);
  return { directory, persistence: await openTestPersistence(directory) };
}

const draft: TaskReviewDraft = {
  comments: [
    { id: 'c1', path: 'index.html', side: 'NEW', line: 27, text: 'Keep "Saved to your workspace".' },
    { id: 'c2', path: 'src/main.js', side: 'NEW', line: 132, endLine: 133, text: 'Set both from config.' },
    { id: 'c3', path: 'server.js', side: 'OLD', line: 28, text: 'Why was this removed?' },
    { id: 'c4', path: 'README.md', side: 'NEW', text: 'Mention the new route.' }
  ],
  reviewRunId: 'review-1',
  includedDiscussionIds: [],
  includedFindingIds: ['year'],
  note: 'Keep the footer change minimal.'
};

describe('SqliteTaskStore review drafts', () => {
  it('keeps the unsent review across a restart, refuses a malformed one, and clears an empty one', async () => {
    const { directory, persistence } = await openStore();
    const store = persistence.tasks;
    const task = await store.createTask({
      title: 'Add a footer', prompt: 'Add a footer.', repositoryId: (await addTestRepository(store, directory)).id
    });

    await store.saveTaskReviewDraft(task.id, draft);
    await persistence.close();
    const reopened = await openTestPersistence(directory);
    expect((await reopened.tasks.getTaskDetail(task.id)).task.reviewDraft).toEqual(draft);

    await expect(reopened.tasks.saveTaskReviewDraft(task.id, {
      ...draft, comments: [{ id: 'c5', path: 'a.ts', side: 'NEW', line: 9, endLine: 3, text: 'Backwards.' }]
    })).rejects.toThrow('A review comment range is malformed.');
    await expect(reopened.tasks.saveTaskReviewDraft(task.id, { ...draft, note: 'x'.repeat(8_001) }))
      .rejects.toThrow('Keep the review note to at most 8000 characters.');
    await expect(reopened.tasks.saveTaskReviewDraft('missing', draft)).rejects.toThrow('Task not found.');

    await reopened.tasks.saveTaskReviewDraft(task.id, { comments: [], includedFindingIds: [], includedDiscussionIds: [], note: '  ' });
    expect((await reopened.tasks.getTaskDetail(task.id)).task.reviewDraft).toBeUndefined();
    await reopened.close();
  });
});
