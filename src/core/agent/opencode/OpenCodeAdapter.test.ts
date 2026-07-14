import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentExecutionSettings,
  AgentProtocolMessageReference,
  AgentServerInstance,
  AgentSessionRecord,
  AppUpdateEvent,
  RunRecord,
  Task,
  TaskIteration,
  WorktreeRecord
} from '../../../shared/contracts';
import { AppEventBus } from '../../runner/AppEventBus';
import { createDomainEvent } from '../../storage/domainEvent';
import { FileTaskStore } from '../../storage/FileTaskStore';
import { AgentMutationAmbiguousError } from '../AgentRuntimeAdapter';
import { OpenCodeAdapter, type OpenCodeAdapterOptions } from './OpenCodeAdapter';
import type {
  OpenCodeClientTransport,
  OpenCodeEventStreamHandlers,
  OpenCodeHttpResult
} from './OpenCodeHttpClient';
import type { OpenCodeMessage, OpenCodeSession } from './OpenCodeProtocol';
import type {
  OpenCodeServerSupervisorOptions,
  OpenCodeSessionSupervisor,
  OpenCodeSupervisorEvents,
  RunningOpenCodeServer
} from './OpenCodeServerSupervisor';
import type { ResolvedOpenCodeRuntime } from './OpenCodeRuntimeResolver';

const SETTINGS: AgentExecutionSettings = {
  runtimeId: 'opencode',
  model: 'claude-test',
  modelProvider: 'anthropic',
  reasoningEffort: 'high',
  sandbox: 'WORKSPACE_WRITE',
  approvalPolicy: 'on-request',
  networkAccess: true
};

