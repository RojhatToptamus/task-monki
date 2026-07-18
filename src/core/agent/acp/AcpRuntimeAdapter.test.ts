import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentInteractionService } from '../AgentInteractionService';
import { AgentMutationAmbiguousError } from '../AgentRuntimeAdapter';
import { AppEventBus } from '../../runner/AppEventBus';
import {
  ArtifactAppendAmbiguousError,
  FileTaskStore
} from '../../storage/FileTaskStore';
import type { AcpNativeSessionState } from './AcpEventMapper';
import { AcpRuntimeAdapter } from './AcpRuntimeAdapter';
import type { AcpSessionConfigOption, AcpSessionUpdate } from './AcpProtocol';
import type { AcpRpcClient } from './AcpRpcClient';
import {
  GROK_SESSION_MODEL_EXTENSION,
  type AcpRuntimeProfile
} from './AcpRuntimeProfiles';
import { TEST_ACP_PROFILE } from '../../../testSupport/acpRuntimeProfile';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

describe('AcpRuntimeAdapter end-to-end', () => {
  it.each([
    {
      catalog: 'missing',
      initializeMeta: undefined,
      expectedError: 'did not provide the required grok-build-acp/session-models@v1 initialize catalog'
    },
    {
      catalog: 'malformed',
      initializeMeta: {
        modelState: {
          currentModelId: 'grok-build',
          availableModels: [{ modelId: 'grok-build' }]
        }
      },
      expectedError: 'ACP provider extension session model is invalid'
    },
    {
      catalog: 'credential-colliding',
      initializeMeta: {
        modelState: {
          currentModelId: 'test-grok-catalog-secret',
          availableModels: [
            {
              modelId: 'test-grok-catalog-secret',
              name: 'Unsafe credential identifier'
            }
          ]
        }
      },
      expectedError: 'identifier matching a runtime credential',
      credential: 'test-grok-catalog-secret'
    }
  ])(
    'fails closed when the Grok initialize model catalog is $catalog',
    async ({ catalog, initializeMeta, expectedError, credential }) => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), `task-monki-grok-${catalog}-catalog-`)
      );
      temporaryDirectories.push(directory);
      const agentScript = path.join(directory, 'agent.cjs');
      const mutationMarker = path.join(directory, 'provider-mutations.txt');
      await fs.writeFile(
        agentScript,
        invalidGrokCatalogAgentSource(mutationMarker, initializeMeta),
        { mode: 0o600 }
      );
      const runtimeId = `test-grok-${catalog}`;
      const profile: AcpRuntimeProfile = {
        ...TEST_ACP_PROFILE,
        descriptor: { ...TEST_ACP_PROFILE.descriptor, id: runtimeId },
        defaultModelProvider: 'xai',
        defaultModel: 'grok-build',
        sessionModelExtension: GROK_SESSION_MODEL_EXTENSION,
        executableCandidates: [process.execPath],
        argv: [agentScript]
      };
      const store = new FileTaskStore(path.join(directory, 'store'));
      const adapter = new AcpRuntimeAdapter(store, new AppEventBus(), profile, {
        cwd: directory,
        ...(credential
          ? { environment: { ...process.env, TEST_ACP_API_KEY: credential } }
          : {}),
        requestTimeoutMs: 1_000,
        runtimeResolver: async () => ({
          executable: process.execPath,
          version: process.version,
          diagnostics: {
            selectedExecutable: process.execPath,
            selectedSource: 'test',
            selectedVersion: process.version,
            selectedLaunchArgv: [agentScript],
            requiredCapabilities: ['ACP protocolVersion=1'],
            probes: []
          }
        })
      });
      const settings = {
        runtimeId,
        modelProvider: 'xai',
        sandbox: 'DANGER_FULL_ACCESS' as const,
        networkAccess: true,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user' as const
      };
      const task = await store.createTask({
        title: 'Reject invalid Grok catalog',
        prompt: 'This prompt must not reach the provider.',
        repositoryPath: directory,
        runtimeId,
        agentSettings: settings
      });
      const { iteration, worktree } = await store.createIterationAndWorktree({
        task,
        branchName: `codex/grok-${catalog}-catalog`,
        worktreePath: directory,
        baseSha: 'base'
      });
      const session = await store.createAgentSession({
        task,
        iteration,
        worktree,
        runtimeId,
        requestedSettings: settings
      });
      const run = await store.createRun({
        task,
        session,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        requestedSettings: settings
      });

      try {
        await adapter.initialize();
        await expect(
          adapter.resolveExecution({ settings, attachments: [] })
        ).rejects.toThrow(expectedError);
        if (credential) {
          await expect(adapter.preflight()).resolves.toMatchObject({
            readiness: {
              status: 'FAILED',
              canStart: false,
              checks: { initialization: 'FAILED' },
              nextAction: { kind: 'RETRY' }
            }
          });
          await fs.writeFile(
            agentScript,
            invalidGrokCatalogAgentSource(mutationMarker, {
              modelState: {
                currentModelId: 'grok-build',
                availableModels: [
                  { modelId: 'grok-build', name: 'Grok Build' }
                ]
              }
            }),
            { mode: 0o600 }
          );
          await expect(adapter.listModels()).resolves.toEqual([
            expect.objectContaining({ model: 'grok-build', isDefault: true })
          ]);
        } else {
          await expect(adapter.listModels()).rejects.toThrow(expectedError);
          await expect(
            adapter.startTurn({
              localRunId: run.id,
              session: { localSessionId: session.id },
              mode: 'IMPLEMENTATION',
              prompt: task.prompt,
              authoritativeGoal: task.prompt,
              settings,
              attachments: []
            })
          ).rejects.toThrow(expectedError);
        }
        await expect(fs.readFile(mutationMarker, 'utf8')).rejects.toMatchObject({
          code: 'ENOENT'
        });
        expect((await store.getAgentSession(session.id))?.providerSessionId).toBeUndefined();
      } finally {
        await adapter.shutdown();
      }
    }
  );

  it('bounds retained startup payloads before journal redaction shrinks them', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-acp-startup-buffer-')
    );
    temporaryDirectories.push(directory);
    const agentScript = path.join(directory, 'agent.cjs');
    await fs.writeFile(agentScript, oversizedRedactedStartupEventsAgentSource(), {
      mode: 0o600
    });
    const profile: AcpRuntimeProfile = {
      ...TEST_ACP_PROFILE,
      descriptor: { ...TEST_ACP_PROFILE.descriptor, id: 'test-startup-buffer' },
      defaultModelProvider: 'xai',
      defaultModel: 'grok-build',
      sessionModelExtension: GROK_SESSION_MODEL_EXTENSION,
      executableCandidates: [process.execPath],
      argv: [agentScript]
    };
    const store = new FileTaskStore(path.join(directory, 'store'));
    const adapter = new AcpRuntimeAdapter(store, new AppEventBus(), profile, {
      cwd: directory,
      requestTimeoutMs: 2_000,
      runtimeResolver: async () => ({
        executable: process.execPath,
        version: process.version,
        diagnostics: {
          selectedExecutable: process.execPath,
          selectedSource: 'test',
          selectedVersion: process.version,
          selectedLaunchArgv: [agentScript],
          requiredCapabilities: ['ACP protocolVersion=1'],
          probes: []
        }
      })
    });

    try {
      await adapter.initialize();
      await expect(adapter.listModels()).rejects.toThrow(
        'ACP exceeded the bounded event buffer while initialization was completing.'
      );
    } finally {
      await adapter.shutdown();
    }
  });

  it('preserves deferred explicit models for ACP profiles without an initialize catalog', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-generic-acp-model-')
    );
    temporaryDirectories.push(directory);
    const store = new FileTaskStore(path.join(directory, 'store'));
    const adapter = new AcpRuntimeAdapter(
      store,
      new AppEventBus(),
      TEST_ACP_PROFILE,
      {
        cwd: directory,
        runtimeResolver: async () => ({
          executable: process.execPath,
          version: process.version,
          diagnostics: {
            selectedExecutable: process.execPath,
            selectedSource: 'test',
            selectedVersion: process.version,
            selectedLaunchArgv: [],
            requiredCapabilities: ['ACP protocolVersion=1'],
            probes: []
          }
        })
      }
    );
    const settings = {
      runtimeId: TEST_ACP_PROFILE.descriptor.id,
      model: 'provider-specific-model',
      modelProvider: 'test-provider',
      sandbox: 'DANGER_FULL_ACCESS' as const,
      networkAccess: true,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user' as const
    };

    try {
      await adapter.initialize();
      await expect(
        adapter.resolveExecution({ settings, attachments: [] })
      ).resolves.toMatchObject({
        settings: {
          model: 'provider-specific-model',
          modelProvider: 'test-provider'
        },
        model: {
          model: 'provider-specific-model',
          modelProvider: 'test-provider',
          native: { source: 'explicit-runtime-setting' }
        }
      });
      expect((await store.snapshot()).agentServers).toEqual([]);
    } finally {
      await adapter.shutdown();
    }
  });

  it('promotes and restores Cursor model selectors only from task-owned sessions', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-cursor-model-selector-')
    );
    temporaryDirectories.push(directory);
    const agentScript = path.join(directory, 'cursor-agent.cjs');
    const catalogMarker = path.join(directory, 'catalog-state.txt');
    const sessionSequence = path.join(directory, 'session-sequence.txt');
    await fs.writeFile(
      agentScript,
      cursorModelSelectorAgentSource(catalogMarker, sessionSequence),
      { mode: 0o600 }
    );
    const runtimeId = 'test-cursor-model-selector';
    const exactModel = 'grok-4.5[effort=high,fast=true]';
    const profile: AcpRuntimeProfile = {
      ...TEST_ACP_PROFILE,
      descriptor: { ...TEST_ACP_PROFILE.descriptor, id: runtimeId },
      defaultModelProvider: 'cursor',
      defaultModel: 'default',
      promoteSessionModelSelector: true,
      executableCandidates: [process.execPath],
      argv: [agentScript]
    };
    const store = new FileTaskStore(path.join(directory, 'store'));
    const createAdapter = () =>
      new AcpRuntimeAdapter(store, new AppEventBus(), profile, {
        cwd: directory,
        requestTimeoutMs: 2_000,
        runtimeResolver: async () => ({
          executable: process.execPath,
          version: process.version,
          diagnostics: {
            selectedExecutable: process.execPath,
            selectedSource: 'test',
            selectedVersion: process.version,
            selectedLaunchArgv: [agentScript],
            requiredCapabilities: ['ACP protocolVersion=1'],
            probes: []
          }
        })
      });
    const defaultSettings = {
      runtimeId,
      model: 'default',
      modelProvider: 'cursor',
      sandbox: 'DANGER_FULL_ACCESS' as const,
      networkAccess: true,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user' as const
    };
    const createOwnedSession = async (
      slug: string,
      settings: typeof defaultSettings
    ) => {
      const worktreePath = path.join(directory, slug);
      await fs.mkdir(worktreePath);
      const task = await store.createTask({
        title: slug,
        prompt: 'Implement the requested change.',
        repositoryPath: directory,
        runtimeId,
        agentSettings: settings
      });
      const { iteration, worktree } = await store.createIterationAndWorktree({
        task,
        branchName: `codex/${slug}`,
        worktreePath,
        baseSha: 'base'
      });
      const session = await store.createAgentSession({
        task,
        iteration,
        worktree,
        runtimeId,
        requestedSettings: settings
      });
      return { task, iteration, worktree, session };
    };

    const first = createAdapter();
    try {
      await first.initialize();
      await expect(first.listModels()).resolves.toEqual([
        expect.objectContaining({ model: 'default', displayName: 'Auto' })
      ]);
      expect((await store.snapshot()).agentServers).toEqual([]);

      const owned = await createOwnedSession('cursor-default', defaultSettings);
      await first.createSession({
        runtimeId,
        localSessionId: owned.session.id,
        taskId: owned.task.id,
        iterationId: owned.iteration.id,
        worktreeId: owned.worktree.id,
        worktreePath: owned.worktree.worktreePath,
        settings: defaultSettings
      });
      await expect(first.listModels()).resolves.toEqual([
        expect.objectContaining({ model: 'default[]', displayName: 'Auto', isDefault: true }),
        expect.objectContaining({
          model: exactModel,
          displayName: 'grok-4.5',
          isDefault: false,
          native: {
            source: 'task-owned-session-model-selector',
            configId: 'model'
          }
        }),
        expect.objectContaining({
          model: 'composer-2.5[fast=true]',
          displayName: 'composer-2.5'
        })
      ]);
      await first.shutdown();
      await first.initialize();
      const reenabled = await createOwnedSession('cursor-reenabled', defaultSettings);
      await expect(
        first.createSession({
          runtimeId,
          localSessionId: reenabled.session.id,
          taskId: reenabled.task.id,
          iterationId: reenabled.iteration.id,
          worktreeId: reenabled.worktree.id,
          worktreePath: reenabled.worktree.worktreePath,
          settings: defaultSettings
        })
      ).resolves.toMatchObject({
        id: reenabled.session.id,
        providerSessionId: expect.any(String)
      });
    } finally {
      await first.shutdown();
    }

    const serverCountBeforeRestore = (await store.snapshot()).agentServers.length;
    const restored = createAdapter();
    try {
      await restored.initialize();
      await expect(restored.listModels()).resolves.toEqual([
        expect.objectContaining({ model: 'default[]', displayName: 'Auto' }),
        expect.objectContaining({ model: exactModel }),
        expect.objectContaining({ model: 'composer-2.5[fast=true]' })
      ]);
      expect((await store.snapshot()).agentServers).toHaveLength(serverCountBeforeRestore);

      const selectedSettings = { ...defaultSettings, model: exactModel };
      await expect(
        restored.resolveExecution({ settings: selectedSettings, attachments: [] })
      ).resolves.toMatchObject({
        settings: { model: exactModel, modelProvider: 'cursor' },
        model: { model: exactModel }
      });
      const selected = await createOwnedSession('cursor-selected', selectedSettings);
      await restored.createSession({
        runtimeId,
        localSessionId: selected.session.id,
        taskId: selected.task.id,
        iterationId: selected.iteration.id,
        worktreeId: selected.worktree.id,
        worktreePath: selected.worktree.worktreePath,
        settings: selectedSettings
      });
      await expect(restored.listModels()).resolves.toEqual([
        expect.objectContaining({ model: 'default[]', isDefault: true }),
        expect.objectContaining({ model: exactModel, isDefault: false }),
        expect.objectContaining({ model: 'composer-2.5[fast=true]', isDefault: false })
      ]);
      expect(await protocolMethodCount(store, 'session/set_config_option')).toBe(1);
      const activeServer = (await store.snapshot()).agentServers.find(
        (server) => server.status === 'READY'
      );
      expect(activeServer).toBeDefined();
      const journal = await fs.readFile(activeServer!.protocolJournalPath, 'utf8');
      expect(
        journal
          .trim()
          .split('\n')
          .map((line) => JSON.parse(JSON.parse(line).raw))
      ).toContainEqual({
        jsonrpc: '2.0',
        id: expect.any(Number),
        method: 'session/set_config_option',
        params: {
          sessionId: expect.any(String),
          configId: 'model',
          value: exactModel
        }
      });

      await fs.writeFile(catalogMarker, 'stale');
      const stale = await createOwnedSession('cursor-stale', selectedSettings);
      await expect(
        restored.createSession({
          runtimeId,
          localSessionId: stale.session.id,
          taskId: stale.task.id,
          iterationId: stale.iteration.id,
          worktreeId: stale.worktree.id,
          worktreePath: stale.worktree.worktreePath,
          settings: selectedSettings
        })
      ).rejects.toThrow(`does not offer value ${exactModel}`);
      expect(await protocolMethodCount(store, 'session/set_config_option')).toBe(1);
      await expect(restored.listModels()).resolves.toEqual([
        expect.objectContaining({ model: 'default[]', displayName: 'Auto' })
      ]);
    } finally {
      await restored.shutdown();
    }
  });

  it('replaces a valid Grok catalog and quarantines a rejected replacement', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-grok-model-update-')
    );
    temporaryDirectories.push(directory);
    const agentScript = path.join(directory, 'agent.cjs');
    const mutationMarker = path.join(directory, 'provider-mutations.txt');
    const runtimeId = 'test-grok-model-update';
    const secret = 'test-grok-catalog-secret';
    const validParams = {
      currentModelId: 'grok-4.5',
      availableModels: [
        {
          modelId: 'grok-4.5',
          name: `Grok 4.5 ${secret}`,
          description: `Frontier ${secret}`,
          _meta: {
            supportsReasoningEffort: true,
            reasoningEffort: 'high',
            reasoningEfforts: [
              { id: 'high', value: 'high', label: 'High', default: true },
              { id: 'medium', value: 'medium', label: 'Medium', default: false },
              { id: 'low', value: 'low', label: 'Low', default: false }
            ]
          }
        }
      ]
    };
    await fs.writeFile(
      agentScript,
      grokStartupModelUpdateAgentSource(mutationMarker, validParams),
      { mode: 0o600 }
    );
    const profile: AcpRuntimeProfile = {
      ...TEST_ACP_PROFILE,
      descriptor: { ...TEST_ACP_PROFILE.descriptor, id: runtimeId },
      defaultModelProvider: 'xai',
      defaultModel: 'grok-build',
      sessionModelExtension: GROK_SESSION_MODEL_EXTENSION,
      executableCandidates: [process.execPath],
      argv: [agentScript]
    };
    const store = new FileTaskStore(path.join(directory, 'store'));
    const adapter = new AcpRuntimeAdapter(store, new AppEventBus(), profile, {
      cwd: directory,
      environment: { ...process.env, TEST_ACP_API_KEY: secret },
      requestTimeoutMs: 1_000,
      runtimeResolver: async () => ({
        executable: process.execPath,
        version: process.version,
        diagnostics: {
          selectedExecutable: process.execPath,
          selectedSource: 'test',
          selectedVersion: process.version,
          selectedLaunchArgv: [agentScript],
          requiredCapabilities: ['ACP protocolVersion=1'],
          probes: []
        }
      })
    });

    try {
      await adapter.initialize();
      const updated = await adapter.listModels();
      expect(updated).toEqual([
        expect.objectContaining({
          model: 'grok-4.5',
          displayName: 'Grok 4.5 [REDACTED]',
          description: 'Frontier [REDACTED]',
          supportedReasoningEfforts: ['high', 'medium', 'low'],
          defaultReasoningEffort: 'high',
          isDefault: true,
          native: expect.objectContaining({
            advertisedReasoningEfforts: ['high', 'medium', 'low'],
            providerDefaultReasoningEffort: 'high'
          })
        })
      ]);
      expect(JSON.stringify(updated)).not.toContain(secret);
      const internals = adapter as unknown as {
        boundClient?: AcpRpcClient;
        inboundQueue: Promise<void>;
        profileModelState?: unknown;
        models: unknown[];
      };
      const client = internals.boundClient!;
      const server = (await store.snapshot()).agentServers[0]!;
      const emitModelUpdate = async (params: unknown) => {
        const raw = await store.appendProtocolMessage(
          server.id,
          'INBOUND',
          JSON.stringify({
            jsonrpc: '2.0',
            method: '_x.ai/models/update',
            params
          })
        );
        client.events.emit('notification', '_x.ai/models/update', params, raw);
        await internals.inboundQueue;
      };

      await emitModelUpdate({
        ...validParams,
        currentModelId: 'not-advertised'
      });
      expect(internals.profileModelState).toBeUndefined();
      expect(internals.models).toEqual([]);
      expect(internals.boundClient).toBeUndefined();
      expect(await adapter.listModels()).toEqual(updated);
      expect((await store.snapshot()).agentServers).toHaveLength(2);
    } finally {
      await adapter.shutdown();
    }
  });

  it('keeps the session/new model observation separate from an acknowledged Grok model resolution', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-acp-model-attestation-')
    );
    temporaryDirectories.push(directory);
    const agentScript = path.join(directory, 'agent.cjs');
    await fs.writeFile(
      agentScript,
      fakeAgentSource(directory, 'grok-composer-2.5-fast'),
      { mode: 0o600 }
    );
    const runtimeId = 'test-acp-model-attestation';
    const profile: AcpRuntimeProfile = {
      ...TEST_ACP_PROFILE,
      descriptor: { ...TEST_ACP_PROFILE.descriptor, id: runtimeId },
      defaultModelProvider: 'xai',
      defaultModel: 'grok-build',
      sessionModelExtension: GROK_SESSION_MODEL_EXTENSION,
      executableCandidates: [process.execPath],
      argv: [agentScript]
    };
    const store = new FileTaskStore(path.join(directory, 'store'));
    const adapter = new AcpRuntimeAdapter(store, new AppEventBus(), profile, {
      cwd: directory,
      requestTimeoutMs: 2_000,
      runtimeResolver: async () => ({
        executable: process.execPath,
        version: process.version,
        diagnostics: {
          selectedExecutable: process.execPath,
          selectedSource: 'test',
          selectedVersion: process.version,
          selectedLaunchArgv: [agentScript],
          requiredCapabilities: ['ACP protocolVersion=1'],
          probes: []
        }
      })
    });
    const settings = {
      runtimeId,
      model: 'grok-build',
      modelProvider: 'xai',
      sandbox: 'DANGER_FULL_ACCESS' as const,
      networkAccess: true,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user' as const
    };
    const task = await store.createTask({
      title: 'Attest Grok model selection',
      prompt: 'Use Grok Build.',
      repositoryPath: directory,
      runtimeId,
      agentSettings: settings
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/acp-model-attestation',
      worktreePath: directory,
      baseSha: 'base'
    });
    const localSession = await store.createAgentSession({
      task,
      iteration,
      worktree,
      runtimeId,
      requestedSettings: settings
    });

    try {
      await adapter.initialize();
      const session = await adapter.createSession({
        runtimeId,
        localSessionId: localSession.id,
        taskId: task.id,
        iterationId: iteration.id,
        worktreeId: worktree.id,
        worktreePath: worktree.worktreePath,
        settings
      });
      expect(session.observedSettings).toMatchObject({
        model: 'grok-build',
        modelProvider: 'xai'
      });

      const snapshot = await store.snapshot();
      const observations = snapshot.agentSettingsObservations.filter(
        (observation) => observation.sessionId === session.id
      );
      const initial = observations.find(
        (observation) => observation.source === 'THREAD_START_RESPONSE'
      );
      const resolved = observations.find(
        (observation) => observation.source === 'TASK_MONKI_RESOLUTION'
      );
      expect(initial).toMatchObject({
        settings: { model: 'grok-composer-2.5-fast', modelProvider: 'xai' },
        rawMessage: { direction: 'INBOUND' }
      });
      expect(resolved).toMatchObject({
        settings: { model: 'grok-build', modelProvider: 'xai' },
        rawMessage: { direction: 'INBOUND' },
        detail: expect.stringContaining('not a provider settings observation')
      });
      expect(resolved!.rawMessage!.sequence).toBeGreaterThan(
        initial!.rawMessage!.sequence
      );

      const server = snapshot.agentServers.find(
        (candidate) => candidate.id === initial!.rawMessage!.serverInstanceId
      );
      expect(server).toBeDefined();
      const journalRecords = (await fs.readFile(server!.protocolJournalPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { sequence: number; raw: string });
      const referencedMessage = (sequence: number) =>
        JSON.parse(
          journalRecords.find((record) => record.sequence === sequence)!.raw
        ) as Record<string, unknown>;
      expect(referencedMessage(initial!.rawMessage!.sequence)).toMatchObject({
        result: {
          sessionId: 'provider-session-1',
          models: { currentModelId: 'grok-composer-2.5-fast' }
        }
      });
      expect(referencedMessage(resolved!.rawMessage!.sequence)).toMatchObject({
        result: { _meta: { model: { Ok: 'grok-build' } } }
      });
    } finally {
      await adapter.shutdown();
    }
  });

  it('drains accepted old-client work before binding a replacement process', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-acp-replacement-fence-')
    );
    temporaryDirectories.push(directory);
    const agentScript = path.join(directory, 'replacement-agent.cjs');
    const generationFile = path.join(directory, 'generation.txt');
    await fs.writeFile(agentScript, replacementFenceAgentSource(generationFile), {
      mode: 0o600
    });
    const runtimeId = 'test-acp-replacement-fence';
    const profile: AcpRuntimeProfile = {
      ...TEST_ACP_PROFILE,
      descriptor: { ...TEST_ACP_PROFILE.descriptor, id: runtimeId },
      executableCandidates: [process.execPath],
      argv: [agentScript]
    };
    const store = new FileTaskStore(path.join(directory, 'store'));
    const adapter = new AcpRuntimeAdapter(store, new AppEventBus(), profile, {
      cwd: directory,
      requestTimeoutMs: 1_000,
      runtimeResolver: async () => ({
        executable: process.execPath,
        version: process.version,
        diagnostics: {
          selectedExecutable: process.execPath,
          selectedSource: 'test',
          selectedVersion: process.version,
          selectedLaunchArgv: [agentScript],
          requiredCapabilities: ['ACP protocolVersion=1'],
          probes: []
        }
      })
    });
    const settings = {
      runtimeId,
      model: 'default',
      modelProvider: 'test-provider',
      sandbox: 'DANGER_FULL_ACCESS' as const,
      networkAccess: true,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user' as const
    };
    const task = await store.createTask({
      title: 'ACP replacement fence',
      prompt: 'Persist accepted output before replacement.',
      repositoryPath: directory,
      runtimeId,
      agentSettings: settings
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/acp-replacement-fence',
      worktreePath: directory,
      baseSha: 'base'
    });
    const session = await store.createAgentSession({
      task,
      iteration,
      worktree,
      runtimeId,
      requestedSettings: settings
    });
    const run = await store.createRun({
      task,
      session,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      requestedSettings: settings
    });
    const lookupSession = store.getAgentSessionByProviderId.bind(store);
    let releaseMaterialization!: () => void;
    const materializationGate = new Promise<void>((resolve) => {
      releaseMaterialization = resolve;
    });
    let materializationEntered!: () => void;
    const acceptedMaterialization = new Promise<void>((resolve) => {
      materializationEntered = resolve;
    });
    let gatePending = true;
    const lookupSpy = vi
      .spyOn(store, 'getAgentSessionByProviderId')
      .mockImplementation(async (requestedRuntimeId, providerSessionId) => {
        if (providerSessionId === 'replacement-fence-session' && gatePending) {
          gatePending = false;
          materializationEntered();
          await materializationGate;
        }
        return lookupSession(requestedRuntimeId, providerSessionId);
      });
    let releaseLossReconciliation: () => void = () => undefined;
    let snapshotSpy: { mockRestore(): void } | undefined;

    try {
      await adapter.initialize();
      await adapter.startTurn({
        localRunId: run.id,
        session: { localSessionId: session.id },
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        authoritativeGoal: task.prompt,
        settings,
        attachments: []
      });
      await acceptedMaterialization;
      const firstServer = await waitFor(async () =>
        (await store.snapshot()).agentServers.find((server) => server.status === 'LOST')
      );
      const internals = adapter as unknown as {
        ensureClient(): Promise<AcpRpcClient>;
        inboundQueue: Promise<void>;
        boundClient?: AcpRpcClient;
      };
      let lossReconciliationEntered!: () => void;
      const lossReconciliation = new Promise<void>((resolve) => {
        lossReconciliationEntered = resolve;
      });
      const readSnapshot = store.snapshot.bind(store);
      let lossGatePending = true;
      snapshotSpy = vi.spyOn(store, 'snapshot').mockImplementation(async () => {
        if (lossGatePending && internals.boundClient === undefined) {
          lossGatePending = false;
          lossReconciliationEntered();
          await new Promise<void>((resolve) => {
            releaseLossReconciliation = resolve;
          });
        }
        return readSnapshot();
      });
      const replacement = internals.ensureClient();
      const startedBeforeDrain = await Promise.race([
        replacement.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 200))
      ]);

      expect(startedBeforeDrain).toBe(false);
      expect(await fs.readFile(generationFile, 'utf8')).toBe('1');
      releaseMaterialization();
      await lossReconciliation;
      const startedDuringLoss = await Promise.race([
        replacement.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 100))
      ]);
      expect(startedDuringLoss).toBe(false);
      expect(await fs.readFile(generationFile, 'utf8')).toBe('1');
      releaseLossReconciliation();
      const replacementClient = await replacement;
      await internals.inboundQueue;

      const snapshot = await store.snapshot();
      const acceptedItems = snapshot.agentItems.filter(
        (item) => item.runId === run.id && item.providerItemId === 'accepted-old-message'
      );
      const outputArtifact = snapshot.artifacts.find(
        (artifact) => artifact.id === run.outputArtifactId
      );
      const output = outputArtifact ? await fs.readFile(outputArtifact.path, 'utf8') : '';

      expect(replacementClient.serverInstanceId).not.toBe(firstServer.id);
      expect(await fs.readFile(generationFile, 'utf8')).toBe('2');
      expect(acceptedItems).toHaveLength(1);
      expect(itemPayloadText(acceptedItems[0])).toBe('accepted old generation output');
      expect(output.split('accepted old generation output')).toHaveLength(2);
    } finally {
      releaseMaterialization();
      releaseLossReconciliation();
      snapshotSpy?.mockRestore();
      lookupSpy.mockRestore();
      await adapter.shutdown();
    }
  });

  it('runs session -> prompt -> stream -> exact permission -> terminal without client tools', async () => {
    const opaqueProviderSecret = 'm7Qp4Vz9Lk2Nc8';
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-adapter-'));
    temporaryDirectories.push(directory);
    const agentScript = path.join(directory, 'agent.cjs');
    await fs.writeFile(agentScript, fakeAgentSource(directory), { mode: 0o600 });
    const profile: AcpRuntimeProfile = {
      ...TEST_ACP_PROFILE,
      descriptor: { ...TEST_ACP_PROFILE.descriptor, id: 'test-acp' },
      defaultModelProvider: 'xai',
      defaultModel: 'grok-build',
      sessionModelExtension: GROK_SESSION_MODEL_EXTENSION,
      executableCandidates: [process.execPath],
      argv: [agentScript],
      environmentPolicy: {
        contractId: 'task-monki/test-acp-environment@v1',
        allowedKeys: ['GEMINI_API_KEY'],
        sensitiveKeys: ['GEMINI_API_KEY']
      }
    };
    const store = new FileTaskStore(path.join(directory, 'store'));
    const events = new AppEventBus();
    const observedEvents: Array<{ type: string; payload: unknown; runId?: string }> = [];
    events.on((event) => observedEvents.push(event));
    let resolutionCalls = 0;
    const resolvedExecutableOverrides: Array<string | undefined> = [];
    const adapter = new AcpRuntimeAdapter(store, events, profile, {
      cwd: directory,
      environment: { ...process.env, GEMINI_API_KEY: opaqueProviderSecret },
      // Keep control calls bounded without making child startup sensitive to
      // full-suite scheduler contention. AcpRpcClient.test.ts proves that
      // prompt completion can explicitly outlive this bound.
      requestTimeoutMs: 2_000,
      interruptCompletionTimeoutMs: 25,
      runtimeResolver: async (_runtimeProfile, options) => {
        resolutionCalls += 1;
        resolvedExecutableOverrides.push(options.executable);
        return {
          executable: process.execPath,
          version: process.version,
          diagnostics: {
            selectedExecutable: process.execPath,
            selectedSource: 'test',
            selectedVersion: process.version,
            selectedLaunchArgv: [agentScript],
            requiredCapabilities: ['ACP protocolVersion=1'],
            probes: []
          }
        };
      }
    });
    const settings = {
      runtimeId: 'test-acp',
      model: 'grok-composer-2.5-fast',
      modelProvider: 'xai',
      sandbox: 'DANGER_FULL_ACCESS' as const,
      networkAccess: true,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user' as const
    };
    const task = await store.createTask({
      title: 'ACP integration',
      prompt: 'Implement the requested change.',
      repositoryPath: directory,
      runtimeId: 'test-acp',
      agentSettings: settings
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/acp-integration',
      worktreePath: directory,
      baseSha: 'base'
    });
    const localSession = await store.createAgentSession({
      task,
      iteration,
      worktree,
      runtimeId: 'test-acp',
      requestedSettings: settings
    });

    try {
      await adapter.configureRuntime({ executable: process.execPath, restart: false });
      await expect(
        adapter.resolveExecution({ settings, attachments: [{ kind: 'text' }] })
      ).rejects.toThrow('managed attachments are unavailable');
      expect(resolutionCalls).toBe(0);
      await adapter.initialize();
      expect(await adapter.preflight()).toMatchObject({
        readiness: {
          status: 'DISCOVERED',
          canStart: true,
          checks: {
            discovery: 'FOUND',
            compatibility: 'UNKNOWN',
            initialization: 'NOT_STARTED'
          }
        }
      });
      await expect(adapter.listModels()).resolves.toEqual([
        expect.objectContaining({
          id: 'test-acp:xai/grok-composer-2.5-fast',
          model: 'grok-composer-2.5-fast',
          isDefault: false
        }),
        expect.objectContaining({
          id: 'test-acp:xai/grok-build',
          model: 'grok-build',
          isDefault: true
        })
      ]);
      await expect(
        adapter.resolveExecution({
          settings: { ...settings, model: undefined },
          attachments: []
        })
      ).resolves.toMatchObject({
        settings: { model: 'grok-build', modelProvider: 'xai' },
        model: { model: 'grok-build', isDefault: true }
      });
      await expect(
        adapter.resolveExecution({ settings, attachments: [] })
      ).resolves.toMatchObject({
        settings: {
          model: 'grok-composer-2.5-fast',
          modelProvider: 'xai'
        },
        model: { model: 'grok-composer-2.5-fast', isDefault: false }
      });
      await expect(
        adapter.resolveExecution({
          settings: { ...settings, model: 'not-advertised' },
          attachments: []
        })
      ).rejects.toThrow(
        'did not advertise model not-advertised in its grok-build-acp/session-models@v1 provider catalog'
      );
      await expect(
        adapter.resolveExecution({
          settings: {
            ...settings,
            model: undefined,
            modelProvider: 'not-advertised'
          },
          attachments: []
        })
      ).rejects.toThrow('models are owned by provider xai, not not-advertised');
      await expect(
        adapter.resolveExecution({
          settings: { ...settings, reasoningEffort: 'low' },
          attachments: []
        })
      ).rejects.toThrow('does not advertise reasoning effort low');
      const resolutionSnapshot = await store.snapshot();
      expect(resolutionSnapshot.agentServers).toHaveLength(1);
      const resolutionJournal = await fs.readFile(
        resolutionSnapshot.agentServers[0]!.protocolJournalPath,
        'utf8'
      );
      const resolutionMethods = resolutionJournal
        .trim()
        .split('\n')
        .map((line) => JSON.parse(JSON.parse(line).raw) as { method?: string })
        .map((message) => message.method)
        .filter((method): method is string => Boolean(method));
      expect(
        resolutionMethods.filter((method) =>
          ['session/new', 'session/prompt', 'session/set_model'].includes(method)
        )
      ).toEqual([]);
      expect(resolutionCalls).toBe(1);
      expect(resolvedExecutableOverrides).toEqual([process.execPath]);
      const attachmentRun = await store.createRun({
        task,
        session: localSession,
        mode: 'IMPLEMENTATION',
        prompt: 'Must reject before provider session creation.',
        requestedSettings: settings
      });
      await expect(
        adapter.startTurn({
          localRunId: attachmentRun.id,
          session: { localSessionId: localSession.id },
          mode: 'IMPLEMENTATION',
          prompt: 'Must reject before provider session creation.',
          authoritativeGoal: task.prompt,
          settings,
          attachments: [
            {
              attachmentId: 'attachment-unsupported',
              ordinal: 0,
              displayName: 'unsupported.txt',
              kind: 'text',
              mediaType: 'text/plain',
              byteCount: 1,
              sha256: '0'.repeat(64),
              path: path.join(directory, 'not-read.txt'),
              verifiedAt: new Date().toISOString()
            }
          ]
        })
      ).rejects.toThrow('managed attachments are unavailable');
      expect((await store.getAgentSession(localSession.id))?.providerSessionId).toBeUndefined();
      expect((await store.snapshot()).agentServers).toHaveLength(1);
      await store.updateRun(attachmentRun.id, {
        status: 'FAILED',
        endedAt: new Date().toISOString()
      });
      const originalSessionUpdate = store.updateAgentSession.bind(store);
      let failProviderOwnershipPersistence = true;
      store.updateAgentSession = (async (id, update) => {
        if (failProviderOwnershipPersistence && update.providerSessionId) {
          failProviderOwnershipPersistence = false;
          throw new Error('injected provider ownership persistence failure');
        }
        return originalSessionUpdate(id, update);
      }) as typeof store.updateAgentSession;
      try {
        await expect(
          adapter.createSession({
            runtimeId: 'test-acp',
            localSessionId: localSession.id,
            taskId: task.id,
            iterationId: iteration.id,
            worktreeId: worktree.id,
            worktreePath: worktree.worktreePath,
            settings
          })
        ).rejects.toBeInstanceOf(AgentMutationAmbiguousError);
      } finally {
        store.updateAgentSession = originalSessionUpdate;
      }
      const quarantinedOwnershipServer = (await store.snapshot()).agentServers[0];
      expect(quarantinedOwnershipServer).toMatchObject({ status: 'EXITED' });
      expect((await store.getAgentSession(localSession.id))?.providerSessionId).toBeUndefined();
      const session = await adapter.createSession({
        runtimeId: 'test-acp',
        localSessionId: localSession.id,
        taskId: task.id,
        iterationId: iteration.id,
        worktreeId: worktree.id,
        worktreePath: worktree.worktreePath,
        settings
      });
      expect(session).toMatchObject({
        providerSessionId: 'provider-session-1',
        runtimeId: 'test-acp',
        status: 'IDLE',
        observedSettings: { model: 'grok-composer-2.5-fast' }
      });
      expect(await adapter.preflight()).toMatchObject({
        readiness: {
          status: 'READY',
          canStart: true,
          checks: {
            compatibility: 'COMPATIBLE',
            initialization: 'INITIALIZED',
            authentication: 'PROVIDER_MANAGED',
            modelCatalog: 'AVAILABLE'
          }
        }
      });
      const unsupportedReasoningRun = await store.createRun({
        task,
        session,
        mode: 'FOLLOW_UP',
        prompt: 'Do not submit without a native reasoning selector.',
        requestedSettings: { ...settings, reasoningEffort: 'low' }
      });
      const promptCountBeforeReasoningRejection = await protocolMethodCount(
        store,
        'session/prompt'
      );
      await expect(
        adapter.startTurn({
          localRunId: unsupportedReasoningRun.id,
          session: { localSessionId: session.id },
          mode: 'FOLLOW_UP',
          prompt: 'Do not submit without a native reasoning selector.',
          authoritativeGoal: task.prompt,
          settings: { ...settings, reasoningEffort: 'low' },
          attachments: []
        })
      ).rejects.toThrow('did not advertise reasoning effort low');
      expect(
        await protocolMethodCount(store, 'session/prompt')
      ).toBe(promptCountBeforeReasoningRejection);
      await store.updateRun(unsupportedReasoningRun.id, {
        status: 'FAILED',
        endedAt: new Date().toISOString()
      });
      const creationServers = (await store.snapshot()).agentServers;
      expect(creationServers).toHaveLength(2);
      const activeCreationServer = creationServers.find((server) => server.status === 'READY');
      expect(activeCreationServer).toBeDefined();
      const creationJournal = await fs.readFile(
        activeCreationServer!.protocolJournalPath,
        'utf8'
      );
      expect(
        creationJournal
          .trim()
          .split('\n')
          .map((line) => JSON.parse(JSON.parse(line).raw) as { method?: string })
          .filter((message) => message.method === 'session/resume')
      ).toHaveLength(1);
      expect(
        creationJournal
          .trim()
          .split('\n')
          .map((line) => JSON.parse(JSON.parse(line).raw))
      ).toContainEqual({
        jsonrpc: '2.0',
        id: expect.any(Number),
        method: 'session/set_model',
        params: {
          sessionId: 'provider-session-1',
          modelId: 'grok-composer-2.5-fast'
        }
      });
      await expect(adapter.listModels()).resolves.toEqual([
        expect.objectContaining({
          id: 'test-acp:xai/grok-composer-2.5-fast',
          model: 'grok-composer-2.5-fast',
          isDefault: false,
          native: expect.objectContaining({
            source: 'provider-model-extension'
          })
        }),
        expect.objectContaining({
          id: 'test-acp:xai/grok-build',
          model: 'grok-build',
          isDefault: true,
          native: expect.objectContaining({
            source: 'provider-model-extension'
          })
        })
      ]);
      const sessionNativeState = JSON.stringify(await adapter.readNativeState());
      expect(sessionNativeState).toContain('grok-composer-2.5-fast');
      expect(sessionNativeState).toContain('grok-build');
      await expect(adapter.capabilities()).resolves.toMatchObject({
        extensions: {
          nativeSessionModels: {
            maturity: 'experimental',
            detail: expect.stringContaining('grok-build-acp/session-models@v1')
          }
        }
      });
      const [initialControls] = await adapter.listSessionControls();
      expect(initialControls).toMatchObject({
        localSessionId: session.id,
        providerSessionId: session.providerSessionId,
        controls: expect.arrayContaining([
          expect.objectContaining({ id: 'model', kind: 'SELECT' }),
          expect.objectContaining({ id: 'mode', kind: 'SELECT' }),
          expect.objectContaining({ id: 'config:telemetry', kind: 'BOOLEAN' })
        ])
      });
      expect(initialControls?.controls.map((control) => control.id)).not.toContain(
        'config:model'
      );
      await expect(adapter.applySessionControl({
        localSessionId: session.id,
        controlId: 'model',
        value: 'not-advertised',
        revision: initialControls!.revision
      })).rejects.toThrow('invalid choice');
      await expect(adapter.applySessionControl({
        localSessionId: session.id,
        controlId: 'model',
        value: 'grok-build',
        revision: 'stale-revision'
      })).rejects.toThrow('controls changed');
      const modelUpdate = await adapter.applySessionControl({
        localSessionId: session.id,
        controlId: 'model',
        value: 'grok-build',
        revision: initialControls!.revision
      });
      expect(modelUpdate.native).toMatchObject({
        models: { currentModelId: 'grok-build' }
      });
      expect(await store.getAgentSession(session.id)).toMatchObject({
        observedSettings: {
          model: 'grok-build',
          runtimeOptions: {
            'test-acp': { models: { currentModelId: 'grok-build' } }
          }
        }
      });
      expect(observedEvents).toContainEqual(
        expect.objectContaining({
          type: 'runtime.updated',
          payload: expect.objectContaining({
            nativeSessions: expect.arrayContaining([
              expect.objectContaining({
                models: expect.objectContaining({ currentModelId: 'grok-build' })
              })
            ])
          })
        })
      );
      const modeUpdate = await adapter.applySessionControl({
        localSessionId: session.id,
        controlId: 'mode',
        value: 'plan',
        revision: modelUpdate.controls.revision
      });
      expect(modeUpdate.native).toMatchObject({ modes: { currentModeId: 'plan' } });
      const telemetryUpdate = await adapter.applySessionControl({
        localSessionId: session.id,
        controlId: 'config:telemetry',
        value: false,
        revision: modeUpdate.controls.revision
      });
      expect(telemetryUpdate.native).toMatchObject({
        configOptions: expect.arrayContaining([
          expect.objectContaining({ id: 'telemetry', currentValue: false })
        ])
      });
      const turnSettings = {
        ...settings,
        runtimeOptions: {
          'test-acp': {
            modeId: 'code',
            configValues: { telemetry: true }
          }
        }
      };
      const unsafePermissionRun = await store.createRun({
        task,
        session: (await store.getAgentSession(session.id))!,
        mode: 'FOLLOW_UP',
        prompt: 'unsafe permission identifiers',
        requestedSettings: turnSettings
      });
      await adapter.startTurn({
        localRunId: unsafePermissionRun.id,
        session: { localSessionId: session.id, providerSessionId: session.providerSessionId },
        mode: 'FOLLOW_UP',
        prompt: 'unsafe permission identifiers',
        authoritativeGoal: task.prompt,
        settings: turnSettings
      });
      await waitFor(async () =>
        (await store.getRun(unsafePermissionRun.id))?.status === 'COMPLETED'
          ? true
          : undefined
      );
      expect(
        (await store.snapshot()).interactionRequests.filter(
          (interaction) => interaction.runId === unsafePermissionRun.id
        )
      ).toHaveLength(0);
      expect(await adapter.readNativeState()).toMatchObject({
        sessions: [
          expect.objectContaining({
            models: expect.objectContaining({
              currentModelId: 'grok-composer-2.5-fast'
            }),
            modes: expect.objectContaining({ currentModeId: 'code' }),
            configOptions: expect.arrayContaining([
              expect.objectContaining({ id: 'telemetry', currentValue: true })
            ])
          })
        ]
      });
      const delayedRun = await store.createRun({
        task,
        session: (await store.getAgentSession(session.id))!,
        mode: 'FOLLOW_UP',
        prompt: 'delayed terminal',
        requestedSettings: settings
      });
      await adapter.startTurn({
        localRunId: delayedRun.id,
        session: { localSessionId: session.id, providerSessionId: session.providerSessionId },
        mode: 'FOLLOW_UP',
        prompt: 'delayed terminal',
        authoritativeGoal: task.prompt,
        settings
      });
      await waitFor(async () => {
        const current = await store.getRun(delayedRun.id);
        return current?.status === 'COMPLETED' ? current : undefined;
      });
      await adapter.releaseSession({
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      });
      expect((await store.getAgentSession(session.id))?.status).toBe('NOT_LOADED');
      expect(await adapter.readNativeState()).toMatchObject({
        sessions: [
          expect.objectContaining({
            localSessionId: session.id,
            providerSessionId: session.providerSessionId,
            models: expect.objectContaining({
              currentModelId: 'grok-composer-2.5-fast'
            }),
            modes: expect.objectContaining({ currentModeId: 'code' }),
            configOptions: expect.arrayContaining([
              expect.objectContaining({ id: 'telemetry', currentValue: true })
            ])
          })
        ]
      });
      const run = await store.createRun({
        task,
        session: (await store.getAgentSession(session.id))!,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        requestedSettings: settings
      });
      const turn = await adapter.startTurn({
        localRunId: run.id,
        session: { localSessionId: session.id, providerSessionId: session.providerSessionId },
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        authoritativeGoal: task.prompt,
        settings
      });
      expect(turn.providerTurnId).toContain(':');

      const pending = await waitFor(async () =>
        (await store.snapshot()).interactionRequests.find(
          (interaction) => interaction.runId === run.id && interaction.status === 'PENDING'
        )
      );
      expect(pending.allowedActions).toEqual(['ACCEPT', 'DECLINE', 'CANCEL']);
      expect('providerOptions' in pending.request && pending.request.providerOptions).toEqual([
        { id: 'native-allow-42', label: 'Allow once', kind: 'allow_once' },
        { id: 'native-reject-7', label: 'Reject', kind: 'reject_once' }
      ]);
      await expect(
        adapter.releaseSession({
          localSessionId: session.id,
          providerSessionId: session.providerSessionId
        })
      ).rejects.toThrow('while run');
      const originalServerId = (await store.snapshot()).agentServers.find(
        (server) => server.status === 'RUNNING'
      )!.id;
      await adapter.configureRuntime({
        executable: '/deferred/custom-acp',
        restart: true
      });
      expect((await store.getAgentServer(originalServerId))?.status).toBe('RUNNING');
      const interactionService = new AgentInteractionService(store, events, () => adapter);
      await interactionService.respond({
        taskId: task.id,
        runId: run.id,
        interactionRequestId: pending.id,
        decision: { interactionType: 'COMMAND_APPROVAL', action: 'ACCEPT' }
      });

      const completed = await waitFor(async () => {
        const current = await store.getRun(run.id);
        return current?.status === 'COMPLETED' ? current : undefined;
      });
      expect(completed.finalMessage).toBe('Implemented safely.');
      const snapshot = await store.snapshot();
      expect(snapshot.agentPlanRevisions).toEqual([
        expect.objectContaining({
          runId: run.id,
          steps: [{ step: 'Implement', status: 'IN_PROGRESS' }]
        })
      ]);
      expect(
        snapshot.events.filter(
          (event) =>
            event.type === 'AGENT_ACTIVITY_RECEIVED' &&
            event.runId === run.id &&
            typeof event.payload === 'object' &&
            event.payload !== null &&
            'eventType' in event.payload &&
            event.payload.eventType === 'agent_message_chunk'
        )
      ).toHaveLength(1);
      expect(
        snapshot.events.filter(
          (event) =>
            event.type === 'AGENT_INTERACTION_RESOLVED' && event.runId === run.id
        )
      ).toHaveLength(1);
      const journal = await fs.readFile(
        snapshot.agentServers.find((server) => server.id === originalServerId)!.protocolJournalPath,
        'utf8'
      );
      const messages = journal
        .trim()
        .split('\n')
        .map((line) => JSON.parse(JSON.parse(line).raw));
      expect(messages).toContainEqual({
        jsonrpc: '2.0',
        id: 'permission-native-1',
        result: { outcome: { outcome: 'selected', optionId: 'native-allow-42' } }
      });
      await waitFor(async () =>
        observedEvents.some(
          (event) =>
            event.type === 'run.terminal' &&
            typeof event.payload === 'object' &&
            event.payload !== null &&
            'status' in event.payload &&
            event.payload.status === 'completed'
        )
          ? true
          : undefined,
        // Recovery is durable before application-scoped process quarantine
        // finishes. Allow the real child close handler enough wall-clock time
        // when the full Vitest matrix is scheduling other process-heavy suites.
        20_000
      );
      expect(await adapter.readNativeState()).toMatchObject({
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          session: { configOptions: { boolean: {} } }
        }
      });
      await waitFor(async () =>
        (await store.getAgentServer(originalServerId))?.status === 'EXITED'
          ? true
          : undefined
      );
      await waitFor(async () => {
        await adapter.preflight();
        return resolutionCalls === 2 ? true : undefined;
      });
      expect(resolvedExecutableOverrides.at(-1)).toBe('/deferred/custom-acp');

      const highVolumeRun = await store.createRun({
        task,
        session: (await store.getAgentSession(session.id))!,
        mode: 'FOLLOW_UP',
        prompt: 'high volume stream',
        requestedSettings: settings
      });
      const expectedHighVolumeOutput = Array.from(
        { length: 512 },
        (_, index) => String(index).padStart(4, '0')
      ).join('');
      const originalUpsertAgentItem = store.upsertAgentItem.bind(store);
      let highVolumeItemWrites = 0;
      store.upsertAgentItem = (async (input) => {
        if (input.runId === highVolumeRun.id && input.providerItemId === 'message-high-volume') {
          highVolumeItemWrites += 1;
        }
        return originalUpsertAgentItem(input);
      }) as typeof store.upsertAgentItem;
      try {
        await adapter.startTurn({
          localRunId: highVolumeRun.id,
          session: { localSessionId: session.id, providerSessionId: session.providerSessionId },
          mode: 'FOLLOW_UP',
          prompt: 'high volume stream',
          authoritativeGoal: task.prompt,
          settings
        });
        await waitFor(async () => {
          const current = await store.getRun(highVolumeRun.id);
          return current?.status === 'COMPLETED' ? current : undefined;
        }, 30_000);
      } finally {
        store.upsertAgentItem = originalUpsertAgentItem;
      }
      expect(highVolumeItemWrites).toBe(1);
      expect(
        itemPayloadText(
          await store.getAgentItemByProviderId(highVolumeRun.id, 'message-high-volume')
        )
      ).toBe(expectedHighVolumeOutput);
      const highVolumeSnapshot = await store.snapshot();
      expect(
        highVolumeSnapshot.events.filter(
          (event) =>
            event.type === 'AGENT_ACTIVITY_RECEIVED' &&
            event.runId === highVolumeRun.id &&
            typeof event.payload === 'object' &&
            event.payload !== null &&
            'eventType' in event.payload &&
            event.payload.eventType === 'agent_message_chunk'
        )
      ).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ coalescedEvents: 512 })
        })
      ]);
      const highVolumeOutputEvents = observedEvents.filter(
        (event) =>
          event.type === 'run.output' &&
          typeof event.payload === 'object' &&
          event.payload !== null &&
          'text' in event.payload &&
          event.payload.text !== undefined &&
          highVolumeRun.id === event.runId
      );
      // The 75 ms flush boundary is scheduler-dependent under parallel I/O,
      // but it must still collapse at least eight wire deltas per UI event on
      // average for this burst.
      expect(highVolumeOutputEvents.length).toBeLessThanOrEqual(64);
      expect(
        highVolumeOutputEvents
          .map((event) => (event.payload as { text: string }).text)
          .join('')
      ).toBe(expectedHighVolumeOutput);
      const highVolumeArtifact = highVolumeSnapshot.artifacts.find(
        (artifact) => artifact.id === highVolumeRun.outputArtifactId
      );
      expect(highVolumeArtifact).toBeDefined();
      expect(await fs.readFile(highVolumeArtifact!.path, 'utf8')).toBe(expectedHighVolumeOutput);
      const highVolumeJournalMessages = (
        await Promise.all(
          highVolumeSnapshot.agentServers.map((server) =>
            fs.readFile(server.protocolJournalPath, 'utf8')
          )
        )
      ).flatMap((journal) =>
        journal
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(JSON.parse(line).raw) as {
            method?: string;
            params?: { update?: { messageId?: string } };
          })
      );
      expect(
        highVolumeJournalMessages.filter(
          (message) =>
            message.method === 'session/update' &&
            message.params?.update?.messageId === 'message-high-volume'
        )
      ).toHaveLength(512);

      const persistenceRun = await store.createRun({
        task,
        session: (await store.getAgentSession(session.id))!,
        mode: 'FOLLOW_UP',
        prompt: 'persistence failure after permission delivery',
        requestedSettings: settings
      });
      await adapter.startTurn({
        localRunId: persistenceRun.id,
        session: { localSessionId: session.id, providerSessionId: session.providerSessionId },
        mode: 'FOLLOW_UP',
        prompt: 'persistence failure after permission delivery',
        authoritativeGoal: task.prompt,
        settings
      });
      const persistenceInteraction = await waitFor(async () =>
        (await store.snapshot()).interactionRequests.find(
          (interaction) =>
            interaction.runId === persistenceRun.id && interaction.status === 'PENDING'
        )
      );
      const originalTransition = store.transitionInteractionRequest.bind(store);
      let injected = false;
      store.transitionInteractionRequest = (async (id, expected, update) => {
        if (!injected && expected === 'RESPONDING' && update.status === 'RESOLVED') {
          injected = true;
          throw new Error('injected completion persistence failure');
        }
        return originalTransition(id, expected, update);
      }) as typeof store.transitionInteractionRequest;
      try {
        await expect(
          interactionService.respond({
            taskId: task.id,
            runId: persistenceRun.id,
            interactionRequestId: persistenceInteraction.id,
            decision: { interactionType: 'COMMAND_APPROVAL', action: 'ACCEPT' }
          })
        ).rejects.toBeInstanceOf(AgentMutationAmbiguousError);
      } finally {
        store.transitionInteractionRequest = originalTransition;
      }
      const staleInteraction = await store.getInteractionRequest(persistenceInteraction.id);
      expect(staleInteraction?.status).toBe('STALE');
      await waitFor(async () => {
        const current = await store.getRun(persistenceRun.id);
        return current?.status === 'RECOVERY_REQUIRED' ? current : undefined;
      });
      await store.updateRun(persistenceRun.id, {
        status: 'INTERRUPTED',
        endedAt: new Date().toISOString()
      });
      await store.updateAgentSession(session.id, { status: 'IDLE' });

      const failedRun = await store.createRun({
        task,
        session: (await store.getAgentSession(session.id))!,
        mode: 'FOLLOW_UP',
        prompt: 'definitive failure',
        requestedSettings: settings
      });
      await adapter.startTurn({
        localRunId: failedRun.id,
        session: { localSessionId: session.id, providerSessionId: session.providerSessionId },
        mode: 'FOLLOW_UP',
        prompt: 'definitive failure',
        authoritativeGoal: task.prompt,
        settings
      });
      await waitFor(async () => {
        const current = await store.getRun(failedRun.id);
        return current?.status === 'FAILED' ? current : undefined;
      });
      await waitFor(async () =>
        observedEvents.some(
          (event) =>
            event.type === 'run.terminal' &&
            typeof event.payload === 'object' &&
            event.payload !== null &&
            'status' in event.payload &&
            event.payload.status === 'failed'
        )
          ? true
          : undefined
      );
      expect(
        (await store.snapshot()).interactionRequests.filter(
          (interaction) =>
            interaction.runId === failedRun.id &&
            ['PENDING', 'RESPONDING'].includes(interaction.status)
        )
      ).toHaveLength(0);
      const failedRecord = (await store.getRun(failedRun.id))!;
      const failedArtifact = (await store.snapshot()).artifacts.find(
        (artifact) => artifact.id === failedRecord.finalArtifactId
      );
      expect(failedArtifact).toBeDefined();
      const failedArtifactBody = await fs.readFile(failedArtifact!.path, 'utf8');
      const failedEvents = (await store.snapshot()).events.filter(
        (event) => event.runId === failedRun.id
      );
      expect(failedArtifactBody).toContain('[REDACTED]');
      expect(failedArtifactBody).not.toContain(opaqueProviderSecret);
      expect(JSON.stringify(failedEvents)).not.toContain(opaqueProviderSecret);
      expect(JSON.stringify(observedEvents)).not.toContain(opaqueProviderSecret);
      const failedServer = (await store.snapshot()).agentServers.find(
        (server) => server.id === failedRecord.serverInstanceId
      );
      expect(failedServer).toBeDefined();
      const failedJournal = await fs.readFile(failedServer!.protocolJournalPath, 'utf8');
      expect(failedJournal).not.toContain(opaqueProviderSecret);

      const tokenLimitedRun = await store.createRun({
        task,
        session: (await store.getAgentSession(session.id))!,
        mode: 'FOLLOW_UP',
        prompt: 'token limit terminal',
        requestedSettings: settings
      });
      await adapter.startTurn({
        localRunId: tokenLimitedRun.id,
        session: { localSessionId: session.id, providerSessionId: session.providerSessionId },
        mode: 'FOLLOW_UP',
        prompt: 'token limit terminal',
        authoritativeGoal: task.prompt,
        settings
      });
      const tokenLimited = await waitFor(async () => {
        const current = await store.getRun(tokenLimitedRun.id);
        return current?.status === 'FAILED' ? current : undefined;
      });
      expect(tokenLimited.terminalReason).toBe(
        'The ACP agent reached its token limit before completing the turn.'
      );
      const tokenLimitArtifact = (await store.snapshot()).artifacts.find(
        (artifact) => artifact.id === tokenLimited.finalArtifactId
      );
      expect(await fs.readFile(tokenLimitArtifact!.path, 'utf8')).toContain(
        'Failure: The ACP agent reached its token limit before completing the turn.'
      );

      const malformedRun = await store.createRun({
        task,
        session: (await store.getAgentSession(session.id))!,
        mode: 'FOLLOW_UP',
        prompt: 'malformed terminal response',
        requestedSettings: settings
      });
      await adapter.startTurn({
        localRunId: malformedRun.id,
        session: { localSessionId: session.id, providerSessionId: session.providerSessionId },
        mode: 'FOLLOW_UP',
        prompt: 'malformed terminal response',
        authoritativeGoal: task.prompt,
        settings
      });
      await waitFor(async () => {
        const current = await store.getRun(malformedRun.id);
        return current?.status === 'FAILED' ? current : undefined;
      });
      expect(
        (await store.snapshot()).events.some(
          (event) => event.type === 'AGENT_PROTOCOL_INCIDENT' && event.runId === malformedRun.id
        )
      ).toBe(true);
      await adapter.releaseTask(task.id);
      expect((await store.getAgentSession(session.id))?.status).toBe('NOT_LOADED');
      expect((await store.snapshot()).agentServers[0]?.status).toBe('EXITED');

      const interruptedRun = await store.createRun({
        task,
        session: (await store.getAgentSession(session.id))!,
        mode: 'FOLLOW_UP',
        prompt: 'hang for interrupt',
        requestedSettings: settings
      });
      const interruptedTurn = await adapter.startTurn({
        localRunId: interruptedRun.id,
        session: { localSessionId: session.id, providerSessionId: session.providerSessionId },
        mode: 'FOLLOW_UP',
        prompt: 'hang for interrupt',
        authoritativeGoal: task.prompt,
        settings
      });
      expect(interruptedTurn.providerTurnId).toBeDefined();
      const quarantinedClient = (adapter as unknown as { boundClient?: AcpRpcClient })
        .boundClient;
      expect(quarantinedClient).toBeDefined();
      await adapter.interruptTurn({
        session: { localSessionId: session.id, providerSessionId: session.providerSessionId },
        providerTurnId: interruptedTurn.providerTurnId!
      });
      await waitFor(async () => {
        const current = await store.getRun(interruptedRun.id);
        return current?.status === 'RECOVERY_REQUIRED' ? current : undefined;
      });
      await waitFor(async () =>
        observedEvents.some(
          (event) =>
            event.type === 'run.activity' &&
            typeof event.payload === 'object' &&
            event.payload !== null &&
            'eventType' in event.payload &&
            event.payload.eventType === 'session/cancel/ambiguous'
        )
          ? true
          : undefined
      );
      expect((await store.getAgentSession(session.id))?.status).toBe('NOT_LOADED');
      const quarantinedServerId = (await store.getRun(interruptedRun.id))?.serverInstanceId;
      expect(quarantinedServerId).toBeDefined();
      expect(quarantinedClient!.serverInstanceId).toBe(quarantinedServerId);
      await waitFor(async () =>
        (await store.getAgentServer(quarantinedServerId!))?.status === 'EXITED'
          ? true
          : undefined
      );

      // Resolve the old run locally, then start replacement work immediately.
      // The fake process schedules a late old-turn chunk after the cancellation
      // deadline. Quarantine must kill that process so the chunk cannot be
      // attributed to this replacement run (ACP updates have no prompt ID).
      await store.updateRun(interruptedRun.id, {
        status: 'INTERRUPTED',
        endedAt: new Date().toISOString()
      });
      await store.updateAgentSession(session.id, { status: 'IDLE' });

      const replacementRun = await store.createRun({
        task,
        session: (await store.getAgentSession(session.id))!,
        mode: 'FOLLOW_UP',
        prompt: 'replacement after ambiguous cancel',
        requestedSettings: settings
      });
      const replacementTurn = await adapter.startTurn({
        localRunId: replacementRun.id,
        session: { localSessionId: session.id, providerSessionId: session.providerSessionId },
        mode: 'FOLLOW_UP',
        prompt: 'replacement after ambiguous cancel',
        authoritativeGoal: task.prompt,
        settings
      });
      expect(replacementTurn.providerTurnId).not.toContain(quarantinedServerId!);
      const replacementInteraction = await waitFor(async () =>
        (await store.snapshot()).interactionRequests.find(
          (interaction) =>
            interaction.runId === replacementRun.id && interaction.status === 'PENDING'
          )
      );

      // A closed client can still have already queued EventEmitter callbacks.
      // Explicitly deliver an old-generation chunk and permission after the
      // replacement process is active; neither may cross the process fence.
      const lateNotificationParams = {
        sessionId: 'provider-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'late-old-message',
          content: { type: 'text', text: 'late injected output from old ACP generation' }
        }
      };
      const latePermissionRequest = {
        jsonrpc: '2.0' as const,
        id: 'late-old-permission',
        method: 'session/request_permission',
        params: {
          sessionId: 'provider-session-1',
          toolCall: {
            toolCallId: 'late-old-tool',
            title: 'Late old tool',
            kind: 'execute',
            rawInput: {
              command: 'dangerous old command',
              cwd: worktree.worktreePath
            }
          },
          options: [{ optionId: 'late-old-reject', name: 'Reject', kind: 'reject_once' }]
        }
      };
      const lateNotificationRaw = await store.appendProtocolMessage(
        quarantinedServerId!,
        'INBOUND',
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: lateNotificationParams
        })
      );
      const latePermissionRaw = await store.appendProtocolMessage(
        quarantinedServerId!,
        'INBOUND',
        JSON.stringify(latePermissionRequest)
      );
      quarantinedClient!.events.emit(
        'notification',
        'session/update',
        lateNotificationParams,
        lateNotificationRaw
      );
      quarantinedClient!.events.emit('request', latePermissionRequest, latePermissionRaw);
      await (adapter as unknown as { inboundQueue: Promise<void> }).inboundQueue;

      const afterLateGeneration = await store.snapshot();
      expect(
        afterLateGeneration.interactionRequests.some(
          (interaction) => interaction.providerRequestId === 'late-old-permission'
        )
      ).toBe(false);
      expect(
        afterLateGeneration.agentItems
          .filter((item) => item.runId === replacementRun.id)
          .map(itemPayloadText)
          .join('')
      ).not.toContain('late injected output from old ACP generation');
      await new Promise((resolve) => setTimeout(resolve, 100));
      await interactionService.respond({
        taskId: task.id,
        runId: replacementRun.id,
        interactionRequestId: replacementInteraction.id,
        decision: { interactionType: 'COMMAND_APPROVAL', action: 'ACCEPT' }
      });
      const replacementCompleted = await waitFor(async () => {
        const current = await store.getRun(replacementRun.id);
        return current?.status === 'COMPLETED' ? current : undefined;
      });
      expect(replacementCompleted.finalMessage).toBe('Implemented safely.');
      const replacementItems = (await store.snapshot()).agentItems.filter(
        (item) => item.runId === replacementRun.id
      );
      expect(replacementItems.map(itemPayloadText).join('')).not.toContain(
        'late output from cancelled prompt'
      );
      expect(replacementItems.map(itemPayloadText).join('')).not.toContain(
        'late injected output from old ACP generation'
      );
      expect((await store.getRun(interruptedRun.id))?.status).toBe('INTERRUPTED');

      const ambiguousRun = await store.createRun({
        task,
        session: (await store.getAgentSession(session.id))!,
        mode: 'FOLLOW_UP',
        prompt: 'ambiguous disconnect',
        requestedSettings: settings
      });
      await adapter.startTurn({
        localRunId: ambiguousRun.id,
        session: { localSessionId: session.id, providerSessionId: session.providerSessionId },
        mode: 'FOLLOW_UP',
        prompt: 'ambiguous disconnect',
        authoritativeGoal: task.prompt,
        settings
      });
      const recovery = await waitFor(async () => {
        const current = await store.getRun(ambiguousRun.id);
        return current?.status === 'RECOVERY_REQUIRED' ? current : undefined;
      });
      expect(recovery.terminalReason).toMatch(/ambiguous|exited/iu);
      const protocolMessages = (
        await Promise.all(
          (await store.snapshot()).agentServers.map((server) =>
            fs.readFile(server.protocolJournalPath, 'utf8')
          )
        )
      ).flatMap((journal) =>
        journal
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(JSON.parse(line).raw) as { method?: string })
      );
      const submittedPrompts = protocolMessages.filter(
        (message) => message.method === 'session/prompt'
      );
      expect(submittedPrompts).toHaveLength(11);
      expect(
        protocolMessages.filter((message) => message.method === 'session/close')
      ).toHaveLength(2);

      await adapter.configureRuntime({
        executable: '/persisted/custom-acp',
        restart: true
      });
      await adapter.preflight();
      expect(resolutionCalls).toBe(3);
      expect(resolvedExecutableOverrides.at(-1)).toBe('/persisted/custom-acp');
    } finally {
      await adapter.shutdown();
    }
  }, 60_000);
});

