import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createDiscourseLogEvent,
  encodeDiscourseLogEvent,
  FileDiscourseEventLog
} from './FileDiscourseEventLog';

describe('FileDiscourseEventLog format spike', () => {
  it('appends monotonic checksummed events with cursor pagination and exact idempotency', async () => {
    const directory = await temporaryDirectory();
    const log = new FileDiscourseEventLog(directory);
    const first = await log.append({
      kind: 'MESSAGE_APPENDED',
      operationId: 'operation-1',
      requestFingerprint: 'fingerprint-1',
      payload: { messageId: 'message-1' }
    });
    const replay = await log.append({
      kind: 'MESSAGE_APPENDED',
      operationId: 'operation-1',
      requestFingerprint: 'fingerprint-1',
      payload: { messageId: 'ignored-on-replay' }
    });
    await log.append({
      kind: 'MESSAGE_APPENDED',
      operationId: 'operation-2',
      requestFingerprint: 'fingerprint-2',
      payload: { messageId: 'message-2' }
    });

    expect(replay).toEqual(first);
    await expect(
      log.append({
        kind: 'MESSAGE_APPENDED',
        operationId: 'operation-1',
        requestFingerprint: 'changed',
        payload: { messageId: 'message-1' }
      })
    ).rejects.toThrow('REQUEST_CONFLICT');
    expect(await log.readPage({ limit: 1 })).toMatchObject({
      events: [{ sequence: 1, payload: { messageId: 'message-1' } }],
      nextCursor: 1
    });
    expect(await log.readPage({ afterSequence: 1, limit: 10 })).toMatchObject({
      events: [{ sequence: 2, payload: { messageId: 'message-2' } }]
    });
    expect(await log.readPageBefore({ beforeSequence: 3, limit: 1 })).toMatchObject({
      events: [{ sequence: 2, payload: { messageId: 'message-2' } }],
      previousCursor: 2
    });
    expect(await log.readPageBefore({ beforeSequence: 2, limit: 10 })).toMatchObject({
      events: [{ sequence: 1, payload: { messageId: 'message-1' } }]
    });
    expect(await log.latestSequence()).toBe(2);
  });

  it('rotates bounded segments without changing global sequence order', async () => {
    const directory = await temporaryDirectory();
    const log = new FileDiscourseEventLog(directory, {
      segmentMaxBytes: 1024,
      segmentMaxEvents: 2,
      eventMaxBytes: 512
    });
    for (let index = 0; index < 5; index += 1) {
      await log.append({
        kind: 'MESSAGE_APPENDED',
        operationId: `operation-${index}`,
        requestFingerprint: `fingerprint-${index}`,
        payload: { index }
      });
    }

    expect(
      (await fs.readdir(directory)).filter((file) => file.endsWith('.jsonl')).sort()
    ).toEqual(['events-000001.jsonl', 'events-000002.jsonl', 'events-000003.jsonl']);
    expect((await log.readPage({ limit: 10 })).events.map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 5
    ]);
  });

  it('recovers an fsynced append when the rebuildable index update is interrupted', async () => {
    const directory = await temporaryDirectory();
    let interrupt = true;
    const interrupted = new FileDiscourseEventLog(directory, {
      afterAppendBeforeIndex: () => {
        if (interrupt) {
          interrupt = false;
          throw new Error('injected index crash');
        }
      }
    });
    await expect(
      interrupted.append({
        kind: 'MESSAGE_APPENDED',
        operationId: 'operation-1',
        requestFingerprint: 'fingerprint-1',
        payload: { messageId: 'message-1' }
      })
    ).rejects.toThrow('injected index crash');

    const recovered = new FileDiscourseEventLog(directory);
    expect(await recovered.count()).toBe(1);
    await expect(
      recovered.append({
        kind: 'MESSAGE_APPENDED',
        operationId: 'operation-1',
        requestFingerprint: 'fingerprint-1',
        payload: { messageId: 'message-1' }
      })
    ).resolves.toMatchObject({ sequence: 1 });
    await expect(
      fs.readFile(path.join(directory, 'events-000001.index.json'), 'utf8')
    ).resolves.toContain(
      'operation-1'
    );
  });

  it('repairs a stale manifest after the segment index was durably published', async () => {
    const directory = await temporaryDirectory();
    let interrupt = true;
    const interrupted = new FileDiscourseEventLog(directory, {
      afterSegmentIndexBeforeManifest: () => {
        if (interrupt) {
          interrupt = false;
          throw new Error('injected manifest crash');
        }
      }
    });

    await expect(
      interrupted.append({
        kind: 'MESSAGE_APPENDED',
        operationId: 'operation-1',
        requestFingerprint: 'fingerprint-1',
        payload: { messageId: 'message-1' }
      })
    ).rejects.toThrow('injected manifest crash');

    const recovered = new FileDiscourseEventLog(directory);
    expect(await recovered.count()).toBe(1);
    await expect(fs.readFile(path.join(directory, 'manifest.json'), 'utf8')).resolves.toContain(
      '"eventCount":1'
    );
  });

  it('truncates only an unterminated newest tail and preserves earlier valid records', async () => {
    const directory = await temporaryDirectory();
    const log = new FileDiscourseEventLog(directory);
    await log.append({
      kind: 'MESSAGE_APPENDED',
      operationId: 'operation-1',
      requestFingerprint: 'fingerprint-1',
      payload: { messageId: 'message-1' }
    });
    const segmentPath = path.join(directory, 'events-000001.jsonl');
    await fs.appendFile(segmentPath, '{"partial":', 'utf8');

    const recovered = new FileDiscourseEventLog(directory);
    expect(await recovered.count()).toBe(1);
    expect((await fs.readFile(segmentPath, 'utf8')).endsWith('\n')).toBe(true);
  });

  it('refuses a newline-terminated checksum mismatch instead of discarding it', async () => {
    const directory = await temporaryDirectory();
    const log = new FileDiscourseEventLog(directory);
    await log.append({
      kind: 'MESSAGE_APPENDED',
      operationId: 'operation-1',
      requestFingerprint: 'fingerprint-1',
      payload: { body: 'original' }
    });
    const segmentPath = path.join(directory, 'events-000001.jsonl');
    const original = await fs.readFile(segmentPath, 'utf8');
    await fs.writeFile(segmentPath, original.replace('original', 'tampered'), 'utf8');

    await expect(new FileDiscourseEventLog(directory).count()).rejects.toThrow(
      'checksum mismatch'
    );
    await expect(fs.readFile(segmentPath, 'utf8')).resolves.toContain('tampered');
  });

  it('rebuilds corrupt segment indexes and manifests from authoritative segments', async () => {
    const directory = await temporaryDirectory();
    const log = new FileDiscourseEventLog(directory);
    await log.append({
      kind: 'CONVERSATION_CREATED',
      operationId: 'operation-1',
      requestFingerprint: 'fingerprint-1',
      payload: { conversationId: 'conversation-1' }
    });
    await fs.writeFile(path.join(directory, 'events-000001.index.json'), '{corrupt', 'utf8');
    await fs.writeFile(path.join(directory, 'manifest.json'), '{corrupt', 'utf8');

    const recovered = new FileDiscourseEventLog(directory);
    expect(await recovered.count()).toBe(1);
    await expect(fs.readFile(path.join(directory, 'manifest.json'), 'utf8')).resolves.toContain(
      '"schemaVersion":1'
    );
    await expect(
      fs.readFile(path.join(directory, 'events-000001.index.json'), 'utf8')
    ).resolves.toContain('operation-1');
  });

  it('inspects an attested tail without loading or repairing per-event indexes', async () => {
    const directory = await temporaryDirectory();
    const writer = new FileDiscourseEventLog(directory);
    await writer.append({
      kind: 'MESSAGE_APPENDED',
      operationId: 'operation-1',
      requestFingerprint: 'fingerprint-1',
      payload: { messageId: 'message-1' }
    });
    const indexPath = path.join(directory, 'events-000001.index.json');
    await fs.writeFile(indexPath, '{corrupt', 'utf8');

    const cold = new FileDiscourseEventLog(directory);
    await expect(cold.inspectDurableSummary()).resolves.toEqual({
      eventCount: 1,
      latestSequence: 1,
      segmentCount: 1
    });
    await expect(fs.readFile(indexPath, 'utf8')).resolves.toBe('{corrupt');

    await expect(cold.latestSequence()).resolves.toBe(1);
    await expect(fs.readFile(indexPath, 'utf8')).resolves.toContain('operation-1');
  });

  it('indexes and pages 10,000 events without rewriting prior segment indexes', async () => {
    const directory = await temporaryDirectory();
    const segmentLines: string[][] = [];
    for (let sequence = 1; sequence <= 10_000; sequence += 1) {
      const segment = Math.floor((sequence - 1) / 2_048);
      const lines = segmentLines[segment] ?? [];
      lines.push(
        encodeDiscourseLogEvent(
          createDiscourseLogEvent({
            formatVersion: 1,
            sequence,
            kind: 'MESSAGE_APPENDED',
            operationId: `operation-${sequence}`,
            requestFingerprint: `fingerprint-${sequence}`,
            payload: { messageId: `message-${sequence}`, body: 'bounded fixture' }
          })
        )
      );
      segmentLines[segment] = lines;
    }
    await Promise.all(
      segmentLines.map((lines, index) =>
        fs.writeFile(
          path.join(directory, `events-${String(index + 1).padStart(6, '0')}.jsonl`),
          lines.join(''),
          { mode: 0o600 }
        )
      )
    );

    const log = new FileDiscourseEventLog(directory);
    expect(await log.count()).toBe(10_000);
    const tail = await log.readPage({ afterSequence: 9_995, limit: 5 });
    expect(tail.events.map((event) => event.sequence)).toEqual([9_996, 9_997, 9_998, 9_999, 10_000]);
    expect(tail.nextCursor).toBeUndefined();
    const firstIndexPath = path.join(directory, 'events-000001.index.json');
    const firstIndexBefore = await fs.readFile(firstIndexPath, 'utf8');

    await log.append({
      kind: 'MESSAGE_APPENDED',
      operationId: 'operation-10001',
      requestFingerprint: 'fingerprint-10001',
      payload: { messageId: 'message-10001', body: 'bounded fixture' }
    });

    await expect(fs.readFile(firstIndexPath, 'utf8')).resolves.toBe(firstIndexBefore);
    const manifest = await fs.readFile(path.join(directory, 'manifest.json'), 'utf8');
    expect(Buffer.byteLength(manifest, 'utf8')).toBeLessThan(16 * 1024);
  });
});

async function temporaryDirectory(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-discourse-log-'));
}
