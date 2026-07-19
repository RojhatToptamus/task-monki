import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '../../../shared/contracts';
import { addTestRepository } from '../../../testSupport/repositoryFixture';
import { AgentOrchestrator } from '../AgentOrchestrator';
import { AgentMutationAmbiguousError } from '../AgentRuntimeAdapter';
import { AppEventBus } from '../../runner/AppEventBus';
import {
  ArtifactAppendAmbiguousError,
  FileTaskStore
} from '../../storage/FileTaskStore';
import { writeNodeExecutable } from '../../../testSupport/fakeExecutable';
import { CodexAppServerAdapter } from './CodexAppServerAdapter';
import {
  CODEX_APP_SERVER_NOTIFICATION_OPT_OUTS,
  CodexAppServerSupervisor
} from './CodexAppServerSupervisor';
import {
  CodexAmbiguousMutationError,
  type CodexRpcClient
} from './CodexRpcClient';

const APP_SERVER_INTEGRATION_TIMEOUT_MS = 20_000;

describe('CodexAppServerAdapter', { timeout: APP_SERVER_INTEGRATION_TIMEOUT_MS }, () => {
  it('can initialize again after a confirmed idle shutdown', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-app-server-reenable-'));
    const executable = await writeFakeCodexExecutable(dir);
    const store = new FileTaskStore(path.join(dir, 'store'));
    const adapter = new CodexAppServerAdapter(store, new AppEventBus(), {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });

    try {
      await adapter.initialize();
      await expect(adapter.listModels()).resolves.toContainEqual(
        expect.objectContaining({ model: 'fake-model' })
      );
      await adapter.shutdown();

      await adapter.initialize();
      await expect(adapter.preflight()).resolves.toMatchObject({
        readiness: { status: 'READY', canStart: true }
      });
      expect(
        (await store.snapshot()).agentServers.filter(
          (server) => server.runtimeId === 'codex' && server.status === 'READY'
        )
      ).toHaveLength(1);
    } finally {
      await adapter.shutdown();
    }
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('does not report ready when the live Codex model catalog is empty', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-app-server-empty-models-'));
    const executable = await writeFakeCodexExecutable(dir, 'empty-models');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const adapter = new CodexAppServerAdapter(store, new AppEventBus(), {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });

    try {
      await adapter.initialize();
      await expect(adapter.preflight()).resolves.toMatchObject({
        readiness: {
          status: 'FAILED',
          canStart: false,
          checks: { modelCatalog: 'FAILED' },
          diagnostics: [
            expect.objectContaining({
              code: 'MODEL_CATALOG_FAILED',
              stage: 'MODEL_CATALOG'
            })
          ]
        }
      });
    } finally {
      await adapter.shutdown();
    }
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('preserves an explicit Codex model provider that model/list cannot identify', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-app-server-model-provider-')
    );
    const executable = await writeFakeCodexExecutable(dir);
    const store = new FileTaskStore(path.join(dir, 'store'));
    const adapter = new CodexAppServerAdapter(store, new AppEventBus(), {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });

    try {
      await adapter.initialize();
      const providerDefault = await adapter.resolveExecution({
        settings: {
          runtimeId: 'codex',
          model: 'fake-model',
          reasoningEffort: 'low',
          sandbox: 'WORKSPACE_WRITE',
          networkAccess: false,
          approvalPolicy: 'on-request'
        },
        attachments: []
      });
      expect(providerDefault.settings.modelProvider).toBeUndefined();
      expect(providerDefault.model).toMatchObject({
        id: 'codex:fake-model',
        runtimeId: 'codex',
        model: 'fake-model'
      });
      expect(providerDefault.model).not.toHaveProperty('modelProvider');

      const resolved = await adapter.resolveExecution({
        settings: {
          runtimeId: 'codex',
          model: 'fake-model',
          modelProvider: 'azure-openai',
          reasoningEffort: 'high',
          sandbox: 'WORKSPACE_WRITE',
          networkAccess: false,
          approvalPolicy: 'on-request'
        },
        attachments: []
      });

      expect(resolved.settings.modelProvider).toBe('azure-openai');
      expect(resolved.model).toMatchObject({
        id: 'codex:azure-openai/fake-model',
        runtimeId: 'codex',
        modelProvider: 'azure-openai',
        model: 'fake-model'
      });
    } finally {
      await adapter.shutdown();
    }
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('rejects an explicit model that is absent after a forced catalog refresh', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-app-server-missing-model-')
    );
    const executable = await writeFakeCodexExecutable(dir);
    const adapter = new CodexAppServerAdapter(
      new FileTaskStore(path.join(dir, 'store')),
      new AppEventBus(),
      {
        cwd: dir,
        executable,
        requestTimeoutMs: 2_000,
        restartDelaysMs: []
      }
    );

    try {
      await adapter.initialize();
      await expect(
        adapter.resolveExecution({
          settings: {
            runtimeId: 'codex',
            model: 'removed-model',
            modelProvider: 'openai',
            sandbox: 'WORKSPACE_WRITE',
            networkAccess: false,
            approvalPolicy: 'on-request'
          },
          attachments: []
        })
      ).rejects.toThrow('Codex did not report requested model removed-model.');
    } finally {
      await adapter.shutdown();
    }
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('replaces a one-way supervisor for an explicit safe runtime restart', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-app-server-restart-'));
    const executable = await writeFakeCodexExecutable(dir);
    const store = new FileTaskStore(path.join(dir, 'store'));
    const adapter = new CodexAppServerAdapter(store, new AppEventBus(), {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });

    await adapter.initialize();
    await adapter.updateRuntimeConfig({
      executable,
      toolSettings: {
        webSearchMode: 'cached',
        mcpServers: 'all',
        apps: 'disabled'
      },
      restart: true
    });

    const servers = (await store.snapshot()).agentServers.filter(
      (server) => server.runtimeId === 'codex'
    );
    expect(servers).toHaveLength(2);
    expect(servers.map((server) => server.status).sort()).toEqual(['EXITED', 'READY']);
    expect(
      servers.find((server) => server.status === 'READY')?.argv
    ).toContain('web_search="cached"');
    await expect(adapter.listModels()).resolves.toEqual([
      expect.objectContaining({ model: 'fake-model' })
    ]);
    await adapter.shutdown();
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('uses Codex native unrestricted permissions for Full access', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-codex-full-access-'));
    const worktreePath = path.join(dir, 'worktree');
    await fs.mkdir(worktreePath);
    const executable = await writeFakeCodexExecutable(dir);
    const store = new FileTaskStore(path.join(dir, 'store'));
    const adapter = new CodexAppServerAdapter(store, new AppEventBus(), {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const settings = {
      runtimeId: 'codex' as const,
      model: 'fake-model',
      sandbox: 'DANGER_FULL_ACCESS' as const,
      networkAccess: true,
      approvalPolicy: 'never' as const
    };

    try {
      await adapter.initialize();
      const task = await store.createTask({
        title: 'Full access contract',
        prompt: 'Use the native unrestricted profile.',
        repositoryId: (await addTestRepository(store, worktreePath)).id,
        agentSettings: settings
      });
      const { iteration, worktree } = await store.createIterationAndWorktree({
        task,
        branchName: 'codex/full-access-contract',
        worktreePath,
        baseSha: 'base'
      });
      const session = await store.createAgentSession({
        task,
        iteration,
        worktree,
        runtimeId: 'codex'
      });

      await adapter.createSession({
        runtimeId: 'codex',
        localSessionId: session.id,
        taskId: task.id,
        iterationId: iteration.id,
        worktreeId: worktree.id,
        worktreePath,
        settings
      });

      const server = (await store.snapshot()).agentServers.find(
        (candidate) => candidate.runtimeId === 'codex' && candidate.status === 'READY'
      );
      const outbound = readOutboundMessages(
        await fs.readFile(server!.protocolJournalPath, 'utf8')
      );
      const start = outbound.find((message) => message.method === 'thread/start');
      expect(start?.params).toMatchObject({
        config: { default_permissions: ':danger-full-access' }
      });
      expect(start?.params).not.toHaveProperty('sandbox');
      expect((start?.params as { config?: unknown }).config).not.toHaveProperty(
        'permissions'
      );
    } finally {
      await adapter.shutdown();
    }
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('discovers models and completes a real thread/turn lifecycle over stdio', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-app-server-'));
    const executable = await writeFakeCodexExecutable(dir);

    const store = new FileTaskStore(path.join(dir, 'store'));
    const appendArtifact = vi.spyOn(store, 'appendArtifact');
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter, {
    });
    await orchestrator.initialize();

    const catalog = await orchestrator.getRuntimeCatalog();
    const runtime = catalog.runtimes[0]!;
    expect(
      runtime.preflight.readiness.canStart,
      JSON.stringify(runtime.preflight.readiness.diagnostics)
    ).toBe(true);
    expect(runtime.models[0]?.model).toBe('fake-model');
    expect(runtime.models[0]?.supportedReasoningEfforts).toEqual(['low', 'high']);
    expect(adapter.currentRuntimeExecutable).toBe(executable);
    const initializedServer = (await store.snapshot()).agentServers[0];
    expect(initializedServer.runtimeResolution).toMatchObject({
      selectedExecutable: executable,
      selectedSource: 'config',
      selectedVersion: '0.141.0',
      selectedLaunchArgv: ['app-server', '--stdio'],
      requiredCapabilities: expect.arrayContaining(['thread/start', 'turn/start', 'review/start'])
    });
    expect(initializedServer.runtimeResolution?.probes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          executable,
          source: 'config',
          compatible: true,
          version: '0.141.0',
          launchForm: 'stdio-flag'
        })
      ])
    );
    const initializedJournal = await fs.readFile(
      initializedServer.protocolJournalPath,
      'utf8'
    );
    const initializeMessage = readOutboundMessages(initializedJournal).find(
      (message) => message.method === 'initialize'
    );
    expect(initializeMessage?.params).toMatchObject({
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        optOutNotificationMethods: expect.arrayContaining(
          [...CODEX_APP_SERVER_NOTIFICATION_OPT_OUTS]
        )
      }
    });
    expect(readOutboundMethods(initializedJournal)).not.toContain(
      'modelProvider/capabilities/read'
    );

    const repositoryDir = path.join(dir, 'repository');
    await fs.mkdir(repositoryDir);
    const imageBytes = onePixelPng();
    const textBytes = Buffer.from('{"reproduction":true}\n');
    const draft = await store.createAttachmentDraft();
    await store.stageTaskAttachment({
      draftId: draft.id,
      displayName: 'screen.png',
      bytes: imageBytes
    });
    await store.stageTaskAttachment({
      draftId: draft.id,
      displayName: 'reproduction.json',
      bytes: textBytes
    });
    const task = await store.createTask({
      title: 'App Server turn',
      prompt: 'Finish the fake task.',
      repositoryId: (await addTestRepository(store, repositoryDir)).id,
      attachmentDraftId: draft.id,
      agentSettings: {
        model: 'fake-model',
        reasoningEffort: 'high',
        sandbox: 'WORKSPACE_WRITE',
        networkAccess: false,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review'
      }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/fake-app-server',
      worktreePath: repositoryDir,
      baseSha: 'base'
    });
    const verifiedAttachments = await store.verifyTaskAttachments(task.id);
    const canonicalImagePath = verifiedAttachments.find(
      (attachment) => attachment.record.kind === 'image'
    )!.absolutePath;
    const canonicalTextPath = verifiedAttachments.find(
      (attachment) => attachment.record.kind === 'text'
    )!.absolutePath;
    const terminal = new Promise<void>((resolve) => {
      events.on((event) => {
        if (event.type === 'run.terminal') {
          resolve();
        }
      });
    });

    const run = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });
    await terminal;

    const snapshot = await waitForSnapshot(
      store,
      (candidate) =>
        candidate.agentUsageSnapshots.length > 0 &&
        candidate.agentGoalSnapshots.length > 0 &&
        candidate.agentSettingsObservations.some(
          (record) =>
            record.settings.networkAccess === false &&
            record.settings.approvalsReviewer === 'auto_review'
        ),
      'provider observations'
    );
    const completed = snapshot.runs.find((candidate) => candidate.id === run.id);
    expect(completed?.status).toBe('COMPLETED');
    expect(completed?.providerTurnId).toBe('turn-1');
    expect(completed?.finalMessage).toBe('Fake task completed.');
    expect(appendArtifact).toHaveBeenCalledTimes(1);
    expect(appendArtifact.mock.calls[0]?.[1]).toContain('Fake task completed.');
    expect(await store.readArtifact(completed!.outputArtifactId)).toContain(
      'Fake task completed.'
    );
    expect(completed?.attachmentSubmissions).toEqual([
      expect.objectContaining({
        kind: 'image',
        submittedAs: 'localImage',
        providerTurnId: 'turn-1',
        submittedAt: expect.any(String)
      }),
      expect.objectContaining({
        kind: 'text',
        submittedAs: 'prompt-file-reference',
        providerTurnId: 'turn-1',
        submittedAt: expect.any(String)
      })
    ]);
    expect(completed?.attachmentSubmissions?.[0]).not.toHaveProperty('path');
    expect(snapshot.agentSessions[0]?.providerSessionId).toBe('thread-1');
    expect(snapshot.agentItems.map((item) => item.type)).toContain('AGENT_MESSAGE');
    expect(snapshot.agentItems.map((item) => item.type)).toContain('REASONING_SUMMARY');
    expect(snapshot.agentItems.map((item) => item.type)).toContain('CONTEXT_COMPACTION');
    expect(snapshot.agentPlanRevisions).toHaveLength(1);
    expect(snapshot.agentPlanRevisions[0]?.steps[0]?.status).toBe('IN_PROGRESS');
    expect(snapshot.agentUsageSnapshots[0]?.total.totalTokens).toBe(120);
    expect(snapshot.agentGoalSnapshots[0]?.syncState).toBe('IN_SYNC');
    expect(
      snapshot.agentSettingsObservations.some(
        (record) =>
          record.source === 'THREAD_START_RESPONSE' &&
          record.settings.approvalsReviewer === 'auto_review'
      )
    ).toBe(true);
    expect(
      snapshot.agentSettingsObservations.some(
        (record) =>
          record.source === 'THREAD_SETTINGS_NOTIFICATION' &&
          record.settings.networkAccess === false &&
          record.settings.approvalsReviewer === 'auto_review'
      )
    ).toBe(true);
    expect(snapshot.agentServers[0]?.runtimeKind).toBe('APP_SERVER');
    expect(
      snapshot.agentServers.some((server) => server.runtimeKind !== 'APP_SERVER')
    ).toBe(false);
    const finalJournal = await fs.readFile(
      snapshot.agentServers[0]!.protocolJournalPath,
      'utf8'
    );
    const outbound = readOutboundMessages(finalJournal);
    expect(finalJournal).not.toContain(imageBytes.toString('utf8'));
    expect(finalJournal).not.toContain(textBytes.toString('utf8').trim());
    // The parsed raw protocol journal is the explicit debug-only exception to
    // the path-free durable-record rule because Codex receives managed paths.
    const firstThreadStart = outbound.find((message) => message.method === 'thread/start');
    expect(firstThreadStart?.params).toMatchObject({
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      modelProvider: null
    });
    const turnStarts = outbound.filter((message) => message.method === 'turn/start');
    expect(turnStarts).toHaveLength(1);
    expect(outbound.filter((message) => message.method === 'thread/resume')).toHaveLength(0);
    const turnStart = turnStarts[0];
    expect(turnStart?.params).toMatchObject({
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review'
    });
    expect(turnStart?.params).not.toHaveProperty('sandboxPolicy');
    const profileConfig = (firstThreadStart?.params as { config?: unknown } | undefined)?.config as {
      default_permissions?: string;
      permissions?: Record<string, {
        filesystem?: Record<string, string>;
        network?: { enabled?: boolean };
      }>;
    } | undefined;
    const profile = profileConfig?.default_permissions
      ? profileConfig.permissions?.[profileConfig.default_permissions]
      : undefined;
    expect(profileConfig?.default_permissions).toMatch(/^task_monki_/u);
    expect(profile?.filesystem?.[repositoryDir]).toBe('write');
    expect(profile?.network?.enabled).toBe(false);
    const turnInput = (turnStart?.params as {
      input?: Array<{ type?: string; text?: string; path?: string }>;
    } | undefined)?.input;
    const deliveryImagePath = turnInput?.find((item) => item.type === 'localImage')?.path;
    const manifestPaths = readAttachmentManifestPaths(
      turnInput?.find((item) => item.type === 'text')?.text
    );
    const deliveryTextPath = manifestPaths.find((candidate) => candidate !== deliveryImagePath);
    expect(deliveryImagePath).toBe(canonicalImagePath);
    expect(deliveryTextPath).toBe(canonicalTextPath);
    expect(turnInput).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('Task Monki attachment manifest:')
      }),
      { type: 'localImage', path: deliveryImagePath }
    ]);
    expect(manifestPaths).toContain(canonicalTextPath);
    await expect(fs.access(deliveryImagePath!)).resolves.toBeUndefined();
    await expect(fs.access(deliveryTextPath!)).resolves.toBeUndefined();

    await orchestrator.shutdown();
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('redacts Codex telemetry before normalized records and output artifacts are persisted', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-codex-redaction-'));
    const executable = await writeFakeCodexExecutable(dir, 'credential-telemetry');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      environment: {
        ...process.env,
        OPENAI_API_KEY: 'opaque-provider-credential-1742'
      },
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter);
    const outputEvents: Array<{ source: string; text: string }> = [];
    events.on((event) => {
      if (event.type === 'run.output') {
        outputEvents.push(event.payload as { source: string; text: string });
      }
    });
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const terminal = waitForAppEvent(events, 'run.terminal');
    const run = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });
    await terminal;

    const snapshot = await store.snapshot();
    const completed = snapshot.runs.find((candidate) => candidate.id === run.id)!;
    const output = await store.readArtifact(completed.outputArtifactId);
    const final = await store.readArtifact(completed.finalArtifactId!);
    const journal = await fs.readFile(
      snapshot.agentServers[0]!.protocolJournalPath,
      'utf8'
    );
    const normalized = `${JSON.stringify(snapshot)}\n${journal}\n${output}\n${final}`;
    expect(normalized).toContain('[REDACTED]');
    expect(outputEvents.map((event) => event.text).join('')).toContain(
      '[REDACTED] completed.'
    );
    expect(journal).not.toContain('opaque-provider-');
    expect(journal).not.toContain('credential-1742');
    for (const secret of [
      'credential-error-secret',
      'credential-item-secret',
      'credential-message-secret',
      'credential-output-secret',
      'opaque-provider-credential-1742'
    ]) {
      expect(normalized).not.toContain(secret);
    }
    const sourceSession = snapshot.agentSessions.find(
      (session) => session.id === completed.sessionId
    );
    const childSession = snapshot.agentSessions.find(
      (session) => session.providerSessionId === 'credential-child'
    );
    const childObservation = snapshot.agentSubagentObservations.find(
      (observation) => observation.providerChildSessionId === 'credential-child'
    );
    expect(sourceSession?.observedSettings?.model).toBeUndefined();
    expect(childSession).toBeDefined();
    expect(childSession).toMatchObject({
      providerNickname: '[REDACTED]',
      providerRole: '[REDACTED]',
      agentPath: '[REDACTED]'
    });
    expect(childSession?.requestedSettings.model).toBeUndefined();
    expect(childSession?.requestedSettings.reasoningEffort).toBeUndefined();
    expect(childObservation?.requestedSettings?.model).toBeUndefined();
    expect(childObservation?.requestedSettings?.reasoningEffort).toBeUndefined();

    await orchestrator.shutdown();
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('restores a failed output batch ahead of deltas appended during persistence', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-output-buffer-'));
    const store = new FileTaskStore(path.join(dir, 'store'));
    const adapter = new CodexAppServerAdapter(store, new AppEventBus(), {
      cwd: dir,
      environment: {
        ...process.env,
        OPENAI_API_KEY: 'opaque-provider-credential-1742'
      },
      restartDelaysMs: []
    });
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const session = await store.createAgentSession({
      task,
      iteration,
      worktree,
      runtimeId: 'codex',
      requestedSettings: task.agentSettings
    });
    const run = await store.createRun({
      task,
      session,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      requestedSettings: task.agentSettings
    });
    await store.updateRun(run.id, {
      providerTurnId: 'buffered-turn',
      status: 'RUNNING'
    });
    const buffered = adapter as unknown as {
      appendTurnOutput(turnId: string, source: string, text: string): Promise<void>;
      flushBufferedOutput(runId: string, releaseCredentialCarry?: boolean): Promise<void>;
    };
    const appendArtifact = store.appendArtifact.bind(store);
    let releasePersistence!: () => void;
    let markPersistenceStarted!: () => void;
    const persistenceRelease = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const persistenceStarted = new Promise<void>((resolve) => {
      markPersistenceStarted = resolve;
    });
    let appendAttempts = 0;
    vi.spyOn(store, 'appendArtifact').mockImplementation(async (...args) => {
      appendAttempts += 1;
      if (appendAttempts === 1) {
        markPersistenceStarted();
        await persistenceRelease;
        throw new Error('injected output persistence failure');
      }
      return appendArtifact(...args);
    });

    await buffered.appendTurnOutput('buffered-turn', 'agentMessage', 'opaque-provider-');
    await buffered.appendTurnOutput('buffered-turn', 'agentMessage', 'credential-1742');
    const failedFlush = buffered.flushBufferedOutput(run.id);
    await persistenceStarted;
    await buffered.appendTurnOutput('buffered-turn', 'agentMessage', ' after');
    const concurrentFlush = buffered.flushBufferedOutput(run.id);
    const concurrentFailure = expect(concurrentFlush).rejects.toThrow(
      'injected output persistence failure'
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(appendAttempts).toBe(1);
    releasePersistence();
    await expect(failedFlush).rejects.toThrow('injected output persistence failure');
    await concurrentFailure;
    await buffered.flushBufferedOutput(run.id, true);

    const output = await store.readArtifact(run.outputArtifactId);
    expect(output).toContain('[REDACTED] after');
    expect(output).not.toContain('opaque-provider-credential-1742');
    expect(appendAttempts).toBe(2);
    await store.close();
  });

  it('redacts unresolved credential prefixes at source and terminal boundaries', async () => {
    const { adapter, run, store } = await createBufferedCodexRun(
      'task-monki-output-prefix-'
    );
    const buffered = adapter as unknown as {
      appendTurnOutput(turnId: string, source: string, text: string): Promise<void>;
      recordLocalInterruption(run: RunRecord, reason: string): Promise<void>;
    };

    await buffered.appendTurnOutput(
      'buffered-turn',
      'agentMessage',
      'opaque-provider-'
    );
    await buffered.appendTurnOutput(
      'buffered-turn',
      'reasoning',
      'opaque-provider-'
    );
    await buffered.recordLocalInterruption(run, 'Provider output ended.');

    const output = await store.readArtifact(run.outputArtifactId);
    expect(output.match(/\[REDACTED\]/gu)).toHaveLength(2);
    expect(output).not.toContain('opaque-provider-');
    await store.close();
  });

  it('redacts a complete self-overlapping credential before selecting carry', async () => {
    const { adapter, run, store } = await createBufferedCodexRun(
      'task-monki-output-overlap-',
      'aaaaaaaa'
    );
    const buffered = adapter as unknown as {
      appendTurnOutput(turnId: string, source: string, text: string): Promise<void>;
      recordLocalInterruption(run: RunRecord, reason: string): Promise<void>;
    };

    await buffered.appendTurnOutput('buffered-turn', 'output', 'aaaaaaaa');
    await buffered.recordLocalInterruption(run, 'Provider output ended.');

    const output = await store.readArtifact(run.outputArtifactId);
    expect(output).toContain('\n[output]\n[REDACTED]');
    expect(output).not.toContain('\n[output]\na[REDACTED]');
    await store.close();
  });

  it('does not retry an output append whose durable file state is ambiguous', async () => {
    const { adapter, run, store } = await createBufferedCodexRun(
      'task-monki-output-ambiguous-'
    );
    const buffered = adapter as unknown as {
      appendTurnOutput(turnId: string, source: string, text: string): Promise<void>;
      flushBufferedOutput(runId: string): Promise<void>;
      streamBuffers: Map<string, unknown>;
    };
    const appendArtifact = vi.spyOn(store, 'appendArtifact').mockRejectedValue(
      new ArtifactAppendAmbiguousError(
        run.outputArtifactId,
        new Error('injected snapshot persistence failure'),
        new Error('injected artifact rollback failure')
      )
    );

    await buffered.appendTurnOutput('buffered-turn', 'agentMessage', 'safe output');
    await expect(buffered.flushBufferedOutput(run.id)).rejects.toBeInstanceOf(
      ArtifactAppendAmbiguousError
    );
    await expect(buffered.flushBufferedOutput(run.id)).resolves.toBeUndefined();

    expect(appendArtifact).toHaveBeenCalledTimes(1);
    expect(buffered.streamBuffers.has(run.id)).toBe(false);
    await expect(adapter.preflight()).resolves.toMatchObject({
      readiness: { status: 'FAILED', canStart: false }
    });
    await store.close();
  });

  it('bounds output append retries and fences repeated persistence failure', async () => {
    const { adapter, run, store } = await createBufferedCodexRun(
      'task-monki-output-retries-'
    );
    const buffered = adapter as unknown as {
      appendTurnOutput(turnId: string, source: string, text: string): Promise<void>;
      flushBufferedOutput(runId: string): Promise<void>;
      streamBuffers: Map<string, unknown>;
    };
    const appendArtifact = vi
      .spyOn(store, 'appendArtifact')
      .mockRejectedValue(new Error('injected output persistence failure'));

    await buffered.appendTurnOutput('buffered-turn', 'agentMessage', 'safe output');
    await expect(buffered.flushBufferedOutput(run.id)).rejects.toThrow(
      'injected output persistence failure'
    );
    await expect(buffered.flushBufferedOutput(run.id)).rejects.toThrow(
      'injected output persistence failure'
    );
    await expect(buffered.flushBufferedOutput(run.id)).resolves.toBeUndefined();

    expect(appendArtifact).toHaveBeenCalledTimes(2);
    expect(buffered.streamBuffers.has(run.id)).toBe(false);
    await expect(adapter.preflight()).resolves.toMatchObject({
      readiness: { status: 'FAILED', canStart: false }
    });
    await store.close();
  });

  it('publishes exactly one terminal outcome when local and provider settlement race', async () => {
    const { adapter, events, run, store } = await createBufferedCodexRun(
      'task-monki-terminal-owner-'
    );
    const terminalEvents: unknown[] = [];
    events.on((event) => {
      if (event.type === 'run.terminal') terminalEvents.push(event);
    });
    const settlement = adapter as unknown as {
      recordLocalInterruption(run: RunRecord, reason: string): Promise<void>;
      finalizeTurn(
        run: RunRecord,
        turn: {
          id: string;
          items: never[];
          itemsView: { type: 'complete' };
          status: 'completed';
          error: null;
          startedAt: number;
          completedAt: number;
          durationMs: number;
        },
        source: 'TURN_COMPLETED_NOTIFICATION'
      ): Promise<void>;
    };

    await Promise.all([
      settlement.recordLocalInterruption(run, 'Local interrupt deadline elapsed.'),
      settlement.finalizeTurn(
        run,
        {
          id: 'buffered-turn',
          items: [],
          itemsView: { type: 'complete' },
          status: 'completed',
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1
        },
        'TURN_COMPLETED_NOTIFICATION'
      )
    ]);

    const snapshot = await store.snapshot();
    expect(await store.getRun(run.id)).toMatchObject({ status: 'INTERRUPTED' });
    expect(
      snapshot.events.filter(
        (event) =>
          event.runId === run.id &&
          ['AGENT_RUN_COMPLETED', 'AGENT_RUN_FAILED', 'AGENT_RUN_INTERRUPTED'].includes(
            event.type
          )
      )
    ).toHaveLength(1);
    expect(
      snapshot.artifacts.filter(
        (artifact) => artifact.runId === run.id && artifact.kind === 'agent-final'
      )
    ).toHaveLength(1);
    expect(terminalEvents).toHaveLength(1);
    await store.close();
  });

  it('does not let stale reconciliation overwrite a terminal settlement', async () => {
    const { adapter, events, run, store } = await createBufferedCodexRun(
      'task-monki-reconciliation-owner-'
    );
    const terminalEvents: unknown[] = [];
    events.on((event) => {
      if (event.type === 'run.terminal') terminalEvents.push(event);
    });
    const settlement = adapter as unknown as {
      recordLocalInterruption(run: RunRecord, reason: string): Promise<void>;
      recordReconciliation(
        run: RunRecord,
        status: RunRecord['status'],
        recoveryState: RunRecord['recoveryState'],
        terminal: boolean
      ): Promise<RunRecord | undefined>;
    };
    const writeFinalArtifact = store.writeFinalArtifact.bind(store);
    let releaseFinalArtifact!: () => void;
    let markFinalArtifactStarted!: () => void;
    const finalArtifactRelease = new Promise<void>((resolve) => {
      releaseFinalArtifact = resolve;
    });
    const finalArtifactStarted = new Promise<void>((resolve) => {
      markFinalArtifactStarted = resolve;
    });
    vi.spyOn(store, 'writeFinalArtifact').mockImplementation(async (...args) => {
      markFinalArtifactStarted();
      await finalArtifactRelease;
      return writeFinalArtifact(...args);
    });

    const interruption = settlement.recordLocalInterruption(
      run,
      'Local interrupt deadline elapsed.'
    );
    await finalArtifactStarted;
    const staleReconciliation = settlement.recordReconciliation(
      run,
      'COMPLETED',
      'RECOVERED',
      true
    );
    releaseFinalArtifact();
    await Promise.all([interruption, staleReconciliation]);

    const snapshot = await store.snapshot();
    expect(await store.getRun(run.id)).toMatchObject({ status: 'INTERRUPTED' });
    expect(
      snapshot.events.filter(
        (event) =>
          event.runId === run.id &&
          ['AGENT_RUN_COMPLETED', 'AGENT_RUN_FAILED', 'AGENT_RUN_INTERRUPTED'].includes(
            event.type
          )
      )
    ).toHaveLength(1);
    expect(
      snapshot.events.filter(
        (event) => event.runId === run.id && event.type === 'AGENT_RUNTIME_RECONCILED'
      )
    ).toHaveLength(0);
    expect(terminalEvents).toHaveLength(1);
    await store.close();
  });

  it('reconciles a terminal notification after one materialization failure without replaying the prompt', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-terminal-materialization-recovery-')
    );
    const executable = await writeFakeCodexExecutable(
      dir,
      'recovery-notification-echo'
    );
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter);
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const appendRunEventIfStatus = store.appendRunEventIfStatus.bind(store);
    const updateAgentSession = store.updateAgentSession.bind(store);
    let rejectedTerminalEvent = false;
    let rejectedRecoveryEcho = false;
    vi.spyOn(store, 'appendRunEventIfStatus').mockImplementation(async (event, statuses) => {
      if (!rejectedTerminalEvent && event.type === 'AGENT_RUN_COMPLETED') {
        rejectedTerminalEvent = true;
        throw new Error('injected terminal event persistence failure');
      }
      return appendRunEventIfStatus(event, statuses);
    });
    vi.spyOn(store, 'updateAgentSession').mockImplementation(async (sessionId, update) => {
      if (
        rejectedTerminalEvent &&
        !rejectedRecoveryEcho &&
        update.status === 'IDLE' &&
        update.materialized === true &&
        update.observedSettings === undefined
      ) {
        rejectedRecoveryEcho = true;
        throw new Error('injected recovery notification echo persistence failure');
      }
      return updateAgentSession(sessionId, update);
    });

    const terminal = waitForAppEvent(events, 'run.terminal');
    const run = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });
    await terminal;
    const completed = await waitForRunStatus(store, run.id, 'COMPLETED');
    await waitForSnapshot(
      store,
      () => rejectedRecoveryEcho,
      'recovery notification echo failure'
    );
    const snapshot = await store.snapshot();
    const server = snapshot.agentServers.find(
      (candidate) => candidate.runtimeId === 'codex' && candidate.status === 'READY'
    )!;
    const outbound = readOutboundMessages(
      await fs.readFile(server.protocolJournalPath, 'utf8')
    );

    expect(rejectedTerminalEvent).toBe(true);
    expect(rejectedRecoveryEcho).toBe(true);
    expect(completed.providerTerminalSource).toBe('RECOVERY_RESUME_RESPONSE');
    expect(
      snapshot.artifacts.filter(
        (artifact) => artifact.runId === run.id && artifact.kind === 'agent-final'
      )
    ).toHaveLength(1);
    expect(outbound.filter((message) => message.method === 'turn/start')).toHaveLength(1);
    expect(outbound.filter((message) => message.method === 'thread/resume')).toHaveLength(1);
    expect(adapter.getProviderState().preflight).toMatchObject({
      readiness: {
        status: 'DEGRADED',
        canStart: true,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'EVENT_MATERIALIZATION_FAILED' })
        ])
      }
    });

    await orchestrator.shutdown();
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('fences the App Server when terminal materialization cannot be reconciled durably', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-terminal-materialization-fence-')
    );
    const executable = await writeFakeCodexExecutable(dir);
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [5, 10]
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter);
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const appendRunEventIfStatus = store.appendRunEventIfStatus.bind(store);
    vi.spyOn(store, 'appendRunEventIfStatus').mockImplementation(
      async (event, statuses) => {
        if (
          event.type === 'AGENT_RUN_COMPLETED' ||
          event.type === 'AGENT_RUNTIME_RECONCILED'
        ) {
          throw new Error('injected persistent AGENT_RUN_COMPLETED persistence failure');
        }
        return appendRunEventIfStatus(event, statuses);
      }
    );

    const run = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });
    const fenced = await waitForSnapshot(
      store,
      (snapshot) =>
        snapshot.runs.some(
          (candidate) => candidate.id === run.id && candidate.status === 'RECOVERY_REQUIRED'
        ) &&
        snapshot.agentServers.some(
          (server) => server.runtimeId === 'codex' && server.status === 'EXITED'
        ),
      'terminal materialization recovery fence'
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    const servers = (await store.snapshot()).agentServers.filter(
      (server) => server.runtimeId === 'codex'
    );
    expect(servers).toHaveLength(1);
    await expect(adapter.preflight()).resolves.toMatchObject({
      readiness: {
        status: 'FAILED',
        canStart: false,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'EVENT_MATERIALIZATION_FAILED' }),
          expect.objectContaining({ code: 'EVENT_MATERIALIZATION_RECOVERY_FAILED' })
        ])
      }
    });
    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'RETRY',
        prompt: 'Do not replay the prompt while terminal persistence is uncertain.',
        settings: task.agentSettings,
        retryOfRunId: run.id
      })
    ).rejects.toThrow();

    const journal = await fs.readFile(
      fenced.agentServers.find((server) => server.runtimeId === 'codex')!
        .protocolJournalPath,
      'utf8'
    );
    const outbound = readOutboundMessages(journal);
    expect(outbound.filter((message) => message.method === 'turn/start')).toHaveLength(1);
    expect(outbound.filter((message) => message.method === 'thread/resume')).toHaveLength(1);

    await orchestrator.shutdown();
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('replaces an unmaterialized empty thread after App Server restart without resuming or replaying a prompt', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-empty-thread-restart-')
    );
    const executable = await writeFakeCodexExecutable(dir);
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const firstAdapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    await firstAdapter.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const localSession = await store.createAgentSession({
      task,
      iteration,
      worktree,
      runtimeId: 'codex',
      requestedSettings: task.agentSettings
    });
    const emptySession = await firstAdapter.createSession({
      runtimeId: 'codex',
      localSessionId: localSession.id,
      taskId: task.id,
      iterationId: iteration.id,
      worktreeId: worktree.id,
      worktreePath: worktree.worktreePath,
      settings: task.agentSettings,
      attachments: []
    });
    expect(emptySession).toMatchObject({
      providerSessionId: 'thread-1',
      materialized: false
    });
    await firstAdapter.shutdown();

    const secondAdapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = new AgentOrchestrator(store, events, secondAdapter);
    await orchestrator.initialize();
    const run = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });
    await waitForRunStatus(store, run.id, 'COMPLETED');

    const servers = (await store.snapshot()).agentServers.filter(
      (server) => server.runtimeId === 'codex'
    );
    const replacement = servers.find((server) => server.status === 'READY');
    expect(replacement).toBeDefined();
    const journal = await fs.readFile(replacement!.protocolJournalPath, 'utf8');
    const outbound = readOutboundMessages(journal);
    expect(outbound.filter((message) => message.method === 'thread/start')).toHaveLength(1);
    expect(outbound.filter((message) => message.method === 'thread/resume')).toHaveLength(0);
    expect(outbound.filter((message) => message.method === 'turn/start')).toHaveLength(1);

    await orchestrator.shutdown();
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('keeps an empty thread unmaterialized when run startup persistence fails before provider input', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-first-turn-pre-submit-failure-')
    );
    const executable = await writeFakeCodexExecutable(dir);
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter);
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const updateRun = store.updateRun.bind(store);
    let rejectedStartingPersistence = false;
    vi.spyOn(store, 'updateRun').mockImplementation(async (runId, patch) => {
      if (!rejectedStartingPersistence && patch.status === 'STARTING') {
        rejectedStartingPersistence = true;
        throw new Error('injected pre-submit run persistence failure');
      }
      return updateRun(runId, patch);
    });

    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: task.agentSettings
      })
    ).rejects.toThrow('injected pre-submit run persistence failure');

    let snapshot = await store.snapshot();
    const failedRun = snapshot.runs.find((candidate) => candidate.taskId === task.id)!;
    expect(failedRun.status).toBe('FAILED');
    expect(
      snapshot.agentSessions.find((session) => session.id === failedRun.sessionId)
    ).toMatchObject({ materialized: false });
    await expect(
      adapter.attachSession({
        localSessionId: failedRun.sessionId,
        providerSessionId: snapshot.agentSessions.find(
          (session) => session.id === failedRun.sessionId
        )?.providerSessionId
      })
    ).rejects.toThrow('has no resumable rollout');
    await expect(
      adapter.readSession({ localSessionId: failedRun.sessionId })
    ).resolves.toMatchObject({
      session: { materialized: false },
      runs: [expect.objectContaining({ id: failedRun.id, status: 'FAILED' })]
    });
    const server = snapshot.agentServers.find(
      (candidate) => candidate.runtimeId === 'codex' && candidate.status === 'READY'
    )!;
    let outbound = readOutboundMessages(
      await fs.readFile(server.protocolJournalPath, 'utf8')
    );
    expect(outbound.filter((message) => message.method === 'thread/start')).toHaveLength(1);
    expect(outbound.filter((message) => message.method === 'thread/read')).toHaveLength(0);
    expect(outbound.filter((message) => message.method === 'thread/resume')).toHaveLength(0);
    expect(outbound.filter((message) => message.method === 'turn/start')).toHaveLength(0);

    const retry = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'RETRY',
      prompt: 'Retry after the local pre-submit persistence failure.',
      settings: task.agentSettings,
      retryOfRunId: failedRun.id
    });
    await waitForRunStatus(store, retry.id, 'COMPLETED');
    snapshot = await store.snapshot();
    expect(
      snapshot.agentSessions.find((session) => session.id === retry.sessionId)
    ).toMatchObject({ materialized: true });
    outbound = readOutboundMessages(
      await fs.readFile(server.protocolJournalPath, 'utf8')
    );
    expect(outbound.filter((message) => message.method === 'thread/start')).toHaveLength(1);
    expect(outbound.filter((message) => message.method === 'thread/resume')).toHaveLength(0);
    expect(outbound.filter((message) => message.method === 'turn/start')).toHaveLength(1);

    await orchestrator.shutdown();
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('reuses an attested empty thread after a definitive first-turn rejection', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-first-turn-definite-rejection-')
    );
    const executable = await writeFakeCodexExecutable(
      dir,
      'turn-start-rejected-once'
    );
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter);
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);

    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: task.agentSettings
      })
    ).rejects.toThrow('injected definitive turn/start rejection');

    let snapshot = await store.snapshot();
    const failedRun = snapshot.runs.find((candidate) => candidate.taskId === task.id)!;
    expect(failedRun.status).toBe('FAILED');
    expect(failedRun.providerTurnId).toBeUndefined();
    expect(
      snapshot.agentSessions.find((session) => session.id === failedRun.sessionId)
    ).toMatchObject({ materialized: false, providerSessionId: 'thread-1' });
    await expect(
      adapter.readSession({ localSessionId: failedRun.sessionId })
    ).resolves.toMatchObject({ session: { materialized: false } });

    const retry = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'RETRY',
      prompt: 'Retry after the provider definitively rejected the first request.',
      settings: task.agentSettings,
      retryOfRunId: failedRun.id
    });
    await waitForRunStatus(store, retry.id, 'COMPLETED');

    snapshot = await store.snapshot();
    expect(
      snapshot.agentSessions.find((session) => session.id === retry.sessionId)
    ).toMatchObject({ materialized: true, providerSessionId: 'thread-1' });
    const journal = await fs.readFile(
      snapshot.agentServers.find((server) => server.status === 'READY')!
        .protocolJournalPath,
      'utf8'
    );
    const outbound = readOutboundMessages(journal);
    expect(outbound.filter((message) => message.method === 'thread/start')).toHaveLength(1);
    expect(outbound.filter((message) => message.method === 'thread/read')).toHaveLength(0);
    expect(outbound.filter((message) => message.method === 'thread/resume')).toHaveLength(0);
    expect(outbound.filter((message) => message.method === 'turn/start')).toHaveLength(2);

    await orchestrator.shutdown();
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('keeps the no-resend fence when turn evidence precedes a definitive error response', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-first-turn-error-with-evidence-')
    );
    const executable = await writeFakeCodexExecutable(
      dir,
      'turn-start-rejected-with-evidence'
    );
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter);
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);

    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: task.agentSettings
      })
    ).rejects.toBeInstanceOf(AgentMutationAmbiguousError);

    const snapshot = await store.snapshot();
    const recoveryRun = snapshot.runs.find(
      (candidate) => candidate.taskId === task.id
    )!;
    expect(recoveryRun).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      providerTurnId: 'turn-error-evidence'
    });
    expect(
      snapshot.agentSessions.find((session) => session.id === recoveryRun.sessionId)
    ).toMatchObject({ materialized: true });
    const journal = await fs.readFile(
      snapshot.agentServers[0]!.protocolJournalPath,
      'utf8'
    );
    const outbound = readOutboundMessages(journal);
    expect(outbound.filter((message) => message.method === 'thread/start')).toHaveLength(1);
    expect(outbound.filter((message) => message.method === 'thread/resume')).toHaveLength(0);
    expect(outbound.filter((message) => message.method === 'turn/start')).toHaveLength(1);

    await orchestrator.shutdown();
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('keeps the no-resend fence when first-turn evidence fails to materialize', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-first-turn-evidence-store-failure-')
    );
    const executable = await writeFakeCodexExecutable(
      dir,
      'turn-start-rejected-with-evidence'
    );
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter);
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const updateRun = store.updateRun.bind(store);
    let rejectedTurnEvidence = false;
    vi.spyOn(store, 'updateRun').mockImplementation(async (runId, patch) => {
      if (
        !rejectedTurnEvidence &&
        patch.providerTurnId === 'turn-error-evidence' &&
        patch.status === 'RUNNING'
      ) {
        rejectedTurnEvidence = true;
        throw new Error('injected turn evidence persistence failure');
      }
      return updateRun(runId, patch);
    });

    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: task.agentSettings
      })
    ).rejects.toBeInstanceOf(AgentMutationAmbiguousError);

    const snapshot = await store.snapshot();
    const recoveryRun = snapshot.runs.find(
      (candidate) => candidate.taskId === task.id
    )!;
    expect(rejectedTurnEvidence).toBe(true);
    expect(recoveryRun.status).toBe('RECOVERY_REQUIRED');
    expect(recoveryRun.providerTurnId).toBe('turn-error-evidence');
    expect(
      snapshot.agentSessions.find((session) => session.id === recoveryRun.sessionId)
    ).toMatchObject({ materialized: true });

    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'RETRY',
        prompt: 'Do not resend provider input while first-turn evidence is uncertain.',
        settings: task.agentSettings,
        retryOfRunId: recoveryRun.id
      })
    ).rejects.toThrow(/active run|unresolved recovery/u);

    const journal = await fs.readFile(
      snapshot.agentServers[0]!.protocolJournalPath,
      'utf8'
    );
    const outbound = readOutboundMessages(journal);
    expect(outbound.filter((message) => message.method === 'thread/start')).toHaveLength(1);
    expect(outbound.filter((message) => message.method === 'thread/resume')).toHaveLength(1);
    expect(outbound.filter((message) => message.method === 'turn/start')).toHaveLength(1);

    await orchestrator.shutdown();
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('retains the no-resend fence and binds a late turn/started after an ambiguous first turn', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-first-turn-late-evidence-')
    );
    const executable = await writeFakeCodexExecutable(
      dir,
      'turn-start-ambiguous-late'
    );
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter);
    await adapter.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const client = (
      adapter as unknown as { boundClient?: CodexRpcClient }
    ).boundClient!;

    const ambiguousError = await orchestrator
      .startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: task.agentSettings
      })
      .then(
        () => undefined,
        (error: unknown) => error
      );
    expect(ambiguousError).toBeInstanceOf(AgentMutationAmbiguousError);

    let snapshot = await store.snapshot();
    const recoveryRun = snapshot.runs.find((candidate) => candidate.taskId === task.id)!;
    expect(recoveryRun.status).toBe('RECOVERY_REQUIRED');
    expect(recoveryRun.providerTurnId).toBeUndefined();
    expect(
      snapshot.agentSessions.find((session) => session.id === recoveryRun.sessionId)
    ).toMatchObject({ materialized: true });

    const raw = await store.appendProtocolMessage(
      client.serverInstanceId,
      'INBOUND',
      JSON.stringify({
        method: 'turn/started',
        params: { threadId: 'thread-1', turnId: 'turn-late' }
      })
    );
    client.events.emit(
      'notification',
      {
        method: 'turn/started',
        params: {
          threadId: 'thread-1',
          turn: {
            id: 'turn-late',
            items: [],
            itemsView: 'full',
            status: 'inProgress',
            error: null,
            startedAt: 1,
            completedAt: null,
            durationMs: null
          }
        }
      },
      raw
    );
    await (
      adapter as unknown as { inboundQueue: Promise<void> }
    ).inboundQueue;

    expect(await store.getRun(recoveryRun.id)).toMatchObject({
      status: 'RUNNING',
      recoveryState: 'NONE',
      providerTurnId: 'turn-late',
      serverInstanceId: client.serverInstanceId
    });
    snapshot = await store.snapshot();
    const journal = await fs.readFile(
      snapshot.agentServers.find(
        (server) => server.id === client.serverInstanceId
      )!.protocolJournalPath,
      'utf8'
    );
    const outbound = readOutboundMessages(journal);
    expect(outbound.filter((message) => message.method === 'thread/start')).toHaveLength(1);
    expect(outbound.filter((message) => message.method === 'thread/read')).toHaveLength(0);
    expect(outbound.filter((message) => message.method === 'thread/resume')).toHaveLength(0);
    expect(outbound.filter((message) => message.method === 'turn/start')).toHaveLength(1);

    await orchestrator.shutdown();
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('drains permission-profile drift before submitting the first turn', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-first-turn-profile-drift-')
    );
    const executable = await writeFakeCodexExecutable(dir);
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter);
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const updateAgentSession = store.updateAgentSession.bind(store);
    let injectedDrift = false;
    vi.spyOn(store, 'updateAgentSession').mockImplementation(
      async (sessionId, patch) => {
        const stored = await updateAgentSession(sessionId, patch);
        if (!injectedDrift && patch.materialized === true) {
          injectedDrift = true;
          const client = (
            adapter as unknown as { boundClient?: CodexRpcClient }
          ).boundClient!;
          const raw = await store.appendProtocolMessage(
            client.serverInstanceId,
            'INBOUND',
            JSON.stringify({
              method: 'thread/settings/updated',
              params: {
                threadId: 'thread-1',
                activePermissionProfile: ':workspace'
              }
            })
          );
          client.events.emit(
            'notification',
            {
              method: 'thread/settings/updated',
              params: {
                threadId: 'thread-1',
                threadSettings: {
                  cwd: worktree.worktreePath,
                  approvalPolicy: 'on-request',
                  approvalsReviewer: 'user',
                  sandboxPolicy: {
                    type: 'workspaceWrite',
                    writableRoots: [worktree.worktreePath],
                    networkAccess: false,
                    excludeTmpdirEnvVar: true,
                    excludeSlashTmp: true
                  },
                  activePermissionProfile: { id: ':workspace', extends: null },
                  model: 'fake-model',
                  modelProvider: 'openai',
                  serviceTier: null,
                  effort: 'low',
                  summary: null,
                  collaborationMode: {
                    mode: 'default',
                    settings: {
                      model: 'fake-model',
                      reasoning_effort: 'low',
                      developer_instructions: null
                    }
                  },
                  personality: null
                }
              }
            },
            raw
          );
        }
        return stored;
      }
    );

    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: task.agentSettings
      })
    ).rejects.toThrow('changed or removed the Task Monki permission profile');

    const snapshot = await store.snapshot();
    const failedRun = snapshot.runs.find((candidate) => candidate.taskId === task.id)!;
    expect(failedRun.status).toBe('FAILED');
    expect(
      snapshot.agentSessions.find((session) => session.id === failedRun.sessionId)
    ).toMatchObject({ materialized: false });
    const journal = await fs.readFile(
      snapshot.agentServers[0]!.protocolJournalPath,
      'utf8'
    );
    const outbound = readOutboundMessages(journal);
    expect(outbound.filter((message) => message.method === 'thread/start')).toHaveLength(1);
    expect(outbound.filter((message) => message.method === 'turn/start')).toHaveLength(0);
    expect(snapshot.agentServers[0]).toMatchObject({ status: 'EXITED' });

    await orchestrator.shutdown();
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('retains run attachments when persistence fails after Codex acknowledges turn/start', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-post-ack-persistence-')
    );
    const executable = await writeFakeCodexExecutable(dir, 'ack-only');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter, {
    });
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir, {
      withTextAttachment: true
    });
    const updateRun = store.updateRun.bind(store);
    let rejectedAcknowledgement = false;
    vi.spyOn(store, 'updateRun').mockImplementation(async (runId, patch) => {
      if (
        !rejectedAcknowledgement &&
        patch.status === 'RUNNING' &&
        patch.attachmentSubmissions !== undefined
      ) {
        rejectedAcknowledgement = true;
        throw new Error('injected persistence failure');
      }
      return updateRun(runId, patch);
    });

    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: task.agentSettings
      })
    ).rejects.toBeInstanceOf(AgentMutationAmbiguousError);

    const snapshot = await store.snapshot();
    const run = snapshot.runs.find((candidate) => candidate.taskId === task.id);
    expect(run).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      providerTurnId: 'turn-1'
    });
    expect(
      snapshot.agentSessions.find((session) => session.id === run?.sessionId)
    ).toMatchObject({ materialized: true });
    const server = snapshot.agentServers[0]!;
    const journal = await fs.readFile(server.protocolJournalPath, 'utf8');
    const firstOutbound = readOutboundMessages(journal);
    const turnStart = firstOutbound.find(
      (message) => message.method === 'turn/start'
    );
    expect(firstOutbound.filter((message) => message.method === 'thread/start')).toHaveLength(1);
    expect(firstOutbound.filter((message) => message.method === 'thread/resume')).toHaveLength(0);
    expect(firstOutbound.filter((message) => message.method === 'turn/start')).toHaveLength(1);
    const manifest = (
      turnStart?.params as { input?: Array<{ type?: string; text?: string }> } | undefined
    )?.input?.find((item) => item.type === 'text')?.text;
    const deliveryPath = readAttachmentManifestPaths(manifest)[0];
    expect(deliveryPath).toContain(`${path.sep}attachments${path.sep}tasks${path.sep}`);
    await expect(fs.access(deliveryPath!)).resolves.toBeUndefined();

    await orchestrator.shutdown();

    const replacementAdapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const replacementOrchestrator = new AgentOrchestrator(
      store,
      events,
      replacementAdapter
    );
    await replacementOrchestrator.initialize();
    await expect(store.getRun(run!.id)).resolves.toMatchObject({
      status: 'COMPLETED',
      providerTurnId: 'turn-1',
      providerTerminalSource: 'RECOVERY_RESUME_RESPONSE'
    });
    const replacementSnapshot = await store.snapshot();
    const replacementServer = replacementSnapshot.agentServers.find(
      (candidate) => candidate.runtimeId === 'codex' && candidate.status === 'READY'
    );
    expect(replacementServer).toBeDefined();
    const replacementJournal = await fs.readFile(
      replacementServer!.protocolJournalPath,
      'utf8'
    );
    const replacementOutbound = readOutboundMessages(replacementJournal);
    expect(
      replacementOutbound.filter((message) => message.method === 'thread/start')
    ).toHaveLength(0);
    expect(
      replacementOutbound.filter((message) => message.method === 'thread/resume')
    ).toHaveLength(1);
    expect(
      replacementOutbound.filter((message) => message.method === 'turn/start')
    ).toHaveLength(0);
    await replacementOrchestrator.shutdown();
    await expect(fs.access(deliveryPath!)).resolves.toBeUndefined();
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('records recovery before a provider-acknowledged thread/start can be retried', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-thread-start-post-ack-')
    );
    const executable = await writeFakeCodexExecutable(dir, 'ack-only');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter);
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const updateSession = store.updateAgentSession.bind(store);
    let rejectedAcknowledgement = false;
    vi.spyOn(store, 'updateAgentSession').mockImplementation(async (sessionId, patch) => {
      if (!rejectedAcknowledgement && patch.providerSessionId === 'thread-1') {
        rejectedAcknowledgement = true;
        throw new Error('injected thread ownership persistence failure');
      }
      return updateSession(sessionId, patch);
    });

    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: task.agentSettings
      })
    ).rejects.toMatchObject({ operation: 'thread/start' });

    const snapshot = await store.snapshot();
    const run = snapshot.runs.find((candidate) => candidate.taskId === task.id);
    expect(run).toMatchObject({ status: 'RECOVERY_REQUIRED' });
    const journal = await fs.readFile(
      snapshot.agentServers[0]!.protocolJournalPath,
      'utf8'
    );
    expect(
      readOutboundMessages(journal).filter((message) => message.method === 'thread/start')
    ).toHaveLength(1);
    expect(readOutboundMethods(journal)).not.toContain('turn/start');
    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'FOLLOW_UP',
        prompt: 'Do not duplicate the provider session.',
        settings: task.agentSettings
      })
    ).rejects.toThrow('unresolved recovery run');

    await orchestrator.shutdown();
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('fences App Server when thread/start returns an unattested permission profile', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-thread-start-profile-mismatch-')
    );
    const executable = await writeFakeCodexExecutable(dir, 'profile-mismatch-create');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter);
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);

    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: task.agentSettings
      })
    ).rejects.toMatchObject({ operation: 'thread/start' });

    const snapshot = await store.snapshot();
    expect(snapshot.runs.find((candidate) => candidate.taskId === task.id)).toMatchObject({
      status: 'RECOVERY_REQUIRED'
    });
    expect(snapshot.agentServers.at(-1)).toMatchObject({ status: 'EXITED' });
    await expect(adapter.preflight()).resolves.toMatchObject({
      readiness: {
        status: 'FAILED',
        diagnostics: [
          expect.objectContaining({ code: 'SECURITY_BOUNDARY_FAILED' })
        ]
      }
    });
    await expect(adapter.listModels()).rejects.toThrow('unattested permission profile');
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('submits one typed approval response and waits for server resolution', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-approval-'));
    const executable = await writeFakeCodexExecutable(dir, 'approval');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter, {
    });
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const terminal = waitForAppEvent(events, 'run.terminal');

    const run = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });
    const interaction = await waitForInteraction(store, 'PENDING');
    expect(interaction.providerRequestId).toBe(41);
    expect(interaction.allowedActions).toContain('ACCEPT');
    expect((await store.getRun(run.id))?.status).toBe('AWAITING_APPROVAL');
    expect((await store.getAgentSession(interaction.sessionId))?.status).toBe(
      'AWAITING_APPROVAL'
    );

    await expect(
      orchestrator.respondToInteraction({
        taskId: task.id,
        runId: 'another-run',
        interactionRequestId: interaction.id,
        decision: {
          interactionType: 'COMMAND_APPROVAL',
          action: 'ACCEPT'
        }
      })
    ).rejects.toThrow('ownership');

    await orchestrator.respondToInteraction({
      taskId: task.id,
      runId: run.id,
      interactionRequestId: interaction.id,
      decision: {
        interactionType: 'COMMAND_APPROVAL',
        action: 'ACCEPT'
      }
    });
    await terminal;

    const resolved = await store.getInteractionRequest(interaction.id);
    expect(resolved?.status).toBe('RESOLVED');
    expect(resolved?.responseRawMessage?.direction).toBe('OUTBOUND');
    expect((await store.getRun(run.id))?.status).toBe('COMPLETED');
    await expect(
      orchestrator.respondToInteraction({
        taskId: task.id,
        runId: run.id,
        interactionRequestId: interaction.id,
        decision: {
          interactionType: 'COMMAND_APPROVAL',
          action: 'ACCEPT'
        }
      })
    ).rejects.toThrow('expected PENDING');
    const server = (await store.snapshot()).agentServers[0];
    const journal = await fs.readFile(server.protocolJournalPath, 'utf8');
    const response = journal
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { raw: string })
      .map((entry) => JSON.parse(entry.raw) as { id?: string | number; result?: unknown })
      .find((message) => message.id === 41 && message.result);
    expect(response?.id).toBe(41);

    await orchestrator.shutdown();
  });

  it('does not offer a retry after approval-response delivery becomes ambiguous', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-approval-ambiguous-'));
    const executable = await writeFakeCodexExecutable(dir, 'approval');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter);
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const run = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });
    const interaction = await waitForInteraction(store, 'PENDING');
    const client = (
      adapter as unknown as { boundClient?: CodexRpcClient }
    ).boundClient!;
    vi.spyOn(client, 'respond').mockRejectedValue(
      new CodexAmbiguousMutationError(
        'server-request/response',
        'injected ambiguous approval delivery'
      )
    );

    await expect(
      orchestrator.respondToInteraction({
        taskId: task.id,
        runId: run.id,
        interactionRequestId: interaction.id,
        decision: {
          interactionType: 'COMMAND_APPROVAL',
          action: 'ACCEPT'
        }
      })
    ).rejects.toBeInstanceOf(AgentMutationAmbiguousError);

    expect(await store.getInteractionRequest(interaction.id)).toMatchObject({
      status: 'STALE',
      resolution: {
        operation: 'server-request/response',
        automaticResubmission: false
      }
    });
    await orchestrator.shutdown();
  });

  it('settles active ownership when shutdown reports a failure after process exit', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-approval-shutdown-'));
    const executable = await writeFakeCodexExecutable(dir, 'approval');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter, {});
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);

    const run = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });
    const interaction = await waitForInteraction(store, 'PENDING');
    const supervisor = (adapter as unknown as {
      supervisor: { shutdown(): Promise<void> };
    }).supervisor;
    const shutdown = supervisor.shutdown.bind(supervisor);
    vi.spyOn(supervisor, 'shutdown').mockImplementation(async () => {
      await shutdown();
      throw new Error('simulated post-exit shutdown failure');
    });

    await expect(adapter.shutdown()).rejects.toThrow('simulated post-exit shutdown failure');

    expect(await store.getRun(run.id)).toMatchObject({ status: 'RECOVERY_REQUIRED' });
    expect(await store.getInteractionRequest(interaction.id)).toMatchObject({
      status: 'ABORTED_SERVER_LOST',
      resolution: { reason: 'Codex App Server exited.' }
    });
    expect(await store.getAgentSession(interaction.sessionId)).toMatchObject({
      status: 'NOT_LOADED'
    });
    expect((await store.snapshot()).agentServers).toEqual([
      expect.objectContaining({ status: 'EXITED' })
    ]);
    await adapter.initialize();
    await expect(adapter.preflight()).resolves.toMatchObject({
      readiness: { status: 'READY', canStart: true }
    });
    await adapter.shutdown();
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('rebinds a recovered running turn before accepting approval on a replacement server', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-recovered-approval-')
    );
    const executable = await writeFakeCodexExecutable(dir, 'recovery-approval');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const priorServer = await store.createAgentServer({
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable,
      argv: ['app-server', '--stdio']
    });
    await store.updateAgentServer(priorServer.id, { status: 'RUNNING', pid: 41 });
    let session = await store.createAgentSession({
      task,
      iteration,
      worktree,
      runtimeId: 'codex',
      requestedSettings: task.agentSettings
    });
    session = await store.updateAgentSession(session.id, {
      providerSessionId: 'thread-1',
      providerSessionTreeId: 'session-tree-1',
      status: 'NOT_LOADED',
      materialized: true
    });
    const run = await store.createRun({
      task,
      session,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      serverInstanceId: priorServer.id,
      requestedSettings: task.agentSettings
    });
    await store.updateRun(run.id, {
      providerTurnId: 'turn-1',
      status: 'RUNNING'
    });
    const priorInteractionRaw = await store.appendProtocolMessage(
      priorServer.id,
      'INBOUND',
      '{"method":"item/commandExecution/requestApproval","id":41}'
    );
    const priorInteraction = await store.createInteractionRequest({
      runtimeId: 'codex',
      serverInstanceId: priorServer.id,
      providerRequestId: 41,
      taskId: task.id,
      iterationId: iteration.id,
      runId: run.id,
      sessionId: session.id,
      providerTurnId: 'turn-1',
      type: 'COMMAND_APPROVAL',
      request: { command: 'npm test', startedAtMs: Date.now() },
      allowedActions: ['ACCEPT', 'DECLINE', 'CANCEL'],
      policyWarnings: [],
      requestRawMessage: priorInteractionRaw
    });
    await store.updateAgentServer(priorServer.id, {
      status: 'EXITED',
      disconnectedAt: new Date().toISOString(),
      exitedAt: new Date().toISOString(),
      exitReason: 'Injected prior App Server crash.'
    });

    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter);
    await orchestrator.initialize();

    const interaction = await waitForInteraction(store, 'PENDING');
    const recoveredRun = await store.getRun(run.id);
    expect(await store.getInteractionRequest(priorInteraction.id)).toMatchObject({
      status: 'ABORTED_SERVER_LOST'
    });
    expect(interaction.runId).toBe(run.id);
    expect(interaction.serverInstanceId).not.toBe(priorServer.id);
    expect(recoveredRun).toMatchObject({
      serverInstanceId: interaction.serverInstanceId,
      providerTurnId: 'turn-1',
      status: 'AWAITING_APPROVAL'
    });
    expect((await store.getAgentSession(interaction.sessionId))?.status).toBe(
      'AWAITING_APPROVAL'
    );

    await orchestrator.respondToInteraction({
      taskId: task.id,
      runId: run.id,
      interactionRequestId: interaction.id,
      decision: {
        interactionType: 'COMMAND_APPROVAL',
        action: 'ACCEPT'
      }
    });
    const completed = await waitForRunStatus(store, run.id, 'COMPLETED');
    expect(completed.serverInstanceId).toBe(interaction.serverInstanceId);
    expect((await store.getInteractionRequest(interaction.id))?.status).toBe('RESOLVED');

    await orchestrator.shutdown();
  });

  it('ignores late notifications and requests from a replaced App Server generation', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-stale-codex-generation-')
    );
    const executable = await writeFakeCodexExecutable(dir, 'stale-generation');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [0]
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter);

    try {
      await orchestrator.initialize();
      const { task, iteration, worktree } = await createTaskContext(store, dir);
      const run = await orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: task.agentSettings
      });
      const oldClient = (
        adapter as unknown as { boundClient?: CodexRpcClient }
      ).boundClient!;
      const oldServerId = oldClient.serverInstanceId;

      const recovered = await waitForSnapshot(
        store,
        (snapshot) => {
          const current = snapshot.runs.find((candidate) => candidate.id === run.id);
          return (
            current?.status === 'RECOVERY_REQUIRED' &&
            typeof current.serverInstanceId === 'string' &&
            current.serverInstanceId !== oldServerId
          );
        },
        'replacement App Server to own the recovered turn'
      );
      const recoveredRun = recovered.runs.find((candidate) => candidate.id === run.id)!;
      const replacementClient = (
        adapter as unknown as { boundClient?: CodexRpcClient }
      ).boundClient!;
      expect(replacementClient).not.toBe(oldClient);
      expect(replacementClient.serverInstanceId).toBe(recoveredRun.serverInstanceId);

      const staleTurnRaw = await store.appendProtocolMessage(
        oldServerId,
        'INBOUND',
        JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-1' } })
      );
      const staleThreadRaw = await store.appendProtocolMessage(
        oldServerId,
        'INBOUND',
        JSON.stringify({ method: 'thread/closed', params: { threadId: 'thread-1' } })
      );
      const staleRequestRaw = await store.appendProtocolMessage(
        oldServerId,
        'INBOUND',
        JSON.stringify({
          method: 'item/commandExecution/requestApproval',
          id: 901,
          params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'stale-command' }
        })
      );
      const staleResponse = vi
        .spyOn(oldClient, 'respondError')
        .mockResolvedValue(undefined);

      oldClient.events.emit(
        'notification',
        {
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: {
              id: 'turn-1',
              items: [],
              itemsView: 'full',
              status: 'completed',
              error: null,
              startedAt: 1,
              completedAt: 2,
              durationMs: 1
            }
          }
        },
        staleTurnRaw
      );
      oldClient.events.emit(
        'notification',
        { method: 'thread/closed', params: { threadId: 'thread-1' } },
        staleThreadRaw
      );
      oldClient.events.emit(
        'serverRequest',
        {
          method: 'item/commandExecution/requestApproval',
          id: 901,
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'stale-command',
            startedAtMs: Date.now(),
            command: 'npm test',
            cwd: worktree.worktreePath,
            commandActions: []
          }
        },
        staleRequestRaw
      );
      await (
        adapter as unknown as { inboundQueue: Promise<void> }
      ).inboundQueue;

      expect(await store.getRun(run.id)).toMatchObject({
        status: 'RECOVERY_REQUIRED',
        serverInstanceId: replacementClient.serverInstanceId
      });
      expect((await store.getAgentSession(run.sessionId))?.status).not.toBe('NOT_LOADED');
      expect(staleResponse).not.toHaveBeenCalled();
      expect(
        (await store.snapshot()).interactionRequests.some(
          (interaction) => interaction.providerRequestId === 901
        )
      ).toBe(false);
    } finally {
      await orchestrator.shutdown();
    }
  });

  it('drains accepted notifications before settling runtime loss and starting a replacement', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-codex-generation-drain-')
    );
    const executable = await writeFakeCodexExecutable(dir, 'exit');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter);
    const internals = adapter as unknown as {
      supervisor: CodexAppServerSupervisor;
      handleNotification(
        client: CodexRpcClient,
        notification: { method: string },
        raw: unknown
      ): Promise<void>;
    };
    let releaseMaterialization: () => void = () => {};

    try {
      await orchestrator.initialize();
      const { task, iteration, worktree } = await createTaskContext(store, dir);
      const materializationRelease = new Promise<void>((resolve) => {
        releaseMaterialization = resolve;
      });
      let markNotificationAccepted!: () => void;
      const notificationAccepted = new Promise<void>((resolve) => {
        markNotificationAccepted = resolve;
      });
      const originalHandleNotification = internals.handleNotification.bind(adapter);
      let blocked = false;
      vi.spyOn(internals, 'handleNotification').mockImplementation(
        async (client, notification, raw) => {
          if (!blocked && notification.method === 'item/started') {
            blocked = true;
            markNotificationAccepted();
            await materializationRelease;
          }
          await originalHandleNotification(client, notification, raw);
        }
      );

      const durableOrder: string[] = [];
      const upsertAgentItem = store.upsertAgentItem.bind(store);
      vi.spyOn(store, 'upsertAgentItem').mockImplementation(async (item) => {
        const stored = await upsertAgentItem(item);
        if (stored.providerItemId === 'command-1') durableOrder.push('item');
        return stored;
      });
      const appendRunEventIfStatus = store.appendRunEventIfStatus.bind(store);
      vi.spyOn(store, 'appendRunEventIfStatus').mockImplementation(
        async (event, statuses) => {
          const appended = await appendRunEventIfStatus(event, statuses);
          if (appended && event.type === 'AGENT_RUNTIME_LOST') {
            durableOrder.push('runtime-loss');
          }
          return appended;
        }
      );
      const createAgentServer = store.createAgentServer.bind(store);
      vi.spyOn(store, 'createAgentServer').mockImplementation(async (input) => {
        const server = await createAgentServer(input);
        durableOrder.push('replacement');
        return server;
      });

      const run = await orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: task.agentSettings
      });
      await notificationAccepted;
      const oldServerId = (await store.getRun(run.id))!.serverInstanceId!;
      await waitForSnapshot(
        store,
        (snapshot) =>
          snapshot.agentServers.some(
            (server) => server.id === oldServerId && server.status === 'FAILED'
          ),
        'exited App Server generation'
      );
      await new Promise<void>((resolve) => setImmediate(resolve));

      const startReplacement = vi.spyOn(internals.supervisor, 'start');
      const replacement = adapter.preflight();

      expect(startReplacement).not.toHaveBeenCalled();
      expect(durableOrder).toEqual([]);
      expect((await store.snapshot()).agentServers).toHaveLength(1);

      releaseMaterialization();
      await replacement;

      expect(startReplacement).toHaveBeenCalled();
      expect(durableOrder).toEqual(['item', 'runtime-loss', 'replacement']);
      expect(await waitForAgentItem(store, run.id, 'command-1')).toBeDefined();
      expect(await store.getRun(run.id)).toMatchObject({
        status: 'RECOVERY_REQUIRED',
        serverInstanceId: oldServerId
      });
      expect((await store.snapshot()).agentServers).toHaveLength(2);
    } finally {
      releaseMaterialization();
      await orchestrator.shutdown();
    }
  });

  it('redacts and declines redundant attachment path permission requests', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-permission-ref-'));
    const executable = await writeFakeCodexExecutable(dir, 'permission');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter, {
    });
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir, {
      withTextAttachment: true
    });
    const terminal = waitForAppEvent(events, 'run.terminal');
    const run = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });
    const [delivery] = await store.verifyRunAttachments(run.id, task.id);
    const interaction = await waitForInteraction(store, 'PENDING');
    const permissionRequest = interaction.request as {
      permissions: { fileSystem?: { read?: string[] } };
    };

    expect(interaction.type).toBe('PERMISSION_APPROVAL');
    expect(JSON.stringify(interaction)).not.toContain(delivery!.absolutePath);
    expect(permissionRequest.permissions.fileSystem?.read?.[0]).toMatch(
      /^task-monki-external-path:/u
    );
    expect(interaction.allowedActions).toEqual(['DECLINE']);

    await orchestrator.respondToInteraction({
      taskId: task.id,
      runId: run.id,
      interactionRequestId: interaction.id,
      decision: {
        interactionType: 'PERMISSION_APPROVAL',
        action: 'DECLINE'
      }
    });
    await terminal;

    const resolved = await store.getInteractionRequest(interaction.id);
    expect(JSON.stringify(resolved)).not.toContain(delivery!.absolutePath);
    const server = (await store.snapshot()).agentServers[0];
    const journal = await fs.readFile(server.protocolJournalPath, 'utf8');
    const response = journal
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { raw: string })
      .map((entry) => JSON.parse(entry.raw) as { id?: string | number; result?: unknown })
      .find((message) => message.id === 61 && message.result);
    expect(JSON.stringify(response?.result)).not.toContain(delivery!.absolutePath);

    await orchestrator.shutdown();
  });

  it('aborts pending approvals when the owning App Server exits', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-approval-loss-'));
    const executable = await writeFakeCodexExecutable(dir, 'exit');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter, {
    });
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);

    const run = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });
    const aborted = await waitForInteraction(store, 'ABORTED_SERVER_LOST');

    expect(aborted.resolution).toEqual({ reason: 'Codex App Server exited.' });
    expect((await store.getRun(run.id))?.status).toBe('RECOVERY_REQUIRED');
    await expect(
      orchestrator.respondToInteraction({
        taskId: task.id,
        runId: run.id,
        interactionRequestId: aborted.id,
        decision: {
          interactionType: 'COMMAND_APPROVAL',
          action: 'DECLINE'
        }
      })
    ).rejects.toThrow('expected PENDING');

    await orchestrator.shutdown();
  });

  it('marks a request stale when App Server clears it before a response', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-approval-stale-'));
    const executable = await writeFakeCodexExecutable(dir, 'clear');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter, {
    });
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const run = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });

    const stale = await waitForInteraction(store, 'STALE');
    expect(stale.resolution).toMatchObject({ clearedWithoutResponse: true });
    await expect(
      orchestrator.respondToInteraction({
        taskId: task.id,
        runId: run.id,
        interactionRequestId: stale.id,
        decision: {
          interactionType: 'COMMAND_APPROVAL',
          action: 'DECLINE'
        }
      })
    ).rejects.toThrow('expected PENDING');
    await orchestrator.shutdown();
  });

  it('discovers child sessions and correlates child-origin approvals', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-subagent-'));
    const executable = await writeFakeCodexExecutable(dir, 'subagent');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter, {
    });
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const parentRun = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });

    const interaction = await waitForInteraction(store, 'PENDING');
    const childSession = await store.getAgentSession(interaction.sessionId);
    expect(childSession).toMatchObject({
      role: 'SUBAGENT',
      providerSessionId: 'thread-child',
      providerParentSessionId: 'thread-1',
      delegatedPrompt: 'Inspect the repository tests.',
      providerNickname: 'Scout',
      providerRole: 'explorer',
      relationshipState: 'RESOLVED',
      status: 'AWAITING_APPROVAL'
    });
    expect(interaction.providerTurnId).toBe('turn-child');

    await orchestrator.respondToInteraction({
      taskId: task.id,
      runId: interaction.runId,
      interactionRequestId: interaction.id,
      decision: {
        interactionType: 'COMMAND_APPROVAL',
        action: 'ACCEPT'
      }
    });
    await waitForRunStatus(store, parentRun.id, 'COMPLETED');

    const snapshot = await store.snapshot();
    const childRun = snapshot.runs.find(
      (run) => run.providerTurnId === 'turn-child'
    );
    const storedChild = snapshot.agentSessions.find(
      (session) => session.providerSessionId === 'thread-child'
    );
    expect(childRun).toMatchObject({
      mode: 'SUBAGENT',
      origin: 'PROVIDER_SUBAGENT',
      parentRunId: parentRun.id,
      status: 'COMPLETED'
    });
    expect(storedChild?.subagentStatus).toBe('COMPLETED');
    expect(
      snapshot.agentSessions.some(
        (session) => session.providerSessionId === 'thread-review'
      )
    ).toBe(false);
    expect(
      snapshot.agentItems
        .filter((item) => item.runId === childRun?.id)
        .map((item) => item.type)
    ).toEqual(expect.arrayContaining(['COMMAND_EXECUTION', 'AGENT_MESSAGE']));
    expect(snapshot.interactionRequests[0]?.sessionId).toBe(storedChild?.id);
    expect(
      snapshot.agentSubagentObservations.map((observation) => observation.source)
    ).toEqual(
      expect.arrayContaining([
        'COLLAB_RECEIVER',
        'THREAD_STARTED_PARENT',
        'COLLAB_STATE'
      ])
    );
    expect(snapshot.tasks[0]?.currentRunId).toBe(parentRun.id);
    expect(snapshot.tasks[0]?.projection.agentRun).toBe('COMPLETED');

    await orchestrator.shutdown();
  });

  it('keeps the review response turn for item correlation when turn started differs', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-review-retarget-')
    );
    const executable = await writeFakeCodexExecutable(
      dir,
      'review-turn-start-mismatch'
    );
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter, {
    });
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const sourceTerminal = waitForAppEvent(events, 'run.terminal');
    const sourceRun = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });
    await sourceTerminal;

    const reviewRun = await orchestrator.startReview({
      task,
      iteration,
      worktree,
      sourceRun,
      target: { type: 'UNCOMMITTED_CHANGES' },
      settings: task.agentSettings
    });
    const item = await waitForAgentItem(store, reviewRun.id, 'review-message');
    expect(item.type).toBe('AGENT_MESSAGE');
    expect((await store.getRun(reviewRun.id))?.providerTurnId).toBe(
      'review-response-turn'
    );

    await orchestrator.interruptRun(reviewRun.id);

    const server = (await store.snapshot()).agentServers[0];
    const journal = await fs.readFile(server.protocolJournalPath, 'utf8');
    const interruptTurnIds = readOutboundMessages(journal)
      .filter((message) => message.method === 'turn/interrupt')
      .map((message) => (message.params as { turnId: string }).turnId);
    expect(interruptTurnIds).toEqual([
      'review-response-turn',
      'review-active-turn'
    ]);
    expect((await store.getRun(reviewRun.id))?.providerTurnId).toBe(
      'review-active-turn'
    );

    await orchestrator.shutdown();
  });

  it('passes review config to the provider fork and starts review inline there', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-review-effort-')
    );
    const executable = await writeFakeCodexExecutable(
      dir,
      'review-interrupt-no-active'
    );
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter, {
    });
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir, {
      withTextAttachment: true
    });
    const canonicalReviewAttachmentPath = (await store.verifyTaskAttachments(task.id))[0]!
      .absolutePath;
    const sourceTerminal = waitForAppEvent(events, 'run.terminal');
    const sourceRun = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });
    await sourceTerminal;

    const reviewSettings = { ...task.agentSettings, reasoningEffort: 'low' };
    const reviewRun = await orchestrator.startReview({
      task,
      iteration,
      worktree,
      sourceRun,
      target: { type: 'UNCOMMITTED_CHANGES' },
      settings: reviewSettings
    });

    const snapshot = await store.snapshot();
    const reviewSession = snapshot.agentSessions.find(
      (session) => session.id === reviewRun.sessionId
    );
    const reviewObservation = snapshot.agentSettingsObservations.find(
      (observation) =>
        observation.sessionId === reviewRun.sessionId &&
        observation.source === 'THREAD_FORK_RESPONSE'
    );
    expect(reviewSession?.requestedSettings.reasoningEffort).toBe('low');
    expect(reviewObservation?.settings.reasoningEffort).toBe('low');
    expect((await store.getRun(reviewRun.id))?.attachmentSubmissions).toEqual([
      expect.objectContaining({
        kind: 'text',
        submittedAs: 'prompt-file-reference',
        providerTurnId: expect.any(String),
        submittedAt: expect.any(String)
      })
    ]);

    const server = snapshot.agentServers[0];
    const journal = await fs.readFile(server.protocolJournalPath, 'utf8');
    const messages = readOutboundMessages(journal);
    const reviewFork = messages.find((message) => message.method === 'thread/fork');
    expect((reviewFork?.params as { cwd?: string } | undefined)?.cwd).toBe(
      worktree.worktreePath
    );
    expect(
      (
        reviewFork?.params as {
          config?: { model_reasoning_effort?: string } | null;
        }
      )?.config?.model_reasoning_effort
    ).toBe('low');
    const reviewInstructions = (
      reviewFork?.params as { developerInstructions?: string } | undefined
    )?.developerInstructions;
    expect(readAttachmentManifestPaths(reviewInstructions)).toContain(
      canonicalReviewAttachmentPath
    );
    const reviewStart = messages.find((message) => message.method === 'review/start');
    expect(
      (reviewStart?.params as { threadId?: string; delivery?: string } | undefined)
        ?.threadId
    ).toBe('thread-review');
    expect(
      (reviewStart?.params as { delivery?: string } | undefined)?.delivery
    ).toBe('inline');

    await orchestrator.interruptRun(reviewRun.id);
    await waitForRunStatus(store, reviewRun.id, 'INTERRUPTED');
    await orchestrator.shutdown();
  });

  it('blocks review/start when a browser-dev review fork reports unsafe settings', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-review-boundary-')
    );
    const executable = await writeFakeCodexExecutable(dir, 'unsafe-review-fork');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
      enforceBrowserDevBoundary: true
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter, {
      allowNetworkAccess: false
    });
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const safeSettings = {
      ...task.agentSettings,
      approvalPolicy: 'never',
      approvalsReviewer: 'user' as const
    };
    const sourceTerminal = waitForAppEvent(events, 'run.terminal');
    const sourceRun = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: safeSettings
    });
    await sourceTerminal;

    await expect(
      orchestrator.startReview({
        task,
        iteration,
        worktree,
        sourceRun: (await store.getRun(sourceRun.id))!,
        target: { type: 'UNCOMMITTED_CHANGES' },
        settings: safeSettings
      })
    ).rejects.toThrow('Review fork observed settings is unsafe');

    const snapshot = await store.snapshot();
    const journal = await fs.readFile(
      snapshot.agentServers[0]!.protocolJournalPath,
      'utf8'
    );
    const methods = readOutboundMethods(journal);
    expect(methods).toContain('thread/fork');
    expect(methods).not.toContain('review/start');
    expect(snapshot.runs.find((run) => run.mode === 'REVIEW')).toMatchObject({
      status: 'FAILED'
    });
    await orchestrator.shutdown();
  });

  it('stops Codex and ignores buffered commands after unsafe live settings are observed', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-live-settings-boundary-')
    );
    const executable = await writeFakeCodexExecutable(dir, 'unsafe-live-settings');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const updateAgentSession = store.updateAgentSession.bind(store);
    const updateAgentServer = store.updateAgentServer.bind(store);
    let releaseUnsafeObservation!: () => void;
    let markUnsafeObservationBlocked!: () => void;
    let releaseTerminalServerPersistence!: () => void;
    let markTerminalServerPersistenceBlocked!: () => void;
    let unsafeObservationReached = false;
    const unsafeObservationRelease = new Promise<void>((resolve) => {
      releaseUnsafeObservation = resolve;
    });
    const unsafeObservationBlocked = new Promise<void>((resolve) => {
      markUnsafeObservationBlocked = resolve;
    });
    const terminalServerPersistenceRelease = new Promise<void>((resolve) => {
      releaseTerminalServerPersistence = resolve;
    });
    const terminalServerPersistenceBlocked = new Promise<void>((resolve) => {
      markTerminalServerPersistenceBlocked = resolve;
    });
    vi.spyOn(store, 'updateAgentSession').mockImplementation(async (sessionId, patch) => {
      if (patch.observedSettings?.sandbox === 'DANGER_FULL_ACCESS') {
        unsafeObservationReached = true;
        markUnsafeObservationBlocked();
        await unsafeObservationRelease;
      }
      return updateAgentSession(sessionId, patch);
    });
    vi.spyOn(store, 'updateAgentServer').mockImplementation(async (serverId, patch) => {
      if (patch.status === 'EXITED' || patch.status === 'FAILED') {
        markTerminalServerPersistenceBlocked();
        await terminalServerPersistenceRelease;
      }
      return updateAgentServer(serverId, patch);
    });
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
      enforceBrowserDevBoundary: true
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter, {
      allowNetworkAccess: false
    });
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const safeSettings = {
      ...task.agentSettings,
      approvalPolicy: 'never',
      approvalsReviewer: 'user' as const
    };
    const run = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: safeSettings
    });

    await terminalServerPersistenceBlocked;
    expect(unsafeObservationReached).toBe(false);
    await expect(adapter.listModels()).rejects.toThrow(
      'Live session observed settings is unsafe'
    );
    releaseTerminalServerPersistence();
    await unsafeObservationBlocked;
    const beforePersistenceRelease = await store.snapshot();
    expect(beforePersistenceRelease.agentServers.at(-1)?.status).toBe('EXITED');
    expect(beforePersistenceRelease.runs.find((candidate) => candidate.id === run.id)).toMatchObject({
      status: 'RUNNING'
    });
    releaseUnsafeObservation();

    const failed = await waitForRunStatus(store, run.id, 'FAILED');
    const snapshot = await store.snapshot();
    expect(failed.terminalReason).toContain('Live session observed settings is unsafe');
    expect(
      snapshot.events.find(
        (event) =>
          event.runId === run.id &&
          event.type === 'AGENT_RUN_FAILED' &&
          JSON.stringify(event.payload).includes('BROWSER_DEV_LIVE_SETTINGS')
      )
    ).toBeTruthy();
    expect(snapshot.agentItems).toEqual([]);
    expect(snapshot.interactionRequests).toEqual([]);
    expect(snapshot.agentServers.at(-1)?.status).toBe('EXITED');
    await expect(adapter.listModels()).rejects.toThrow(
      'Live session observed settings is unsafe'
    );

    await orchestrator.shutdown();
  });

  it('terminates Codex when live settings remove the attested permission profile', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-live-profile-boundary-')
    );
    const executable = await writeFakeCodexExecutable(dir, 'profile-drift');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter);
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const run = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });

    const failed = await waitForRunStatus(store, run.id, 'FAILED');
    expect(failed.terminalReason).toContain(
      'changed or removed the Task Monki permission profile'
    );
    expect(
      (await store.snapshot()).events.some(
        (event) =>
          event.runId === run.id &&
          event.type === 'AGENT_RUN_FAILED' &&
          JSON.stringify(event.payload).includes('CODEX_PERMISSION_PROFILE')
      )
    ).toBe(true);
    await expect(adapter.listModels()).rejects.toThrow(
      'changed or removed the Task Monki permission profile'
    );
    await orchestrator.shutdown();
  });

  it('stops initialization before persisting an unsafe recovery resume response', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-recovery-response-boundary-')
    );
    const executable = await writeFakeCodexExecutable(dir, 'unsafe-recovery-resume');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const safeSettings = {
      ...task.agentSettings,
      approvalPolicy: 'never',
      approvalsReviewer: 'user' as const
    };
    const session = await store.createAgentSession({
      task,
      iteration,
      worktree,
      runtimeId: 'codex',
      requestedSettings: safeSettings
    });
    await store.updateAgentSession(session.id, {
      providerSessionId: 'thread-1',
      providerSessionTreeId: 'session-tree-1',
      status: 'ACTIVE'
    });
    const run = await store.createRun({
      task,
      session,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      requestedSettings: safeSettings
    });
    await store.updateRun(run.id, {
      providerTurnId: 'turn-1',
      status: 'RUNNING'
    });
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
      enforceBrowserDevBoundary: true
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter, {
      allowNetworkAccess: false
    });

    await expect(orchestrator.initialize()).rejects.toThrow(
      'Recovery resume observed settings is unsafe'
    );

    const snapshot = await store.snapshot();
    expect(snapshot.agentServers.at(-1)?.status).toBe('EXITED');
    expect(snapshot.agentSessions.find((candidate) => candidate.id === session.id))
      .not.toHaveProperty('observedSettings');
    await expect(adapter.listModels()).rejects.toThrow(
      'Recovery resume observed settings is unsafe'
    );
  });

  it('retains review attachments when persistence fails after review/start acknowledgement', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-review-post-ack-')
    );
    const executable = await writeFakeCodexExecutable(
      dir,
      'review-interrupt-no-active'
    );
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter, {
    });
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir, {
      withTextAttachment: true
    });
    const sourceTerminal = waitForAppEvent(events, 'run.terminal');
    const sourceRun = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });
    await sourceTerminal;

    const updateRun = store.updateRun.bind(store);
    let rejectedAcknowledgement = false;
    vi.spyOn(store, 'updateRun').mockImplementation(async (runId, patch) => {
      if (
        !rejectedAcknowledgement &&
        patch.status === 'RUNNING' &&
        patch.attachmentSubmissions !== undefined
      ) {
        rejectedAcknowledgement = true;
        throw new Error('injected review persistence failure');
      }
      return updateRun(runId, patch);
    });

    await expect(
      orchestrator.startReview({
        task,
        iteration,
        worktree,
        sourceRun,
        target: { type: 'UNCOMMITTED_CHANGES' },
        settings: { ...task.agentSettings, reasoningEffort: 'low' }
      })
    ).rejects.toBeInstanceOf(AgentMutationAmbiguousError);

    const snapshot = await store.snapshot();
    const reviewRun = snapshot.runs.find((candidate) => candidate.mode === 'REVIEW');
    expect(reviewRun?.status).toBe('RECOVERY_REQUIRED');
    const journal = await fs.readFile(snapshot.agentServers[0]!.protocolJournalPath, 'utf8');
    const reviewFork = readOutboundMessages(journal)
      .filter((message) => message.method === 'thread/fork')
      .find((message) =>
        Boolean(
          (message.params as { developerInstructions?: string } | undefined)
            ?.developerInstructions
        )
      );
    const instructions = (
      reviewFork?.params as { developerInstructions?: string } | undefined
    )?.developerInstructions;
    const deliveryPath = readAttachmentManifestPaths(instructions)[0];
    await expect(fs.access(deliveryPath!)).resolves.toBeUndefined();

    await orchestrator.shutdown();
    await expect(fs.access(deliveryPath!)).resolves.toBeUndefined();
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('retains the acknowledged review fork when its observation cannot be persisted', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-review-fork-post-ack-')
    );
    const executable = await writeFakeCodexExecutable(
      dir,
      'review-interrupt-no-active'
    );
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter, {
    });
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir, {
      withTextAttachment: true
    });
    const sourceTerminal = waitForAppEvent(events, 'run.terminal');
    const sourceRun = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });
    await sourceTerminal;

    const recordObservation = store.recordAgentSettingsObservation.bind(store);
    let rejectedForkObservation = false;
    vi.spyOn(store, 'recordAgentSettingsObservation').mockImplementation(
      async (record) => {
        if (
          !rejectedForkObservation &&
          record.source === 'THREAD_FORK_RESPONSE'
        ) {
          rejectedForkObservation = true;
          throw new Error('injected fork observation persistence failure');
        }
        return recordObservation(record);
      }
    );

    await expect(
      orchestrator.startReview({
        task,
        iteration,
        worktree,
        sourceRun,
        target: { type: 'UNCOMMITTED_CHANGES' },
        settings: { ...task.agentSettings, reasoningEffort: 'low' }
      })
    ).rejects.toMatchObject({
      operation: 'thread/fork'
    });

    const snapshot = await store.snapshot();
    const reviewRun = snapshot.runs.find((candidate) => candidate.mode === 'REVIEW');
    const reviewSession = snapshot.agentSessions.find(
      (candidate) => candidate.id === reviewRun?.sessionId
    );
    expect(reviewRun?.status).toBe('RECOVERY_REQUIRED');
    expect(reviewSession).toMatchObject({
      providerSessionId: 'thread-review',
      providerSessionTreeId: 'session-tree-1',
      materialized: true
    });

    const journal = await fs.readFile(snapshot.agentServers[0]!.protocolJournalPath, 'utf8');
    const messages = readOutboundMessages(journal);
    const reviewFork = messages
      .filter((message) => message.method === 'thread/fork')
      .find((message) =>
        Boolean(
          (message.params as { developerInstructions?: string } | undefined)
            ?.developerInstructions
        )
      );
    expect(reviewFork).toBeDefined();
    expect(messages.some((message) => message.method === 'review/start')).toBe(false);
    const instructions = (
      reviewFork?.params as { developerInstructions?: string } | undefined
    )?.developerInstructions;
    const deliveryPath = readAttachmentManifestPaths(instructions)[0];
    await expect(fs.access(deliveryPath!)).resolves.toBeUndefined();

    await orchestrator.shutdown();
    await expect(fs.access(deliveryPath!)).resolves.toBeUndefined();
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('recovers when stopping a detached review with a stale provider turn id', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-review-interrupt-')
    );
    const executable = await writeFakeCodexExecutable(
      dir,
      'review-interrupt-mismatch'
    );
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter, {
    });
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const sourceTerminal = waitForAppEvent(events, 'run.terminal');
    const sourceRun = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });
    await sourceTerminal;

    const reviewRun = await orchestrator.startReview({
      task,
      iteration,
      worktree,
      sourceRun,
      target: { type: 'UNCOMMITTED_CHANGES' },
      settings: task.agentSettings
    });
    expect((await store.getRun(reviewRun.id))?.providerTurnId).toBe(
      'review-response-turn'
    );

    await orchestrator.interruptRun(reviewRun.id);

    const server = (await store.snapshot()).agentServers[0];
    const journal = await fs.readFile(server.protocolJournalPath, 'utf8');
    const interruptTurnIds = readOutboundMessages(journal)
      .filter((message) => message.method === 'turn/interrupt')
      .map((message) => (message.params as { turnId: string }).turnId);
    expect(interruptTurnIds).toEqual([
      'review-response-turn',
      'review-active-turn'
    ]);
    expect((await store.getRun(reviewRun.id))?.providerTurnId).toBe(
      'review-active-turn'
    );

    await orchestrator.shutdown();
  });

  it('locally stops a detached review when the provider never confirms the interrupt', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-review-interrupt-timeout-')
    );
    const executable = await writeFakeCodexExecutable(
      dir,
      'review-interrupt-ambiguous-no-terminal'
    );
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
      interruptRequestTimeoutMs: 40,
      interruptCompletionTimeoutMs: 40
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter, {
    });
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const sourceTerminal = waitForAppEvent(events, 'run.terminal');
    const sourceRun = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });
    await sourceTerminal;
    const reviewRun = await orchestrator.startReview({
      task,
      iteration,
      worktree,
      sourceRun,
      target: { type: 'UNCOMMITTED_CHANGES' },
      settings: task.agentSettings
    });

    await orchestrator.interruptRun(reviewRun.id);
    const interrupted = await waitForRunStatus(store, reviewRun.id, 'INTERRUPTED');
    const storedTask = await store.getTask(task.id);

    expect(interrupted.recoveryState).toBe('NONE');
    expect(interrupted.terminalReason).toContain('did not emit a terminal event');
    expect(storedTask?.projection.agentReview?.status).toBe('CANCELED');
    expect(storedTask?.projection.agentRun).toBe('COMPLETED');
    expect((await store.snapshot()).events.map((event) => event.type)).not.toContain(
      'AGENT_MUTATION_AMBIGUOUS'
    );
    await orchestrator.shutdown();
  });

  it('locally stops a detached review when the provider has no active turn', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-review-interrupt-idle-')
    );
    const executable = await writeFakeCodexExecutable(
      dir,
      'review-interrupt-no-active'
    );
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter, {
    });
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const sourceTerminal = waitForAppEvent(events, 'run.terminal');
    const sourceRun = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });
    await sourceTerminal;
    const reviewRun = await orchestrator.startReview({
      task,
      iteration,
      worktree,
      sourceRun,
      target: { type: 'UNCOMMITTED_CHANGES' },
      settings: task.agentSettings
    });

    await orchestrator.interruptRun(reviewRun.id);
    const interrupted = await waitForRunStatus(store, reviewRun.id, 'INTERRUPTED');
    const storedTask = await store.getTask(task.id);
    const storedSession = (await store.snapshot()).agentSessions.find(
      (session) => session.id === interrupted.sessionId
    );

    expect(interrupted.recoveryState).toBe('NONE');
    expect(interrupted.terminalReason).toContain('no active turn to interrupt');
    expect(storedSession?.status).toBe('IDLE');
    expect(storedTask?.projection.agentReview?.status).toBe('CANCELED');
    expect(storedTask?.projection.agentRun).toBe('COMPLETED');
    expect((await store.snapshot()).events.map((event) => event.type)).not.toContain(
      'AGENT_MUTATION_AMBIGUOUS'
    );

    await orchestrator.shutdown();
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('keeps an ambiguous implementation interrupt in the cancel path until the provider terminal event arrives', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-interrupt-terminal-')
    );
    const executable = await writeFakeCodexExecutable(
      dir,
      'interrupt-ambiguous-then-terminal'
    );
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
      interruptRequestTimeoutMs: 40,
      interruptCompletionTimeoutMs: 200
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter, {
    });
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const run = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });

    await orchestrator.interruptRun(run.id);
    const interrupted = await waitForRunStatus(store, run.id, 'INTERRUPTED');
    await (adapter as unknown as { inboundQueue: Promise<void> }).inboundQueue;

    expect(interrupted.recoveryState).toBe('NONE');
    expect(interrupted.terminalReason).toBe('interrupted');
    expect((await store.snapshot()).events.map((event) => event.type)).not.toContain(
      'AGENT_MUTATION_AMBIGUOUS'
    );
    await orchestrator.shutdown();
  });

  it('locally interrupts an implementation run when the provider never confirms the stop', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-interrupt-timeout-')
    );
    const executable = await writeFakeCodexExecutable(
      dir,
      'interrupt-ambiguous-no-terminal'
    );
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
      interruptRequestTimeoutMs: 40,
      interruptCompletionTimeoutMs: 40
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter, {
    });
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const run = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });

    await orchestrator.interruptRun(run.id);
    const interrupted = await waitForRunStatus(store, run.id, 'INTERRUPTED');
    await (adapter as unknown as { inboundQueue: Promise<void> }).inboundQueue;

    expect(interrupted.recoveryState).toBe('NONE');
    expect(interrupted.terminalReason).toContain('did not emit a terminal event');
    expect(interrupted.finalArtifactId).toBeTruthy();
    const snapshot = await store.snapshot();
    expect(snapshot.events.map((event) => event.type)).not.toContain(
      'AGENT_MUTATION_AMBIGUOUS'
    );
    expect(
      snapshot.events.filter(
        (event) => event.runId === run.id && event.type === 'AGENT_RUN_INTERRUPTED'
      )
    ).toHaveLength(1);
    expect(
      snapshot.artifacts.filter(
        (artifact) => artifact.runId === run.id && artifact.kind === 'agent-final'
      )
    ).toHaveLength(1);
    await orchestrator.shutdown();
  });

  it('requires recovery when local interruption cannot confirm process-tree termination', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-interrupt-termination-failure-')
    );
    const executable = await writeFakeCodexExecutable(
      dir,
      'interrupt-ambiguous-no-terminal'
    );
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
      interruptRequestTimeoutMs: 40,
      interruptCompletionTimeoutMs: 40
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter);
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const run = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });
    const supervisor = (
      adapter as unknown as { supervisor: CodexAppServerSupervisor }
    ).supervisor;
    const terminate = vi
      .spyOn(supervisor, 'terminateUnresponsive')
      .mockRejectedValue(new Error('injected process-tree termination failure'));
    const processTree = vi
      .spyOn(supervisor, 'processTreeRunning', 'get')
      .mockReturnValue(true);

    await orchestrator.interruptRun(run.id);
    const recoverySnapshot = await waitForSnapshot(
      store,
      (snapshot) => snapshot.runs.some(
        (candidate) =>
          candidate.id === run.id &&
          candidate.status === 'RECOVERY_REQUIRED' &&
          candidate.recoveryState === 'REQUIRES_USER_ACTION'
      ),
      'unconfirmed local interruption recovery'
    );
    const recovery = recoverySnapshot.runs.find(
      (candidate) => candidate.id === run.id
    )!;

    expect(recovery.recoveryState).toBe('REQUIRES_USER_ACTION');
    expect(recovery.terminalReason).toContain('termination was not fully confirmed');
    expect((await store.snapshot()).events.map((event) => event.type)).not.toContain(
      'AGENT_RUN_INTERRUPTED'
    );

    terminate.mockRestore();
    processTree.mockRestore();
    await orchestrator.shutdown();
  });
});

