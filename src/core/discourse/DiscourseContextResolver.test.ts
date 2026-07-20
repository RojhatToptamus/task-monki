import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ContextSnapshotRecord } from '../../shared/discourse';
import { FileTaskStore } from '../storage/FileTaskStore';
import { git } from '../git/gitCli';
import { DiscourseContextResolver } from './DiscourseContextResolver';
import { DiscourseContextSnapshotService } from './DiscourseContextSnapshotService';

describe('DiscourseContextResolver', () => {
  it('resolves ids core-side and deduplicates task plus repository filesystem access', async () => {
    const fixture = await contextFixture();
    const task = await fixture.tasks.createTask({
      title: 'Context resolver',
      prompt: 'Keep paths out of renderer authority.',
      repositoryId: fixture.repository.id
    });
    const catalog = await fixture.resolver.catalogEntries();
    expect(catalog.tasks).toEqual([
      expect.objectContaining({ id: task.id, repositoryId: fixture.repository.id })
    ]);
    expect(catalog.repositories).toEqual([
      expect.objectContaining({ id: fixture.repository.id, accessMode: 'FILESYSTEM_READ' })
    ]);

    const preview = await fixture.resolver.preview({
      pinned: [],
      messageContext: [
        { entityKind: 'TASK', entityId: task.id },
        { entityKind: 'REPOSITORY', entityId: fixture.repository.id },
        { entityKind: 'REPOSITORY', entityId: fixture.repository.id }
      ]
    });
    expect(preview.references).toHaveLength(2);
    expect(preview.filesystemRootCount).toBe(1);
    expect(preview.deduplicatedRepositoryIds).toEqual([fixture.repository.id]);
    expect(preview.policy).toEqual({
      filesystem: 'READ_ONLY',
      writes: false,
      network: false,
      externalTools: false,
      approvals: 'NEVER'
    });
  });

  it('rejects forged ids without accepting renderer labels or paths as authority', async () => {
    const fixture = await contextFixture();
    await expect(
      fixture.resolver.resolveSelections([{ entityKind: 'TASK', entityId: 'forged-task' }])
    ).rejects.toThrow('Unknown discourse task context id');
    await expect(
      fixture.resolver.resolveSelections([
        { entityKind: 'REPOSITORY', entityId: fixture.repositoryPath }
      ])
    ).rejects.toThrow('Unknown discourse repository context id');
  });

  it('changes task and repository generations when their live working tree changes', async () => {
    const fixture = await contextFixture();
    const task = await fixture.tasks.createTask({
      title: 'Fresh context',
      prompt: 'Detect edits between Team phases.',
      repositoryId: fixture.repository.id
    });
    const selections = [
      { entityKind: 'TASK' as const, entityId: task.id },
      { entityKind: 'REPOSITORY' as const, entityId: fixture.repository.id }
    ];

    const before = await fixture.resolver.resolveSelections(selections);
    const snapshot: ContextSnapshotRecord = {
      id: 'snapshot-1',
      conversationId: 'conversation-1',
      waveId: 'wave-1',
      contextRevisionId: 'context-revision-1',
      recordRevision: 1,
      status: 'READY',
      sources: before.map((reference, index) => ({
        contextLinkId: `context-link-${index + 1}`,
        entityKind: reference.snapshot.entityKind,
        entityId: reference.snapshot.entityId,
        labelSnapshot: reference.snapshot.labelSnapshot,
        required: true,
        availability: reference.snapshot.availability,
        accessMode: 'FILESYSTEM_READ',
        ...(reference.repositoryId ? { repositoryId: reference.repositoryId } : {}),
        ...(reference.generation ? { generation: reference.generation } : {}),
        inspectedAt: '2026-07-15T10:00:00.000Z',
        exclusionReasons: []
      })),
      transcriptOrdinals: [1],
      attachmentIds: [],
      permissionProfileHash: 'a'.repeat(64),
      budget: {
        inputBytes: 0,
        estimatedInputTokens: 0,
        reservedOutputTokens: 1_024,
        sourceCount: before.length
      },
      exclusions: [],
      contextSchemaVersion: 1,
      promptPolicyVersion: 1,
      createdAt: '2026-07-15T10:00:00.000Z',
      resolvedAt: '2026-07-15T10:00:00.000Z'
    };
    const freshness = new DiscourseContextSnapshotService(
      fixture.resolver,
      {} as never,
      async () => {
        throw new Error('Freshness inspection must not build an execution context.');
      }
    );
    expect(await freshness.freshness(snapshot)).toBe('FRESH');

    await fs.writeFile(
      path.join(fixture.repositoryPath, 'tracked.txt'),
      'changed after the answer phase\n',
      'utf8'
    );
    const after = await fixture.resolver.resolveSelections(selections);

    expect(await freshness.freshness(snapshot)).toBe('CHANGED_DURING_JOB');
    expect(before.map((reference) => reference.generation?.value)).not.toEqual(
      after.map((reference) => reference.generation?.value)
    );
    expect(before.every((reference) =>
      reference.generation?.components.some((component) => component.startsWith('liveGitDirty:'))
    )).toBe(true);
    expect(after[0]?.generation?.value).not.toBe(before[0]?.generation?.value);
    expect(after[1]?.generation?.value).not.toBe(before[1]?.generation?.value);
  });
});

async function contextFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-context-resolver-'));
  const repositoryPath = path.join(root, 'repository');
  await fs.mkdir(repositoryPath);
  await git(repositoryPath, ['init', '--initial-branch=main']);
  await fs.writeFile(path.join(repositoryPath, 'tracked.txt'), 'initial\n', 'utf8');
  await git(repositoryPath, ['add', 'tracked.txt']);
  await git(repositoryPath, [
    '-c',
    'user.name=Task Monki Tests',
    '-c',
    'user.email=tests@task-monki.local',
    'commit',
    '-m',
    'Initial fixture'
  ]);
  const tasks = new FileTaskStore(path.join(root, 'tasks'));
  const repository = await tasks.addRepository({
    path: repositoryPath,
    root: repositoryPath,
    status: 'VALID',
    headSha: await git(repositoryPath, ['rev-parse', 'HEAD']),
    branch: 'main',
    remotes: [],
    checkedAt: new Date().toISOString()
  });
  return {
    repositoryPath,
    repository,
    tasks,
    resolver: new DiscourseContextResolver(tasks)
  };
}
