import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeAdapter } from '../agent/AgentRuntimeAdapter';
import {
  GEMINI_ACP_PROFILE,
  acpCapabilities
} from '../agent/acp/AcpRuntimeProfiles';
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
  it('routes typed operations only after validating task, runtime, and idle ownership', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-native-session-'));
    temporaryDirectories.push(directory);
    const store = new FileTaskStore(path.join(directory, 'store'));
    const scripted = new ScriptedAgentRuntimeAdapter(store);
    Object.defineProperty(scripted, 'descriptor', {
      value: GEMINI_ACP_PROFILE.descriptor
    });
    const adapter = scripted as AgentRuntimeAdapter;
    const setSessionMode = vi.fn(async () => ({
      sessionId: 'provider-session-1',
      modes: { currentModeId: 'plan' }
    }));
    const setSessionConfigOption = vi.fn(async () => ({
      sessionId: 'provider-session-1',
      configOptions: [{ id: 'model', currentValue: 'gemini-2.5-pro' }]
    }));
    adapter.setSessionMode = setSessionMode;
    adapter.setSessionConfigOption = setSessionConfigOption;
    const service = new TaskManagerService(store, directory, undefined, {
      agentProviderAdapter: adapter
    });
    const settings = {
      runtimeId: GEMINI_ACP_PROFILE.descriptor.id,
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
      runtimeId: GEMINI_ACP_PROFILE.descriptor.id,
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
      runtimeId: GEMINI_ACP_PROFILE.descriptor.id,
      requestedSettings: settings
    });
    const session = await store.updateAgentSession(createdSession.id, {
      providerSessionId: 'provider-session-1',
      status: 'IDLE'
    });

    await expect(
      service.updateAgentNativeSession({
        operation: 'SET_MODE',
        taskId: task.id,
        sessionId: session.id,
        runtimeId: GEMINI_ACP_PROFILE.descriptor.id,
        modeId: 'plan'
      })
    ).resolves.toEqual({
      taskId: task.id,
      sessionId: session.id,
      runtimeId: GEMINI_ACP_PROFILE.descriptor.id,
      native: {
        sessionId: 'provider-session-1',
        modes: { currentModeId: 'plan' }
      }
    });
    expect(setSessionMode).toHaveBeenCalledWith(session.id, 'plan');

    await service.updateAgentNativeSession({
      operation: 'SET_CONFIG_OPTION',
      taskId: task.id,
      sessionId: session.id,
      runtimeId: GEMINI_ACP_PROFILE.descriptor.id,
      configId: 'model',
      value: 'gemini-2.5-pro'
    });
    expect(setSessionConfigOption).toHaveBeenCalledWith(
      session.id,
      'model',
      'gemini-2.5-pro'
    );

    await expect(
      service.updateAgentNativeSession({
        operation: 'SET_MODE',
        taskId: 'another-task',
        sessionId: session.id,
        runtimeId: GEMINI_ACP_PROFILE.descriptor.id,
        modeId: 'plan'
      })
    ).rejects.toThrow('ownership');
    await expect(
      service.updateAgentNativeSession({
        operation: 'SET_MODE',
        taskId: task.id,
        sessionId: session.id,
        runtimeId: 'grok-acp',
        modeId: 'plan'
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
        operation: 'SET_MODE',
        taskId: task.id,
        sessionId: session.id,
        runtimeId: GEMINI_ACP_PROFILE.descriptor.id,
        modeId: 'plan'
      })
    ).rejects.toThrow('active or recovery-required');
    await store.updateRun(run.id, { status: 'COMPLETED' });

    vi.spyOn(adapter, 'capabilities').mockResolvedValue(
      acpCapabilities(GEMINI_ACP_PROFILE)
    );
    const browserService = new TaskManagerService(store, directory, undefined, {
      agentProviderAdapter: adapter,
      allowAgentNetworkAccess: false
    });
    await expect(
      browserService.updateAgentNativeSession({
        operation: 'SET_MODE',
        taskId: task.id,
        sessionId: session.id,
        runtimeId: GEMINI_ACP_PROFILE.descriptor.id,
        modeId: 'plan'
      })
    ).rejects.toThrow('browser development');
    await service.shutdown();
  });
});
