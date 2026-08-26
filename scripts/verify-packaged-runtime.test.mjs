import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertPackagedDesignResources,
  assertPackagedApplicationEntries,
  resolvePackagedArchive,
  resolvePackagedRuntime
} from './verify-packaged-runtime.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

describe('packaged runtime selection', () => {
  const releaseDir = path.resolve('release-test');

  it.each([
    ['darwin', 'x64', ['mac', 'Task Monki.app', 'Contents', 'MacOS', 'Task Monki']],
    ['darwin', 'arm64', ['mac-arm64', 'Task Monki.app', 'Contents', 'MacOS', 'Task Monki']],
    ['win32', 'x64', ['win-unpacked', 'Task Monki.exe']],
    ['linux', 'x64', ['linux-unpacked', 'task-monki']]
  ])('selects the %s/%s executable', (platform, arch, segments) => {
    expect(resolvePackagedRuntime({ platform, arch, releaseDir })).toBe(
      path.join(releaseDir, ...segments)
    );
  });

  it.each([
    ['darwin', 'ia32'],
    ['win32', 'arm64'],
    ['linux', 'arm64'],
    ['freebsd', 'x64']
  ])('rejects unsupported %s/%s runners', (platform, arch) => {
    expect(() => resolvePackagedRuntime({ platform, arch, releaseDir })).toThrow(
      `Unsupported packaged runtime platform: ${platform}/${arch}`
    );
  });

  it('selects the packaged application archive for every supported runner', () => {
    expect(resolvePackagedArchive({ platform: 'darwin', arch: 'arm64', releaseDir })).toBe(
      path.join(
        releaseDir,
        'mac-arm64',
        'Task Monki.app',
        'Contents',
        'Resources',
        'app.asar'
      )
    );
    expect(resolvePackagedArchive({ platform: 'win32', arch: 'x64', releaseDir })).toBe(
      path.join(releaseDir, 'win-unpacked', 'resources', 'app.asar')
    );
  });

  it('accepts production application entries without development tools', () => {
    expect(() =>
      assertPackagedApplicationEntries([
        '/dist-electron/electron/main.js',
        '/dist-electron/electron/preload.js',
        '/dist-electron/core/app/TaskManagerService.js',
        '/dist-electron/shared/contracts.js',
        '/dist-renderer/index.html',
        '/package.json'
      ])
    ).not.toThrow();
  });

  it.each([
    ['Electron main entry point', '/dist-electron/electron/main.js'],
    ['Electron preload entry point', '/dist-electron/electron/preload.js'],
    ['core application entry point', '/dist-electron/core/app/TaskManagerService.js'],
    ['shared contracts', '/dist-electron/shared/contracts.js'],
    ['renderer entry point', '/dist-renderer/index.html'],
    ['package manifest', '/package.json']
  ])('rejects an archive missing its %s', (description, missingEntry) => {
    const entries = [
      '/dist-electron/electron/main.js',
      '/dist-electron/electron/preload.js',
      '/dist-electron/core/app/TaskManagerService.js',
      '/dist-electron/shared/contracts.js',
      '/dist-renderer/index.html',
      '/package.json'
    ].filter((entry) => entry !== missingEntry);

    expect(() => assertPackagedApplicationEntries(entries)).toThrow(
      `missing its ${description}`
    );
  });

  it.each([
    '/dist-electron/dev/providerSmoke.js',
    '/dist-tools/dev/seed.js',
    '/src/dev/seedData.ts'
  ])('rejects development-only packaged content: %s', (entry) => {
    expect(() =>
      assertPackagedApplicationEntries([
        '/dist-electron/electron/main.js',
        '/dist-electron/electron/preload.js',
        '/dist-electron/core/app/TaskManagerService.js',
        '/dist-electron/shared/contracts.js',
        '/dist-renderer/index.html',
        '/package.json',
        entry
      ])
    ).toThrow('development-only content');
  });

  it('accepts the complete packaged Design skill and legal resources', async () => {
    const resources = await packagedDesignResources();

    await expect(assertPackagedDesignResources(resources)).resolves.toBeUndefined();
  });

  it('rejects a packaged Design resource that is missing', async () => {
    const resources = await packagedDesignResources();
    await fs.rm(path.join(resources, 'design-skills/prototype/SKILL.md'));

    await expect(assertPackagedDesignResources(resources)).rejects.toThrow(
      'prototype/SKILL.md'
    );
  });
});

async function packagedDesignResources() {
  const resources = await fs.mkdtemp(
    path.join(os.tmpdir(), 'task-monki-packaged-design-resources-')
  );
  temporaryDirectories.push(resources);
  await copyDirectory(
    path.resolve('resources/design-skills'),
    path.join(resources, 'design-skills')
  );
  await fs.mkdir(path.join(resources, 'legal/third-party'), { recursive: true });
  await fs.copyFile(
    path.resolve('THIRD_PARTY_NOTICES.md'),
    path.join(resources, 'legal/THIRD_PARTY_NOTICES.md')
  );
  await fs.copyFile(
    path.resolve('THIRD_PARTY_LICENSES/Claude-Design-System-MIT.txt'),
    path.join(resources, 'legal/third-party/Claude-Design-System-MIT.txt')
  );
  await fs.mkdir(path.join(resources, 'legal/electron'), { recursive: true });
  await fs.writeFile(path.join(resources, 'legal/electron/LICENSE'), 'Electron license\n');
  await fs.writeFile(
    path.join(resources, 'legal/electron/LICENSES.chromium.html'),
    'Chromium notices\n'
  );
  return resources;
}

async function copyDirectory(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyDirectory(sourcePath, destinationPath);
    else await fs.copyFile(sourcePath, destinationPath);
  }
}
