import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RepositoryInspectionError,
  type InspectedRepository,
  type RepositoryPathInspector
} from '../repository/RepositoryRegistry';
import { FileRepositoryRegistry } from './FileRepositoryRegistry';
import { RepositoryRegistryPublishedError } from './FileRepositoryRegistry';

describe('FileRepositoryRegistry', () => {
  it('creates a private versioned store and keeps canonical ids stable across restart', async () => {
    const root = await temporaryRoot();
    const repo = nativePath('repos', 'task-monki');
    const inspector = new FakeInspector().available(repo, inspected(repo, 'anchor-a'));
    const first = registry(root, inspector, ['repository-1']);

    const reconciled = await first.reconcile([
      { path: repo, source: 'DEFAULT', isDefault: true },
      { path: `${repo}${path.sep}`, source: 'LEGACY_SETTINGS' }
    ]);

    expect(reconciled).toMatchObject({
      schemaVersion: 1,
      revision: 1,
      defaultRepositoryId: 'repository-1'
    });
    expect(reconciled.repositories).toHaveLength(1);
    const second = registry(root, inspector, ['must-not-be-used']);
    await expect(second.snapshot()).resolves.toEqual(reconciled);
    await expect(
      second.reconcile([{ path: repo, source: 'DEFAULT', isDefault: true }])
    ).resolves.toEqual(reconciled);

    if (process.platform !== 'win32') {
      expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(path.join(root, 'store.json'))).mode & 0o777).toBe(0o600);
    }
  });

  it('deduplicates discovery aliases by inspected canonical real path', async () => {
    const root = await temporaryRoot();
    const canonical = nativePath('repos', 'canonical');
    const alias = nativePath('links', 'canonical');
    const inspector = new FakeInspector()
      .available(canonical, inspected(canonical, 'anchor-a'))
      .available(alias, inspected(canonical, 'anchor-a'));
    const store = registry(root, inspector, ['repository-1', 'repository-2']);

    const snapshot = await store.reconcile([
      { path: canonical, source: 'DEFAULT', isDefault: true },
      { path: alias, source: 'TASK' }
    ]);

    expect(snapshot.repositories).toHaveLength(1);
    expect(snapshot.repositories[0]?.pathAliases).toEqual(
      expect.arrayContaining([canonical, alias])
    );
  });

  it('retains a missing repository id and restores the same record when it returns', async () => {
    const root = await temporaryRoot();
    const repo = nativePath('repos', 'temporarily-missing');
    const inspector = new FakeInspector().unavailable(repo, 'MISSING');
    const store = registry(root, inspector, ['repository-1', 'repository-2']);

    const missing = await store.reconcile([{ path: repo, source: 'LEGACY_SETTINGS' }]);
    expect(missing.repositories[0]).toMatchObject({
      id: 'repository-1',
      availability: 'UNAVAILABLE',
      unavailableReason: 'MISSING'
    });

    inspector.available(repo, inspected(repo, 'anchor-a'));
    const restored = await store.reconcile([{ path: repo, source: 'LEGACY_SETTINGS' }]);
    expect(restored.repositories).toHaveLength(1);
    expect(restored.repositories[0]).toMatchObject({
      id: 'repository-1',
      availability: 'AVAILABLE',
      canonicalRealPath: repo
    });
  });

  it('marks path replacement as an identity change instead of silently reusing authority', async () => {
    const root = await temporaryRoot();
    const selectedPath = nativePath('repos', 'project');
    const originalRoot = nativePath('volumes', 'original-project');
    const replacementRoot = nativePath('volumes', 'replacement-project');
    const inspector = new FakeInspector().available(
      selectedPath,
      inspected(originalRoot, 'anchor-original')
    );
    const store = registry(root, inspector, ['repository-1']);
    await store.reconcile([{ path: selectedPath, source: 'TASK' }]);

    inspector.available(selectedPath, inspected(replacementRoot, 'anchor-replacement'));
    const snapshot = await store.reconcile([{ path: selectedPath, source: 'TASK' }]);

    expect(snapshot.repositories).toHaveLength(1);
    expect(snapshot.repositories[0]).toMatchObject({
      id: 'repository-1',
      availability: 'UNAVAILABLE',
      unavailableReason: 'IDENTITY_CHANGED',
      canonicalRealPath: originalRoot
    });
  });

  it('rejects forged ids before any filesystem inspection', async () => {
    const root = await temporaryRoot();
    const inspector = new FakeInspector();
    const store = registry(root, inspector, []);

    await expect(store.resolve('forged')).rejects.toThrow('Unknown repository id');
    await expect(store.relinkTrustedPath('forged', nativePath('repos', 'x'))).rejects.toThrow(
      'Unknown repository id'
    );
    expect(inspector.calls).toEqual([]);
  });

  it('reinspects identity on authoritative resolution and fails closed on replacement', async () => {
    const root = await temporaryRoot();
    const repo = nativePath('repos', 'replaceable');
    const inspector = new FakeInspector().available(repo, inspected(repo, 'anchor-original'));
    const store = registry(root, inspector, ['repository-1']);
    await store.reconcile([{ path: repo, source: 'USER' }]);

    inspector.available(repo, inspected(repo, 'anchor-replacement'));
    await expect(store.resolve('repository-1')).rejects.toThrow('changed identity');
    expect((await store.snapshot()).repositories[0]).toMatchObject({
      availability: 'UNAVAILABLE',
      unavailableReason: 'IDENTITY_CHANGED'
    });
  });

  it('relinks only with matching identity evidence and retains historical task aliases', async () => {
    const root = await temporaryRoot();
    const oldPath = nativePath('repos', 'old-project');
    const newPath = nativePath('repos', 'moved-project');
    const wrongPath = nativePath('repos', 'different-project');
    const inspector = new FakeInspector()
      .available(oldPath, inspected(oldPath, 'anchor-shared'))
      .available(newPath, inspected(newPath, 'anchor-shared'))
      .available(wrongPath, inspected(wrongPath, 'anchor-other'));
    const store = registry(root, inspector, ['repository-1']);
    await store.reconcile([{ path: oldPath, source: 'USER' }]);

    await expect(store.relinkTrustedPath('repository-1', wrongPath)).rejects.toThrow(
      'does not match'
    );
    const relinked = await store.relinkTrustedPath('repository-1', newPath);
    expect(relinked).toMatchObject({
      id: 'repository-1',
      canonicalRealPath: newPath,
      lastKnownPath: newPath
    });
    expect(relinked.pathAliases).toEqual(expect.arrayContaining([oldPath, newPath]));
    await expect(store.resolveRecordedPath(oldPath)).resolves.toMatchObject({
      repositoryId: 'repository-1',
      canonicalRealPath: newPath
    });
  });

  it('does not accept a matching remote without shared commit identity', async () => {
    const root = await temporaryRoot();
    const oldPath = nativePath('repos', 'remote-original');
    const newPath = nativePath('repos', 'remote-unrelated');
    const original = inspected(oldPath, 'anchor-original');
    const unrelated = inspected(newPath, 'anchor-unrelated');
    original.identity.remoteFingerprints = ['same-remote'];
    unrelated.identity.remoteFingerprints = ['same-remote'];
    const inspector = new FakeInspector()
      .available(oldPath, original)
      .available(newPath, unrelated);
    const store = registry(root, inspector, ['repository-1']);
    await store.reconcile([{ path: oldPath, source: 'USER' }]);

    await expect(store.relinkTrustedPath('repository-1', newPath)).rejects.toThrow(
      'does not match'
    );
  });

  it('rejects new aliases instead of silently evicting historical task paths', async () => {
    const root = await temporaryRoot();
    const canonical = nativePath('repos', 'alias-root');
    const inspector = new FakeInspector();
    for (let index = 0; index < 17; index += 1) {
      inspector.available(
        nativePath('aliases', `alias-${index}`),
        inspected(canonical, 'anchor-shared')
      );
    }
    const store = registry(root, inspector, ['repository-1']);
    for (let index = 0; index < 15; index += 1) {
      await store.reconcile([
        { path: nativePath('aliases', `alias-${index}`), source: 'TASK' }
      ]);
    }
    const before = await store.snapshot();
    expect(before.repositories[0]?.pathAliases).toHaveLength(16);
    await expect(
      store.reconcile([{ path: nativePath('aliases', 'alias-16'), source: 'TASK' }])
    ).rejects.toThrow('aliases exceed their safety limit');
    expect((await store.snapshot()).repositories[0]?.pathAliases).toEqual(
      before.repositories[0]?.pathAliases
    );
  });

  it('serializes concurrent first initialization and mutation without losing the record', async () => {
    const root = await temporaryRoot();
    const repo = nativePath('repos', 'concurrent-init');
    const inspector = new FakeInspector().available(repo, inspected(repo, 'anchor-a'));
    const store = registry(root, inspector, ['repository-1']);

    const [, reconciled] = await Promise.all([
      store.snapshot(),
      store.reconcile([{ path: repo, source: 'USER' }])
    ]);

    expect(reconciled.repositories.map((record) => record.id)).toEqual(['repository-1']);
    expect((await store.snapshot()).repositories).toHaveLength(1);
  });

  it('keeps published memory after a post-rename directory-sync failure', async () => {
    const root = await temporaryRoot();
    const first = nativePath('repos', 'published-first');
    const second = nativePath('repos', 'published-second');
    const inspector = new FakeInspector()
      .available(first, inspected(first, 'anchor-a'))
      .available(second, inspected(second, 'anchor-b'));
    let syncCalls = 0;
    const ids = ['repository-1', 'repository-2'];
    const store = new FileRepositoryRegistry(root, inspector, {
      now: () => '2026-07-13T10:00:00.000Z',
      createId: () => ids.shift()!,
      syncDirectory: async () => {
        syncCalls += 1;
        if (syncCalls === 2) throw new Error('injected directory sync failure');
      }
    });
    await store.snapshot();

    await expect(store.reconcile([{ path: first, source: 'USER' }])).rejects.toBeInstanceOf(
      RepositoryRegistryPublishedError
    );
    expect((await store.snapshot()).repositories.map((record) => record.id)).toEqual([
      'repository-1'
    ]);
    await store.reconcile([{ path: second, source: 'USER' }]);
    expect((await store.snapshot()).repositories.map((record) => record.id)).toEqual([
      'repository-1',
      'repository-2'
    ]);
  });

  it('derives task associations and selection from ids while preserving duplicate labels', async () => {
    const root = await temporaryRoot();
    const first = nativePath('company-a', 'project');
    const second = nativePath('company-b', 'project');
    const inspector = new FakeInspector()
      .available(first, inspected(first, 'anchor-a'))
      .available(second, inspected(second, 'anchor-b'));
    const store = registry(root, inspector, ['repository-1', 'repository-2']);
    await store.reconcile([
      { path: first, source: 'DEFAULT', isDefault: true },
      { path: second, source: 'TASK' }
    ]);

    const catalog = await store.catalog({
      selectedRepositoryId: 'repository-2',
      tasks: [
        { id: 'task-a', repositoryPath: first },
        { id: 'task-b', repositoryPath: second }
      ]
    });

    expect(catalog.selectedRepositoryId).toBe('repository-2');
    expect(catalog.repositories.map((entry) => entry.displayName)).toEqual([
      'project',
      'project'
    ]);
    expect(catalog.taskAssociations).toEqual([
      { taskId: 'task-a', repositoryId: 'repository-1' },
      { taskId: 'task-b', repositoryId: 'repository-2' }
    ]);
  });

  it('protects default and task-referenced repositories from removal', async () => {
    const root = await temporaryRoot();
    const first = nativePath('repos', 'first');
    const second = nativePath('repos', 'second');
    const inspector = new FakeInspector()
      .available(first, inspected(first, 'anchor-a'))
      .available(second, inspected(second, 'anchor-b'));
    const store = registry(root, inspector, ['repository-1', 'repository-2']);
    await store.reconcile([
      { path: first, source: 'DEFAULT', isDefault: true },
      { path: second, source: 'USER' }
    ]);

    await expect(store.remove('repository-1')).rejects.toThrow('default repository');
    await expect(store.remove('repository-2', { inUse: true })).rejects.toThrow('referenced');
    await store.remove('repository-2');
    expect((await store.snapshot()).repositories[1]?.removedAt).toBeTruthy();
  });

  it('preserves and refuses corrupt or newer registry files', async () => {
    const newerRoot = await temporaryRoot();
    const newerPath = path.join(newerRoot, 'store.json');
    const newer = '{"schemaVersion":2,"revision":0,"defaultRepositoryId":null,"repositories":[]}';
    await fs.mkdir(newerRoot, { recursive: true, mode: 0o700 });
    await fs.writeFile(newerPath, newer, { mode: 0o600 });
    await expect(registry(newerRoot, new FakeInspector(), []).snapshot()).rejects.toThrow(
      'newer than this app supports'
    );
    await expect(fs.readFile(newerPath, 'utf8')).resolves.toBe(newer);

    const corruptRoot = await temporaryRoot();
    const corruptPath = path.join(corruptRoot, 'store.json');
    await fs.mkdir(corruptRoot, { recursive: true, mode: 0o700 });
    await fs.writeFile(corruptPath, '{broken', { mode: 0o600 });
    await expect(registry(corruptRoot, new FakeInspector(), []).snapshot()).rejects.toThrow(
      'original file was preserved'
    );
    await expect(fs.readFile(corruptPath, 'utf8')).resolves.toBe('{broken');
  });

  it.runIf(process.platform !== 'win32')('rejects a symlinked registry root', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-registry-link-'));
    const actual = path.join(parent, 'actual');
    const linked = path.join(parent, 'linked');
    await fs.mkdir(actual);
    await fs.symlink(actual, linked);

    await expect(registry(linked, new FakeInspector(), []).snapshot()).rejects.toThrow(
      'not a symlink'
    );
  });
});

