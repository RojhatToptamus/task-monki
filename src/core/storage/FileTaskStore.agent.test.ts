import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileTaskStore } from './FileTaskStore';
import { addTestRepository } from '../../testSupport/repositoryFixture';

describe('FileTaskStore agent persistence', () => {
  it('persists provider-neutral server, session, turn, item, and interaction records', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-agent-store-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({
      title: 'Agent persistence',
      prompt: 'Inspect the repository.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/agent-persistence',
      worktreePath: dir,
      baseSha: 'base'
    });
    const session = await store.createAgentSession({
      task,
      iteration,
      worktree,
      provider: 'codex',
      requestedSettings: { model: 'model-a', reasoningEffort: 'high' }
    });
    const server = await store.createAgentServer({
      provider: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio'],
      runtimeVersion: '0.141.0',
      schemaHash: 'schema-hash',
      runtimeResolution: {
        selectedExecutable: '/Applications/Codex.app/Contents/Resources/codex',
        selectedSource: 'codex-app-bundle',
        selectedVersion: '0.142.4',
        selectedLaunchArgv: ['app-server', '--stdio'],
        requiredCapabilities: ['thread/start', 'turn/start'],
        probes: [
          {
            executable: '/opt/homebrew/bin/codex',
            source: 'path',
            explicit: false,
            compatible: false,
            version: '0.22.0',
            detail: 'Codex App Server command or stdio transport was not detected.'
          },
          {
            executable: '/Applications/Codex.app/Contents/Resources/codex',
            source: 'codex-app-bundle',
            explicit: false,
            compatible: true,
            version: '0.142.4',
            launchArgv: ['app-server', '--stdio'],
            launchForm: 'stdio-flag',
            detail: 'Compatible Codex App Server via stdio-flag.'
          }
        ]
      }
    });
    const run = await store.createRun({
      task,
      session,
      serverInstanceId: server.id,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      requestedSettings: session.requestedSettings
    });
    const storeBeforeOutput = await fs.readFile(path.join(dir, 'store.json'), 'utf8');
    await store.appendArtifact(run.outputArtifactId, 'streamed output\n');
    expect(await fs.readFile(path.join(dir, 'store.json'), 'utf8')).toBe(storeBeforeOutput);
    const rawRequest = await store.appendProtocolMessage(
      server.id,
      'INBOUND',
      '{"method":"item/commandExecution/requestApproval","id":7}',
      { method: 'item/commandExecution/requestApproval' }
    );
    const item = await store.upsertAgentItem({
      taskId: task.id,
      iterationId: iteration.id,
      runId: run.id,
      sessionId: session.id,
      providerItemId: 'item-1',
      type: 'COMMAND_EXECUTION',
      status: 'IN_PROGRESS',
      payload: { command: 'npm test' },
      rawMessage: rawRequest
    });
    await store.upsertAgentItem({
      ...item,
      status: 'COMPLETED',
      payload: { command: 'npm test', exitCode: 0 }
    });
    await expect(
      store.upsertAgentItem({
        ...item,
        status: 'IN_PROGRESS',
        payload: { command: 'npm test' }
      })
    ).rejects.toThrow('Invalid agent item transition');
    const interaction = await store.createInteractionRequest({
      serverInstanceId: server.id,
      providerRequestId: 7,
      taskId: task.id,
      iterationId: iteration.id,
      runId: run.id,
      sessionId: session.id,
      providerItemId: item.providerItemId,
      type: 'COMMAND_APPROVAL',
      request: { command: 'npm test', startedAtMs: Date.now() },
      allowedActions: ['ACCEPT', 'DECLINE', 'CANCEL'],
      policyWarnings: [],
      requestRawMessage: rawRequest
    });

    await store.transitionInteractionRequest(interaction.id, 'PENDING', {
      status: 'RESPONDING',
      decision: {
        interactionType: 'COMMAND_APPROVAL',
        action: 'ACCEPT'
      },
      respondedAt: new Date().toISOString()
    });
    await expect(
      store.transitionInteractionRequest(interaction.id, 'PENDING', {
        status: 'RESPONDING'
      })
    ).rejects.toThrow('expected PENDING');
    await store.transitionInteractionRequest(interaction.id, 'RESPONDING', {
      status: 'RESOLVED',
      resolution: { accepted: true },
      resolvedAt: new Date().toISOString()
    });

    const reloaded = await new FileTaskStore(dir).snapshot();
    expect(reloaded.agentServers).toHaveLength(1);
    expect(reloaded.agentServers[0]?.runtimeResolution).toMatchObject({
      selectedExecutable: '/Applications/Codex.app/Contents/Resources/codex',
      selectedVersion: '0.142.4',
      probes: [
        {
          executable: '/opt/homebrew/bin/codex',
          compatible: false,
          version: '0.22.0'
        },
        {
          executable: '/Applications/Codex.app/Contents/Resources/codex',
          compatible: true,
          launchForm: 'stdio-flag'
        }
      ]
    });
    expect(reloaded.agentSessions).toHaveLength(1);
    expect(reloaded.agentItems).toHaveLength(1);
    expect(reloaded.interactionRequests[0]?.status).toBe('RESOLVED');
    expect(reloaded.runs[0]?.sessionId).toBe(session.id);
    expect(reloaded.runs[0]?.promptArtifactId).toBeTruthy();
  });

  it('keeps protocol traffic out of the monolithic store and continues journal sequences', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-agent-journal-'));
    const store = new FileTaskStore(dir);
    const server = await store.createAgentServer({
      provider: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio']
    });
    const storePath = path.join(dir, 'store.json');
    const before = await fs.readFile(storePath, 'utf8');

    const first = await store.appendProtocolMessage(server.id, 'INBOUND', '{"id":1}');
    const secondStore = new FileTaskStore(dir);
    await secondStore.init();
    const second = await secondStore.appendProtocolMessage(server.id, 'OUTBOUND', '{"id":2}');

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(await fs.readFile(storePath, 'utf8')).toBe(before);

    const journal = await fs.readFile(server.protocolJournalPath, 'utf8');
    expect(journal.trim().split('\n')).toHaveLength(2);
    if (process.platform !== 'win32') {
      expect((await fs.stat(server.protocolJournalPath)).mode & 0o777).toBe(0o600);
    }
  });

  it('rejects old store formats instead of maintaining compatibility code', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-old-store-'));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'store.json'), JSON.stringify({ tasks: [] }), {
      encoding: 'utf8',
      mode: 0o600
    });

    await expect(new FileTaskStore(dir).init()).rejects.toThrow(
      'migrations are intentionally not supported'
    );
  });
});
