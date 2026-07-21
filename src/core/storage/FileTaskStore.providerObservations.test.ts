import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileTaskStore } from './FileTaskStore';
import { addTestRepository } from '../../testSupport/repositoryFixture';

describe('FileTaskStore provider observations', () => {
  it('structurally redacts provider credentials before journal persistence', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-redacted-journal-'));
    const store = new FileTaskStore(dir);
    const server = await store.createAgentServer({
      runtimeId: 'grok',
      runtimeKind: 'ACP_AGENT',
      transport: 'STDIO',
      executable: 'grok',
      argv: ['agent', 'stdio']
    });
    const secrets = {
      env: 'grok-env-secret',
      header: 'grok-header-secret',
      password: 'grok-url-password',
      metadata: 'grok-metadata-secret'
    };
    const reference = await store.appendProtocolMessage(
      server.id,
      'INBOUND',
      JSON.stringify({
        jsonrpc: '2.0',
        method: '_x.ai/mcp/servers_updated',
        params: {
          servers: [
            {
              name: 'github',
              env: [
                {
                  name: 'GITHUB_PERSONAL_ACCESS_TOKEN',
                  value: secrets.env
                },
                { name: 'LOG_LEVEL', value: 'debug' }
              ],
              headers: [
                {
                  key: 'Authorization',
                  value: `Bearer ${secrets.header}`
                }
              ],
              endpoint: `https://mcp-user:${secrets.password}@example.test/rpc`
            }
          ],
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
        }
      }),
      {
        authorization: `Basic ${secrets.metadata}`,
        tokenCount: 15
      }
    );

    const persisted = await store.readProtocolMessage(reference);
    const raw = JSON.parse(persisted.raw) as {
      params: {
        servers: Array<{
          env: Array<{ name: string; value: string }>;
          headers: Array<{ key: string; value: string }>;
          endpoint: string;
        }>;
        usage: { totalTokens: number };
      };
    };
    expect(raw.params.servers[0]?.env).toEqual([
      { name: 'GITHUB_PERSONAL_ACCESS_TOKEN', value: '[REDACTED]' },
      { name: 'LOG_LEVEL', value: 'debug' }
    ]);
    expect(raw.params.servers[0]?.headers[0]?.value).toBe('[REDACTED]');
    expect(raw.params.servers[0]?.endpoint).toBe(
      'https://[REDACTED]@example.test/rpc'
    );
    expect(raw.params.usage.totalTokens).toBe(15);
    expect(persisted.metadata).toEqual({
      authorization: '[REDACTED]',
      tokenCount: 15
    });

    await store.close();
    const journalBytes = await fs.readFile(server.protocolJournalPath, 'utf8');
    for (const secret of Object.values(secrets)) {
      expect(journalBytes).not.toContain(secret);
    }
    expect(journalBytes).toContain('GITHUB_PERSONAL_ACCESS_TOKEN');
    expect(journalBytes).toContain('[REDACTED]');
  });

  it('persists immutable provider observations and validates raw journal reads', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-provider-observations-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({
      title: 'Provider observations',
      prompt: 'Keep Task Monki authoritative.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/provider-observations',
      worktreePath: dir,
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
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });
    const server = await store.createAgentServer({
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio']
    });
    const raw = JSON.stringify({
      method: 'turn/plan/updated',
      params: { threadId: 'thread-1', turnId: 'turn-1' }
    });
    const reference = await store.appendProtocolMessage(
      server.id,
      'INBOUND',
      raw,
      { method: 'turn/plan/updated' }
    );

    await store.recordAgentPlanRevision({
      taskId: task.id,
      iterationId: iteration.id,
      runId: run.id,
      sessionId: session.id,
      runtimeId: 'codex',
      explanation: 'First plan',
      steps: [{ step: 'Inspect', status: 'IN_PROGRESS' }],
      rawMessage: reference
    });
    await store.recordAgentPlanRevision({
      taskId: task.id,
      iterationId: iteration.id,
      runId: run.id,
      sessionId: session.id,
      runtimeId: 'codex',
      explanation: 'Revised plan',
      steps: [{ step: 'Inspect', status: 'COMPLETED' }],
      rawMessage: reference
    });
    await store.recordAgentUsageSnapshot({
      taskId: task.id,
      iterationId: iteration.id,
      sessionId: session.id,
      runId: run.id,
      runtimeId: 'codex',
      total: usage(100),
      last: usage(40),
      modelContextWindow: 200_000,
      rawMessage: reference
    });
    await store.recordAgentSettingsObservation({
      taskId: task.id,
      iterationId: iteration.id,
      sessionId: session.id,
      runId: run.id,
      runtimeId: 'codex',
      source: 'MODEL_REROUTED_NOTIFICATION',
      settings: { model: 'gpt-observed' },
      rawMessage: reference
    });

    const snapshot = await store.snapshot();
    expect(snapshot.agentPlanRevisions.map((plan) => plan.revision).sort()).toEqual([
      1,
      2
    ]);
    expect(snapshot.agentUsageSnapshots[0]?.total.totalTokens).toBe(100);
    expect(snapshot.agentSettingsObservations[0]?.settings.model).toBe(
      'gpt-observed'
    );
    await expect(store.readProtocolMessage(reference)).resolves.toEqual({
      raw,
      metadata: { method: 'turn/plan/updated' }
    });

    await expect(
      store.readProtocolMessage({ ...reference, sha256: '0'.repeat(64) })
    ).rejects.toThrow('integrity');
  });
});

function usage(totalTokens: number) {
  return {
    totalTokens,
    inputTokens: totalTokens,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0
  };
}