describe('OpenCodeAdapter', () => {
  it('owns one runtime per session and durably maps turns, interactions, output, and shutdown', async () => {
    const fixture = await createFixture();
    const { adapter, harness, store } = fixture;
    await adapter.initialize();
    expect((await adapter.preflight()).ready).toBe(true);

    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    const turn = await adapter.startTurn({
      localRunId: run.id,
      session: { localSessionId: session.id, providerSessionId: session.providerSessionId },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });

    const running = (await store.getRun(run.id))!;
    expect(turn.providerTurnId).toMatch(/^msg_taskmonki_/);
    expect(running.status).toBe('RUNNING');
    expect(running.serverInstanceId).toBe(harness.sessionSupervisor.currentServer?.id);
    expect(running.serverInstanceId).not.toBe(harness.catalogSupervisor.currentServer?.id);
    expect(harness.promptBodies).toEqual([
      expect.objectContaining({
        messageID: turn.providerTurnId,
        model: { providerID: 'anthropic', modelID: 'claude-test' },
        variant: 'high'
      })
    ]);

    harness.permissions = [
      {
        id: 'per_1',
        sessionID: session.providerSessionId!,
        action: 'bash',
        resources: ['npm test'],
        metadata: { cwd: fixture.worktree.worktreePath }
      }
    ];
    harness.questions = [
      {
        id: 'que_1',
        sessionID: session.providerSessionId!,
        questions: [
          {
            header: 'Scope',
            question: 'Which path?',
            options: [{ label: 'Core', description: 'Only core' }]
          }
        ]
      }
    ];
    await adapter.attachSession({
      localSessionId: session.id,
      providerSessionId: session.providerSessionId
    });
    const pending = (await store.snapshot()).interactionRequests;
    expect(pending.map((item) => item.type).sort()).toEqual([
      'COMMAND_APPROVAL',
      'USER_INPUT'
    ]);
    const permission = pending.find((item) => item.type === 'COMMAND_APPROVAL')!;
    const decision = { interactionType: 'COMMAND_APPROVAL', action: 'ACCEPT' } as const;
    await store.transitionInteractionRequest(permission.id, 'PENDING', {
      status: 'RESPONDING',
      decision,
      respondedAt: new Date().toISOString()
    });
    await adapter.respondToInteraction({ interaction: permission, decision });
    expect((await store.getInteractionRequest(permission.id))?.status).toBe('RESOLVED');
    expect(harness.permissionReplies).toEqual([{ reply: 'once' }]);

    const assistant: OpenCodeMessage = {
      info: {
        id: 'msg_assistant_1',
        sessionID: session.providerSessionId!,
        role: 'assistant',
        parentID: turn.providerTurnId,
        providerID: 'anthropic',
        modelID: 'claude-test',
        finish: 'stop',
        time: { created: Date.now() - 10, completed: Date.now() },
        tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 1, write: 0 } }
      },
      parts: [
        {
          id: 'prt_text_1',
          sessionID: session.providerSessionId!,
          messageID: 'msg_assistant_1',
          type: 'text',
          text: 'Implemented and verified.'
        }
      ]
    };
    harness.messages.set(session.providerSessionId!, [
      {
        info: {
          id: turn.providerTurnId!,
          sessionID: session.providerSessionId!,
          role: 'user',
          time: { created: Date.now() - 20 }
        },
        parts: []
      },
      assistant
    ]);
    harness.statuses[session.providerSessionId!] = { type: 'idle' };
    await harness.emit({
      id: 'evt_part',
      type: 'message.part.updated',
      properties: { part: assistant.parts[0], delta: 'Implemented and verified.' }
    });
    await harness.emit({
      id: 'evt_idle',
      type: 'session.idle',
      properties: { sessionID: session.providerSessionId }
    });

    const completed = (await store.getRun(run.id))!;
    expect(completed.status).toBe('COMPLETED');
    expect(completed.finalMessage).toBe('Implemented and verified.');
    expect((await store.getAgentItemsForRun(run.id))[0]).toEqual(
      expect.objectContaining({ providerItemId: 'prt_text_1', status: 'COMPLETED' })
    );
    expect(
      (await store.snapshot()).interactionRequests.find((item) => item.type === 'USER_INPUT')?.status
    ).toBe('STALE');

    await adapter.shutdown();
    expect(harness.catalogSupervisor.shutdownCount).toBe(1);
    expect(harness.sessionSupervisor.shutdownCount).toBe(1);
    expect(harness.stoppedStreams).toBe(1);
  });

  it('never resends an accepted prompt when post-ack persistence fails and reconciles by message id', async () => {
    const fixture = await createFixture();
    const { adapter, harness, store } = fixture;
    await adapter.initialize();
    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    const originalUpdateRun = store.updateRun.bind(store);
    let failedAcknowledgementWrite = false;
    store.updateRun = async (runId, update) => {
      if (
        harness.promptBodies.length === 1 &&
        update.status === 'RUNNING' &&
        !failedAcknowledgementWrite
      ) {
        failedAcknowledgementWrite = true;
        throw new Error('simulated durable store failure');
      }
      return originalUpdateRun(runId, update);
    };

    await expect(
      adapter.startTurn({
        localRunId: run.id,
        session: { localSessionId: session.id, providerSessionId: session.providerSessionId },
        mode: 'IMPLEMENTATION',
        prompt: fixture.task.prompt,
        authoritativeGoal: fixture.task.prompt,
        settings: SETTINGS
      })
    ).rejects.toBeInstanceOf(AgentMutationAmbiguousError);
    expect(harness.promptBodies).toHaveLength(1);
    const providerMessageId = (await store.getRun(run.id))?.providerTurnId;
    expect(providerMessageId).toMatch(/^msg_taskmonki_/);

    store.updateRun = originalUpdateRun;
    await store.appendEvent(
      createDomainEvent({
        type: 'AGENT_MUTATION_AMBIGUOUS',
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        agentSessionId: run.sessionId,
        source: 'provider',
        payload: {
          operation: 'session/prompt_async',
          reason: 'acknowledgement persistence failed',
          automaticResubmission: false
        }
      })
    );
    harness.messages.set(session.providerSessionId!, [
      {
        info: {
          id: providerMessageId!,
          sessionID: session.providerSessionId!,
          role: 'user',
          time: { created: Date.now() - 10 }
        },
        parts: []
      },
      {
        info: {
          id: 'msg_assistant_recovered',
          sessionID: session.providerSessionId!,
          role: 'assistant',
          parentID: providerMessageId,
          finish: 'stop',
          time: { completed: Date.now() }
        },
        parts: [
          {
            id: 'prt_recovered',
            sessionID: session.providerSessionId!,
            messageID: 'msg_assistant_recovered',
            type: 'text',
            text: 'Recovered without resubmission.'
          }
        ]
      }
    ]);
    harness.statuses[session.providerSessionId!] = { type: 'idle' };

    const reconciled = await adapter.reconcile();

    expect(reconciled.reconciledSessionIds).toContain(session.id);
    expect((await store.getRun(run.id))?.status).toBe('COMPLETED');
    expect(harness.promptBodies).toHaveLength(1);
    await adapter.shutdown();
  });

  it('coalesces high-volume text deltas while preserving ordered output and a terminal item', async () => {
    const fixture = await createFixture();
    const { adapter, harness, store, appEvents } = fixture;
    const updates: AppUpdateEvent[] = [];
    const unsubscribe = appEvents.on((event) => updates.push(event));
    await adapter.initialize();
    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    const turn = await adapter.startTurn({
      localRunId: run.id,
      session: { localSessionId: session.id, providerSessionId: session.providerSessionId },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });
    const upsert = vi.spyOn(store, 'upsertAgentItem');

    for (let index = 1; index <= 100; index += 1) {
      await harness.emit({
        id: `evt_delta_${index}`,
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_stream',
            sessionID: session.providerSessionId,
            messageID: 'msg_assistant_stream',
            type: 'text',
            text: 'x'.repeat(index)
          },
          delta: 'x'
        }
      });
    }
    expect(upsert).not.toHaveBeenCalled();

    harness.messages.set(session.providerSessionId!, [
      {
        info: {
          id: turn.providerTurnId!,
          sessionID: session.providerSessionId!,
          role: 'user',
          time: { created: Date.now() - 10 }
        },
        parts: []
      },
      {
        info: {
          id: 'msg_assistant_stream',
          sessionID: session.providerSessionId!,
          role: 'assistant',
          parentID: turn.providerTurnId,
          finish: 'stop',
          time: { completed: Date.now() }
        },
        parts: [
          {
            id: 'prt_stream',
            sessionID: session.providerSessionId!,
            messageID: 'msg_assistant_stream',
            type: 'text',
            text: 'x'.repeat(100)
          }
        ]
      }
    ]);
    harness.statuses[session.providerSessionId!] = { type: 'idle' };
    await harness.emit({
      id: 'evt_stream_idle',
      type: 'session.idle',
      properties: { sessionID: session.providerSessionId }
    });

    expect(upsert).toHaveBeenCalledTimes(1);
    expect((await store.getAgentItemsForRun(run.id))[0]).toEqual(
      expect.objectContaining({ providerItemId: 'prt_stream', status: 'COMPLETED' })
    );
    const output = await store.readArtifact(run.outputArtifactId);
    expect(output.replaceAll('\n[text]\n', '')).toBe('x'.repeat(100));
    const outputUpdates = updates.filter(
      (event) => event.type === 'run.output' && event.runId === run.id
    );
    expect(outputUpdates.length).toBeLessThan(20);
    expect(
      outputUpdates.map((event) => (event.payload as { text: string }).text).join('')
    ).toBe('x'.repeat(100));
    upsert.mockRestore();
    unsubscribe();
    await adapter.shutdown();
  });

  it('debounces native provider catalog changes and refreshes the renderer', async () => {
    const fixture = await createFixture();
    const updates: AppUpdateEvent[] = [];
    const unsubscribe = fixture.appEvents.on((event) => updates.push(event));
    await fixture.adapter.initialize();
    await materializeSession(fixture);
    const baselineGets = fixture.harness.providerGetCount;

    await fixture.harness.emit({ type: 'models-dev.refreshed', properties: {} });
    await fixture.harness.emit({ type: 'provider.updated', properties: {} });
    await fixture.harness.emit({ type: 'config.updated', properties: {} });
    await wait(350);

    expect(fixture.harness.providerGetCount).toBe(baselineGets + 1);
    expect(updates.filter((event) => event.type === 'runtime.updated')).toHaveLength(1);
    unsubscribe();
    await fixture.adapter.shutdown();
  });

  it('publishes reconciliation, protocol-incident, and runtime-loss refresh events', async () => {
    const fixture = await createFixture();
    const updates: AppUpdateEvent[] = [];
    const unsubscribe = fixture.appEvents.on((event) => updates.push(event));
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    await fixture.adapter.startTurn({
      localRunId: run.id,
      session: { localSessionId: session.id, providerSessionId: session.providerSessionId },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });

    await fixture.adapter.reconcile();
    await fixture.harness.emit({ incompatible: true });
    await fixture.harness.sessionSupervisor.lose();
    await waitForCondition(() =>
      updates.some(
        (event) =>
          event.type === 'run.activity' &&
          (event.payload as { eventType?: string }).eventType === 'runtime/lost'
      )
    );

    const activityTypes = updates
      .filter((event) => event.type === 'run.activity' && event.runId === run.id)
      .map((event) => (event.payload as { eventType?: string }).eventType);
    expect(activityTypes).toContain('runtime/reconciled');
    expect(activityTypes).toContain('runtime/protocol-incident');
    expect(activityTypes).toContain('runtime/lost');
    unsubscribe();
    await fixture.adapter.shutdown();
  });

  it('selects from the worktree catalog and rejects an explicitly stale project model', async () => {
    const fixture = await createFixture();
    fixture.harness.catalogs.set(path.resolve(fixture.worktree.worktreePath), {
      connected: ['anthropic', 'xai'],
      default: { anthropic: 'claude-test', xai: 'grok-code' },
      all: [
        ...(defaultProviderCatalog() as { all: unknown[] }).all,
        {
          id: 'xai',
          name: 'xAI',
          models: {
            'grok-code': {
              id: 'grok-code',
              name: 'Grok Code',
              status: 'active',
              capabilities: { input: { text: true } },
              variants: { fast: {} }
            }
          }
        }
      ]
    });
    await fixture.adapter.initialize();
    expect((await fixture.adapter.listModels()).map((model) => model.model)).not.toContain('grok-code');
    const session = await fixture.store.createAgentSession({
      task: fixture.task,
      iteration: fixture.iteration,
      worktree: fixture.worktree,
      runtimeId: 'opencode',
      requestedSettings: SETTINGS
    });
    const run = await createRun(fixture, session);
    const projectSettings: AgentExecutionSettings = {
      ...SETTINGS,
      modelProvider: 'xai',
      model: 'grok-code',
      reasoningEffort: 'fast'
    };
    const deferred = await fixture.adapter.resolveExecution({
      settings: projectSettings,
      attachments: []
    });
    expect(deferred.model.native).toEqual({
      discovery: 'deferred-to-worktree-catalog'
    });

    await fixture.adapter.startTurn({
      localRunId: run.id,
      session: { localSessionId: session.id },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: projectSettings
    });
    expect(fixture.harness.promptBodies.at(-1)).toEqual(
      expect.objectContaining({
        model: { providerID: 'xai', modelID: 'grok-code' },
        variant: 'fast'
      })
    );

    const staleSession = await fixture.store.createAgentSession({
      task: fixture.task,
      iteration: fixture.iteration,
      worktree: fixture.worktree,
      runtimeId: 'opencode',
      requestedSettings: SETTINGS
    });
    const staleRun = await createRun(fixture, staleSession);
    await expect(
      fixture.adapter.startTurn({
        localRunId: staleRun.id,
        session: { localSessionId: staleSession.id },
        mode: 'IMPLEMENTATION',
        prompt: fixture.task.prompt,
        authoritativeGoal: fixture.task.prompt,
        settings: { ...SETTINGS, modelProvider: 'xai', model: 'removed-model' }
      })
    ).rejects.toThrow('worktree catalog');
    expect(fixture.harness.promptBodies).toHaveLength(1);
    await fixture.adapter.shutdown();
  });

  it('evicts idle session runtimes, lazily reattaches, and never evicts an active run', async () => {
    const fixture = await createFixture({ sessionIdleTimeoutMs: 20 });
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    await fixture.adapter.startTurn({
      localRunId: run.id,
      session: { localSessionId: session.id, providerSessionId: session.providerSessionId },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });
    const firstSupervisor = fixture.harness.sessionSupervisor;

    await fixture.harness.emit({
      type: 'session.idle',
      properties: { sessionID: session.providerSessionId }
    });
    await wait(60);
    expect(firstSupervisor.shutdownCount).toBe(0);

    const providerMessageId = (await fixture.store.getRun(run.id))!.providerTurnId!;
    fixture.harness.messages.set(session.providerSessionId!, [
      {
        info: {
          id: providerMessageId,
          sessionID: session.providerSessionId!,
          role: 'user',
          time: { created: Date.now() - 10 }
        },
        parts: []
      },
      {
        info: {
          id: 'msg_idle_terminal',
          sessionID: session.providerSessionId!,
          role: 'assistant',
          parentID: providerMessageId,
          finish: 'stop',
          time: { completed: Date.now() }
        },
        parts: []
      }
    ]);
    fixture.harness.statuses[session.providerSessionId!] = { type: 'idle' };
    await fixture.harness.emit({
      type: 'session.idle',
      properties: { sessionID: session.providerSessionId }
    });
    await wait(60);
    expect(firstSupervisor.shutdownCount).toBe(1);
    expect(fixture.harness.stoppedStreams).toBe(1);

    const continuedSession = (await fixture.store.getAgentSession(session.id))!;
    const nextRun = await createRun(fixture, continuedSession);
    await fixture.adapter.startTurn({
      localRunId: nextRun.id,
      session: { localSessionId: session.id, providerSessionId: session.providerSessionId },
      mode: 'IMPLEMENTATION',
      prompt: 'Continue the same conversation.',
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });
    expect(fixture.harness.sessionSupervisor).not.toBe(firstSupervisor);
    expect(fixture.harness.sessions.size).toBe(1);
    expect(fixture.harness.promptBodies).toHaveLength(2);
    await fixture.adapter.shutdown();
  });

  it('releases inactive task runtimes without deleting provider conversations', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const supervisor = fixture.harness.sessionSupervisor;

    await fixture.adapter.releaseTask(fixture.task.id);

    expect(supervisor.shutdownCount).toBe(1);
    expect(fixture.harness.stoppedStreams).toBe(1);
    expect(fixture.harness.sessions.has(session.providerSessionId!)).toBe(true);
    expect((await fixture.store.getAgentSession(session.id))?.status).toBe('NOT_LOADED');
    await fixture.adapter.shutdown();
  });

  it('forks native history in the target worktree request context', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    const source = await materializeSession(fixture);
    const targetWorktreePath = path.join(fixture.root, 'alternative-worktree');
    await fs.mkdir(targetWorktreePath, { recursive: true });
    const targetTask = await fixture.store.createTask({
      runtimeId: 'opencode',
      title: 'OpenCode target alternative',
      prompt: fixture.task.prompt,
      repositoryPath: fixture.task.repositoryPath,
      agentSettings: SETTINGS
    });
    const targetOwnership = await fixture.store.createIterationAndWorktree({
      task: targetTask,
      branchName: 'codex/opencode-target-alternative',
      worktreePath: targetWorktreePath,
      baseSha: 'base-sha'
    });
    const target = await fixture.store.createAgentSession({
      task: targetTask,
      iteration: targetOwnership.iteration,
      worktree: targetOwnership.worktree,
      runtimeId: 'opencode',
      requestedSettings: SETTINGS,
      forkedFromSessionId: source.id
    });

    const forked = await fixture.adapter.forkSession({
      sourceSession: {
        localSessionId: source.id,
        providerSessionId: source.providerSessionId
      },
      localSessionId: target.id,
      settings: SETTINGS
    });

    expect(fixture.harness.forkRequests).toEqual([
      {
        sourceSessionId: source.providerSessionId,
        directory: path.resolve(targetWorktreePath)
      }
    ]);
    expect(forked.worktreePath).toBe(targetWorktreePath);
    expect(forked.providerForkedFromSessionId).toBe(source.providerSessionId);
    expect(forked.providerParentSessionId).toBeUndefined();
    expect(forked.providerSessionId).not.toBe(source.providerSessionId);
    expect(
      fixture.harness.sessions.get(forked.providerSessionId!)?.directory
    ).toBe(targetWorktreePath);
    await fixture.adapter.shutdown();
  });

  it('never repeats a provider-accepted fork when ownership persistence fails', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    const source = await materializeSession(fixture);
    const target = await fixture.store.createAgentSession({
      task: fixture.task,
      iteration: fixture.iteration,
      worktree: fixture.worktree,
      runtimeId: 'opencode',
      role: 'ALTERNATIVE',
      requestedSettings: SETTINGS,
      forkedFromSessionId: source.id
    });
    const originalUpdate = fixture.store.updateAgentSession.bind(fixture.store);
    fixture.store.updateAgentSession = async (sessionId, update) => {
      if (sessionId === target.id && update.providerSessionId) {
        throw new Error('simulated durable fork ownership failure');
      }
      return originalUpdate(sessionId, update);
    };

    await expect(
      fixture.adapter.forkSession({
        sourceSession: {
          localSessionId: source.id,
          providerSessionId: source.providerSessionId
        },
        localSessionId: target.id,
        settings: SETTINGS
      })
    ).rejects.toMatchObject({
      name: 'AgentMutationAmbiguousError',
      operation: 'session/fork'
    });
    expect(fixture.harness.forkRequests).toHaveLength(1);
    fixture.store.updateAgentSession = originalUpdate;
    await fixture.adapter.shutdown();
  });

  it('marks post-ack interaction persistence failure ambiguous and never retries the reply', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    await fixture.adapter.startTurn({
      localRunId: run.id,
      session: { localSessionId: session.id, providerSessionId: session.providerSessionId },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });
    await fixture.harness.emit({
      type: 'permission.asked',
      properties: {
        id: 'per_ambiguous',
        sessionID: session.providerSessionId,
        action: 'bash',
        resources: ['npm test']
      }
    });
    const interaction = (await fixture.store.snapshot()).interactionRequests[0];
    const decision = { interactionType: 'COMMAND_APPROVAL', action: 'ACCEPT' } as const;
    await fixture.store.transitionInteractionRequest(interaction.id, 'PENDING', {
      status: 'RESPONDING',
      decision,
      respondedAt: new Date().toISOString()
    });
    const originalTransition = fixture.store.transitionInteractionRequest.bind(fixture.store);
    fixture.store.transitionInteractionRequest = async (...args) => {
      if (fixture.harness.permissionReplies.length === 1) {
        throw new Error('simulated durable response failure');
      }
      return originalTransition(...args);
    };

    await expect(
      fixture.adapter.respondToInteraction({ interaction, decision })
    ).rejects.toBeInstanceOf(AgentMutationAmbiguousError);
    expect(fixture.harness.permissionReplies).toHaveLength(1);
    fixture.store.transitionInteractionRequest = originalTransition;
    await fixture.adapter.shutdown();
  });

  it('retries initialization after the runtime becomes available', async () => {
    let attempts = 0;
    const fixture = await createFixture({
      runtimeResolver: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('OpenCode is not installed.');
        return fakeRuntime();
      }
    });

    await expect(fixture.adapter.initialize()).rejects.toThrow('not installed');
    expect((await fixture.adapter.preflight()).ready).toBe(false);
    await fixture.adapter.initialize();

    expect(attempts).toBe(2);
    expect((await fixture.adapter.preflight()).ready).toBe(true);
    await fixture.adapter.shutdown();
  });

  it('repairs an unavailable runtime with a configured executable path', async () => {
    let available = false;
    const observedExecutables: Array<string | undefined> = [];
    const fixture = await createFixture({
      runtimeResolver: async (resolverOptions) => {
        observedExecutables.push(resolverOptions.executable);
        if (!available) throw new Error('configured OpenCode executable is unavailable');
        const runtime = fakeRuntime();
        return {
          ...runtime,
          executable: resolverOptions.executable ?? runtime.executable,
          diagnostics: {
            ...runtime.diagnostics,
            selectedExecutable: resolverOptions.executable ?? runtime.executable
          }
        };
      }
    });
    await expect(fixture.adapter.initialize()).rejects.toThrow('unavailable');

    available = true;
    await fixture.adapter.configureRuntime({
      executable: '/custom/bin/opencode',
      restart: true
    });

    expect(observedExecutables).toEqual(['/fake/opencode', '/custom/bin/opencode']);
    expect((await fixture.adapter.preflight()).ready).toBe(true);
    expect(fixture.harness.catalogSupervisor.currentServer?.executable).toBe(
      '/custom/bin/opencode'
    );
    await fixture.adapter.shutdown();
  });

  it('defers executable replacement until active provider work is terminal', async () => {
    const fixture = await createFixture({
      runtimeResolver: async (resolverOptions) => {
        const runtime = fakeRuntime();
        return { ...runtime, executable: resolverOptions.executable ?? runtime.executable };
      }
    });
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    const turn = await fixture.adapter.startTurn({
      localRunId: run.id,
      session: { localSessionId: session.id, providerSessionId: session.providerSessionId },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });
    const activeSupervisor = fixture.harness.sessionSupervisor;

    await fixture.adapter.configureRuntime({
      executable: '/custom/bin/opencode-next',
      restart: false
    });

    expect(activeSupervisor.shutdownCount).toBe(0);
    expect((await fixture.adapter.preflight()).warnings.join(' ')).toContain(
      'will be applied after active provider work'
    );

    fixture.harness.messages.set(session.providerSessionId!, [
      {
        info: {
          id: turn.providerTurnId!,
          sessionID: session.providerSessionId!,
          role: 'user',
          time: { created: Date.now() - 10 }
        },
        parts: []
      },
      {
        info: {
          id: 'msg_config_terminal',
          sessionID: session.providerSessionId!,
          role: 'assistant',
          parentID: turn.providerTurnId,
          finish: 'stop',
          time: { completed: Date.now() }
        },
        parts: []
      }
    ]);
    fixture.harness.statuses[session.providerSessionId!] = { type: 'idle' };
    await fixture.harness.emit({
      type: 'session.idle',
      properties: { sessionID: session.providerSessionId }
    });
    await waitForCondition(async () =>
      fixture.harness.supervisors.at(-1)?.currentServer?.executable ===
        '/custom/bin/opencode-next' && (await fixture.adapter.preflight()).ready
    );

    expect(activeSupervisor.shutdownCount).toBe(1);
    expect(fixture.harness.supervisors.at(-1)?.currentServer?.executable).toBe(
      '/custom/bin/opencode-next'
    );
    expect((await fixture.adapter.preflight()).ready).toBe(true);
    await fixture.adapter.shutdown();
  });

  it('applies a pending executable before the next start after lost work is explicitly closed', async () => {
    const observedExecutables: Array<string | undefined> = [];
    const fixture = await createFixture({
      runtimeResolver: async (resolverOptions) => {
        observedExecutables.push(resolverOptions.executable);
        const runtime = fakeRuntime();
        return { ...runtime, executable: resolverOptions.executable ?? runtime.executable };
      }
    });
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const lostRun = await createRun(fixture, session);
    await fixture.adapter.startTurn({
      localRunId: lostRun.id,
      session: { localSessionId: session.id, providerSessionId: session.providerSessionId },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });
    const lostSupervisor = fixture.harness.sessionSupervisor;

    await fixture.adapter.configureRuntime({
      executable: '/custom/bin/opencode-after-loss',
      restart: false
    });
    await lostSupervisor.lose();
    await waitForCondition(
      async () => (await fixture.store.getRun(lostRun.id))?.status === 'RECOVERY_REQUIRED'
    );
    await fixture.adapter.resolveExecution({ settings: SETTINGS, attachments: [] });
    expect(observedExecutables).toEqual(['/fake/opencode']);

    const finalArtifact = await fixture.store.writeFinalArtifact(
      lostRun.taskId,
      lostRun.id,
      '# Recovery run closed\n\nExplicitly abandoned for replacement.\n'
    );
    await fixture.store.appendEvent(
      createDomainEvent({
        type: 'AGENT_RUN_INTERRUPTED',
        taskId: lostRun.taskId,
        iterationId: lostRun.iterationId,
        runId: lostRun.id,
        worktreeId: lostRun.worktreeId,
        agentSessionId: lostRun.sessionId,
        serverInstanceId: lostRun.serverInstanceId,
        source: 'ui',
        payload: {
          terminalReason: 'Recovery-required run was explicitly abandoned.',
          finalArtifactId: finalArtifact.id
        }
      })
    );
    const continuedSession = (await fixture.store.getAgentSession(session.id))!;
    const nextRun = await createRun(fixture, continuedSession);

    await fixture.adapter.startTurn({
      localRunId: nextRun.id,
      session: { localSessionId: session.id, providerSessionId: session.providerSessionId },
      mode: 'RETRY',
      prompt: 'Start only the explicit replacement turn.',
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });

    expect(observedExecutables).toEqual([
      '/fake/opencode',
      '/custom/bin/opencode-after-loss'
    ]);
    expect(fixture.harness.sessionSupervisor.currentServer?.executable).toBe(
      '/custom/bin/opencode-after-loss'
    );
    expect(fixture.harness.promptBodies).toHaveLength(2);
    expect(lostSupervisor.shutdownCount).toBe(0);
    await fixture.adapter.shutdown();
  });

  it('rejects managed attachments before starting or mutating OpenCode state', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    await expect(
      fixture.adapter.resolveExecution({
        settings: SETTINGS,
        attachments: [{ kind: 'image' }]
      })
    ).rejects.toThrow('managed attachments are unavailable');
    const session = await fixture.store.createAgentSession({
      task: fixture.task,
      iteration: fixture.iteration,
      worktree: fixture.worktree,
      runtimeId: 'opencode',
      requestedSettings: SETTINGS
    });
    const run = await createRun(fixture, session);
    await expect(
      fixture.adapter.startTurn({
        localRunId: run.id,
        session: { localSessionId: session.id },
        mode: 'IMPLEMENTATION',
        prompt: fixture.task.prompt,
        authoritativeGoal: fixture.task.prompt,
        settings: SETTINGS,
        attachments: [
          {
            attachmentId: 'att_1',
            ordinal: 0,
            displayName: 'secret.png',
            kind: 'image',
            mediaType: 'image/png',
            byteCount: 1,
            sha256: '0'.repeat(64),
            path: path.join(fixture.root, 'secret.png'),
            verifiedAt: new Date().toISOString()
          }
        ]
      })
    ).rejects.toThrow('managed attachments are unavailable');
    expect(fixture.harness.supervisors).toHaveLength(1);
    expect(fixture.harness.promptBodies).toHaveLength(0);
    await fixture.adapter.shutdown();
  });
});

