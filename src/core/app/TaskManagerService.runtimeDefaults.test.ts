import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentModel, AgentRuntimeCapabilities } from '../../shared/contracts';
import { ScriptedAgentRuntimeAdapter } from '../../testSupport/taskMonkiScenario';
import { createRuntimeReadiness } from '../agent/AgentRuntimeReadiness';
import { acpCapabilities } from '../agent/acp/AcpRuntimeProfiles';
import { TEST_ACP_PROFILE } from '../../testSupport/acpRuntimeProfile';
import {
  OPENCODE_RUNTIME_DESCRIPTOR,
  opencodeCapabilities
} from '../agent/opencode/opencodeCapabilities';
import { MemoryAppSettingsStore } from '../settings/AppSettingsStore';
import { FileTaskStore } from '../storage/FileTaskStore';
import { TaskManagerService } from './TaskManagerService';

describe('TaskManagerService runtime execution defaults', () => {
  it.each([
    {
      runtimeId: 'opencode',
      descriptor: OPENCODE_RUNTIME_DESCRIPTOR,
      capabilities: opencodeCapabilities(),
      expected: {
        sandbox: 'DANGER_FULL_ACCESS',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        networkAccess: true
      }
    },
    {
      runtimeId: TEST_ACP_PROFILE.descriptor.id,
      descriptor: TEST_ACP_PROFILE.descriptor,
      capabilities: acpCapabilities(TEST_ACP_PROFILE),
      expected: {
        sandbox: 'DANGER_FULL_ACCESS',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        networkAccess: true
      }
    }
  ])(
    'persists the $runtimeId adapter default when the API omits security settings',
    async ({ runtimeId, descriptor, capabilities, expected }) => {
      const dir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'task-monki-runtime-defaults-')
      );
      const store = new FileTaskStore(path.join(dir, 'store'));
      const adapter = new ScriptedAgentRuntimeAdapter(store);
      Object.defineProperty(adapter, 'descriptor', { value: descriptor });
      vi.spyOn(adapter, 'capabilities').mockResolvedValue(
        capabilities as AgentRuntimeCapabilities
      );
      const resolveExecution = vi.spyOn(adapter, 'resolveExecution');
      const service = new TaskManagerService(store, dir, undefined, {
        agentRuntimeAdapters: [adapter]
      });

      const task = await service.createTask({
        runtimeId,
        title: `${runtimeId} defaults`,
        prompt: 'Use the runtime-owned default policy.',
        repositoryPath: dir
      });

      expect(task.agentSettings).toMatchObject({
        runtimeId,
        ...expected
      });
      expect(resolveExecution).not.toHaveBeenCalled();
    }
  );

  it('registers all built-in runtime profiles without starting them in inert mode', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-runtime-composition-')
    );
    const service = new TaskManagerService(
      new FileTaskStore(path.join(dir, 'store')),
      dir,
      undefined,
      {
        agentProviderStartupDisabledReason: 'inert test'
      }
    );
    await service.init();
    const catalog = await service.getAgentRuntimeCatalog();

    expect(catalog.runtimes.map((runtime) => runtime.preflight.runtime.id)).toEqual([
      'codex',
      'opencode',
      'grok-acp',
      'cursor-agent-acp',
      'claude-agent-acp'
    ]);
    expect(
      catalog.runtimes.every((runtime) => !runtime.preflight.readiness.canStart)
    ).toBe(true);
    await service.shutdown();
  });

  it('applies persisted and updated executable settings through the owning runtime', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-runtime-executable-settings-')
    );
    const store = new FileTaskStore(path.join(dir, 'store'));
    const adapter = new ScriptedAgentRuntimeAdapter(store);
    Object.defineProperty(adapter, 'descriptor', {
      value: OPENCODE_RUNTIME_DESCRIPTOR
    });
    vi.spyOn(adapter, 'capabilities').mockResolvedValue(opencodeCapabilities());
    vi.spyOn(adapter, 'preflight').mockResolvedValue({
      runtime: OPENCODE_RUNTIME_DESCRIPTOR,
      readiness: createRuntimeReadiness('READY', 'OpenCode is ready.'),
      capabilities: opencodeCapabilities(),
    });
    vi.spyOn(adapter, 'listModels').mockResolvedValue([
      model('opencode', 'openai')
    ]);
    const configureRuntime = vi.fn(async () => undefined);
    Object.defineProperty(adapter, 'configureRuntime', { value: configureRuntime });
    const settingsStore = new MemoryAppSettingsStore({
      defaultRuntimeId: 'opencode',
      runtimeExecutablePaths: { opencode: '/opt/agents/opencode' }
    });
    const service = new TaskManagerService(store, dir, undefined, {
      agentRuntimeAdapters: [adapter],
      appSettingsStore: settingsStore,
      agentProviderStartupDisabledReason: 'settings-only test'
    });

    await service.init();
    expect(configureRuntime).toHaveBeenCalledWith({
      executable: '/opt/agents/opencode',
      restart: false
    });

    await service.updateAppSettings({
      runtimeExecutablePaths: { opencode: '/usr/local/bin/opencode' }
    });
    expect(configureRuntime).toHaveBeenLastCalledWith({
      executable: '/usr/local/bin/opencode',
      restart: true
    });
    expect((await settingsStore.get()).runtimeExecutablePaths).toEqual({
      opencode: '/usr/local/bin/opencode'
    });
    await service.shutdown();
  });

  it('keeps an explicit startup executable override ahead of saved runtime settings', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-runtime-executable-override-')
    );
    const store = new FileTaskStore(path.join(dir, 'store'));
    const adapter = new ScriptedAgentRuntimeAdapter(store);
    Object.defineProperty(adapter, 'descriptor', {
      value: OPENCODE_RUNTIME_DESCRIPTOR
    });
    vi.spyOn(adapter, 'capabilities').mockResolvedValue(opencodeCapabilities());
    const configureRuntime = vi.fn(async () => undefined);
    Object.defineProperty(adapter, 'configureRuntime', { value: configureRuntime });
    const service = new TaskManagerService(store, dir, undefined, {
      agentRuntimeAdapters: [adapter],
      openCodePath: '/debug/overrides/opencode',
      appSettingsStore: new MemoryAppSettingsStore({
        defaultRuntimeId: 'opencode',
        runtimeExecutablePaths: { opencode: '/saved/opencode' }
      }),
      agentProviderStartupDisabledReason: 'settings-only test'
    });

    await service.init();
    expect(configureRuntime).toHaveBeenCalledWith({
      executable: '/debug/overrides/opencode',
      restart: false
    });
    await service.shutdown();
  });

  it('rejects an unsafe runtime before task creation can probe it in browser development', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-browser-runtime-create-')
    );
    const store = new FileTaskStore(path.join(dir, 'store'));
    const adapter = new ScriptedAgentRuntimeAdapter(store);
    Object.defineProperty(adapter, 'descriptor', {
      value: OPENCODE_RUNTIME_DESCRIPTOR
    });
    vi.spyOn(adapter, 'capabilities').mockResolvedValue(opencodeCapabilities());
    const resolveExecution = vi.spyOn(adapter, 'resolveExecution');
    const service = new TaskManagerService(store, dir, undefined, {
      agentRuntimeAdapters: [adapter],
      allowAgentNetworkAccess: false
    });

    await expect(
      service.createTask({
        runtimeId: 'opencode',
        title: 'Unsafe browser runtime',
        prompt: 'Do not start the provider.',
        repositoryPath: dir
      })
    ).rejects.toThrow('browser development');
    expect(resolveExecution).not.toHaveBeenCalled();
    expect((await store.snapshot()).tasks).toEqual([]);
    await service.shutdown();
  });

  it('persists but does not apply unsafe runtime executable changes in browser development', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-browser-runtime-settings-')
    );
    const store = new FileTaskStore(path.join(dir, 'store'));
    const adapter = new ScriptedAgentRuntimeAdapter(store);
    Object.defineProperty(adapter, 'descriptor', {
      value: OPENCODE_RUNTIME_DESCRIPTOR
    });
    vi.spyOn(adapter, 'capabilities').mockResolvedValue(opencodeCapabilities());
    const configureRuntime = vi.fn(async () => undefined);
    Object.defineProperty(adapter, 'configureRuntime', { value: configureRuntime });
    const settingsStore = new MemoryAppSettingsStore({
      defaultRuntimeId: 'opencode'
    });
    const service = new TaskManagerService(store, dir, undefined, {
      agentRuntimeAdapters: [adapter],
      appSettingsStore: settingsStore,
      allowAgentNetworkAccess: false
    });

    await service.updateAppSettings({
      runtimeExecutablePaths: { opencode: '/usr/local/bin/opencode' }
    });

    expect(configureRuntime).not.toHaveBeenCalled();
    expect((await settingsStore.get()).runtimeExecutablePaths).toEqual({
      opencode: '/usr/local/bin/opencode'
    });
    await service.shutdown();
  });

  it('rejects contradictory runtime identities at the service boundary', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-runtime-identity-conflict-')
    );
    const store = new FileTaskStore(path.join(dir, 'store'));
    const service = new TaskManagerService(store, dir, undefined, {
      agentRuntimeAdapters: [new ScriptedAgentRuntimeAdapter(store)]
    });

    await expect(
      service.createTask({
        runtimeId: 'codex',
        title: 'Conflicting runtime',
        prompt: 'Reject ambiguous ownership.',
        repositoryPath: dir,
        agentSettings: { runtimeId: 'opencode' }
      })
    ).rejects.toThrow('runtime must match');
    expect((await store.snapshot()).tasks).toEqual([]);
    await service.shutdown();
  });
});

function model(runtimeId: string, modelProvider: string): AgentModel {
  return {
    id: `${runtimeId}:${modelProvider}/default`,
    runtimeId,
    modelProvider,
    model: 'default',
    displayName: 'Default',
    hidden: false,
    supportedReasoningEfforts: [],
    serviceTiers: [],
    inputModalities: ['text'],
    isDefault: true
  };
}
