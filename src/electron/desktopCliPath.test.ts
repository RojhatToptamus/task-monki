import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDesktopCliPath } from './desktopCliPath';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

describe('buildDesktopCliPath', () => {
  it('adds common macOS user CLI locations for Finder-launched apps', async () => {
    const homeDir = await temporaryHome();
    await Promise.all([
      fs.mkdir(path.join(homeDir, '.nvm', 'versions', 'node', 'v20.19.5', 'bin'), {
        recursive: true
      }),
      fs.mkdir(path.join(homeDir, '.nvm', 'versions', 'node', 'v22.23.1', 'bin'), {
        recursive: true
      }),
      fs.mkdir(path.join(homeDir, '.nvm', 'versions', 'node', 'current', 'bin'), {
        recursive: true
      })
    ]);

    const entries = buildDesktopCliPath({
      platform: 'darwin',
      homeDir,
      existingPath: ['/usr/bin', path.join(homeDir, '.local', 'bin')].join(path.delimiter)
    }).split(path.delimiter);

    expect(entries).toEqual([
      path.join(homeDir, '.local', 'bin'),
      path.join(homeDir, '.opencode', 'bin'),
      path.join(homeDir, '.nvm', 'versions', 'node', 'v22.23.1', 'bin'),
      path.join(homeDir, '.nvm', 'versions', 'node', 'v20.19.5', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin'
    ]);
  });

  it('keeps non-macOS path construction unchanged', () => {
    expect(
      buildDesktopCliPath({
        platform: 'linux',
        homeDir: '/home/example',
        existingPath: '/custom/bin:/usr/bin'
      })
    ).toBe('/usr/local/bin:/usr/bin:/bin:/custom/bin');
  });
});

async function temporaryHome(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-cli-path-'));
  temporaryDirectories.push(directory);
  return directory;
}
