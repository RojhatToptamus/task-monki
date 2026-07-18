import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentModel,
  AgentExecutionSettings,
  AgentPreflight,
  AgentRuntimeCapabilities,
  AgentSessionRecord,
  AgentSessionSnapshot
} from '../../shared/agent';
import { AppEventBus } from '../runner/AppEventBus';
import { createDomainEvent } from '../storage/domainEvent';
import { FileTaskStore } from '../storage/FileTaskStore';
import {
  AgentMutationAmbiguousError,
  AgentProviderSessionMissingError,
  type AgentRuntimeAdapter,
  type AgentReconciliationResult,
  type AgentSessionRef,
  type AgentTurn,
  type CreateAgentSession,
  type InterruptAgentTurn,
  type ForkAgentSession,
  type StartAgentReview,
  type StartAgentTurn,
  type SteerAgentTurn,
  type SyncAgentGoal,
  type ResolveAgentExecution,
  type ResolvedAgentExecution
} from './AgentRuntimeAdapter';
import { createRuntimeReadiness } from './AgentRuntimeReadiness';
import { AgentOrchestrator } from './AgentOrchestrator';
import { assertModelSupportsAttachments } from './AgentAttachmentDelivery';
import {
  CODEX_RUNTIME_DESCRIPTOR,
  codexCapabilities
} from './codex/codexCapabilities';
import {
  OPENCODE_RUNTIME_DESCRIPTOR,
  opencodeCapabilities
} from './opencode/opencodeCapabilities';

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

  it('uses the adapter-resolved provider identity before starting a turn', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-provider-normalize-'));
    const repositoryDir = path.join(dir, 'repository');
    await fs.mkdir(repositoryDir);
    const store = new FileTaskStore(path.join(dir, 'store'));
    const adapter = new Phase4Adapter(store);
    const orchestrator = new AgentOrchestrator(store, new AppEventBus(), adapter);
    const task = await store.createTask({
      title: 'Normalize provider',
      prompt: 'Start with resolved settings.',
      repositoryPath: repositoryDir,
      agentSettings: {
        model: 'test-model',
        modelProvider: 'openai',
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

  it('preserves recovery established by a provider before startup rejects', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-provider-start-recovery-')
    );
    const repositoryDir = path.join(dir, 'repository');
    await fs.mkdir(repositoryDir);
    const store = new FileTaskStore(path.join(dir, 'store'));
    const adapter = new Phase4Adapter(store);
    adapter.recoveryThenRejectStart = true;
    const appEvents = new AppEventBus();
    const terminalEvents: unknown[] = [];
    appEvents.on((event) => {
      if (event.type === 'run.terminal') terminalEvents.push(event);
    });
    const orchestrator = new AgentOrchestrator(store, appEvents, adapter);
    const task = await store.createTask({
      title: 'Provider startup recovery',
      prompt: 'Preserve provider recovery evidence.',
      repositoryPath: repositoryDir,
      agentSettings: { model: 'test-model', reasoningEffort: 'high' }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/provider-start-recovery',
      worktreePath: repositoryDir,
      baseSha: 'base'
    });

    const getRun = store.getRun.bind(store);
    let staleActiveRun: Awaited<ReturnType<typeof getRun>>;
    let returnedStaleRun = false;
    vi.spyOn(store, 'getRun').mockImplementation(async (runId) => {
      const current = await getRun(runId);
      if (current && current.status !== 'RECOVERY_REQUIRED' && !staleActiveRun) {
        staleActiveRun = current;
      }
      if (
        current?.status === 'RECOVERY_REQUIRED' &&
        staleActiveRun &&
        !returnedStaleRun
      ) {
        returnedStaleRun = true;
        return staleActiveRun;
      }
      return current;
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
    ).rejects.toThrow('provider failed after publishing recovery');

    const snapshot = await store.snapshot();
    expect(snapshot.runs[0]).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      recoveryState: 'REQUIRES_USER_ACTION',
      terminalReason: 'Provider established recovery before rejecting startup.'
    });
    expect(
      snapshot.events.filter((event) => event.type === 'AGENT_MUTATION_AMBIGUOUS')
    ).toHaveLength(1);
    expect(
      snapshot.events.some((event) => event.type === 'AGENT_RUN_FAILED')
    ).toBe(false);
    expect(returnedStaleRun).toBe(true);
    expect(terminalEvents).toEqual([]);

    const recoveryRun = snapshot.runs[0]!;
    expect(recoveryRun.finalArtifactId).toBeUndefined();
    expect(
      snapshot.artifacts.filter(
        (artifact) =>
          artifact.runId === recoveryRun.id && artifact.kind === 'agent-final'
      )
    ).toEqual([]);

    await orchestrator.interruptRun(recoveryRun.id);
    const resolved = (await store.getRun(recoveryRun.id))!;
    expect(resolved).toMatchObject({
      status: 'INTERRUPTED',
      recoveryState: 'NONE',
      terminalReason: 'Recovery-required run was explicitly abandoned by the user.'
    });
    expect(resolved.finalArtifactId).toBeTruthy();
    await expect(store.readArtifact(resolved.finalArtifactId!)).resolves.toContain(
      '# Recovery run closed'
    );
    await expect(store.readArtifact(resolved.finalArtifactId!)).resolves.not.toContain(
      'provider failed after publishing recovery'
    );
  });

  it('links a winning startup failure artifact to its failed review projection', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-review-start-failure-')
    );
    const repositoryDir = path.join(dir, 'repository');
    await fs.mkdir(repositoryDir);
    const store = new FileTaskStore(path.join(dir, 'store'));
    const adapter = new Phase4Adapter(store);
    const orchestrator = new AgentOrchestrator(store, new AppEventBus(), adapter);
    const task = await store.createTask({
      title: 'Review startup failure',
      prompt: 'Keep failed review evidence coherent.',
      repositoryPath: repositoryDir,
      agentSettings: { model: 'test-model', reasoningEffort: 'high' }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/review-start-failure',
      worktreePath: repositoryDir,
      baseSha: 'base'
    });
    const implementation = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      settings: task.agentSettings
    });
    await terminal(store, implementation, 'AGENT_RUN_COMPLETED');
    adapter.reviewStartFailure = 'provider review failed to start';

    await expect(
      orchestrator.startReview({
        task,
        iteration,
        worktree,
        sourceRun: (await store.getRun(implementation.id))!,
        target: { type: 'UNCOMMITTED_CHANGES' },
        settings: { ...task.agentSettings, sandbox: 'READ_ONLY' }
      })
    ).rejects.toThrow('provider review failed to start');

    const snapshot = await store.snapshot();
    const failedReview = snapshot.runs.find((run) => run.mode === 'REVIEW')!;
    expect(failedReview).toMatchObject({
      status: 'FAILED',
      terminalReason: 'provider review failed to start'
    });
    expect(failedReview.finalArtifactId).toBeTruthy();
    expect(snapshot.tasks[0]?.projection.codexReview).toMatchObject({
      status: 'FAILED',
      runId: failedReview.id,
      finalArtifactId: failedReview.finalArtifactId,
      summary: 'provider review failed to start'
    });
    const failureEvent = snapshot.events.find(
      (event) => event.runId === failedReview.id && event.type === 'AGENT_RUN_FAILED'
    );
    const artifactEvent = snapshot.events.find(
      (event) => event.runId === failedReview.id && event.type === 'ARTIFACT_CREATED'
    );
    expect(failureEvent?.payload).toEqual({
      error: 'provider review failed to start'
    });
    expect(snapshot.events.indexOf(failureEvent!)).toBeLessThan(
      snapshot.events.indexOf(artifactEvent!)
    );
    await expect(store.readArtifact(failedReview.finalArtifactId!)).resolves.toContain(
      'provider review failed to start'
    );
  });

  it('preserves the provider startup error when supplementary artifact creation fails', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-start-failure-artifact-')
    );
    const repositoryDir = path.join(dir, 'repository');
    await fs.mkdir(repositoryDir);
    const store = new FileTaskStore(path.join(dir, 'store'));
    const adapter = new Phase4Adapter(store);
    adapter.startFailure = 'provider startup failed';
    const appEvents = new AppEventBus();
    const terminalEvents: unknown[] = [];
    appEvents.on((event) => {
      if (event.type === 'run.terminal') terminalEvents.push(event);
    });
    const orchestrator = new AgentOrchestrator(store, appEvents, adapter);
    const task = await store.createTask({
      title: 'Startup artifact failure',
      prompt: 'Preserve the original provider error.',
      repositoryPath: repositoryDir,
      agentSettings: { model: 'test-model', reasoningEffort: 'high' }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/start-failure-artifact',
      worktreePath: repositoryDir,
      baseSha: 'base'
    });
    vi.spyOn(store, 'writeFinalArtifact').mockRejectedValueOnce(
      new Error('final artifact storage unavailable')
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
    ).rejects.toThrow('provider startup failed');

    const snapshot = await store.snapshot();
    const failedRun = snapshot.runs[0]!;
    expect(failedRun).toMatchObject({
      status: 'FAILED',
      terminalReason: 'provider startup failed'
    });
    expect(failedRun.finalArtifactId).toBeUndefined();
    expect(
      snapshot.artifacts.filter(
        (artifact) => artifact.runId === failedRun.id && artifact.kind === 'agent-final'
      )
    ).toEqual([]);
    expect(terminalEvents).toEqual([
      expect.objectContaining({
        runId: failedRun.id,
        payload: { status: 'failed', error: 'provider startup failed' }
      })
    ]);
    await expect(store.readArtifact(failedRun.diagnosticArtifactId)).resolves.toContain(
      'final artifact storage unavailable'
    );
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
      runtimeId: 'codex',
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
      runtimeId: 'codex',
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
      runtimeId: 'codex',
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

  it('rejects an unattested runtime before browser development can resolve provider state', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-runtime-boundary-'));
    const repositoryDir = path.join(dir, 'repository');
    await fs.mkdir(repositoryDir);
    const store = new FileTaskStore(path.join(dir, 'store'));
    const adapter = new Phase4Adapter(store);
    Object.defineProperty(adapter, 'descriptor', {
      value: OPENCODE_RUNTIME_DESCRIPTOR
    });
    vi.spyOn(adapter, 'capabilities').mockResolvedValue(opencodeCapabilities());
    const resolveExecution = vi.spyOn(adapter, 'resolveExecution');
    const orchestrator = new AgentOrchestrator(store, new AppEventBus(), adapter, {
      allowNetworkAccess: false
    });
    const task = await store.createTask({
      runtimeId: 'opencode',
      title: 'Reject unattested runtime',
      prompt: 'Do not probe the provider.',
      repositoryPath: repositoryDir,
      agentSettings: {
        runtimeId: 'opencode',
        sandbox: 'WORKSPACE_WRITE',
        networkAccess: false,
        approvalPolicy: 'never',
        approvalsReviewer: 'user'
      }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'task-monki/runtime-boundary',
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
    ).rejects.toThrow('browser development');
    expect(resolveExecution).not.toHaveBeenCalled();
    expect((await store.snapshot()).runs).toEqual([]);
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
    expect((await store.snapshot()).runs).toEqual([
      expect.objectContaining({ status: 'FAILED' })
    ]);
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
      runtimeId: 'codex',
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
      'Runtime recovery reported unsafe observed settings'
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
      runtimeId: 'codex',
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
        runtimeId: 'codex',
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
          runtimeId: 'codex',
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
      runtimeId: 'codex',
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
  }, 20_000);

  it('rejects unexpected provider approval acceptance in browser-dev mode', async () => {
    const getInteractionRequest = vi.fn().mockResolvedValue({
      id: 'interaction-one',
      taskId: 'task-one',
      runId: 'run-one',
      runtimeId: 'codex',
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

class Phase4Adapter implements AgentRuntimeAdapter {
  readonly descriptor = CODEX_RUNTIME_DESCRIPTOR;
  ambiguousStart = false;
  recoveryThenRejectStart = false;
  startFailure?: string;
  reviewStartFailure?: string;
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
      runtime: this.descriptor,
      readiness: createRuntimeReadiness('READY', 'Test runtime is ready.'),
      capabilities: phase4Capabilities(),
    });
  }

  capabilities(): Promise<AgentRuntimeCapabilities> {
    return Promise.resolve(phase4Capabilities());
  }

  listModels(): Promise<AgentModel[]> {
    return Promise.resolve([
      {
        id: 'codex:openai/test-model',
        runtimeId: 'codex',
        modelProvider: 'openai',
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

  async resolveExecution(input: ResolveAgentExecution): Promise<ResolvedAgentExecution> {
    const model = (await this.listModels())[0]!;
    assertModelSupportsAttachments(model, input.attachments);
    return {
      model,
      settings: {
        ...input.settings,
        runtimeId: this.descriptor.id,
        model: model.model,
        modelProvider: model.modelProvider,
        reasoningEffort: input.settings.reasoningEffort ?? model.defaultReasoningEffort
      }
    };
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
    if (this.startFailure) {
      throw new Error(this.startFailure);
    }
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
    if (this.recoveryThenRejectStart) {
      const run = await this.store.getRun(input.localRunId);
      if (!run) throw new Error('Run not found.');
      await this.store.appendEvent(
        createDomainEvent({
          type: 'AGENT_MUTATION_AMBIGUOUS',
          taskId: run.taskId,
          iterationId: run.iterationId,
          runId: run.id,
          worktreeId: run.worktreeId,
          agentSessionId: run.sessionId,
          source: 'provider',
          payload: {
            operation: 'turn/start',
            reason: 'Provider established recovery before rejecting startup.',
            automaticResubmission: false
          }
        })
      );
      throw new Error('provider failed after publishing recovery');
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

  forkSession(_input: ForkAgentSession): Promise<AgentSessionRecord> {
    return Promise.reject(new Error('Session fork is not exercised by this fake.'));
  }

  syncGoal(_input: SyncAgentGoal): ReturnType<NonNullable<AgentRuntimeAdapter['syncGoal']>> {
    return Promise.reject(new Error('Goal sync is not exercised by this fake.'));
  }

  async startReview(input: StartAgentReview): Promise<AgentTurn> {
    if (this.reviewStartFailure) {
      throw new Error(this.reviewStartFailure);
    }
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

function phase4Capabilities(): AgentRuntimeCapabilities {
  return {
    ...codexCapabilities(),
    promptRefinement: {
      maturity: 'unsupported',
      detail: 'The phase-four test adapter does not implement prompt refinement.'
    }
  };
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
