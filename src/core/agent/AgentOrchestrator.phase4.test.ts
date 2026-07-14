import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentModel,
  AgentExecutionSettings,
  AgentPreflight,
  AgentProviderCapabilities,
  AgentSessionRecord,
  AgentSessionSnapshot
} from '../../shared/agent';
import { AppEventBus } from '../runner/AppEventBus';
import { createDomainEvent } from '../storage/domainEvent';
import { FileTaskStore } from '../storage/FileTaskStore';
import {
  AgentMutationAmbiguousError,
  AgentProviderSessionMissingError,
  type AgentProviderAdapter,
  type AgentReconciliationResult,
  type AgentSessionRef,
  type AgentTurn,
  type CreateAgentSession,
  type InterruptAgentTurn,
  type StartAgentReview,
  type StartAgentTurn,
  type SteerAgentTurn
} from './AgentProviderAdapter';
import { AgentOrchestrator } from './AgentOrchestrator';
import { codexCapabilities } from './codex/codexCapabilities';

describe('AgentOrchestrator Phase 4', () => {
  it('rejects image delivery before creating a run when the selected model is text-only', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-text-model-'));
    const repositoryDir = path.join(dir, 'repository');
    await fs.mkdir(repositoryDir);
    const store = new FileTaskStore(path.join(dir, 'store'));
    const adapter = new Phase4Adapter(store);
    const orchestrator = new AgentOrchestrator(store, new AppEventBus(), adapter, {
    });
    const draft = await store.createAttachmentDraft();
    await store.stageTaskAttachment({
      draftId: draft.id,
      displayName: 'screen.png',
      bytes: onePixelPng()
    });
    const task = await store.createTask({
      title: 'Text-only model',
      prompt: 'Inspect the screenshot.',
      repositoryPath: repositoryDir,
      attachmentDraftId: draft.id,
      agentSettings: { model: 'test-model', reasoningEffort: 'high' }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/text-only-model',
      worktreePath: repositoryDir,
      baseSha: 'base'
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
    ).rejects.toThrow('does not accept image attachments');

    const snapshot = await store.snapshot();
    expect(snapshot.runs).toHaveLength(0);
    expect(snapshot.agentSessions).toHaveLength(0);
  });

  it('normalizes legacy codex adapter provider settings before starting a turn', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-provider-normalize-'));
    const repositoryDir = path.join(dir, 'repository');
    await fs.mkdir(repositoryDir);
    const store = new FileTaskStore(path.join(dir, 'store'));
    const adapter = new Phase4Adapter(store);
    const orchestrator = new AgentOrchestrator(store, new AppEventBus(), adapter);
    const task = await store.createTask({
      title: 'Normalize provider',
      prompt: 'Start with legacy settings.',
      repositoryPath: repositoryDir,
      agentSettings: {
        model: 'test-model',
        modelProvider: 'codex',
        reasoningEffort: 'high'
      }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/provider-normalize',
      worktreePath: repositoryDir,
      baseSha: 'base'
    });

    await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });

    expect(adapter.lastStart?.settings?.modelProvider).toBe('openai');
  });

  it('preserves session lineage across steer, continue, and detached review', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-phase4-'));
    const repositoryDir = path.join(dir, 'repository');
    await fs.mkdir(repositoryDir);
    const store = new FileTaskStore(path.join(dir, 'store'));
    const adapter = new Phase4Adapter(store);
    const orchestrator = new AgentOrchestrator(store, new AppEventBus(), adapter);
    const task = await store.createTask({
      title: 'Phase 4',
      prompt: 'Implement continuation controls.',
      repositoryPath: repositoryDir,
      agentSettings: { model: 'test-model', reasoningEffort: 'high' }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/phase-4',
      worktreePath: repositoryDir,
      baseSha: 'base'
    });

    const first = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });
    await orchestrator.steerRun(first.id, 'Focus on recovery first.');
    expect(adapter.lastSteer?.providerTurnId).toBe(first.providerTurnId);
    expect(adapter.lastSteer?.clientMessageId).toBeTruthy();

    await terminal(store, first, 'AGENT_RUN_INTERRUPTED');
    const continued = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      sessionId: first.sessionId,
      mode: 'FOLLOW_UP',
      prompt: 'Continue after interruption.',
      settings: task.agentSettings,
      continuedFromRunId: first.id
    });
    expect(continued.sessionId).toBe(first.sessionId);
    expect(continued.continuedFromRunId).toBe(first.id);

    await terminal(store, continued, 'AGENT_RUN_COMPLETED');
    const reviewed = await orchestrator.startReview({
      task,
      iteration,
      worktree,
      sourceRun: (await store.getRun(continued.id))!,
      target: { type: 'UNCOMMITTED_CHANGES' },
      settings: {
        ...task.agentSettings,
        sandbox: 'READ_ONLY'
      }
    });
    const reviewSession = await store.getAgentSession(reviewed.sessionId);
    expect(reviewSession?.role).toBe('REVIEW');
    expect(reviewSession?.parentSessionId).toBe(first.sessionId);
    expect(reviewed.mode).toBe('REVIEW');
  });

  it('recreates a missing provider session and retries the same follow-up run', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-missing-session-'));
    const repositoryDir = path.join(dir, 'repository');
    await fs.mkdir(repositoryDir);
    const store = new FileTaskStore(path.join(dir, 'store'));
    const adapter = new Phase4Adapter(store);
    const orchestrator = new AgentOrchestrator(store, new AppEventBus(), adapter);
    const task = await store.createTask({
      title: 'Missing provider thread',
      prompt: 'Continue even when provider session storage was evicted.',
      repositoryPath: repositoryDir,
      agentSettings: { model: 'test-model', reasoningEffort: 'high' }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/missing-provider-thread',
      worktreePath: repositoryDir,
      baseSha: 'base'
    });
    const first = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });
    await terminal(store, first, 'AGENT_RUN_COMPLETED');
    const originalSession = (await store.getAgentSession(first.sessionId))!;
    adapter.missingProviderSessionOnStart = originalSession.providerSessionId;

    const continued = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      sessionId: first.sessionId,
      mode: 'FOLLOW_UP',
      prompt: 'Fix review feedback.',
      settings: task.agentSettings,
      continuedFromRunId: first.id
    });

    const recoveredSession = (await store.getAgentSession(first.sessionId))!;
    const snapshot = await store.snapshot();
    expect(continued.id).toBeTruthy();
    expect(continued.sessionId).toBe(first.sessionId);
    expect(continued.status).toBe('RUNNING');
    expect(recoveredSession.providerSessionId).toBe('thread-2');
    expect(recoveredSession.providerSessionId).not.toBe(originalSession.providerSessionId);
    expect(recoveredSession.relationshipDetail).toContain('was missing during turn/start');
    expect(
      snapshot.events.some(
        (event) =>
          event.type === 'AGENT_RUN_FAILED' &&
          event.runId === continued.id
      )
    ).toBe(false);
  });

  it('records ambiguous turn submission as recovery-required without false failure', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-phase4-ambiguous-'));
    const repositoryDir = path.join(dir, 'repository');
    await fs.mkdir(repositoryDir);
    const store = new FileTaskStore(path.join(dir, 'store'));
    const adapter = new Phase4Adapter(store);
    adapter.ambiguousStart = true;
    const orchestrator = new AgentOrchestrator(store, new AppEventBus(), adapter);
    const task = await store.createTask({
      title: 'Ambiguous start',
      prompt: 'Do not duplicate this mutation.',
      repositoryPath: repositoryDir,
      agentSettings: { model: 'test-model', reasoningEffort: 'high' }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/ambiguous',
      worktreePath: repositoryDir,
      baseSha: 'base'
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
    expect(snapshot.runs[0]?.status).toBe('RECOVERY_REQUIRED');
    expect(snapshot.runs[0]?.recoveryState).toBe('REQUIRES_USER_ACTION');
    expect(
      snapshot.events.some((event) => event.type === 'AGENT_RUN_FAILED')
    ).toBe(false);

    await orchestrator.interruptRun(snapshot.runs[0]!.id);
    await expect(store.getRun(snapshot.runs[0]!.id)).resolves.toMatchObject({
      status: 'INTERRUPTED',
      recoveryState: 'NONE',
      terminalReason: 'Recovery-required run was explicitly abandoned by the user.'
    });
  });

  it('refuses network-enabled turns when the browser development boundary disables them', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-network-boundary-'));
    const repositoryDir = path.join(dir, 'repository');
    await fs.mkdir(repositoryDir);
    const store = new FileTaskStore(path.join(dir, 'store'));
    const adapter = new Phase4Adapter(store);
    const orchestrator = new AgentOrchestrator(store, new AppEventBus(), adapter, {
      allowNetworkAccess: false
    });
    const task = await store.createTask({
      title: 'Keep dev API isolated',
      prompt: 'Do not expose the browser development API.',
      repositoryPath: repositoryDir,
      agentSettings: { model: 'test-model', networkAccess: true }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/network-boundary',
      worktreePath: repositoryDir,
      baseSha: 'base'
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
    ).rejects.toThrow('browser development server');
    expect((await store.snapshot()).runs).toHaveLength(0);

    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: {
          ...task.agentSettings,
          networkAccess: false,
          sandbox: 'DANGER_FULL_ACCESS'
        }
      })
    ).rejects.toThrow('browser development server');
    expect((await store.snapshot()).runs).toHaveLength(0);

    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: {
          ...task.agentSettings,
          networkAccess: false,
          sandbox: 'WORKSPACE_WRITE',
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user'
        }
      })
    ).rejects.toThrow('non-escalatable agent runs');
    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: {
          ...task.agentSettings,
          networkAccess: false,
          sandbox: 'WORKSPACE_WRITE',
          approvalPolicy: 'never',
          approvalsReviewer: 'auto_review'
        }
      })
    ).rejects.toThrow('automated approval reviewer');
    expect((await store.snapshot()).runs).toHaveLength(0);

    const legacySession = await store.createAgentSession({
      task,
      iteration,
      worktree,
      provider: 'codex',
      requestedSettings: {
        model: 'test-model',
        sandbox: 'WORKSPACE_WRITE',
        networkAccess: false,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user'
      }
    });
    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: {
          model: 'test-model',
          networkAccess: false,
          sandbox: 'WORKSPACE_WRITE',
          approvalPolicy: 'never',
          approvalsReviewer: 'user'
        }
      })
    ).rejects.toThrow('Selected session is unsafe');
    await store.updateAgentSession(legacySession.id, {
      requestedSettings: {
        model: 'test-model',
        sandbox: 'WORKSPACE_WRITE',
        networkAccess: false,
        approvalPolicy: 'never',
        approvalsReviewer: 'user'
      },
      observedSettings: {
        model: 'test-model',
        sandbox: 'WORKSPACE_WRITE',
        networkAccess: true,
        approvalPolicy: 'never',
        approvalsReviewer: 'user'
      }
    });
    const safeSettings: AgentExecutionSettings = {
      model: 'test-model',
      networkAccess: false,
      sandbox: 'WORKSPACE_WRITE',
      approvalPolicy: 'never',
      approvalsReviewer: 'user'
    };
    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: safeSettings
      })
    ).rejects.toThrow('Selected session observed settings is unsafe');
    await store.updateAgentSession(legacySession.id, { observedSettings: safeSettings });
    await store.recordAgentSettingsObservation({
      taskId: task.id,
      iterationId: iteration.id,
      sessionId: legacySession.id,
      provider: 'codex',
      source: 'THREAD_SETTINGS_NOTIFICATION',
      settings: { ...safeSettings, sandbox: 'DANGER_FULL_ACCESS' }
    });
    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: safeSettings
      })
    ).rejects.toThrow('latest settings observation is unsafe');
    await store.recordAgentSettingsObservation({
      taskId: task.id,
      iterationId: iteration.id,
      sessionId: legacySession.id,
      provider: 'codex',
      source: 'THREAD_SETTINGS_NOTIFICATION',
      settings: safeSettings
    });

    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: safeSettings
      })
    ).resolves.toMatchObject({
      requestedSettings: {
        networkAccess: false,
        sandbox: 'WORKSPACE_WRITE',
        approvalPolicy: 'never',
        approvalsReviewer: 'user'
      }
    });
  });

  it('rechecks provider-observed settings after creating a session and before turn/start', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-created-boundary-'));
    const store = new FileTaskStore(path.join(dir, 'store'));
    const adapter = new Phase4Adapter(store);
    const safeSettings: AgentExecutionSettings = {
      model: 'test-model',
      sandbox: 'WORKSPACE_WRITE',
      networkAccess: false,
      approvalPolicy: 'never',
      approvalsReviewer: 'user'
    };
    adapter.createdSessionObservedSettings = {
      ...safeSettings,
      networkAccess: true
    };
    const orchestrator = new AgentOrchestrator(store, new AppEventBus(), adapter, {
      allowNetworkAccess: false
    });
    const { task, iteration, worktree } = await createPhase4TaskContext(
      store,
      dir,
      safeSettings
    );

    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        settings: safeSettings
      })
    ).rejects.toThrow('Created session observed settings is unsafe');

    expect(adapter.startCount).toBe(0);
    expect((await store.snapshot()).runs).toHaveLength(0);
  });

  it('rechecks recreated session observations before retrying turn/start', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-recreated-boundary-'));
    const store = new FileTaskStore(path.join(dir, 'store'));
    const adapter = new Phase4Adapter(store);
    const safeSettings: AgentExecutionSettings = {
      model: 'test-model',
      sandbox: 'WORKSPACE_WRITE',
      networkAccess: false,
      approvalPolicy: 'never',
      approvalsReviewer: 'user'
    };
    const orchestrator = new AgentOrchestrator(store, new AppEventBus(), adapter, {
      allowNetworkAccess: false
    });
    const { task, iteration, worktree } = await createPhase4TaskContext(
      store,
      dir,
      safeSettings
    );
    const first = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: safeSettings
    });
    await terminal(store, first, 'AGENT_RUN_COMPLETED');
    const originalSession = (await store.getAgentSession(first.sessionId))!;
    adapter.missingProviderSessionOnStart = originalSession.providerSessionId;
    adapter.createdSessionObservedSettings = {
      ...safeSettings,
      sandbox: 'DANGER_FULL_ACCESS'
    };

    await expect(
      orchestrator.startTurn({
        task,
        iteration,
        worktree,
        sessionId: first.sessionId,
        mode: 'FOLLOW_UP',
        prompt: 'Continue safely.',
        settings: safeSettings,
        continuedFromRunId: first.id
      })
    ).rejects.toThrow('Recreated session observed settings is unsafe');

    expect(adapter.startCount).toBe(2);
    const followUp = (await store.snapshot()).runs.find(
      (run) => run.continuedFromRunId === first.id
    );
    expect(followUp).toMatchObject({ status: 'FAILED' });
  });

  it('stops the provider when recovery first observes unsafe browser-dev settings', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-recovery-boundary-'));
    const store = new FileTaskStore(path.join(dir, 'store'));
    const safeSettings: AgentExecutionSettings = {
      model: 'test-model',
      sandbox: 'WORKSPACE_WRITE',
      networkAccess: false,
      approvalPolicy: 'never',
      approvalsReviewer: 'user'
    };
    const { task, iteration, worktree } = await createPhase4TaskContext(
      store,
      dir,
      safeSettings
    );
    const session = await store.createAgentSession({
      task,
      iteration,
      worktree,
      provider: 'codex',
      requestedSettings: safeSettings
    });
    const run = await store.createRun({
      task,
      session,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      requestedSettings: safeSettings
    });
    const adapter = new Phase4Adapter(store);
    adapter.initializeObservedSettings = {
      sessionId: session.id,
      settings: { ...safeSettings, approvalPolicy: 'on-request' }
    };
    const orchestrator = new AgentOrchestrator(store, new AppEventBus(), adapter, {
      allowNetworkAccess: false
    });

    await expect(orchestrator.initialize()).rejects.toThrow(
      'Provider recovery reported unsafe observed settings'
    );

    expect(adapter.initializeCount).toBe(1);
    expect(adapter.shutdownCount).toBe(1);
    await expect(store.getRun(run.id)).resolves.toMatchObject({ status: 'FAILED' });
  });

  it('terminalizes unsafe persisted runs before browser-dev provider initialization', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-cold-boundary-'));
    const repositoryDir = path.join(dir, 'repository');
    await fs.mkdir(repositoryDir);
    const store = new FileTaskStore(path.join(dir, 'store'));
    const server = await store.createAgentServer({
      provider: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable: 'codex',
      argv: ['app-server', '--stdio']
    });
    const safeSettings: AgentExecutionSettings = {
      model: 'test-model',
      sandbox: 'WORKSPACE_WRITE' as const,
      networkAccess: false,
      approvalPolicy: 'never',
      approvalsReviewer: 'user' as const
    };
    const persisted: Array<{
      runId: string;
      sessionId: string;
      unsafe: boolean;
    }> = [];
    const persistRun = async (input: {
      title: string;
      status: 'QUEUED' | 'STARTING' | 'RUNNING' | 'RECOVERY_REQUIRED';
      runSettings: AgentExecutionSettings;
      sessionSettings?: AgentExecutionSettings;
      runObservedSettings?: AgentExecutionSettings;
      sessionObservedSettings?: AgentExecutionSettings;
      latestSettingsObservation?: AgentExecutionSettings;
      unsafe: boolean;
      attachment?: boolean;
    }) => {
      let attachmentDraftId: string | undefined;
      if (input.attachment) {
        const draft = await store.createAttachmentDraft();
        await store.stageTaskAttachment({
          draftId: draft.id,
          displayName: 'startup-input.txt',
          bytes: new TextEncoder().encode('cold-start boundary input')
        });
        attachmentDraftId = draft.id;
      }
      const task = await store.createTask({
        title: input.title,
        prompt: input.title,
        repositoryPath: repositoryDir,
        agentSettings: input.runSettings,
        attachmentDraftId
      });
      const { iteration, worktree } = await store.createIterationAndWorktree({
        task,
        branchName: `codex/${input.title}`,
        worktreePath: repositoryDir,
        baseSha: 'base'
      });
      const session = await store.createAgentSession({
        task,
        iteration,
        worktree,
        provider: 'codex',
        requestedSettings: input.sessionSettings ?? input.runSettings
      });
      if (input.sessionObservedSettings) {
        await store.updateAgentSession(session.id, {
          observedSettings: input.sessionObservedSettings
        });
      }
      const run = await store.createRun({
        task,
        session,
        serverInstanceId: server.id,
        mode: 'IMPLEMENTATION',
        prompt: task.prompt,
        requestedSettings: input.runSettings
      });
      if (input.status !== 'QUEUED') {
        await store.updateRun(run.id, {
          status: input.status,
          recoveryState:
            input.status === 'RECOVERY_REQUIRED' ? 'REQUIRES_USER_ACTION' : 'NONE',
          observedSettings: input.runObservedSettings
        });
      } else if (input.runObservedSettings) {
        await store.updateRun(run.id, { observedSettings: input.runObservedSettings });
      }
      if (input.latestSettingsObservation) {
        await store.recordAgentSettingsObservation({
          taskId: task.id,
          iterationId: iteration.id,
          sessionId: session.id,
          runId: run.id,
          provider: 'codex',
          source: 'THREAD_SETTINGS_NOTIFICATION',
          settings: input.latestSettingsObservation
        });
      }
      persisted.push({ runId: run.id, sessionId: session.id, unsafe: input.unsafe });
      const deliveryPath = input.attachment
        ? (await store.prepareRunAttachments(run.id, task.id))[0]?.absolutePath
        : undefined;
      return { task, iteration, worktree, session, run, deliveryPath };
    };

    const queuedNetwork = await persistRun({
      title: 'queued-network',
      status: 'QUEUED',
      runSettings: { ...safeSettings, networkAccess: true },
      unsafe: true,
      attachment: true
    });
    await persistRun({
      title: 'running-full-access',
      status: 'RUNNING',
      runSettings: { ...safeSettings, sandbox: 'DANGER_FULL_ACCESS' },
      unsafe: true
    });
    const pendingApprovalWithSafeSettings = await persistRun({
      title: 'running-pending-approval',
      status: 'RUNNING',
      runSettings: safeSettings,
      unsafe: true
    });
    await persistRun({
      title: 'recovery-escalatable',
      status: 'RECOVERY_REQUIRED',
      runSettings: { ...safeSettings, approvalPolicy: 'on-request' },
      unsafe: true
    });
    await persistRun({
      title: 'starting-session-reviewer',
      status: 'STARTING',
      runSettings: safeSettings,
      sessionSettings: { ...safeSettings, approvalsReviewer: 'guardian_subagent' },
      unsafe: true
    });
    await persistRun({
      title: 'running-session-observed-network',
      status: 'RUNNING',
      runSettings: safeSettings,
      sessionObservedSettings: { ...safeSettings, networkAccess: true },
      unsafe: true
    });
    await persistRun({
      title: 'running-run-observed-full-access',
      status: 'RUNNING',
      runSettings: safeSettings,
      runObservedSettings: { ...safeSettings, sandbox: 'DANGER_FULL_ACCESS' },
      unsafe: true
    });
    await persistRun({
      title: 'running-latest-observation-escalatable',
      status: 'RUNNING',
      runSettings: safeSettings,
      latestSettingsObservation: { ...safeSettings, approvalPolicy: 'on-request' },
      unsafe: true
    });
    await persistRun({
      title: 'queued-safe',
      status: 'QUEUED',
      runSettings: safeSettings,
      unsafe: false
    });
    expect(queuedNetwork.deliveryPath).toBeTruthy();
    await expect(fs.stat(queuedNetwork.deliveryPath!)).resolves.toBeTruthy();
    const rawInteraction = await store.appendProtocolMessage(
      server.id,
      'INBOUND',
      '{"method":"item/commandExecution/requestApproval","id":71}',
      { method: 'item/commandExecution/requestApproval' }
    );
    const pendingInteraction = await store.createInteractionRequest({
      serverInstanceId: server.id,
      providerRequestId: 71,
      taskId: pendingApprovalWithSafeSettings.task.id,
      iterationId: pendingApprovalWithSafeSettings.iteration.id,
      runId: pendingApprovalWithSafeSettings.run.id,
      sessionId: pendingApprovalWithSafeSettings.session.id,
      type: 'COMMAND_APPROVAL',
      request: { command: 'curl http://127.0.0.1:3099', startedAtMs: Date.now() },
      allowedActions: ['ACCEPT', 'DECLINE', 'CANCEL'],
      policyWarnings: [],
      requestRawMessage: rawInteraction
    });

    const electronAdapter = new Phase4Adapter(store);
    const electronOrchestrator = new AgentOrchestrator(
      store,
      new AppEventBus(),
      electronAdapter,
      {}
    );
    await electronOrchestrator.initialize();
    expect(
      electronAdapter.runsAtInitialize.filter((run) =>
        persisted.some((expected) => expected.unsafe && expected.runId === run.id)
      )
    ).toHaveLength(persisted.filter((expected) => expected.unsafe).length);
    await expect(fs.stat(queuedNetwork.deliveryPath!)).resolves.toBeTruthy();

    const terminalRunIds: string[] = [];
    const events = new AppEventBus();
    events.on((event) => {
      if (event.type === 'run.terminal' && event.runId) terminalRunIds.push(event.runId);
    });
    const adapter = new Phase4Adapter(store);
    const orchestrator = new AgentOrchestrator(store, events, adapter, {
      allowNetworkAccess: false,
    });

    const failedTerminalWrite = vi
      .spyOn(store, 'writeFinalArtifact')
      .mockRejectedValueOnce(new Error('simulated storage failure'));
    await expect(orchestrator.initialize()).rejects.toThrow('simulated storage failure');
    expect(adapter.initializeCount).toBe(0);
    failedTerminalWrite.mockRestore();

    await orchestrator.initialize();

    expect(adapter.initializeCount).toBe(1);
    const snapshot = await store.snapshot();
    await expect(fs.stat(queuedNetwork.deliveryPath!)).resolves.toBeTruthy();
    expect(
      snapshot.interactionRequests.find((request) => request.id === pendingInteraction.id)
    ).toMatchObject({ status: 'STALE' });
    for (const expected of persisted) {
      const run = snapshot.runs.find((candidate) => candidate.id === expected.runId);
      const statusAtProviderInitialize = adapter.runsAtInitialize.find(
        (candidate) => candidate.id === expected.runId
      )?.status;
      if (expected.unsafe) {
        expect(run).toMatchObject({
          status: 'FAILED',
          recoveryState: 'NONE'
        });
        expect(run?.terminalReason).toContain('persisted run was not resumed');
        expect(statusAtProviderInitialize).toBe('FAILED');
        expect(terminalRunIds).toContain(expected.runId);
        expect(
          snapshot.agentSessions.find((session) => session.id === expected.sessionId)?.status
        ).toBe('NOT_LOADED');
      } else {
        expect(run?.status).toBe('QUEUED');
        expect(statusAtProviderInitialize).toBe('QUEUED');
        expect(terminalRunIds).not.toContain(expected.runId);
      }
    }
    expect(
      snapshot.events.filter(
        (event) =>
          event.type === 'AGENT_RUN_FAILED' &&
          JSON.stringify(event.payload).includes('BROWSER_DEV')
      )
    ).toHaveLength(persisted.filter((expected) => expected.unsafe).length);
    await orchestrator.shutdown();
    await electronOrchestrator.shutdown();
  });

  it('rejects unexpected provider approval acceptance in browser-dev mode', async () => {
    const getInteractionRequest = vi.fn().mockResolvedValue({
      id: 'interaction-one',
      taskId: 'task-one',
      runId: 'run-one',
      type: 'COMMAND_APPROVAL'
    });
    const store = { getInteractionRequest } as unknown as FileTaskStore;
    const adapter = new Phase4Adapter(store);
    const orchestrator = new AgentOrchestrator(store, new AppEventBus(), adapter, {
      allowNetworkAccess: false
    });

    await expect(
      orchestrator.respondToInteraction({
        taskId: 'task-one',
        runId: 'run-one',
        interactionRequestId: 'interaction-one',
        decision: {
          interactionType: 'COMMAND_APPROVAL',
          action: 'ACCEPT'
        }
      })
    ).rejects.toThrow('can only be declined or canceled');
    expect(getInteractionRequest).toHaveBeenCalledWith('interaction-one');
  });
});

