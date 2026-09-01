import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addTestRepository } from '../../testSupport/repositoryFixture';
import type { AgentExecutionSettings } from '../../shared/agent';
import {
  openScriptedTaskManagerPersistence,
  createTaskMonkiScenario
} from '../../testSupport/taskMonkiScenario';
import { TaskManagerService } from './TaskManagerService';

const temporaryProfiles: Array<{
  directory: string;
  close(): Promise<void>;
}> = [];

afterEach(async () => {
  await Promise.all(
    temporaryProfiles.splice(0).map(async ({ directory, close }) => {
      await close();
      await fs.rm(directory, { recursive: true, force: true });
    })
  );
});

describe('TaskManagerService interaction and cancellation coordination', () => {
  it('admits Stop while a normal Task start still owns the task action', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-cancel-queued-service'
    });
    let releaseSession = () => {};
    let starting: Promise<unknown> | undefined;
    try {
      const task = await scenario.createTask({
        title: 'Cancel queued Task start',
        prompt: 'This prompt must remain unsent after Stop.'
      });
      const createSession = scenario.agent.createSession.bind(scenario.agent);
      let markSessionStarted!: () => void;
      const sessionStarted = new Promise<void>((resolve) => {
        markSessionStarted = resolve;
      });
      const sessionGate = new Promise<void>((resolve) => {
        releaseSession = resolve;
      });
      vi.spyOn(scenario.agent, 'createSession').mockImplementation(async (input) => {
        markSessionStarted();
        await sessionGate;
        return createSession(input);
      });

      starting = scenario.service.startRun({ taskId: task.id });
      await Promise.race([
        sessionStarted,
        starting.then(() => {
          throw new Error('The run finished before it tried to create a provider session.');
        })
      ]);
      const queued = (await scenario.store.snapshot()).runs.find(
        (candidate) => candidate.taskId === task.id
      )!;
      expect(queued.status).toBe('QUEUED');
      expect(queued.providerTurnId).toBeUndefined();

      await expect(
        scenario.service.cancelRun({ runId: queued.id })
      ).resolves.toBeUndefined();
      releaseSession();

      await expect(starting).resolves.toMatchObject({
        id: queued.id,
        status: 'INTERRUPTED',
        providerTurnId: undefined
      });
      expect(scenario.agent.startedTurns).toEqual([]);
    } finally {
      releaseSession();
      await starting?.catch(() => undefined);
      await scenario.dispose();
    }
  }, 20_000);

  it('does not deliver a positive approval while cancellation owns the task', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-interaction-cancel-')
    );
    const opened = await openScriptedTaskManagerPersistence(
      path.join(directory, 'store')
    );
    temporaryProfiles.push({ directory, close: () => opened.persistence.close() });
    const { store, ...scriptedRuntime } = opened;
    const adapter = scriptedRuntime.adapter;
    const service = new TaskManagerService(store, directory, undefined, {
      ...scriptedRuntime.serviceOptions
    });
    const settings: AgentExecutionSettings = {
      runtimeId: 'codex',
      model: 'scenario-model',
      modelProvider: 'openai',
      sandbox: 'WORKSPACE_WRITE',
      networkAccess: false,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user'
    };
    const task = await store.createTask({
      title: 'Cancel an approval',
      prompt: 'Do not execute after cancellation.',
      repositoryId: (await addTestRepository(store, directory)).id,
      runtimeId: 'codex',
      agentSettings: settings
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/cancel-approval',
      worktreePath: directory,
      baseSha: 'base'
    });
    const createdSession = await scriptedRuntime.createSession({
      task,
      iteration,
      worktree,
      runtimeId: 'codex',
      settings
    });
    const session = await scriptedRuntime.taskRuntime.updateAgentSession(
      createdSession.id,
      {
        providerSessionId: 'thread-one',
        providerSessionTreeId: 'thread-one',
        status: 'ACTIVE',
        materialized: true
      },
      `interaction-session-active:${createdSession.id}`
    );
    const server = await scriptedRuntime.runtimeStore.createAgentServer({
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio']
    });
    const createdRun = await scriptedRuntime.createRun({
      task,
      session,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt
    });
    await scriptedRuntime.taskRuntime.updateRun(
      createdRun.id,
      { serverInstanceId: server.id, status: 'STARTING' },
      `interaction-run-starting:${createdRun.id}`
    );
    const run = await scriptedRuntime.transitionRun(
      createdRun.id,
      { providerTurnId: 'turn-one', status: 'RUNNING' },
      `interaction-run-running:${createdRun.id}`
    );
    const requestRawMessage = await scriptedRuntime.runtimeStore.appendProtocolMessage(
      server.id,
      'INBOUND',
      '{"method":"item/commandExecution/requestApproval","id":1}'
    );
    const interaction = await scriptedRuntime.taskRuntime.createInteractionRequest(
      {
        runtimeId: 'codex',
        serverInstanceId: server.id,
        providerRequestId: 1,
        taskId: task.id,
        iterationId: iteration.id,
        runId: run.id,
        sessionId: session.id,
        providerTurnId: run.providerTurnId,
        type: 'COMMAND_APPROVAL',
        request: {
          startedAtMs: Date.now(),
          command: 'npm test',
          cwd: directory
        },
        allowedActions: ['ACCEPT', 'DECLINE', 'CANCEL'],
        policyWarnings: [],
        requestRawMessage
      },
      `interaction-request:${run.id}`
    );

    let releaseCancellation!: () => void;
    const cancellationReleased = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    let markCancellationStarted!: () => void;
    const cancellationStarted = new Promise<void>((resolve) => {
      markCancellationStarted = resolve;
    });
    vi.spyOn(adapter, 'interruptTurn').mockImplementationOnce(async () => {
      markCancellationStarted();
      await cancellationReleased;
    });
    const respond = vi.spyOn(adapter, 'respondToInteraction');

    const cancellation = service.cancelRun({ runId: run.id });
    await cancellationStarted;

    const approval = {
      taskId: task.id,
      runId: run.id,
      interactionRequestId: interaction.id,
      decision: {
        interactionType: 'COMMAND_APPROVAL' as const,
        action: 'ACCEPT' as const
      }
    };
    await expect(service.respondToInteraction(approval)).rejects.toThrow(
      'Agent cancellation is already running for this task.'
    );
    expect(respond).not.toHaveBeenCalled();

    releaseCancellation();
    await cancellation;
    await expect(service.respondToInteraction(approval)).rejects.toThrow('cannot resume');
    expect(respond).not.toHaveBeenCalled();

    await service.shutdown();
  });
});