async function createTaskContext(
  store: FileTaskStore,
  dir: string,
  options: { withTextAttachment?: boolean } = {}
) {
  const repositoryDir = path.join(dir, 'repository');
  await fs.mkdir(repositoryDir, { recursive: true });
  let attachmentDraftId: string | undefined;
  if (options.withTextAttachment) {
    const draft = await store.createAttachmentDraft();
    await store.stageTaskAttachment({
      draftId: draft.id,
      displayName: 'review-context.json',
      bytes: Buffer.from('{"review":true}\n')
    });
    attachmentDraftId = draft.id;
  }
  const task = await store.createTask({
    title: 'Approval turn',
    prompt: 'Finish the fake task.',
    repositoryId: (await addTestRepository(store, repositoryDir)).id,
    attachmentDraftId,
    agentSettings: {
      model: 'fake-model',
      reasoningEffort: 'high',
      sandbox: 'WORKSPACE_WRITE',
      networkAccess: false,
      approvalPolicy: 'on-request'
    }
  });
  const { iteration, worktree } = await store.createIterationAndWorktree({
    task,
    branchName: 'codex/fake-approval',
    worktreePath: repositoryDir,
    baseSha: 'base'
  });
  return { task, iteration, worktree };
}

async function createBufferedCodexRun(
  directoryPrefix: string,
  credential = 'opaque-provider-credential-1742'
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), directoryPrefix));
  const store = new FileTaskStore(path.join(dir, 'store'));
  const events = new AppEventBus();
  const adapter = new CodexAppServerAdapter(store, events, {
    cwd: dir,
    environment: {
      ...process.env,
      OPENAI_API_KEY: credential
    },
    restartDelaysMs: []
  });
  const { task, iteration, worktree } = await createTaskContext(store, dir);
  const session = await store.createAgentSession({
    task,
    iteration,
    worktree,
    runtimeId: 'codex',
    requestedSettings: task.agentSettings
  });
  const created = await store.createRun({
    task,
    session,
    mode: 'IMPLEMENTATION',
    prompt: task.prompt,
    requestedSettings: task.agentSettings
  });
  const run = await store.updateRun(created.id, {
    providerTurnId: 'buffered-turn',
    status: 'RUNNING'
  });
  return { adapter, events, run, store };
}