class Phase4Adapter implements AgentProviderAdapter {
  ambiguousStart = false;
  missingProviderSessionOnStart?: string;
  createdSessionObservedSettings?: AgentExecutionSettings;
  initializeObservedSettings?: {
    sessionId: string;
    settings: AgentExecutionSettings;
  };
  lastStart?: StartAgentTurn;
  startCount = 0;
  initializeCount = 0;
  shutdownCount = 0;
  runsAtInitialize: Array<{ id: string; status: string }> = [];
  lastSteer?: SteerAgentTurn;
  private turnCounter = 0;
  private threadCounter = 0;

  constructor(private readonly store: FileTaskStore) {}

  async initialize(): Promise<void> {
    this.initializeCount += 1;
    if (this.initializeObservedSettings) {
      await this.store.updateAgentSession(this.initializeObservedSettings.sessionId, {
        observedSettings: this.initializeObservedSettings.settings
      });
    }
    this.runsAtInitialize = (await this.store.snapshot()).runs.map((run) => ({
      id: run.id,
      status: run.status
    }));
  }

  preflight(): Promise<AgentPreflight> {
    return Promise.resolve({
      provider: 'codex',
      ready: true,
      capabilities: codexCapabilities(),
      problems: [],
      warnings: []
    });
  }

  capabilities(): Promise<AgentProviderCapabilities> {
    return Promise.resolve(codexCapabilities());
  }

