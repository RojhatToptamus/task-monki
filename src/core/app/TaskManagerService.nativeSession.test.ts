import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeAdapter } from '../agent/AgentRuntimeAdapter';
import { acpCapabilities } from '../agent/acp/AcpRuntimeProfiles';
import { TEST_ACP_PROFILE } from '../../testSupport/acpRuntimeProfile';
import { FileTaskStore } from '../storage/FileTaskStore';
import { ScriptedAgentRuntimeAdapter } from '../../testSupport/taskMonkiScenario';
import { TaskManagerService } from './TaskManagerService';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

describe('TaskManagerService provider-native session configuration', () => {
  it('routes revisioned provider controls only after validating task, runtime, and idle ownership', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-native-session-'));
    temporaryDirectories.push(directory);
    const store = new FileTaskStore(path.join(directory, 'store'));
    const scripted = new ScriptedAgentRuntimeAdapter(store);
    Object.defineProperty(scripted, 'descriptor', {
      value: TEST_ACP_PROFILE.descriptor
    });
    const adapter = scripted as AgentRuntimeAdapter;
    const applySessionControl = vi.fn(async (input: {
      localSessionId: string;
      controlId: string;
      value: string | boolean;
      revision: string;
    }) => ({
      native: {
        sessionId: 'provider-session-1',
        applied: { id: input.controlId, value: input.value }
      },
      controls: {
        localSessionId: input.localSessionId,
        providerSessionId: 'provider-session-1',
        revision: 'revision-2',
        controls: []
      }
    }));
    adapter.applySessionControl = applySessionControl;
    const service = new TaskManagerService(store, directory, undefined, {
      agentRuntimeAdapters: [adapter]
    });
    const settings = {
      runtimeId: TEST_ACP_PROFILE.descriptor.id,
      model: 'default',
      modelProvider: 'google',
      sandbox: 'DANGER_FULL_ACCESS' as const,
      networkAccess: true,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user' as const
    };
    const task = await store.createTask({
      title: 'Native configuration',
      prompt: 'Keep provider-native controls typed.',
      repositoryPath: directory,
      runtimeId: TEST_ACP_PROFILE.descriptor.id,
      agentSettings: settings
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/native-configuration',
      worktreePath: directory,
      baseSha: 'base'
    });
    const createdSession = await store.createAgentSession({
      task,
      iteration,
      worktree,
      runtimeId: TEST_ACP_PROFILE.descriptor.id,
      requestedSettings: settings
    });
    const session = await store.updateAgentSession(createdSession.id, {
      providerSessionId: 'provider-session-1',
      status: 'IDLE'
    });

    await expect(
      service.updateAgentNativeSession({
        taskId: task.id,
        sessionId: session.id,
        runtimeId: TEST_ACP_PROFILE.descriptor.id,
        controlId: 'model',
        value: 'grok-build',
        revision: 'revision-1'
      })
    ).resolves.toEqual({
      taskId: task.id,
      sessionId: session.id,
      runtimeId: TEST_ACP_PROFILE.descriptor.id,
      native: {
        sessionId: 'provider-session-1',
        applied: { id: 'model', value: 'grok-build' }
      },
      controls: {
        localSessionId: session.id,
        providerSessionId: 'provider-session-1',
        revision: 'revision-2',
        controls: []
      }
    });
    expect(applySessionControl).toHaveBeenCalledWith({
      localSessionId: session.id,
      controlId: 'model',
      value: 'grok-build',
      revision: 'revision-1'
    });

    await expect(
      service.updateAgentNativeSession({
        taskId: task.id,
        sessionId: session.id,
        runtimeId: TEST_ACP_PROFILE.descriptor.id,
        controlId: 'mode',
        value: 'plan',
        revision: 'revision-1'
      })
    ).resolves.toEqual({
      taskId: task.id,
      sessionId: session.id,
      runtimeId: TEST_ACP_PROFILE.descriptor.id,
      native: {
        sessionId: 'provider-session-1',
        applied: { id: 'mode', value: 'plan' }
      },
      controls: {
        localSessionId: session.id,
        providerSessionId: 'provider-session-1',
        revision: 'revision-2',
        controls: []
      }
    });

    await service.updateAgentNativeSession({
      taskId: task.id,
      sessionId: session.id,
      runtimeId: TEST_ACP_PROFILE.descriptor.id,
      controlId: 'provider:temperature',
      value: 'precise',
      revision: 'revision-1'
    });
    expect(applySessionControl).toHaveBeenLastCalledWith({
      localSessionId: session.id,
      controlId: 'provider:temperature',
      value: 'precise',
      revision: 'revision-1'
    });

    await expect(
      service.updateAgentNativeSession({
        taskId: 'another-task',
        sessionId: session.id,
        runtimeId: TEST_ACP_PROFILE.descriptor.id,
        controlId: 'mode', value: 'plan', revision: 'revision-1'
      })
    ).rejects.toThrow('ownership');
    await expect(
      service.updateAgentNativeSession({
        taskId: task.id,
        sessionId: session.id,
        runtimeId: 'grok-acp',
        controlId: 'mode', value: 'plan', revision: 'revision-1'
      })
    ).rejects.toThrow('belongs to');

    const run = await store.createRun({
      task,
      session,
      mode: 'FOLLOW_UP',
      prompt: 'Active work',
      requestedSettings: settings
    });
    await expect(
      service.updateAgentNativeSession({
        taskId: task.id,
        sessionId: session.id,
        runtimeId: TEST_ACP_PROFILE.descriptor.id,
        controlId: 'mode', value: 'plan', revision: 'revision-1'
      })
    ).rejects.toThrow('active or recovery-required');
    await store.updateRun(run.id, { status: 'COMPLETED' });

    let releaseModelUpdate!: () => void;
    const modelUpdateReleased = new Promise<void>((resolve) => {
      releaseModelUpdate = resolve;
    });
    let markModelUpdateStarted!: () => void;
    const modelUpdateStarted = new Promise<void>((resolve) => {
      markModelUpdateStarted = resolve;
    });
    applySessionControl.mockImplementationOnce(async (input) => {
      markModelUpdateStarted();
      await modelUpdateReleased;
      return {
        native: {
          sessionId: 'provider-session-1',
          applied: { id: input.controlId, value: input.value }
        },
        controls: {
          localSessionId: input.localSessionId,
          providerSessionId: 'provider-session-1',
          revision: 'revision-2',
          controls: []
        }
      };
    });
    const pendingModelUpdate = service.updateAgentNativeSession({
      taskId: task.id,
      sessionId: session.id,
      runtimeId: TEST_ACP_PROFILE.descriptor.id,
      controlId: 'model', value: 'grok-build', revision: 'revision-1'
    });
    await modelUpdateStarted;
    await expect(service.startRun({ taskId: task.id })).rejects.toThrow(
      'Provider session update is already running for this task.'
    );
    releaseModelUpdate();
    await pendingModelUpdate;

    vi.spyOn(adapter, 'capabilities').mockResolvedValue(
      acpCapabilities(TEST_ACP_PROFILE)
    );
    const browserService = new TaskManagerService(store, directory, undefined, {
      agentRuntimeAdapters: [adapter],
      allowAgentNetworkAccess: false
    });
    await expect(
      browserService.updateAgentNativeSession({
        taskId: task.id,
        sessionId: session.id,
        runtimeId: TEST_ACP_PROFILE.descriptor.id,
        controlId: 'mode', value: 'plan', revision: 'revision-1'
      })
    ).rejects.toThrow('browser development');
    await service.shutdown();
  });
});
