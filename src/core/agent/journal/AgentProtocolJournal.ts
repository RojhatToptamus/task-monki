import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentProtocolMessageReference } from '../../../shared/agent';

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
    return path.join(this.journalDir, `${serverInstanceId}.ndjson`);
  }

  append(
    serverInstanceId: string,
    direction: AgentProtocolMessageReference['direction'],
    raw: string,
    metadata?: Record<string, unknown>
  ): Promise<AgentProtocolMessageReference> {
    const operation = (this.queues.get(serverInstanceId) ?? Promise.resolve()).then(() =>
      this.appendSerialized(serverInstanceId, direction, raw, metadata)
    );
    this.queues.set(serverInstanceId, operation.catch(() => undefined));
    return operation;
  }

  async read(
    reference: AgentProtocolMessageReference
  ): Promise<AgentProtocolJournalRecord> {
    const handle = await fs.open(this.pathFor(reference.serverInstanceId), 'r');
    try {
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
    await fs.mkdir(this.journalDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.journalDir, 0o700);

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
    const handle = await fs.open(filePath, 'a', 0o600);

    try {
      const stat = await handle.stat();
      await handle.write(line, null, 'utf8');
      await handle.sync();
      await fs.chmod(filePath, 0o600);
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
    try {
      const contents = await fs.readFile(filePath, 'utf8');
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
    }
  }
}
