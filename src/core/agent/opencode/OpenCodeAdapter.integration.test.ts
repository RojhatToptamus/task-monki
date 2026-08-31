import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { addTestRepository } from '../../../testSupport/repositoryFixture';
import { openTestPersistence } from '../../../testSupport/persistenceFixture';
import type {
  AgentExecutionSettings,
  AgentProtocolMessageReference,
  AgentServerInstance,
  AgentSessionRecord,
  AppUpdateEvent,
  RespondToInteractionRequest,
  RunRecord,
  Task,
  TaskIteration,
  WorktreeRecord
} from '../../../shared/contracts';
import type { AgentAttachmentSelection } from '../../../shared/attachments';
import { AppEventBus } from '../../runner/AppEventBus';
import { createDomainEvent } from '../../storage/domainEvent';
import { SqliteTaskStore } from '../../storage/SqliteTaskStore';
import { SqliteAgentRuntimeStore } from '../../storage/SqliteAgentRuntimeStore';
import type { ApplicationPersistence } from '../../storage/sqlite/ApplicationPersistence';
import type {
  AgentProviderRuntimeStore,
  TaskAgentRuntimeAccess
} from '../AgentRuntimeStore';
import { AgentRuntimeArtifactMutationAmbiguousError } from '../AgentRuntimeStore';
import { createAgentSessionAccessEpoch } from '../AgentRuntimeOwnership';
import { AgentMutationAmbiguousError } from '../AgentRuntimeAdapter';
import type { AgentRuntimeTurnEvent } from '../AgentRuntimeCoordinator';
import { AgentInteractionService } from '../AgentInteractionService';
import {
  createOpenCodeMessageId,
  OpenCodeAdapter,
  type OpenCodeAdapterOptions
} from './OpenCodeAdapter';
import type {
  OpenCodeClientTransport,
  OpenCodeEventStream,
  OpenCodeEventStreamHandlers,
  OpenCodeHttpResult,
  OpenCodeRequestOptions
} from './OpenCodeHttpClient';
import {
  OpenCodeAmbiguousMutationError,
  OpenCodeHttpError
} from './OpenCodeHttpClient';
import {
  openCodePermissionRules,
  openCodeReadOnlyPermissionRules
} from './OpenCodeInteractionMapper';
import type { OpenCodeMessage, OpenCodeSession } from './OpenCodeProtocol';
import type {
  OpenCodeServerSupervisorOptions,
  OpenCodeSessionSupervisor,
  OpenCodeSupervisorEvents,
  RunningOpenCodeServer
} from './OpenCodeServerSupervisor';
import type { ResolvedOpenCodeRuntime } from './OpenCodeRuntimeResolver';
import type { DesignClientToolBridge } from '../../design/DesignClientToolBridge';

const SETTINGS: AgentExecutionSettings = {
  runtimeId: 'opencode',
  model: 'claude-test',
  modelProvider: 'anthropic',
  reasoningEffort: 'high',
  sandbox: 'DANGER_FULL_ACCESS',
  approvalPolicy: 'on-request',
  networkAccess: true
};