describe('AcpRuntimeAdapter process safety fence', () => {
  it('retains and fences an unfenced supervisor when shutdown rejects', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-acp-shutdown-fence-')
    );
    temporaryDirectories.push(directory);
    const store = new FileTaskStore(path.join(directory, 'store'));
    const server = await store.createAgentServer({
      runtimeId: 'test-acp-shutdown-fence',
      runtimeKind: 'ACP_AGENT',
      transport: 'STDIO',
      executable: '/fake/acp',
      argv: ['--acp'],
      schemaVersion: '1.19.0'
    });
    const profile: AcpRuntimeProfile = {
      ...TEST_ACP_PROFILE,
      descriptor: { ...TEST_ACP_PROFILE.descriptor, id: 'test-acp-shutdown-fence' }
    };
    const adapter = new AcpRuntimeAdapter(store, new AppEventBus(), profile, {
      cwd: directory
    });
    const shutdownFailure = new Error('ACP supervisor shutdown rejected');
    const fakeSupervisor = {
      currentServer: server,
      currentClient: {} as AcpRpcClient,
      safetyFenceReason: undefined,
      shutdown: vi.fn().mockRejectedValue(shutdownFailure)
    };
    const internals = adapter as unknown as {
      supervisor?: typeof fakeSupervisor;
      initialized: boolean;
      runtimeSafetyFence?: Error;
    };
    internals.supervisor = fakeSupervisor;
    internals.initialized = true;

    await expect(adapter.shutdown()).rejects.toThrow(
      'ACP runtime shutdown was incomplete.'
    );
    expect(internals.supervisor).toBe(fakeSupervisor);
    expect(internals.initialized).toBe(true);
    expect(internals.runtimeSafetyFence?.message).toContain(
      'safety-fenced until Task Monki restarts'
    );
    await expect(adapter.initialize()).rejects.toThrow(
      'safety-fenced until Task Monki restarts'
    );
    expect(fakeSupervisor.shutdown).toHaveBeenCalledOnce();
  });

  it('retains a failed quarantine and rejects every later runtime operation', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-fence-'));
    temporaryDirectories.push(directory);
    const store = new FileTaskStore(path.join(directory, 'store'));
    const server = await store.createAgentServer({
      runtimeId: 'test-acp-fence',
      runtimeKind: 'ACP_AGENT',
      transport: 'STDIO',
      executable: '/fake/acp',
      argv: ['--acp'],
      schemaVersion: '1.19.0'
    });
    const profile: AcpRuntimeProfile = {
      ...TEST_ACP_PROFILE,
      descriptor: { ...TEST_ACP_PROFILE.descriptor, id: 'test-acp-fence' }
    };
    const adapter = new AcpRuntimeAdapter(store, new AppEventBus(), profile, {
      cwd: directory
    });
    const shutdownFailure = new Error('old ACP child may still be live');
    const fakeSupervisor = {
      currentServer: server,
      currentClient: {} as AcpRpcClient,
      safetyFenceReason: 'ACP process termination could not be confirmed.',
      shutdown: vi.fn().mockRejectedValue(shutdownFailure)
    };
    const internals = adapter as unknown as {
      supervisor?: typeof fakeSupervisor;
      quarantineRuntimeAfterAmbiguousMutation(
        operation: string,
        detail: string
      ): Promise<void>;
      waitForRuntimeQuarantine(): Promise<void>;
    };
    internals.supervisor = fakeSupervisor;

    await expect(
      internals.quarantineRuntimeAfterAmbiguousMutation(
        'session/prompt',
        'Delivery could not be confirmed.'
      )
    ).rejects.toThrow('safety-fenced until Task Monki restarts');
    expect(internals.supervisor).toBe(fakeSupervisor);
    expect(fakeSupervisor.shutdown).toHaveBeenCalledOnce();
    await expect(internals.waitForRuntimeQuarantine()).rejects.toThrow(
      'safety-fenced until Task Monki restarts'
    );
    await expect(
      adapter.configureRuntime({ executable: '/replacement/acp', restart: true })
    ).rejects.toThrow('safety-fenced until Task Monki restarts');
    await expect(adapter.initialize()).rejects.toThrow(
      'safety-fenced until Task Monki restarts'
    );
    expect(fakeSupervisor.shutdown).toHaveBeenCalledOnce();
  });
});

