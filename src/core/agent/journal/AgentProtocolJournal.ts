import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentProtocolMessageReference } from '../../../shared/agent';
import {
  enforcePosixMode,
  hasNoGroupOrOtherPosixAccess,
  isOwnedByCurrentUser,
  syncDirectoryIfSupported
} from '../../filesystem/secureFilesystem';
import { redactProtocolJournalRecord } from './AgentProtocolRedaction';

const SERVER_INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export const DEFAULT_AGENT_PROTOCOL_JOURNAL_LIMITS = Object.freeze({
  maxEntryBytes: 24 * 1024 * 1024,
  maxSegmentBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxUnsyncedBytes: 1024 * 1024,
  syncIntervalMs: 100,
  idleHandleTimeoutMs: 1_000
});

export interface AgentProtocolJournalOptions {
  /** Maximum serialized NDJSON bytes for one protocol message. */
  maxEntryBytes?: number;
  /** Maximum bytes in one segment. An existing segment zero may exceed this until rotation. */
  maxSegmentBytes?: number;
  /** Maximum retained segment bytes for one server instance. */
  maxTotalBytes?: number;
  /** Force a batched sync after this many dirty bytes. */
  maxUnsyncedBytes?: number;
  /** Maximum time dirty inbound data can remain without a filesystem sync. */
  syncIntervalMs?: number;
  /** Sync and release an inactive writer handle after this delay. */
  idleHandleTimeoutMs?: number;
}

interface NormalizedJournalOptions {
  maxEntryBytes: number;
  maxSegmentBytes: number;
  maxTotalBytes: number;
  maxUnsyncedBytes: number;
  syncIntervalMs: number;
  idleHandleTimeoutMs: number;
}

interface JournalEntry {
  serverInstanceId: string;
  segment?: number;
  sequence: number;
  direction: AgentProtocolMessageReference['direction'];
  recordedAt: string;
  raw: string;
  metadata?: Record<string, unknown>;
  sha256?: string;
}

interface WriterState {
  handle: Awaited<ReturnType<typeof fs.open>>;
  segment: number;
  byteLength: number;
  totalBytes: number;
  sequence: number;
  dirtyBytes: number;
  syncTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
}

interface SegmentEntry {
  segment: number;
  filePath: string;
  byteLength: number;
}

export interface AgentProtocolJournalRecord {
  raw: string;
  metadata?: Record<string, unknown>;
}

/**
 * Per-server segmented, structurally redacted protocol storage.
 *
 * Appends for one server are serialized and references use a global sequence.
 * Segment zero keeps the unnumbered `<server>.ndjson` name; newer references
 * carry a segment number only after rotation. Inbound writes are synced in
 * bounded batches, while outbound writes are synced before append resolves.
 */
export class AgentProtocolJournal {
  private readonly options: NormalizedJournalOptions;
  private readonly writers = new Map<string, WriterState>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly backgroundErrors = new Map<string, Error>();
  private closed = false;
  private directoryReady?: Promise<void>;

  constructor(
    private readonly journalDir: string,
    options: AgentProtocolJournalOptions = {}
  ) {
    this.options = normalizeOptions(options);
  }

  pathFor(serverInstanceId: string, segment = 0): string {
    assertSafeServerInstanceId(serverInstanceId);
    assertSegment(segment);
    const suffix = segment === 0 ? '.ndjson' : `.${segment}.ndjson`;
    const resolved = path.resolve(this.journalDir, `${serverInstanceId}${suffix}`);
    if (path.dirname(resolved) !== path.resolve(this.journalDir)) {
      throw new Error('Protocol journal path escaped its managed directory.');
    }
    return resolved;
  }

