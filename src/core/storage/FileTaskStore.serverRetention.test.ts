import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addTestRepository } from '../../testSupport/repositoryFixture';
import type { AgentServerInstance, RunRecord, Task } from '../../shared/contracts';
import { createDomainEvent } from './domainEvent';
import { FileTaskStore } from './FileTaskStore';

describe('FileTaskStore agent server retention', () => {
  it('keeps the newest bounded diagnostics and removes older journals globally', async () => {
    const directory = await temporaryDirectory('bounded');
    const store = new FileTaskStore(directory, {
      maxUnreferencedTerminalAgentServers: 1
    });
    const active = await createServerWithJournal(store, 'active');
    await store.updateAgentServer(active.id, { status: 'READY' });
    const older = await createServerWithJournal(store, 'older');
    await store.updateAgentServer(older.id, {
      status: 'EXITED',
      exitedAt: '2026-07-12T10:00:00.000Z'
    });
    const newer = await createServerWithJournal(store, 'newer');
    await store.updateAgentServer(newer.id, {
      status: 'FAILED',
      exitedAt: '2026-07-12T11:00:00.000Z'
    });

    const snapshot = await store.snapshot();
    expect(new Set(snapshot.agentServers.map((server) => server.id))).toEqual(
      new Set([active.id, newer.id])
    );
    await expect(fs.access(older.protocolJournalPath)).rejects.toMatchObject({
      code: 'ENOENT'
    });
    await expect(fs.access(active.protocolJournalPath)).resolves.toBeUndefined();
    await expect(fs.access(newer.protocolJournalPath)).resolves.toBeUndefined();
    await store.close();
  });

  it('preserves terminal servers referenced by runs or nested durable event data', async () => {
    const directory = await temporaryDirectory('references');
    const store = new FileTaskStore(directory, {
      maxUnreferencedTerminalAgentServers: 0
    });
    const runServer = await createServerWithJournal(store, 'run');
    const { task } = await createRunForServer(store, directory, runServer);
    const eventServer = await createServerWithJournal(store, 'event');
    await store.appendEvent(
      createDomainEvent({
        type: 'AGENT_PROTOCOL_INCIDENT',
        taskId: task.id,
        source: 'provider',
        payload: { diagnostics: { owningServer: eventServer.id } }
      })
    );

    await store.updateAgentServer(runServer.id, {
      status: 'LOST',
      exitedAt: '2026-07-12T10:00:00.000Z'
    });
    await store.updateAgentServer(eventServer.id, {
      status: 'EXITED',
      exitedAt: '2026-07-12T11:00:00.000Z'
    });

    const snapshot = await store.snapshot();
    expect(new Set(snapshot.agentServers.map((server) => server.id))).toEqual(
      new Set([runServer.id, eventServer.id])
    );
    await expect(fs.access(runServer.protocolJournalPath)).resolves.toBeUndefined();
    await expect(fs.access(eventServer.protocolJournalPath)).resolves.toBeUndefined();
    await store.close();
  });

  it('removes safe orphan journal segments during restart reconciliation', async () => {
    const directory = await temporaryDirectory('orphan');
    const initial = new FileTaskStore(directory);
    await initial.init();
    await initial.close();
    const journalDirectory = path.join(directory, 'protocol-journals');
    const orphanPath = path.join(journalDirectory, 'orphan-server.2.ndjson');
    const unrelatedPath = path.join(journalDirectory, 'operator-notes.txt');
    await fs.writeFile(orphanPath, '{"orphan":true}\n', { mode: 0o600 });
    await fs.writeFile(unrelatedPath, 'preserve\n', { mode: 0o600 });

    const restarted = new FileTaskStore(directory);
    await restarted.init();

    await expect(fs.access(orphanPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(unrelatedPath, 'utf8')).resolves.toBe('preserve\n');
    await restarted.close();
  });

  it('collects a deleted task server only after its durable references are removed', async () => {
    const directory = await temporaryDirectory('delete');
    const store = new FileTaskStore(directory, {
      maxUnreferencedTerminalAgentServers: 0
    });
    const server = await createServerWithJournal(store, 'deleted-task');
    const { task } = await createRunForServer(store, directory, server);
    await store.updateAgentServer(server.id, {
      status: 'EXITED',
      exitedAt: '2026-07-12T12:00:00.000Z'
    });
    expect(await store.getAgentServer(server.id)).toBeDefined();

    await store.deleteTask(task.id);

    expect(await store.getAgentServer(server.id)).toBeUndefined();
    await expect(fs.access(server.protocolJournalPath)).rejects.toMatchObject({
      code: 'ENOENT'
    });
    await store.close();
  });
});

async function createServerWithJournal(
  store: FileTaskStore,
  label: string
): Promise<AgentServerInstance> {
  const server = await store.createAgentServer({
    runtimeId: 'codex',
    runtimeKind: 'APP_SERVER',
    transport: 'STDIO',
    executable: `codex-${label}`,
    argv: ['app-server', '--stdio']
  });
  await store.appendProtocolMessage(server.id, 'INBOUND', JSON.stringify({ label }));
  return server;
}

async function createRunForServer(
  store: FileTaskStore,
  directory: string,
  server: AgentServerInstance
): Promise<{ task: Task; run: RunRecord }> {
  const task = await store.createTask({
    title: `Task for ${server.id}`,
    prompt: 'Preserve this server reference.',
    repositoryId: (await addTestRepository(store, directory)).id
  });
  const { iteration, worktree } = await store.createIterationAndWorktree({
    task,
    branchName: `task-monki/${task.id}`,
    worktreePath: path.join(directory, `worktree-${task.id}`),
    baseSha: 'base'
  });
  const session = await store.createAgentSession({
    task,
    iteration,
    worktree,
    runtimeId: 'codex'
  });
  const run = await store.createRun({
    task,
    session,
    serverInstanceId: server.id,
    mode: 'IMPLEMENTATION',
    prompt: task.prompt
  });
  return { task, run };
}

async function temporaryDirectory(label: string): Promise<string> {
  return fs.mkdtemp(
    path.join(os.tmpdir(), `task-monki-server-retention-${label}-`)
  );
}