describe('AcpRuntimeAdapter native settings', () => {
  it('applies an explicit effort only through an advertised thought_level selector', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-acp-reasoning-selector-')
    );
    temporaryDirectories.push(directory);
    const runtimeId = 'test-acp-reasoning-selector';
    const profile: AcpRuntimeProfile = {
      ...TEST_ACP_PROFILE,
      descriptor: { ...TEST_ACP_PROFILE.descriptor, id: runtimeId }
    };
    const adapter = new AcpRuntimeAdapter(
      new FileTaskStore(path.join(directory, 'store')),
      new AppEventBus(),
      profile,
      { cwd: directory }
    );
    const raw = {
      serverInstanceId: 'server-reasoning',
      sequence: 1,
      direction: 'INBOUND' as const,
      recordedAt: new Date().toISOString(),
      byteOffset: 0,
      byteLength: 1,
      sha256: '0'.repeat(64)
    };
    const configOptions: Array<
      Extract<AcpSessionConfigOption, { type: 'select' }>
    > = [
      {
        id: 'effort',
        name: 'Reasoning effort',
        category: 'thought_level',
        type: 'select' as const,
        currentValue: 'low',
        options: [
          { value: 'high', name: 'High' },
          { value: 'low', name: 'Low' }
        ]
      }
    ];
    const requestMutation = vi.fn().mockResolvedValue({
      result: { configOptions },
      raw
    });
    const client = { requestMutation } as unknown as AcpRpcClient;
    const apply = (
      adapter as unknown as {
        applyRequestedNativeSettings(
          client: AcpRpcClient,
          state: AcpNativeSessionState,
          settings: Record<string, unknown>
        ): Promise<unknown>;
      }
    ).applyRequestedNativeSettings.bind(adapter);
    const state: AcpNativeSessionState = {
      sessionId: 'session-reasoning',
      modes: null,
      models: null,
      configOptions: [{ ...configOptions[0]!, currentValue: 'high' }]
    };

    await apply(client, state, { runtimeId, reasoningEffort: 'low' });
    expect(requestMutation).toHaveBeenCalledWith(
      'session/set_config_option',
      {
        sessionId: 'session-reasoning',
        configId: 'effort',
        value: 'low'
      }
    );
    requestMutation.mockResolvedValueOnce({ result: {}, raw });
    await expect(
      apply(client, state, { runtimeId, reasoningEffort: 'low' })
    ).rejects.toBeInstanceOf(AgentMutationAmbiguousError);
    await expect(
      apply(
        client,
        {
          ...state,
          modes: {
            currentModeId: 'plan',
            availableModes: [
              { id: 'plan', name: 'Plan' },
              { id: 'code', name: 'Code' }
            ]
          },
          configOptions: []
        },
        {
          runtimeId,
          reasoningEffort: 'low',
          runtimeOptions: { [runtimeId]: { modeId: 'code' } }
        }
      )
    ).rejects.toThrow('did not advertise an ACP thought_level');
    expect(requestMutation).toHaveBeenCalledTimes(2);
  });

  it('overrides stale Grok session effort through the provider model contract', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-grok-reasoning-setting-')
    );
    temporaryDirectories.push(directory);
    const runtimeId = 'test-grok-reasoning-setting';
    const adapter = new AcpRuntimeAdapter(
      new FileTaskStore(path.join(directory, 'store')),
      new AppEventBus(),
      {
        ...TEST_ACP_PROFILE,
        descriptor: { ...TEST_ACP_PROFILE.descriptor, id: runtimeId },
        sessionModelExtension: GROK_SESSION_MODEL_EXTENSION
      },
      { cwd: directory }
    );
    const raw = {
      serverInstanceId: 'server-grok-reasoning',
      sequence: 1,
      direction: 'INBOUND' as const,
      recordedAt: new Date().toISOString(),
      byteOffset: 0,
      byteLength: 1,
      sha256: '0'.repeat(64)
    };
    const requestMutation = vi.fn().mockResolvedValue({ result: {}, raw });
    const client = { requestMutation } as unknown as AcpRpcClient;
    const apply = (
      adapter as unknown as {
        applyRequestedNativeSettings(
          client: AcpRpcClient,
          state: AcpNativeSessionState,
          settings: Record<string, unknown>
        ): Promise<{ state: AcpNativeSessionState }>;
      }
    ).applyRequestedNativeSettings.bind(adapter);
    const state: AcpNativeSessionState = {
      sessionId: 'session-grok-reasoning',
      modes: null,
      models: {
        currentModelId: 'grok-4.5',
        availableModels: [
          {
            modelId: 'grok-4.5',
            name: 'Grok 4.5',
            reasoningEffort: 'high',
            reasoningEfforts: [
              { id: 'high', value: 'high', label: 'High', default: true },
              { id: 'low', value: 'low', label: 'Low', default: false }
            ]
          }
        ]
      },
      configOptions: []
    };

    const applied = await apply(client, state, {
      runtimeId,
      model: 'grok-4.5',
      reasoningEffort: 'low'
    });

    expect(requestMutation).toHaveBeenCalledWith('session/set_model', {
      sessionId: 'session-grok-reasoning',
      modelId: 'grok-4.5',
      _meta: { reasoningEffort: 'low' }
    });
    expect(applied.state.models?.availableModels[0]?.reasoningEffort).toBe('low');
  });

  it('retains native settings when a config update omits its resulting state', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-acp-invalid-config-update-')
    );
    temporaryDirectories.push(directory);
    const adapter = new AcpRuntimeAdapter(
      new FileTaskStore(path.join(directory, 'store')),
      new AppEventBus(),
      TEST_ACP_PROFILE,
      { cwd: directory }
    );
    const state: AcpNativeSessionState = {
      sessionId: 'session-config-update',
      modes: null,
      models: null,
      configOptions: [
        {
          id: 'telemetry',
          name: 'Telemetry',
          type: 'boolean',
          currentValue: true
        }
      ]
    };
    const internals = adapter as unknown as {
      nativeSessions: Map<string, AcpNativeSessionState>;
      recordProtocolIncident(message: string, raw: unknown): Promise<void>;
      persistNativeState(...args: unknown[]): Promise<void>;
      handleConfigUpdate(
        session: { providerSessionId?: string },
        update: AcpSessionUpdate,
        raw: unknown
      ): Promise<void>;
    };
    internals.nativeSessions.set(state.sessionId, state);
    const incident = vi.spyOn(internals, 'recordProtocolIncident').mockResolvedValue();
    const persist = vi.spyOn(internals, 'persistNativeState').mockResolvedValue();

    await internals.handleConfigUpdate(
      { providerSessionId: state.sessionId },
      { sessionUpdate: 'config_option_update' },
      {}
    );

    expect(internals.nativeSessions.get(state.sessionId)).toBe(state);
    expect(persist).not.toHaveBeenCalled();
    expect(incident).toHaveBeenCalledWith(
      'ACP config update did not include configOptions.',
      {}
    );
  });
});