describe('OpenCodeAdapter', () => {
  it('generates message IDs in OpenCode ascending format', () => {
    const timestamp = 1_234_567_890_123;
    vi.useFakeTimers();
    vi.setSystemTime(timestamp);
    try {
      const first = createOpenCodeMessageId();
      const second = createOpenCodeMessageId();
      const mask = 0xffffffffffffn;

      expect(first).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      expect(second).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      expect(BigInt(`0x${first.slice(4, 16)}`)).toBe(
        (BigInt(timestamp) * 0x1000n + 1n) & mask
      );
      expect(BigInt(`0x${second.slice(4, 16)}`)).toBe(
        (BigInt(timestamp) * 0x1000n + 2n) & mask
      );
      expect(first < second).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs Design in pure mode with one registered MCP bridge and bounded turn grants', async () => {
    const bridge = fakeDesignToolBridge();
    const fixture = await createFixture({
      designSkillRoot: path.resolve('resources/design-skills'),
      designClientToolBridge: bridge.api
    });
    await fixture.adapter.initialize();
    const session = await createLocalSession(fixture);
    const run = await createRun(fixture, session, SETTINGS, [], {
      purpose: 'TASK_DESIGN',
      clientToolGrants: ['inspect_design']
    });
    const turn = await fixture.adapter.startTurn({
      localRunId: run.id,
      session: { localSessionId: session.id },
      mode: 'DESIGN',
      instructionProfile: 'DESIGN',
      prompt: 'Create and verify the Design.',
      authoritativeGoal: 'Create and verify the Design.',
      settings: SETTINGS
    });

    expect(fixture.harness.sessionSupervisor.currentServer?.argv).toContain('--pure');
    expect(fixture.harness.mcpRegistrations).toEqual([
      {
        name: 'task_monki_design',
        config: {
          type: 'local',
          command: ['/app/Task Monki', '/resources/design-tool-mcp-server.mjs'],
          environment: {
            TASK_MONKI_DESIGN_TOOL_SESSION_CREDENTIAL: 'session-credential',
            TASK_MONKI_DESIGN_TOOL_CREDENTIAL_FILE: '/private/grant-file'
          },
          timeout: 120_000
        }
      }
    ]);
    expect(fixture.harness.mcpSensitiveValues).toEqual([
      ['session-credential', '/private/grant-file']
    ]);
    expect(bridge.createSessionGrant).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      sessionId: session.id,
      worktreeId: fixture.worktree.id,
      providerGeneration: fixture.harness.sessionSupervisor.currentServer?.id
    });
    expect(bridge.activateGrant).toHaveBeenCalledWith({
      grantId: 'design-grant-1',
      authority: {
        runtimeId: 'opencode',
        sessionId: session.id,
        runId: run.id,
        worktreeId: fixture.worktree.id,
        providerGeneration: fixture.harness.sessionSupervisor.currentServer?.id
      }
    });
    expect(fixture.harness.promptBodies[0]).toMatchObject({
      system: expect.stringContaining('Task Monki Design agent')
    });
    expect(JSON.stringify(fixture.harness.promptBodies[0])).toContain(
      'Read each matching Task Monki skill with the normal file-reading tool at its exact Path.'
    );

    const activeSession = (await fixture.runtime.getAgentSession(session.id))!;
    const assistantId = createOpenCodeMessageId();
    fixture.harness.messages.set(activeSession.providerSessionId!, [
      {
        info: {
          id: turn.providerTurnId!,
          sessionID: activeSession.providerSessionId!,
          role: 'user',
          time: { created: Date.now() }
        },
        parts: []
      },
      {
        info: {
          id: assistantId,
          sessionID: activeSession.providerSessionId!,
          role: 'assistant',
          parentID: turn.providerTurnId,
          providerID: 'anthropic',
          modelID: 'claude-test',
          finish: 'stop',
          time: { created: Date.now(), completed: Date.now() }
        },
        parts: [{
          id: 'prt_design_done',
          sessionID: activeSession.providerSessionId!,
          messageID: assistantId,
          type: 'text',
          text: 'READY'
        }]
      }
    ]);
    fixture.harness.statuses[activeSession.providerSessionId!] = { type: 'idle' };
    await fixture.harness.emit({
      type: 'session.idle',
      properties: { sessionID: activeSession.providerSessionId }
    });

    expect(await fixture.runtime.getRun(run.id)).toMatchObject({ status: 'COMPLETED' });
    expect(bridge.revokeGrant).toHaveBeenCalledWith('design-grant-1');
    await fixture.adapter.releaseSession({
      localSessionId: session.id,
      providerSessionId: activeSession.providerSessionId
    });
    expect(fixture.harness.mcpDisconnects).toEqual([
      '/mcp/task_monki_design/disconnect'
    ]);
    expect(bridge.releaseSessionGrant).toHaveBeenCalledWith('design-grant-1');
    await fixture.adapter.shutdown();
  });

  it('quarantines an uncertain Design MCP registration and releases its grant', async () => {
    const bridge = fakeDesignToolBridge();
    const fixture = await createFixture({
      designSkillRoot: path.resolve('resources/design-skills'),
      designClientToolBridge: bridge.api
    });
    fixture.harness.failNextMcpRegistrationAfterAccept = true;
    await fixture.adapter.initialize();
    const session = await createLocalSession(fixture);
    const run = await createRun(fixture, session, SETTINGS, [], {
      purpose: 'TASK_DESIGN',
      clientToolGrants: ['inspect_design']
    });

    await expect(fixture.adapter.startTurn({
      localRunId: run.id,
      session: { localSessionId: session.id },
      mode: 'DESIGN',
      instructionProfile: 'DESIGN',
      prompt: 'Create and verify the Design.',
      authoritativeGoal: 'Create and verify the Design.',
      settings: SETTINGS
    })).rejects.toBeInstanceOf(AgentMutationAmbiguousError);

    expect(fixture.harness.sessionSupervisor.shutdownCount).toBe(1);
    expect(bridge.releaseSessionGrant).toHaveBeenCalledWith('design-grant-1');
    await fixture.adapter.shutdown();
  });

  it('rejects a definite failed Design MCP registration before prompt delivery', async () => {
    const bridge = fakeDesignToolBridge();
    const fixture = await createFixture({
      designSkillRoot: path.resolve('resources/design-skills'),
      designClientToolBridge: bridge.api
    });
    fixture.harness.nextMcpRegistrationStatus = {
      status: 'failed',
      error: 'simulated child launch failure'
    };
    await fixture.adapter.initialize();
    const session = await createLocalSession(fixture);
    const run = await createRun(fixture, session, SETTINGS, [], {
      purpose: 'TASK_DESIGN',
      clientToolGrants: ['inspect_design']
    });

    await expect(fixture.adapter.startTurn({
      localRunId: run.id,
      session: { localSessionId: session.id },
      mode: 'DESIGN',
      instructionProfile: 'DESIGN',
      prompt: 'Create and verify the Design.',
      authoritativeGoal: 'Create and verify the Design.',
      settings: SETTINGS
    })).rejects.toThrow('reported failed for the Design MCP server');

    expect(fixture.harness.promptBodies).toHaveLength(0);
    expect(bridge.releaseSessionGrant).toHaveBeenCalledWith('design-grant-1');
    await fixture.adapter.shutdown();
  });

  it('stops a newly created Design runtime when session setup fails', async () => {
    const bridge = fakeDesignToolBridge();
    const fixture = await createFixture({
      designSkillRoot: path.resolve('resources/design-skills'),
      designClientToolBridge: bridge.api
    });
    await fixture.adapter.initialize();
    fixture.harness.failProviderGetAt = fixture.harness.providerGetCount + 2;
    const session = await createLocalSession(fixture);
    const run = await createRun(fixture, session, SETTINGS, [], {
      purpose: 'TASK_DESIGN',
      clientToolGrants: ['inspect_design']
    });

    await expect(
      fixture.adapter.startTurn({
        localRunId: run.id,
        session: { localSessionId: session.id },
        mode: 'DESIGN',
        instructionProfile: 'DESIGN',
        prompt: 'Create and verify the Design.',
        authoritativeGoal: 'Create and verify the Design.',
        settings: SETTINGS,
        attachments: []
      })
    ).rejects.toThrow('simulated provider catalog failure');

    expect(fixture.harness.sessionSupervisor.shutdownCount).toBe(1);
    expect(bridge.releaseSessionGrant).toHaveBeenCalledWith('design-grant-1');
    await fixture.adapter.shutdown();
  });

  it('enables Design for connected catalog models that report image input', async () => {
    const runtime = {
      ...fakeRuntime(),
      version: '1.99.0',
      diagnostics: {
        ...fakeRuntime().diagnostics,
        selectedVersion: '1.99.0'
      }
    };
    const bridge = fakeDesignToolBridge();
    const fixture = await createFixture({
      runtimeResolver: async () => runtime,
      designSkillRoot: path.resolve('resources/design-skills'),
      designClientToolBridge: bridge.api
    });
    const catalog = {
      connected: ['opencode', 'openai'],
      default: {
        opencode: 'catalog-image-model',
        openai: 'gpt-5.6-luna'
      },
      all: [
        {
          id: 'opencode',
          name: 'OpenCode',
          models: {
            'catalog-image-model': {
              id: 'catalog-image-model',
              name: 'Catalog image model',
              status: 'active',
              capabilities: { input: { text: true, image: true } }
            },
            'catalog-text-model': {
              id: 'catalog-text-model',
              name: 'Catalog text model',
              status: 'active',
              capabilities: { input: { text: true, image: false } }
            }
          }
        },
        {
          id: 'openai',
          name: 'OpenAI',
          models: {
            'gpt-5.6-luna': {
              id: 'gpt-5.6-luna',
              name: 'GPT-5.6 Luna',
              status: 'active',
              capabilities: { input: { text: true, image: true } }
            },
            'second-image-model': {
              id: 'second-image-model',
              name: 'Second image model',
              status: 'active',
              capabilities: { input: { text: true, image: true } },
              cost: { input: 0, output: 0 }
            }
          }
        }
      ]
    };
    fixture.harness.catalogs.set(path.resolve(fixture.appCwd), catalog);
    fixture.harness.catalogs.set(path.resolve(fixture.worktree.worktreePath), catalog);

    await fixture.adapter.initialize();

    expect(await fixture.adapter.capabilities()).toMatchObject({
      extensions: {
        'task-monki.design-instructions': { maturity: 'stable' },
        'task-monki.design-skill-access': { maturity: 'stable' },
        'task-monki.design-browser-verification': { maturity: 'stable' }
      }
    });
    expect(await fixture.adapter.listModels()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          modelProvider: 'opencode',
          model: 'catalog-image-model',
          designSupport: {
            maturity: 'stable',
            detail: expect.stringContaining('reports image input support')
          }
        }),
        expect.objectContaining({
          modelProvider: 'openai',
          model: 'second-image-model',
          designSupport: {
            maturity: 'stable',
            detail: expect.stringContaining('reports image input support')
          }
        }),
        expect.objectContaining({
          modelProvider: 'opencode',
          model: 'catalog-text-model',
          designSupport: {
            maturity: 'unsupported',
            detail: expect.stringContaining('reports no image input support')
          }
        })
      ])
    );
    await fixture.adapter.shutdown();
  });

  it('rejects Design before provider mutation when the worktree catalog loses image support', async () => {
    const fixture = await createFixture({
      designSkillRoot: path.resolve('resources/design-skills'),
      designClientToolBridge: fakeDesignToolBridge().api
    });
    await fixture.adapter.initialize();
    fixture.harness.catalogs.set(path.resolve(fixture.worktree.worktreePath), {
      connected: ['anthropic'],
      default: { anthropic: 'claude-test' },
      all: [{
        id: 'anthropic',
        name: 'Anthropic',
        models: {
          'claude-test': {
            id: 'claude-test',
            name: 'Claude Test',
            status: 'active',
            capabilities: { input: { text: true } },
            variants: { high: {} }
          }
        }
      }]
    });
    const session = await createLocalSession(fixture);
    const run = await createRun(fixture, session, SETTINGS, [], {
      purpose: 'TASK_DESIGN',
      clientToolGrants: ['inspect_design']
    });

    await expect(
      fixture.adapter.startTurn({
        localRunId: run.id,
        session: { localSessionId: session.id },
        mode: 'DESIGN',
        instructionProfile: 'DESIGN',
        prompt: 'Create and verify the Design.',
        authoritativeGoal: 'Create and verify the Design.',
        settings: SETTINGS
      })
    ).rejects.toThrow('reports no image input support');
    expect(fixture.harness.promptBodies).toHaveLength(0);
    expect(fixture.harness.sessions.size).toBe(0);
    await fixture.adapter.shutdown();
  });

  it('revokes the Design grant before cancellation reaches OpenCode', async () => {
    const bridge = fakeDesignToolBridge();
    const fixture = await createFixture({
      interruptCompletionTimeoutMs: 80,
      designSkillRoot: path.resolve('resources/design-skills'),
      designClientToolBridge: bridge.api
    });
    fixture.harness.settleAbort = true;
    await fixture.adapter.initialize();
    const session = await createLocalSession(fixture);
    const run = await createRun(fixture, session, SETTINGS, [], {
      purpose: 'TASK_DESIGN',
      clientToolGrants: ['inspect_design']
    });
    const turn = await fixture.adapter.startTurn({
      localRunId: run.id,
      session: { localSessionId: session.id },
      mode: 'DESIGN',
      instructionProfile: 'DESIGN',
      prompt: 'Create and verify the Design.',
      authoritativeGoal: 'Create and verify the Design.',
      settings: SETTINGS
    });
    const activeSession = (await fixture.runtime.getAgentSession(session.id))!;

    await fixture.adapter.interruptTurn({
      session: {
        localSessionId: session.id,
        providerSessionId: activeSession.providerSessionId
      },
      providerTurnId: turn.providerTurnId!
    });

    expect(bridge.revokeGrant).toHaveBeenCalledWith('design-grant-1');
    expect(fixture.harness.abortedSessionIds).toEqual([
      activeSession.providerSessionId
    ]);
    await fixture.adapter.shutdown();
  });

  it('releases a Design grant when its exact OpenCode generation exits', async () => {
    const bridge = fakeDesignToolBridge();
    const fixture = await createFixture({
      designSkillRoot: path.resolve('resources/design-skills'),
      designClientToolBridge: bridge.api
    });
    await fixture.adapter.initialize();
    const session = await createLocalSession(fixture);
    const run = await createRun(fixture, session, SETTINGS, [], {
      purpose: 'TASK_DESIGN',
      clientToolGrants: ['inspect_design']
    });
    await fixture.adapter.startTurn({
      localRunId: run.id,
      session: { localSessionId: session.id },
      mode: 'DESIGN',
      instructionProfile: 'DESIGN',
      prompt: 'Create and verify the Design.',
      authoritativeGoal: 'Create and verify the Design.',
      settings: SETTINGS
    });

    await fixture.harness.sessionSupervisor.lose();
    await waitForCondition(() => bridge.releaseSessionGrant.mock.calls.length === 1);

    expect(bridge.revokeGrant).toHaveBeenCalledWith('design-grant-1');
    expect(bridge.releaseSessionGrant).toHaveBeenCalledWith('design-grant-1');
    await fixture.adapter.shutdown();
  });

  it('releases the Design grant before an unconfirmed quarantine shutdown', async () => {
    const bridge = fakeDesignToolBridge();
    const fixture = await createFixture({
      designSkillRoot: path.resolve('resources/design-skills'),
      designClientToolBridge: bridge.api
    });
    await fixture.adapter.initialize();
    const session = await createLocalSession(fixture);
    const run = await createRun(fixture, session, SETTINGS, [], {
      purpose: 'TASK_DESIGN',
      clientToolGrants: ['inspect_design']
    });
    await fixture.adapter.startTurn({
      localRunId: run.id,
      session: { localSessionId: session.id },
      mode: 'DESIGN',
      instructionProfile: 'DESIGN',
      prompt: 'Create and verify the Design.',
      authoritativeGoal: 'Create and verify the Design.',
      settings: SETTINGS
    });

    const lifecycle: string[] = [];
    bridge.releaseSessionGrant.mockImplementation(async () => {
      lifecycle.push('release-design-grant');
    });
    const supervisor = fixture.harness.sessionSupervisor;
    supervisor.shutdownFailure = new Error('old OpenCode child may still be live');
    const shutdown = supervisor.shutdown.bind(supervisor);
    vi.spyOn(supervisor, 'shutdown').mockImplementation(async () => {
      lifecycle.push('shutdown');
      await shutdown();
    });
    const internals = fixture.adapter as unknown as {
      quarantineSessionRuntime(
        sessionId: string,
        operation: string,
        detail: string
      ): Promise<void>;
    };

    await expect(
      internals.quarantineSessionRuntime(
        session.id,
        'test/quarantine',
        'Delivery could not be confirmed.'
      )
    ).rejects.toThrow('session process quarantine was incomplete');
    expect(lifecycle.slice(0, 2)).toEqual(['release-design-grant', 'shutdown']);
    expect(bridge.releaseSessionGrant).toHaveBeenCalledWith('design-grant-1');

    supervisor.shutdownFailure = undefined;
    await expect(fixture.adapter.shutdown()).rejects.toThrow(
      'OpenCode runtimes failed to shut down'
    );
  });

  it('maps the shared read-only request to native denial without claiming confinement', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();

    await expect(
      fixture.adapter.resolveExecution({
        settings: {
          ...SETTINGS,
          sandbox: 'READ_ONLY',
          approvalPolicy: 'NEVER',
          networkAccess: false
        },
        attachments: []
      })
    ).resolves.toMatchObject({
      settings: {
        sandbox: 'DANGER_FULL_ACCESS',
        approvalPolicy: 'never',
        networkAccess: true
      }
    });
    await fixture.adapter.shutdown();
  });

  it('runs an owner-neutral turn with exact native read-only rules and bounded output', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    const context = await fixture.adapter.buildExecutionContext({
      sessionId: 'runtime-session',
      primaryCwd: fixture.worktree.worktreePath,
      readRoots: [{
        canonicalPath: fixture.worktree.worktreePath,
        kind: 'WORKTREE',
        entityId: fixture.worktree.id
      }],
      modelSettings: SETTINGS,
      clientOperationId: 'runtime-context'
    });
    const owner = {
      kind: 'DISCOURSE' as const,
      conversationId: 'conversation-1',
      stableParticipantId: 'participant-1'
    };
    expect(context.modelSettings.approvalPolicy).toBe('NEVER');
    const session = await fixture.runtimeStore.createSession({
      id: 'runtime-session',
      owner,
      accessEpoch: createAgentSessionAccessEpoch({
        owner,
        sessionId: 'runtime-session',
        epoch: 1,
        runtimeId: 'opencode',
        model: context.modelSettings.model!,
        executionContext: context,
        createdAt: new Date().toISOString()
      }),
      executionContext: context,
      clientOperationId: 'runtime-session-create',
      runtimeId: 'opencode',
      role: 'PRIMARY',
      relationshipState: 'ROOT',
      status: 'NOT_MATERIALIZED',
      materialized: false,
      requestedSettings: context.modelSettings
    });
    let run = await fixture.runtimeStore.createRun({
      id: 'runtime-run',
      owner,
      scope: {
        kind: 'DISCOURSE',
        conversationId: 'conversation-1',
        waveId: 'wave-1',
        jobId: 'job-1',
        contextSnapshotId: 'snapshot-1',
        attemptId: 'attempt-1'
      },
      sessionId: session.id,
      sessionAccessEpoch: 1,
      purpose: 'DISCOURSE_ANSWER',
      generationKey: 'runtime-generation',
      clientOperationId: 'runtime-run-create',
      requestedSettings: context.modelSettings,
      promptArtifactId: 'runtime-prompt',
      outputArtifactId: 'runtime-output',
      diagnosticArtifactId: 'runtime-diagnostic'
    });
    await Promise.all([
      fixture.runtimeStore.createArtifact({
        id: run.promptArtifactId,
        owner,
        runId: run.id,
        kind: 'PROMPT',
        clientOperationId: 'runtime-prompt-create',
        content: 'Inspect this repository.'
      }),
      fixture.runtimeStore.createArtifact({
        id: run.outputArtifactId,
        owner,
        runId: run.id,
        kind: 'OUTPUT',
        clientOperationId: 'runtime-output-create',
        content: ''
      }),
      fixture.runtimeStore.createArtifact({
        id: run.diagnosticArtifactId,
        owner,
        runId: run.id,
        kind: 'DIAGNOSTIC',
        clientOperationId: 'runtime-diagnostic-create',
        content: ''
      })
    ]);
    run = await fixture.runtimeStore.updateRun(
      run.id,
      run.recordRevision,
      {
        status: 'STARTING',
        delivery: 'SENDING',
        startedAt: new Date().toISOString()
      },
      'runtime-starting'
    );
    const events: AgentRuntimeTurnEvent[] = [];
    const unsubscribe = fixture.adapter.onRuntimeTurnEvent((event) => events.push(event));
    const started = await fixture.adapter.startRuntimeTurn({
      session,
      run,
      executionContext: context,
      prompt: 'Inspect this repository.',
      attachments: []
    });
    const providerSession = fixture.harness.sessions.get(started.providerSessionId)!;
    expect(providerSession.permission).toEqual(openCodeReadOnlyPermissionRules());
    await expect(fixture.runtimeStore.getAgentServer(started.serverInstanceId)).resolves.toMatchObject({
      argv: expect.arrayContaining(['--pure'])
    });

    const assistant: OpenCodeMessage = {
      info: {
        id: 'msg_runtime_assistant',
        sessionID: providerSession.id,
        role: 'assistant',
        parentID: started.providerTurnId,
        finish: 'stop',
        time: { created: Date.now(), completed: Date.now() }
      },
      parts: [{
        id: 'prt_runtime_answer',
        sessionID: providerSession.id,
        messageID: 'msg_runtime_assistant',
        type: 'text',
        text: 'The repository is consistent.'
      }]
    };
    fixture.harness.messages.get(providerSession.id)!.push(assistant);
    fixture.harness.statuses[providerSession.id] = { type: 'idle' };
    await fixture.harness.emit({
      type: 'message.updated',
      properties: { info: assistant.info }
    });
    await fixture.harness.emit({
      type: 'session.idle',
      properties: { sessionID: providerSession.id }
    });

    expect(await fixture.runtimeStore.readArtifact(run.outputArtifactId)).toBe(
      'The repository is consistent.'
    );
    expect(await fixture.runtimeStore.getRun(run.id)).toMatchObject({
      status: 'COMPLETED',
      delivery: 'TERMINAL',
      providerTurnId: started.providerTurnId
    });
    expect(await fixture.runtimeStore.getSession(session.id)).toMatchObject({
      requestedSettings: { approvalPolicy: 'NEVER' },
      observedSettings: { approvalPolicy: 'never' }
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'TERMINAL', runId: run.id, status: 'completed' })
    );
    unsubscribe();
    await fixture.adapter.shutdown();
  });

  it('fails a denied read-only permission request only after provider settlement', async () => {
    const fixture = await createOwnerNeutralRuntimeFixture();
    fixture.harness.settleAbort = true;
    const events: AgentRuntimeTurnEvent[] = [];
    const unsubscribe = fixture.adapter.onRuntimeTurnEvent((event) => events.push(event));
    await fixture.harness.emit({
      type: 'permission.asked',
      properties: {
        id: 'permission-runtime-edit',
        sessionID: fixture.started.providerSessionId,
        permission: 'edit',
        source: { messageID: fixture.started.providerTurnId }
      }
    });

    expect(fixture.harness.permissionReplies).toEqual([{ reply: 'reject' }]);
    expect(fixture.harness.abortedSessionIds).toEqual([fixture.started.providerSessionId]);
    expect(fixture.harness.statusReadCount).toBeGreaterThan(0);
    expect(await fixture.runtimeStore.getRun(fixture.run.id)).toMatchObject({
      status: 'FAILED',
      delivery: 'TERMINAL',
      terminalReason: expect.stringContaining('request was denied')
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'TERMINAL', runId: fixture.run.id, status: 'failed' })
    );
    unsubscribe();
    await fixture.adapter.shutdown();
  });

  it('finishes a shared read-only cancellation only after OpenCode reports idle', async () => {
    const fixture = await createOwnerNeutralRuntimeFixture({
      interruptCompletionTimeoutMs: 40
    });
    fixture.harness.settleAbort = true;
    const events: AgentRuntimeTurnEvent[] = [];
    const unsubscribe = fixture.adapter.onRuntimeTurnEvent((event) => events.push(event));
    const session = (await fixture.runtimeStore.getSession(fixture.session.id))!;
    let run = (await fixture.runtimeStore.getRun(fixture.run.id))!;
    run = await fixture.runtimeStore.updateRun(
      run.id,
      run.recordRevision,
      {
        status: 'INTERRUPTING',
        delivery: 'ACKNOWLEDGED',
        interruptDelivery: 'SENDING',
        stopRequestedAt: new Date().toISOString()
      },
      'runtime-denial-interrupting'
    );

    await fixture.adapter.interruptRuntimeTurn({ session, run });

    expect(fixture.harness.abortedSessionIds).toEqual([fixture.started.providerSessionId]);
    expect(fixture.harness.statusReadCount).toBeGreaterThan(0);
    expect(await fixture.runtimeStore.getRun(run.id)).toMatchObject({
      status: 'INTERRUPTED',
      delivery: 'TERMINAL',
      interruptDelivery: 'TERMINAL'
    });
    expect(await fixture.runtimeStore.getSession(session.id)).toMatchObject({
      status: 'IDLE',
      materialized: true
    });
    expect(fixture.harness.sessionSupervisor.shutdownCount).toBe(0);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'TERMINAL', runId: run.id, status: 'interrupted' })
    );
    unsubscribe();
    await fixture.adapter.shutdown();
  });

  it('stops the session process when a shared read-only cancellation never settles', async () => {
    const fixture = await createOwnerNeutralRuntimeFixture({
      interruptCompletionTimeoutMs: 40
    });
    const oldClient = fixture.harness.sessionSupervisor.client!;
    const events: AgentRuntimeTurnEvent[] = [];
    const unsubscribe = fixture.adapter.onRuntimeTurnEvent((event) => events.push(event));
    const session = (await fixture.runtimeStore.getSession(fixture.session.id))!;
    let run = (await fixture.runtimeStore.getRun(fixture.run.id))!;
    run = await fixture.runtimeStore.updateRun(
      run.id,
      run.recordRevision,
      {
        status: 'INTERRUPTING',
        delivery: 'ACKNOWLEDGED',
        interruptDelivery: 'SENDING',
        stopRequestedAt: new Date().toISOString()
      },
      'runtime-denial-interrupting'
    );

    await fixture.adapter.interruptRuntimeTurn({ session, run });

    expect(fixture.harness.abortedSessionIds).toEqual([fixture.started.providerSessionId]);
    expect(fixture.harness.statusReadCount).toBeGreaterThan(0);
    expect(fixture.harness.sessionSupervisor.shutdownCount).toBe(1);
    expect(fixture.harness.stoppedStreams).toBe(1);
    expect(await fixture.runtimeStore.getRun(run.id)).toMatchObject({
      status: 'INTERRUPTED',
      delivery: 'TERMINAL',
      interruptDelivery: 'TERMINAL',
      providerTerminalSource: 'OPENCODE_PROCESS_STOP',
      terminalReason: expect.stringContaining('stopped the owning OpenCode session process')
    });
    expect(await fixture.runtimeStore.getSession(session.id)).toMatchObject({
      status: 'NOT_LOADED'
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'TERMINAL', runId: run.id, status: 'interrupted' })
    );
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'RECOVERY_REQUIRED' }));

    await oldClient.emitLate({
      type: 'session.idle',
      properties: { sessionID: fixture.started.providerSessionId }
    });
    expect((await fixture.runtimeStore.getRun(run.id))?.status).toBe('INTERRUPTED');
    unsubscribe();
    await fixture.adapter.shutdown();
  });

  it('does not cross the repository boundary when read-only cancellation cannot stop the process', async () => {
    const fixture = await createOwnerNeutralRuntimeFixture({
      interruptCompletionTimeoutMs: 40
    });
    fixture.harness.sessionSupervisor.shutdownFailure = new Error(
      'simulated session shutdown failure'
    );
    const events: AgentRuntimeTurnEvent[] = [];
    const unsubscribe = fixture.adapter.onRuntimeTurnEvent((event) => events.push(event));
    const session = (await fixture.runtimeStore.getSession(fixture.session.id))!;
    let run = (await fixture.runtimeStore.getRun(fixture.run.id))!;
    run = await fixture.runtimeStore.updateRun(
      run.id,
      run.recordRevision,
      {
        status: 'INTERRUPTING',
        delivery: 'ACKNOWLEDGED',
        interruptDelivery: 'SENDING',
        stopRequestedAt: new Date().toISOString()
      },
      'runtime-denial-interrupting'
    );

    await expect(
      fixture.adapter.interruptRuntimeTurn({ session, run })
    ).rejects.toMatchObject({ delivery: 'AMBIGUOUS' });

    expect(fixture.harness.sessionSupervisor.shutdownCount).toBe(1);
    expect(await fixture.runtimeStore.getRun(run.id)).toMatchObject({
      status: 'INTERRUPTING'
    });
    expect((await fixture.runtimeStore.getRun(run.id))?.repositoryIntegrity).toBeUndefined();
    expect((await fixture.runtimeStore.getSession(session.id))?.status).not.toBe(
      'NOT_LOADED'
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: 'RECOVERY_REQUIRED', runId: run.id })
    );
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'TERMINAL' }));
    fixture.harness.sessionSupervisor.shutdownFailure = undefined;
    unsubscribe();
    await expect(fixture.adapter.shutdown()).rejects.toThrow(
      'OpenCode runtimes failed to shut down'
    );
  });

  it('does not emit recovery when an inbound read-only quarantine cannot stop the process', async () => {
    const fixture = await createOwnerNeutralRuntimeFixture();
    fixture.harness.sessionSupervisor.shutdownFailure = new Error(
      'simulated inbound session shutdown failure'
    );
    const events: AgentRuntimeTurnEvent[] = [];
    const unsubscribe = fixture.adapter.onRuntimeTurnEvent((event) => events.push(event));

    await fixture.harness.emit({
      type: 'permission.asked',
      properties: {
        id: 'permission-runtime-unconfirmed-quarantine',
        sessionID: fixture.started.providerSessionId,
        permission: 'edit',
        source: { messageID: fixture.started.providerTurnId }
      }
    });

    expect(fixture.harness.permissionReplies).toEqual([{ reply: 'reject' }]);
    expect(fixture.harness.abortedSessionIds).toEqual([
      fixture.started.providerSessionId
    ]);
    expect(fixture.harness.sessionSupervisor.shutdownCount).toBe(1);
    expect(await fixture.runtimeStore.getRun(fixture.run.id)).toMatchObject({
      status: 'STARTING'
    });
    expect(
      (await fixture.runtimeStore.getRun(fixture.run.id))?.repositoryIntegrity
    ).toBeUndefined();
    expect((await fixture.runtimeStore.getSession(fixture.session.id))?.status).not.toBe(
      'NOT_LOADED'
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: 'RECOVERY_REQUIRED', runId: fixture.run.id })
    );
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'TERMINAL' }));

    fixture.harness.sessionSupervisor.shutdownFailure = undefined;
    unsubscribe();
    await expect(fixture.adapter.shutdown()).rejects.toThrow(
      'OpenCode runtimes failed to shut down'
    );
  });

  it('quarantines a read-only turn when abort does not reach provider settlement', async () => {
    const fixture = await createOwnerNeutralRuntimeFixture();
    const oldClient = fixture.harness.sessionSupervisor.client!;
    const events: AgentRuntimeTurnEvent[] = [];
    const unsubscribe = fixture.adapter.onRuntimeTurnEvent((event) => events.push(event));

    await fixture.harness.emit({
      type: 'permission.asked',
      properties: {
        id: 'permission-runtime-unsettled',
        sessionID: fixture.started.providerSessionId,
        permission: 'edit',
        source: { messageID: fixture.started.providerTurnId }
      }
    });

    expect(fixture.harness.permissionReplies).toEqual([{ reply: 'reject' }]);
    expect(fixture.harness.abortedSessionIds).toEqual([fixture.started.providerSessionId]);
    expect(await fixture.runtimeStore.getRun(fixture.run.id)).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      recoveryState: 'REQUIRES_USER_ACTION'
    });
    expect(fixture.harness.sessionSupervisor.shutdownCount).toBe(1);
    expect(fixture.harness.stoppedStreams).toBe(1);
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'TERMINAL' }));

    await oldClient.emitLate({
      type: 'session.idle',
      properties: { sessionID: fixture.started.providerSessionId }
    });
    expect((await fixture.runtimeStore.getRun(fixture.run.id))?.status).toBe(
      'RECOVERY_REQUIRED'
    );
    unsubscribe();
    await fixture.adapter.shutdown();
  });

  it('quarantines a read-only turn when the provider abort request fails', async () => {
    const fixture = await createOwnerNeutralRuntimeFixture();
    fixture.harness.failNextAbort = true;

    await fixture.harness.emit({
      type: 'permission.asked',
      properties: {
        id: 'permission-runtime-abort-failed',
        sessionID: fixture.started.providerSessionId,
        permission: 'edit',
        source: { messageID: fixture.started.providerTurnId }
      }
    });

    expect(fixture.harness.permissionReplies).toEqual([{ reply: 'reject' }]);
    expect(fixture.harness.abortedSessionIds).toEqual([fixture.started.providerSessionId]);
    expect(await fixture.runtimeStore.getRun(fixture.run.id)).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      recoveryState: 'REQUIRES_USER_ACTION'
    });
    expect(fixture.harness.sessionSupervisor.shutdownCount).toBe(1);
    expect(fixture.harness.stoppedStreams).toBe(1);
    await fixture.adapter.shutdown();
  });

  it('stops after one assistant response when OpenCode compares message IDs', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    const terminalEvents: AppUpdateEvent[] = [];
    const unsubscribe = fixture.appEvents.on((event) => {
      if (event.type === 'run.terminal' && event.runId === run.id) {
        terminalEvents.push(event);
      }
    });
    const turn = await fixture.adapter.startTurn({
      localRunId: run.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });

    const assistants: OpenCodeMessage[] = [];
    for (let step = 0; step < 40; step += 1) {
      const messageId = createOpenCodeMessageId();
      assistants.push({
        info: {
          id: messageId,
          sessionID: session.providerSessionId!,
          role: 'assistant',
          parentID: turn.providerTurnId,
          providerID: 'anthropic',
          modelID: 'claude-test',
          finish: 'stop',
          time: { created: Date.now(), completed: Date.now() }
        },
        parts: [
          {
            id: `prt_stop_${step}`,
            sessionID: session.providerSessionId!,
            messageID: messageId,
            type: 'text',
            text: 'TASK_MONKI_PROVIDER_SMOKE_OK'
          }
        ]
      });
      if (turn.providerTurnId! < messageId) break;
    }

    expect(assistants).toHaveLength(1);
    fixture.harness.messages.set(session.providerSessionId!, [
      {
        info: {
          id: turn.providerTurnId!,
          sessionID: session.providerSessionId!,
          role: 'user',
          time: { created: Date.now() }
        },
        parts: []
      },
      ...assistants
    ]);
    fixture.harness.statuses[session.providerSessionId!] = { type: 'idle' };
    await fixture.harness.emit({
      type: 'session.idle',
      properties: { sessionID: session.providerSessionId }
    });

    expect(await fixture.runtime.getRun(run.id)).toMatchObject({
      status: 'COMPLETED',
      finalMessage: 'TASK_MONKI_PROVIDER_SMOKE_OK'
    });
    expect(terminalEvents).toHaveLength(1);
    unsubscribe();
    await fixture.adapter.shutdown();
  });

  it('answers a native multi-part question once and resumes the same run', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    const turn = await fixture.adapter.startTurn({
      localRunId: run.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });
    await fixture.harness.emit({
      type: 'question.asked',
      properties: {
        id: 'que_native_input',
        sessionID: session.providerSessionId,
        tool: {
          messageID: turn.providerTurnId,
          callID: 'call_native_input'
        },
        questions: [
          {
            header: 'Checks',
            question: 'Which checks should run?',
            multiple: true,
            options: [
              { label: 'Unit', description: 'Run focused unit tests.' },
              { label: 'Build', description: 'Build the app.' }
            ]
          },
          {
            header: 'Detail',
            question: 'What should the agent preserve?'
          }
        ]
      }
    });
    await fixture.harness.emit({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_native_question',
          sessionID: session.providerSessionId,
          role: 'assistant',
          parentID: turn.providerTurnId,
          time: { created: Date.now() }
        }
      }
    });
    await fixture.harness.emit({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_native_question',
          sessionID: session.providerSessionId,
          messageID: 'msg_native_question',
          type: 'tool',
          tool: 'question',
          callID: 'call_native_input',
          state: {
            status: 'running',
            input: { questions: [] },
            time: { start: Date.now() }
          }
        }
      }
    });

    const interaction = (await fixture.runtime.snapshot()).interactionRequests.find(
      (candidate) => candidate.providerRequestId === 'que_native_input'
    )!;
    expect(interaction).toMatchObject({
      type: 'USER_INPUT',
      status: 'PENDING',
      runId: run.id,
      providerTurnId: turn.providerTurnId,
      request: {
        questions: [
          { id: 'que_native_input:0', allowsMultiple: true, isOther: true },
          { id: 'que_native_input:1', isOther: true }
        ]
      }
    });
    expect(await fixture.runtime.getRun(run.id)).toMatchObject({
      status: 'AWAITING_USER_INPUT',
      providerTurnId: turn.providerTurnId
    });
    expect(await fixture.runtime.getAgentSession(session.id)).toMatchObject({
      status: 'AWAITING_USER_INPUT'
    });

    const service = new AgentInteractionService(
      fixture.runtime,
      fixture.appEvents,
      () => fixture.adapter
    );
    const input: RespondToInteractionRequest = {
      taskId: fixture.task.id,
      runId: run.id,
      interactionRequestId: interaction.id,
      decision: {
        interactionType: 'USER_INPUT',
        action: 'ANSWER',
        answers: {
          'que_native_input:0': ['Unit', 'Smoke'],
          'que_native_input:1': ['Preserve current behavior.']
        }
      }
    };
    await service.respond(input);

    expect(fixture.harness.questionReplies).toEqual([
      {
        answers: [
          ['Unit', 'Smoke'],
          ['Preserve current behavior.']
        ]
      }
    ]);
    expect(await fixture.runtime.getInteractionRequest(interaction.id)).toMatchObject({
      status: 'RESOLVED',
      resolution: { provider: 'opencode', acknowledged: true }
    });
    expect(await fixture.runtime.getRun(run.id)).toMatchObject({
      status: 'RUNNING',
      providerTurnId: turn.providerTurnId
    });
    expect(await fixture.runtime.getAgentSession(session.id)).toMatchObject({
      status: 'ACTIVE'
    });
    await expect(service.respond(input)).rejects.toThrow('expected PENDING');
    expect(fixture.harness.questionReplies).toHaveLength(1);
    await fixture.adapter.shutdown();
  });

  it('fails a blocked question closed when it is first discovered during recovery', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    const turn = await fixture.adapter.startTurn({
      localRunId: run.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });
    fixture.harness.questions = [
      {
        id: 'que_secret_recovery',
        sessionID: session.providerSessionId,
        tool: { messageID: turn.providerTurnId },
        questions: [
          {
            header: 'API token',
            question: 'Enter the secret API token.',
            options: []
          }
        ]
      }
    ];

    await fixture.adapter.attachSession({
      localSessionId: session.id,
      providerSessionId: session.providerSessionId
    });
    await fixture.adapter.attachSession({
      localSessionId: session.id,
      providerSessionId: session.providerSessionId
    });

    expect(fixture.harness.questionReplies).toEqual([{ answers: [[]] }]);
    expect(
      (await fixture.runtime.snapshot()).interactionRequests.find(
        (candidate) => candidate.providerRequestId === 'que_secret_recovery'
      )
    ).toMatchObject({
      status: 'RESOLVED',
      allowedActions: [],
      policyWarnings: [expect.stringContaining('secret-safe response channel')]
    });
    expect(await fixture.runtime.getRun(run.id)).toMatchObject({ status: 'RUNNING' });
    expect(await fixture.runtime.getAgentSession(session.id)).toMatchObject({
      status: 'ACTIVE'
    });
    await fixture.adapter.shutdown();
  });

  it('omits credential-colliding provider/model IDs without mutating operational catalog values', async () => {
    const opaque = 'm7Qp4Vz9Lk2Nc8';
    const fixture = await createFixture({ environment: { XAI_API_KEY: opaque } });
    const catalog = {
      connected: ['anthropic', opaque],
      default: { anthropic: 'claude-test', [opaque]: `model-${opaque}` },
      all: [
        {
          id: 'anthropic',
          name: `Anthropic ${opaque}`,
          models: {
            'claude-test': {
              id: 'claude-test',
              name: `Claude ${opaque}`,
              status: 'active',
              capabilities: {
                input: { text: true, [`modality-${opaque}`]: true }
              },
              variants: {
                high: { [`metadata-${opaque}`]: true },
                [`variant-${opaque}`]: {}
              }
            }
          }
        },
        {
          id: opaque,
          name: 'Unsafe provider',
          models: {
            [`model-${opaque}`]: {
              id: `model-${opaque}`,
              name: 'Unsafe model',
              status: 'active'
            }
          }
        }
      ]
    };
    fixture.harness.catalogs.set(path.resolve(fixture.appCwd), catalog);
    fixture.harness.catalogs.set(path.resolve(fixture.worktree.worktreePath), catalog);

    await fixture.adapter.initialize();
    const published = await fixture.adapter.listModels();
    expect(published).toHaveLength(1);
    expect(JSON.stringify(published)).not.toContain(opaque);
    expect(published[0]).toMatchObject({
      modelProvider: 'anthropic',
      model: 'claude-test',
      displayName: 'Claude [REDACTED]',
      supportedReasoningEfforts: ['high'],
      inputModalities: ['text'],
      native: {
        capabilities: { input: { text: true } },
        variants: { high: {} }
      }
    });
    expect(JSON.stringify(await fixture.adapter.readNativeState())).not.toContain(opaque);
    expect((await fixture.adapter.preflight()).readiness.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'SENSITIVE_PROVIDER_IDENTIFIER_OMITTED' })
    );
    await expect(
      fixture.adapter.resolveExecution({
        settings: { ...SETTINGS, modelProvider: opaque, model: `model-${opaque}` },
        attachments: []
      })
    ).rejects.toThrow('matches a runtime credential');
    await expect(
      fixture.adapter.resolveExecution({
        settings: { ...SETTINGS, reasoningEffort: `variant-${opaque}` },
        attachments: []
      })
    ).rejects.toThrow('matches a runtime credential');
    await expect(
      fixture.adapter.resolveExecution({ settings: SETTINGS, attachments: [] })
    ).resolves.toMatchObject({
      settings: { modelProvider: 'anthropic', model: 'claude-test' }
    });
    await fixture.adapter.shutdown();
  });

  it('omits credential-colliding session and message model observations', async () => {
    const opaque = 'm7Qp4Vz9Lk2Nc8';
    const fixture = await createFixture({ environment: { XAI_API_KEY: opaque } });
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const providerSession = fixture.harness.sessions.get(session.providerSessionId!)!;
    providerSession.model = {
      providerID: opaque,
      modelID: `model-${opaque}`,
      variant: `variant-${opaque}`
    };

    const observedSession = await fixture.adapter.readSession({
      localSessionId: session.id,
      providerSessionId: session.providerSessionId
    });
    expect(observedSession.session.observedSettings?.modelProvider).toBeUndefined();
    expect(observedSession.session.observedSettings?.model).toBeUndefined();
    expect(observedSession.session.observedSettings?.reasoningEffort).toBeUndefined();
    expect(JSON.stringify(observedSession.session.observedSettings)).not.toContain(opaque);

    const run = await createRun(fixture, observedSession.session);
    const turn = await fixture.adapter.startTurn({
      localRunId: run.id,
      session: {
        localSessionId: observedSession.session.id,
        providerSessionId: observedSession.session.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });
    await fixture.harness.emit({
      id: 'evt_unsafe_observed_model',
      type: 'message.updated',
      properties: {
        info: {
          id: turn.providerTurnId,
          sessionID: session.providerSessionId,
          role: 'user',
          providerID: opaque,
          modelID: `model-${opaque}`,
          variant: `variant-${opaque}`,
          time: { created: Date.now() }
        }
      }
    });

    const storedRun = (await fixture.runtime.getRun(run.id))!;
    const storedSession = (await fixture.runtime.getAgentSession(session.id))!;
    expect(storedRun.observedSettings?.modelProvider).toBeUndefined();
    expect(storedRun.observedSettings?.model).toBeUndefined();
    expect(storedRun.observedSettings?.reasoningEffort).toBeUndefined();
    expect(JSON.stringify({ storedRun, storedSession })).not.toContain(opaque);
    expect((await fixture.adapter.preflight()).readiness.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'SENSITIVE_PROVIDER_IDENTIFIER_OMITTED' })
    );
    await fixture.adapter.shutdown();
  });

  it('keeps outbound model resolution distinct from provider-confirmed SSE settings', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    const turn = await fixture.adapter.startTurn({
      localRunId: run.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });

    let observations = (await fixture.runtime.snapshot()).agentSettingsObservations.filter(
      (observation) => observation.runId === run.id
    );
    expect(observations).toEqual([
      expect.objectContaining({
        source: 'TASK_MONKI_RESOLUTION',
        settings: expect.objectContaining({
          modelProvider: 'anthropic',
          model: 'claude-test',
          reasoningEffort: 'high'
        }),
        rawMessage: expect.objectContaining({ direction: 'INBOUND' })
      })
    ]);

    await fixture.harness.emit({
      id: 'evt_provider_settings',
      type: 'message.updated',
      properties: {
        info: {
          id: turn.providerTurnId,
          sessionID: session.providerSessionId,
          role: 'user',
          providerID: 'anthropic',
          modelID: 'claude-test',
          variant: 'high',
          time: { created: Date.now() }
        }
      }
    });

    observations = (await fixture.runtime.snapshot()).agentSettingsObservations.filter(
      (observation) => observation.runId === run.id
    );
    expect(observations.map((observation) => observation.source)).toEqual([
      'THREAD_SETTINGS_NOTIFICATION',
      'TASK_MONKI_RESOLUTION'
    ]);
    expect(observations[0]).toMatchObject({
      settings: {
        modelProvider: 'anthropic',
        model: 'claude-test',
        reasoningEffort: 'high'
      },
      rawMessage: expect.objectContaining({ direction: 'INBOUND' })
    });
    await fixture.adapter.shutdown();
  });

  it('recovers provider-confirmed settings from native message history when SSE was missed', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    const turn = await fixture.adapter.startTurn({
      localRunId: run.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });
    const userMessage = fixture.harness.messages
      .get(session.providerSessionId!)
      ?.find((message) => message.info.id === turn.providerTurnId);
    expect(userMessage).toBeDefined();
    Object.assign(userMessage!.info, {
      providerID: 'anthropic',
      modelID: 'claude-test',
      variant: 'high'
    });

    await expect(fixture.adapter.reconcile()).resolves.toMatchObject({
      reconciledSessionIds: [session.id],
      recoveryRequiredSessionIds: []
    });

    const observations = (await fixture.runtime.snapshot()).agentSettingsObservations.filter(
      (observation) => observation.runId === run.id
    );
    expect(observations.map((observation) => observation.source)).toEqual([
      'RECOVERY_RESUME_RESPONSE',
      'TASK_MONKI_RESOLUTION'
    ]);
    expect(observations[0]).toMatchObject({
      settings: {
        modelProvider: 'anthropic',
        model: 'claude-test',
        reasoningEffort: 'high'
      },
      rawMessage: expect.objectContaining({ direction: 'INBOUND' })
    });
    expect(fixture.harness.promptBodies).toHaveLength(1);
    await fixture.adapter.shutdown();
  });

  it('keeps passive attach read-only and does not claim a drifted native approval policy', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    fixture.harness.sessions.get(session.providerSessionId!)!.permission!.push({
      permission: 'edit',
      pattern: '*',
      action: 'allow'
    });

    const attached = await fixture.adapter.attachSession({
      localSessionId: session.id,
      providerSessionId: session.providerSessionId
    });

    expect(fixture.harness.permissionPatchBodies).toEqual([]);
    expect(attached.observedSettings?.approvalPolicy).toBeUndefined();
    await fixture.adapter.shutdown();
  });

  it('quarantines active recovery when native permissions no longer attest its policy', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    await fixture.adapter.startTurn({
      localRunId: run.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });
    fixture.harness.sessions.get(session.providerSessionId!)!.permission!.push({
      permission: 'edit',
      pattern: '*',
      action: 'allow'
    });

    await expect(fixture.adapter.reconcile()).resolves.toEqual({
      reconciledSessionIds: [],
      recoveryRequiredSessionIds: [session.id]
    });

    const recoveredRun = await fixture.runtime.getRun(run.id);
    expect(recoveredRun).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      recoveryState: 'REQUIRES_USER_ACTION',
      terminalReason: expect.stringContaining(
        'does not attest the requested on-request approval policy'
      )
    });
    expect(recoveredRun?.observedSettings?.approvalPolicy).toBeUndefined();
    const recoveredSession = await fixture.runtime.getAgentSession(session.id);
    expect(recoveredSession).toMatchObject({ status: 'NOT_LOADED' });
    expect(recoveredSession?.observedSettings?.approvalPolicy).toBeUndefined();
    expect(fixture.harness.sessionSupervisor.shutdownCount).toBe(1);
    await fixture.adapter.shutdown();
  });

  it('repairs and attests the effective native permission suffix before prompting', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    fixture.harness.sessions.get(session.providerSessionId!)!.permission!.push({
      permission: 'edit',
      pattern: '*',
      action: 'allow'
    });
    const run = await createRun(fixture, session);

    await fixture.adapter.startTurn({
      localRunId: run.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });

    expect(fixture.harness.permissionPatchBodies).toEqual([
      { permission: openCodePermissionRules(SETTINGS) }
    ]);
    expect(fixture.harness.promptBodies).toHaveLength(1);
    expect((await fixture.runtime.getAgentSession(session.id))?.observedSettings)
      .toMatchObject({ approvalPolicy: 'on-request' });
    await fixture.adapter.shutdown();
  });

  it('quarantines an ambiguous permission mutation without submitting a prompt', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    fixture.harness.sessions.get(session.providerSessionId!)!.permission!.push({
      permission: 'bash',
      pattern: '*',
      action: 'allow'
    });
    fixture.harness.failNextPermissionPatchAfterAccept = true;
    const run = await createRun(fixture, session);

    await expect(fixture.adapter.startTurn({
      localRunId: run.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    })).rejects.toMatchObject({
      name: 'AgentMutationAmbiguousError',
      operation: 'session/update-permission'
    });
    expect(fixture.harness.promptBodies).toEqual([]);
    expect(await fixture.runtime.getAgentSession(session.id)).toMatchObject({
      status: 'NOT_LOADED'
    });
    await fixture.adapter.shutdown();
  });

  it('distinguishes missing provider authentication from a broken connected model catalog', async () => {
    const unauthenticated = await createFixture();
    unauthenticated.harness.catalogs.set(path.resolve(unauthenticated.appCwd), {
      connected: [],
      default: {},
      all: []
    });
    await unauthenticated.adapter.initialize();
    await expect(unauthenticated.adapter.preflight()).resolves.toMatchObject({
      readiness: {
        status: 'AUTHENTICATION_REQUIRED',
        checks: { authentication: 'REQUIRED', modelCatalog: 'EMPTY' }
      }
    });
    await unauthenticated.adapter.shutdown();

    const brokenCatalog = await createFixture();
    brokenCatalog.harness.catalogs.set(path.resolve(brokenCatalog.appCwd), {
      connected: ['anthropic'],
      default: { anthropic: 'claude-test' },
      all: [{ id: 'anthropic', name: 'Anthropic', models: {} }]
    });
    await brokenCatalog.adapter.initialize();
    await expect(brokenCatalog.adapter.preflight()).resolves.toMatchObject({
      readiness: {
        status: 'FAILED',
        checks: { authentication: 'AUTHENTICATED', modelCatalog: 'FAILED' },
        diagnostics: [
          expect.objectContaining({
            code: 'CONNECTED_PROVIDER_MODEL_CATALOG_EMPTY',
            stage: 'MODEL_CATALOG'
          }),
          expect.anything()
        ]
      }
    });
    await brokenCatalog.adapter.shutdown();
  });

  it('does not publish a catalog or launch a replacement when temporary runtime teardown is unconfirmed', async () => {
    const fixture = await createFixture();
    fixture.harness.supervisorShutdownFailures.set(
      0,
      new Error('simulated catalog shutdown failure')
    );

    await expect(fixture.adapter.initialize()).rejects.toThrow(
      'simulated catalog shutdown failure'
    );

    expect(await fixture.adapter.preflight()).toMatchObject({
      readiness: { status: 'FAILED', canStart: false }
    });
    expect(fixture.harness.supervisors).toHaveLength(1);
    expect(fixture.harness.catalogSupervisor.shutdownCount).toBe(2);
    await expect(fixture.adapter.listModels()).rejects.toThrow(
      'previous catalog process is unconfirmed'
    );
    expect(fixture.harness.supervisors).toHaveLength(1);

    fixture.harness.catalogSupervisor.shutdownFailure = undefined;
    await fixture.adapter.shutdown();
  });

  it('fully reinitializes a stopped runtime before resolving and starting new work', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    await fixture.adapter.shutdown();

    await expect(
      fixture.adapter.resolveExecution({ settings: SETTINGS, attachments: [] })
    ).resolves.toMatchObject({
      settings: {
        runtimeId: 'opencode',
        model: 'claude-test',
        modelProvider: 'anthropic'
      }
    });
    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    await expect(fixture.adapter.startTurn({
      localRunId: run.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    })).resolves.toMatchObject({ localRunId: run.id });

    expect(await fixture.runtime.getRun(run.id)).toMatchObject({ status: 'RUNNING' });
    await fixture.adapter.shutdown();
  });

  it('accepts an OpenCode session directory that is a canonical alias of its worktree', async () => {
    const fixture = await createFixture();
    const worktreeAlias = path.join(fixture.root, 'worktree-alias');
    await fs.symlink(
      fixture.worktree.worktreePath,
      worktreeAlias,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    fixture.harness.sessionDirectoryTransform = () => worktreeAlias;

    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);

    expect(session.providerSessionId).toBeDefined();
    expect(
      fixture.harness.sessions.get(session.providerSessionId!)?.directory
    ).toBe(worktreeAlias);
    expect(path.resolve(worktreeAlias)).not.toBe(
      path.resolve(fixture.worktree.worktreePath)
    );
    expect(await fs.realpath(worktreeAlias)).toBe(
      await fs.realpath(fixture.worktree.worktreePath)
    );
    await fixture.adapter.shutdown();
  });

  it('quarantines mismatched created and discovered sessions without persisting or reusing them', async () => {
    const fixture = await createFixture();
    const differentWorktree = path.join(fixture.root, 'different-worktree');
    await fs.mkdir(differentWorktree);
    fixture.harness.sessionDirectoryTransform = () => differentWorktree;

    await fixture.adapter.initialize();
    await expect(materializeSession(fixture)).rejects.toThrow(
      'does not match its Task Monki worktree'
    );

    const createdSessionSupervisor = fixture.harness.sessionSupervisor;
    const localSession = (await fixture.runtime.snapshot()).agentSessions.find(
      (session) => session.runtimeId === 'opencode'
    )!;
    expect(createdSessionSupervisor.shutdownCount).toBe(1);
    expect(createdSessionSupervisor.startCount).toBe(1);
    expect(localSession.status).toBe('NOT_LOADED');
    expect(localSession.providerSessionId).toBeUndefined();
    expect(localSession.providerSessionTreeId).toBeUndefined();
    expect(fixture.harness.sessions.size).toBe(1);

    fixture.harness.includeCrossDirectorySessions = true;
    await expect(
      fixture.adapter.createSession({
        runtimeId: 'opencode',
        localSessionId: localSession.id,
        taskId: fixture.task.id,
        iterationId: fixture.iteration.id,
        worktreeId: fixture.worktree.id,
        worktreePath: fixture.worktree.worktreePath,
        settings: SETTINGS
      })
    ).rejects.toThrow('does not match its Task Monki worktree');

    const discoverySupervisor = fixture.harness.sessionSupervisor;
    expect(discoverySupervisor).not.toBe(createdSessionSupervisor);
    expect(discoverySupervisor.shutdownCount).toBe(1);
    expect(createdSessionSupervisor.startCount).toBe(1);
    expect((await fixture.runtime.getAgentSession(localSession.id))?.providerSessionId).toBeUndefined();
    expect(fixture.harness.sessions.size).toBe(1);
    await fixture.adapter.shutdown();
  });

  it('fails on structured provider errors with a redacted actionable diagnostic', async () => {
    const opaque = 'm7Qp4Vz9Lk2Nc8';
    const fixture = await createFixture({ environment: { XAI_API_KEY: opaque } });
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    await fixture.adapter.startTurn({
      localRunId: run.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });

    await fixture.harness.emit({
      type: 'session.error',
      properties: {
        sessionID: session.providerSessionId,
        error: {
          name: 'APIError',
          data: {
            message: `token expired or incorrect for ${opaque}`,
            statusCode: 401,
            isRetryable: false,
            responseHeaders: { authorization: `Bearer ${opaque}` },
            responseBody: `{"token":"${opaque}"}`,
            metadata: { url: `https://provider.example/?token=${opaque}` }
          }
        }
      }
    });

    const failed = (await fixture.runtime.getRun(run.id))!;
    expect(failed).toMatchObject({
      status: 'FAILED',
      terminalReason:
        'APIError: token expired or incorrect for [REDACTED] (status 401; not retryable)'
    });
    expect((await fixture.runtime.getAgentSession(session.id))?.status).toBe('SYSTEM_ERROR');
    expect(await fixture.runtimeStore.readArtifact(failed.finalArtifactId!)).toContain(
      'APIError: token expired or incorrect for [REDACTED] (status 401; not retryable)'
    );
    expect(JSON.stringify((await fixture.store.snapshot()).events)).not.toContain(opaque);
    await fixture.adapter.shutdown();
  });

  it('keeps a context-overflow notification nonterminal while OpenCode compacts and continues', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    const turn = await fixture.adapter.startTurn({
      localRunId: run.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });

    await fixture.harness.emit({
      type: 'session.error',
      properties: {
        sessionID: session.providerSessionId,
        error: {
          name: 'ContextOverflowError',
          data: { message: 'Context limit reached; compacting.' }
        }
      }
    });

    expect(await fixture.runtime.getRun(run.id)).toMatchObject({ status: 'RUNNING' });
    expect(
      (await fixture.runtime.snapshot()).artifacts.filter(
        (artifact) => artifact.runId === run.id && artifact.kind === 'agent-final'
      )
    ).toEqual([]);

    const assistant: OpenCodeMessage = {
      info: {
        id: 'msg_after_compaction',
        sessionID: session.providerSessionId!,
        role: 'assistant',
        parentID: turn.providerTurnId,
        finish: 'stop',
        time: { created: Date.now(), completed: Date.now() }
      },
      parts: [{
        id: 'prt_after_compaction',
        sessionID: session.providerSessionId!,
        messageID: 'msg_after_compaction',
        type: 'text',
        text: 'Completed after automatic compaction.'
      }]
    };
    fixture.harness.messages.set(session.providerSessionId!, [
      fixture.harness.messages.get(session.providerSessionId!)![0]!,
      assistant
    ]);
    fixture.harness.statuses[session.providerSessionId!] = { type: 'idle' };
    await fixture.harness.emit({
      type: 'session.idle',
      properties: { sessionID: session.providerSessionId }
    });

    expect(await fixture.runtime.getRun(run.id)).toMatchObject({
      status: 'COMPLETED',
      finalMessage: 'Completed after automatic compaction.'
    });
    await fixture.adapter.shutdown();
  });

  it('does not infer a user interruption from a provider abort error', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    await fixture.adapter.startTurn({
      localRunId: run.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });

    await fixture.harness.emit({
      type: 'session.error',
      properties: {
        sessionID: session.providerSessionId,
        error: { name: 'MessageAbortedError', data: { message: 'Aborted' } }
      }
    });

    expect(await fixture.runtime.getRun(run.id)).toMatchObject({
      status: 'FAILED',
      terminalReason: 'MessageAbortedError: Aborted'
    });
    expect((await fixture.runtime.getAgentSession(session.id))?.status).toBe('SYSTEM_ERROR');
    await fixture.adapter.shutdown();
  });

  it('preserves a requested interrupt through active reconciliation and the provider abort', async () => {
    const fixture = await createFixture({ interruptCompletionTimeoutMs: 60 });
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    const turn = await fixture.adapter.startTurn({
      localRunId: run.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });

    await fixture.adapter.interruptTurn({
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      providerTurnId: turn.providerTurnId!
    });

    expect((await fixture.runtime.getRun(run.id))?.status).toBe('INTERRUPTING');
    await fixture.harness.emit({
      type: 'session.error',
      properties: {
        sessionID: session.providerSessionId,
        error: { name: 'MessageAbortedError', data: { message: 'Aborted' } }
      }
    });

    expect(await fixture.runtime.getRun(run.id)).toMatchObject({
      status: 'INTERRUPTED',
      terminalReason: 'MessageAbortedError: Aborted'
    });
    expect((await fixture.runtime.getAgentSession(session.id))?.status).toBe('IDLE');
    await wait(100);
    const snapshot = await fixture.store.snapshot();
    const runtimeSnapshot = await fixture.runtime.snapshot();
    expect(
      snapshot.events.filter(
        (event) =>
          event.runId === run.id &&
          ['AGENT_RUN_COMPLETED', 'AGENT_RUN_FAILED', 'AGENT_RUN_INTERRUPTED'].includes(event.type)
      )
    ).toHaveLength(1);
    expect(
      runtimeSnapshot.artifacts.filter(
        (artifact) => artifact.runId === run.id && artifact.kind === 'agent-final'
      )
    ).toHaveLength(1);
    expect(
      snapshot.events.filter(
        (event) => event.runId === run.id && event.type === 'AGENT_RUNTIME_LOST'
      )
    ).toHaveLength(0);
    expect(fixture.harness.sessionSupervisor.shutdownCount).toBe(0);
    await fixture.adapter.shutdown();
  });

  it('reconciles an acknowledged interrupt from an aborted snapshot when terminal SSE was missed', async () => {
    const fixture = await createFixture({ interruptCompletionTimeoutMs: 80 });
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    const turn = await fixture.adapter.startTurn({
      localRunId: run.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });

    await fixture.adapter.interruptTurn({
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      providerTurnId: turn.providerTurnId!
    });
    const userMessage = fixture.harness.messages.get(session.providerSessionId!)![0]!;
    fixture.harness.messages.set(session.providerSessionId!, [
      userMessage,
      {
        info: {
          id: 'msg_aborted_without_sse',
          sessionID: session.providerSessionId!,
          role: 'assistant',
          parentID: turn.providerTurnId,
          error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
          time: { created: Date.now(), completed: Date.now() }
        },
        parts: []
      }
    ]);
    delete fixture.harness.statuses[session.providerSessionId!];

    await waitForCondition(
      async () => (await fixture.runtime.getRun(run.id))?.status === 'INTERRUPTED'
    );
    expect(await fixture.runtime.getRun(run.id)).toMatchObject({
      status: 'INTERRUPTED',
      terminalReason: 'MessageAbortedError: Aborted'
    });
    expect(fixture.harness.sessionSupervisor.shutdownCount).toBe(0);
    await fixture.adapter.shutdown();
  });

  it('treats acknowledged abort plus explicit idle as interrupted without requiring an assistant', async () => {
    const fixture = await createFixture({ interruptCompletionTimeoutMs: 80 });
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    const turn = await fixture.adapter.startTurn({
      localRunId: run.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });
    await fixture.adapter.interruptTurn({
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      providerTurnId: turn.providerTurnId!
    });
    fixture.harness.statuses[session.providerSessionId!] = { type: 'idle' };

    await waitForCondition(
      async () => (await fixture.runtime.getRun(run.id))?.status === 'INTERRUPTED'
    );
    expect((await fixture.runtime.getRun(run.id))?.terminalReason).toContain(
      'reported the provider session idle'
    );
    expect(fixture.harness.sessionSupervisor.shutdownCount).toBe(0);
    await fixture.adapter.shutdown();
  });

  it('does not interpret a missing interrupt status plus an older assistant as explicit idle', async () => {
    const fixture = await createFixture({ interruptCompletionTimeoutMs: 100 });
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    const turn = await fixture.adapter.startTurn({
      localRunId: run.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });
    const userMessage = fixture.harness.messages.get(session.providerSessionId!)![0]!;
    fixture.harness.messages.set(session.providerSessionId!, [
      userMessage,
      {
        info: {
          id: 'msg_before_interrupt',
          sessionID: session.providerSessionId!,
          role: 'assistant',
          parentID: turn.providerTurnId,
          finish: 'stop',
          time: { created: Date.now() - 1_000, completed: Date.now() - 900 }
        },
        parts: [{
          id: 'prt_before_interrupt',
          sessionID: session.providerSessionId!,
          messageID: 'msg_before_interrupt',
          type: 'text',
          text: 'An older response.'
        }]
      }
    ]);
    await fixture.adapter.interruptTurn({
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      providerTurnId: turn.providerTurnId!
    });
    delete fixture.harness.statuses[session.providerSessionId!];

    await wait(40);
    expect((await fixture.runtime.getRun(run.id))?.status).toBe('INTERRUPTING');
    await waitForCondition(
      async () => (await fixture.runtime.getRun(run.id))?.status === 'INTERRUPTED'
    );
    expect((await fixture.runtime.getRun(run.id))?.terminalReason).toContain(
      'could not prove a terminal provider state'
    );
    expect(fixture.harness.sessionSupervisor.shutdownCount).toBe(1);
    await fixture.adapter.shutdown();
  });

  it('uses a fresh final snapshot when the provider becomes idle after the first deadline probe', async () => {
    // Keep the synthetic deadline comfortably above event-loop jitter from the
    // parallel suite. Production uses a six-second window; this test needs
    // enough space for both deliberately distinct probes.
    const fixture = await createFixture({ interruptCompletionTimeoutMs: 4_000 });
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    const turn = await fixture.adapter.startTurn({
      localRunId: run.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });
    await fixture.adapter.interruptTurn({
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      providerTurnId: turn.providerTurnId!
    });
    const readsAfterImmediateReconciliation = fixture.harness.statusReadCount;
    await waitForCondition(
      () => fixture.harness.statusReadCount > readsAfterImmediateReconciliation,
      6_000
    );
    fixture.harness.statuses[session.providerSessionId!] = { type: 'idle' };

    await waitForCondition(
      async () => (await fixture.runtime.getRun(run.id))?.status === 'INTERRUPTED',
      6_000
    );
    expect(fixture.harness.statusReadCount).toBeGreaterThan(
      readsAfterImmediateReconciliation + 1
    );
    expect(fixture.harness.sessionSupervisor.shutdownCount).toBe(0);
    await fixture.adapter.shutdown();
  }, 10_000);

  it('bounds stalled abort and reconciliation requests and never leaves the run interrupting', async () => {
    const stalledAbort = await createFixture({ interruptCompletionTimeoutMs: 80 });
    await stalledAbort.adapter.initialize();
    const abortSession = await materializeSession(stalledAbort);
    const abortRun = await createRun(stalledAbort, abortSession);
    const abortTurn = await stalledAbort.adapter.startTurn({
      localRunId: abortRun.id,
      session: {
        localSessionId: abortSession.id,
        providerSessionId: abortSession.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: stalledAbort.task.prompt,
      authoritativeGoal: stalledAbort.task.prompt,
      settings: SETTINGS
    });
    stalledAbort.harness.stallAbort = true;
    await expect(stalledAbort.adapter.interruptTurn({
      session: {
        localSessionId: abortSession.id,
        providerSessionId: abortSession.providerSessionId
      },
      providerTurnId: abortTurn.providerTurnId!
    })).rejects.toBeInstanceOf(AgentMutationAmbiguousError);
    expect(stalledAbort.harness.abortDeadlineWindowsMs).toHaveLength(1);
    expect(Math.max(...stalledAbort.harness.abortDeadlineWindowsMs)).toBeLessThanOrEqual(20);
    expect((await stalledAbort.runtime.getRun(abortRun.id))?.status).toBe(
      'RECOVERY_REQUIRED'
    );
    await stalledAbort.adapter.shutdown();

    const stalledReconciliation = await createFixture({
      interruptCompletionTimeoutMs: 100
    });
    await stalledReconciliation.adapter.initialize();
    const reconcileSession = await materializeSession(stalledReconciliation);
    const reconcileRun = await createRun(stalledReconciliation, reconcileSession);
    const reconcileTurn = await stalledReconciliation.adapter.startTurn({
      localRunId: reconcileRun.id,
      session: {
        localSessionId: reconcileSession.id,
        providerSessionId: reconcileSession.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: stalledReconciliation.task.prompt,
      authoritativeGoal: stalledReconciliation.task.prompt,
      settings: SETTINGS
    });
    stalledReconciliation.harness.stallMessageReads = true;
    await stalledReconciliation.adapter.interruptTurn({
      session: {
        localSessionId: reconcileSession.id,
        providerSessionId: reconcileSession.providerSessionId
      },
      providerTurnId: reconcileTurn.providerTurnId!
    });
    await waitForCondition(async () =>
      (await stalledReconciliation.runtime.getRun(reconcileRun.id))?.status === 'INTERRUPTED'
    );
    expect(stalledReconciliation.harness.messageReadDeadlineWindowsMs.length).toBeGreaterThan(0);
    expect(
      Math.max(...stalledReconciliation.harness.messageReadDeadlineWindowsMs)
    ).toBeLessThanOrEqual(25);
    expect(stalledReconciliation.harness.sessionSupervisor.shutdownCount).toBe(1);
    await stalledReconciliation.adapter.shutdown();
  });

  it('clears an armed interrupt deadline during shutdown without late mutations', async () => {
    const fixture = await createFixture({ interruptCompletionTimeoutMs: 60 });
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    const turn = await fixture.adapter.startTurn({
      localRunId: run.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });
    await fixture.adapter.interruptTurn({
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      providerTurnId: turn.providerTurnId!
    });
    await fixture.adapter.shutdown();
    const before = await fixture.store.snapshot();
    await wait(100);
    const after = await fixture.store.snapshot();
    expect(after.events).toHaveLength(before.events.length);
    expect((await fixture.runtime.getRun(run.id))?.status).toBe(
      'INTERRUPTING'
    );
    expect(fixture.harness.sessionSupervisor.shutdownCount).toBe(1);
  });

  it('fences an old interrupt deadline from a replacement runtime generation', async () => {
    const fixture = await createFixture({ interruptCompletionTimeoutMs: 80 });
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const oldRun = await createRun(fixture, session);
    const oldTurn = await fixture.adapter.startTurn({
      localRunId: oldRun.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });
    await fixture.adapter.interruptTurn({
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      providerTurnId: oldTurn.providerTurnId!
    });
    const oldSupervisor = fixture.harness.sessionSupervisor;
    await oldSupervisor.lose();
    await waitForCondition(
      async () => (await fixture.runtime.getRun(oldRun.id))?.status === 'RECOVERY_REQUIRED'
    );
    const finalArtifact = await fixture.runtime.writeFinalArtifact(
      oldRun.taskId,
      oldRun.id,
      '# Interrupted after runtime loss\n',
      `test:old-run-final:${oldRun.id}`
    );
    await fixture.runtime.applyTaskRuntimeEvent(createDomainEvent({
      type: 'AGENT_RUN_INTERRUPTED',
      taskId: oldRun.taskId,
      iterationId: oldRun.iterationId,
      runId: oldRun.id,
      worktreeId: oldRun.worktreeId,
      agentSessionId: oldRun.sessionId,
      serverInstanceId: oldRun.serverInstanceId,
      source: 'ui',
      payload: {
        terminalReason: 'Explicitly closed before replacement.',
        finalArtifactId: finalArtifact.id
      }
    }), `test:old-run-interrupted:${oldRun.id}`);

    const replacementSession = (await fixture.runtime.getAgentSession(session.id))!;
    const replacementRun = await createRun(fixture, replacementSession);
    const replacementStart = fixture.adapter.startTurn({
      localRunId: replacementRun.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: 'RETRY',
      prompt: 'Start the replacement turn only.',
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });
    await replacementStart;
    const replacementSupervisor = fixture.harness.sessionSupervisor;
    expect(replacementSupervisor).not.toBe(oldSupervisor);
    await wait(140);

    expect((await fixture.runtime.getRun(replacementRun.id))?.status).toBe('RUNNING');
    expect(replacementSupervisor.shutdownCount).toBe(0);
    expect(
      (await fixture.store.snapshot()).events.filter(
        (event) =>
          event.runId === replacementRun.id &&
          ['AGENT_RUN_INTERRUPTED', 'AGENT_RUNTIME_LOST'].includes(event.type)
      )
    ).toHaveLength(0);
    expect(
      (await fixture.store.snapshot()).events.filter(
        (event) =>
          event.runId === replacementRun.id &&
          event.type === 'AGENT_ACTIVITY_RECEIVED' &&
          typeof event.payload === 'object' &&
          event.payload !== null &&
          'eventType' in event.payload &&
          event.payload.eventType === 'session/abort/deadline-expired'
      )
    ).toHaveLength(0);
    await fixture.adapter.shutdown();
  });

  it('requires recovery when the deadline cannot confirm session process shutdown', async () => {
    const fixture = await createFixture({ interruptCompletionTimeoutMs: 60 });
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    const turn = await fixture.adapter.startTurn({
      localRunId: run.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });
    fixture.harness.sessionSupervisor.shutdownFailure = new Error(
      'simulated unconfirmed interrupt teardown'
    );
    await fixture.adapter.interruptTurn({
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      providerTurnId: turn.providerTurnId!
    });

    await waitForCondition(
      async () => {
        const stored = await fixture.runtime.getRun(run.id);
        return stored?.status === 'RECOVERY_REQUIRED' &&
          stored.recoveryState === 'REQUIRES_USER_ACTION';
      }
    );
    expect((await fixture.runtime.getRun(run.id))?.recoveryState).toBe(
      'REQUIRES_USER_ACTION'
    );
    await expect(
      fixture.adapter.readSession({
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      })
    ).rejects.toThrow('session process quarantine was incomplete');
    fixture.harness.sessionSupervisor.shutdownFailure = undefined;
    await expect(fixture.adapter.shutdown()).rejects.toThrow(
      'OpenCode runtimes failed to shut down'
    );
  });

  it('serializes SSE terminal errors behind reconciliation without duplicate terminal evidence', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    const turn = await fixture.adapter.startTurn({
      localRunId: run.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });
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
          id: 'msg_reconciled_terminal',
          sessionID: session.providerSessionId!,
          role: 'assistant',
          parentID: turn.providerTurnId,
          finish: 'stop',
          time: { completed: Date.now() }
        },
        parts: [
          {
            id: 'prt_reconciled_terminal',
            sessionID: session.providerSessionId!,
            messageID: 'msg_reconciled_terminal',
            type: 'text',
            text: 'Completed from the authoritative snapshot.'
          }
        ]
      }
    ]);
    fixture.harness.statuses[session.providerSessionId!] = { type: 'idle' };

    const originalWriteFinalArtifact = fixture.runtime.writeFinalArtifact.bind(fixture.runtime);
    let finalArtifactWrites = 0;
    let releaseFirstWrite!: () => void;
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let firstWriteStarted!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      firstWriteStarted = resolve;
    });
    fixture.runtime.writeFinalArtifact = async (...args) => {
      finalArtifactWrites += 1;
      if (finalArtifactWrites === 1) {
        firstWriteStarted();
        await firstWriteGate;
      }
      return originalWriteFinalArtifact(...args);
    };

    const reconciliation = fixture.adapter.reconcile();
    await firstWrite;
    const terminalEvent = fixture.harness.emit({
      type: 'session.error',
      properties: {
        sessionID: session.providerSessionId,
        error: { name: 'APIError', data: { message: 'late provider error' } }
      }
    });
    await wait(20);
    expect(finalArtifactWrites).toBe(1);
    releaseFirstWrite();
    await Promise.all([reconciliation, terminalEvent]);
    fixture.runtime.writeFinalArtifact = originalWriteFinalArtifact;

    const snapshot = await fixture.store.snapshot();
    const runtimeSnapshot = await fixture.runtime.snapshot();
    expect(runtimeSnapshot.runs.find((candidate) => candidate.id === run.id)?.status).toBe('COMPLETED');
    expect(
      runtimeSnapshot.artifacts.filter(
        (artifact) => artifact.runId === run.id && artifact.kind === 'agent-final'
      )
    ).toHaveLength(1);
    expect(
      snapshot.events.filter(
        (event) =>
          event.runId === run.id &&
          ['AGENT_RUN_COMPLETED', 'AGENT_RUN_FAILED', 'AGENT_RUN_INTERRUPTED'].includes(event.type)
      )
    ).toHaveLength(1);
    await fixture.adapter.shutdown();
  });

  it('preserves a concurrent terminal run when a stale provider error finishes later', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    await fixture.adapter.startTurn({
      localRunId: run.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });

    const updates: AppUpdateEvent[] = [];
    const unsubscribe = fixture.appEvents.on((event) => updates.push(event));
    const writeFinalArtifact = fixture.runtime.writeFinalArtifact.bind(fixture.runtime);
    let releaseStaleWrite!: () => void;
    const staleWriteGate = new Promise<void>((resolve) => {
      releaseStaleWrite = resolve;
    });
    let markStaleWriteStarted!: () => void;
    const staleWriteStarted = new Promise<void>((resolve) => {
      markStaleWriteStarted = resolve;
    });
    let firstWrite = true;
    const writeFinalArtifactSpy = vi
      .spyOn(fixture.runtime, 'writeFinalArtifact')
      .mockImplementation(async (...args) => {
        if (firstWrite) {
          firstWrite = false;
          markStaleWriteStarted();
          await staleWriteGate;
        }
        return writeFinalArtifact(...args);
      });

    const staleFailure = fixture.harness.emit({
      type: 'session.error',
      properties: {
        sessionID: session.providerSessionId,
        error: { name: 'ProviderError', data: { message: 'stale provider failure' } }
      }
    });
    await staleWriteStarted;
    const winnerArtifact = await fixture.runtime.writeFinalArtifact(
      run.taskId,
      run.id,
      '# Concurrent terminal winner\n',
      `test:concurrent-terminal-winner:${run.id}`
    );
    await fixture.runtime.applyTaskRuntimeEvent(
      createDomainEvent({
        type: 'AGENT_RUN_INTERRUPTED',
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        agentSessionId: run.sessionId,
        serverInstanceId: (await fixture.runtime.getRun(run.id))!.serverInstanceId,
        source: 'ui',
        payload: {
          terminalReason: 'Concurrent terminal winner.',
          finalArtifactId: winnerArtifact.id
        }
      }),
      `test:concurrent-terminal-event:${run.id}`
    );
    releaseStaleWrite();
    await staleFailure;

    const snapshot = await fixture.store.snapshot();
    expect(await fixture.runtime.getRun(run.id)).toMatchObject({
      status: 'INTERRUPTED',
      terminalReason: 'Concurrent terminal winner.',
      finalArtifactId: winnerArtifact.id
    });
    expect(
      snapshot.events.filter(
        (event) =>
          event.runId === run.id &&
          ['AGENT_RUN_COMPLETED', 'AGENT_RUN_FAILED', 'AGENT_RUN_INTERRUPTED'].includes(
            event.type
          )
      )
    ).toHaveLength(1);
    expect((await fixture.runtime.getAgentSession(session.id))?.status).toBe('ACTIVE');
    expect(
      updates.filter((event) => event.type === 'run.terminal' && event.runId === run.id)
    ).toHaveLength(0);
    expect(await fixture.runtimeStore.readArtifact(winnerArtifact.id)).toBe(
      '# Concurrent terminal winner\n'
    );
    writeFinalArtifactSpy.mockRestore();
    unsubscribe();
    await fixture.adapter.shutdown();
  });

  it('reuses a durable final artifact when reconciliation retries partial terminal persistence', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    const turn = await fixture.adapter.startTurn({
      localRunId: run.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });
    const providerError = {
      name: 'APIError',
      data: {
        message: 'terminal persistence interrupted',
        statusCode: 502,
        isRetryable: true
      }
    };
    const originalAppendRunEventIfStatus =
      fixture.runtime.applyTaskRuntimeEventIfRunStatus.bind(fixture.runtime);
    let rejectedTerminalEvent = false;
    fixture.runtime.applyTaskRuntimeEventIfRunStatus = async (
      event,
      allowedStatuses,
      operationId
    ) => {
      if (
        !rejectedTerminalEvent &&
        ['AGENT_RUN_COMPLETED', 'AGENT_RUN_FAILED', 'AGENT_RUN_INTERRUPTED'].includes(event.type)
      ) {
        rejectedTerminalEvent = true;
        throw new Error('simulated failure after final artifact persistence');
      }
      return originalAppendRunEventIfStatus(event, allowedStatuses, operationId);
    };

    await fixture.harness.emit({
      type: 'session.error',
      properties: {
        sessionID: session.providerSessionId,
        error: providerError
      }
    });

    const partial = await fixture.store.snapshot();
    const partialRuntime = await fixture.runtime.snapshot();
    const partialArtifacts = partialRuntime.artifacts.filter(
      (artifact) => artifact.runId === run.id && artifact.kind === 'agent-final'
    );
    expect(rejectedTerminalEvent).toBe(true);
    expect(partialRuntime.runs.find((candidate) => candidate.id === run.id)?.status).toBe('RUNNING');
    expect(partialArtifacts).toHaveLength(1);
    expect(
      partial.events.filter(
        (event) =>
          event.runId === run.id &&
          ['AGENT_RUN_COMPLETED', 'AGENT_RUN_FAILED', 'AGENT_RUN_INTERRUPTED'].includes(event.type)
      )
    ).toHaveLength(0);

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
          id: 'msg_partial_terminal_retry',
          sessionID: session.providerSessionId!,
          role: 'assistant',
          parentID: turn.providerTurnId,
          error: providerError,
          time: { completed: Date.now() }
        },
        parts: []
      }
    ]);
    fixture.harness.statuses[session.providerSessionId!] = { type: 'idle' };

    await expect(fixture.adapter.reconcile()).resolves.toMatchObject({
      reconciledSessionIds: [session.id],
      recoveryRequiredSessionIds: []
    });
    fixture.runtime.applyTaskRuntimeEventIfRunStatus = originalAppendRunEventIfStatus;

    const recovered = await fixture.store.snapshot();
    const recoveredRuntime = await fixture.runtime.snapshot();
    const recoveredArtifacts = recoveredRuntime.artifacts.filter(
      (artifact) => artifact.runId === run.id && artifact.kind === 'agent-final'
    );
    const terminalEvents = recovered.events.filter(
      (event) => event.runId === run.id && event.type === 'AGENT_RUN_FAILED'
    );
    expect(recoveredRuntime.runs.find((candidate) => candidate.id === run.id)).toMatchObject({
      status: 'FAILED',
      finalArtifactId: partialArtifacts[0]!.id
    });
    expect(recoveredArtifacts).toEqual([
      expect.objectContaining({ id: partialArtifacts[0]!.id })
    ]);
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.payload).toMatchObject({
      finalArtifactId: partialArtifacts[0]!.id
    });
    await fixture.adapter.shutdown();
  });

  it('discards an in-flight recovery snapshot after its server generation is quarantined', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const oldRun = await createRun(fixture, session);
    await fixture.adapter.startTurn({
      localRunId: oldRun.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });
    const startedOldRun = (await fixture.runtime.getRun(oldRun.id))!;
    const oldServerId = startedOldRun.serverInstanceId!;
    const messages = fixture.harness.messages.get(session.providerSessionId!)!;
    messages.push({
      info: {
        id: 'msg_stale_snapshot',
        sessionID: session.providerSessionId!,
        role: 'assistant',
        parentID: startedOldRun.providerTurnId,
        finish: 'stop',
        tokens: { input: 5, output: 2, reasoning: 1 },
        time: { completed: Date.now() }
      },
      parts: [{
        id: 'prt_stale_snapshot',
        sessionID: session.providerSessionId!,
        messageID: 'msg_stale_snapshot',
        type: 'text',
        text: 'Stale terminal snapshot.'
      }]
    });
    fixture.harness.statuses[session.providerSessionId!] = { type: 'idle' };
    const originalUpdateSession = fixture.runtime.updateAgentSession.bind(fixture.runtime);
    let failInboundStatus = true;
    fixture.runtime.updateAgentSession = async (sessionId, update, operationId) => {
      if (sessionId === session.id && update.status === 'IDLE' && failInboundStatus) {
        failInboundStatus = false;
        throw new Error('simulated inbound status persistence failure');
      }
      return originalUpdateSession(sessionId, update, operationId);
    };
    const originalItemLookup = fixture.runtime.getAgentItemByProviderId.bind(fixture.runtime);
    let releaseOldSnapshot!: () => void;
    const oldSnapshotGate = new Promise<void>((resolve) => {
      releaseOldSnapshot = resolve;
    });
    let markOldSnapshotEntered!: () => void;
    const oldSnapshotEntered = new Promise<void>((resolve) => {
      markOldSnapshotEntered = resolve;
    });
    let blockOldSnapshot = true;
    fixture.runtime.getAgentItemByProviderId = async (...args) => {
      if (blockOldSnapshot && args[1] === 'prt_stale_snapshot') {
        blockOldSnapshot = false;
        markOldSnapshotEntered();
        await oldSnapshotGate;
      }
      return originalItemLookup(...args);
    };

    const oldRecovery = fixture.harness.emit({
      type: 'session.status',
      properties: {
        sessionID: session.providerSessionId,
        status: { type: 'idle' }
      }
    });
    await oldSnapshotEntered;

    const providerSession = fixture.harness.sessions.get(session.providerSessionId!)!;
    const expectedDirectory = providerSession.directory;
    const mismatchedDirectory = path.join(fixture.root, 'quarantine-mismatch');
    await fs.mkdir(mismatchedDirectory);
    providerSession.directory = mismatchedDirectory;
    await expect(
      fixture.adapter.readSession({
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      })
    ).rejects.toThrow('does not match its Task Monki worktree');
    providerSession.directory = expectedDirectory;

    expect(await fixture.runtime.getRun(oldRun.id)).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      serverInstanceId: oldServerId
    });
    const replacementSession = (await fixture.runtime.getAgentSession(session.id))!;
    const replacementRun = await createRun(fixture, replacementSession);
    let replacementStarted = false;
    const replacementStart = fixture.adapter.startTurn({
      localRunId: replacementRun.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: 'Retry on the replacement runtime.',
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    }).then((turn) => {
      replacementStarted = true;
      return turn;
    });
    await wait(100);
    expect(replacementStarted).toBe(false);
    expect(fixture.harness.supervisors).toHaveLength(2);
    expect(fixture.harness.promptBodies).toHaveLength(1);

    releaseOldSnapshot();
    await oldRecovery;
    await replacementStart;
    const runningReplacement = (await fixture.runtime.getRun(replacementRun.id))!;
    expect(runningReplacement.status).toBe('RUNNING');
    expect(runningReplacement.serverInstanceId).not.toBe(oldServerId);

    fixture.runtime.updateAgentSession = originalUpdateSession;
    fixture.runtime.getAgentItemByProviderId = originalItemLookup;

    const snapshot = await fixture.store.snapshot();
    const runtimeSnapshot = await fixture.runtime.snapshot();
    const storedReplacement = runtimeSnapshot.runs.find((run) => run.id === replacementRun.id)!;
    expect(storedReplacement.status).toBe('RUNNING');
    expect(storedReplacement.finalArtifactId).toBeUndefined();
    const storedOldRun = runtimeSnapshot.runs.find((run) => run.id === oldRun.id)!;
    expect(storedOldRun).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      serverInstanceId: oldServerId
    });
    expect(storedOldRun.finalArtifactId).toBeUndefined();
    expect(
      runtimeSnapshot.agentItems.some((item) => item.providerItemId === 'prt_stale_snapshot')
    ).toBe(false);
    expect(runtimeSnapshot.agentUsageSnapshots.some((usage) => usage.runId === oldRun.id)).toBe(false);
    expect(
      snapshot.events.filter(
        (event) =>
          (event.runId === oldRun.id || event.runId === replacementRun.id) &&
          ['AGENT_RUN_COMPLETED', 'AGENT_RUN_FAILED', 'AGENT_RUN_INTERRUPTED'].includes(event.type)
      )
    ).toHaveLength(0);
    expect((await fixture.runtime.getAgentSession(session.id))?.status).toBe('ACTIVE');
    await fixture.adapter.shutdown();
  });

  it('propagates reconciliation failures without poisoning the session operation queue', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    const turn = await fixture.adapter.startTurn({
      localRunId: run.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });
    fixture.harness.messages.set(
      session.providerSessionId!,
      { incompatible: true } as unknown as OpenCodeMessage[]
    );

    await expect(fixture.adapter.reconcile()).rejects.toThrow(
      'OpenCode message history is incompatible'
    );

    fixture.harness.messages.set(session.providerSessionId!, [
      {
        info: {
          id: turn.providerTurnId!,
          sessionID: session.providerSessionId!,
          role: 'user',
          time: { created: Date.now() }
        },
        parts: []
      }
    ]);
    fixture.harness.statuses[session.providerSessionId!] = { type: 'busy' };
    await expect(fixture.adapter.reconcile()).resolves.toMatchObject({
      reconciledSessionIds: [session.id],
      recoveryRequiredSessionIds: []
    });
    expect((await fixture.runtime.getRun(run.id))?.status).toBe('RUNNING');
    await fixture.adapter.shutdown();
  });

  it('owns one runtime per session and durably maps turns, interactions, output, and shutdown', async () => {
    const fixture = await createFixture();
    const { adapter, harness, runtime } = fixture;
    await adapter.initialize();
    expect((await adapter.preflight()).readiness.canStart).toBe(true);

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

    const running = (await runtime.getRun(run.id))!;
    expect(turn.providerTurnId).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
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
        metadata: { cwd: fixture.worktree.worktreePath },
        source: { messageID: turn.providerTurnId }
      }
    ];
    harness.questions = [];
    await adapter.attachSession({
      localSessionId: session.id,
      providerSessionId: session.providerSessionId
    });
    const pending = (await runtime.snapshot()).interactionRequests;
    expect(pending.map((item) => item.type)).toEqual(['COMMAND_APPROVAL']);
    expect((await runtime.getAgentSession(session.id))?.status).toBe(
      'AWAITING_APPROVAL'
    );
    const permission = pending.find((item) => item.type === 'COMMAND_APPROVAL')!;
    expect(permission.allowedActions).toContain('ACCEPT');
    expect(permission.allowedActions).not.toEqual(
      expect.arrayContaining([
        'ACCEPT_FOR_SESSION',
        'GRANT_SESSION',
        'DECLINE_FOR_SESSION'
      ])
    );
    await harness.emit({
      type: 'message.updated',
      properties: {
        info: {
          id: turn.providerTurnId,
          sessionID: session.providerSessionId,
          role: 'user',
          time: { created: Date.now() }
        }
      }
    });
    await harness.emit({
      type: 'session.status',
      properties: { sessionID: session.providerSessionId, status: { type: 'busy' } }
    });
    await adapter.readSession({
      localSessionId: session.id,
      providerSessionId: session.providerSessionId
    });
    await adapter.attachSession({
      localSessionId: session.id,
      providerSessionId: session.providerSessionId
    });
    await adapter.reconcile();
    expect(await runtime.getRun(run.id)).toMatchObject({ status: 'AWAITING_APPROVAL' });
    expect(await runtime.getAgentSession(session.id)).toMatchObject({
      status: 'AWAITING_APPROVAL'
    });
    const decision = { interactionType: 'COMMAND_APPROVAL', action: 'ACCEPT' } as const;
    await runtime.transitionInteractionRequest(permission.id, 'PENDING', {
      status: 'RESPONDING',
      decision,
      respondedAt: new Date().toISOString()
    }, `test:permission-response:${permission.id}`);
    await adapter.respondToInteraction({ interaction: permission, decision });
    expect((await runtime.getInteractionRequest(permission.id))?.status).toBe('RESOLVED');
    expect(harness.permissionReplies).toEqual([{ reply: 'once' }]);
    expect(await runtime.getRun(run.id)).toMatchObject({ status: 'RUNNING' });
    expect(await runtime.getAgentSession(session.id)).toMatchObject({ status: 'ACTIVE' });

    harness.permissions = [];
    harness.questions = [
      {
        id: 'que_1',
        sessionID: session.providerSessionId!,
        tool: { messageID: turn.providerTurnId },
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
    expect(
      (await runtime.snapshot()).interactionRequests.find(
        (item) => item.type === 'USER_INPUT'
      )?.status
    ).toBe('PENDING');
    expect((await runtime.getAgentSession(session.id))?.status).toBe(
      'AWAITING_USER_INPUT'
    );
    await harness.emit({
      type: 'message.updated',
      properties: {
        info: {
          id: turn.providerTurnId,
          sessionID: session.providerSessionId,
          role: 'user',
          time: { created: Date.now() }
        }
      }
    });
    expect(await runtime.getRun(run.id)).toMatchObject({ status: 'AWAITING_USER_INPUT' });
    expect(await runtime.getAgentSession(session.id)).toMatchObject({
      status: 'AWAITING_USER_INPUT'
    });
    harness.questions = [];
    await harness.emit({
      type: 'question.replied',
      properties: {
        requestID: 'que_1',
        sessionID: session.providerSessionId
      }
    });
    expect(
      (await runtime.snapshot()).interactionRequests.find(
        (item) => item.providerRequestId === 'que_1'
      )?.status
    ).toBe('STALE');
    expect(await runtime.getRun(run.id)).toMatchObject({ status: 'RUNNING' });
    expect(await runtime.getAgentSession(session.id)).toMatchObject({ status: 'ACTIVE' });

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
      id: 'evt_assistant',
      type: 'message.updated',
      properties: { info: assistant.info }
    });
    await harness.emit({
      id: 'evt_part',
      type: 'message.part.updated',
      properties: { part: assistant.parts[0] }
    });
    await harness.emit({
      id: 'evt_idle',
      type: 'session.idle',
      properties: { sessionID: session.providerSessionId }
    });

    const completed = (await runtime.getRun(run.id))!;
    expect(completed.status).toBe('COMPLETED');
    expect(completed.finalMessage).toBe('Implemented and verified.');
    expect((await runtime.getAgentItemsForRun(run.id))[0]).toEqual(
      expect.objectContaining({ providerItemId: 'prt_text_1', status: 'COMPLETED' })
    );
    expect(
      (await runtime.snapshot()).interactionRequests.find((item) => item.type === 'USER_INPUT')?.status
    ).toBe('STALE');

    await adapter.shutdown();
    expect(harness.catalogSupervisor.shutdownCount).toBe(1);
    expect(harness.sessionSupervisor.shutdownCount).toBe(1);
    expect(harness.stoppedStreams).toBe(1);
  });

  it('never resends an accepted prompt when post-ack persistence fails and reconciles by message id', async () => {
    const fixture = await createFixture();
    const { adapter, harness, store, runtime } = fixture;
    await adapter.initialize();
    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    const originalUpdateRun = runtime.updateRun.bind(runtime);
    let failedAcknowledgementWrite = false;
    runtime.updateRun = async (runId, update, operationId) => {
      if (
        harness.promptBodies.length === 1 &&
        update.status === 'RUNNING' &&
        !failedAcknowledgementWrite
      ) {
        failedAcknowledgementWrite = true;
        throw new Error('simulated durable store failure');
      }
      return originalUpdateRun(runId, update, operationId);
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
    const providerMessageId = (await runtime.getRun(run.id))?.providerTurnId;
    expect(providerMessageId).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);

    runtime.updateRun = originalUpdateRun;
    await runtime.applyTaskRuntimeEvent(
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
      }),
      `test:ambiguous-prompt-event:${run.id}`
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
    expect((await runtime.getRun(run.id))?.status).toBe('COMPLETED');
    expect(harness.promptBodies).toHaveLength(1);
    await adapter.shutdown();
  });

  it('coalesces high-volume text deltas while preserving ordered output and a terminal item', async () => {
    const fixture = await createFixture();
    const { adapter, harness, runtime, runtimeStore, appEvents } = fixture;
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
    const upsert = vi.spyOn(runtime, 'upsertAgentItem');

    await harness.emit({
      id: 'evt_stream_assistant',
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_assistant_stream',
          sessionID: session.providerSessionId,
          role: 'assistant',
          parentID: turn.providerTurnId,
          time: { created: Date.now() }
        }
      }
    });
    await harness.emit({
      id: 'evt_stream_part_started',
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_stream',
          sessionID: session.providerSessionId,
          messageID: 'msg_assistant_stream',
          type: 'text',
          text: ''
        }
      }
    });

    for (let index = 1; index <= 100; index += 1) {
      await harness.emit({
        id: `evt_delta_${index}`,
        type: 'message.part.delta',
        properties: {
          sessionID: session.providerSessionId,
          messageID: 'msg_assistant_stream',
          partID: 'prt_stream',
          field: 'text',
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
            text: 'x'.repeat(100),
            state: { status: 'completed', time: { end: Date.now() } }
          }
        ]
      }
    ]);
    await harness.emit({
      id: 'evt_stream_part_completed',
      type: 'message.part.updated',
      properties: {
        part: harness.messages.get(session.providerSessionId!)![1]!.parts[0]
      }
    });
    harness.statuses[session.providerSessionId!] = { type: 'idle' };
    await harness.emit({
      id: 'evt_stream_idle',
      type: 'session.idle',
      properties: { sessionID: session.providerSessionId }
    });

    expect(upsert).toHaveBeenCalledTimes(1);
    expect((await runtime.getAgentItemsForRun(run.id))[0]).toEqual(
      expect.objectContaining({ providerItemId: 'prt_stream', status: 'COMPLETED' })
    );
    const output = await runtimeStore.readArtifact(run.outputArtifactId);
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

  it('drains an SSE record whose journal write overlaps unexpected process exit', async () => {
    const fixture = await createFixture();
    const { session, run } = await startStreamingRun(fixture);
    const oldSupervisor = fixture.harness.sessionSupervisor;
    const appendProtocolMessage =
      fixture.runtimeStore.appendProtocolMessage.bind(fixture.runtimeStore);
    let releaseJournal!: () => void;
    const journalGate = new Promise<void>((resolve) => {
      releaseJournal = resolve;
    });
    let markJournalStarted!: () => void;
    const journalStarted = new Promise<void>((resolve) => {
      markJournalStarted = resolve;
    });
    vi.spyOn(fixture.runtimeStore, 'appendProtocolMessage').mockImplementation(
      async (...args) => {
        if (args[2].includes('evt_exit_drain')) {
          markJournalStarted();
          await journalGate;
        }
        return appendProtocolMessage(...args);
      }
    );

    const accepted = fixture.harness.emit({
      id: 'evt_exit_drain',
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_stream',
          sessionID: session.providerSessionId,
          messageID: 'msg_assistant_stream',
          type: 'text',
          text: 'drained before runtime loss',
          state: { status: 'completed', time: { end: Date.now() } }
        }
      }
    });
    await journalStarted;
    await oldSupervisor.lose();
    const replacement = fixture.adapter.attachSession({
      localSessionId: session.id,
      providerSessionId: session.providerSessionId
    });
    await wait(20);
    expect(fixture.harness.supervisors).toHaveLength(2);

    releaseJournal();
    await accepted;
    await replacement;

    const snapshot = await fixture.store.snapshot();
    const itemActivityIndex = snapshot.events.findIndex(
      (event) =>
        event.runId === run.id &&
        event.type === 'AGENT_ACTIVITY_RECEIVED' &&
        (event.payload as { eventType?: string }).eventType === 'item/text/completed'
    );
    const runtimeLossIndex = snapshot.events.findIndex(
      (event) => event.runId === run.id && event.type === 'AGENT_RUNTIME_LOST'
    );
    expect(itemActivityIndex).toBeGreaterThanOrEqual(0);
    expect(runtimeLossIndex).toBeGreaterThan(itemActivityIndex);
    expect(await fixture.runtimeStore.readArtifact(run.outputArtifactId)).toContain(
      'drained before runtime loss'
    );
    expect(fixture.harness.supervisors).toHaveLength(3);
    await fixture.adapter.shutdown();
  });

  it('preserves a concurrent terminal run when stale runtime-loss handling finishes later', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    await fixture.adapter.startTurn({
      localRunId: run.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });
    const winnerArtifact = await fixture.runtime.writeFinalArtifact(
      run.taskId,
      run.id,
      '# Concurrent completion winner\n',
      `test:concurrent-completion-winner:${run.id}`
    );
    const updates: AppUpdateEvent[] = [];
    const unsubscribe = fixture.appEvents.on((event) => updates.push(event));
    const internals = fixture.adapter as unknown as {
      materializeRunStreamBuffer(runId: string): Promise<void>;
      sessionExitDrains: Map<string, Promise<void>>;
    };
    const materializeRunStreamBuffer =
      internals.materializeRunStreamBuffer.bind(fixture.adapter);
    let releaseStaleRuntimeLoss!: () => void;
    const staleRuntimeLossGate = new Promise<void>((resolve) => {
      releaseStaleRuntimeLoss = resolve;
    });
    let markStaleRuntimeLossStarted!: () => void;
    const staleRuntimeLossStarted = new Promise<void>((resolve) => {
      markStaleRuntimeLossStarted = resolve;
    });
    let firstMaterialization = true;
    internals.materializeRunStreamBuffer = async (runId) => {
      if (runId === run.id && firstMaterialization) {
        firstMaterialization = false;
        markStaleRuntimeLossStarted();
        await staleRuntimeLossGate;
      }
      await materializeRunStreamBuffer(runId);
    };

    await fixture.harness.sessionSupervisor.lose();
    await staleRuntimeLossStarted;
    const exitDrain = internals.sessionExitDrains.get(session.id);
    expect(exitDrain).toBeDefined();
    await fixture.runtime.applyTaskRuntimeEvent(
      createDomainEvent({
        type: 'AGENT_RUN_COMPLETED',
        taskId: run.taskId,
        iterationId: run.iterationId,
        runId: run.id,
        worktreeId: run.worktreeId,
        agentSessionId: run.sessionId,
        serverInstanceId: (await fixture.runtime.getRun(run.id))!.serverInstanceId,
        source: 'provider',
        payload: {
          terminalStatus: 'completed',
          finalArtifactId: winnerArtifact.id
        }
      }),
      `test:concurrent-completion-event:${run.id}`
    );
    releaseStaleRuntimeLoss();
    await exitDrain;
    internals.materializeRunStreamBuffer = materializeRunStreamBuffer;

    const snapshot = await fixture.store.snapshot();
    expect(await fixture.runtime.getRun(run.id)).toMatchObject({
      status: 'COMPLETED',
      finalArtifactId: winnerArtifact.id
    });
    expect(
      snapshot.events.filter(
        (event) => event.runId === run.id && event.type === 'AGENT_RUNTIME_LOST'
      )
    ).toHaveLength(0);
    expect((await fixture.runtime.getAgentSession(session.id))?.status).toBe('ACTIVE');
    expect(
      updates.filter(
        (event) =>
          event.type === 'run.state.updated' &&
          event.runId === run.id &&
          (event.payload as { eventType?: string }).eventType === 'runtime/lost'
      )
    ).toHaveLength(0);
    unsubscribe();
    await fixture.adapter.shutdown();
  });

  it('bounds output persistence retries and quarantines the affected session once', async () => {
    const fixture = await createFixture();
    const { session, run } = await startStreamingRun(fixture);
    const appendArtifact = vi
      .spyOn(fixture.runtime, 'appendArtifact')
      .mockRejectedValue(new Error('simulated persistent output failure'));

    await fixture.harness.emit({
      type: 'message.part.delta',
      properties: {
        sessionID: session.providerSessionId,
        messageID: 'msg_assistant_stream',
        partID: 'prt_stream',
        field: 'text',
        delta: 'safe buffered output'
      }
    });

    await waitForCondition(
      async () =>
        appendArtifact.mock.calls.length === 2 &&
        (await fixture.runtime.getRun(run.id))?.status === 'RECOVERY_REQUIRED',
      4_000
    );
    await wait(250);
    expect(appendArtifact).toHaveBeenCalledTimes(2);
    expect(fixture.harness.stoppedStreams).toBe(1);
    await fixture.adapter.shutdown();
  });

  it('records runtime loss while a transient output failure retries within its bound', async () => {
    const fixture = await createFixture();
    const { session, run } = await startStreamingRun(fixture);
    const appendArtifact = fixture.runtime.appendArtifact.bind(fixture.runtime);
    const append = vi.spyOn(fixture.runtime, 'appendArtifact');
    append.mockRejectedValueOnce(new Error('simulated transient output failure'));
    append.mockImplementation((...args) => appendArtifact(...args));
    let outputPersisted = false;
    const unsubscribe = fixture.appEvents.on((event) => {
      if (
        event.type === 'run.output' &&
        event.runId === run.id &&
        (event.payload as { text?: string }).text ===
          'output retained across runtime loss'
      ) {
        outputPersisted = true;
      }
    });
    await fixture.harness.emit({
      type: 'message.part.delta',
      properties: {
        sessionID: session.providerSessionId,
        messageID: 'msg_assistant_stream',
        partID: 'prt_stream',
        field: 'text',
        delta: 'output retained across runtime loss'
      }
    });

    await fixture.harness.sessionSupervisor.lose();

    await waitForCondition(async () =>
      (await fixture.runtime.getRun(run.id))?.status === 'RECOVERY_REQUIRED'
    );
    await waitForCondition(() => outputPersisted, 4_000);
    expect(await fixture.runtimeStore.readArtifact(run.outputArtifactId)).toContain(
      'output retained across runtime loss'
    );
    expect(append).toHaveBeenCalledTimes(2);
    unsubscribe();
    await fixture.adapter.shutdown();
  });

  it('persists identical text from distinct protocol events across separate flushes', async () => {
    const fixture = await createFixture();
    const { session, run } = await startStreamingRun(fixture);
    const text = 'same provider chunk';

    for (let index = 1; index <= 2; index += 1) {
      await fixture.harness.emit({
        id: `evt_repeated_chunk_${index}`,
        type: 'message.part.delta',
        properties: {
          sessionID: session.providerSessionId,
          messageID: 'msg_assistant_stream',
          partID: 'prt_stream',
          field: 'text',
          delta: text
        }
      });
      await waitForCondition(async () =>
        (await fixture.runtimeStore.readArtifact(run.outputArtifactId))
          .replaceAll('\n[text]\n', '') === text.repeat(index)
      );
    }

    await fixture.adapter.shutdown();
  });

  it('keeps an unfinished native question recovery-required across restart and accepts a later retry', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    const turn = await fixture.adapter.startTurn({
      localRunId: run.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });
    await fixture.harness.emit({
      type: 'question.asked',
      properties: {
        id: 'que_restart',
        sessionID: session.providerSessionId,
        tool: { messageID: turn.providerTurnId },
        questions: [
          {
            header: 'Scope',
            question: 'Which scope should be used?',
            options: []
          }
        ]
      }
    });
    const originalServerId = (await fixture.runtime.getRun(run.id))!.serverInstanceId;
    fixture.harness.messages.set(session.providerSessionId!, [
      {
        info: {
          id: turn.providerTurnId!,
          sessionID: session.providerSessionId!,
          role: 'user',
          time: { created: Date.now() }
        },
        parts: []
      },
      {
        info: {
          id: 'msg_unfinished_question',
          sessionID: session.providerSessionId!,
          role: 'assistant',
          parentID: turn.providerTurnId,
          time: { created: Date.now() }
        },
        parts: [
          {
            id: 'prt_unfinished_question',
            sessionID: session.providerSessionId!,
            messageID: 'msg_unfinished_question',
            type: 'tool',
            tool: 'question',
            state: {
              status: 'running',
              input: {
                questions: [
                  {
                    header: 'Scope',
                    question: 'Which scope should be used?',
                    options: []
                  }
                ]
              },
              time: { start: Date.now() }
            }
          }
        ]
      }
    ]);
    fixture.harness.statuses[session.providerSessionId!] = { type: 'idle' };

    await fixture.harness.sessionSupervisor.lose();
    await waitForCondition(
      async () => (await fixture.runtime.getRun(run.id))?.status === 'RECOVERY_REQUIRED'
    );
    await fixture.adapter.shutdown();

    const replacement = createAdapterForFixture(fixture);
    await expect(replacement.initialize()).resolves.toBeUndefined();
    const recoveredRun = (await fixture.runtime.getRun(run.id))!;
    expect(recoveredRun).toMatchObject({ status: 'RECOVERY_REQUIRED' });
    expect(recoveredRun.finalArtifactId).toBeUndefined();
    expect(
      (await fixture.runtime.snapshot()).interactionRequests.find(
        (interaction) => interaction.providerRequestId === 'que_restart'
      )
    ).toMatchObject({
      status: 'ABORTED_SERVER_LOST',
      serverInstanceId: originalServerId
    });

    const finalArtifact = await fixture.runtime.writeFinalArtifact(
      run.taskId,
      run.id,
      '# Recovery run closed\n\nExplicitly abandoned before retry.\n',
      `test:recovery-run-final:${run.id}`
    );
    await fixture.runtime.applyTaskRuntimeEvent(createDomainEvent({
      type: 'AGENT_RUN_INTERRUPTED',
      taskId: run.taskId,
      iterationId: run.iterationId,
      runId: run.id,
      worktreeId: run.worktreeId,
      agentSessionId: run.sessionId,
      serverInstanceId: run.serverInstanceId,
      source: 'ui',
      payload: {
        terminalReason: 'Recovery-required run was explicitly abandoned.',
        finalArtifactId: finalArtifact.id
      }
    }), `test:recovery-run-interrupted:${run.id}`);
    const nextRun = await createRun(
      fixture,
      (await fixture.runtime.getAgentSession(session.id))!
    );
    await replacement.startTurn({
      localRunId: nextRun.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: 'RETRY',
      prompt: 'Start a new question after recovery.',
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });

    expect(await fixture.runtime.getRun(nextRun.id)).toMatchObject({ status: 'RUNNING' });
    expect(fixture.harness.promptBodies).toHaveLength(2);
    await replacement.shutdown();
    await fixture.persistence.close();
    const reopened = await openTestPersistence(path.join(fixture.root, 'profile'));
    await expect(reopened.tasks.snapshot()).resolves.toMatchObject({
      runs: expect.arrayContaining([
        expect.objectContaining({ id: run.id, status: 'INTERRUPTED' }),
        expect.objectContaining({ id: nextRun.id, status: 'RUNNING' })
      ])
    });
    await reopened.close();
  });

  it('never retries an output append with ambiguous durable state', async () => {
    const fixture = await createFixture();
    const { session, run } = await startStreamingRun(fixture);
    const appendArtifact = vi.spyOn(fixture.runtime, 'appendArtifact').mockRejectedValue(
      new AgentRuntimeArtifactMutationAmbiguousError(
        'simulated ambiguous artifact append',
        { cause: new Error('simulated snapshot failure and rollback failure') }
      )
    );

    await fixture.harness.emit({
      type: 'message.part.delta',
      properties: {
        sessionID: session.providerSessionId,
        messageID: 'msg_assistant_stream',
        partID: 'prt_stream',
        field: 'text',
        delta: 'ambiguous output'
      }
    });

    await waitForCondition(async () =>
      (await fixture.runtime.getRun(run.id))?.status === 'RECOVERY_REQUIRED'
    );
    await wait(200);
    expect(appendArtifact).toHaveBeenCalledTimes(1);
    expect(fixture.harness.stoppedStreams).toBe(1);
    await fixture.adapter.shutdown();
  });

  it('flushes healthy large output and fences only when retained output cannot persist', async () => {
    const largeDelta = 'x'.repeat(512 * 1024 + 1);
    const healthy = await createFixture();
    const healthyStream = await startStreamingRun(healthy);

    await healthy.harness.emit({
      type: 'message.part.delta',
      properties: {
        sessionID: healthyStream.session.providerSessionId,
        messageID: 'msg_assistant_stream',
        partID: 'prt_stream',
        field: 'text',
        delta: largeDelta
      }
    });

    expect(await healthy.runtimeStore.readArtifact(healthyStream.run.outputArtifactId)).toContain(
      largeDelta
    );
    expect((await healthy.runtime.getRun(healthyStream.run.id))?.status).toBe('RUNNING');
    await healthy.adapter.shutdown();

    const failing = await createFixture();
    const failingStream = await startStreamingRun(failing);
    const appendArtifact = vi
      .spyOn(failing.runtime, 'appendArtifact')
      .mockRejectedValue(new Error('simulated unavailable output store'));
    await failing.harness.emit({
      type: 'message.part.delta',
      properties: {
        sessionID: failingStream.session.providerSessionId,
        messageID: 'msg_assistant_stream',
        partID: 'prt_stream',
        field: 'text',
        delta: largeDelta
      }
    });

    await waitForCondition(async () =>
      (await failing.runtime.getRun(failingStream.run.id))?.status === 'RECOVERY_REQUIRED'
    );
    await wait(200);
    expect(appendArtifact).toHaveBeenCalledTimes(1);
    expect(failing.harness.stoppedStreams).toBe(1);
    await failing.adapter.shutdown();
  }, 15_000);

  it('redacts exact credentials split across output flushes, including self-overlap', async () => {
    const fixture = await createFixture({
      environment: {
        XAI_API_KEY: 'opaque-provider-credential-1742',
        GROK_API_KEY: 'aaaaaaaa'
      }
    });
    const outputUpdates: AppUpdateEvent[] = [];
    const unsubscribe = fixture.appEvents.on((event) => {
      if (event.type === 'run.output') outputUpdates.push(event);
    });
    const { session, run } = await startStreamingRun(fixture);
    const emitDelta = (delta: string) => fixture.harness.emit({
      type: 'message.part.delta',
      properties: {
        sessionID: session.providerSessionId,
        messageID: 'msg_assistant_stream',
        partID: 'prt_stream',
        field: 'text',
        delta
      }
    });

    await emitDelta('safe opaque-provider-');
    await waitForCondition(async () =>
      (await fixture.runtimeStore.readArtifact(run.outputArtifactId)).includes('safe ')
    );
    expect(await fixture.runtimeStore.readArtifact(run.outputArtifactId)).not.toContain(
      'opaque-provider-'
    );
    await emitDelta('credential-1742 / ');
    await emitDelta('aaaa');
    await emitDelta('aaaa');
    await fixture.harness.emit({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_stream',
          sessionID: session.providerSessionId,
          messageID: 'msg_assistant_stream',
          type: 'text',
          text: 'safe opaque-provider-credential-1742 / aaaaaaaa',
          state: { status: 'completed', time: { end: Date.now() } }
        }
      }
    });

    const expected = 'safe [REDACTED] / [REDACTED]';
    const artifact = await fixture.runtimeStore.readArtifact(run.outputArtifactId);
    const emitted = outputUpdates
      .filter((event) => event.runId === run.id)
      .map((event) => (event.payload as { text: string }).text)
      .join('');
    expect(artifact.replaceAll('\n[text]\n', '')).toBe(expected);
    expect(emitted).toBe(expected);
    for (const leaked of [
      'opaque-provider-credential-1742',
      'opaque-provider-',
      'credential-1742',
      'aaaaaaaa'
    ]) {
      expect(artifact).not.toContain(leaked);
      expect(emitted).not.toContain(leaked);
    }
    unsubscribe();
    await fixture.adapter.shutdown();
  }, 15_000);

  it('accumulates assistant-step usage and ignores duplicate terminal updates', async () => {
    const fixture = await createFixture();
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
    const first = {
      id: 'msg_usage_step_1',
      sessionID: session.providerSessionId!,
      role: 'assistant' as const,
      parentID: turn.providerTurnId,
      finish: 'tool-calls',
      tokens: { input: 10, output: 3, reasoning: 1, cache: { read: 2, write: 0 } },
      time: { created: 1, completed: 2 }
    };
    const second = {
      id: 'msg_usage_step_2',
      sessionID: session.providerSessionId!,
      role: 'assistant' as const,
      parentID: turn.providerTurnId,
      finish: 'stop',
      tokens: { input: 4, output: 2, cache: { read: 1, write: 0 } },
      time: { created: 3, completed: 4 }
    };

    await fixture.harness.emit({
      type: 'message.updated',
      properties: { info: first }
    });
    await fixture.harness.emit({
      type: 'message.updated',
      properties: { info: second }
    });
    await fixture.harness.emit({
      type: 'message.updated',
      properties: { info: second }
    });

    const usage = (await fixture.runtime.snapshot()).agentUsageSnapshots.filter(
      (snapshot) => snapshot.runId === run.id
    );
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({
      total: {
        totalTokens: 23,
        inputTokens: 14,
        cachedInputTokens: 3,
        outputTokens: 5,
        reasoningOutputTokens: 1
      },
      last: {
        totalTokens: 7,
        inputTokens: 4,
        cachedInputTokens: 1,
        outputTokens: 2,
        reasoningOutputTokens: 0
      }
    });
    await fixture.adapter.shutdown();
  });

  it('recomputes an evicted terminal usage entry without replaying fresh IDs', async () => {
    const fixture = await createFixture();
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
    const terminal = {
      id: 'msg_usage_evicted',
      sessionID: session.providerSessionId!,
      role: 'assistant' as const,
      parentID: turn.providerTurnId,
      finish: 'stop',
      tokens: { input: 8, output: 3, reasoning: 1, cache: { read: 2, write: 0 } },
      time: { created: 1, completed: 2 }
    };
    fixture.harness.messages.get(session.providerSessionId!)!.push({
      info: terminal,
      parts: []
    });
    await fixture.harness.emit({
      type: 'message.updated',
      properties: { info: terminal }
    });

    const internals = fixture.adapter as unknown as {
      rememberAssistantUsage(
        sessionId: string,
        messageId: string,
        tracked: {
          runId: string;
          usage: {
            totalTokens: number;
            inputTokens: number;
            cachedInputTokens: number;
            outputTokens: number;
            reasoningOutputTokens: number;
          };
          createdAt: number;
        }
      ): void;
      assistantMessageUsage: Map<string, Map<string, unknown>>;
    };
    for (let index = 0; index < 2_048; index += 1) {
      internals.rememberAssistantUsage(session.id, `msg_cache_${index}`, {
        runId: run.id,
        usage: {
          totalTokens: 0,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0
        },
        createdAt: index + 2
      });
    }
    expect(internals.assistantMessageUsage.get(session.id)?.has(terminal.id)).toBe(false);

    const messageReadsBeforeReplay = fixture.harness.messageReadCount;
    await fixture.harness.emit({
      type: 'message.updated',
      properties: { info: terminal }
    });

    expect(fixture.harness.messageReadCount).toBe(messageReadsBeforeReplay + 1);
    const usage = (await fixture.runtime.snapshot()).agentUsageSnapshots.filter(
      (snapshot) => snapshot.runId === run.id
    );
    expect(usage).toHaveLength(1);
    expect(usage[0]?.total).toEqual({
      totalTokens: 14,
      inputTokens: 8,
      cachedInputTokens: 2,
      outputTokens: 3,
      reasoningOutputTokens: 1
    });

    const freshTerminal = {
      ...terminal,
      id: 'msg_usage_fresh_after_eviction',
      tokens: { input: 2, output: 1 },
      time: { created: 3, completed: 4 }
    };
    fixture.harness.messages.get(session.providerSessionId!)!.push({
      info: freshTerminal,
      parts: []
    });
    const messageReadsBeforeFreshTerminal = fixture.harness.messageReadCount;
    await fixture.harness.emit({
      type: 'message.updated',
      properties: { info: freshTerminal }
    });

    expect(fixture.harness.messageReadCount).toBe(messageReadsBeforeFreshTerminal);
    const updatedUsage = (await fixture.runtime.snapshot()).agentUsageSnapshots.filter(
      (snapshot) => snapshot.runId === run.id
    );
    expect(updatedUsage).toHaveLength(2);
    expect(updatedUsage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          total: {
            totalTokens: 17,
            inputTokens: 10,
            cachedInputTokens: 2,
            outputTokens: 4,
            reasoningOutputTokens: 1
          },
          last: {
            totalTokens: 3,
            inputTokens: 2,
            cachedInputTokens: 0,
            outputTokens: 1,
            reasoningOutputTokens: 0
          }
        })
      ])
    );
    await fixture.adapter.shutdown();
  });

  it('recomputes a replayed terminal message from history after runtime release and reattach', async () => {
    const fixture = await createFixture();
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
    const terminal = {
      id: 'msg_usage_replayed_after_reattach',
      sessionID: session.providerSessionId!,
      role: 'assistant' as const,
      parentID: turn.providerTurnId,
      finish: 'tool-calls',
      tokens: { input: 12, output: 4, reasoning: 2, cache: { read: 3, write: 1 } },
      time: { created: 1, completed: 2 }
    };
    fixture.harness.messages.get(session.providerSessionId!)!.push({
      info: terminal,
      parts: []
    });

    await fixture.harness.emit({
      type: 'message.updated',
      properties: { info: terminal }
    });

    const providerSession = fixture.harness.sessions.get(session.providerSessionId!)!;
    const expectedDirectory = providerSession.directory;
    const mismatchedDirectory = path.join(fixture.root, 'usage-reattach-mismatch');
    await fs.mkdir(mismatchedDirectory);
    providerSession.directory = mismatchedDirectory;
    await expect(
      fixture.adapter.readSession({
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      })
    ).rejects.toThrow('does not match its Task Monki worktree');
    providerSession.directory = expectedDirectory;
    await fixture.adapter.attachSession({
      localSessionId: session.id,
      providerSessionId: session.providerSessionId
    });
    expect(await fixture.runtime.getRun(run.id)).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      serverInstanceId: fixture.harness.sessionSupervisor.currentServer?.id
    });

    const messageReadsBeforeReplay = fixture.harness.messageReadCount;
    await fixture.harness.emit({
      type: 'message.updated',
      properties: { info: terminal }
    });

    const usage = (await fixture.runtime.snapshot()).agentUsageSnapshots.filter(
      (snapshot) => snapshot.runId === run.id
    );
    expect(fixture.harness.messageReadCount).toBe(messageReadsBeforeReplay + 1);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      total: {
        totalTokens: 22,
        inputTokens: 12,
        cachedInputTokens: 3,
        outputTokens: 4,
        reasoningOutputTokens: 2
      },
      last: {
        totalTokens: 22,
        inputTokens: 12,
        cachedInputTokens: 3,
        outputTokens: 4,
        reasoningOutputTokens: 2
      }
    });
    await fixture.adapter.shutdown();
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
          event.type === 'run.state.updated' &&
          (event.payload as { eventType?: string }).eventType === 'runtime/lost'
      )
    );

    const activityTypes = updates
      .filter((event) => event.type === 'run.state.updated' && event.runId === run.id)
      .map((event) => (event.payload as { eventType?: string }).eventType);
    expect(activityTypes).toContain('runtime/reconciled');
    expect(activityTypes).toContain('runtime/protocol-incident');
    expect(activityTypes).toContain('runtime/lost');
    unsubscribe();
    await fixture.adapter.shutdown();
  });

  it('coalesces failed inbound persistence into one authoritative session snapshot', async () => {
    const fixture = await createFixture();
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
    const messages = fixture.harness.messages.get(session.providerSessionId!)!;
    const userMessage = messages.find((message) => message.info.id === turn.providerTurnId)!;
    Object.assign(userMessage.info, {
      providerID: 'anthropic',
      modelID: 'claude-test',
      variant: 'high'
    });
    userMessage.parts = [{
      id: 'prt_recovered_user',
      sessionID: session.providerSessionId!,
      messageID: turn.providerTurnId!,
      type: 'text',
      text: fixture.task.prompt
    }];
    messages.push({
      info: {
        id: 'msg_recovered_assistant',
        sessionID: session.providerSessionId!,
        role: 'assistant',
        parentID: turn.providerTurnId,
        finish: 'stop',
        tokens: { input: 7, output: 3, reasoning: 1 },
        time: { completed: Date.now() }
      },
      parts: [{
        id: 'prt_recovered_assistant',
        sessionID: session.providerSessionId!,
        messageID: 'msg_recovered_assistant',
        type: 'text',
        text: 'Recovered from the provider snapshot.'
      }]
    });
    messages.push({
      info: {
        id: 'msg_recovered_assistant_final',
        sessionID: session.providerSessionId!,
        role: 'assistant',
        parentID: turn.providerTurnId,
        finish: 'stop',
        tokens: { input: 5, output: 2, cache: { read: 1, write: 0 } },
        time: { completed: Date.now() }
      },
      parts: [{
        id: 'prt_recovered_assistant_final',
        sessionID: session.providerSessionId!,
        messageID: 'msg_recovered_assistant_final',
        type: 'text',
        text: 'Recovered final assistant step.'
      }]
    });
    fixture.harness.todos.set(session.providerSessionId!, [
      { content: 'Recover provider state', status: 'in_progress' }
    ]);
    fixture.harness.permissions = [{
      id: 'per_recovered',
      sessionID: session.providerSessionId!,
      action: 'bash',
      resources: ['npm test'],
      source: { messageID: turn.providerTurnId }
    }];
    const baseline = {
      session: fixture.harness.sessionReadCount,
      messages: fixture.harness.messageReadCount,
      status: fixture.harness.statusReadCount,
      permission: fixture.harness.permissionReadCount,
      question: fixture.harness.questionReadCount,
      todo: fixture.harness.todoReadCount
    };
    const originalUpdate = fixture.runtime.updateAgentSession.bind(fixture.runtime);
    let remainingFailures = 1;
    fixture.runtime.updateAgentSession = async (sessionId, update, operationId) => {
      if (sessionId === session.id && update.status === 'ACTIVE' && remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error('simulated inbound persistence failure');
      }
      return originalUpdate(sessionId, update, operationId);
    };

    await fixture.harness.emitConcurrent([
      {
        type: 'session.status',
        properties: { sessionID: session.providerSessionId, status: { type: 'busy' } }
      },
      {
        type: 'session.status',
        properties: { sessionID: session.providerSessionId, status: { type: 'busy' } }
      }
    ]);
    fixture.runtime.updateAgentSession = originalUpdate;

    expect(remainingFailures).toBe(0);
    expect(fixture.harness.sessionReadCount - baseline.session).toBe(1);
    expect(fixture.harness.messageReadCount - baseline.messages).toBe(1);
    expect(fixture.harness.statusReadCount - baseline.status).toBe(1);
    expect(fixture.harness.permissionReadCount - baseline.permission).toBe(1);
    expect(fixture.harness.questionReadCount - baseline.question).toBe(1);
    expect(fixture.harness.todoReadCount - baseline.todo).toBe(1);
    const snapshot = await fixture.runtime.snapshot();
    expect(snapshot.agentItems.filter((item) => item.runId === run.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerItemId: 'prt_recovered_user' }),
        expect.objectContaining({ providerItemId: 'prt_recovered_assistant' }),
        expect.objectContaining({ providerItemId: 'prt_recovered_assistant_final' })
      ])
    );
    expect(snapshot.agentPlanRevisions.filter((revision) => revision.runId === run.id))
      .toHaveLength(1);
    expect(snapshot.agentUsageSnapshots.filter((usage) => usage.runId === run.id))
      .toEqual([
        expect.objectContaining({
          total: {
            totalTokens: 19,
            inputTokens: 12,
            cachedInputTokens: 1,
            outputTokens: 5,
            reasoningOutputTokens: 1
          },
          last: {
            totalTokens: 8,
            inputTokens: 5,
            cachedInputTokens: 1,
            outputTokens: 2,
            reasoningOutputTokens: 0
          }
        })
      ]);
    expect(snapshot.interactionRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerRequestId: 'per_recovered',
          runId: run.id,
          status: 'PENDING'
        })
      ])
    );
    expect(await fixture.runtime.getRun(run.id)).toMatchObject({
      status: 'AWAITING_APPROVAL',
      recoveryState: 'RECOVERED'
    });
    expect(await fixture.runtime.getAgentSession(session.id)).toMatchObject({
      status: 'AWAITING_APPROVAL'
    });
    expect(fixture.harness.promptBodies).toHaveLength(1);
    expect(fixture.harness.permissionReplies).toEqual([]);
    await fixture.adapter.shutdown();
  });

  it('quarantines a generation when its one inbound recovery snapshot cannot persist', async () => {
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
    fixture.harness.todos.set(session.providerSessionId!, [
      { content: 'Persist provider plan', status: 'in_progress' }
    ]);
    const originalRecordPlan = fixture.runtime.recordAgentPlanRevision.bind(fixture.runtime);
    let remainingFailures = 2;
    fixture.runtime.recordAgentPlanRevision = async (record, operationId) => {
      if (record.runId === run.id && remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error('simulated repeated plan persistence failure');
      }
      return originalRecordPlan(record, operationId);
    };

    await expect(fixture.harness.emit({
      type: 'todo.updated',
      properties: {
        sessionID: session.providerSessionId,
        todos: [{ content: 'Persist provider plan', status: 'in_progress' }]
      }
    })).rejects.toThrow('inbound persistence recovery failed');
    fixture.runtime.recordAgentPlanRevision = originalRecordPlan;

    expect(remainingFailures).toBe(0);
    expect(await fixture.runtime.getAgentSession(session.id)).toMatchObject({
      status: 'NOT_LOADED'
    });
    expect(await fixture.runtime.getRun(run.id)).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      recoveryState: 'REQUIRES_USER_ACTION'
    });
    expect(fixture.harness.promptBodies).toHaveLength(1);
    expect(fixture.harness.permissionReplies).toEqual([]);
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
    const projectSettings: AgentExecutionSettings = {
      ...SETTINGS,
      modelProvider: 'xai',
      model: 'grok-code',
      reasoningEffort: 'fast'
    };
    const session = await createLocalSession(fixture, {
      requestedSettings: projectSettings
    });
    const run = await createRun(fixture, session, projectSettings);
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

    const staleSession = await createLocalSession(fixture);
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
    const stoppedStreamsBeforeIdleEviction = fixture.harness.stoppedStreams;

    await fixture.harness.emit({
      type: 'session.idle',
      properties: { sessionID: session.providerSessionId }
    });
    await wait(60);
    expect(firstSupervisor.shutdownCount).toBe(0);
    expect(fixture.harness.stoppedStreams).toBe(
      stoppedStreamsBeforeIdleEviction
    );

    const providerMessageId = (await fixture.runtime.getRun(run.id))!.providerTurnId!;
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
    expect(fixture.harness.stoppedStreams).toBe(
      stoppedStreamsBeforeIdleEviction + 1
    );

    const continuedSession = (await fixture.runtime.getAgentSession(session.id))!;
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
    expect((await fixture.runtime.getAgentSession(session.id))?.status).toBe('NOT_LOADED');
    await fixture.adapter.shutdown();
  });

  it('retains a failed session teardown as a hard fence until shutdown is confirmed', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const supervisor = fixture.harness.sessionSupervisor;
    supervisor.shutdownFailure = new Error('simulated session shutdown failure');

    await expect(
      fixture.adapter.releaseSession({
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      })
    ).rejects.toThrow('simulated session shutdown failure');
    expect(supervisor.shutdownCount).toBe(1);
    expect(supervisor.startCount).toBe(1);

    await expect(
      fixture.adapter.readSession({
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      })
    ).rejects.toThrow('termination of its previous runtime is unconfirmed');
    expect(fixture.harness.supervisors).toHaveLength(2);
    expect(supervisor.startCount).toBe(1);

    supervisor.shutdownFailure = undefined;
    await fixture.adapter.releaseSession({
      localSessionId: session.id,
      providerSessionId: session.providerSessionId
    });
    await fixture.adapter.readSession({
      localSessionId: session.id,
      providerSessionId: session.providerSessionId
    });
    expect(fixture.harness.supervisors).toHaveLength(3);
    expect(fixture.harness.sessionSupervisor).not.toBe(supervisor);
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
      repositoryId: fixture.task.repositoryId,
      agentSettings: SETTINGS
    });
    const targetOwnership = await fixture.store.createIterationAndWorktree({
      task: targetTask,
      branchName: 'codex/opencode-target-alternative',
      worktreePath: targetWorktreePath,
      baseSha: 'base-sha'
    });
    const target = await createLocalSession(fixture, {
      task: targetTask,
      iteration: targetOwnership.iteration,
      worktree: targetOwnership.worktree,
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
    expect(fixture.harness.permissionPatchBodies).toEqual([
      { permission: openCodePermissionRules(SETTINGS) }
    ]);
    expect(forked).toMatchObject({
      status: 'IDLE',
      materialized: true,
      observedSettings: { approvalPolicy: 'on-request' }
    });
    expect(
      fixture.harness.sessions.get(forked.providerSessionId!)?.directory
    ).toBe(targetWorktreePath);
    await fixture.adapter.shutdown();
  });

  it('deletes an unowned native fork when ownership persistence fails', async () => {
    const fixture = await createFixture({ sessionIdleTimeoutMs: 20 });
    await fixture.adapter.initialize();
    const source = await materializeSession(fixture);
    const target = await createLocalSession(fixture, {
      role: 'ALTERNATIVE',
      requestedSettings: SETTINGS,
      forkedFromSessionId: source.id
    });
    const originalUpdate = fixture.runtime.updateAgentSession.bind(fixture.runtime);
    fixture.runtime.updateAgentSession = async (sessionId, update, operationId) => {
      if (sessionId === target.id && update.providerSessionId) {
        throw new Error('simulated durable fork ownership failure');
      }
      return originalUpdate(sessionId, update, operationId);
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
    ).rejects.toThrow('can be retried safely');
    expect(fixture.harness.forkRequests).toHaveLength(1);
    const forkedSessionId = fixture.harness.deletedSessionIds[0];
    expect(forkedSessionId).toMatch(/^ses_/u);
    expect(fixture.harness.sessions.has(forkedSessionId!)).toBe(false);
    expect((await fixture.runtime.getAgentSession(target.id))?.providerSessionId).toBeUndefined();
    await waitForCondition(
      () => fixture.harness.sessionSupervisor.shutdownCount === 1
    );
    fixture.runtime.updateAgentSession = originalUpdate;
    await fixture.adapter.shutdown();
  });

  it('never deletes a provider session that is already owned when fork returns a duplicate id', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    const source = await materializeSession(fixture);
    const target = await createLocalSession(fixture, {
      role: 'ALTERNATIVE',
      requestedSettings: SETTINGS,
      forkedFromSessionId: source.id
    });
    fixture.harness.returnSourceIdOnFork = true;

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
      operation: 'session/fork-cleanup'
    });
    expect(fixture.harness.deletedSessionIds).toEqual([]);
    expect(fixture.harness.sessions.has(source.providerSessionId!)).toBe(true);
    expect(
      await fixture.runtime.getAgentSessionByProviderId(
        'opencode',
        source.providerSessionId!
      )
    ).toMatchObject({ id: source.id });
    expect((await fixture.runtime.getAgentSession(target.id))?.providerSessionId).toBeUndefined();
    expect(fixture.harness.sessionSupervisor.shutdownCount).toBe(1);
    await fixture.adapter.shutdown();
  });

  it('does not delete a fork when its durable ownership cannot be confirmed', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    const source = await materializeSession(fixture);
    const target = await createLocalSession(fixture, {
      role: 'ALTERNATIVE',
      requestedSettings: SETTINGS,
      forkedFromSessionId: source.id
    });
    const originalUpdate = fixture.runtime.updateAgentSession.bind(fixture.runtime);
    const originalGet = fixture.runtime.getAgentSession.bind(fixture.runtime);
    let committedForkId: string | undefined;
    let failConfirmationRead = true;
    fixture.runtime.updateAgentSession = async (sessionId, update, operationId) => {
      const stored = await originalUpdate(sessionId, update, operationId);
      if (sessionId === target.id && update.providerSessionId) {
        committedForkId = update.providerSessionId;
        throw new Error('simulated lost ownership-write acknowledgement');
      }
      return stored;
    };
    fixture.runtime.getAgentSession = async (sessionId) => {
      if (sessionId === target.id && committedForkId && failConfirmationRead) {
        failConfirmationRead = false;
        throw new Error('simulated ownership confirmation read failure');
      }
      return originalGet(sessionId);
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
      operation: 'session/fork-ownership'
    });
    expect(committedForkId).toMatch(/^ses_/u);
    expect(fixture.harness.deletedSessionIds).toEqual([]);
    expect(fixture.harness.sessions.has(committedForkId!)).toBe(true);
    fixture.runtime.updateAgentSession = originalUpdate;
    fixture.runtime.getAgentSession = originalGet;
    expect(await fixture.runtime.getAgentSession(target.id)).toMatchObject({
      providerSessionId: committedForkId
    });
    await fixture.adapter.shutdown();
  });

  it('quarantines the target runtime when unowned fork deletion is unconfirmed', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    const source = await materializeSession(fixture);
    const target = await createLocalSession(fixture, {
      role: 'ALTERNATIVE',
      requestedSettings: SETTINGS,
      forkedFromSessionId: source.id
    });
    const originalUpdate = fixture.runtime.updateAgentSession.bind(fixture.runtime);
    fixture.runtime.updateAgentSession = async (sessionId, update, operationId) => {
      if (sessionId === target.id && update.providerSessionId) {
        throw new Error('simulated durable fork ownership failure');
      }
      return originalUpdate(sessionId, update, operationId);
    };
    fixture.harness.failNextSessionDeleteBeforeAccept = true;

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
      operation: 'session/fork-cleanup'
    });
    expect(fixture.harness.forkRequests).toHaveLength(1);
    expect(fixture.harness.deletedSessionIds).toEqual([]);
    expect(fixture.harness.sessionSupervisor.shutdownCount).toBe(1);
    fixture.runtime.updateAgentSession = originalUpdate;
    await fixture.adapter.shutdown();
  });

  it('resumes an awaiting run when reconciliation proves the provider queue is empty', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const run = await createRun(fixture, session);
    const turn = await fixture.adapter.startTurn({
      localRunId: run.id,
      session: {
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });
    await fixture.harness.emit({
      type: 'permission.asked',
      properties: {
        id: 'per_missing_from_queue',
        sessionID: session.providerSessionId,
        action: 'bash',
        resources: ['npm test'],
        source: { messageID: turn.providerTurnId }
      }
    });
    expect(await fixture.runtime.getRun(run.id)).toMatchObject({
      status: 'AWAITING_APPROVAL'
    });

    await fixture.adapter.attachSession({
      localSessionId: session.id,
      providerSessionId: session.providerSessionId
    });

    expect(
      (await fixture.runtime.snapshot()).interactionRequests.find(
        (interaction) => interaction.providerRequestId === 'per_missing_from_queue'
      )
    ).toMatchObject({
      status: 'STALE',
      resolution: { providerQueueAbsent: true }
    });
    expect(await fixture.runtime.getRun(run.id)).toMatchObject({ status: 'RUNNING' });
    expect(await fixture.runtime.getAgentSession(session.id)).toMatchObject({ status: 'ACTIVE' });
    await fixture.adapter.shutdown();
  });

  it('marks post-ack interaction persistence failure ambiguous and never retries the reply', async () => {
    const fixture = await createFixture();
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
    await fixture.harness.emit({
      type: 'permission.asked',
      properties: {
        id: 'per_ambiguous',
        sessionID: session.providerSessionId,
        action: 'bash',
        resources: ['npm test'],
        source: { messageID: turn.providerTurnId }
      }
    });
    const interaction = (await fixture.runtime.snapshot()).interactionRequests[0];
    const decision = { interactionType: 'COMMAND_APPROVAL', action: 'ACCEPT' } as const;
    await fixture.runtime.transitionInteractionRequest(interaction.id, 'PENDING', {
      status: 'RESPONDING',
      decision,
      respondedAt: new Date().toISOString()
    }, `test:interaction-responding:${interaction.id}`);
    const originalTransition =
      fixture.runtime.transitionInteractionRequest.bind(fixture.runtime);
    let failedResolutionWrite = false;
    fixture.runtime.transitionInteractionRequest = async (...args) => {
      if (fixture.harness.permissionReplies.length === 1 && !failedResolutionWrite) {
        failedResolutionWrite = true;
        throw new Error('simulated durable response failure');
      }
      return originalTransition(...args);
    };

    await expect(
      fixture.adapter.respondToInteraction({ interaction, decision })
    ).rejects.toBeInstanceOf(AgentMutationAmbiguousError);
    expect(fixture.harness.permissionReplies).toHaveLength(1);
    fixture.runtime.transitionInteractionRequest = originalTransition;
    await fixture.adapter.shutdown();
  });

  it('quarantines credential-colliding interaction IDs before persistence', async () => {
    const opaque = 'm7Qp4Vz9Lk2Nc8';
    const fixture = await createFixture({ environment: { XAI_API_KEY: opaque } });
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

    await fixture.harness.emit({
      type: 'permission.asked',
      properties: {
        id: opaque,
        sessionID: session.providerSessionId,
        action: 'bash',
        resources: ['npm test'],
        source: { messageID: turn.providerTurnId }
      }
    });

    expect((await fixture.runtime.snapshot()).interactionRequests).toHaveLength(0);
    expect(fixture.harness.sessionSupervisor.shutdownCount).toBeGreaterThan(0);
    expect(JSON.stringify((await fixture.store.snapshot()).events)).not.toContain(opaque);
    await fixture.adapter.shutdown();
  });

  it('quarantines ambiguous turns before replacement and rejects late output or interactions from the old process', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    const session = await materializeSession(fixture);
    const oldRun = await createRun(fixture, session);
    fixture.harness.failNextPromptAfterAccept = true;

    await expect(
      fixture.adapter.startTurn({
        localRunId: oldRun.id,
        session: { localSessionId: session.id, providerSessionId: session.providerSessionId },
        mode: 'IMPLEMENTATION',
        prompt: fixture.task.prompt,
        authoritativeGoal: fixture.task.prompt,
        settings: SETTINGS
      })
    ).rejects.toBeInstanceOf(AgentMutationAmbiguousError);

    const oldSupervisor = fixture.harness.sessionSupervisor;
    const oldClient = oldSupervisor.client!;
    const oldProviderTurnId = (await fixture.runtime.getRun(oldRun.id))!.providerTurnId!;
    expect(oldSupervisor.shutdownCount).toBe(1);
    expect((await fixture.runtime.getRun(oldRun.id))?.status).toBe('RECOVERY_REQUIRED');

    const finalArtifact = await fixture.runtime.writeFinalArtifact(
      oldRun.taskId,
      oldRun.id,
      '# Ambiguous provider turn\n\nExplicitly closed before replacement.\n',
      `test:ambiguous-run-final:${oldRun.id}`
    );
    await fixture.runtime.applyTaskRuntimeEvent(
      createDomainEvent({
        type: 'AGENT_RUN_INTERRUPTED',
        taskId: oldRun.taskId,
        iterationId: oldRun.iterationId,
        runId: oldRun.id,
        worktreeId: oldRun.worktreeId,
        agentSessionId: oldRun.sessionId,
        serverInstanceId: oldRun.serverInstanceId,
        source: 'ui',
        payload: {
          terminalReason: 'Ambiguous run explicitly abandoned.',
          finalArtifactId: finalArtifact.id
        }
      }),
      `test:ambiguous-run-interrupted:${oldRun.id}`
    );

    const replacementSession = (await fixture.runtime.getAgentSession(session.id))!;
    const replacementRun = await createRun(fixture, replacementSession);
    const replacementTurn = await fixture.adapter.startTurn({
      localRunId: replacementRun.id,
      session: { localSessionId: session.id, providerSessionId: session.providerSessionId },
      mode: 'RETRY',
      prompt: 'Run only the explicit replacement.',
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS
    });
    expect(fixture.harness.sessionSupervisor).not.toBe(oldSupervisor);

    await oldClient.emitLate({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_late_old_assistant',
          sessionID: session.providerSessionId,
          role: 'assistant',
          parentID: oldProviderTurnId,
          finish: 'stop',
          tokens: { input: 999, output: 999 },
          time: { completed: Date.now() }
        }
      }
    });
    await oldClient.emitLate({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_late_old',
          sessionID: session.providerSessionId,
          messageID: 'msg_late_old_assistant',
          type: 'text',
          text: 'late old output'
        }
      }
    });
    await oldClient.emitLate({
      type: 'permission.asked',
      properties: {
        id: 'per_late_old',
        sessionID: session.providerSessionId,
        action: 'bash',
        resources: ['dangerous old command'],
        source: { messageID: oldProviderTurnId }
      }
    });
    await oldClient.emitLate({
      type: 'todo.updated',
      properties: {
        sessionID: session.providerSessionId,
        todos: [{ content: 'late old plan', status: 'in_progress' }]
      }
    });
    await oldClient.emitLate({
      type: 'session.error',
      properties: {
        sessionID: session.providerSessionId,
        error: { name: 'ProviderError', message: 'late old failure' }
      }
    });

    expect((await fixture.runtime.getRun(replacementRun.id))?.providerTurnId).toBe(
      replacementTurn.providerTurnId
    );
    expect((await fixture.runtime.getRun(replacementRun.id))?.status).toBe('RUNNING');
    expect(await fixture.runtime.getAgentItemsForRun(replacementRun.id)).toEqual([]);
    expect(
      (await fixture.runtime.snapshot()).agentPlanRevisions.filter(
        (revision) => revision.runId === replacementRun.id
      )
    ).toEqual([]);
    expect(
      (await fixture.runtime.snapshot()).interactionRequests.filter(
        (request) => request.runId === replacementRun.id
      )
    ).toEqual([]);
    expect(await fixture.runtimeStore.readArtifact(replacementRun.outputArtifactId)).not.toContain(
      'late old output'
    );
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
    expect((await fixture.adapter.preflight()).readiness.canStart).toBe(false);
    await fixture.adapter.initialize();

    expect(attempts).toBe(2);
    expect((await fixture.adapter.preflight()).readiness.canStart).toBe(true);
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
    expect((await fixture.adapter.preflight()).readiness.canStart).toBe(true);
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
    expect((await fixture.adapter.preflight()).readiness.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'RUNTIME_RESTART_REQUIRED' })
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
        '/custom/bin/opencode-next' &&
        (await fixture.adapter.preflight()).readiness.canStart
    );

    expect(activeSupervisor.shutdownCount).toBe(1);
    expect(fixture.harness.supervisors.at(-1)?.currentServer?.executable).toBe(
      '/custom/bin/opencode-next'
    );
    expect((await fixture.adapter.preflight()).readiness.canStart).toBe(true);
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
      async () => (await fixture.runtime.getRun(lostRun.id))?.status === 'RECOVERY_REQUIRED'
    );
    await fixture.adapter.resolveExecution({ settings: SETTINGS, attachments: [] });
    expect(observedExecutables).toEqual(['/fake/opencode']);

    const finalArtifact = await fixture.runtime.writeFinalArtifact(
      lostRun.taskId,
      lostRun.id,
      '# Recovery run closed\n\nExplicitly abandoned for replacement.\n',
      `test:lost-run-final:${lostRun.id}`
    );
    await fixture.runtime.applyTaskRuntimeEvent(
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
      }),
      `test:lost-run-interrupted:${lostRun.id}`
    );
    const continuedSession = (await fixture.runtime.getAgentSession(session.id))!;
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

  it('sends verified text and image attachments as native data parts', async () => {
    const fixture = await createFixture();
    await fixture.adapter.initialize();
    const textBytes = Buffer.from('The launch code is MONKI-42.');
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const textPath = path.join(fixture.root, 'brief.txt');
    const imagePath = path.join(fixture.root, 'reference.png');
    await Promise.all([
      fs.writeFile(textPath, textBytes, { mode: 0o400 }),
      fs.writeFile(imagePath, imageBytes, { mode: 0o400 })
    ]);
    const attachments = [
      {
        attachmentId: 'att_text',
        ordinal: 0,
        displayName: 'brief.txt',
        kind: 'text' as const,
        mediaType: 'text/markdown',
        byteCount: textBytes.byteLength,
        sha256: createHash('sha256').update(textBytes).digest('hex'),
        path: textPath,
        verifiedAt: new Date().toISOString()
      },
      {
        attachmentId: 'att_image',
        ordinal: 1,
        displayName: 'reference.png',
        kind: 'image' as const,
        mediaType: 'image/png',
        byteCount: imageBytes.byteLength,
        sha256: createHash('sha256').update(imageBytes).digest('hex'),
        path: imagePath,
        verifiedAt: new Date().toISOString()
      }
    ];
    await expect(
      fixture.adapter.resolveExecution({
        settings: SETTINGS,
        attachments
      })
    ).resolves.toMatchObject({ model: { inputModalities: ['text', 'image'] } });
    const session = await createLocalSession(fixture);
    const run = await createRun(
      fixture,
      session,
      SETTINGS,
      attachments.map((attachment) => ({
        attachmentId: attachment.attachmentId,
        ordinal: attachment.ordinal,
        kind: attachment.kind,
        mediaType: attachment.mediaType,
        byteCount: attachment.byteCount,
        sha256: attachment.sha256
      }))
    );
    const started = await fixture.adapter.startTurn({
      localRunId: run.id,
      session: { localSessionId: session.id },
      mode: 'IMPLEMENTATION',
      prompt: fixture.task.prompt,
      authoritativeGoal: fixture.task.prompt,
      settings: SETTINGS,
      attachments
    });

    const body = fixture.harness.promptBodies[0] as {
      parts: Array<{
        type: string;
        text?: string;
        mime?: string;
        filename?: string;
        url?: string;
      }>;
    };
    expect(body.parts).toHaveLength(3);
    expect(body.parts[0]).toEqual({ type: 'text', text: fixture.task.prompt });
    expect(body.parts[1]).toMatchObject({
      type: 'file',
      mime: 'text/plain',
      filename: 'brief.txt'
    });
    expect(body.parts[2]).toMatchObject({
      type: 'file',
      mime: 'image/png',
      filename: 'reference.png'
    });
    expect(decodeDataUrl(body.parts[1]!.url!)).toEqual(textBytes);
    expect(decodeDataUrl(body.parts[2]!.url!)).toEqual(imageBytes);
    expect(JSON.stringify(body)).not.toContain(textPath);
    expect(JSON.stringify(body)).not.toContain(imagePath);
    expect(JSON.stringify(body)).not.toContain(
      JSON.stringify(textPath).slice(1, -1)
    );
    expect(JSON.stringify(body)).not.toContain(
      JSON.stringify(imagePath).slice(1, -1)
    );
    await expect(fixture.runtime.getRun(run.id)).resolves.toMatchObject({
      attachmentSubmissions: attachments.map((attachment) =>
        expect.objectContaining({
          attachmentId: attachment.attachmentId,
          transport: 'native-file',
          correlation: { kind: 'provider-message', id: started.providerTurnId }
        })
      )
    });
    expect(fixture.harness.supervisors).toHaveLength(2);
    expect(fixture.harness.promptBodies).toHaveLength(1);
    await fixture.adapter.shutdown();
  });

  it('rejects an image before provider mutation when the selected model is text-only', async () => {
    const fixture = await createFixture();
    fixture.harness.catalogs.set(path.resolve(fixture.appCwd), {
      connected: ['anthropic'],
      default: { anthropic: 'claude-test' },
      all: [{
        id: 'anthropic',
        name: 'Anthropic',
        models: {
          'claude-test': {
            id: 'claude-test',
            name: 'Claude Test',
            status: 'active',
            capabilities: { input: { text: true } },
            variants: { high: {} }
          }
        }
      }]
    });
    await fixture.adapter.initialize();

    await expect(
      fixture.adapter.resolveExecution({
        settings: SETTINGS,
        attachments: [{
          kind: 'image',
          mediaType: 'image/png',
          byteCount: 4,
          sha256: createHash('sha256')
            .update(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
            .digest('hex')
        }]
      })
    ).rejects.toThrow('does not accept image attachments');
    expect(fixture.harness.promptBodies).toHaveLength(0);
    await fixture.adapter.shutdown();
  });

  it('uses the same native attachment mapping for owner-neutral turns', async () => {
    const fixture = await createOwnerNeutralRuntimeFixture({}, true);
    const body = fixture.harness.promptBodies[0] as {
      parts: Array<{ type: string; mime?: string; filename?: string; url?: string }>;
    };

    expect(body.parts[1]).toMatchObject({
      type: 'file',
      mime: 'text/plain',
      filename: 'review-context.txt'
    });
    expect(decodeDataUrl(body.parts[1]!.url!)).toEqual(fixture.attachmentBytes);
    expect(JSON.stringify(body)).not.toContain(fixture.attachmentPath);
    expect(JSON.stringify(body)).not.toContain(
      JSON.stringify(fixture.attachmentPath).slice(1, -1)
    );
    expect(fixture.started.attachmentSubmissions).toEqual([
      expect.objectContaining({
        attachmentId: fixture.attachments[0]!.attachmentId,
        transport: 'native-file',
        correlation: {
          kind: 'provider-message',
          id: fixture.started.providerTurnId
        }
      })
    ]);
    await fixture.adapter.shutdown();
  });
});

