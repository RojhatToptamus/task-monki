import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgentOrchestrator } from '../AgentOrchestrator';
import { createAgentSessionAccessEpoch } from '../AgentRuntimeOwnership';
import { AgentTurnScheduler } from '../AgentTurnScheduler';
import { AgentMutationAmbiguousError } from '../AgentProviderAdapter';
import { AppEventBus } from '../../runner/AppEventBus';
import { FileAgentRuntimeStore } from '../../storage/FileAgentRuntimeStore';
import { FileTaskStore } from '../../storage/FileTaskStore';
import { writeNodeExecutable } from '../../../testSupport/fakeExecutable';
import { CodexAppServerAdapter } from './CodexAppServerAdapter';
import { CODEX_APP_SERVER_NOTIFICATION_OPT_OUTS } from './CodexAppServerSupervisor';
import { codexReadOnlyScopeProfile } from './CodexPermissionProfile';

const APP_SERVER_INTEGRATION_TIMEOUT_MS = 20_000;

describe('CodexAppServerAdapter', () => {
  it('runs a scoped discourse turn over real stdio without touching task projections', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-scoped-app-server-'));
    const executable = await writeFakeCodexExecutable(dir, 'scoped');
    const workspacePath = path.join(dir, 'read-only-workspace');
    await fs.mkdir(workspacePath, { mode: 0o700 });
    const workspace = await fs.realpath(workspacePath);
    const taskStore = new FileTaskStore(path.join(dir, 'task-store'));
    const runtime = new FileAgentRuntimeStore(path.join(dir, 'runtime'));
    const events = new AppEventBus();
    let resolveTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const adapter = new CodexAppServerAdapter(taskStore, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
      providerRuntimeStore: runtime,
      scopedRuntimeStore: runtime,
      onScopedTurnCompleted: async () => {
        resolveTerminal();
      }
    });
    await adapter.initialize();

    const owner = {
      kind: 'DISCOURSE' as const,
      conversationId: 'conversation-1',
      stableParticipantId: 'participant-1'
    };
    const sessionId = 'scoped-session-1';
    const profile = await codexReadOnlyScopeProfile({
      sessionId,
      scope: { primaryCwd: workspace, readOnlyRoots: [workspace] },
      reasoningEffort: 'high'
    });
    const executionContext = {
      attestation: { status: 'ATTESTED' as const },
      primaryCwd: workspace,
      readRoots: [{ canonicalPath: workspace, kind: 'EMPTY_MANAGED' as const }],
      managedAttachments: [],
      permissionProfileHash: profile.scopeHash,
      modelSettings: {
        model: 'fake-model',
        modelProvider: 'openai',
        reasoningEffort: 'high',
        sandbox: 'READ_ONLY' as const,
        networkAccess: false,
        approvalPolicy: 'NEVER',
        approvalsReviewer: 'user' as const
      },
      externalTools: {
        network: false,
        webSearch: 'disabled' as const,
        mcpServers: false,
        apps: false,
        dynamicTools: false
      },
      clientOperationId: 'scoped-execution-context-1'
    };
    const session = await runtime.createSession({
      id: sessionId,
      owner,
      accessEpoch: createAgentSessionAccessEpoch({
        owner,
        sessionId,
        epoch: 1,
        providerId: 'codex',
        model: 'fake-model',
        executionContext,
        createdAt: '2026-07-13T00:00:00.000Z'
      }),
      executionContext,
      clientOperationId: 'create-scoped-session',
      provider: 'codex',
      role: 'PRIMARY',
      relationshipState: 'ROOT',
      status: 'NOT_MATERIALIZED',
      materialized: false,
      requestedSettings: executionContext.modelSettings
    });
    const run = await runtime.createRun({
      id: 'scoped-run-1',
      owner,
      scope: {
        kind: 'DISCOURSE',
        conversationId: owner.conversationId,
        waveId: 'wave-1',
        jobId: 'job-1',
        contextSnapshotId: 'context-1',
        attemptId: 'attempt-1'
      },
      sessionId: session.id,
      sessionAccessEpoch: session.accessEpoch.epoch,
      purpose: 'DISCOURSE_ANSWER',
      generationKey: 'generation-1',
      clientOperationId: 'create-scoped-run',
      requestedSettings: executionContext.modelSettings,
      promptArtifactId: 'scoped-prompt-1',
      outputArtifactId: 'scoped-output-1',
      diagnosticArtifactId: 'scoped-diagnostic-1'
    });
    await Promise.all([
      runtime.createArtifact({
        id: run.promptArtifactId,
        owner,
        runId: run.id,
        kind: 'PROMPT',
        clientOperationId: 'create-scoped-prompt',
        content: 'Question the proposed architecture.'
      }),
      runtime.createArtifact({
        id: run.outputArtifactId,
        owner,
        runId: run.id,
        kind: 'OUTPUT',
        clientOperationId: 'create-scoped-output',
        content: ''
      }),
      runtime.createArtifact({
        id: run.diagnosticArtifactId,
        owner,
        runId: run.id,
        kind: 'DIAGNOSTIC',
        clientOperationId: 'create-scoped-diagnostic',
        content: ''
      })
    ]);
    const starting = await runtime.updateRun(
      run.id,
      run.recordRevision,
      {
        status: 'STARTING',
        delivery: 'SENDING',
        startedAt: '2026-07-13T00:00:01.000Z'
      },
      'scoped-start-intent'
    );
    const started = await adapter.startScopedTurn({
      session,
      run: starting,
      executionContext,
      prompt: 'Question the proposed architecture.'
    });
    const afterResponse = (await runtime.getRun(run.id))!;
    if (afterResponse.status === 'STARTING') {
      await runtime.updateRun(
        run.id,
        afterResponse.recordRevision,
        {
          serverInstanceId: started.serverInstanceId,
          providerTurnId: started.providerTurnId,
          status: 'RUNNING',
          delivery: 'ACKNOWLEDGED'
        },
        'scoped-start-ack'
      );
    }
    await terminal;

    await expect(runtime.getRun(run.id)).resolves.toMatchObject({
      status: 'COMPLETED',
      delivery: 'TERMINAL',
      providerTurnId: 'turn-1'
    });
    expect(await runtime.readArtifact(run.outputArtifactId)).toContain(
      'Fake task completed.'
    );
    expect(await taskStore.snapshot()).toMatchObject({
      tasks: [],
      runs: [],
      agentSessions: [],
      agentItems: [],
      interactionRequests: []
    });
    const journal = await fs.readFile(
      (await runtime.listAgentServers())[0]!.protocolJournalPath,
      'utf8'
    );
    const outbound = readOutboundMessages(journal);
    expect(outbound.find((message) => message.method === 'thread/start')?.params).toMatchObject({
      cwd: workspace,
      approvalPolicy: 'never',
      approvalsReviewer: 'user'
    });
    await adapter.shutdown();
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('discovers models and completes a real thread/turn lifecycle over stdio', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-app-server-'));
    const executable = await writeFakeCodexExecutable(dir);

    const store = new FileTaskStore(path.join(dir, 'store'));
    const runtime = new FileAgentRuntimeStore(path.join(dir, 'runtime'));
    const scheduler = new AgentTurnScheduler(runtime);
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
      providerRuntimeStore: runtime,
      scopedRuntimeStore: runtime
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter, {
      runtimeStore: runtime,
      scheduler
    });
    await orchestrator.initialize();

    const provider = await orchestrator.getProviderState();
    expect(provider.preflight.ready, JSON.stringify(provider.preflight.problems)).toBe(true);
    expect(provider.models[0]?.model).toBe('fake-model');
    expect(provider.models[0]?.supportedReasoningEfforts).toEqual(['low', 'high']);
    const initializedServer = (await runtime.listAgentServers())[0];
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
      repositoryPath: repositoryDir,
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
    expect(snapshot.agentServers).toEqual([]);
    expect((await runtime.listAgentServers())[0]?.runtimeKind).toBe('APP_SERVER');
    const runtimeTelemetry = await runtime.listTelemetryByOwner({
      kind: 'TASK',
      taskId: task.id
    });
    expect(new Set(runtimeTelemetry.map((record) => record.kind))).toEqual(
      new Set(['ITEM', 'GOAL', 'PLAN', 'USAGE', 'SETTINGS'])
    );
    expect(runtimeTelemetry).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'ITEM',
          sessionId: completed?.sessionId,
          runId: completed?.id
        })
      ])
    );
    for (const telemetry of runtimeTelemetry) {
      expect(telemetry.payload).not.toHaveProperty('taskId');
      expect(telemetry.payload).not.toHaveProperty('iterationId');
    }
    const finalJournal = await fs.readFile(
      (await runtime.listAgentServers())[0]!.protocolJournalPath,
      'utf8'
    );
    const outbound = readOutboundMessages(finalJournal);
    expect(finalJournal).not.toContain(imageBytes.toString('utf8'));
    expect(finalJournal).not.toContain(textBytes.toString('utf8').trim());
    // The parsed raw protocol journal is the explicit debug-only exception to
    // the path-free durable-record rule because Codex receives managed paths.
    expect(outbound.find((message) => message.method === 'thread/start')?.params)
      .toMatchObject({
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review'
      });
    const turnStart = outbound.find((message) => message.method === 'turn/start');
    expect(turnStart?.params).toMatchObject({
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review'
    });
    expect(turnStart?.params).not.toHaveProperty('sandboxPolicy');
    const profileResume = outbound
      .filter((message) => message.method === 'thread/resume')
      .at(-1);
    const profileConfig = (profileResume?.params as { config?: unknown } | undefined)?.config as {
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
    expect(run?.status).toBe('RECOVERY_REQUIRED');
    const server = snapshot.agentServers[0]!;
    const journal = await fs.readFile(server.protocolJournalPath, 'utf8');
    const turnStart = readOutboundMessages(journal).find(
      (message) => message.method === 'turn/start'
    );
    const manifest = (
      turnStart?.params as { input?: Array<{ type?: string; text?: string }> } | undefined
    )?.input?.find((item) => item.type === 'text')?.text;
    const deliveryPath = readAttachmentManifestPaths(manifest)[0];
    expect(deliveryPath).toContain(`${path.sep}attachments${path.sep}tasks${path.sep}`);
    await expect(fs.access(deliveryPath!)).resolves.toBeUndefined();

    await orchestrator.shutdown();
    await expect(fs.access(deliveryPath!)).resolves.toBeUndefined();
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('submits one typed approval response and waits for server resolution', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-approval-'));
    const executable = await writeFakeCodexExecutable(dir, 'approval');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const runtime = new FileAgentRuntimeStore(path.join(dir, 'runtime'));
    const scheduler = new AgentTurnScheduler(runtime);
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
      providerRuntimeStore: runtime,
      scopedRuntimeStore: runtime
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter, {
      runtimeStore: runtime,
      scheduler
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
    const server = (await runtime.listAgentServers())[0];
    const journal = await fs.readFile(server.protocolJournalPath, 'utf8');
    const response = journal
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { raw: string })
      .map((entry) => JSON.parse(entry.raw) as { id?: string | number; result?: unknown })
      .find((message) => message.id === 41 && message.result);
    expect(response?.id).toBe(41);
    const interactionTelemetry = (
      await runtime.listTelemetryByOwner({ kind: 'TASK', taskId: task.id })
    ).filter((record) => record.kind === 'INTERACTION');
    expect(
      new Set(
        interactionTelemetry.map(
          (record) => (record.payload as { status: string }).status
        )
      )
    ).toEqual(new Set(['PENDING', 'RESPONDING', 'RESOLVED']));

    await orchestrator.shutdown();
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
    const runtime = new FileAgentRuntimeStore(path.join(dir, 'runtime'));
    const scheduler = new AgentTurnScheduler(runtime);
    const events = new AppEventBus();
    const adapter = new CodexAppServerAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
      providerRuntimeStore: runtime,
      scopedRuntimeStore: runtime
    });
    const orchestrator = new AgentOrchestrator(store, events, adapter, {
      runtimeStore: runtime,
      scheduler
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
      relationshipState: 'RESOLVED'
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
    const runtimeSnapshot = await runtime.snapshot();
    const runtimeChildSession = runtimeSnapshot.sessions.find(
      (session) => session.providerSessionId === 'thread-child'
    );
    expect(runtimeChildSession).toMatchObject({
      role: 'SUBAGENT',
      parentSessionId: parentRun.sessionId,
      executionContext: {
        attestation: {
          status: 'INHERITED_UNATTESTED',
          parentSessionId: parentRun.sessionId
        }
      }
    });
    expect(runtimeSnapshot.runs.find((run) => run.providerTurnId === 'turn-child'))
      .toMatchObject({
        purpose: 'PROVIDER_SUBAGENT',
        parentRunId: parentRun.id,
        status: 'COMPLETED',
        delivery: 'TERMINAL'
      });
    expect(
      new Set(
        (await runtime.listTelemetryByOwner({ kind: 'TASK', taskId: task.id }))
          .filter((record) => record.sessionId === runtimeChildSession?.id)
          .map((record) => record.kind)
      )
    ).toEqual(new Set(['SUBAGENT', 'ITEM', 'INTERACTION']));

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
      provider: 'codex',
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
    expect(storedTask?.projection.codexReview?.status).toBe('CANCELED');
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
    expect(storedTask?.projection.codexReview?.status).toBe('CANCELED');
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

    expect(interrupted.recoveryState).toBe('NONE');
    expect(interrupted.terminalReason).toContain('did not emit a terminal event');
    expect(interrupted.finalArtifactId).toBeTruthy();
    expect((await store.snapshot()).events.map((event) => event.type)).not.toContain(
      'AGENT_MUTATION_AMBIGUOUS'
    );
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
    repositoryPath: repositoryDir,
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

async function waitForInteraction(
  store: FileTaskStore,
  status: 'PENDING' | 'ABORTED_SERVER_LOST' | 'STALE'
) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
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
  for (let attempt = 0; attempt < 300; attempt += 1) {
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
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const snapshot = await store.snapshot();
    if (predicate(snapshot)) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for snapshot: ${description}.`);
}

async function waitForRunProviderTurnId(
  store: FileTaskStore,
  runId: string,
  providerTurnId: string
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await store.getRun(runId);
    if (run?.providerTurnId === providerTurnId) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for run ${runId} to use provider turn ${providerTurnId}.`
  );
}

async function waitForAgentItem(
  store: FileTaskStore,
  runId: string,
  providerItemId: string
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
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
    | 'scoped'
    | 'ack-only'
    | 'approval'
    | 'permission'
    | 'exit'
    | 'clear'
    | 'subagent'
    | 'unsafe-review-fork'
    | 'unsafe-live-settings'
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
const approvalMode = mode === 'approval' || mode === 'permission' || mode === 'exit' || mode === 'clear' || mode === 'subagent';
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
    id: currentProfileId,
    extends: null
  },
  instructionSources: [],
  approvalPolicy: request.approvalPolicy ?? (approvalMode ? 'on-request' : 'never'),
  approvalsReviewer: request.approvalsReviewer ?? 'user',
  sandbox: mode === 'scoped' ? {
    type: 'readOnly',
    networkAccess: false
  } : {
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
        data: [{
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
        const response = { ...threadResponse(message.params), thread: thread([turn('completed')]) };
        if (mode === 'unsafe-recovery-resume') {
          response.sandbox = { type: 'dangerFullAccess' };
        }
        send({ id: message.id, result: response });
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
              : mode === 'scoped'
                ? { type: 'readOnly', networkAccess: false }
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
            model: message.params.model ?? 'fake-model',
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
          if (mode === 'exit') {
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
          delta: 'Fake task completed.'
        } });
        send({ method: 'item/completed', params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          completedAtMs: Date.now(),
          item: {
            type: 'agentMessage',
            id: 'item-1',
            text: 'Fake task completed.',
            phase: null,
            memoryCitation: null
          }
        } });
        send({ method: 'turn/completed', params: {
          threadId: 'thread-1',
          turn: turn('completed')
        } });
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