describe('AcpRuntimeAdapter permission materialization', () => {
  it.each([
    {
      profileName: 'Cursor',
      allowOpaqueExecuteOnce: true,
      expectedActions: ['ACCEPT', 'DECLINE', 'CANCEL']
    },
    {
      profileName: 'another ACP runtime',
      allowOpaqueExecuteOnce: false,
      expectedActions: ['DECLINE', 'CANCEL']
    }
  ])(
    'keeps opaque execute approval profile-scoped for $profileName',
    async ({ profileName, allowOpaqueExecuteOnce, expectedActions }) => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), 'task-monki-acp-opaque-permission-')
      );
      temporaryDirectories.push(directory);
      const agentScript = path.join(directory, 'permission-agent.cjs');
      await fs.writeFile(agentScript, permissionMaterializationAgentSource(), {
        mode: 0o600
      });
      const runtimeId = allowOpaqueExecuteOnce
        ? 'test-cursor-opaque-permission'
        : 'test-acp-opaque-permission';
      const profile: AcpRuntimeProfile = {
        ...TEST_ACP_PROFILE,
        descriptor: { ...TEST_ACP_PROFILE.descriptor, id: runtimeId },
        ...(allowOpaqueExecuteOnce ? { allowOpaqueExecuteOnce: true as const } : {}),
        executableCandidates: [process.execPath],
        argv: [agentScript]
      };
      const store = new FileTaskStore(path.join(directory, 'store'));
      const events = new AppEventBus();
      const adapter = new AcpRuntimeAdapter(store, events, profile, {
        cwd: directory,
        requestTimeoutMs: 1_000,
        runtimeResolver: async () => ({
          executable: process.execPath,
          version: process.version,
          diagnostics: {
            selectedExecutable: process.execPath,
            selectedSource: 'test',
            selectedVersion: process.version,
            selectedLaunchArgv: [agentScript],
            requiredCapabilities: ['ACP protocolVersion=1'],
            probes: []
          }
        })
      });
      const settings = {
        runtimeId,
        model: 'default',
        modelProvider: 'test-provider',
        sandbox: 'DANGER_FULL_ACCESS' as const,
        networkAccess: true,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user' as const
      };
      const task = await store.createTask({
        title: `${profileName} opaque permission`,
        prompt: 'Request an opaque execute permission.',
        repositoryPath: directory,
        runtimeId,
        agentSettings: settings
      });
      const { iteration, worktree } = await store.createIterationAndWorktree({
        task,
        branchName: `codex/${runtimeId}`,
        worktreePath: directory,
        baseSha: 'base'
      });
      const session = await store.createAgentSession({
        task,
        iteration,
        worktree,
        runtimeId,
        requestedSettings: settings
      });
      const run = await store.createRun({
        task,
        session,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        requestedSettings: settings
      });

      try {
        await adapter.initialize();
        await adapter.startTurn({
          localRunId: run.id,
          session: { localSessionId: session.id },
          mode: 'IMPLEMENTATION',
          prompt: task.prompt,
          authoritativeGoal: task.prompt,
          settings,
          attachments: []
        });
        const runtimeInternals = adapter as unknown as {
          boundClient?: AcpRpcClient;
        };
        const client = runtimeInternals.boundClient!;
        const server = (await store.snapshot()).agentServers.find(
          (candidate) => candidate.status === 'RUNNING'
        )!;
        const requestId = `opaque-permission-${runtimeId}`;
        const request = {
          jsonrpc: '2.0' as const,
          id: requestId,
          method: 'session/request_permission',
          params: {
            sessionId: 'permission-materialization-session',
            toolCall: {
              toolCallId: `opaque-tool-${runtimeId}`,
              title: 'Run command',
              kind: 'execute'
            },
            options: [
              { optionId: 'opaque-allow-once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'opaque-reject-once', name: 'Reject', kind: 'reject_once' }
            ]
          }
        };
        const raw = await store.appendProtocolMessage(
          server.id,
          'INBOUND',
          JSON.stringify(request)
        );
        client.events.emit('request', request, raw);

        const pending = await waitFor(async () =>
          (await store.snapshot()).interactionRequests.find(
            (interaction) => interaction.runId === run.id && interaction.status === 'PENDING'
          )
        );
        expect(pending.allowedActions).toEqual(expectedActions);

        if (allowOpaqueExecuteOnce) {
          const interactionService = new AgentInteractionService(store, events, () => adapter);
          await interactionService.respond({
            taskId: task.id,
            runId: run.id,
            interactionRequestId: pending.id,
            decision: { interactionType: 'COMMAND_APPROVAL', action: 'ACCEPT' }
          });
          const journal = await fs.readFile(server.protocolJournalPath, 'utf8');
          const messages = journal
            .trim()
            .split('\n')
            .map((line) => JSON.parse(JSON.parse(line).raw));
          expect(messages).toContainEqual({
            jsonrpc: '2.0',
            id: requestId,
            result: { outcome: { outcome: 'selected', optionId: 'opaque-allow-once' } }
          });
        }
      } finally {
        await adapter.shutdown();
      }
    }
  );

  it.each([
    {
      boundary: 'atomic activation before publication',
      failure: 'injected permission activation failure',
      failDuringPersistence: false
    },
    {
      boundary: 'atomic boundary persistence',
      failure: 'injected permission boundary persistence failure',
      failDuringPersistence: true
    }
  ])(
    'cancels and quarantines when $boundary cannot be persisted',
    async ({ boundary, failure, failDuringPersistence }) => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), 'task-monki-acp-permission-persistence-')
      );
      temporaryDirectories.push(directory);
      const agentScript = path.join(directory, 'permission-agent.cjs');
      await fs.writeFile(agentScript, permissionMaterializationAgentSource(), {
        mode: 0o600
      });

      const runtimeId = `test-acp-permission-${
        failDuringPersistence ? 'persistence' : 'activation'
      }`;
      const profile: AcpRuntimeProfile = {
        ...TEST_ACP_PROFILE,
        descriptor: { ...TEST_ACP_PROFILE.descriptor, id: runtimeId },
        executableCandidates: [process.execPath],
        argv: [agentScript]
      };
      const store = new FileTaskStore(path.join(directory, 'store'));
      const adapter = new AcpRuntimeAdapter(store, new AppEventBus(), profile, {
        cwd: directory,
        requestTimeoutMs: 1_000,
        runtimeResolver: async () => ({
          executable: process.execPath,
          version: process.version,
          diagnostics: {
            selectedExecutable: process.execPath,
            selectedSource: 'test',
            selectedVersion: process.version,
            selectedLaunchArgv: [agentScript],
            requiredCapabilities: ['ACP protocolVersion=1'],
            probes: []
          }
        })
      });
      const settings = {
        runtimeId,
        model: 'default',
        modelProvider: 'test-provider',
        sandbox: 'DANGER_FULL_ACCESS' as const,
        networkAccess: true,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user' as const
      };
      const task = await store.createTask({
        title: 'Permission materialization failure',
        prompt: 'Request a permission and remain blocked.',
        repositoryPath: directory,
        runtimeId,
        agentSettings: settings
      });
      const { iteration, worktree } = await store.createIterationAndWorktree({
        task,
        branchName: `codex/acp-permission-${task.id}`,
        worktreePath: directory,
        baseSha: 'base'
      });
      const session = await store.createAgentSession({
        task,
        iteration,
        worktree,
        runtimeId,
        requestedSettings: settings
      });
      const run = await store.createRun({
        task,
        session,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        requestedSettings: settings
      });

      const persistenceSpies: Array<{ mockRestore(): void }> = [];
      if (!failDuringPersistence) {
        persistenceSpies.push(
          vi
            .spyOn(store, 'createInteractionRequest')
            .mockRejectedValueOnce(new Error(failure))
        );
      } else {
        const createInteractionRequest = store.createInteractionRequest.bind(store);
        persistenceSpies.push(
          vi
            .spyOn(store, 'createInteractionRequest')
            .mockImplementationOnce(async (input) => {
              const internals = store as unknown as {
                persistSnapshot(): Promise<boolean>;
              };
              const persist = vi
                .spyOn(internals, 'persistSnapshot')
                .mockRejectedValueOnce(new Error(failure));
              try {
                return await createInteractionRequest(input);
              } finally {
                persist.mockRestore();
              }
            })
        );
      }

      const readProtocolMessages = async () => {
        const snapshot = await store.snapshot();
        return (
          await Promise.all(
            snapshot.agentServers.map((server) =>
              fs.readFile(server.protocolJournalPath, 'utf8')
            )
          )
        ).flatMap((journal) =>
          journal
            .trim()
            .split('\n')
            .filter(Boolean)
            .map(
              (line) =>
                JSON.parse(JSON.parse(line).raw) as {
                  id?: string | number;
                  method?: string;
                  result?: { outcome?: { outcome?: string } };
                }
            )
        );
      };

      try {
        await adapter.initialize();
        await adapter.startTurn({
          localRunId: run.id,
          session: { localSessionId: session.id },
          mode: 'IMPLEMENTATION',
          prompt: task.prompt,
          authoritativeGoal: task.prompt,
          settings,
          attachments: []
        });
        const runtimeInternals = adapter as unknown as {
          boundClient?: AcpRpcClient;
          activePromptRunIds: Set<string>;
        };
        const client = runtimeInternals.boundClient!;
        const server = (await store.snapshot()).agentServers.find(
          (candidate) => candidate.status === 'RUNNING'
        )!;
        const request = {
          jsonrpc: '2.0' as const,
          id: 'permission-persistence-1',
          method: 'session/request_permission',
          params: {
            sessionId: 'permission-materialization-session',
            toolCall: {
              toolCallId: 'permission-tool-1',
              title: 'Run tests',
              kind: 'execute',
              rawInput: { command: 'npm test' }
            },
            options: [
              { optionId: 'permission-allow-1', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'permission-reject-1', name: 'Reject', kind: 'reject_once' }
            ]
          }
        };
        const raw = await store.appendProtocolMessage(
          server.id,
          'INBOUND',
          JSON.stringify(request)
        );
        client.events.emit('request', request, raw);

        const recovered = await waitFor(async () => {
          const [currentRun, currentSession, snapshot] = await Promise.all([
            store.getRun(run.id),
            store.getAgentSession(session.id),
            store.snapshot()
          ]);
          const runtimeStopped = !snapshot.agentServers.some((server) =>
            ['STARTING', 'READY', 'RUNNING', 'DEGRADED', 'STOPPING'].includes(
              server.status
            )
          );
          const unresolvedInteraction = snapshot.interactionRequests.some(
            (interaction) =>
              interaction.runId === run.id &&
              ['PENDING', 'RESPONDING'].includes(interaction.status)
          );
          if (
            currentRun?.status === 'RECOVERY_REQUIRED' &&
            currentRun.recoveryState === 'REQUIRES_USER_ACTION' &&
            currentSession?.status === 'NOT_LOADED' &&
            runtimeStopped &&
            !unresolvedInteraction
          ) {
            return { run: currentRun, session: currentSession, snapshot };
          }
          return undefined;
        });

        expect(recovered.run.terminalReason).toContain(failure);
        expect(recovered.session.status).toBe('NOT_LOADED');
        expect(
          recovered.snapshot.events.filter(
            (event) => event.runId === run.id && event.type === 'AGENT_MUTATION_AMBIGUOUS'
          )
        ).toHaveLength(1);
        expect(
          recovered.snapshot.interactionRequests.filter(
            (interaction) =>
              interaction.runId === run.id &&
              ['PENDING', 'RESPONDING'].includes(interaction.status)
          )
        ).toHaveLength(0);

        const protocolMessages = await readProtocolMessages();
        expect(
          protocolMessages.filter((message) => message.method === 'session/prompt')
        ).toHaveLength(1);
        expect(
          protocolMessages.filter(
            (message) =>
              message.id === 'permission-persistence-1' &&
              message.result?.outcome?.outcome === 'cancelled'
          )
        ).toHaveLength(1);
        expect(
          recovered.snapshot.agentServers.some((server) =>
            ['STARTING', 'READY', 'RUNNING', 'DEGRADED', 'STOPPING'].includes(
              server.status
            )
          )
        ).toBe(false);

        expect(runtimeInternals.boundClient).toBeUndefined();
        expect(runtimeInternals.activePromptRunIds.has(run.id)).toBe(false);

        const reconciliation = await adapter.reconcile();
        expect(reconciliation.recoveryRequiredSessionIds).toContain(session.id);
        expect((await store.getRun(run.id))?.status).toBe('RECOVERY_REQUIRED');
        expect((await store.getAgentSession(session.id))?.status).toBe('NOT_LOADED');
        expect(
          (await readProtocolMessages()).filter(
            (message) => message.method === 'session/prompt'
          )
        ).toHaveLength(1);
      } finally {
        for (const spy of persistenceSpies) spy.mockRestore();
        await adapter.shutdown();
      }
    },
    30_000
  );
});