class FakeInspector implements RepositoryPathInspector {
  readonly calls: string[] = [];
  private readonly results = new Map<string, InspectedRepository | RepositoryInspectionError>();

  available(candidatePath: string, result: InspectedRepository): this {
    this.results.set(path.resolve(candidatePath), result);
    return this;
  }

  unavailable(
    candidatePath: string,
    reason: 'MISSING' | 'INACCESSIBLE' | 'NOT_A_REPOSITORY'
  ): this {
    this.results.set(
      path.resolve(candidatePath),
      new RepositoryInspectionError(reason, `Repository is ${reason.toLowerCase()}.`)
    );
    return this;
  }

  inspect(candidatePath: string): Promise<InspectedRepository> {
    const normalized = path.resolve(candidatePath);
    this.calls.push(normalized);
    const result = this.results.get(normalized);
    if (result instanceof RepositoryInspectionError) return Promise.reject(result);
    if (!result) {
      return Promise.reject(new RepositoryInspectionError('MISSING', 'Repository is missing.'));
    }
    return Promise.resolve(structuredClone(result));
  }
}

function registry(root: string, inspector: RepositoryPathInspector, ids: string[]) {
  let timestamp = 0;
  return new FileRepositoryRegistry(root, inspector, {
    now: () => `2026-07-13T10:00:${String(timestamp++).padStart(2, '0')}.000Z`,
    createId: () => {
      const id = ids.shift();
      if (!id) throw new Error('Unexpected repository id allocation.');
      return id;
    }
  });
}

function inspected(canonicalRealPath: string, anchor: string): InspectedRepository {
  return {
    canonicalRealPath,
    displayName: path.basename(canonicalRealPath),
    identity: {
      objectFormat: 'sha1',
      anchorCommits: [anchor],
      remoteFingerprints: [`remote-${anchor}`],
      fileSystem: { device: '1', inode: anchor }
    }
  };
}

async function temporaryRoot(): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-registry-'));
  return path.join(parent, 'registry');
}

function nativePath(...segments: string[]): string {
  return path.join(path.parse(process.cwd()).root, 'private', ...segments);
}