interface AdapterFixture {
  persistence: ApplicationPersistence;
  root: string;
  appCwd: string;
  store: SqliteTaskStore;
  runtimeStore: SqliteAgentRuntimeStore;
  runtime: TaskAgentRuntimeAccess;
  adapter: OpenCodeAdapter;
  appEvents: AppEventBus;
  harness: FakeOpenCodeHarness;
  task: Task;
  designTurnId?: string;
  iteration: TaskIteration;
  worktree: WorktreeRecord;
}

interface AdapterFixtureOptions {
  sessionIdleTimeoutMs?: number;
  interruptCompletionTimeoutMs?: number;
  runtimeResolver?: OpenCodeAdapterOptions['runtimeResolver'];
  environment?: NodeJS.ProcessEnv;
  designSkillRoot?: string;
  designClientToolBridge?: Pick<
    DesignClientToolBridge,
    'createSessionGrant' | 'activateGrant' | 'revokeGrant' | 'releaseSessionGrant'
  >;
}

async function createOwnerNeutralRuntimeFixture(
  options: AdapterFixtureOptions = {},
  withAttachment = false
) {
  const fixture = await createFixture(options);
  await fixture.adapter.initialize();
  const attachmentBytes = Buffer.from('The owner-neutral code is MONKI-READ-42.');
  const attachmentPath = path.join(fixture.root, 'review-context.txt');
  const attachments = withAttachment
    ? [{
        attachmentId: 'att_runtime_text',
        ordinal: 0,
        displayName: 'review-context.txt',
        kind: 'text' as const,
        mediaType: 'text/plain',
        byteCount: attachmentBytes.byteLength,
        sha256: createHash('sha256').update(attachmentBytes).digest('hex'),
        path: attachmentPath,
        verifiedAt: new Date().toISOString()
      }]
    : [];
  if (withAttachment) {
    await fs.writeFile(attachmentPath, attachmentBytes, { mode: 0o400 });
  }
  const context = await fixture.adapter.buildExecutionContext({
    sessionId: 'runtime-session-denial',
    primaryCwd: fixture.worktree.worktreePath,
    readRoots: [{
      canonicalPath: fixture.worktree.worktreePath,
      kind: 'WORKTREE',
      entityId: fixture.worktree.id
    }],
    modelSettings: SETTINGS,
    clientOperationId: 'runtime-context-denial',
    attachments
  });
  const owner = withAttachment
    ? {
        kind: 'PROMPT_REFINEMENT' as const,
        requestId: 'refinement-attachment'
      }
    : {
        kind: 'DISCOURSE' as const,
        conversationId: 'conversation-denial',
        stableParticipantId: 'participant-denial'
      };
  const session = await fixture.runtimeStore.createSession({
    id: 'runtime-session-denial',
    owner,
    accessEpoch: createAgentSessionAccessEpoch({
      owner,
      sessionId: 'runtime-session-denial',
      epoch: 1,
      runtimeId: 'opencode',
      model: context.modelSettings.model!,
      executionContext: context,
      createdAt: new Date().toISOString()
    }),
    executionContext: context,
    clientOperationId: 'runtime-session-denial-create',
    runtimeId: 'opencode',
    role: 'PRIMARY',
    relationshipState: 'ROOT',
    status: 'NOT_MATERIALIZED',
    materialized: false,
    requestedSettings: context.modelSettings
  });
  let run = await fixture.runtimeStore.createRun({
    id: 'runtime-run-denial',
    owner,
    scope: withAttachment
      ? { kind: 'PROMPT_REFINEMENT', requestId: 'refinement-attachment' }
      : {
          kind: 'DISCOURSE',
          conversationId: 'conversation-denial',
          waveId: 'wave-denial',
          jobId: 'job-denial',
          contextSnapshotId: 'snapshot-denial',
          attemptId: 'attempt-denial'
        },
    sessionId: session.id,
    sessionAccessEpoch: 1,
    purpose: withAttachment ? 'PROMPT_REFINEMENT' : 'DISCOURSE_ANSWER',
    generationKey: 'runtime-generation-denial',
    clientOperationId: 'runtime-run-denial-create',
    requestedSettings: context.modelSettings,
    promptArtifactId: 'runtime-prompt-denial',
    outputArtifactId: 'runtime-output-denial',
    diagnosticArtifactId: 'runtime-diagnostic-denial',
    attachmentSelection: attachments.map((attachment) => ({
      attachmentId: attachment.attachmentId,
      ordinal: attachment.ordinal,
      kind: attachment.kind,
      mediaType: attachment.mediaType,
      byteCount: attachment.byteCount,
      sha256: attachment.sha256
    }))
  });
  await Promise.all([
    fixture.runtimeStore.createArtifact({
      id: run.promptArtifactId,
      owner,
      runId: run.id,
      kind: 'PROMPT',
      clientOperationId: 'runtime-prompt-denial-create',
      content: 'Inspect without changing files.'
    }),
    fixture.runtimeStore.createArtifact({
      id: run.outputArtifactId,
      owner,
      runId: run.id,
      kind: 'OUTPUT',
      clientOperationId: 'runtime-output-denial-create',
      content: ''
    }),
    fixture.runtimeStore.createArtifact({
      id: run.diagnosticArtifactId,
      owner,
      runId: run.id,
      kind: 'DIAGNOSTIC',
      clientOperationId: 'runtime-diagnostic-denial-create',
      content: ''
    })
  ]);
  run = await fixture.runtimeStore.updateRun(
    run.id,
    run.recordRevision,
    {
      status: 'STARTING',
      delivery: 'SENDING',
      startedAt: new Date().toISOString()
    },
    'runtime-denial-starting'
  );
  const started = await fixture.adapter.startRuntimeTurn({
    session,
    run,
    executionContext: context,
    prompt: 'Inspect without changing files.',
    attachments
  });
  return {
    ...fixture,
    owner,
    session,
    run,
    context,
    started,
    attachments,
    attachmentBytes,
    attachmentPath
  };
}