describe('AcpRuntimeAdapter terminal persistence', () => {
  it('fails closed without replay after consuming a prompt response whose final artifact cannot be persisted', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-acp-terminal-persistence-')
    );
    temporaryDirectories.push(directory);
    const agentScript = path.join(directory, 'terminal-agent.cjs');
    await fs.writeFile(agentScript, terminalPersistenceAgentSource(), { mode: 0o600 });

    const runtimeId = 'test-acp-terminal-persistence';
    const profile: AcpRuntimeProfile = {
      ...TEST_ACP_PROFILE,
      descriptor: { ...TEST_ACP_PROFILE.descriptor, id: runtimeId },
      executableCandidates: [process.execPath],
      argv: [agentScript]
    };
    const store = new FileTaskStore(path.join(directory, 'store'));
    const appEvents = new AppEventBus();
    const observedEvents: Array<{ type: string; runId?: string }> = [];
    appEvents.on((event) => observedEvents.push(event));
    const adapter = new AcpRuntimeAdapter(store, appEvents, profile, {
      cwd: directory,
      requestTimeoutMs: 1_000,
      runtimeResolver: async () => ({
        executable: process.execPath,
        version: process.version,
        diagnostics: {
          selectedExecutable: process.execPath,
          selectedSource: 'test',
          selectedVersion: process.version,
          selectedLaunchArgv: [agentScript],
          requiredCapabilities: ['ACP protocolVersion=1'],
          probes: []
        }
      })
    });
    const settings = {
      runtimeId,
      model: 'default',
      modelProvider: 'test-provider',
      sandbox: 'DANGER_FULL_ACCESS' as const,
      networkAccess: true,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user' as const
    };
    const task = await store.createTask({
      title: 'Terminal persistence failure',
      prompt: 'Return a definitive terminal response.',
      repositoryPath: directory,
      runtimeId,
      agentSettings: settings
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/acp-terminal-persistence',
      worktreePath: directory,
      baseSha: 'base'
    });
    const session = await store.createAgentSession({
      task,
      iteration,
      worktree,
      runtimeId,
      requestedSettings: settings
    });
    const run = await store.createRun({
      task,
      session,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      requestedSettings: settings
    });

    const originalWriteFinalArtifact = store.writeFinalArtifact.bind(store);
    let injectedFailures = 0;
    const artifactSpy = vi
      .spyOn(store, 'writeFinalArtifact')
      .mockImplementation(async (taskId, runId, content) => {
        if (runId === run.id && injectedFailures === 0) {
          injectedFailures += 1;
          throw new Error('injected post-response final artifact persistence failure');
        }
        return originalWriteFinalArtifact(taskId, runId, content);
      });

    try {
      await adapter.initialize();
      await adapter.startTurn({
        localRunId: run.id,
        session: { localSessionId: session.id },
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        authoritativeGoal: task.prompt,
        settings,
        attachments: []
      });

      const recovered = await waitFor(async () => {
        const [currentRun, currentSession, snapshot] = await Promise.all([
          store.getRun(run.id),
          store.getAgentSession(session.id),
          store.snapshot()
        ]);
        const runtimeStopped = !snapshot.agentServers.some((server) =>
          ['STARTING', 'READY', 'RUNNING', 'DEGRADED', 'STOPPING'].includes(server.status)
        );
        if (
          currentRun?.status === 'RECOVERY_REQUIRED' &&
          currentRun.recoveryState === 'REQUIRES_USER_ACTION' &&
          currentSession?.status === 'NOT_LOADED' &&
          runtimeStopped
        ) {
          return { run: currentRun, session: currentSession };
        }
        return undefined;
      });

      expect(injectedFailures).toBe(1);
      expect(recovered.run.terminalReason).toContain(
        'injected post-response final artifact persistence failure'
      );
      expect(recovered.session.status).toBe('NOT_LOADED');
      expect(
        (await store.snapshot()).events.filter(
          (event) =>
            event.runId === run.id && event.type === 'AGENT_MUTATION_AMBIGUOUS'
        )
      ).toHaveLength(1);
      expect(
        (await store.snapshot()).events.filter(
          (event) =>
            event.runId === run.id &&
            ['AGENT_RUN_COMPLETED', 'AGENT_RUN_FAILED', 'AGENT_RUN_INTERRUPTED'].includes(
              event.type
            )
        )
      ).toHaveLength(0);
      expect(
        observedEvents.filter(
          (event) => event.runId === run.id && event.type === 'run.terminal'
        )
      ).toHaveLength(0);

      const readPromptRequests = async () => {
        const snapshot = await store.snapshot();
        const protocolMessages = (
          await Promise.all(
            snapshot.agentServers.map((server) =>
              fs.readFile(server.protocolJournalPath, 'utf8')
            )
          )
        ).flatMap((journal) =>
          journal
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(JSON.parse(line).raw) as { method?: string })
        );
        return protocolMessages.filter((message) => message.method === 'session/prompt');
      };
      expect(await readPromptRequests()).toHaveLength(1);

      const reconciliation = await adapter.reconcile();
      expect(reconciliation.recoveryRequiredSessionIds).toContain(session.id);
      expect((await store.getRun(run.id))?.status).toBe('RECOVERY_REQUIRED');
      expect((await store.getAgentSession(session.id))?.status).toBe('NOT_LOADED');
      expect(await readPromptRequests()).toHaveLength(1);
      expect(
        (await store.snapshot()).agentServers.some((server) =>
          ['STARTING', 'READY', 'RUNNING', 'DEGRADED', 'STOPPING'].includes(server.status)
        )
      ).toBe(false);
    } finally {
      artifactSpy.mockRestore();
      await adapter.shutdown();
    }
  });
});