interface AdapterFixture {
  root: string;
  appCwd: string;
  store: FileTaskStore;
  adapter: OpenCodeAdapter;
  appEvents: AppEventBus;
  harness: FakeOpenCodeHarness;
  task: Task;
  iteration: TaskIteration;
  worktree: WorktreeRecord;
}

interface AdapterFixtureOptions {
  sessionIdleTimeoutMs?: number;
  runtimeResolver?: OpenCodeAdapterOptions['runtimeResolver'];
}

async function createFixture(options: AdapterFixtureOptions = {}): Promise<AdapterFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-opencode-adapter-'));
  const appCwd = path.join(root, 'app');
  const worktreePath = path.join(root, 'worktree');
  await fs.mkdir(appCwd, { recursive: true });
  await fs.mkdir(worktreePath, { recursive: true });
  const store = new FileTaskStore(path.join(root, 'store'));
  const task = await store.createTask({
    runtimeId: 'opencode',
    title: 'OpenCode adapter lifecycle',
    prompt: 'Implement the requested change.',
    repositoryPath: worktreePath,
    agentSettings: SETTINGS
  });
  const { iteration, worktree } = await store.createIterationAndWorktree({
    task,
    branchName: 'codex/opencode-adapter',
    worktreePath,
    baseSha: 'base-sha'
  });
  const harness = new FakeOpenCodeHarness(store);
  harness.catalogs.set(path.resolve(appCwd), defaultProviderCatalog());
  harness.catalogs.set(path.resolve(worktreePath), defaultProviderCatalog());
  const runtime = fakeRuntime();
  const appEvents = new AppEventBus();
  const adapter = new OpenCodeAdapter(store, appEvents, {
    cwd: appCwd,
    executable: runtime.executable,
    runtimeResolver: options.runtimeResolver ?? (async () => runtime),
    supervisorFactory: (runtimeStore, supervisorOptions) =>
      harness.createSupervisor(runtimeStore, supervisorOptions),
    sessionIdleTimeoutMs: options.sessionIdleTimeoutMs
  });
  return { root, appCwd, store, adapter, appEvents, harness, task, iteration, worktree };
}

