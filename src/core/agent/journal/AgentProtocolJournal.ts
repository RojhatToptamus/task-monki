import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentProtocolMessageReference } from '../../../shared/agent';
import { AGENT_RUNTIME_LIMITS } from '../../../shared/agentRuntime';
import {
  enforcePosixMode,
  hasNoGroupOrOtherPosixAccess,
  isOwnedByCurrentUser,
  syncDirectoryIfSupported
} from '../../filesystem/secureFilesystem';

const SAFE_SERVER_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const JOURNAL_FILE = /^([A-Za-z0-9_-]{1,128})\.ndjson$/u;

interface JournalEntry {
  serverInstanceId: string;
  sequence: number;
  direction: AgentProtocolMessageReference['direction'];
  recordedAt: string;
  raw: string;
  metadata?: Record<string, unknown>;
}

export interface AgentProtocolJournalRecord {
  raw: string;
  metadata?: Record<string, unknown>;
}

export class AgentProtocolJournal {
  private readonly sequences = new Map<string, number>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly journalDir: string) {}

  pathFor(serverInstanceId: string): string {
    requireServerId(serverInstanceId);
    return path.join(this.journalDir, `${serverInstanceId}.ndjson`);
  }

  async reconcile(serverInstanceIds: readonly string[]): Promise<void> {
    await this.ensureDirectory();
    const expected = new Set(serverInstanceIds);
    for (const serverInstanceId of expected) requireServerId(serverInstanceId);
    for (const entry of await fs.readdir(this.journalDir, { withFileTypes: true })) {
      const match = entry.name.match(JOURNAL_FILE);
      if (!entry.isFile() || entry.isSymbolicLink() || !match) {
        throw new Error('Protocol journal directory contains an unsafe entry.');
      }
      if (!expected.has(match[1]!)) {
        throw new Error('Protocol journal file has no owning server record.');
      }
      const stat = await fs.lstat(path.join(this.journalDir, entry.name));
      if (
        stat.size > AGENT_RUNTIME_LIMITS.maxProtocolJournalBytesPerServer ||
        !isOwnedByCurrentUser(stat) ||
        !hasNoGroupOrOtherPosixAccess(stat)
      ) {
        throw new Error('Protocol journal file failed its integrity check.');
      }
      const sequence = await this.readLastSequence(
        path.join(this.journalDir, entry.name)
      );
      if (sequence > AGENT_RUNTIME_LIMITS.maxProtocolMessagesPerServer) {
        throw new Error('Protocol journal message-count limit was exceeded.');
      }
      this.sequences.set(match[1]!, sequence);
    }
  }

  append(
    serverInstanceId: string,
    direction: AgentProtocolMessageReference['direction'],
    raw: string,
    metadata?: Record<string, unknown>
  ): Promise<AgentProtocolMessageReference> {
    requireServerId(serverInstanceId);
    if (!['INBOUND', 'OUTBOUND'].includes(direction)) {
      return Promise.reject(new Error('Protocol journal direction is invalid.'));
    }
    if (
      !raw ||
      Buffer.byteLength(raw, 'utf8') > AGENT_RUNTIME_LIMITS.maxProtocolMessageBytes
    ) {
      return Promise.reject(new Error('Protocol journal message exceeds its safety limit.'));
    }
    const operation = (this.queues.get(serverInstanceId) ?? Promise.resolve()).then(() =>
      this.appendSerialized(serverInstanceId, direction, raw, metadata)
    );
    this.queues.set(serverInstanceId, operation.catch(() => undefined));
    return operation;
  }

  async read(
    reference: AgentProtocolMessageReference
  ): Promise<AgentProtocolJournalRecord> {
    assertReference(reference);
    const handle = await fs.open(
      this.pathFor(reference.serverInstanceId),
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
    );
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        !isOwnedByCurrentUser(stat) ||
        !hasNoGroupOrOtherPosixAccess(stat)
      ) {
        throw new Error('Protocol journal file failed its integrity check.');
      }
      const buffer = Buffer.alloc(reference.byteLength);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        reference.byteLength,
        reference.byteOffset
      );
      if (bytesRead !== reference.byteLength) {
        throw new Error('Protocol journal entry is incomplete.');
      }
      const entry = JSON.parse(buffer.toString('utf8').trim()) as JournalEntry;
      if (
        entry.serverInstanceId !== reference.serverInstanceId ||
        entry.sequence !== reference.sequence ||
        entry.direction !== reference.direction ||
        createHash('sha256').update(entry.raw).digest('hex') !== reference.sha256
      ) {
        throw new Error('Protocol journal reference failed integrity validation.');
      }
      return { raw: entry.raw, metadata: entry.metadata };
    } finally {
      await handle.close();
    }
  }

  private async appendSerialized(
    serverInstanceId: string,
    direction: AgentProtocolMessageReference['direction'],
    raw: string,
    metadata?: Record<string, unknown>
  ): Promise<AgentProtocolMessageReference> {
    await this.ensureDirectory();

    const filePath = this.pathFor(serverInstanceId);
    const previousSequence = this.sequences.has(serverInstanceId)
      ? this.sequences.get(serverInstanceId) ?? 0
      : await this.readLastSequence(filePath);
    const sequence = previousSequence + 1;
    const recordedAt = new Date().toISOString();
    const entry: JournalEntry = {
      serverInstanceId,
      sequence,
      direction,
      recordedAt,
      raw,
      metadata
    };
    const line = `${JSON.stringify(entry)}\n`;
    const byteLength = Buffer.byteLength(line);
    if (byteLength > AGENT_RUNTIME_LIMITS.maxProtocolMessageBytes) {
      throw new Error('Encoded protocol journal entry exceeds its safety limit.');
    }
    if (sequence > AGENT_RUNTIME_LIMITS.maxProtocolMessagesPerServer) {
      throw new Error('Protocol journal message-count limit reached.');
    }
    const handle = await fs.open(
      filePath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_APPEND |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600
    );

    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        !isOwnedByCurrentUser(stat) ||
        (stat.size > 0 && !hasNoGroupOrOtherPosixAccess(stat)) ||
        stat.size + byteLength > AGENT_RUNTIME_LIMITS.maxProtocolJournalBytesPerServer
      ) {
        throw new Error('Protocol journal file failed its integrity or size check.');
      }
      await handle.writeFile(line, 'utf8');
      await handle.sync();
      await enforcePosixMode(handle, 0o600);
      await handle.sync();
      if (stat.size === 0) await syncDirectoryIfSupported(this.journalDir);
      this.sequences.set(serverInstanceId, sequence);
      return {
        serverInstanceId,
        sequence,
        direction,
        recordedAt,
        byteOffset: stat.size,
        byteLength,
        sha256: createHash('sha256').update(raw).digest('hex')
      };
    } finally {
      await handle.close();
    }
  }

  private async readLastSequence(filePath: string): Promise<number> {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      handle = await fs.open(
        filePath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
      );
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.size > AGENT_RUNTIME_LIMITS.maxProtocolJournalBytesPerServer ||
        !isOwnedByCurrentUser(stat) ||
        !hasNoGroupOrOtherPosixAccess(stat)
      ) {
        throw new Error('Protocol journal file failed its integrity check.');
      }
      if (stat.size === 0) return 0;
      const byteLength = Math.min(
        stat.size,
        AGENT_RUNTIME_LIMITS.maxProtocolMessageBytes
      );
      const buffer = Buffer.alloc(byteLength);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        byteLength,
        stat.size - byteLength
      );
      if (bytesRead !== byteLength) {
        throw new Error('Protocol journal tail changed while it was read.');
      }
      const contents = buffer.toString('utf8');
      const lastLine = contents
        .trim()
        .split('\n')
        .filter(Boolean)
        .at(-1);
      if (!lastLine) {
        return 0;
      }
      const parsed = JSON.parse(lastLine) as Partial<JournalEntry>;
      return typeof parsed.sequence === 'number' ? parsed.sequence : 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 0;
      }
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.journalDir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.journalDir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !isOwnedByCurrentUser(stat)) {
      throw new Error('Protocol journal root failed its integrity check.');
    }
    await enforcePosixMode(this.journalDir, 0o700);
  }
}

function requireServerId(serverInstanceId: string): void {
  if (!SAFE_SERVER_ID.test(serverInstanceId)) {
    throw new Error('Protocol journal server id is invalid.');
  }
}

function assertReference(reference: AgentProtocolMessageReference): void {
  requireServerId(reference.serverInstanceId);
  if (
    !Number.isSafeInteger(reference.sequence) ||
    reference.sequence < 1 ||
    !Number.isSafeInteger(reference.byteOffset) ||
    reference.byteOffset < 0 ||
    !Number.isSafeInteger(reference.byteLength) ||
    reference.byteLength < 1 ||
    reference.byteLength > AGENT_RUNTIME_LIMITS.maxProtocolMessageBytes ||
    !/^[a-f0-9]{64}$/u.test(reference.sha256) ||
    !['INBOUND', 'OUTBOUND'].includes(reference.direction)
  ) {
    throw new Error('Protocol journal reference integrity metadata is invalid.');
  }
}