describe('AcpRuntimeAdapter stream safety', () => {
  it('redacts an exact credential split across provider updates and journal records', async () => {
    const secret = 'opaque-split-stream-credential-9Qx7';
    const harness = await createStreamSafetyHarness('split-credential', secret);
    try {
      await harness.start();
      const completed = await waitFor(async () => {
        const run = await harness.store.getRun(harness.run.id);
        return run?.status === 'COMPLETED' ? run : undefined;
      });
      const snapshot = await harness.store.snapshot();
      const item = snapshot.agentItems.find(
        (candidate) => candidate.runId === harness.run.id && candidate.type === 'AGENT_MESSAGE'
      );
      const artifact = snapshot.artifacts.find(
        (candidate) => candidate.id === harness.run.outputArtifactId
      );
      const journal = (
        await Promise.all(
          snapshot.agentServers.map((server) => fs.readFile(server.protocolJournalPath, 'utf8'))
        )
      ).join('\n');
      const durable = [
        completed.finalMessage,
        itemPayloadText(item),
        artifact ? await fs.readFile(artifact.path, 'utf8') : '',
        JSON.stringify(snapshot.events),
        journal
      ].join('\n');

      expect(completed.finalMessage).toBe('before [REDACTED] after');
      expect(durable).not.toContain(secret);
      expect(durable).not.toContain(secret.slice(0, 14));
      expect(durable).not.toContain(secret.slice(14));
      expect(journal).toContain('[REDACTED PROVIDER STREAM CONTENT]');
      expect(JSON.stringify(harness.observedEvents)).not.toContain(secret);
    } finally {
      await harness.adapter.shutdown();
    }
  });

  it('redacts a complete self-overlapping credential before retaining a suffix', async () => {
    const harness = await createStreamSafetyHarness('self-overlap', 'aaaaaaaa');
    try {
      await harness.start();
      const completed = await waitFor(async () => {
        const run = await harness.store.getRun(harness.run.id);
        return run?.status === 'COMPLETED' ? run : undefined;
      });

      expect(completed.finalMessage).toBe('[REDACTED]');
    } finally {
      await harness.adapter.shutdown();
    }
  });

  it('keeps unresolved credential carry with its owning message', async () => {
    const secret = 'boundary-secret-value';
    const harness = await createStreamSafetyHarness('message-boundary', secret);
    try {
      await harness.start();
      const completed = await waitFor(async () => {
        const run = await harness.store.getRun(harness.run.id);
        return run?.status === 'COMPLETED' ? run : undefined;
      });
      const snapshot = await harness.store.snapshot();
      const messages = snapshot.agentItems.filter(
        (candidate) => candidate.runId === harness.run.id && candidate.type === 'AGENT_MESSAGE'
      );
      const artifact = snapshot.artifacts.find(
        (candidate) => candidate.id === harness.run.outputArtifactId
      );

      expect(completed.finalMessage).toBe('one [REDACTED]\ntwo');
      expect(
        itemPayloadText(messages.find((item) => item.providerItemId === 'stream-message-1'))
      ).toBe('one [REDACTED]');
      expect(
        itemPayloadText(messages.find((item) => item.providerItemId === 'stream-message-2'))
      ).toBe('two');
      expect(artifact ? await fs.readFile(artifact.path, 'utf8') : '').toContain(
        'one [REDACTED]two'
      );
    } finally {
      await harness.adapter.shutdown();
    }
  });

  it.each([
    { kind: 'ordinary' as const, expectedAttempts: 3 },
    { kind: 'ambiguous' as const, expectedAttempts: 1 }
  ])(
    'fences the run after $kind artifact append failure without unbounded retries',
    async ({ kind, expectedAttempts }) => {
      const harness = await createStreamSafetyHarness(`persistence-${kind}`);
      const appendArtifact = harness.store.appendArtifact.bind(harness.store);
      let attempts = 0;
      const appendSpy = vi
        .spyOn(harness.store, 'appendArtifact')
        .mockImplementation(async (artifactId, text) => {
          if (artifactId !== harness.run.outputArtifactId) {
            return appendArtifact(artifactId, text);
          }
          attempts += 1;
          if (kind === 'ambiguous') {
            throw new ArtifactAppendAmbiguousError(
              artifactId,
              new Error('injected append failure'),
              new Error('injected rollback failure')
            );
          }
          throw new Error('injected persistent append failure');
        });
      try {
        await harness.start();
        const recovered = await waitFor(async () => {
          const [run, session] = await Promise.all([
            harness.store.getRun(harness.run.id),
            harness.store.getAgentSession(harness.session.id)
          ]);
          if (
            run?.status === 'RECOVERY_REQUIRED' &&
            run.recoveryState === 'REQUIRES_USER_ACTION' &&
            session?.status === 'NOT_LOADED'
          ) {
            return { run, session };
          }
          return undefined;
        });

        expect(recovered.run.recoveryState).toBe('REQUIRES_USER_ACTION');
        expect(attempts).toBe(expectedAttempts);
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(attempts).toBe(expectedAttempts);
        expect(
          (harness.adapter as unknown as { streamBuffers: Map<string, unknown> }).streamBuffers.size
        ).toBe(0);
        const loss = (await harness.store.snapshot()).events.find(
          (event) => event.type === 'AGENT_RUNTIME_LOST' && event.runId === harness.run.id
        );
        expect(JSON.stringify(loss?.payload)).toContain('ACP output');
      } finally {
        appendSpy.mockRestore();
        await harness.adapter.shutdown();
      }
    }
  );

  it('keeps duplicated item and artifact buffering within the hard retained-byte cap', async () => {
    const harness = await createStreamSafetyHarness('large-stream');
    const appendArtifact = harness.store.appendArtifact.bind(harness.store);
    let maximumRetainedBytes = 0;
    const appendSpy = vi
      .spyOn(harness.store, 'appendArtifact')
      .mockImplementation(async (artifactId, text) => {
        maximumRetainedBytes = Math.max(
          maximumRetainedBytes,
          (
            harness.adapter as unknown as { retainedStreamBytes(): number }
          ).retainedStreamBytes()
        );
        return appendArtifact(artifactId, text);
      });
    try {
      await harness.start();
      await waitFor(async () => {
        const run = await harness.store.getRun(harness.run.id);
        return run?.status === 'COMPLETED' ? run : undefined;
      }, 20_000);

      expect(maximumRetainedBytes).toBeGreaterThan(0);
      expect(maximumRetainedBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
      expect(
        (harness.adapter as unknown as { streamBuffers: Map<string, unknown> }).streamBuffers.size
      ).toBe(0);
    } finally {
      appendSpy.mockRestore();
      await harness.adapter.shutdown();
    }
  }, 30_000);
});

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for ACP test state.');
}