function fakeRuntime(): ResolvedOpenCodeRuntime {
  return {
    executable: '/fake/opencode',
    version: '1.17.18',
    source: 'config',
    diagnostics: {
      selectedExecutable: '/fake/opencode',
      selectedSource: 'config',
      selectedVersion: '1.17.18',
      selectedLaunchArgv: ['serve', '--hostname', '127.0.0.1', '--port', '0'],
      requiredCapabilities: ['GET /event (SSE)'],
      probes: []
    }
  };
}

async function materializeSession(fixture: AdapterFixture): Promise<AgentSessionRecord> {
  const session = await fixture.store.createAgentSession({
    task: fixture.task,
    iteration: fixture.iteration,
    worktree: fixture.worktree,
    runtimeId: 'opencode',
    requestedSettings: SETTINGS
  });
  return fixture.adapter.createSession({
    runtimeId: 'opencode',
    localSessionId: session.id,
    taskId: fixture.task.id,
    iterationId: fixture.iteration.id,
    worktreeId: fixture.worktree.id,
    worktreePath: fixture.worktree.worktreePath,
    settings: SETTINGS
  });
}

async function createRun(
  fixture: AdapterFixture,
  session: AgentSessionRecord
): Promise<RunRecord> {
  return fixture.store.createRun({
    task: fixture.task,
    session,
    mode: 'IMPLEMENTATION',
    prompt: fixture.task.prompt,
    requestedSettings: SETTINGS
  });
}

