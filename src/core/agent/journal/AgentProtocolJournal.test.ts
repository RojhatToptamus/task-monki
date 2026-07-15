import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentProtocolMessageReference } from '../../../shared/agent';
import {
  AgentProtocolJournal,
  type AgentProtocolJournalOptions
} from './AgentProtocolJournal';

describe('AgentProtocolJournal', () => {
  it('rotates per-server segments and keeps references readable', async () => {
    const directory = await temporaryDirectory();
    const journal = new AgentProtocolJournal(directory, tinyLimits({ maxTotalBytes: 4_000 }));
    const references = [] as AgentProtocolMessageReference[];

    for (let index = 0; index < 4; index += 1) {
      references.push(
        await journal.append('server-rotation', 'INBOUND', `${index}:${'x'.repeat(240)}`)
      );
    }

    expect(references.map((reference) => reference.segment ?? 0)).toEqual([0, 1, 2, 3]);
    await expect(journal.read(references[0]!)).resolves.toMatchObject({
      raw: `0:${'x'.repeat(240)}`
    });
    await expect(journal.read(references[3]!)).resolves.toMatchObject({
      raw: `3:${'x'.repeat(240)}`
    });
    await expect(fs.access(journal.pathFor('server-rotation', 3))).resolves.toBeUndefined();
    await journal.close();
  });

  it('prunes only complete old segments and fails closed for a pruned reference', async () => {
    const directory = await temporaryDirectory();
    const limits = tinyLimits({ maxTotalBytes: 1_100 });
    const journal = new AgentProtocolJournal(directory, limits);
    const references = [] as AgentProtocolMessageReference[];

    for (let index = 0; index < 6; index += 1) {
      references.push(
        await journal.append('server-retention', 'INBOUND', `${index}:${'r'.repeat(240)}`)
      );
    }

    await expect(journal.read(references[0]!)).rejects.toThrow('pruned');
    await expect(journal.read(references.at(-1)!)).resolves.toMatchObject({
      raw: `5:${'r'.repeat(240)}`
    });
    const retainedBytes = await segmentBytes(directory, 'server-retention');
    expect(retainedBytes).toBeLessThanOrEqual(limits.maxTotalBytes!);
    expect(await fs.readdir(directory)).not.toContain('server-retention.ndjson');
    await journal.close();
  });

  it('continues a global sequence across segment rotation and restart', async () => {
    const directory = await temporaryDirectory();
    const limits = tinyLimits({ maxTotalBytes: 4_000 });
    const first = new AgentProtocolJournal(directory, limits);
    const prior = [] as AgentProtocolMessageReference[];
    for (let index = 0; index < 3; index += 1) {
      prior.push(
        await first.append('server-restart', 'INBOUND', `${index}:${'s'.repeat(240)}`)
      );
    }
    await first.close();

    const restarted = new AgentProtocolJournal(directory, limits);
    const next = await restarted.append(
      'server-restart',
      'OUTBOUND',
      `after:${'s'.repeat(240)}`
    );

    expect(next.sequence).toBe(prior.at(-1)!.sequence + 1);
    expect(next.segment).toBe((prior.at(-1)!.segment ?? 0) + 1);
    await expect(restarted.read(next)).resolves.toMatchObject({
      raw: `after:${'s'.repeat(240)}`
    });
    await restarted.close();
  });

  it('repairs only a crash-truncated tail before continuing', async () => {
    const directory = await temporaryDirectory();
    const limits = tinyLimits({
      maxSegmentBytes: 4_096,
      maxTotalBytes: 8_192,
      maxUnsyncedBytes: 4_096
    });
    const first = new AgentProtocolJournal(directory, limits);
    const complete = await first.append('server-tail', 'OUTBOUND', 'complete');
    await first.close();
    await fs.appendFile(first.pathFor('server-tail'), '{"partial":', 'utf8');

    const restarted = new AgentProtocolJournal(directory, limits);
    const next = await restarted.append('server-tail', 'OUTBOUND', 'continued');
    expect(next.sequence).toBe(complete.sequence + 1);
    await expect(restarted.read(complete)).resolves.toEqual({ raw: 'complete' });
    await expect(restarted.read(next)).resolves.toEqual({ raw: 'continued' });
    const lines = (await fs.readFile(restarted.pathFor('server-tail'), 'utf8'))
      .trim()
      .split('\n');
    expect(lines).toHaveLength(2);
    await restarted.close();
  });

  it('serializes concurrent appends in invocation order without duplicate sequences', async () => {
    const directory = await temporaryDirectory();
    const journal = new AgentProtocolJournal(
      directory,
      tinyLimits({
        maxSegmentBytes: 4_096,
        maxTotalBytes: 64 * 1024,
        maxUnsyncedBytes: 4_096
      })
    );
    const references = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        journal.append('server-concurrent', 'INBOUND', `message-${index}`)
      )
    );

    expect(references.map((reference) => reference.sequence)).toEqual(
      Array.from({ length: 40 }, (_, index) => index + 1)
    );
    const rows = await Promise.all(references.map((reference) => journal.read(reference)));
    expect(rows.map((row) => row.raw)).toEqual(
      Array.from({ length: 40 }, (_, index) => `message-${index}`)
    );
    await journal.close();
  });

  it('flushes dirty input on close and rejects later appends', async () => {
    const directory = await temporaryDirectory();
    const limits = tinyLimits({
      maxSegmentBytes: 4_096,
      maxTotalBytes: 8_192,
      maxUnsyncedBytes: 4_096,
      syncIntervalMs: 60_000,
      idleHandleTimeoutMs: 60_000
    });
    const originalOpen = fs.open.bind(fs);
    let syncCount = 0;
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith('server-close.ndjson')) {
        const originalSync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          syncCount += 1;
          await originalSync();
        });
      }
      return handle;
    });
    const journal = new AgentProtocolJournal(directory, limits);
    let first: AgentProtocolMessageReference;
    try {
      first = await journal.append('server-close', 'INBOUND', 'flush one');
      await journal.append('server-close', 'INBOUND', 'flush two');
      await journal.append('server-close', 'INBOUND', 'flush three');
      expect(syncCount).toBe(0);
      await journal.close();
      expect(syncCount).toBe(1);
      await expect(
        journal.append('server-close', 'INBOUND', 'too late')
      ).rejects.toThrow('closed');
    } finally {
      open.mockRestore();
    }

    const restarted = new AgentProtocolJournal(directory, limits);
    await expect(restarted.read(first!)).resolves.toEqual({ raw: 'flush one' });
    const second = await restarted.append('server-close', 'INBOUND', 'after restart');
    expect(second.sequence).toBe(4);
    await restarted.close();
  });

  it('reads legacy segment-zero references and continues their sequence', async () => {
    const directory = await temporaryDirectory();
    const serverInstanceId = 'server-legacy';
    const recordedAt = '2026-07-12T12:00:00.000Z';
    const raw = '{"legacy":true}';
    const line = `${JSON.stringify({
      serverInstanceId,
      sequence: 42,
      direction: 'INBOUND',
      recordedAt,
      raw,
      metadata: { legacy: true }
    })}\n`;
    const filePath = path.join(directory, `${serverInstanceId}.ndjson`);
    await fs.writeFile(filePath, line, { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(filePath, 0o600);
    const reference: AgentProtocolMessageReference = {
      serverInstanceId,
      sequence: 42,
      direction: 'INBOUND',
      recordedAt,
      byteOffset: 0,
      byteLength: Buffer.byteLength(line),
      sha256: createHash('sha256').update(raw).digest('hex')
    };
    const journal = new AgentProtocolJournal(directory, tinyLimits({ maxTotalBytes: 4_000 }));

    await expect(journal.read(reference)).resolves.toEqual({
      raw,
      metadata: { legacy: true }
    });
    const next = await journal.append(serverInstanceId, 'OUTBOUND', 'new format');
    expect(next).toMatchObject({ sequence: 43 });
    expect(next.segment).toBeUndefined();
    await journal.close();
  });

  it('bounds serialized entries without consuming a sequence', async () => {
    const directory = await temporaryDirectory();
    const journal = new AgentProtocolJournal(directory, tinyLimits());

    await expect(
      journal.append('server-bounds', 'INBOUND', 'x'.repeat(2_000))
    ).rejects.toThrow('entry exceeds');
    const accepted = await journal.append('server-bounds', 'INBOUND', 'small');
    expect(accepted.sequence).toBe(1);
    await journal.close();
  });

  it('applies the entry bound before redaction can shrink provider input', async () => {
    const directory = await temporaryDirectory();
    const journal = new AgentProtocolJournal(directory, tinyLimits());

    await expect(
      journal.append(
        'server-redaction-bounds',
        'INBOUND',
        JSON.stringify({ apiKey: 'x'.repeat(2_000) })
      )
    ).rejects.toThrow('entry exceeds');
    const accepted = await journal.append(
      'server-redaction-bounds',
      'INBOUND',
      'small'
    );
    expect(accepted.sequence).toBe(1);
    await journal.close();
  });

  it('rejects path traversal and does not follow a journal symlink', async () => {
    const directory = await temporaryDirectory();
    const journal = new AgentProtocolJournal(directory, tinyLimits());
    expect(() => journal.pathFor('../outside')).toThrow('id is invalid');

    if (process.platform !== 'win32') {
      const outside = path.join(await temporaryDirectory(), 'outside.ndjson');
      await fs.writeFile(outside, 'preserve', 'utf8');
      await fs.symlink(outside, path.join(directory, 'server-symlink.ndjson'));
      await expect(
        journal.append('server-symlink', 'INBOUND', 'unsafe')
      ).rejects.toThrow();
      await expect(fs.readFile(outside, 'utf8')).resolves.toBe('preserve');
    }
    await journal.close();
  });

  it('serializes whole-server removal behind queued appends', async () => {
    const directory = await temporaryDirectory();
    const journal = new AgentProtocolJournal(directory, tinyLimits());
    const append = journal.append('server-remove', 'INBOUND', 'queued');
    const removal = journal.removeServer('server-remove');

    await expect(append).resolves.toMatchObject({ sequence: 1 });
    await expect(removal).resolves.toBeUndefined();
    await expect(fs.access(journal.pathFor('server-remove'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    await journal.close();
  });

  it.runIf(process.platform !== 'win32')(
    'refuses to collect symlinked, hard-linked, or non-private managed segments',
    async () => {
      const cases = ['symlink', 'hardlink', 'mode'] as const;
      for (const kind of cases) {
        const directory = await temporaryDirectory();
        const outside = path.join(await temporaryDirectory(), `${kind}.ndjson`);
        await fs.writeFile(outside, 'preserve\n', { mode: 0o600 });
        const managed = path.join(directory, `orphan-${kind}.ndjson`);
        if (kind === 'symlink') {
          await fs.symlink(outside, managed);
        } else if (kind === 'hardlink') {
          await fs.link(outside, managed);
        } else {
          await fs.writeFile(managed, 'private-required\n', { mode: 0o644 });
          await fs.chmod(managed, 0o644);
        }
        const journal = new AgentProtocolJournal(directory, tinyLimits());

        await expect(journal.reconcileServers([])).rejects.toThrow('integrity');
        await expect(fs.readFile(outside, 'utf8')).resolves.toBe('preserve\n');
        await expect(fs.access(managed)).resolves.toBeUndefined();
        await journal.close();
      }
    }
  );

  it.runIf(process.platform !== 'win32')(
    'keeps its directory and segments private',
    async () => {
      const directory = await temporaryDirectory();
      await fs.chmod(directory, 0o755);
      const journal = new AgentProtocolJournal(directory, tinyLimits());
      await journal.append('server-modes', 'OUTBOUND', 'private');

      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(journal.pathFor('server-modes'))).mode & 0o777).toBe(0o600);
      await journal.close();
    }
  );
});

function tinyLimits(
  overrides: AgentProtocolJournalOptions = {}
): AgentProtocolJournalOptions {
  return {
    maxEntryBytes: 512,
    maxSegmentBytes: 600,
    maxTotalBytes: 1_200,
    maxUnsyncedBytes: 600,
    syncIntervalMs: 60_000,
    idleHandleTimeoutMs: 60_000,
    ...overrides
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'task-monki-protocol-journal-')
  );
  await fs.chmod(directory, 0o700);
  return directory;
}

async function segmentBytes(directory: string, serverInstanceId: string): Promise<number> {
  let total = 0;
  for (const fileName of await fs.readdir(directory)) {
    if (!fileName.startsWith(`${serverInstanceId}.`) || !fileName.endsWith('.ndjson')) {
      continue;
    }
    total += (await fs.stat(path.join(directory, fileName))).size;
  }
  return total;
}
