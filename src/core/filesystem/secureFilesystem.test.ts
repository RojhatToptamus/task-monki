import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  enforcePosixMode,
  hasNoGroupOrOtherPosixAccess,
  isOwnedByCurrentUser,
  posixModeMatches,
  syncDirectoryIfSupported
} from './secureFilesystem';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

describe('secure filesystem platform boundaries', () => {
  it.runIf(process.platform !== 'win32')(
    'enforces and evaluates POSIX private modes',
    async () => {
      const directory = await temporaryDirectory();
      const filePath = path.join(directory, 'private.txt');
      await fs.writeFile(filePath, 'private', { mode: 0o666 });

      await enforcePosixMode(filePath, 0o600);

      const stat = await fs.stat(filePath);
      expect(posixModeMatches(stat, 0o600)).toBe(true);
      expect(hasNoGroupOrOtherPosixAccess(stat)).toBe(true);
      expect(isOwnedByCurrentUser(stat)).toBe(true);
    }
  );

  it.runIf(process.platform === 'win32')(
    'does not pretend to enforce POSIX modes on Windows',
    async () => {
      let chmodCalled = false;
      await enforcePosixMode(
        {
          chmod: async () => {
            chmodCalled = true;
          }
        },
        0o600
      );

      expect(chmodCalled).toBe(false);
      expect(posixModeMatches({ mode: 0 }, 0o600)).toBe(true);
      expect(hasNoGroupOrOtherPosixAccess({ mode: 0o777 })).toBe(true);
    }
  );

  it.runIf(process.platform !== 'win32')(
    'synchronizes a directory on supported POSIX filesystems',
    async () => {
      const directory = await temporaryDirectory();
      await expect(syncDirectoryIfSupported(directory)).resolves.toBeUndefined();
    }
  );

  it.runIf(process.platform === 'win32')(
    'skips unsupported Windows directory synchronization before opening a handle',
    async () => {
      await expect(
        syncDirectoryIfSupported('Z:\\task-monki-does-not-exist')
      ).resolves.toBeUndefined();
    }
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'task-monki-secure-filesystem-')
  );
  temporaryDirectories.push(directory);
  return directory;
}