async function createFixture(options: AdapterFixtureOptions = {}): Promise<AdapterFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-opencode-adapter-'));
  const appCwd = path.join(root, 'app');
  const worktreePath = path.join(root, 'worktree');
  await fs.mkdir(appCwd, { recursive: true });
  await fs.mkdir(worktreePath, { recursive: true });
  const persistence = await openTestPersistence(path.join(root, 'profile'));
  const store = persistence.tasks;
  const runtimeStore = persistence.agentRuntime;
  const runtimeAccess = persistence.taskRuntime;
  let task: Task;
  let designTurnId: string | undefined;
  if (options.designClientToolBridge) {
    const created = await store.createDesignBundle({
      request: {
        brief: 'Create and verify the Design.',
        creationToken: `opencode-design-${randomUUID()}`,
        runtimeId: 'opencode',
        model: SETTINGS.model,
        reasoningEffort: SETTINGS.reasoningEffort
      },
      agentSettings: SETTINGS,
      repository: {
        id: randomUUID(),
        name: 'OpenCode adapter Design',
        path: path.join(root, 'managed-design-repository'),
        headSha: 'a'.repeat(40),
        branch: 'main',
        checkedAt: new Date().toISOString()
      }
    });
    task = created.task;
    designTurnId = created.turn.id;
  } else {
    task = await store.createTask({
      runtimeId: 'opencode',
      title: 'OpenCode adapter lifecycle',
      prompt: 'Implement the requested change.',
      repositoryId: (await addTestRepository(store, worktreePath)).id,
      agentSettings: SETTINGS
    });
  }
  const { iteration, worktree } = await store.createIterationAndWorktree({
    task,
    branchName: 'codex/opencode-adapter',
    worktreePath,
    baseSha: 'base-sha'
  });
  const harness = new FakeOpenCodeHarness();
  harness.catalogs.set(path.resolve(appCwd), defaultProviderCatalog());
  harness.catalogs.set(path.resolve(worktreePath), defaultProviderCatalog());
  const runtime = fakeRuntime();
  const appEvents = new AppEventBus();
  const fixture = {
    persistence,
    root,
    appCwd,
    store,
    runtimeStore,
    runtime: runtimeAccess,
    appEvents,
    harness,
    task,
    designTurnId,
    iteration,
    worktree
  };
  const adapter = createAdapterForFixture(fixture, options);
  return { ...fixture, adapter };
}

