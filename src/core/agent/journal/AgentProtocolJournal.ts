import { createHash } from 'node:crypto';
import path from 'node:path';
import type { AgentProtocolMessageReference } from '../../../shared/agent';
import {
  appendPrivateFile,
  ensurePrivateDirectory,
  readPrivateFileRange,
  readPrivateFileTail
} from '../../filesystem/secureFilesystem';

const MAX_PROTOCOL_JOURNAL_ENTRY_BYTES = 10 * 1024 * 1024;
const SERVER_INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

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
    assertServerInstanceId(serverInstanceId);
    return path.join(this.journalDir, `${serverInstanceId}.ndjson`);
  }

  async append(
    serverInstanceId: string,
    direction: AgentProtocolMessageReference['direction'],
    raw: string,
    metadata?: Record<string, unknown>
  ): Promise<AgentProtocolMessageReference> {
    assertServerInstanceId(serverInstanceId);
    const operation = (this.queues.get(serverInstanceId) ?? Promise.resolve()).then(() =>
      this.appendSerialized(serverInstanceId, direction, raw, metadata)
    );
    this.queues.set(serverInstanceId, operation.catch(() => undefined));
    return operation;
  }

  async read(
    reference: AgentProtocolMessageReference
  ): Promise<AgentProtocolJournalRecord> {
    assertProtocolReference(reference);
    const buffer = await readPrivateFileRange(
      this.pathFor(reference.serverInstanceId),
      reference.byteOffset,
      reference.byteLength,
      MAX_PROTOCOL_JOURNAL_ENTRY_BYTES
    );
    const entry = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(buffer).trim()
    ) as JournalEntry;
    if (
      entry.serverInstanceId !== reference.serverInstanceId ||
      entry.sequence !== reference.sequence ||
      entry.direction !== reference.direction ||
      createHash('sha256').update(entry.raw).digest('hex') !== reference.sha256
    ) {
      throw new Error('Protocol journal reference failed integrity validation.');
    }
    return { raw: entry.raw, metadata: entry.metadata };
  }

  private async appendSerialized(
    serverInstanceId: string,
    direction: AgentProtocolMessageReference['direction'],
    raw: string,
    metadata?: Record<string, unknown>
  ): Promise<AgentProtocolMessageReference> {
    await ensurePrivateDirectory(this.journalDir);

    const filePath = this.pathFor(serverInstanceId);
    const previousSequence = this.sequences.has(serverInstanceId)
      ? this.sequences.get(serverInstanceId) ?? 0
      : await this.readLastSequence(filePath, serverInstanceId);
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
    if (byteLength > MAX_PROTOCOL_JOURNAL_ENTRY_BYTES) {
      throw new Error('Protocol journal entry exceeds its size limit.');
    }
    const byteOffset = await appendPrivateFile(filePath, line);
    this.sequences.set(serverInstanceId, sequence);
    return {
      serverInstanceId,
      sequence,
      direction,
      recordedAt,
      byteOffset,
      byteLength,
      sha256: createHash('sha256').update(raw).digest('hex')
    };
  }

  private async readLastSequence(
    filePath: string,
    serverInstanceId: string
  ): Promise<number> {
    try {
      const tail = await readPrivateFileTail(
        filePath,
        MAX_PROTOCOL_JOURNAL_ENTRY_BYTES
      );
      let lineEnd = tail.byteLength;
      while (
        lineEnd > 0 &&
        (tail[lineEnd - 1] === 0x0a || tail[lineEnd - 1] === 0x0d)
      ) {
        lineEnd -= 1;
      }
      if (lineEnd === 0) {
        return 0;
      }
      const previousLineBreak = tail.lastIndexOf(0x0a, lineEnd - 1);
      const lastLine = new TextDecoder('utf-8', { fatal: true }).decode(
        tail.subarray(previousLineBreak + 1, lineEnd)
      );
      const parsed = JSON.parse(lastLine) as Partial<JournalEntry>;
      if (
        parsed.serverInstanceId !== serverInstanceId ||
        !Number.isSafeInteger(parsed.sequence) ||
        (parsed.sequence ?? 0) <= 0
      ) {
        throw new Error('Protocol journal tail failed its integrity check.');
      }
      return parsed.sequence!;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return 0;
      }
      throw error;
    }
  }
}

function assertServerInstanceId(serverInstanceId: string): void {
  if (
    !SERVER_INSTANCE_ID_PATTERN.test(serverInstanceId) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(serverInstanceId)
  ) {
    throw new Error('Protocol journal server instance identifier is invalid.');
  }
}

function assertProtocolReference(reference: AgentProtocolMessageReference): void {
  assertServerInstanceId(reference.serverInstanceId);
  if (
    !Number.isSafeInteger(reference.sequence) ||
    reference.sequence <= 0 ||
    !Number.isSafeInteger(reference.byteOffset) ||
    reference.byteOffset < 0 ||
    !Number.isSafeInteger(reference.byteLength) ||
    reference.byteLength <= 0 ||
    reference.byteLength > MAX_PROTOCOL_JOURNAL_ENTRY_BYTES ||
    !/^[a-f0-9]{64}$/.test(reference.sha256)
  ) {
    throw new Error('Protocol journal reference is invalid.');
  }
}
