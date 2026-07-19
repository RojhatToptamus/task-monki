import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileTaskStore } from './FileTaskStore';
import { addTestRepository } from '../../testSupport/repositoryFixture';

describe('FileTaskStore Phase 5 provider observations', () => {
  it('persists immutable provider observations and validates raw journal reads', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-phase5-store-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({
      title: 'Provider observations',
      prompt: 'Keep Task Monki authoritative.',
      repositoryId: (await addTestRepository(store, dir)).id
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/phase5-store',
      worktreePath: dir,
      baseSha: 'base'
    });
    const session = await store.createAgentSession({
      task,
      iteration,
      worktree,
      provider: 'codex'
    });
    const run = await store.createRun({
      task,
      session,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });
    const server = await store.createAgentServer({
      provider: 'codex',
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
      provider: 'codex',
      explanation: 'First plan',
      steps: [{ step: 'Inspect', status: 'IN_PROGRESS' }],
      rawMessage: reference
    });
    await store.recordAgentPlanRevision({
      taskId: task.id,
      iterationId: iteration.id,
      runId: run.id,
      sessionId: session.id,
      provider: 'codex',
      explanation: 'Revised plan',
      steps: [{ step: 'Inspect', status: 'COMPLETED' }],
      rawMessage: reference
    });
    await store.recordAgentUsageSnapshot({
      taskId: task.id,
      iterationId: iteration.id,
      sessionId: session.id,
      runId: run.id,
      provider: 'codex',
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
      provider: 'codex',
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