  listModels(): Promise<AgentModel[]> {
    return Promise.resolve([
      {
        id: 'test-model',
        provider: 'codex',
        model: 'test-model',
        displayName: 'Test model',
        hidden: false,
        supportedReasoningEfforts: ['high'],
        defaultReasoningEffort: 'high',
        serviceTiers: [],
        inputModalities: ['text'],
        isDefault: true
      }
    ]);
  }

  async createSession(input: CreateAgentSession): Promise<AgentSessionRecord> {
    this.threadCounter += 1;
    return this.store.updateAgentSession(input.localSessionId, {
      providerSessionId: `thread-${this.threadCounter}`,
      providerSessionTreeId: `thread-${this.threadCounter}`,
      status: 'IDLE',
      requestedSettings: input.settings,
      observedSettings: this.createdSessionObservedSettings
    });
  }

  async attachSession(ref: AgentSessionRef): Promise<AgentSessionRecord> {
    const session = await this.store.getAgentSession(ref.localSessionId);
    if (!session) {
      throw new Error('Session not found.');
    }
    return session;
  }

  async readSession(ref: AgentSessionRef): Promise<AgentSessionSnapshot> {
    return { session: await this.attachSession(ref), runs: [] };
  }

  async startTurn(input: StartAgentTurn): Promise<AgentTurn> {
    this.lastStart = input;
    this.startCount += 1;
    if (
      this.missingProviderSessionOnStart &&
      input.session.providerSessionId === this.missingProviderSessionOnStart
    ) {
      this.missingProviderSessionOnStart = undefined;
      throw new AgentProviderSessionMissingError(
        'turn/start',
        `thread not found: ${input.session.providerSessionId}`
      );
    }
    if (this.ambiguousStart) {
      throw new AgentMutationAmbiguousError(
        'turn/start',
        'Connection closed after submission.'
      );
    }
    this.turnCounter += 1;
    const providerTurnId = `turn-${this.turnCounter}`;
    await this.store.updateRun(input.localRunId, {
      providerTurnId,
      status: 'RUNNING'
    });
    return { localRunId: input.localRunId, providerTurnId };
  }