async function protocolMethodCount(
  store: FileTaskStore,
  method: string
): Promise<number> {
  const snapshot = await store.snapshot();
  const messages = (
    await Promise.all(
      snapshot.agentServers.map((server) =>
        fs.readFile(server.protocolJournalPath, 'utf8')
      )
    )
  ).flatMap((journal) =>
    journal
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(JSON.parse(line).raw) as { method?: string })
  );
  return messages.filter((message) => message.method === method).length;
}

function itemPayloadText(item: { payload: unknown } | undefined): string {
  if (!item || typeof item.payload !== 'object' || item.payload === null) return '';
  const text = (item.payload as { text?: unknown }).text;
  return typeof text === 'string' ? text : '';
}

function cursorModelSelectorAgentSource(
  catalogMarker: string,
  sessionSequence: string
): string {
  return `
const fs = require('node:fs');
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const fullOptions = [
  { value: 'default[]', name: 'Auto' },
  { value: 'grok-4.5[effort=high,fast=true]', name: 'grok-4.5' },
  { value: 'composer-2.5[fast=true]', name: 'composer-2.5' }
];
const selector = (currentValue, options = fullOptions) => ({
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue,
  options
});
const nextSessionId = () => {
  let sequence = 0;
  try { sequence = Number(fs.readFileSync(${JSON.stringify(sessionSequence)}, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  sequence += 1;
  fs.writeFileSync(${JSON.stringify(sessionSequence)}, String(sequence));
  return 'cursor-session-' + sequence;
};
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: 1,
      agentCapabilities: { promptCapabilities: {} },
      agentInfo: { name: 'cursor-selector-agent', version: '1.0.0' }
    }});
    return;
  }
  if (message.method === 'session/new') {
    let stale = false;
    try { stale = fs.readFileSync(${JSON.stringify(catalogMarker)}, 'utf8') === 'stale'; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    send({ jsonrpc: '2.0', id: message.id, result: {
      sessionId: nextSessionId(),
      configOptions: [selector('default[]', stale ? [fullOptions[0]] : fullOptions)]
    }});
    return;
  }
  if (message.method === 'session/set_config_option') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      configOptions: [selector(message.params.value)]
    }});
    return;
  }
  send({ jsonrpc: '2.0', id: message.id, result: {} });
});
`;
}