function createAdapterForFixture(
  fixture: Omit<AdapterFixture, 'adapter'>,
  options: AdapterFixtureOptions = {}
): OpenCodeAdapter {
  const runtime = fakeRuntime();
  return new OpenCodeAdapter(fixture.runtime, fixture.runtimeStore, fixture.appEvents, {
    cwd: fixture.appCwd,
    executable: runtime.executable,
    runtimeResolver: options.runtimeResolver ?? (async () => runtime),
    environment: options.environment,
    supervisorFactory: (runtimeStore, supervisorOptions) =>
      fixture.harness.createSupervisor(runtimeStore, supervisorOptions),
    sessionIdleTimeoutMs: options.sessionIdleTimeoutMs,
    interruptCompletionTimeoutMs: options.interruptCompletionTimeoutMs,
    designSkillRoot: options.designSkillRoot,
    designClientToolBridge: options.designClientToolBridge
  });
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
  const session = await createLocalSession(fixture);
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
  session: AgentSessionRecord,
  requestedSettings: AgentExecutionSettings = SETTINGS,
  attachmentSelection: AgentAttachmentSelection[] = [],
  options: {
    purpose?: 'TASK_IMPLEMENTATION' | 'TASK_DESIGN';
    clientToolGrants?: string[];
  } = {}
): Promise<RunRecord> {
  const id = nextRuntimeTestId('run');
  const owner = { kind: 'TASK' as const, taskId: fixture.task.id };
  const created = await fixture.runtimeStore.createRun({
    id,
    owner,
    scope: {
      kind: 'TASK',
      taskId: fixture.task.id,
      iterationId: fixture.iteration.id,
      worktreeId: fixture.worktree.id
    },
    sessionId: session.id,
    sessionAccessEpoch: 1,
    purpose: options.purpose ?? 'TASK_IMPLEMENTATION',
    generationKey:
      options.purpose === 'TASK_DESIGN'
        ? fixture.designTurnId ?? `opencode-test:${id}`
        : `opencode-test:${id}`,
    clientOperationId: `create:${id}`,
    requestedSettings,
    promptArtifactId: `${id}-prompt`,
    outputArtifactId: `${id}-output`,
    diagnosticArtifactId: `${id}-diagnostics`,
    clientToolGrants: options.clientToolGrants,
    attachmentSelection,
    taskDetails: { eventCount: 0 }
  });
  await Promise.all([
    fixture.runtimeStore.createArtifact({
      id: created.promptArtifactId,
      owner,
      runId: created.id,
      kind: 'PROMPT',
      clientOperationId: `artifact:${id}:prompt`,
      content: fixture.task.prompt
    }),
    fixture.runtimeStore.createArtifact({
      id: created.outputArtifactId,
      owner,
      runId: created.id,
      kind: 'OUTPUT',
      clientOperationId: `artifact:${id}:output`,
      content: ''
    }),
    fixture.runtimeStore.createArtifact({
      id: created.diagnosticArtifactId,
      owner,
      runId: created.id,
      kind: 'DIAGNOSTIC',
      clientOperationId: `artifact:${id}:diagnostics`,
      content: ''
    })
  ]);
  return (await fixture.runtime.getRun(id))!;
}

