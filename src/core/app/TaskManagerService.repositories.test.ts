import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { git } from '../git/gitCli';
import { NodeRepositoryInspector } from '../repository/NodeRepositoryInspector';
import {
  AppSettingsStore,
  MemoryAppSettingsStore,
  type AppSettingsStorage,
  type RepositorySettingsMigration
} from '../settings/AppSettingsStore';
import type { TaskManagerAppSettings, UpdateAppSettingsRequest } from '../../shared/contracts';
import { FileRepositoryRegistry } from '../storage/FileRepositoryRegistry';
import { FileTaskStore } from '../storage/FileTaskStore';
import { TaskManagerService } from './TaskManagerService';

describe('TaskManagerService repository catalog', () => {
  it('migrates default, legacy, and task paths registry-first and preserves a pre-v4 backup', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-repository-migration-'));
    const defaultPath = await createRepository(root, 'default');
    const legacyPath = await createRepository(root, 'legacy');
    const taskPath = await createRepository(root, 'task');
    const store = new FileTaskStore(path.join(root, 'task-store'));
    await store.init();
    const task = await store.createTask({
      title: 'Existing task',
      prompt: 'Keep its repository association.',
      repositoryPath: taskPath
    });
    const settingsPath = path.join(root, 'app-settings.json');
    const legacyRaw = JSON.stringify({
      schemaVersion: 3,
      firstLaunchSetupCompleted: true,
      repositories: {
        knownPaths: [legacyPath],
        selectedPath: legacyPath
      }
    });
    await fs.writeFile(settingsPath, legacyRaw, 'utf8');
    const service = createService(root, defaultPath, store, settingsPath);

    await service.init();
    try {
      const catalog = await service.getRepositoryCatalog();
      const settings = await service.getAppSettings();
      const selected = catalog.repositories.find(
        (repository) => repository.id === catalog.selectedRepositoryId
      );

      expect(catalog.repositories).toHaveLength(3);
      expect(selected?.displayName).toBe('legacy');
      expect(catalog.repositories.find((repository) => repository.isDefault)?.displayName).toBe(
        'default'
      );
      expect(catalog.taskAssociations).toContainEqual({
        taskId: task.id,
        repositoryId: expect.any(String)
      });
      expect(settings.repositories.selectedRepositoryId).toBe(catalog.selectedRepositoryId);
      await expect(fs.readFile(`${settingsPath}.pre-v4-backup`, 'utf8')).resolves.toBe(
        legacyRaw
      );
      await expect(fs.readFile(settingsPath, 'utf8')).resolves.not.toContain('knownPaths');
    } finally {
      await service.shutdown();
    }
  }, 20_000);

  it('keeps paths behind trusted host methods and repairs selection after removal', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-repository-api-'));
    const defaultPath = await createRepository(root, 'default');
    const secondaryPath = await createRepository(root, 'secondary');
    const store = new FileTaskStore(path.join(root, 'task-store'));
    const settingsPath = path.join(root, 'app-settings.json');
    const service = createService(root, defaultPath, store, settingsPath);

    await service.init();
    try {
      const initial = await service.getRepositoryCatalog();
      const defaultId = initial.defaultRepositoryId!;
      await expect(
        service.createTask({
          title: 'Forged',
          prompt: 'Must not accept a renderer path.',
          repositoryPath: defaultPath
        } as never)
      ).rejects.toThrow('valid repository id');
      await expect(
        service.selectRepository({ repositoryId: 'forged-repository' })
      ).rejects.toThrow(/unavailable|Unknown repository/);
      await expect(
        service.updateAppSettings({
          repositories: { selectedRepositoryId: defaultId }
        } as never)
      ).rejects.toThrow('repository catalog API');

      const added = await service.addRepositoryFromTrustedPath(secondaryPath, {
        clientMutationId: 'add-secondary-0001'
      });
      const secondary = added.repositories.find(
        (repository) => repository.displayName === 'secondary'
      )!;
      expect(added.selectedRepositoryId).toBe(secondary.id);

      const duplicate = await service.addRepositoryFromTrustedPath(secondaryPath, {
        clientMutationId: 'add-secondary-0002'
      });
      expect(duplicate.repositories).toHaveLength(2);
      expect(duplicate.selectedRepositoryId).toBe(secondary.id);

      const movedPath = path.join(root, 'secondary-moved');
      await fs.rename(secondaryPath, movedPath);
      const relinked = await service.relinkRepositoryFromTrustedPath(movedPath, {
        repositoryId: secondary.id,
        clientMutationId: 'relink-secondary-01'
      });
      expect(relinked.repositories.find((repository) => repository.id === secondary.id)).toMatchObject({
        displayName: 'secondary-moved',
        availability: 'AVAILABLE'
      });

      const created = await service.createTask({
        title: 'Core resolved task',
        prompt: 'Resolve the opaque id before storage.',
        repositoryId: defaultId
      });
      expect(created.repositoryPath).toBe(await fs.realpath(defaultPath));
      await expect(
        service.removeRepository({
          repositoryId: defaultId,
          clientMutationId: 'remove-default-0001'
        })
      ).rejects.toThrow('default repository cannot be removed');

      const repaired = await service.removeRepository({
        repositoryId: secondary.id,
        clientMutationId: 'remove-secondary-01'
      });
      expect(repaired.selectedRepositoryId).toBe(defaultId);
      await expect(service.getAppSettings()).resolves.toMatchObject({
        repositories: { selectedRepositoryId: defaultId }
      });
    } finally {
      await service.shutdown();
    }
  }, 20_000);

  it('retries registry-first add and remove sagas after selection persistence fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-repository-saga-'));
    const defaultPath = await createRepository(root, 'default');
    const secondaryPath = await createRepository(root, 'secondary');
    const store = new FileTaskStore(path.join(root, 'task-store'));
    const settings = new FailOnceSelectionSettings();
    const service = new TaskManagerService(store, defaultPath, undefined, {
      appSettingsStore: settings,
      repositoryRegistry: new FileRepositoryRegistry(
        path.join(root, 'repository-registry'),
        new NodeRepositoryInspector()
      ),
      agentProviderStartupDisabledReason: 'Repository saga test does not run Codex.'
    });

    await service.init();
    try {
      settings.failNextSelection = true;
      await expect(
        service.addRepositoryFromTrustedPath(secondaryPath, {
          clientMutationId: 'add-secondary-fail1'
        })
      ).rejects.toThrow('injected selection persistence failure');

      const recoveredAdd = await service.addRepositoryFromTrustedPath(secondaryPath, {
        clientMutationId: 'add-secondary-retry'
      });
      expect(recoveredAdd.repositories).toHaveLength(2);
      const secondaryId = recoveredAdd.selectedRepositoryId!;

      settings.failNextSelection = true;
      await expect(
        service.removeRepository({
          repositoryId: secondaryId,
          clientMutationId: 'remove-secondary-fail'
        })
      ).rejects.toThrow('injected selection persistence failure');

      const recoveredRemove = await service.removeRepository({
        repositoryId: secondaryId,
        clientMutationId: 'remove-secondary-retry'
      });
      expect(recoveredRemove.repositories).toHaveLength(1);
      expect(recoveredRemove.selectedRepositoryId).toBe(recoveredRemove.defaultRepositoryId);
    } finally {
      await service.shutdown();
    }
  }, 20_000);
});