class FakeOpenCodeHarness {
  readonly sessions = new Map<string, OpenCodeSession>();
  readonly messages = new Map<string, OpenCodeMessage[]>();
  readonly catalogs = new Map<string, unknown>();
  readonly statuses: Record<string, unknown> = {};
  permissions: unknown[] = [];
  questions: unknown[] = [];
  readonly promptBodies: unknown[] = [];
  readonly permissionReplies: unknown[] = [];
  readonly forkRequests: Array<{ sourceSessionId: string; directory: string }> = [];
  readonly supervisors: FakeOpenCodeSupervisor[] = [];
  providerGetCount = 0;
  stoppedStreams = 0;
  private nextSession = 0;

  constructor(private readonly store: FileTaskStore) {}

  get catalogSupervisor(): FakeOpenCodeSupervisor {
    return this.supervisors[0]!;
  }

  get sessionSupervisor(): FakeOpenCodeSupervisor {
    return this.supervisors.at(-1)!;
  }

  createSupervisor(
    store: FileTaskStore,
    options: OpenCodeServerSupervisorOptions
  ): FakeOpenCodeSupervisor {
    const supervisor = new FakeOpenCodeSupervisor(store, options, this);
    this.supervisors.push(supervisor);
    return supervisor;
  }

  async emit(value: unknown): Promise<void> {
    const clients = this.supervisors
      .map((supervisor) => supervisor.client)
      .filter((client): client is FakeOpenCodeClient => Boolean(client));
    for (const client of clients) await client.emit(value);
  }