async function waitForInteraction(
  store: FileTaskStore,
  status: 'PENDING' | 'ABORTED_SERVER_LOST' | 'STALE'
) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const interaction = (await store.snapshot()).interactionRequests.find(
      (candidate) => candidate.status === status
    );
    if (interaction) {
      return interaction;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for interaction status ${status}.`);
}

async function waitForRunStatus(
  store: FileTaskStore,
  runId: string,
  status: 'COMPLETED' | 'FAILED' | 'INTERRUPTED'
) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const run = await store.getRun(runId);
    if (run?.status === status) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for run ${runId} to reach ${status}.`);
}

async function waitForSnapshot(
  store: FileTaskStore,
  predicate: (snapshot: Awaited<ReturnType<FileTaskStore['snapshot']>>) => boolean,
  description: string
) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const snapshot = await store.snapshot();
    if (predicate(snapshot)) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for snapshot: ${description}.`);
}

async function waitForAgentItem(
  store: FileTaskStore,
  runId: string,
  providerItemId: string
) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const item = (await store.snapshot()).agentItems.find(
      (candidate) =>
        candidate.runId === runId && candidate.providerItemId === providerItemId
    );
    if (item) {
      return item;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for run ${runId} to receive item ${providerItemId}.`
  );
}

function onePixelPng(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
}

