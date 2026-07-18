import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentExecutionSettings } from '../../shared/agent';
import { ScriptedAgentRuntimeAdapter } from '../../testSupport/taskMonkiScenario';
import { FileTaskStore } from '../storage/FileTaskStore';
import { TaskManagerService } from './TaskManagerService';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

describe('TaskManagerService interaction and cancellation coordination', () => {
  it('does not deliver a positive approval while cancellation owns the task', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-interaction-cancel-')
    );
    temporaryDirectories.push(directory);
    const store = new FileTaskStore(path.join(directory, 'store'));
    const adapter = new ScriptedAgentRuntimeAdapter(store);
    const service = new TaskManagerService(store, directory, undefined, {
      agentRuntimeAdapters: [adapter]
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
      repositoryPath: directory,
      runtimeId: 'codex',
      agentSettings: settings
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/cancel-approval',
      worktreePath: directory,
      baseSha: 'base'
    });
    const createdSession = await store.createAgentSession({
      task,
      iteration,
      worktree,
      runtimeId: 'codex',
      requestedSettings: settings
    });
    const session = await store.updateAgentSession(createdSession.id, {
      providerSessionId: 'thread-one',
      providerSessionTreeId: 'thread-one',
      status: 'ACTIVE',
      materialized: true
    });
    const server = await store.createAgentServer({
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio']
    });
    const createdRun = await store.createRun({
      task,
      session,
      serverInstanceId: server.id,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      requestedSettings: settings
    });
    const run = await store.updateRun(createdRun.id, {
      providerTurnId: 'turn-one',
      status: 'RUNNING'
    });
    const requestRawMessage = await store.appendProtocolMessage(
      server.id,
      'INBOUND',
      '{"method":"item/commandExecution/requestApproval","id":1}'
    );
    const interaction = await store.createInteractionRequest({
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
    });

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