async function createLocalSession(
  fixture: AdapterFixture,
  input: {
    task?: Task;
    iteration?: TaskIteration;
    worktree?: WorktreeRecord;
    role?: AgentSessionRecord['role'];
    forkedFromSessionId?: string;
    requestedSettings?: AgentExecutionSettings;
  } = {}
): Promise<AgentSessionRecord> {
  const task = input.task ?? fixture.task;
  const iteration = input.iteration ?? fixture.iteration;
  const worktree = input.worktree ?? fixture.worktree;
  const requestedSettings = input.requestedSettings ?? SETTINGS;
  const id = nextRuntimeTestId('session');
  const owner = { kind: 'TASK' as const, taskId: task.id };
  const operationId = `create:${id}`;
  const executionContext = {
    attestation: { status: 'ATTESTED' as const },
    repositoryAccess: 'WRITE' as const,
    primaryCwd: worktree.worktreePath,
    readRoots: [{
      canonicalPath: worktree.worktreePath,
      kind: 'WORKTREE' as const,
      entityId: worktree.id
    }],
    managedAttachments: [],
    permissionProfileHash: 'a'.repeat(64),
    modelSettings: requestedSettings,
    externalTools: {
      network: requestedSettings.networkAccess === true,
      webSearch: requestedSettings.networkAccess === true ? 'live' as const : 'disabled' as const,
      mcpServers: false,
      apps: false,
      dynamicTools: false
    },
    clientOperationId: operationId
  };
  await fixture.runtimeStore.createSession({
    id,
    owner,
    accessEpoch: createAgentSessionAccessEpoch({
      owner,
      sessionId: id,
      epoch: 1,
      runtimeId: 'opencode',
      model: requestedSettings.model!,
      executionContext
    }),
    executionContext,
    clientOperationId: operationId,
    runtimeId: 'opencode',
    role: input.role ?? 'PRIMARY',
    ...(input.forkedFromSessionId
      ? { forkedFromSessionId: input.forkedFromSessionId }
      : {}),
    relationshipState: input.forkedFromSessionId ? 'RESOLVED' : 'ROOT',
    status: 'NOT_MATERIALIZED',
    materialized: false,
    requestedSettings,
    taskContext: {
      iterationId: iteration.id,
      worktreeId: worktree.id,
      worktreePath: worktree.worktreePath
    }
  });
  return (await fixture.runtime.getAgentSession(id))!;
}

