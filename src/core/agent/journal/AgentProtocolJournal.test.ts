import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentProtocolJournal } from './AgentProtocolJournal';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

describe('AgentProtocolJournal', () => {
  it('persists private journal entries and validates descriptor-backed reads', async () => {
    const root = await temporaryDirectory();
    const journalDirectory = path.join(root, 'journals');
    const journal = new AgentProtocolJournal(journalDirectory);

    const first = await journal.append('server-1', 'OUTBOUND', '{"id":1}', {
      method: 'thread/start'
    });
    const secondJournal = new AgentProtocolJournal(journalDirectory);
    const second = await secondJournal.append('server-1', 'INBOUND', '{"id":1}');

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    await expect(secondJournal.read(first)).resolves.toEqual({
      raw: '{"id":1}',
      metadata: { method: 'thread/start' }
    });
    if (process.platform !== 'win32') {
      expect((await fs.stat(journal.pathFor('server-1'))).mode & 0o777).toBe(0o600);
      expect((await fs.stat(journalDirectory)).mode & 0o777).toBe(0o700);
    }
  });

  it('rejects path traversal in server instance identifiers', async () => {
    const root = await temporaryDirectory();
    const journal = new AgentProtocolJournal(path.join(root, 'journals'));

    expect(() => journal.pathFor('../outside')).toThrow(
      'Protocol journal server instance identifier is invalid.'
    );
    expect(() => journal.pathFor('NUL')).toThrow(
      'Protocol journal server instance identifier is invalid.'
    );
    await expect(
      journal.append('../outside', 'OUTBOUND', '{}')
    ).rejects.toThrow('Protocol journal server instance identifier is invalid.');
  });

  it.runIf(process.platform !== 'win32')(
    'rejects a symlinked journal file without modifying its target',
    async () => {
      const root = await temporaryDirectory();
      const journalDirectory = path.join(root, 'journals');
      await fs.mkdir(journalDirectory, { mode: 0o700 });
      const outsidePath = path.join(root, 'outside.ndjson');
      await fs.writeFile(outsidePath, 'outside\n', { mode: 0o600 });
      await fs.symlink(outsidePath, path.join(journalDirectory, 'server-1.ndjson'));
      const journal = new AgentProtocolJournal(journalDirectory);

      await expect(journal.append('server-1', 'OUTBOUND', '{}')).rejects.toBeTruthy();
      await expect(fs.readFile(outsidePath, 'utf8')).resolves.toBe('outside\n');
    }
  );

  it.runIf(process.platform !== 'win32')(
    'rejects a symlinked journal directory without writing through it',
    async () => {
      const root = await temporaryDirectory();
      const outsideDirectory = path.join(root, 'outside');
      const journalDirectory = path.join(root, 'journals');
      await fs.mkdir(outsideDirectory, { mode: 0o700 });
      await fs.symlink(outsideDirectory, journalDirectory);
      const journal = new AgentProtocolJournal(journalDirectory);

      await expect(journal.append('server-1', 'OUTBOUND', '{}')).rejects.toBeTruthy();
      await expect(fs.readdir(outsideDirectory)).resolves.toEqual([]);
    }
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'task-monki-protocol-journal-')
  );
  temporaryDirectories.push(directory);
  return directory;
}
