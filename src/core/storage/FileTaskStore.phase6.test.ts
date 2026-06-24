import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDomainEvent } from './domainEvent';
import { FileTaskStore } from './FileTaskStore';

describe('FileTaskStore Phase 6 subagent observations', () => {
  it('materializes explicit child hierarchy without replacing the task run', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-phase6-store-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({
      title: 'Observed subagent',
      prompt: 'Delegate repository inspection.',
      repositoryPath: dir
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/phase6-store',
      worktreePath: dir,
      baseSha: 'base'
    });
    const parent = await store.createAgentSession({
      task,
      iteration,
      worktree,
      provider: 'codex'
    });
    await store.updateAgentSession(parent.id, {
      providerSessionId: 'thread-parent',
      providerSessionTreeId: 'tree-1',
      materialized: true
    });
    const run = await store.createRun({
      task,
      session: await requireSession(store, parent.id),
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
    const raw = await store.appendProtocolMessage(
      server.id,
      'INBOUND',
      '{"method":"item/completed"}',
      { method: 'item/completed' }
    );

    const discovered = await store.observeSubagent({
      parentSessionId: parent.id,
      parentRunId: run.id,
      providerChildSessionId: 'thread-child',
      providerParentSessionId: 'thread-parent',
      source: 'COLLAB_RECEIVER',
      delegatedPrompt: 'Inspect the storage layer.',
      requestedSettings: { model: 'gpt-child', reasoningEffort: 'low' },
      rawMessage: raw
    });
    const childRun = await store.createObservedSubagentRun({
      session: discovered.session,
      providerTurnId: 'turn-child',
      serverInstanceId: server.id,
      parentRunId: run.id
    });
    await store.appendEvent(
      createDomainEvent({
        type: 'AGENT_RUN_COMPLETED',
        taskId: task.id,
        iterationId: iteration.id,
        runId: childRun.id,
        worktreeId: worktree.id,
        agentSessionId: discovered.session.id,
        serverInstanceId: server.id,
        source: 'provider',
        payload: { terminalStatus: 'completed' }
      })
    );

    const snapshot = await store.snapshot();
    const storedTask = snapshot.tasks.find((candidate) => candidate.id === task.id);
    const child = snapshot.agentSessions.find(
      (session) => session.providerSessionId === 'thread-child'
    );
    expect(child).toMatchObject({
      role: 'SUBAGENT',
      parentSessionId: parent.id,
      parentRunId: run.id,
      relationshipState: 'RESOLVED',
      delegatedPrompt: 'Inspect the storage layer.',
      requestedSettings: { model: 'gpt-child', reasoningEffort: 'low' }
    });
    expect(snapshot.agentSubagentObservations).toHaveLength(1);
    expect(snapshot.runs.find((candidate) => candidate.id === childRun.id)).toMatchObject({
      mode: 'SUBAGENT',
      origin: 'PROVIDER_SUBAGENT',
      parentRunId: run.id,
      status: 'COMPLETED'
    });
    expect(storedTask?.currentRunId).toBe(run.id);
    expect(storedTask?.currentAgentSessionId).toBe(parent.id);
    expect(storedTask?.workflowPhase).toBe('IN_PROGRESS');
    expect(storedTask?.projection.agentRun).not.toBe('COMPLETED');
  });

  it('retains contradictory parent observations instead of rewriting hierarchy', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-phase6-conflict-'));
    const store = new FileTaskStore(dir);
    const task = await store.createTask({
      title: 'Contradictory subagent',
      prompt: 'Observe exact identifiers.',
      repositoryPath: dir
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/phase6-conflict',
      worktreePath: dir,
      baseSha: 'base'
    });
    const firstParent = await store.createAgentSession({
      task,
      iteration,
      worktree,
      provider: 'codex'
    });
    const secondParent = await store.createAgentSession({
      task,
      iteration,
      worktree,
      provider: 'codex',
      role: 'ALTERNATIVE'
    });
    await store.updateAgentSession(firstParent.id, {
      providerSessionId: 'thread-parent-a'
    });
    await store.updateAgentSession(secondParent.id, {
      providerSessionId: 'thread-parent-b'
    });
    const server = await store.createAgentServer({
      provider: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio']
    });
    const raw = await store.appendProtocolMessage(
      server.id,
      'INBOUND',
      '{"method":"thread/started"}'
    );
    await store.observeSubagent({
      parentSessionId: firstParent.id,
      providerChildSessionId: 'thread-child',
      providerParentSessionId: 'thread-parent-a',
      source: 'THREAD_STARTED_PARENT',
      rawMessage: raw
    });
    const conflicting = await store.observeSubagent({
      parentSessionId: secondParent.id,
      providerChildSessionId: 'thread-child',
      providerParentSessionId: 'thread-parent-b',
      source: 'THREAD_STARTED_PARENT',
      rawMessage: raw
    });

    expect(conflicting.session.relationshipState).toBe('CONTRADICTORY');
    expect(conflicting.session.parentSessionId).toBe(firstParent.id);
    expect(conflicting.observation.detail).toContain('already linked');
    expect(
      (await store.snapshot()).events.some(
        (event) => event.type === 'AGENT_SUBAGENT_RELATIONSHIP_UNRESOLVED'
      )
    ).toBe(true);
  });
});

async function requireSession(store: FileTaskStore, sessionId: string) {
  const session = await store.getAgentSession(sessionId);
  if (!session) {
    throw new Error(`Missing session ${sessionId}`);
  }
  return session;
}