async function createStreamSafetyHarness(scenario: string, secret = 'test-stream-secret') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `task-monki-acp-${scenario}-`));
  temporaryDirectories.push(directory);
  const agentScript = path.join(directory, 'stream-agent.cjs');
  await fs.writeFile(agentScript, streamSafetyAgentSource(), { mode: 0o600 });
  const runtimeId = `test-acp-${scenario}`;
  const profile: AcpRuntimeProfile = {
    ...TEST_ACP_PROFILE,
    descriptor: { ...TEST_ACP_PROFILE.descriptor, id: runtimeId },
    executableCandidates: [process.execPath],
    argv: [agentScript]
  };
  const store = new FileTaskStore(path.join(directory, 'store'));
  const appEvents = new AppEventBus();
  const observedEvents: Array<{ type: string; runId?: string; payload: unknown }> = [];
  appEvents.on((event) => observedEvents.push(event));
  const adapter = new AcpRuntimeAdapter(store, appEvents, profile, {
    cwd: directory,
    environment: { ...process.env, TEST_ACP_API_KEY: secret },
    requestTimeoutMs: 1_000,
    runtimeResolver: async () => ({
      executable: process.execPath,
      version: process.version,
      diagnostics: {
        selectedExecutable: process.execPath,
        selectedSource: 'test',
        selectedVersion: process.version,
        selectedLaunchArgv: [agentScript],
        requiredCapabilities: ['ACP protocolVersion=1'],
        probes: []
      }
    })
  });
  const settings = {
    runtimeId,
    model: 'default',
    modelProvider: 'test-provider',
    sandbox: 'DANGER_FULL_ACCESS' as const,
    networkAccess: true,
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user' as const
  };
  const task = await store.createTask({
    title: `ACP ${scenario}`,
    prompt: scenario,
    repositoryPath: directory,
    runtimeId,
    agentSettings: settings
  });
  const { iteration, worktree } = await store.createIterationAndWorktree({
    task,
    branchName: `codex/acp-${scenario}`,
    worktreePath: directory,
    baseSha: 'base'
  });
  const session = await store.createAgentSession({
    task,
    iteration,
    worktree,
    runtimeId,
    requestedSettings: settings
  });
  const run = await store.createRun({
    task,
    session,
    mode: 'IMPLEMENTATION',
    prompt: scenario,
    requestedSettings: settings
  });
  const start = async () => {
    await adapter.initialize();
    await adapter.startTurn({
      localRunId: run.id,
      session: { localSessionId: session.id },
      mode: 'IMPLEMENTATION',
      prompt: scenario,
      authoritativeGoal: task.prompt,
      settings,
      attachments: []
    });
  };
  return { adapter, observedEvents, run, session, start, store };
}

function invalidGrokCatalogAgentSource(
  mutationMarker: string,
  initializeMeta: Record<string, unknown> | undefined
): string {
  return `
const fs = require('node:fs');
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: 1,
      agentCapabilities: { promptCapabilities: {} },
      agentInfo: { name: 'invalid-grok-catalog', version: '1.0.0' },
      ${initializeMeta ? `_meta: ${JSON.stringify(initializeMeta)}` : ''}
    }});
    return;
  }
  fs.appendFileSync(${JSON.stringify(mutationMarker)}, message.method + '\\n');
  send({ jsonrpc: '2.0', id: message.id, result: {} });
});
`;
}

function oversizedRedactedStartupEventsAgentSource(): string {
  return `
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method !== 'initialize') return;
  const notification = JSON.stringify({
    jsonrpc: '2.0',
    method: '_test/credential-payload',
    params: { apiKey: 'x'.repeat(1500000) }
  });
  const response = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
    protocolVersion: 1,
    agentCapabilities: { promptCapabilities: {} },
    agentInfo: { name: 'startup-buffer-agent', version: '1.0.0' },
    _meta: {
      modelState: {
        currentModelId: 'grok-build',
        availableModels: [{ modelId: 'grok-build', name: 'Grok Build' }]
      }
    }
  }});
  process.stdout.write(
    notification + '\\n' + notification + '\\n' + notification + '\\n' + response + '\\n'
  );
});
`;
}

function grokStartupModelUpdateAgentSource(
  mutationMarker: string,
  update: Record<string, unknown>
): string {
  return `
const fs = require('node:fs');
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    const response = { jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: 1,
      agentCapabilities: { promptCapabilities: {} },
      agentInfo: { name: 'grok-model-update', version: '1.0.0' },
      _meta: {
        modelState: {
          currentModelId: 'grok-build',
          availableModels: [{ modelId: 'grok-build', name: 'Grok Build' }]
        }
      }
    }};
    const notification = {
      jsonrpc: '2.0',
      method: '_x.ai/models/update',
      params: ${JSON.stringify(update)}
    };
    process.stdout.write(JSON.stringify(response) + '\\n' + JSON.stringify(notification) + '\\n');
    return;
  }
  fs.appendFileSync(${JSON.stringify(mutationMarker)}, message.method + '\\n');
  send({ jsonrpc: '2.0', id: message.id, result: {} });
});
`;
}

function terminalPersistenceAgentSource(): string {
  return `
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: 1,
      agentCapabilities: { promptCapabilities: {} },
      agentInfo: { name: 'terminal-persistence-agent', version: '1.0.0' }
    }});
    return;
  }
  if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      sessionId: 'terminal-persistence-session'
    }});
    return;
  }
  if (message.method === 'session/prompt') {
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
    return;
  }
  send({ jsonrpc: '2.0', id: message.id, result: {} });
});
`;
}

function permissionMaterializationAgentSource(): string {
  return `
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: 1,
      agentCapabilities: { promptCapabilities: {} },
      agentInfo: { name: 'permission-materialization-agent', version: '1.0.0' }
    }});
    return;
  }
  if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      sessionId: 'permission-materialization-session'
    }});
    return;
  }
  if (message.method === 'session/prompt') {
    return;
  }
});
`;
}

function streamSafetyAgentSource(): string {
  return `
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: 1,
      agentCapabilities: { promptCapabilities: {} },
      agentInfo: { name: 'stream-safety-agent', version: '1.0.0' }
    }});
    return;
  }
  if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      sessionId: 'stream-safety-session',
      configOptions: []
    }});
    return;
  }
  if (message.method !== 'session/prompt') return;
  const prompt = JSON.stringify(message.params.prompt);
  const stream = (text, messageId = 'stream-message') => send({ jsonrpc: '2.0', method: 'session/update', params: {
    sessionId: 'stream-safety-session',
    update: {
      sessionUpdate: 'agent_message_chunk',
      messageId,
      content: { type: 'text', text }
    }
  }});
  if (prompt.includes('self-overlap')) {
    stream(process.env.TEST_ACP_API_KEY);
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (prompt.includes('message-boundary')) {
    const secret = process.env.TEST_ACP_API_KEY;
    stream('one ' + secret.slice(0, 12), 'stream-message-1');
    stream('two', 'stream-message-2');
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (prompt.includes('split-credential')) {
    const secret = process.env.TEST_ACP_API_KEY;
    stream('before ' + secret.slice(0, 14));
    stream(secret.slice(14) + ' after');
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (prompt.includes('large-stream')) {
    for (let index = 0; index < 3; index += 1) stream('x'.repeat(1200 * 1024));
    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
    return;
  }
  stream('x'.repeat(70 * 1024));
});
`;
}

function replacementFenceAgentSource(generationFile: string): string {
  return `
const fs = require('node:fs');
const readline = require('node:readline');
let generation = 1;
try {
  generation = Number(fs.readFileSync(${JSON.stringify(generationFile)}, 'utf8')) + 1;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
fs.writeFileSync(${JSON.stringify(generationFile)}, String(generation));
const input = readline.createInterface({ input: process.stdin });
const send = (message, callback) =>
  process.stdout.write(JSON.stringify(message) + '\\n', callback);
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: 1,
      agentCapabilities: { promptCapabilities: {} },
      agentInfo: { name: 'replacement-fence-agent', version: '1.0.0' }
    }});
    return;
  }
  if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      sessionId: 'replacement-fence-session',
      configOptions: []
    }});
    return;
  }
  if (message.method === 'session/prompt' && generation === 1) {
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'replacement-fence-session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'accepted-old-message',
        content: { type: 'text', text: 'accepted old generation output' }
      }
    }}, () => process.exit(17));
    return;
  }
  send({ jsonrpc: '2.0', id: message.id, result: {} });
});
`;
}

function fakeAgentSource(cwd: string, initialModelId = 'grok-build'): string {
  return `
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
let promptRequestId;
let permissionCount = 0;
let currentModelId = ${JSON.stringify(initialModelId)};
let telemetryEnabled = true;
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: {},
        sessionCapabilities: { resume: {}, close: {} }
      },
      agentInfo: { name: 'fake-acp', version: '1.0.0' },
      _meta: {
        modelState: {
          currentModelId,
          availableModels: [
            {
              modelId: 'grok-composer-2.5-fast',
              name: 'Composer 2.5',
              description: 'Cursor latest coding model'
            },
            {
              modelId: 'grok-build',
              name: 'Grok Build',
              description: 'Best for advanced coding tasks'
            }
          ]
        }
      }
    }});
    return;
  }
  if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      sessionId: 'provider-session-1',
      modes: {
        currentModeId: 'code',
        availableModes: [
          { id: 'code', name: 'Code' },
          { id: 'plan', name: 'Plan' }
        ]
      },
      models: {
        currentModelId,
        availableModels: [
          {
            modelId: 'grok-composer-2.5-fast',
            name: 'Composer 2.5',
            description: 'Cursor latest coding model'
          },
          {
            modelId: 'grok-build',
            name: 'Grok Build',
            description: 'Best for advanced coding tasks'
          }
        ]
      },
      configOptions: [
        {
          id: 'model', name: 'Model', category: 'model', type: 'select',
          currentValue: 'default', options: [{ value: 'default', name: 'Provider default' }]
        },
        {
          id: 'telemetry', name: 'Telemetry', category: 'other', type: 'boolean',
          currentValue: true
        }
      ]
    }});
    return;
  }
  if (message.method === 'session/resume' || message.method === 'session/load') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      sessionId: message.params.sessionId,
      modes: {
        currentModeId: 'code',
        availableModes: [
          { id: 'code', name: 'Code' },
          { id: 'plan', name: 'Plan' }
        ]
      },
      models: {
        currentModelId,
        availableModels: [
          { modelId: 'grok-composer-2.5-fast', name: 'Composer 2.5' },
          { modelId: 'grok-build', name: 'Grok Build' }
        ]
      },
      configOptions: [
        {
          id: 'model', name: 'Model', category: 'model', type: 'select',
          currentValue: 'default', options: [{ value: 'default', name: 'Provider default' }]
        },
        {
          id: 'telemetry', name: 'Telemetry', category: 'other', type: 'boolean',
          currentValue: telemetryEnabled
        }
      ]
    }});
    return;
  }
  if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
    return;
  }
  if (message.method === 'session/set_model') {
    currentModelId = message.params.modelId;
    send({ jsonrpc: '2.0', id: message.id, result: {
      _meta: { model: { Ok: currentModelId } }
    }});
    return;
  }
  if (message.method === 'session/set_config_option') {
    if (message.params.configId === 'telemetry') telemetryEnabled = message.params.value;
    send({ jsonrpc: '2.0', id: message.id, result: {
      configOptions: [
        {
          id: 'model', name: 'Model', category: 'model', type: 'select',
          currentValue: 'default', options: [{ value: 'default', name: 'Provider default' }]
        },
        {
          id: 'telemetry', name: 'Telemetry', category: 'other', type: 'boolean',
          currentValue: telemetryEnabled
        }
      ]
    }});
    return;
  }
  if (message.method === 'session/close') {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
    return;
  }
  if (message.method === 'session/prompt') {
    promptRequestId = message.id;
    if (JSON.stringify(message.params.prompt).includes('delayed terminal')) {
      setTimeout(() => send({
        jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' }
      }), 250);
      return;
    }
    if (JSON.stringify(message.params.prompt).includes('hang for interrupt')) {
      return;
    }
    if (JSON.stringify(message.params.prompt).includes('ambiguous disconnect')) {
      process.exit(17);
    }
    if (JSON.stringify(message.params.prompt).includes('unsafe permission identifiers')) {
      send({ jsonrpc: '2.0', id: process.env.GEMINI_API_KEY, method: 'session/request_permission', params: {
        sessionId: 'provider-session-1',
        toolCall: { toolCallId: 'tool-safe', title: 'Unsafe provider request', kind: 'execute', rawInput: { command: 'npm test' } },
        options: [{ optionId: 'allow-safe', name: 'Allow once', kind: 'allow_once' }]
      }});
      return;
    }
    if (JSON.stringify(message.params.prompt).includes('definitive failure')) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'provider rejected prompt ' + process.env.GEMINI_API_KEY } });
      return;
    }
    if (JSON.stringify(message.params.prompt).includes('malformed terminal response')) {
      send({ jsonrpc: '2.0', id: message.id, result: {} });
      return;
    }
    if (JSON.stringify(message.params.prompt).includes('token limit terminal')) {
      send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'max_tokens' } });
      return;
    }
    if (JSON.stringify(message.params.prompt).includes('high volume stream')) {
      for (let index = 0; index < 512; index += 1) {
        send({ jsonrpc: '2.0', method: 'session/update', params: {
          sessionId: 'provider-session-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'message-high-volume',
            content: { type: 'text', text: String(index).padStart(4, '0') }
          }
        }});
      }
      send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
      return;
    }
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'provider-session-1',
      update: { sessionUpdate: 'plan', entries: [{ content: 'Implement', priority: 'high', status: 'in_progress' }] }
    }});
    for (const text of ['Implemented ', 'safely', '.']) {
      send({ jsonrpc: '2.0', method: 'session/update', params: {
        sessionId: 'provider-session-1',
        update: { sessionUpdate: 'agent_message_chunk', messageId: 'message-1', content: { type: 'text', text } }
      }});
    }
    permissionCount += 1;
    const permissionId = 'permission-native-' + permissionCount;
    send({ jsonrpc: '2.0', id: permissionId, method: 'session/request_permission', params: {
      sessionId: 'provider-session-1',
      toolCall: { toolCallId: 'tool-1', title: 'Run tests', kind: 'execute', rawInput: { command: 'npm test', cwd: ${JSON.stringify(cwd)} } },
      options: [
        { optionId: 'native-allow-42', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'native-reject-7', name: 'Reject', kind: 'reject_once' }
      ]
    }});
    return;
  }
  if (message.method === 'session/cancel') {
    const cancelledPromptRequestId = promptRequestId;
    setTimeout(() => send({
      jsonrpc: '2.0', method: 'session/update', params: {
        sessionId: 'provider-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'message-late-cancelled',
          content: { type: 'text', text: 'late output from cancelled prompt' }
        }
      }
    }), 60);
    setTimeout(() => send({
      jsonrpc: '2.0', id: cancelledPromptRequestId, result: { stopReason: 'cancelled' }
    }), 75);
    return;
  }
  if (typeof message.id === 'string' && message.id.startsWith('permission-native-') && message.result) {
    send({ jsonrpc: '2.0', id: promptRequestId, result: { stopReason: 'end_turn' } });
    return;
  }
  if (message.id === process.env.GEMINI_API_KEY && message.result?.outcome?.outcome === 'cancelled') {
    send({ jsonrpc: '2.0', id: promptRequestId, result: { stopReason: 'end_turn' } });
  }
});
`;
}