function nextRuntimeTestId(_prefix: string): string {
  return randomUUID();
}

function fakeDesignToolBridge() {
  const createSessionGrant = vi.fn(async () => ({
    id: 'design-grant-1',
    launch: {
      executablePath: '/app/Task Monki',
      argv: ['/resources/design-tool-mcp-server.mjs'],
      environment: {
        TASK_MONKI_DESIGN_TOOL_SESSION_CREDENTIAL: 'session-credential',
        TASK_MONKI_DESIGN_TOOL_CREDENTIAL_FILE: '/private/grant-file'
      }
    }
  }));
  const activateGrant = vi.fn(async () => undefined);
  const revokeGrant = vi.fn(async () => undefined);
  const releaseSessionGrant = vi.fn(async () => undefined);
  return {
    api: {
      createSessionGrant,
      activateGrant,
      revokeGrant,
      releaseSessionGrant
    },
    createSessionGrant,
    activateGrant,
    revokeGrant,
    releaseSessionGrant
  };
}

async function startStreamingRun(fixture: AdapterFixture): Promise<{
  session: AgentSessionRecord;
  run: RunRecord;
}> {
  await fixture.adapter.initialize();
  const session = await materializeSession(fixture);
  const run = await createRun(fixture, session);
  const turn = await fixture.adapter.startTurn({
    localRunId: run.id,
    session: {
      localSessionId: session.id,
      providerSessionId: session.providerSessionId
    },
    mode: 'IMPLEMENTATION',
    prompt: fixture.task.prompt,
    authoritativeGoal: fixture.task.prompt,
    settings: SETTINGS
  });
  await fixture.harness.emit({
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg_assistant_stream',
        sessionID: session.providerSessionId,
        role: 'assistant',
        parentID: turn.providerTurnId,
        time: { created: Date.now() }
      }
    }
  });
  await fixture.harness.emit({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'prt_stream',
        sessionID: session.providerSessionId,
        messageID: 'msg_assistant_stream',
        type: 'text',
        text: ''
      }
    }
  });
  return { session, run };
}