function waitForAppEvent(events: AppEventBus, type: 'run.terminal'): Promise<void> {
  return new Promise((resolve) => {
    events.on((event) => {
      if (event.type === type) {
        resolve();
      }
    });
  });
}

function readOutboundMethods(journal: string): string[] {
  return journal
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { direction: string; raw: string })
    .filter((entry) => entry.direction === 'OUTBOUND')
    .map((entry) => JSON.parse(entry.raw) as { method?: string })
    .map((message) => message.method)
    .filter((method): method is string => typeof method === 'string');
}

function readOutboundMessages(
  journal: string
): Array<{ method?: string; params?: unknown }> {
  return journal
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { direction: string; raw: string })
    .filter((entry) => entry.direction === 'OUTBOUND')
    .map((entry) => JSON.parse(entry.raw) as { method?: string; params?: unknown });
}

function readAttachmentManifestPaths(manifest: string | undefined): string[] {
  if (!manifest) return [];
  const prefix = 'Attachment metadata: ';
  return manifest
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(prefix))
    .map((line) => JSON.parse(line.slice(prefix.length)) as { readOnlyPath?: unknown })
    .map((metadata) => metadata.readOnlyPath)
    .filter((value): value is string => typeof value === 'string');
}

async function writeFakeCodexExecutable(
  directory: string,
  mode: Parameters<typeof fakeCodexScript>[0] = 'normal'
): Promise<string> {
  return writeNodeExecutable(directory, 'fake-codex', fakeCodexScript(mode));
}