class FailOnceSelectionSettings implements AppSettingsStorage {
  readonly delegate = new MemoryAppSettingsStore();
  failNextSelection = false;

  initializeRepositories(_migrate: RepositorySettingsMigration): Promise<void> {
    return Promise.resolve();
  }

  get(): Promise<TaskManagerAppSettings> {
    return this.delegate.get();
  }

  update(input: UpdateAppSettingsRequest): Promise<TaskManagerAppSettings> {
    return this.delegate.update(input);
  }

  setSelectedRepositoryId(repositoryId: string | null): Promise<TaskManagerAppSettings> {
    if (this.failNextSelection) {
      this.failNextSelection = false;
      return Promise.reject(new Error('injected selection persistence failure'));
    }
    return this.delegate.setSelectedRepositoryId(repositoryId);
  }
}

function createService(
  root: string,
  defaultPath: string,
  store: FileTaskStore,
  settingsPath: string
): TaskManagerService {
  return new TaskManagerService(store, defaultPath, undefined, {
    appSettingsStore: new AppSettingsStore(settingsPath),
    repositoryRegistry: new FileRepositoryRegistry(
      path.join(root, 'repository-registry'),
      new NodeRepositoryInspector()
    ),
    agentProviderStartupDisabledReason: 'Repository catalog test does not run Codex.'
  });
}

async function createRepository(root: string, name: string): Promise<string> {
  const repositoryPath = path.join(root, name);
  await fs.mkdir(repositoryPath, { recursive: true });
  await git(repositoryPath, ['init']);
  await git(repositoryPath, ['config', 'user.email', 'task-monki-test@example.invalid']);
  await git(repositoryPath, ['config', 'user.name', 'Task Monki Test']);
  await fs.writeFile(path.join(repositoryPath, 'README.md'), `${name}\n`, 'utf8');
  await git(repositoryPath, ['add', 'README.md']);
  await git(repositoryPath, ['commit', '-m', 'Initial commit']);
  return repositoryPath;
}
