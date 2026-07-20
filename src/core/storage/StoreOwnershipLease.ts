import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  enforcePosixMode,
  isOwnedByCurrentUser,
  posixModeMatches,
  syncDirectoryIfSupported
} from '../filesystem/secureFilesystem';

export const STORE_OWNERSHIP_LEASE_FILE = '.task-monki-owner.lock';

const STORE_LEASE_MAX_BYTES = 4 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export interface StoreOwnershipLease {
  token: string;
  pid: number;
  acquiredAt: string;
}

export async function acquireStoreOwnershipLease(
  baseDir: string,
  leasePath: string
): Promise<StoreOwnershipLease> {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const lease: StoreOwnershipLease = {
      token: randomUUID(),
      pid: process.pid,
      acquiredAt: new Date().toISOString()
    };
    const ownerPath = storeLeaseOwnerPath(baseDir, path.basename(leasePath), lease.token);
    await writeStoreLeaseFile(ownerPath, lease);
    let linked = false;
    try {
      await syncDirectoryIfSupported(baseDir);
      await fs.link(ownerPath, leasePath);
      linked = true;
      await syncDirectoryIfSupported(baseDir);
      await assertStoreOwnershipLease(leasePath, lease);
      await cleanupOrphanedStoreLeaseFiles(baseDir, path.basename(leasePath), lease);
      return lease;
    } catch (error) {
      if (linked) {
        try {
          await releaseStoreOwnershipLease(baseDir, leasePath, lease);
        } catch (releaseError) {
          throw new AggregateError(
            [error, releaseError],
            'Task store ownership initialization failed and its lease could not be released.'
          );
        }
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        await fs.unlink(ownerPath).catch(() => undefined);
        throw error;
      }
      await fs.unlink(ownerPath).catch(() => undefined);
    }

    let existing: StoreLeaseInspection;
    try {
      existing = await inspectStoreOwnershipLease(leasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (processIsAlive(existing.lease.pid)) {
      throw new Error(
        `Task store is already owned by process ${existing.lease.pid}. Close the other Task Monki instance first.`
      );
    }
    await reclaimStoreOwnershipLease(baseDir, leasePath, existing);
  }
  throw new Error('Task store ownership changed repeatedly during initialization.');
}

export async function assertStoreOwnershipLease(
  leasePath: string,
  expected: StoreOwnershipLease
): Promise<void> {
  const inspected = await inspectStoreOwnershipLease(leasePath).catch(() => undefined);
  const ownerPath = storeLeaseOwnerPath(
    path.dirname(leasePath),
    path.basename(leasePath),
    expected.token
  );
  const owner = await inspectStoreOwnershipLease(ownerPath).catch(() => undefined);
  if (
    !inspected ||
    !owner ||
    !sameStoreLease(inspected.lease, expected) ||
    !sameStoreLease(owner.lease, expected) ||
    !sameStoreLeaseIdentity(inspected.stat, owner.stat)
  ) {
    throw new Error('Task store ownership lease was lost before publication.');
  }
}

export async function releaseStoreOwnershipLease(
  baseDir: string,
  leasePath: string,
  expected: StoreOwnershipLease
): Promise<void> {
  await assertStoreOwnershipLease(leasePath, expected);
  const ownerPath = storeLeaseOwnerPath(
    baseDir,
    path.basename(leasePath),
    expected.token
  );
  await fs.unlink(leasePath);
  await syncDirectoryIfSupported(baseDir);
  await fs.unlink(ownerPath);
  await syncDirectoryIfSupported(baseDir);
}

type StoreLeaseStat = Awaited<ReturnType<typeof fs.lstat>>;

interface StoreLeaseInspection {
  lease: StoreOwnershipLease;
  stat: StoreLeaseStat;
}

async function inspectStoreOwnershipLease(
  leasePath: string
): Promise<StoreLeaseInspection> {
  const before = await fs.lstat(leasePath);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    !isOwnedByCurrentUser(before) ||
    !posixModeMatches(before, 0o600) ||
    before.size > STORE_LEASE_MAX_BYTES
  ) {
    throw new Error('Task store ownership lease failed its integrity check.');
  }
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(
      leasePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
    );
  } catch {
    throw new Error('Task store ownership lease could not be opened safely.');
  }
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.dev !== before.dev ||
      (stat.ino !== 0 && before.ino !== 0 && stat.ino !== before.ino) ||
      stat.size !== before.size
    ) {
      throw new Error('Task store ownership lease changed while it was inspected.');
    }
    const raw = await handle.readFile('utf8');
    try {
      const value = JSON.parse(raw) as Partial<StoreOwnershipLease>;
      if (
        typeof value.token !== 'string' ||
        !UUID_PATTERN.test(value.token) ||
        !Number.isSafeInteger(value.pid) ||
        (value.pid ?? 0) <= 0 ||
        !isCanonicalTimestamp(value.acquiredAt)
      ) {
        throw new Error('Task store ownership lease failed its integrity check.');
      }
      return { lease: value as StoreOwnershipLease, stat };
    } catch {
      throw new Error('Task store ownership lease failed its integrity check.');
    }
  } finally {
    await handle.close();
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function writeStoreLeaseFile(
  filePath: string,
  lease: StoreOwnershipLease
): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(
      filePath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600
    );
    await handle.writeFile(`${JSON.stringify(lease)}\n`, 'utf8');
    await handle.sync();
    await enforcePosixMode(handle, 0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(filePath).catch(() => undefined);
    throw error;
  }
}

