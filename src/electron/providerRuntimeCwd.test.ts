import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveProviderRuntimeCwd } from './providerRuntimeCwd';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

describe('resolveProviderRuntimeCwd', () => {
  it('keeps a configured development repository as the provider cwd', () => {
    expect(
      resolveProviderRuntimeCwd({
        defaultRepositoryPath: '/work/repository',
        userDataDir: '/app/profile'
      })
    ).toBe('/work/repository');
  });

  it('creates a dedicated app-owned bootstrap directory for packaged startup', async () => {
    const userDataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-provider-cwd-')
    );
    temporaryDirectories.push(userDataDir);

    const runtimeCwd = resolveProviderRuntimeCwd({
      defaultRepositoryPath: '',
      userDataDir
    });

    expect(runtimeCwd).toBe(path.join(userDataDir, 'provider-runtime'));
    expect((await fs.stat(runtimeCwd)).isDirectory()).toBe(true);
  });
});