  steerTurn(input: SteerAgentTurn): Promise<void> {
    this.lastSteer = input;
    return Promise.resolve();
  }

  interruptTurn(_input: InterruptAgentTurn): Promise<void> {
    return Promise.resolve();
  }

  async startReview(input: StartAgentReview): Promise<AgentTurn> {
    this.threadCounter += 1;
    this.turnCounter += 1;
    const providerTurnId = `review-${this.turnCounter}`;
    await this.store.updateAgentSession(input.reviewSessionId, {
      providerSessionId: `review-thread-${this.threadCounter}`,
      providerSessionTreeId: `review-thread-${this.threadCounter}`,
      status: 'ACTIVE'
    });
    await this.store.updateRun(input.localRunId, {
      providerTurnId,
      status: 'RUNNING'
    });
    return { localRunId: input.localRunId, providerTurnId };
  }

  respondToInteraction(): Promise<void> {
    return Promise.resolve();
  }

  reconcile(): Promise<AgentReconciliationResult> {
    return Promise.resolve({
      reconciledSessionIds: [],
      recoveryRequiredSessionIds: []
    });
  }

  shutdown(): Promise<void> {
    this.shutdownCount += 1;
    return Promise.resolve();
  }
}

async function createPhase4TaskContext(
  store: FileTaskStore,
  dir: string,
  settings: AgentExecutionSettings
) {
  const repositoryDir = path.join(dir, 'repository');
  await fs.mkdir(repositoryDir, { recursive: true });
  const task = await store.createTask({
    title: 'Browser development boundary',
    prompt: 'Keep this turn inside the restricted boundary.',
    repositoryPath: repositoryDir,
    agentSettings: settings
  });
  const { iteration, worktree } = await store.createIterationAndWorktree({
    task,
    branchName: `codex/browser-boundary-${task.id}`,
    worktreePath: repositoryDir,
    baseSha: 'base'
  });
  return { task, iteration, worktree };
}

async function terminal(
  store: FileTaskStore,
  run: { id: string; taskId: string; iterationId: string; worktreeId: string; sessionId: string },
  type: 'AGENT_RUN_COMPLETED' | 'AGENT_RUN_FAILED' | 'AGENT_RUN_INTERRUPTED'
): Promise<void> {
  await store.appendEvent(
    createDomainEvent({
      type,
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      worktreeId: run.worktreeId,
      agentSessionId: run.sessionId,
      source: 'provider',
      payload: type === 'AGENT_RUN_FAILED' ? { error: 'failed' } : {}
    })
  );
}

function onePixelPng(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
}