  append(
    serverInstanceId: string,
    direction: AgentProtocolMessageReference['direction'],
    raw: string,
    metadata?: Record<string, unknown>
  ): Promise<AgentProtocolMessageReference> {
    if (this.closed) {
      return Promise.reject(new Error('Protocol journal is closed.'));
    }
    assertSafeServerInstanceId(serverInstanceId);
    let redacted: AgentProtocolJournalRecord;
    try {
      this.assertUnredactedInputSize(raw, metadata);
      redacted = redactProtocolJournalRecord(raw, metadata);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.enqueue(serverInstanceId, async () => {
      this.throwBackgroundError(serverInstanceId);
      const reference = await this.appendSerialized(
        serverInstanceId,
        direction,
        redacted.raw,
        redacted.metadata
      );
      const state = this.writers.get(serverInstanceId);
      if (!state) {
        throw new Error('Protocol journal writer disappeared during append.');
      }
      if (
        direction === 'OUTBOUND' ||
        state.dirtyBytes >= this.options.maxUnsyncedBytes
      ) {
        await this.syncWriter(serverInstanceId, state);
      } else {
        this.scheduleSync(serverInstanceId, state);
      }
      this.scheduleIdleClose(serverInstanceId, state);
      return reference;
    });
  }

  read(
    reference: AgentProtocolMessageReference
  ): Promise<AgentProtocolJournalRecord> {
    validateReference(reference, this.options.maxEntryBytes);
    const segment = reference.segment ?? 0;
    return this.enqueue(reference.serverInstanceId, async () => {
      await this.ensureDirectory();
      const filePath = this.pathFor(reference.serverInstanceId, segment);
      let handle: Awaited<ReturnType<typeof fs.open>>;
      try {
        handle = await openPrivateFile(filePath, 'read');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(
            `Protocol journal segment ${segment} is unavailable or has been pruned.`
          );
        }
        throw error;
      }
      try {
        const stat = await handle.stat();
        if (
          reference.byteOffset + reference.byteLength > stat.size ||
          reference.byteOffset + reference.byteLength < reference.byteOffset
        ) {
          throw new Error('Protocol journal entry is incomplete.');
        }
        const buffer = Buffer.allocUnsafe(reference.byteLength);
        const { bytesRead } = await handle.read(
          buffer,
          0,
          reference.byteLength,
          reference.byteOffset
        );
        if (bytesRead !== reference.byteLength) {
          throw new Error('Protocol journal entry is incomplete.');
        }
        const entry = decodeEntry(buffer);
        const sha256 = hashRaw(entry.raw);
        if (
          entry.serverInstanceId !== reference.serverInstanceId ||
          (entry.segment ?? 0) !== segment ||
          entry.sequence !== reference.sequence ||
          entry.direction !== reference.direction ||
          entry.recordedAt !== reference.recordedAt ||
          sha256 !== reference.sha256 ||
          (entry.sha256 !== undefined && entry.sha256 !== sha256)
        ) {
          throw new Error('Protocol journal reference failed integrity validation.');
        }
        return { raw: entry.raw, metadata: entry.metadata };
      } finally {
        await handle.close();
      }
    });
  }

  /** Flushes all appends queued before this call. */
  async flush(serverInstanceId?: string): Promise<void> {
    if (serverInstanceId !== undefined) {
      assertSafeServerInstanceId(serverInstanceId);
    }
    const serverIds = serverInstanceId
      ? [serverInstanceId]
      : [
          ...new Set([
            ...this.queues.keys(),
            ...this.writers.keys(),
            ...this.backgroundErrors.keys()
          ])
        ];
    await Promise.all(
      serverIds.map((id) =>
        this.enqueue(id, async () => {
          this.throwBackgroundError(id);
          const state = this.writers.get(id);
          if (state) await this.syncWriter(id, state);
        })
      )
    );
  }

  /**
   * Removes every segment owned by one server after its durable record has
   * been collected. The server queue is drained first so an in-flight append
   * cannot recreate a segment behind the cleanup.
   */
  async removeServer(serverInstanceId: string): Promise<void> {
    if (this.closed) {
      throw new Error('Protocol journal is closed.');
    }
    assertSafeServerInstanceId(serverInstanceId);
    await this.enqueue(serverInstanceId, async () => {
      const state = this.writers.get(serverInstanceId);
      if (state) {
        clearWriterTimers(state);
        await state.handle.close().finally(() => {
          this.writers.delete(serverInstanceId);
        });
      }

      await this.ensureDirectory();
      const segments = await this.listSegments(serverInstanceId);
      for (const segment of segments) {
        await fs.unlink(segment.filePath);
      }
      if (segments.length > 0) {
        await syncDirectoryIfSupported(this.journalDir);
      }
      this.backgroundErrors.delete(serverInstanceId);
    });
  }

