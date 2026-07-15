import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ScriptedAgentProviderAdapter } from '../../testSupport/taskMonkiScenario';
import { AppEventBus } from '../runner/AppEventBus';
import { FileAgentRuntimeStore } from '../storage/FileAgentRuntimeStore';
import { FileTaskStore } from '../storage/FileTaskStore';
import { createDomainEvent } from '../storage/domainEvent';
import { AgentOrchestrator } from './AgentOrchestrator';
import { AgentTurnScheduler } from './AgentTurnScheduler';
import { TaskAgentRuntimeMigrator } from './TaskAgentRuntimeMigrator';

describe('TaskAgentRuntimeMigrator', () => {
  it('imports terminal schema-11 task runtime and artifacts once without changing the task store', async () => {
    const fixture = await legacyFixture('terminal');
    const run = await fixture.legacyOrchestrator.startTurn(fixture.turnInput);
    await fixture.store.appendEvent(
      createDomainEvent({
        type: 'AGENT_RUN_COMPLETED',
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        agentSessionId: run.sessionId,
        source: 'provider',
        payload: { terminalStatus: 'completed' }
      })
    );
    const taskSnapshotBefore = await fixture.store.snapshot();

    const migrator = new TaskAgentRuntimeMigrator(fixture.store, fixture.runtime);
    await migrator.migrateTaskStoreV11();
    const migrated = await fixture.runtime.snapshot();
    expect(migrated.migrations).toEqual([
      expect.objectContaining({
        source: 'TASK_STORE_V11',
        sessionCount: 1,
        runCount: 1
      })
    ]);
    expect(migrated.sessions[0]).toMatchObject({
      id: run.sessionId,
      owner: { kind: 'TASK', taskId: run.taskId },
      executionContext: {
        attestation: { status: 'LEGACY_UNATTESTED' }
      }
    });
    expect(migrated.runs[0]).toMatchObject({
      id: run.id,
      status: 'COMPLETED',
      delivery: 'TERMINAL'
    });
    expect(migrated.queueEntries).toHaveLength(0);
    expect(await fixture.runtime.readArtifact(run.promptArtifactId)).toBe(
      fixture.turnInput.prompt
    );
    expect(await fixture.store.snapshot()).toEqual(taskSnapshotBefore);

    const revision = migrated.revision;
    await migrator.migrateTaskStoreV11();
    expect((await fixture.runtime.snapshot()).revision).toBe(revision);
  });

  it('quarantines active legacy delivery and forces a new exact session epoch for later work', async () => {
    const fixture = await legacyFixture('active');
    const legacyRun = await fixture.legacyOrchestrator.startTurn(fixture.turnInput);
    await new TaskAgentRuntimeMigrator(
      fixture.store,
      fixture.runtime
    ).migrateTaskStoreV11();

    expect(await fixture.runtime.getRun(legacyRun.id)).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      delivery: 'AMBIGUOUS',
      recoveryState: 'REQUIRES_USER_ACTION'
    });
    const legacyQueue = (await fixture.runtime.snapshot()).queueEntries.find(
      (entry) => entry.runId === legacyRun.id
    );
    expect(legacyQueue?.status).toBe('LEASED');

    const scheduler = new AgentTurnScheduler(fixture.runtime);
    const currentOrchestrator = new AgentOrchestrator(
      fixture.store,
      fixture.events,
      fixture.adapter,
      { runtimeStore: fixture.runtime, scheduler }
    );
    const currentRun = await currentOrchestrator.startTurn(fixture.turnInput);
    expect(currentRun.sessionId).not.toBe(legacyRun.sessionId);
    expect((await fixture.runtime.getSession(currentRun.sessionId))?.executionContext)
      .toMatchObject({ attestation: { status: 'ATTESTED' } });
  });
});

async function legacyFixture(name: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `task-monki-runtime-migration-${name}-`));
  const repositoryPath = path.join(root, 'repository');
  await fs.mkdir(repositoryPath, { recursive: true });
  const store = new FileTaskStore(path.join(root, 'tasks'));
  const runtime = new FileAgentRuntimeStore(path.join(root, 'runtime'));
  const events = new AppEventBus();
  const adapter = new ScriptedAgentProviderAdapter(store);
  await store.init();
  await runtime.init();
  const task = await store.createTask({
    title: `Legacy ${name}`,
    prompt: `Migrate the ${name} task turn.`,
    repositoryPath,
    agentSettings: { model: 'scenario-model', reasoningEffort: 'low' }
  });
  const { iteration, worktree } = await store.createIterationAndWorktree({
    task,
    branchName: `codex/legacy-${name}`,
    worktreePath: repositoryPath,
    baseSha: 'base'
  });
  const turnInput = {
    task,
    iteration,
    worktree,
    mode: 'IMPLEMENTATION' as const,
    prompt: task.prompt,
    settings: task.agentSettings
  };
  const legacyOrchestrator = new AgentOrchestrator(store, events, adapter);
  return {
    root,
    store,
    runtime,
    events,
    adapter,
    turnInput,
    legacyOrchestrator
  };
}