  createProviderSession(directory: string, body: unknown): OpenCodeSession {
    const input = body as { title?: string; metadata?: Record<string, unknown> };
    const session: OpenCodeSession = {
      id: `ses_${++this.nextSession}`,
      directory,
      title: input.title ?? 'Untitled',
      version: '1.17.18',
      metadata: input.metadata,
      time: { created: Date.now(), updated: Date.now() }
    };
    this.sessions.set(session.id, session);
    this.statuses[session.id] = { type: 'idle' };
    this.messages.set(session.id, []);
    return session;
  }

  forkProviderSession(directory: string, sourceSessionId: string): OpenCodeSession {
    const source = this.sessions.get(sourceSessionId);
    if (!source) throw new Error(`OpenCode session not found: ${sourceSessionId}`);
    this.forkRequests.push({
      sourceSessionId,
      directory: path.resolve(directory)
    });
    return this.createProviderSession(directory, {
      title: `${source.title} (fork #1)`,
      metadata: source.metadata
    });
  }

  providerCatalog(directory: string): unknown {
    return this.catalogs.get(path.resolve(directory)) ?? defaultProviderCatalog();
  }
}

class FakeOpenCodeSupervisor implements OpenCodeSessionSupervisor {
  readonly events = new EventEmitter<OpenCodeSupervisorEvents>();
  currentServer: AgentServerInstance | undefined;
  client: FakeOpenCodeClient | undefined;
  shutdownCount = 0;