function fakeCodexScript(
  mode:
    | 'normal'
    | 'credential-telemetry'
    | 'empty-models'
    | 'ack-only'
    | 'recovery-notification-echo'
    | 'turn-start-rejected-once'
    | 'turn-start-rejected-with-evidence'
    | 'turn-start-ambiguous-late'
    | 'approval'
    | 'recovery-approval'
    | 'stale-generation'
    | 'permission'
    | 'exit'
    | 'clear'
    | 'subagent'
    | 'unsafe-review-fork'
    | 'unsafe-live-settings'
    | 'profile-mismatch-create'
    | 'profile-drift'
    | 'unsafe-recovery-resume'
    | 'review-turn-start-mismatch'
    | 'review-interrupt-mismatch'
    | 'review-interrupt-ambiguous-no-terminal'
    | 'review-interrupt-no-active'
    | 'interrupt-ambiguous-then-terminal'
    | 'interrupt-ambiguous-no-terminal' = 'normal'
): string {
  return `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.141.0\\n');
  process.exit(0);
}
if (process.argv[2] === 'mcp' && process.argv[3] === 'list') {
  process.stdout.write('[]\\n');
  process.exit(0);
}
if (process.argv[2] === 'app-server' && process.argv.includes('--help')) {
  process.stdout.write('Usage: codex app-server [OPTIONS]\\n  --stdio\\n  --listen <URL>\\n');
  process.exit(0);
}

const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const mode = ${JSON.stringify(mode)};
const reviewMode = mode === 'review-turn-start-mismatch' || mode === 'review-interrupt-mismatch';
const reviewInterruptTimeoutMode = mode === 'review-interrupt-ambiguous-no-terminal';
const reviewInterruptNoActiveMode = mode === 'review-interrupt-no-active';
const interruptMode = mode === 'interrupt-ambiguous-then-terminal' || mode === 'interrupt-ambiguous-no-terminal';
const approvalMode = mode === 'approval' || mode === 'permission' || mode === 'exit' || mode === 'clear' || mode === 'subagent' || mode === 'stale-generation';
const reviewResponseTurnId = 'review-response-turn';
const reviewActiveTurnId = 'review-active-turn';
const turn = (status, error = null) => ({
  id: 'turn-1',
  items: [],
  itemsView: { type: 'complete' },
  status,
  error,
  startedAt: 1,
  completedAt: status === 'inProgress' ? null : 2,
  durationMs: status === 'inProgress' ? null : 100
});
const thread = (turns = []) => ({
  id: 'thread-1',
  sessionId: 'session-tree-1',
  forkedFromId: null,
  parentThreadId: null,
  preview: 'Finish the fake task.',
  ephemeral: false,
  modelProvider: 'openai',
  createdAt: 1,
  updatedAt: 1,
  status: { type: 'idle' },
  path: null,
  cwd: process.cwd(),
  cliVersion: '0.141.0',
  source: 'appServer',
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: null,
  turns
});
const childThread = () => ({
  ...thread(),
  id: 'thread-child',
  sessionId: 'session-tree-1',
  parentThreadId: 'thread-1',
  preview: 'Inspect the repository tests.',
  source: {
    subAgent: {
      thread_spawn: {
        parent_thread_id: 'thread-1',
        depth: 1,
        agent_path: 'explorer',
        agent_nickname: 'Scout',
        agent_role: 'explorer'
      }
    }
  },
  agentNickname: 'Scout',
  agentRole: 'explorer'
});
const reviewThread = () => ({
  ...thread(),
  id: 'thread-review',
  forkedFromId: 'thread-1',
  preview: 'Review current changes.',
  source: { subAgent: 'review' }
});
let currentProfileId = ':workspace';
let currentProfileNetworkAccess = false;
let turnStartAttempts = 0;
const threadResponse = (request = {}) => {
  currentProfileId = request.config?.default_permissions ?? currentProfileId;
  currentProfileNetworkAccess =
    request.config?.permissions?.[currentProfileId]?.network?.enabled === true;
  const configuredEffort =
    request.config && typeof request.config.model_reasoning_effort === 'string'
      ? request.config.model_reasoning_effort
      : 'high';
  return {
  thread: thread(),
  model: 'fake-model',
  modelProvider: 'openai',
  serviceTier: null,
  cwd: request.cwd ?? process.cwd(),
  runtimeWorkspaceRoots: [request.cwd ?? process.cwd()],
    activePermissionProfile: {
      id:
        mode === 'profile-mismatch-create' &&
        currentProfileId !== 'task_monki_capability_probe'
          ? ':workspace'
          : currentProfileId,
    extends: null
  },
  instructionSources: [],
  approvalPolicy: request.approvalPolicy ?? (approvalMode ? 'on-request' : 'never'),
  approvalsReviewer: request.approvalsReviewer ?? 'user',
  sandbox: {
    type: 'workspaceWrite',
    writableRoots: [process.cwd()],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true
  },
  reasoningEffort: configuredEffort
  };
};

rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (!('id' in message)) return;
  if (!message.method) {
    if (mode === 'approval' && message.id === 41) {
      send({ method: 'serverRequest/resolved', params: {
        threadId: 'thread-1',
        requestId: 41
      } });
      send({ method: 'item/completed', params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: Date.now(),
        item: {
          type: 'commandExecution',
          id: 'command-1',
          command: 'npm test',
          cwd: process.cwd(),
          processId: null,
          source: 'agent',
          status: 'completed',
          commandActions: [],
          aggregatedOutput: 'passed',
          exitCode: 0,
          durationMs: 10
        }
      } });
      send({ method: 'turn/completed', params: {
        threadId: 'thread-1',
        turn: turn('completed')
      } });
    }
    if (mode === 'recovery-approval' && message.id === 71) {
      send({ method: 'serverRequest/resolved', params: {
        threadId: 'thread-1',
        requestId: 71
      } });
      send({ method: 'item/completed', params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: Date.now(),
        item: {
          type: 'commandExecution',
          id: 'recovered-command',
          command: 'npm test',
          cwd: process.cwd(),
          processId: null,
          source: 'agent',
          status: 'completed',
          commandActions: [],
          aggregatedOutput: 'passed',
          exitCode: 0,
          durationMs: 10
        }
      } });
      send({ method: 'turn/completed', params: {
        threadId: 'thread-1',
        turn: turn('completed')
      } });
    }
    if (mode === 'permission' && message.id === 61) {
      send({ method: 'serverRequest/resolved', params: {
        threadId: 'thread-1',
        requestId: 61
      } });
      send({ method: 'turn/completed', params: {
        threadId: 'thread-1',
        turn: turn('completed')
      } });
    }
    if (mode === 'subagent' && message.id === 52) {
      send({ method: 'serverRequest/resolved', params: {
        threadId: 'thread-child',
        requestId: 52
      } });
      send({ method: 'item/completed', params: {
        threadId: 'thread-child',
        turnId: 'turn-child',
        completedAtMs: Date.now(),
        item: {
          type: 'commandExecution',
          id: 'child-command',
          command: 'npm test',
          cwd: process.cwd(),
          processId: null,
          source: 'agent',
          status: 'completed',
          commandActions: [],
          aggregatedOutput: 'passed',
          exitCode: 0,
          durationMs: 10
        }
      } });
      send({ method: 'item/completed', params: {
        threadId: 'thread-child',
        turnId: 'turn-child',
        completedAtMs: Date.now(),
        item: {
          type: 'agentMessage',
          id: 'child-message',
          text: 'Tests are present and focused.',
          phase: null,
          memoryCitation: null
        }
      } });
      send({ method: 'turn/completed', params: {
        threadId: 'thread-child',
        turn: { ...turn('completed'), id: 'turn-child' }
      } });
      send({ method: 'item/completed', params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: Date.now(),
        item: {
          type: 'collabAgentToolCall',
          id: 'spawn-1',
          tool: 'spawnAgent',
          status: 'completed',
          senderThreadId: 'thread-1',
          receiverThreadIds: ['thread-child'],
          prompt: 'Inspect the repository tests.',
          model: 'fake-model',
          reasoningEffort: 'low',
          agentsStates: {
            'thread-child': { status: 'completed', message: 'done' }
          }
        }
      } });
      send({ method: 'turn/completed', params: {
        threadId: 'thread-1',
        turn: turn('completed')
      } });
    }
    return;
  }
  switch (message.method) {
    case 'initialize':
      send({ id: message.id, result: {
        userAgent: 'fake',
        codexHome: process.cwd(),
        platformFamily: 'unix',
        platformOs: 'macos'
      } });
      break;
    case 'account/read':
      send({ id: message.id, result: {
        account: { type: 'apiKey' },
        requiresOpenaiAuth: false
      } });
      break;
    case 'modelProvider/capabilities/read':
      send({ id: message.id, result: {
        namespaceTools: true,
        imageGeneration: false,
        webSearch: true
      } });
      break;
    case 'model/list':
      send({ id: message.id, result: {
        data: mode === 'empty-models' ? [] : [{
          id: 'fake-model',
          model: 'fake-model',
          upgrade: null,
          upgradeInfo: null,
          availabilityNux: null,
          displayName: 'Fake Model',
          description: 'Test model',
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'Low' },
            { reasoningEffort: 'high', description: 'High' }
          ],
          defaultReasoningEffort: 'high',
          inputModalities: ['text', 'image'],
          supportsPersonality: false,
          additionalSpeedTiers: [],
          serviceTiers: [],
          defaultServiceTier: null,
          isDefault: true
        }],
        nextCursor: null
      } });
      break;
    case 'thread/start':
      send({ id: message.id, result: threadResponse(message.params) });
      break;
    case 'thread/resume':
      {
        const recoveringApproval =
          mode === 'recovery-approval' && message.params.threadId === 'thread-1';
        const recoveringTurn =
          (recoveringApproval || mode === 'stale-generation') &&
          message.params.threadId === 'thread-1';
        const response = {
          ...threadResponse(message.params),
          thread: thread([turn(recoveringTurn ? 'inProgress' : 'completed')])
        };
        if (mode === 'unsafe-recovery-resume') {
          response.sandbox = { type: 'dangerFullAccess' };
        }
        send({ id: message.id, result: response });
        if (mode === 'recovery-notification-echo') {
          send({ method: 'turn/completed', params: {
            threadId: 'thread-1',
            turn: turn('completed')
          } });
        }
        if (recoveringApproval) {
          setTimeout(() => {
            send({ method: 'item/started', params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              startedAtMs: Date.now(),
              item: {
                type: 'commandExecution',
                id: 'recovered-command',
                command: 'npm test',
                cwd: message.params.cwd,
                processId: null,
                source: 'agent',
                status: 'inProgress',
                commandActions: [],
                aggregatedOutput: null,
                exitCode: null,
                durationMs: null
              }
            } });
            send({ method: 'item/commandExecution/requestApproval', id: 71, params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'recovered-command',
              startedAtMs: Date.now(),
              reason: 'Verify the recovered turn',
              command: 'npm test',
              cwd: message.params.cwd,
              commandActions: []
            } });
          }, 20);
        }
      }
      break;
    case 'thread/read':
      send({ id: message.id, result: { thread: thread([turn('completed')]) } });
      break;
    case 'thread/fork':
      {
        const response = { ...threadResponse(message.params), thread: reviewThread() };
        if (mode === 'unsafe-review-fork') {
          response.sandbox = { type: 'dangerFullAccess' };
        }
        send({ id: message.id, result: response });
      }
      break;
    case 'thread/goal/set': {
      const goal = {
        threadId: 'thread-1',
        objective: message.params.objective,
        status: 'active',
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1
      };
      send({ id: message.id, result: { goal } });
      send({ method: 'thread/goal/updated', params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        goal
      } });
      break;
    }
    case 'thread/goal/get':
      send({ id: message.id, result: { goal: null } });
      break;
    case 'turn/steer':
      send({ id: message.id, result: { turnId: 'turn-1' } });
      break;
    case 'review/start':
      send({ id: message.id, result: {
        turn: { ...turn('inProgress'), id: reviewResponseTurnId },
        reviewThreadId: 'thread-review'
      } });
      if (mode === 'review-turn-start-mismatch') {
        setTimeout(() => {
          send({ method: 'turn/started', params: {
            threadId: 'thread-review',
            turn: { ...turn('inProgress'), id: reviewActiveTurnId }
          } });
          send({ method: 'item/started', params: {
            threadId: 'thread-review',
            turnId: reviewResponseTurnId,
            startedAtMs: Date.now(),
            item: {
              type: 'agentMessage',
              id: 'review-message',
              text: '',
              phase: null,
              memoryCitation: null
            }
          } });
          send({ method: 'item/completed', params: {
            threadId: 'thread-review',
            turnId: reviewResponseTurnId,
            completedAtMs: Date.now(),
            item: {
              type: 'agentMessage',
              id: 'review-message',
              text: 'Review is inspecting the current diff.',
              phase: null,
              memoryCitation: null
            }
          } });
        }, 10);
      }
      break;
    case 'turn/start':
      turnStartAttempts += 1;
      if (mode === 'turn-start-rejected-once' && turnStartAttempts === 1) {
        send({ id: message.id, error: {
          code: -32602,
          message: 'injected definitive turn/start rejection'
        } });
        return;
      }
      if (
        mode === 'turn-start-rejected-with-evidence' &&
        message.params.threadId === 'thread-1'
      ) {
        send({ method: 'turn/started', params: {
          threadId: 'thread-1',
          turn: { ...turn('inProgress'), id: 'turn-error-evidence' }
        } });
        send({ id: message.id, error: {
          code: -32602,
          message: 'injected turn/start error after turn evidence'
        } });
        return;
      }
      if (
        mode === 'turn-start-ambiguous-late' &&
        message.params.threadId === 'thread-1'
      ) {
        process.exit(17);
      }
      send({ id: message.id, result: { turn: turn('inProgress') } });
      if (mode === 'ack-only') return;
      setTimeout(() => {
        send({ method: 'turn/started', params: { threadId: 'thread-1', turn: turn('inProgress') } });
        send({ method: 'thread/settings/updated', params: {
          threadId: 'thread-1',
          threadSettings: {
            cwd: message.params.cwd ?? process.cwd(),
            approvalPolicy: message.params.approvalPolicy ?? 'on-request',
            approvalsReviewer: message.params.approvalsReviewer ?? 'user',
            sandboxPolicy: mode === 'unsafe-live-settings'
              ? { type: 'dangerFullAccess' }
              : message.params.sandboxPolicy ?? {
                  type: 'workspaceWrite',
                  writableRoots: [process.cwd()],
                  networkAccess: currentProfileNetworkAccess,
                  excludeTmpdirEnvVar: true,
                  excludeSlashTmp: true
                },
            activePermissionProfile: {
              id: mode === 'profile-drift' ? ':workspace' : currentProfileId,
              extends: null
            },
            model: mode === 'credential-telemetry'
              ? process.env.OPENAI_API_KEY
              : message.params.model ?? 'fake-model',
            modelProvider: 'openai',
            serviceTier: message.params.serviceTier ?? null,
            effort: message.params.effort ?? 'high',
            summary: message.params.summary ?? null,
            collaborationMode: null,
            personality: message.params.personality ?? null
          }
        } });
        if (mode === 'unsafe-live-settings') {
          send({ method: 'item/started', params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            startedAtMs: Date.now(),
            item: {
              type: 'commandExecution',
              id: 'unsafe-command',
              command: 'curl http://127.0.0.1:3099',
              cwd: process.cwd(),
              processId: null,
              source: 'agent',
              status: 'inProgress',
              commandActions: [],
              aggregatedOutput: null,
              exitCode: null,
              durationMs: null
            }
          } });
          send({ method: 'item/commandExecution/requestApproval', id: 88, params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'unsafe-command',
            startedAtMs: Date.now(),
            reason: 'Use the newly unsafe settings',
            command: 'curl http://127.0.0.1:3099',
            cwd: process.cwd(),
            commandActions: []
          } });
          return;
        }
        if (interruptMode) {
          return;
        }
        if (mode === 'subagent') {
          send({ method: 'item/started', params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            startedAtMs: Date.now(),
            item: {
              type: 'collabAgentToolCall',
              id: 'spawn-1',
              tool: 'spawnAgent',
              status: 'inProgress',
              senderThreadId: 'thread-1',
              receiverThreadIds: ['thread-child'],
              prompt: 'Inspect the repository tests.',
              model: 'fake-model',
              reasoningEffort: 'low',
              agentsStates: {
                'thread-child': { status: 'running', message: null }
              }
            }
          } });
          send({ method: 'thread/started', params: { thread: reviewThread() } });
          send({ method: 'thread/started', params: { thread: childThread() } });
          send({ method: 'turn/started', params: {
            threadId: 'thread-child',
            turn: { ...turn('inProgress'), id: 'turn-child' }
          } });
          send({ method: 'item/started', params: {
            threadId: 'thread-child',
            turnId: 'turn-child',
            startedAtMs: Date.now(),
            item: {
              type: 'commandExecution',
              id: 'child-command',
              command: 'npm test',
              cwd: message.params.cwd,
              processId: null,
              source: 'agent',
              status: 'inProgress',
              commandActions: [],
              aggregatedOutput: null,
              exitCode: null,
              durationMs: null
            }
          } });
          send({ method: 'item/commandExecution/requestApproval', id: 52, params: {
            threadId: 'thread-child',
            turnId: 'turn-child',
            itemId: 'child-command',
            startedAtMs: Date.now(),
            reason: 'Verify the delegated test analysis',
            command: 'npm test',
            cwd: message.params.cwd,
            commandActions: []
          } });
          return;
        }
        if (mode === 'permission') {
          const inputText = message.params.input.find((item) => item.type === 'text').text;
          const manifestLine = inputText.split('\\n').find((line) => line.startsWith('Attachment metadata: '));
          const metadata = JSON.parse(manifestLine.slice('Attachment metadata: '.length));
          send({ method: 'item/permissions/requestApproval', id: 61, params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'permission-1',
            environmentId: null,
            startedAtMs: Date.now(),
            cwd: message.params.cwd,
            reason: 'Read ' + metadata.readOnlyPath,
            permissions: {
              network: null,
              fileSystem: {
                read: [metadata.readOnlyPath],
                write: null,
                entries: [{ path: { type: 'path', path: metadata.readOnlyPath }, access: 'read' }]
              }
            }
          } });
          return;
        }
        if (approvalMode) {
          send({ method: 'item/started', params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            startedAtMs: Date.now(),
            item: {
              type: 'commandExecution',
              id: 'command-1',
              command: 'npm test',
              cwd: message.params.cwd,
              processId: null,
              source: 'agent',
              status: 'inProgress',
              commandActions: [],
              aggregatedOutput: null,
              exitCode: null,
              durationMs: null
            }
          } });
          send({ method: 'item/commandExecution/requestApproval', id: 41, params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'command-1',
            startedAtMs: Date.now(),
            reason: 'Run repository tests',
            command: 'npm test',
            cwd: message.params.cwd,
            commandActions: []
          } });
          if (mode === 'exit' || mode === 'stale-generation') {
            setTimeout(() => process.exit(17), 50);
          } else if (mode === 'clear') {
            setTimeout(() => {
              send({ method: 'serverRequest/resolved', params: {
                threadId: 'thread-1',
                requestId: 41
              } });
              send({ method: 'turn/completed', params: {
                threadId: 'thread-1',
                turn: turn('interrupted')
              } });
            }, 20);
          }
          return;
        }
        if (mode === 'credential-telemetry') {
          send({ method: 'thread/started', params: { thread: {
            ...thread(),
            id: 'credential-child',
            parentThreadId: 'thread-1',
            source: {
              subAgent: {
                thread_spawn: {
                  parent_thread_id: 'thread-1',
                  depth: 1,
                  agent_path: 'opaque-provider-credential-1742',
                  agent_nickname: 'opaque-provider-credential-1742',
                  agent_role: 'opaque-provider-credential-1742'
                }
              }
            },
            agentNickname: 'opaque-provider-credential-1742',
            agentRole: 'opaque-provider-credential-1742'
          } } });
          send({ method: 'model/rerouted', params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            fromModel: 'fake-model',
            toModel: process.env.OPENAI_API_KEY,
            reason: 'highRiskCyberActivity'
          } });
          send({ method: 'item/completed', params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            completedAtMs: Date.now(),
            item: {
              type: 'collabAgentToolCall',
              id: 'credential-spawn',
              tool: 'spawnAgent',
              status: 'completed',
              senderThreadId: 'thread-1',
              receiverThreadIds: ['credential-child'],
              prompt: 'Inspect credentials safely.',
              model: process.env.OPENAI_API_KEY,
              reasoningEffort: process.env.OPENAI_API_KEY,
              agentsStates: {
                'credential-child': { status: 'completed', message: 'done' }
              }
            }
          } });
          send({ method: 'error', params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            error: {
              message: 'Authorization: Bearer credential-error-secret',
              codexErrorInfo: 'other',
              additionalDetails: 'OPENAI_API_KEY=credential-error-secret'
            },
            willRetry: false
          } });
          send({ method: 'item/completed', params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            completedAtMs: Date.now(),
            item: {
              type: 'commandExecution',
              id: 'credential-command',
              command: 'printenv',
              cwd: process.cwd(),
              processId: null,
              source: 'agent',
              status: 'completed',
              commandActions: [],
              aggregatedOutput: 'OPENAI_API_KEY=credential-item-secret',
              exitCode: 0,
              durationMs: 10
            }
          } });
        }
        send({ method: 'turn/plan/updated', params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          explanation: 'Implement and verify.',
          plan: [
            { step: 'Implement', status: 'inProgress' },
            { step: 'Verify', status: 'pending' }
          ]
        } });
        send({ method: 'thread/tokenUsage/updated', params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          tokenUsage: {
            total: {
              totalTokens: 120,
              inputTokens: 80,
              cachedInputTokens: 20,
              outputTokens: 40,
              reasoningOutputTokens: 10
            },
            last: {
              totalTokens: 120,
              inputTokens: 80,
              cachedInputTokens: 20,
              outputTokens: 40,
              reasoningOutputTokens: 10
            },
            modelContextWindow: 200000
          }
        } });
        send({ method: 'item/started', params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          startedAtMs: Date.now(),
          item: { type: 'reasoning', id: 'reasoning-1', summary: [], content: [] }
        } });
        send({ method: 'item/completed', params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          completedAtMs: Date.now(),
          item: {
            type: 'reasoning',
            id: 'reasoning-1',
            summary: ['Checked the implementation approach.'],
            content: []
          }
        } });
        send({ method: 'item/started', params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          startedAtMs: Date.now(),
          item: { type: 'contextCompaction', id: 'compaction-1' }
        } });
        send({ method: 'item/completed', params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          completedAtMs: Date.now(),
          item: { type: 'contextCompaction', id: 'compaction-1' }
        } });
        send({ method: 'item/started', params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          startedAtMs: Date.now(),
          item: { type: 'agentMessage', id: 'item-1', text: '', phase: null, memoryCitation: null }
        } });
        send({ method: 'item/agentMessage/delta', params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'item-1',
          delta: mode === 'credential-telemetry'
            ? 'OPENAI_API_KEY=credential-output-secret opaque-provider-'
            : 'Fake task '
        } });
        const finishAgentMessage = () => {
          send({ method: 'item/agentMessage/delta', params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'item-1',
            delta: mode === 'credential-telemetry'
              ? 'credential-1742 completed.'
              : 'completed.'
          } });
          send({ method: 'item/completed', params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            completedAtMs: Date.now(),
            item: {
              type: 'agentMessage',
              id: 'item-1',
              text: mode === 'credential-telemetry'
                ? 'Bearer credential-message-secret'
                : 'Fake task completed.',
              phase: null,
              memoryCitation: null
            }
          } });
          send({ method: 'turn/completed', params: {
            threadId: 'thread-1',
            turn: turn('completed')
          } });
        };
        if (mode === 'credential-telemetry') {
          setTimeout(finishAgentMessage, 120);
        } else {
          finishAgentMessage();
        }
      }, 10);
      break;
    case 'turn/interrupt':
      if (interruptMode && message.params.threadId === 'thread-1') {
        if (mode === 'interrupt-ambiguous-then-terminal') {
          setTimeout(() => {
            send({ method: 'turn/completed', params: {
              threadId: 'thread-1',
              turn: turn('interrupted')
            } });
          }, 25);
        }
        break;
      }
      if (reviewInterruptTimeoutMode && message.params.threadId === 'thread-review') {
        break;
      }
      if (reviewInterruptNoActiveMode && message.params.threadId === 'thread-review') {
        send({ id: message.id, error: {
          code: -32600,
          message: 'no active turn to interrupt'
        } });
        break;
      }
      if (reviewMode && message.params.threadId === 'thread-review') {
        if (message.params.turnId !== reviewActiveTurnId) {
          send({ id: message.id, error: {
            code: -32602,
            message: 'expected active turn id ' + message.params.turnId + ' but found ' + reviewActiveTurnId
          } });
          break;
        }
      }
      send({ id: message.id, result: {} });
      break;
    default:
      send({ id: message.id, error: { code: -32601, message: 'unsupported' } });
  }
});
`;
}