class FakeOpenCodeHarness {
  readonly sessions = new Map<string, OpenCodeSession>();
  readonly messages = new Map<string, OpenCodeMessage[]>();
  readonly todos = new Map<string, unknown[]>();
  readonly catalogs = new Map<string, unknown>();
  readonly statuses: Record<string, unknown> = {};
  permissions: unknown[] = [];
  questions: unknown[] = [];
  readonly promptBodies: unknown[] = [];
  readonly mcpRegistrations: unknown[] = [];
  readonly mcpSensitiveValues: string[][] = [];
  readonly mcpDisconnects: string[] = [];
  readonly permissionReplies: unknown[] = [];
  readonly questionReplies: unknown[] = [];
  readonly permissionPatchBodies: unknown[] = [];
  readonly forkRequests: Array<{ sourceSessionId: string; directory: string }> = [];
  readonly deletedSessionIds: string[] = [];
  readonly supervisors: FakeOpenCodeSupervisor[] = [];
  readonly supervisorShutdownFailures = new Map<number, Error>();
  providerGetCount = 0;
  failProviderGetAt?: number;
  stoppedStreams = 0;
  failNextPromptAfterAccept = false;
  failNextMcpRegistrationAfterAccept = false;
  nextMcpRegistrationStatus?: Record<string, unknown>;
  failNextMcpDisconnectAfterAccept = false;
  failNextPermissionPatchAfterAccept = false;
  failNextSessionDeleteBeforeAccept = false;
  ignorePermissionPatches = false;
  settleAbort = false;
  failNextAbort = false;
  stallAbort = false;
  stallMessageReads = false;
  readonly abortedSessionIds: string[] = [];
  readonly abortDeadlineWindowsMs: number[] = [];
  readonly messageReadDeadlineWindowsMs: number[] = [];
  messageReadCount = 0;
  statusReadCount = 0;
  sessionReadCount = 0;
  permissionReadCount = 0;
  questionReadCount = 0;
  todoReadCount = 0;
  includeCrossDirectorySessions = false;
  returnSourceIdOnFork = false;
  sessionDirectoryTransform: (directory: string) => string = (directory) => directory;
  private nextSession = 0;

  get catalogSupervisor(): FakeOpenCodeSupervisor {
    return this.supervisors[0]!;
  }

  get sessionSupervisor(): FakeOpenCodeSupervisor {
    return this.supervisors.at(-1)!;
  }

  createSupervisor(
    store: AgentProviderRuntimeStore,
    options: OpenCodeServerSupervisorOptions
  ): FakeOpenCodeSupervisor {
    const supervisor = new FakeOpenCodeSupervisor(store, options, this);
    supervisor.shutdownFailure = this.supervisorShutdownFailures.get(
      this.supervisors.length
    );
    this.supervisors.push(supervisor);
    return supervisor;
  }

  async emit(value: unknown): Promise<void> {
    const clients = this.supervisors
      .map((supervisor) => supervisor.client)
      .filter((client): client is FakeOpenCodeClient => Boolean(client));
    for (const client of clients) await client.emit(value);
  }

  async emitConcurrent(values: readonly unknown[]): Promise<void> {
    const clients = this.supervisors
      .map((supervisor) => supervisor.client)
      .filter((client): client is FakeOpenCodeClient => Boolean(client));
    for (const client of clients) await client.emitConcurrent(values);
  }

  createProviderSession(directory: string, body: unknown): OpenCodeSession {
    const input = body as {
      title?: string;
      metadata?: Record<string, unknown>;
      model?: { id?: string; providerID?: string; variant?: string };
      permission?: OpenCodeSession['permission'];
    };
    const session: OpenCodeSession = {
      id: `ses_${++this.nextSession}`,
      directory: this.sessionDirectoryTransform(directory),
      title: input.title ?? 'Untitled',
      version: '1.17.18',
      ...(input.model?.providerID
        ? {
            model: {
              providerID: input.model.providerID,
              ...(input.model.id ? { modelID: input.model.id } : {}),
              ...(input.model.variant ? { variant: input.model.variant } : {})
            }
          }
        : {}),
      ...(input.permission ? { permission: structuredClone(input.permission) } : {}),
      metadata: input.metadata,
      time: { created: Date.now(), updated: Date.now() }
    };
    this.sessions.set(session.id, session);
    this.statuses[session.id] = { type: 'idle' };
    this.messages.set(session.id, []);
    this.todos.set(session.id, []);
    return session;
  }

  forkProviderSession(directory: string, sourceSessionId: string): OpenCodeSession {
    const source = this.sessions.get(sourceSessionId);
    if (!source) throw new Error(`OpenCode session not found: ${sourceSessionId}`);
    this.forkRequests.push({
      sourceSessionId,
      directory: path.resolve(directory)
    });
    if (this.returnSourceIdOnFork) return structuredClone(source);
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
  shutdownFailure?: Error;
  shutdownCount = 0;
  startCount = 0;

  constructor(
    private readonly store: AgentProviderRuntimeStore,
    private readonly options: OpenCodeServerSupervisorOptions,
    private readonly harness: FakeOpenCodeHarness
  ) {}

  get currentClient(): FakeOpenCodeClient | undefined {
    return this.client;
  }

  async start(): Promise<RunningOpenCodeServer> {
    this.startCount += 1;
    if (!this.currentServer) {
      this.currentServer = await this.store.createAgentServer({
        runtimeId: 'opencode',
        runtimeKind: 'HTTP_AGENT',
        transport: 'HTTP_SSE',
        executable: this.options.runtime.executable,
        argv: ['serve', ...(this.options.pure ? ['--pure'] : [])],
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
    if (this.shutdownFailure) throw this.shutdownFailure;
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
    this.client = undefined;
    this.events.emit('exit', this.currentServer, true);
  }
}

interface FakeOpenCodeEventStream {
  handlers: OpenCodeEventStreamHandlers;
  stopped: boolean;
  pending: Set<Promise<void>>;
  settled: Promise<void>;
  resolveSettled(): void;
}

class FakeOpenCodeClient implements OpenCodeClientTransport {
  private stream?: FakeOpenCodeEventStream;
  private lastStream?: FakeOpenCodeEventStream;

  constructor(
    private readonly store: AgentProviderRuntimeStore,
    private readonly directory: string,
    private readonly serverId: () => string,
    private readonly harness: FakeOpenCodeHarness
  ) {}

  async get<T>(
    requestPath: string,
    options?: OpenCodeRequestOptions
  ): Promise<OpenCodeHttpResult<T>> {
    let data: unknown;
    if (requestPath === '/provider') {
      this.harness.providerGetCount += 1;
      if (this.harness.providerGetCount === this.harness.failProviderGetAt) {
        throw new Error('simulated provider catalog failure');
      }
      data = this.harness.providerCatalog(this.directory);
    } else if (requestPath === '/session') {
      data = [...this.harness.sessions.values()].filter(
        (session) =>
          this.harness.includeCrossDirectorySessions ||
          path.resolve(session.directory) === path.resolve(this.directory)
      );
    } else if (requestPath === '/session/status') {
      this.harness.statusReadCount += 1;
      // HTTP response bodies are immutable snapshots. Returning the harness
      // object by reference lets a later mutation rewrite an in-flight read.
      data = structuredClone(this.harness.statuses);
    } else if (requestPath === '/permission') {
      this.harness.permissionReadCount += 1;
      data = this.harness.permissions;
    } else if (requestPath === '/question') {
      this.harness.questionReadCount += 1;
      data = this.harness.questions;
    } else if (requestPath.endsWith('/message')) {
      this.harness.messageReadCount += 1;
      if (this.harness.stallMessageReads) {
        this.harness.messageReadDeadlineWindowsMs.push(
          remainingDeadlineMs(options)
        );
        await rejectAtDeadline(
          options,
          new Error('simulated stalled message snapshot')
        );
      }
      data = this.harness.messages.get(providerSessionId(requestPath)) ?? [];
    } else if (requestPath.endsWith('/todo')) {
      this.harness.todoReadCount += 1;
      data = this.harness.todos.get(providerSessionId(requestPath)) ?? [];
    } else {
      this.harness.sessionReadCount += 1;
      const sessionId = providerSessionId(requestPath);
      if (this.harness.deletedSessionIds.includes(sessionId)) {
        throw new OpenCodeHttpError(
          404,
          `GET ${requestPath}`,
          `OpenCode rejected GET ${requestPath} with HTTP 404.`
        );
      }
      data = this.harness.sessions.get(sessionId);
    }
    return { data: data as T, raw: await this.raw(data) };
  }

  async post<T>(
    requestPath: string,
    body?: unknown,
    options?: OpenCodeRequestOptions
  ): Promise<OpenCodeHttpResult<T>> {
    let data: unknown;
    if (requestPath === '/session') {
      data = this.harness.createProviderSession(this.directory, body);
    } else if (requestPath === '/mcp') {
      this.harness.mcpRegistrations.push(structuredClone(body));
      this.harness.mcpSensitiveValues.push([...(options?.sensitiveValues ?? [])]);
      if (this.harness.failNextMcpRegistrationAfterAccept) {
        this.harness.failNextMcpRegistrationAfterAccept = false;
        throw new OpenCodeAmbiguousMutationError(
          'POST /mcp',
          'simulated MCP registration response loss'
        );
      }
      const status = this.harness.nextMcpRegistrationStatus ?? {
        status: 'connected'
      };
      this.harness.nextMcpRegistrationStatus = undefined;
      data = { task_monki_design: status };
    } else if (requestPath.startsWith('/mcp/') && requestPath.endsWith('/disconnect')) {
      this.harness.mcpDisconnects.push(requestPath);
      if (this.harness.failNextMcpDisconnectAfterAccept) {
        this.harness.failNextMcpDisconnectAfterAccept = false;
        throw new OpenCodeAmbiguousMutationError(
          `POST ${requestPath}`,
          'simulated MCP disconnect response loss'
        );
      }
      data = true;
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
      if (this.harness.failNextPromptAfterAccept) {
        this.harness.failNextPromptAfterAccept = false;
        throw new OpenCodeAmbiguousMutationError(
          'POST session/prompt_async',
          'simulated response loss after provider acceptance'
        );
      }
      data = undefined;
    } else if (requestPath.startsWith('/permission/')) {
      this.harness.permissionReplies.push(body);
      data = true;
    } else if (requestPath.startsWith('/question/')) {
      this.harness.questionReplies.push(body);
      data = true;
    } else if (requestPath.endsWith('/abort')) {
      const sessionId = providerSessionId(requestPath);
      this.harness.abortedSessionIds.push(sessionId);
      if (this.harness.failNextAbort) {
        this.harness.failNextAbort = false;
        throw new OpenCodeAmbiguousMutationError(
          'POST session/abort',
          'simulated abort response loss'
        );
      }
      if (this.harness.stallAbort) {
        this.harness.abortDeadlineWindowsMs.push(remainingDeadlineMs(options));
        await rejectAtDeadline(
          options,
          new OpenCodeAmbiguousMutationError(
            'POST session/abort',
            'simulated stalled abort'
          )
        );
      }
      if (this.harness.settleAbort) {
        this.harness.statuses[sessionId] = { type: 'idle' };
      }
      data = true;
    } else {
      data = true;
    }
    return { data: data as T, raw: await this.raw(data) };
  }

  async patch<T>(
    requestPath: string,
    body?: unknown,
    _options?: OpenCodeRequestOptions
  ): Promise<OpenCodeHttpResult<T>> {
    const session = this.harness.sessions.get(providerSessionId(requestPath));
    if (!session) throw new Error(`OpenCode session not found: ${requestPath}`);
    const update = body as { permission?: OpenCodeSession['permission'] };
    if (update.permission) {
      this.harness.permissionPatchBodies.push(structuredClone(body));
      if (!this.harness.ignorePermissionPatches) {
        session.permission = [
          ...(session.permission ?? []),
          ...structuredClone(update.permission)
        ];
      }
      if (this.harness.failNextPermissionPatchAfterAccept) {
        this.harness.failNextPermissionPatchAfterAccept = false;
        throw new OpenCodeAmbiguousMutationError(
          'PATCH session',
          'simulated permission patch response loss after provider acceptance'
        );
      }
    }
    return this.result(structuredClone(session) as T);
  }

  async delete<T>(
    requestPath: string,
    _options?: OpenCodeRequestOptions
  ): Promise<OpenCodeHttpResult<T>> {
    const sessionId = providerSessionId(requestPath);
    if (this.harness.failNextSessionDeleteBeforeAccept) {
      this.harness.failNextSessionDeleteBeforeAccept = false;
      throw new OpenCodeAmbiguousMutationError(
        `DELETE ${requestPath}`,
        'simulated session deletion delivery failure'
      );
    }
    this.harness.deletedSessionIds.push(sessionId);
    this.harness.sessions.delete(sessionId);
    this.harness.messages.delete(sessionId);
    this.harness.todos.delete(sessionId);
    delete this.harness.statuses[sessionId];
    return this.result(true as T);
  }

  startEventStream(handlers: OpenCodeEventStreamHandlers): OpenCodeEventStream {
    let resolveSettled!: () => void;
    const state: FakeOpenCodeEventStream = {
      handlers,
      stopped: false,
      pending: new Set<Promise<void>>(),
      settled: new Promise<void>((resolve) => {
        resolveSettled = resolve;
      }),
      resolveSettled: () => resolveSettled()
    };
    this.stream = state;
    this.lastStream = state;
    return {
      settled: state.settled,
      stop: () => {
        if (state.stopped) return;
        state.stopped = true;
        this.harness.stoppedStreams += 1;
        if (this.stream === state) this.stream = undefined;
        this.settleStreamIfDrained(state);
      }
    };
  }

  async emit(value: unknown): Promise<void> {
    const stream = this.stream;
    if (stream) await this.dispatchEvent(stream, value);
  }

  async emitConcurrent(values: readonly unknown[]): Promise<void> {
    const stream = this.stream;
    if (!stream) return;
    await Promise.all(values.map((value) => this.dispatchEvent(stream, value)));
  }

  async emitLate(value: unknown): Promise<void> {
    if (this.lastStream) {
      await this.lastStream.handlers.onEvent(value, await this.raw(value));
    }
  }

  private dispatchEvent(
    stream: FakeOpenCodeEventStream,
    value: unknown
  ): Promise<void> {
    if (stream.stopped) return Promise.resolve();
    const operation = (async () => {
      await stream.handlers.onEvent(value, await this.raw(value));
    })();
    stream.pending.add(operation);
    void operation.then(
      () => {
        stream.pending.delete(operation);
        this.settleStreamIfDrained(stream);
      },
      () => {
        stream.pending.delete(operation);
        this.settleStreamIfDrained(stream);
      }
    );
    return operation;
  }

  private settleStreamIfDrained(stream: FakeOpenCodeEventStream): void {
    if (stream.stopped && stream.pending.size === 0) stream.resolveSettled();
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

function decodeDataUrl(value: string): Buffer {
  const separator = value.indexOf(',');
  if (separator < 0 || !value.slice(0, separator).endsWith(';base64')) {
    throw new Error('Expected a base64 data URL.');
  }
  return Buffer.from(value.slice(separator + 1), 'base64');
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

function remainingDeadlineMs(options: OpenCodeRequestOptions | undefined): number {
  if (options?.deadlineAt === undefined) {
    throw new Error('Expected the OpenCode request to carry a bounded deadline.');
  }
  return Math.max(0, options.deadlineAt - Date.now());
}

async function rejectAtDeadline(
  options: OpenCodeRequestOptions | undefined,
  error: Error
): Promise<never> {
  const deadlineAt = options?.deadlineAt ?? Date.now() + 50;
  await wait(Math.max(1, deadlineAt - Date.now() + 1));
  throw error;
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