  constructor(
    private readonly store: FileTaskStore,
    private readonly options: OpenCodeServerSupervisorOptions,
    private readonly harness: FakeOpenCodeHarness
  ) {}

  get currentClient(): FakeOpenCodeClient | undefined {
    return this.client;
  }

  async start(): Promise<RunningOpenCodeServer> {
    if (!this.currentServer) {
      this.currentServer = await this.store.createAgentServer({
        runtimeId: 'opencode',
        runtimeKind: 'HTTP_AGENT',
        transport: 'HTTP_SSE',
        executable: this.options.runtime.executable,
        argv: ['serve'],
        runtimeVersion: this.options.runtime.version,
        runtimeResolution: this.options.runtime.diagnostics
      });
      this.currentServer = await this.store.updateAgentServer(this.currentServer.id, {
        status: 'READY',
        pid: 4242,
        initializedAt: new Date().toISOString()
      });
      this.client = new FakeOpenCodeClient(
        this.store,
        this.options.cwd,
        () => this.currentServer!.id,
        this.harness
      );
    }
    return { server: this.currentServer, client: this.client! };
  }

  async shutdown(): Promise<void> {
    this.shutdownCount += 1;
    if (this.currentServer && !['EXITED', 'FAILED', 'LOST'].includes(this.currentServer.status)) {
      this.currentServer = await this.store.updateAgentServer(this.currentServer.id, {
        status: 'STOPPING'
      });
      this.currentServer = await this.store.updateAgentServer(this.currentServer.id, {
        status: 'EXITED',
        exitedAt: new Date().toISOString()
      });
    }
  }