async function reclaimStoreOwnershipLease(
  baseDir: string,
  leasePath: string,
  expected: StoreLeaseInspection
): Promise<boolean> {
  const leaseName = path.basename(leasePath);
  const anchor = await findStoreLeaseAnchor(baseDir, leaseName, expected);
  if (!anchor) return false;
  const reclaimPath = storeLeaseReclaimPath(
    baseDir,
    leaseName,
    expected.lease.token,
    randomUUID()
  );
  try {
    await fs.rename(anchor, reclaimPath);
    await syncDirectoryIfSupported(baseDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  try {
    const [canonical, claimed] = await Promise.all([
      inspectStoreOwnershipLease(leasePath),
      inspectStoreOwnershipLease(reclaimPath)
    ]);
    if (
      !sameStoreLease(canonical.lease, expected.lease) ||
      !sameStoreLease(claimed.lease, expected.lease) ||
      !sameStoreLeaseIdentity(canonical.stat, expected.stat) ||
      !sameStoreLeaseIdentity(claimed.stat, expected.stat)
    ) {
      throw new Error('Task store ownership changed during stale-lease reclamation.');
    }
    await fs.unlink(leasePath);
    await syncDirectoryIfSupported(baseDir);
    await fs.unlink(reclaimPath);
    await syncDirectoryIfSupported(baseDir);
    return true;
  } catch (error) {
    const canonical = await fs.lstat(leasePath).catch(() => undefined);
    if (canonical && sameStoreLeaseIdentity(canonical, expected.stat)) {
      try {
        await fs.rename(reclaimPath, anchor);
        await syncDirectoryIfSupported(baseDir);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          'Task store stale-lease reclamation failed and its anchor could not be restored.'
        );
      }
    }
    throw error;
  }
}

async function findStoreLeaseAnchor(
  baseDir: string,
  leaseName: string,
  expected: StoreLeaseInspection
): Promise<string | undefined> {
  const candidates: string[] = [];
  for (const entry of await fs.readdir(baseDir, { withFileTypes: true })) {
    if (!isStoreLeaseAnchorName(entry.name, leaseName, expected.lease.token)) continue;
    const entryPath = path.join(baseDir, entry.name);
    const inspected = await inspectStoreOwnershipLease(entryPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (!inspected) continue;
    if (
      sameStoreLease(inspected.lease, expected.lease) &&
      sameStoreLeaseIdentity(inspected.stat, expected.stat)
    ) {
      candidates.push(entryPath);
    }
  }
  if (candidates.length > 1) {
    throw new Error('Task store ownership lease has multiple reclaim anchors.');
  }
  return candidates[0];
}

async function cleanupOrphanedStoreLeaseFiles(
  baseDir: string,
  leaseName: string,
  active: StoreOwnershipLease
): Promise<void> {
  let removed = false;
  for (const entry of await fs.readdir(baseDir, { withFileTypes: true })) {
    const token = storeLeaseArtifactToken(entry.name, leaseName);
    if (!token || token === active.token) continue;
    const entryPath = path.join(baseDir, entry.name);
    const inspected = await inspectStoreOwnershipLease(entryPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (!inspected || processIsAlive(inspected.lease.pid)) continue;
    await fs.unlink(entryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    removed = true;
  }
  if (removed) await syncDirectoryIfSupported(baseDir);
}

function storeLeaseOwnerPath(baseDir: string, leaseName: string, token: string): string {
  return path.join(baseDir, `${leaseName}.${token}.owner`);
}

function storeLeaseReclaimPath(
  baseDir: string,
  leaseName: string,
  token: string,
  reclaimToken: string
): string {
  return path.join(baseDir, `${leaseName}.${token}.reclaim.${reclaimToken}`);
}

function storeLeaseArtifactToken(name: string, leaseName: string): string | undefined {
  const prefix = `${leaseName}.`;
  if (!name.startsWith(prefix)) return undefined;
  const parts = name.slice(prefix.length).split('.');
  if (!UUID_PATTERN.test(parts[0] ?? '')) return undefined;
  if (parts.length === 2 && parts[1] === 'owner') return parts[0];
  if (
    parts.length === 3 &&
    parts[1] === 'reclaim' &&
    UUID_PATTERN.test(parts[2] ?? '')
  ) {
    return parts[0];
  }
  return undefined;
}

function isStoreLeaseAnchorName(name: string, leaseName: string, token: string): boolean {
  return storeLeaseArtifactToken(name, leaseName) === token;
}

function sameStoreLease(left: StoreOwnershipLease, right: StoreOwnershipLease): boolean {
  return (
    left.token === right.token &&
    left.pid === right.pid &&
    left.acquiredAt === right.acquiredAt
  );
}

function sameStoreLeaseIdentity(left: StoreLeaseStat, right: StoreLeaseStat): boolean {
  return (
    left.dev === right.dev &&
    (left.ino === 0 || right.ino === 0 || left.ino === right.ino)
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
