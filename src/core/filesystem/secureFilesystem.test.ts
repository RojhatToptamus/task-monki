import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendPrivateFile,
  enforcePosixMode,
  ensurePrivateDirectory,
  hasNoGroupOrOtherPosixAccess,
  isOwnedByCurrentUser,
  posixModeMatches,
  readPrivateFile,
  readPrivateFileRange,
  readPrivateFileTail,
  writePrivateFileAtomically,
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
  it('publishes private files atomically and supports bounded descriptor reads', async () => {
    const directory = await temporaryDirectory();
    const filePath = path.join(directory, 'private.txt');

    await writePrivateFileAtomically(filePath, 'first');
    await expect(appendPrivateFile(filePath, '-second')).resolves.toBe(5);

    await expect(readPrivateFile(filePath, 64)).resolves.toEqual(
      Buffer.from('first-second')
    );
    await expect(readPrivateFileRange(filePath, 6, 6, 64)).resolves.toEqual(
      Buffer.from('second')
    );
    await expect(readPrivateFileTail(filePath, 6)).resolves.toEqual(
      Buffer.from('second')
    );
    if (process.platform !== 'win32') {
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    }
  });

  it('does not reuse or remove an untrusted legacy temporary path', async () => {
    const directory = await temporaryDirectory();
    const filePath = path.join(directory, 'private.txt');
    const legacyTemporaryPath = `${filePath}.tmp`;
    await fs.mkdir(legacyTemporaryPath);
    await fs.writeFile(path.join(legacyTemporaryPath, 'marker'), 'keep');

    await writePrivateFileAtomically(filePath, 'published');

    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe('published');
    await expect(
      fs.readFile(path.join(legacyTemporaryPath, 'marker'), 'utf8')
    ).resolves.toBe('keep');
  });

  it.runIf(process.platform !== 'win32')(
    'can require an existing private mode without repairing it',
    async () => {
      const directory = await temporaryDirectory();
      const filePath = path.join(directory, 'private.txt');
      await fs.writeFile(filePath, 'private', { mode: 0o644 });

      await expect(
        readPrivateFile(filePath, 64, { permissionPolicy: 'REQUIRE' })
      ).rejects.toBeTruthy();
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o644);
    }
  );

  it(
    'rejects symlinked private files and directories without changing their targets',
    async () => {
      const directory = await temporaryDirectory();
      const outsideFile = path.join(directory, 'outside.txt');
      const fileLink = path.join(directory, 'linked.txt');
      await fs.writeFile(outsideFile, 'outside', { mode: 0o600 });
      await fs.symlink(outsideFile, fileLink);

      await expect(readPrivateFile(fileLink, 64)).rejects.toBeTruthy();
      await expect(appendPrivateFile(fileLink, 'changed')).rejects.toBeTruthy();
      await expect(fs.readFile(outsideFile, 'utf8')).resolves.toBe('outside');

      const outsideDirectory = path.join(directory, 'outside-directory');
      const directoryLink = path.join(directory, 'linked-directory');
      await fs.mkdir(outsideDirectory, { mode: 0o700 });
      await fs.symlink(
        outsideDirectory,
        directoryLink,
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      await expect(ensurePrivateDirectory(directoryLink)).rejects.toBeTruthy();
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
