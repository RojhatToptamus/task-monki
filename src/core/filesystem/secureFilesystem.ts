import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';

type ChmodHandle = Pick<Awaited<ReturnType<typeof fs.open>>, 'chmod'>;

/**
 * Node exposes POSIX mode APIs on Windows, but Windows does not implement the
 * owner/group/other permission model that those APIs represent.
 */
export async function enforcePosixMode(
  target: string | ChmodHandle,
  mode: number
): Promise<void> {
  if (process.platform === 'win32') return;
  if (typeof target === 'string') {
    await fs.chmod(target, mode);
    return;
  }
  await target.chmod(mode);
}

export function posixModeMatches(
  stat: { mode: number | bigint },
  expected: number
): boolean {
  return process.platform === 'win32' || posixMode(stat) === expected;
}

export function hasNoGroupOrOtherPosixAccess(stat: {
  mode: number | bigint;
}): boolean {
  return process.platform === 'win32' || (posixMode(stat) & 0o077) === 0;
}

export function isOwnedByCurrentUser(stat: { uid: number | bigint }): boolean {
  if (typeof process.getuid !== 'function') return true;
  const uid = process.getuid();
  return typeof stat.uid === 'bigint'
    ? stat.uid === BigInt(uid)
    : stat.uid === uid;
}

/**
 * Directory fsync is not supported by Node on Windows. File handles are still
 * flushed before publication; POSIX directory metadata is flushed here where
 * the platform/filesystem supports it.
 */
export async function syncDirectoryIfSupported(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(
      directory,
      fsConstants.O_RDONLY |
        (fsConstants.O_DIRECTORY ?? 0) |
        (fsConstants.O_NOFOLLOW ?? 0)
    );
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await handle?.close();
  }
}

function posixMode(stat: { mode: number | bigint }): number {
  return typeof stat.mode === 'bigint'
    ? Number(stat.mode & BigInt(0o777))
    : stat.mode & 0o777;
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === 'EINVAL' ||
    code === 'ENOTSUP' ||
    code === 'EOPNOTSUPP' ||
    code === 'EBADF'
  );
}