  async markRunning(): Promise<void> {
    if (this.currentServer?.status === 'READY' || this.currentServer?.status === 'DEGRADED') {
      this.currentServer = await this.store.updateAgentServer(this.currentServer.id, {
        status: 'RUNNING'
      });
    }
  }

  async markDegraded(reason: string): Promise<void> {
    if (this.currentServer?.status === 'RUNNING') {
      this.currentServer = await this.store.updateAgentServer(this.currentServer.id, {
        status: 'DEGRADED',
        exitReason: reason
      });
    }
  }

  async lose(): Promise<void> {
    if (!this.currentServer) throw new Error('Fake OpenCode server is not running.');
    this.currentServer = await this.store.updateAgentServer(this.currentServer.id, {
      status: 'LOST',
      disconnectedAt: new Date().toISOString(),
      exitedAt: new Date().toISOString(),
      exitReason: 'simulated runtime loss'
    });
    this.events.emit('exit', this.currentServer, true);
  }
}

class FakeOpenCodeClient implements OpenCodeClientTransport {
  private stream?: OpenCodeEventStreamHandlers;

  constructor(
    private readonly store: FileTaskStore,
    private readonly directory: string,
    private readonly serverId: () => string,
    private readonly harness: FakeOpenCodeHarness
  ) {}

  async get<T>(requestPath: string): Promise<OpenCodeHttpResult<T>> {
    let data: unknown;
    if (requestPath === '/provider') {
      this.harness.providerGetCount += 1;
      data = this.harness.providerCatalog(this.directory);
    } else if (requestPath === '/session') {
      data = [...this.harness.sessions.values()].filter(
        (session) => path.resolve(session.directory) === path.resolve(this.directory)
      );
    } else if (requestPath === '/session/status') {
      data = this.harness.statuses;
    } else if (requestPath === '/permission') {
      data = this.harness.permissions;
    } else if (requestPath === '/question') {
      data = this.harness.questions;
    } else if (requestPath.endsWith('/message')) {
      data = this.harness.messages.get(providerSessionId(requestPath)) ?? [];
    } else {
      data = this.harness.sessions.get(providerSessionId(requestPath));
    }
    return { data: data as T, raw: await this.raw(data) };
  }

  async post<T>(requestPath: string, body?: unknown): Promise<OpenCodeHttpResult<T>> {
    let data: unknown;
    if (requestPath === '/session') {
      data = this.harness.createProviderSession(this.directory, body);
    } else if (requestPath.endsWith('/fork')) {
      data = this.harness.forkProviderSession(
        this.directory,
        providerSessionId(requestPath)
      );
    } else if (requestPath.endsWith('/prompt_async')) {
      this.harness.promptBodies.push(body);
      const sessionId = providerSessionId(requestPath);
      const input = body as { messageID: string };
      this.harness.messages.set(sessionId, [
        {
          info: {
            id: input.messageID,
            sessionID: sessionId,
            role: 'user',
            time: { created: Date.now() }
          },
          parts: []
        }
      ]);
      this.harness.statuses[sessionId] = { type: 'busy' };
      data = undefined;
    } else if (requestPath.startsWith('/permission/')) {
      this.harness.permissionReplies.push(body);
      data = true;
    } else if (requestPath.endsWith('/abort')) {
      data = true;
    } else {
      data = true;
    }
    return { data: data as T, raw: await this.raw(data) };
  }

  patch<T>(_path: string, body?: unknown): Promise<OpenCodeHttpResult<T>> {
    return this.result(body as T);
  }

  delete<T>(_path: string): Promise<OpenCodeHttpResult<T>> {
    return this.result(true as T);
  }

  startEventStream(handlers: OpenCodeEventStreamHandlers): { stop(): void } {
    this.stream = handlers;
    return {
      stop: () => {
        this.harness.stoppedStreams += 1;
        this.stream = undefined;
      }
    };
  }

  async emit(value: unknown): Promise<void> {
    if (this.stream) await this.stream.onEvent(value, await this.raw(value));
  }

  private async result<T>(data: T): Promise<OpenCodeHttpResult<T>> {
    return { data, raw: await this.raw(data) };
  }

  private raw(value: unknown): Promise<AgentProtocolMessageReference> {
    return this.store.appendProtocolMessage(
      this.serverId(),
      'INBOUND',
      JSON.stringify(value ?? { status: 204 })
    );
  }
}

function providerSessionId(requestPath: string): string {
  const match = requestPath.match(/^\/session\/([^/]+)/u);
  if (!match) throw new Error(`Missing provider session id in ${requestPath}`);
  return decodeURIComponent(match[1]);
}

function defaultProviderCatalog(): unknown {
  return {
    connected: ['anthropic'],
    default: { anthropic: 'claude-test' },
    all: [
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: {
          'claude-test': {
            id: 'claude-test',
            name: 'Claude Test',
            status: 'active',
            capabilities: { input: { text: true, image: true } },
            variants: { low: {}, high: {} }
          }
        }
      }
    ]
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test condition.');
    await wait(10);
  }
}
