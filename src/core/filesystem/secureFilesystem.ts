import { randomUUID } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

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

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(
      directory,
      fsConstants.O_RDONLY |
        (fsConstants.O_DIRECTORY ?? 0) |
        (fsConstants.O_NOFOLLOW ?? 0)
    );
    const stat = await handle.stat();
    if (!stat.isDirectory() || !isOwnedByCurrentUser(stat)) {
      throw new Error('Private directory failed its integrity check.');
    }
    await enforcePosixMode(handle, 0o700);
    if (!posixModeMatches(await handle.stat(), 0o700)) {
      throw new Error('Private directory has unsafe permissions.');
    }
  } finally {
    await handle?.close();
  }
}

export async function readPrivateFile(
  filePath: string,
  maxBytes: number
): Promise<Buffer> {
  assertReadLimit(maxBytes);
  const { handle, stat } = await openPrivateFile(filePath, fsConstants.O_RDONLY);
  try {
    if (stat.size > maxBytes) {
      throw new Error('Private file exceeds its size limit.');
    }
    const contents = await readExactly(handle, stat.size, 0);
    await assertUnchangedPrivateFile(handle, stat, stat.size);
    return contents;
  } finally {
    await handle.close();
  }
}

export async function readPrivateFileTail(
  filePath: string,
  maxBytes: number
): Promise<Buffer> {
  assertReadLimit(maxBytes);
  const { handle, stat } = await openPrivateFile(filePath, fsConstants.O_RDONLY);
  try {
    const byteLength = Math.min(stat.size, maxBytes);
    const contents = await readExactly(handle, byteLength, stat.size - byteLength);
    await assertUnchangedPrivateFile(handle, stat, stat.size);
    return contents;
  } finally {
    await handle.close();
  }
}

export async function readPrivateFileRange(
  filePath: string,
  byteOffset: number,
  byteLength: number,
  maxBytes: number
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(byteOffset) ||
    byteOffset < 0 ||
    !Number.isSafeInteger(byteLength) ||
    byteLength <= 0 ||
    byteLength > maxBytes ||
    !Number.isSafeInteger(byteOffset + byteLength)
  ) {
    throw new Error('Private file range is invalid.');
  }
  assertReadLimit(maxBytes);
  const { handle, stat } = await openPrivateFile(filePath, fsConstants.O_RDONLY);
  try {
    if (byteOffset + byteLength > stat.size) {
      throw new Error('Private file range is incomplete.');
    }
    const contents = await readExactly(handle, byteLength, byteOffset);
    await assertUnchangedPrivateFile(handle, stat);
    return contents;
  } finally {
    await handle.close();
  }
}

export async function appendPrivateFile(
  filePath: string,
  contents: string | Buffer
): Promise<number> {
  await ensurePrivateDirectory(path.dirname(filePath));
  const { handle, stat } = await openPrivateFile(
    filePath,
    fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT,
    0o600
  );
  try {
    await handle.writeFile(contents);
    await enforcePosixMode(handle, 0o600);
    assertPrivateFileStat(await handle.stat());
    await handle.sync();
    return stat.size;
  } finally {
    await handle.close();
  }
}

export async function writePrivateFileAtomically(
  filePath: string,
  contents: string | Buffer
): Promise<void> {
  const directory = path.dirname(filePath);
  await ensurePrivateDirectory(directory);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(
      temporaryPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600
    );
    await handle.writeFile(contents);
    await enforcePosixMode(handle, 0o600);
    assertPrivateFileStat(await handle.stat());
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, filePath);
    await syncDirectoryIfSupported(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function openPrivateFile(
  filePath: string,
  flags: number,
  mode?: number
): Promise<{
  handle: Awaited<ReturnType<typeof fs.open>>;
  stat: Stats;
}> {
  const handle = await fs.open(
    filePath,
    flags |
      (fsConstants.O_NOFOLLOW ?? 0) |
      (fsConstants.O_NONBLOCK ?? 0),
    mode
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || !isOwnedByCurrentUser(before)) {
      throw new Error('Private file failed its integrity check.');
    }
    await enforcePosixMode(handle, 0o600);
    const stat = await handle.stat();
    assertPrivateFileStat(stat);
    if (!sameFileIdentity(before, stat)) {
      throw new Error('Private file changed during initialization.');
    }
    return { handle, stat };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function assertPrivateFileStat(stat: {
  isFile(): boolean;
  mode: number | bigint;
  uid: number | bigint;
}): void {
  if (
    !stat.isFile() ||
    !isOwnedByCurrentUser(stat) ||
    !posixModeMatches(stat, 0o600)
  ) {
    throw new Error('Private file failed its integrity check.');
  }
}

async function assertUnchangedPrivateFile(
  handle: Awaited<ReturnType<typeof fs.open>>,
  before: { dev: number | bigint; ino: number | bigint; size: number },
  expectedSize?: number
): Promise<void> {
  const after = await handle.stat();
  assertPrivateFileStat(after);
  if (
    !sameFileIdentity(before, after) ||
    (expectedSize !== undefined && after.size !== expectedSize)
  ) {
    throw new Error('Private file changed while it was being read.');
  }
}

async function readExactly(
  handle: Awaited<ReturnType<typeof fs.open>>,
  byteLength: number,
  byteOffset: number
): Promise<Buffer> {
  const buffer = Buffer.alloc(byteLength);
  let totalRead = 0;
  while (totalRead < byteLength) {
    const { bytesRead } = await handle.read(
      buffer,
      totalRead,
      byteLength - totalRead,
      byteOffset + totalRead
    );
    if (bytesRead === 0) {
      throw new Error('Private file changed while it was being read.');
    }
    totalRead += bytesRead;
  }
  return buffer;
}

function sameFileIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint }
): boolean {
  return (
    left.dev === right.dev &&
    (left.ino === 0 || right.ino === 0 || left.ino === right.ino)
  );
}

function assertReadLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('Private file size limit is invalid.');
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
