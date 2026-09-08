import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addTestRepository } from '../../testSupport/repositoryFixture';
import type { AgentRuntimeAdapter } from '../agent/AgentRuntimeAdapter';
import { acpCapabilities } from '../agent/acp/AcpRuntimeProfiles';
import { TEST_ACP_PROFILE } from '../../testSupport/acpRuntimeProfile';
import { openScriptedTaskManagerPersistence } from '../../testSupport/taskMonkiScenario';
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

describe('TaskManagerService provider-native session configuration', () => {
  it('routes revisioned provider controls only after validating task, runtime, and idle ownership', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-native-session-'));
    const opened = await openScriptedTaskManagerPersistence(
      path.join(directory, 'store')
    );
    temporaryProfiles.push({ directory, close: () => opened.persistence.close() });
    const { store, ...scriptedRuntime } = opened;
    const scripted = scriptedRuntime.adapter;
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
      ...scriptedRuntime.serviceOptions,
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
      repositoryId: (await addTestRepository(store, directory)).id,
      runtimeId: TEST_ACP_PROFILE.descriptor.id,
      agentSettings: settings
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/native-configuration',
      worktreePath: directory,
      baseSha: 'base'
    });
    const createdSession = await scriptedRuntime.createSession({
      task,
      iteration,
      worktree,
      runtimeId: TEST_ACP_PROFILE.descriptor.id,
      settings
    });
    const session = await scriptedRuntime.taskRuntime.updateAgentSession(
      createdSession.id,
      {
        providerSessionId: 'provider-session-1',
        status: 'IDLE',
        materialized: true
      },
      `native-session-materialized:${createdSession.id}`
    );

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

    const run = await scriptedRuntime.createRun({
      task,
      session,
      mode: 'FOLLOW_UP',
      prompt: 'Active work'
    });
    await expect(
      service.updateAgentNativeSession({
        taskId: task.id,
        sessionId: session.id,
        runtimeId: TEST_ACP_PROFILE.descriptor.id,
        controlId: 'mode', value: 'plan', revision: 'revision-1'
      })
    ).rejects.toThrow('active or recovery-required');
    await scriptedRuntime.transitionRun(
      run.id,
      { status: 'COMPLETED' },
      `native-run-completed:${run.id}`
    );

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
      ...scriptedRuntime.serviceOptions,
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