  /**
   * Validates managed journal entries and removes segments whose server record
   * was already removed from the durable store. Unknown files are not owned by
   * Task Monki and are left untouched.
   */
  async reconcileServers(retainedServerInstanceIds: Iterable<string>): Promise<void> {
    if (this.closed) {
      throw new Error('Protocol journal is closed.');
    }
    const retained = new Set<string>();
    for (const serverInstanceId of retainedServerInstanceIds) {
      assertSafeServerInstanceId(serverInstanceId);
      retained.add(serverInstanceId);
    }

    await this.ensureDirectory();
    const orphanServerIds = new Set<string>();
    for (const entry of await fs.readdir(this.journalDir, { withFileTypes: true })) {
      const parsed = parseManagedJournalFileName(entry.name);
      if (!parsed) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error('Protocol journal segment failed its integrity check.');
      }
      const stat = await fs.lstat(this.pathFor(parsed.serverInstanceId, parsed.segment));
      assertPrivateRegularFile(stat);
      if (!retained.has(parsed.serverInstanceId)) {
        orphanServerIds.add(parsed.serverInstanceId);
      }
    }

    await Promise.all(
      [...orphanServerIds].map((serverInstanceId) =>
        this.removeServer(serverInstanceId)
      )
    );
  }

  /** Flushes queued data and permanently releases every writer handle. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const serverIds = [
      ...new Set([
        ...this.queues.keys(),
        ...this.writers.keys(),
        ...this.backgroundErrors.keys()
      ])
    ];
    const results = await Promise.allSettled(
      serverIds.map((id) =>
        this.enqueue(id, async () => {
          const state = this.writers.get(id);
          if (!state) {
            this.throwBackgroundError(id);
            return;
          }
          clearWriterTimers(state);
          try {
            this.throwBackgroundError(id);
            await this.syncWriter(id, state);
          } finally {
            await state.handle.close().catch(() => undefined);
            this.writers.delete(id);
          }
        })
      )
    );
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (rejected) throw rejected.reason;
  }

  private enqueue<T>(serverInstanceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(serverInstanceId) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(operation);
    const tail = queued.then(
      () => undefined,
      () => undefined
    );
    this.queues.set(serverInstanceId, tail);
    void tail.then(() => {
      if (this.queues.get(serverInstanceId) === tail) {
        this.queues.delete(serverInstanceId);
      }
    });
    return queued;
  }

  private async appendSerialized(
    serverInstanceId: string,
    direction: AgentProtocolMessageReference['direction'],
    raw: string,
    metadata?: Record<string, unknown>
  ): Promise<AgentProtocolMessageReference> {
    const state = await this.getWriter(serverInstanceId);
    const sequence = state.sequence + 1;
    const recordedAt = new Date().toISOString();
    let encoded = encodeEntry({
      serverInstanceId,
      segment: state.segment === 0 ? undefined : state.segment,
      sequence,
      direction,
      recordedAt,
      raw,
      metadata,
      sha256: hashRaw(raw)
    });
    this.assertEntrySize(encoded.byteLength);

    if (
      state.byteLength > 0 &&
      state.byteLength + encoded.byteLength > this.options.maxSegmentBytes
    ) {
      await this.rotateWriter(serverInstanceId, state);
      encoded = encodeEntry({
        serverInstanceId,
        segment: state.segment,
        sequence,
        direction,
        recordedAt,
        raw,
        metadata,
        sha256: hashRaw(raw)
      });
      this.assertEntrySize(encoded.byteLength);
    }

    const byteOffset = state.byteLength;
    try {
      await writeAll(state.handle, encoded);
    } catch (cause) {
      this.rememberBackgroundError(serverInstanceId, cause);
      clearWriterTimers(state);
      await state.handle.close().catch(() => undefined);
      this.writers.delete(serverInstanceId);
      throw cause;
    }
    state.byteLength += encoded.byteLength;
    state.totalBytes += encoded.byteLength;
    state.sequence = sequence;
    state.dirtyBytes += encoded.byteLength;
    await this.pruneRetainedSegments(serverInstanceId, state);

    return {
      serverInstanceId,
      ...(state.segment === 0 ? {} : { segment: state.segment }),
      sequence,
      direction,
      recordedAt,
      byteOffset,
      byteLength: encoded.byteLength,
      sha256: hashRaw(raw)
    };
  }

  private assertEntrySize(byteLength: number): void {
    if (byteLength <= 0 || byteLength > this.options.maxEntryBytes) {
      throw new Error(
        `Protocol journal entry exceeds the ${this.options.maxEntryBytes}-byte limit.`
      );
    }
    if (byteLength > this.options.maxSegmentBytes) {
      throw new Error('Protocol journal entry cannot fit in one segment.');
    }
  }

  private assertUnredactedInputSize(
    raw: string,
    metadata?: Record<string, unknown>
  ): void {
    const metadataJson = metadata === undefined ? '' : JSON.stringify(metadata);
    const byteLength = Buffer.byteLength(raw) + Buffer.byteLength(metadataJson);
    if (byteLength > this.options.maxEntryBytes) {
      throw new Error(
        `Protocol journal entry exceeds the ${this.options.maxEntryBytes}-byte limit.`
      );
    }
  }

  private async getWriter(serverInstanceId: string): Promise<WriterState> {
    const existing = this.writers.get(serverInstanceId);
    if (existing) return existing;
    await this.ensureDirectory();
    let segments = await this.listSegments(serverInstanceId);
    const currentSegment = segments.at(-1)?.segment ?? 0;
    const sequence = await this.readLastSequence(serverInstanceId, segments);
    // Tail repair can remove a crash-truncated suffix, so refresh retained
    // sizes before enforcing the total bound.
    segments = await this.listSegments(serverInstanceId);
    const filePath = this.pathFor(serverInstanceId, currentSegment);
    const handle = await openPrivateFile(filePath, 'append');
    const stat = await handle.stat();
    const state: WriterState = {
      handle,
      segment: currentSegment,
      byteLength: stat.size,
      totalBytes: segments.reduce((total, segment) => total + segment.byteLength, 0),
      sequence,
      dirtyBytes: 0
    };
    if (!segments.some((segment) => segment.segment === currentSegment)) {
      state.totalBytes += stat.size;
    }
    this.writers.set(serverInstanceId, state);
    return state;
  }

  private async rotateWriter(
    serverInstanceId: string,
    state: WriterState
  ): Promise<void> {
    if (state.segment >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Protocol journal segment sequence is exhausted.');
    }
    clearWriterTimers(state);
    await this.syncWriter(serverInstanceId, state);
    await state.handle.close();
    state.segment += 1;
    try {
      state.handle = await openPrivateFile(
        this.pathFor(serverInstanceId, state.segment),
        'create'
      );
    } catch (error) {
      this.writers.delete(serverInstanceId);
      throw error;
    }
    state.byteLength = 0;
    state.dirtyBytes = 0;
    await syncDirectoryIfSupported(this.journalDir);
  }

  private async pruneRetainedSegments(
    serverInstanceId: string,
    state: WriterState
  ): Promise<void> {
    if (state.totalBytes <= this.options.maxTotalBytes) return;
    // Never durably prune the last complete copy before its replacement is
    // durable. Rotation/retention syncs are infrequent segment boundaries, not
    // per-token syncs.
    await this.syncWriter(serverInstanceId, state);
    const segments = await this.listSegments(serverInstanceId);
    let totalBytes = segments.reduce((total, segment) => total + segment.byteLength, 0);
    let pruned = false;
    for (const segment of segments) {
      if (totalBytes <= this.options.maxTotalBytes) break;
      if (segment.segment === state.segment) continue;
      const stat = await fs.lstat(segment.filePath).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        }
      );
      if (!stat) {
        totalBytes -= segment.byteLength;
        continue;
      }
      assertPrivateRegularFile(stat);
      await fs.unlink(segment.filePath);
      totalBytes -= segment.byteLength;
      pruned = true;
    }
    state.totalBytes = totalBytes;
    if (state.totalBytes > this.options.maxTotalBytes) {
      throw new Error('Protocol journal retention bound cannot be satisfied safely.');
    }
    if (pruned) await syncDirectoryIfSupported(this.journalDir);
  }

  private async listSegments(serverInstanceId: string): Promise<SegmentEntry[]> {
    const prefix = `${serverInstanceId}.`;
    const segments: SegmentEntry[] = [];
    for (const entry of await fs.readdir(this.journalDir, { withFileTypes: true })) {
      const segment = parseSegmentFileName(serverInstanceId, entry.name);
      if (segment === undefined) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error('Protocol journal segment failed its integrity check.');
      }
      const filePath = this.pathFor(serverInstanceId, segment);
      const stat = await fs.lstat(filePath);
      assertPrivateRegularFile(stat);
      segments.push({ segment, filePath, byteLength: stat.size });
    }
    segments.sort((left, right) => left.segment - right.segment);
    for (let index = 1; index < segments.length; index += 1) {
      if (segments[index - 1]!.segment === segments[index]!.segment) {
        throw new Error(`Duplicate protocol journal segment for ${prefix}`);
      }
    }
    return segments;
  }

  private async readLastSequence(
    serverInstanceId: string,
    segments: SegmentEntry[]
  ): Promise<number> {
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      const segment = segments[index]!;
      const lastEntry = await readLastCompleteEntry(
        segment.filePath,
        this.options.maxEntryBytes
      );
      if (!lastEntry) continue;
      if (
        lastEntry.serverInstanceId !== serverInstanceId ||
        (lastEntry.segment ?? 0) !== segment.segment ||
        !Number.isSafeInteger(lastEntry.sequence) ||
        lastEntry.sequence <= 0 ||
        (lastEntry.sha256 !== undefined && lastEntry.sha256 !== hashRaw(lastEntry.raw))
      ) {
        throw new Error('Protocol journal tail failed its integrity check.');
      }
      return lastEntry.sequence;
    }
    return 0;
  }

  private scheduleSync(serverInstanceId: string, state: WriterState): void {
    if (state.syncTimer || state.dirtyBytes === 0) return;
    state.syncTimer = setTimeout(() => {
      state.syncTimer = undefined;
      void this.enqueue(serverInstanceId, async () => {
        if (this.writers.get(serverInstanceId) === state) {
          await this.syncWriter(serverInstanceId, state);
        }
      }).catch((cause) => this.rememberBackgroundError(serverInstanceId, cause));
    }, this.options.syncIntervalMs);
    state.syncTimer.unref();
  }

  private scheduleIdleClose(serverInstanceId: string, state: WriterState): void {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      state.idleTimer = undefined;
      void this.enqueue(serverInstanceId, async () => {
        if (this.writers.get(serverInstanceId) !== state) return;
        try {
          await this.syncWriter(serverInstanceId, state);
        } finally {
          clearWriterTimers(state);
          await state.handle.close().catch(() => undefined);
          this.writers.delete(serverInstanceId);
        }
      }).catch((cause) => this.rememberBackgroundError(serverInstanceId, cause));
    }, this.options.idleHandleTimeoutMs);
    state.idleTimer.unref();
  }

  private async syncWriter(serverInstanceId: string, state: WriterState): Promise<void> {
    if (state.syncTimer) {
      clearTimeout(state.syncTimer);
      state.syncTimer = undefined;
    }
    if (state.dirtyBytes === 0) return;
    try {
      await state.handle.sync();
      state.dirtyBytes = 0;
    } catch (cause) {
      this.rememberBackgroundError(serverInstanceId, cause);
      throw cause;
    }
  }

  private rememberBackgroundError(serverInstanceId: string, cause: unknown): void {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (!this.backgroundErrors.has(serverInstanceId)) {
      this.backgroundErrors.set(serverInstanceId, error);
    }
  }

  private throwBackgroundError(serverInstanceId: string): void {
    const error = this.backgroundErrors.get(serverInstanceId);
    if (error) throw error;
  }

  private ensureDirectory(): Promise<void> {
    if (!this.directoryReady) {
      this.directoryReady = initializePrivateDirectory(this.journalDir).catch((error) => {
        this.directoryReady = undefined;
        throw error;
      });
    }
    return this.directoryReady;
  }
}

function normalizeOptions(options: AgentProtocolJournalOptions): NormalizedJournalOptions {
  const normalized = {
    ...DEFAULT_AGENT_PROTOCOL_JOURNAL_LIMITS,
    ...options
  };
  for (const [name, value] of Object.entries(normalized)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Protocol journal option ${name} must be a positive integer.`);
    }
  }
  if (normalized.maxEntryBytes > normalized.maxSegmentBytes) {
    throw new Error('Protocol journal entry bound must fit inside a segment.');
  }
  if (normalized.maxSegmentBytes > normalized.maxTotalBytes) {
    throw new Error('Protocol journal segment bound must fit inside total retention.');
  }
  if (normalized.maxUnsyncedBytes > normalized.maxSegmentBytes) {
    throw new Error('Protocol journal unsynced byte bound must fit inside a segment.');
  }
  return normalized;
}

async function initializePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !isOwnedByCurrentUser(stat)) {
    throw new Error('Protocol journal directory failed its integrity check.');
  }
  await enforcePosixMode(directory, 0o700);
  const secured = await fs.lstat(directory);
  if (!hasNoGroupOrOtherPosixAccess(secured)) {
    throw new Error('Protocol journal directory is not private.');
  }
}

async function openPrivateFile(
  filePath: string,
  mode: 'append' | 'create' | 'read' | 'repair'
): Promise<Awaited<ReturnType<typeof fs.open>>> {
  const flags =
    mode === 'append'
      ? fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_APPEND |
        (fsConstants.O_NOFOLLOW ?? 0)
      : mode === 'repair'
        ? fsConstants.O_RDWR |
          fsConstants.O_APPEND |
          (fsConstants.O_NOFOLLOW ?? 0)
      : mode === 'create'
        ? fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_APPEND |
          (fsConstants.O_NOFOLLOW ?? 0)
      : fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await fs.open(filePath, flags, 0o600);
  try {
    const stat = await handle.stat();
    assertPrivateRegularFile(stat, false);
    if (mode !== 'read') {
      await enforcePosixMode(handle, 0o600);
      const secured = await handle.stat();
      if (!hasNoGroupOrOtherPosixAccess(secured)) {
        throw new Error('Protocol journal segment is not private.');
      }
    } else if (!hasNoGroupOrOtherPosixAccess(stat)) {
      throw new Error('Protocol journal segment is not private.');
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function assertPrivateRegularFile(
  stat: {
    isFile(): boolean;
    uid: number | bigint;
    nlink: number | bigint;
    mode: number | bigint;
  },
  requirePrivate = true
): void {
  if (
    !stat.isFile() ||
    !isOwnedByCurrentUser(stat) ||
    (process.platform !== 'win32' && Number(stat.nlink) !== 1) ||
    (requirePrivate && !hasNoGroupOrOtherPosixAccess(stat))
  ) {
    throw new Error('Protocol journal segment failed its integrity check.');
  }
}

async function writeAll(
  handle: Awaited<ReturnType<typeof fs.open>>,
  bytes: Buffer
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      null
    );
    if (bytesWritten <= 0) {
      throw new Error('Protocol journal write made no progress.');
    }
    offset += bytesWritten;
  }
}

async function readLastCompleteEntry(
  filePath: string,
  maxEntryBytes: number
): Promise<JournalEntry | undefined> {
  const handle = await openPrivateFile(filePath, 'repair');
  try {
    let stat = await handle.stat();
    if (stat.size === 0) return undefined;
    const tailLength = Math.min(stat.size, maxEntryBytes + 1);
    const tail = Buffer.allocUnsafe(tailLength);
    const { bytesRead } = await handle.read(tail, 0, tailLength, stat.size - tailLength);
    if (bytesRead !== tailLength) {
      throw new Error('Protocol journal tail changed while it was read.');
    }
    let end = tailLength;
    if (tail[end - 1] !== 0x0a) {
      const lastNewline = tail.lastIndexOf(0x0a);
      if (lastNewline < 0 && stat.size > maxEntryBytes) {
        throw new Error('Protocol journal tail exceeds the entry bound.');
      }
      const truncateAt = stat.size - tailLength + lastNewline + 1;
      await handle.truncate(truncateAt);
      await handle.sync();
      stat = await handle.stat();
      if (stat.size === 0) return undefined;
      return readLastCompleteEntry(filePath, maxEntryBytes);
    }
    end -= 1;
    const previousNewline = tail.lastIndexOf(0x0a, end - 1);
    const start = previousNewline + 1;
    const line = tail.subarray(start, end + 1);
    if (line.byteLength > maxEntryBytes || (start === 0 && stat.size > tailLength)) {
      throw new Error('Protocol journal tail exceeds the entry bound.');
    }
    return decodeEntry(line);
  } finally {
    await handle.close();
  }
}

function encodeEntry(entry: JournalEntry): Buffer {
  return Buffer.from(`${JSON.stringify(entry)}\n`, 'utf8');
}

function decodeEntry(bytes: Buffer): JournalEntry {
  if (bytes.byteLength === 0 || bytes[bytes.byteLength - 1] !== 0x0a) {
    throw new Error('Protocol journal entry is incomplete.');
  }
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(0, bytes.byteLength - 1)
    );
  } catch {
    throw new Error('Protocol journal entry is not valid UTF-8.');
  }
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    throw new Error('Protocol journal entry is not valid JSON.');
  }
  if (!isJournalEntry(value)) {
    throw new Error('Protocol journal entry failed its integrity check.');
  }
  return value;
}

function isJournalEntry(value: unknown): value is JournalEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<JournalEntry>;
  return (
    typeof entry.serverInstanceId === 'string' &&
    (entry.segment === undefined ||
      (Number.isSafeInteger(entry.segment) && (entry.segment ?? -1) >= 0)) &&
    Number.isSafeInteger(entry.sequence) &&
    (entry.sequence ?? 0) > 0 &&
    (entry.direction === 'INBOUND' || entry.direction === 'OUTBOUND') &&
    typeof entry.recordedAt === 'string' &&
    Number.isFinite(Date.parse(entry.recordedAt)) &&
    typeof entry.raw === 'string' &&
    (entry.metadata === undefined ||
      (typeof entry.metadata === 'object' &&
        entry.metadata !== null &&
        !Array.isArray(entry.metadata))) &&
    (entry.sha256 === undefined || /^[a-f0-9]{64}$/.test(entry.sha256))
  );
}

function validateReference(
  reference: AgentProtocolMessageReference,
  maxEntryBytes: number
): void {
  assertSafeServerInstanceId(reference.serverInstanceId);
  assertSegment(reference.segment ?? 0);
  if (
    !Number.isSafeInteger(reference.sequence) ||
    reference.sequence <= 0 ||
    !Number.isSafeInteger(reference.byteOffset) ||
    reference.byteOffset < 0 ||
    !Number.isSafeInteger(reference.byteLength) ||
    reference.byteLength <= 0 ||
    reference.byteLength > maxEntryBytes ||
    (reference.direction !== 'INBOUND' && reference.direction !== 'OUTBOUND') ||
    !Number.isFinite(Date.parse(reference.recordedAt)) ||
    !/^[a-f0-9]{64}$/u.test(reference.sha256)
  ) {
    throw new Error('Protocol journal reference is invalid.');
  }
}

function assertSafeServerInstanceId(serverInstanceId: string): void {
  if (!SERVER_INSTANCE_ID_PATTERN.test(serverInstanceId)) {
    throw new Error('Protocol journal server instance id is invalid.');
  }
}

function assertSegment(segment: number): void {
  if (!Number.isSafeInteger(segment) || segment < 0) {
    throw new Error('Protocol journal segment is invalid.');
  }
}

function parseSegmentFileName(
  serverInstanceId: string,
  fileName: string
): number | undefined {
  if (fileName === `${serverInstanceId}.ndjson`) return 0;
  const prefix = `${serverInstanceId}.`;
  if (!fileName.startsWith(prefix) || !fileName.endsWith('.ndjson')) return undefined;
  const raw = fileName.slice(prefix.length, -'.ndjson'.length);
  if (!/^[1-9][0-9]*$/.test(raw)) return undefined;
  const segment = Number(raw);
  return Number.isSafeInteger(segment) ? segment : undefined;
}

function parseManagedJournalFileName(
  fileName: string
): { serverInstanceId: string; segment: number } | undefined {
  const match = /^([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?:\.([0-9]+))?\.ndjson$/.exec(
    fileName
  );
  if (!match) return undefined;
  const serverInstanceId = match[1]!;
  const rawSegment = match[2];
  if (rawSegment === undefined) {
    return { serverInstanceId, segment: 0 };
  }
  if (!/^[1-9][0-9]*$/.test(rawSegment)) {
    throw new Error('Protocol journal segment name is invalid.');
  }
  const segment = Number(rawSegment);
  assertSegment(segment);
  return { serverInstanceId, segment };
}

function hashRaw(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function clearWriterTimers(state: WriterState): void {
  if (state.syncTimer) clearTimeout(state.syncTimer);
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.syncTimer = undefined;
  state.idleTimer = undefined;
}
