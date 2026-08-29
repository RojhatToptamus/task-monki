import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentExecutionSettings,
  AgentRunMode,
  AgentSessionRecord,
  RespondToInteractionRequest,
  RunRecord,
  Task,
  TaskIteration,
  WorktreeRecord
} from '../../../shared/contracts';
import { addTestRepository } from '../../../testSupport/repositoryFixture';
import { git } from '../../git/gitCli';
import { AgentOrchestrator } from '../AgentOrchestrator';
import {
  AgentMutationAmbiguousError,
  AgentRuntimeDeliveryError
} from '../AgentRuntimeAdapter';
import { AgentRuntimeArtifactMutationAmbiguousError } from '../AgentRuntimeStore';
import { createAgentSessionAccessEpoch } from '../AgentRuntimeOwnership';
import { AppEventBus } from '../../runner/AppEventBus';
import { FileTaskStore } from '../../storage/FileTaskStore';
import { FileAgentRuntimeStore } from '../../storage/FileAgentRuntimeStore';
import { writeNodeExecutable } from '../../../testSupport/fakeExecutable';
import {
  CodexAppServerAdapter,
  type CodexAppServerAdapterOptions
} from './CodexAppServerAdapter';
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
  it('runs a scoped Discourse turn without fabricating task-owned state', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-scoped-app-server-'));
    const executable = await writeFakeCodexExecutable(dir, 'scoped');
    const workspacePath = path.join(dir, 'read-only-workspace');
    await fs.mkdir(workspacePath, { mode: 0o700 });
    const workspace = await fs.realpath(workspacePath);
    const store = new FileTaskStore(path.join(dir, 'task-store'));
    const runtime = new FileAgentRuntimeStore(path.join(dir, 'runtime'));
    await runtime.init();
    const adapter = createCodexAdapter(store, new AppEventBus(), {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
      runtimeStore: runtime
    });
    let resolveTerminal!: () => void;
    const terminal = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const observedEvents: string[] = [];
    const unsubscribe = adapter.onRuntimeTurnEvent((event) => {
      observedEvents.push(event.type);
      if (event.type === 'TERMINAL') resolveTerminal();
    });
    try {
      await adapter.initialize();
      const owner = {
        kind: 'DISCOURSE' as const,
        conversationId: 'conversation-1',
        stableParticipantId: 'participant-1'
      };
      const sessionId = 'scoped-session-1';
      const executionContext = await adapter.buildExecutionContext({
        sessionId,
        primaryCwd: workspace,
        readRoots: [{ canonicalPath: workspace, kind: 'EMPTY_MANAGED' }],
        modelSettings: {
          runtimeId: 'codex',
          model: 'fake-model',
          modelProvider: 'openai',
          reasoningEffort: 'high',
          sandbox: 'READ_ONLY',
          networkAccess: false,
          approvalPolicy: 'NEVER',
          approvalsReviewer: 'user'
        },
        clientOperationId: 'scoped-context-1'
      });
      const session = await runtime.createSession({
        id: sessionId,
        owner,
        accessEpoch: createAgentSessionAccessEpoch({
          owner,
          sessionId,
          epoch: 1,
          runtimeId: 'codex',
          model: 'fake-model',
          executionContext,
          createdAt: '2026-07-13T00:00:00.000Z'
        }),
        executionContext,
        clientOperationId: 'create-scoped-session',
        runtimeId: 'codex',
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
        { status: 'STARTING', delivery: 'SENDING', startedAt: '2026-07-13T00:00:01.000Z' },
        'scoped-start-intent'
      );
      const started = await adapter.startRuntimeTurn({
        session,
        run: starting,
        executionContext,
        prompt: 'Question the proposed architecture.',
        attachments: []
      });
      const afterResponse = await runtime.getRun(run.id);
      if (afterResponse?.status === 'STARTING') {
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
      await new Promise((resolve) => setTimeout(resolve, 75));

      await expect(runtime.getRun(run.id)).resolves.toMatchObject({
        status: 'COMPLETED',
        delivery: 'TERMINAL',
        providerTurnId: 'turn-1'
      });
      await expect(runtime.readArtifact(run.outputArtifactId)).resolves.toBe(
        'Fake task completed.'
      );
      expect(observedEvents.filter((event) => event === 'DELTA')).toHaveLength(2);
      expect(observedEvents.filter((event) => event === 'TERMINAL')).toHaveLength(1);
      expect(observedEvents.at(-1)).toBe('TERMINAL');
      const runtimeSnapshot = await runtime.snapshot();
      const journal = await fs.readFile(
        runtimeSnapshot.servers[0]!.protocolJournalPath,
        'utf8'
      );
      const outbound = readOutboundMessages(journal);
      expect(
        outbound.find((message) => message.method === 'thread/start')?.params
      ).toMatchObject({
        model: 'fake-model',
        modelProvider: 'openai',
        cwd: workspace,
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        ephemeral: false,
        dynamicTools: []
      });
      expect(
        outbound.find((message) => message.method === 'turn/start')?.params
      ).toMatchObject({
        threadId: 'thread-1',
        clientUserMessageId: run.id,
        cwd: workspace,
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        model: 'fake-model',
        effort: 'high'
      });
      const taskSnapshot = await store.snapshot();
      expect(taskSnapshot.tasks).toEqual([]);
      expect(taskSnapshot.runs).toEqual([]);
      expect(taskSnapshot.agentSessions).toEqual([]);
    } finally {
      unsubscribe();
      await adapter.shutdown();
      await runtime.close();
    }
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('rejects a missing read-only attachment before starting a provider thread', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-scoped-attachment-preflight-')
    );
    const executable = await writeFakeCodexExecutable(dir, 'scoped');
    const workspacePath = path.join(dir, 'read-only-workspace');
    await fs.mkdir(workspacePath, { mode: 0o700 });
    const workspace = await fs.realpath(workspacePath);
    const attachmentFilePath = path.join(dir, 'reference.txt');
    const attachmentBytes = Buffer.from('immutable reference\n');
    await fs.writeFile(attachmentFilePath, attachmentBytes, { mode: 0o400 });
    const attachmentPath = await fs.realpath(attachmentFilePath);
    const attachment = {
      attachmentId: 'scoped-attachment-1',
      ordinal: 0,
      displayName: 'reference.txt',
      kind: 'text' as const,
      mediaType: 'text/plain',
      byteCount: attachmentBytes.byteLength,
      sha256: createHash('sha256').update(attachmentBytes).digest('hex'),
      path: attachmentPath,
      verifiedAt: new Date().toISOString()
    };
    const store = new FileTaskStore(path.join(dir, 'task-store'));
    const runtime = new FileAgentRuntimeStore(path.join(dir, 'runtime'));
    await runtime.init();
    const adapter = createCodexAdapter(store, new AppEventBus(), {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
      runtimeStore: runtime
    });
    try {
      await adapter.initialize();
      const owner = {
        kind: 'DISCOURSE' as const,
        conversationId: 'conversation-attachment-preflight',
        stableParticipantId: 'participant-attachment-preflight'
      };
      const sessionId = 'scoped-session-attachment-preflight';
      const executionContext = await adapter.buildExecutionContext({
        sessionId,
        primaryCwd: workspace,
        readRoots: [{ canonicalPath: workspace, kind: 'EMPTY_MANAGED' }],
        modelSettings: {
          runtimeId: 'codex',
          model: 'fake-model',
          reasoningEffort: 'high',
          sandbox: 'READ_ONLY',
          networkAccess: false,
          approvalPolicy: 'NEVER',
          approvalsReviewer: 'user'
        },
        clientOperationId: 'scoped-attachment-preflight-context',
        attachments: [attachment]
      });
      const session = await runtime.createSession({
        id: sessionId,
        owner,
        accessEpoch: createAgentSessionAccessEpoch({
          owner,
          sessionId,
          epoch: 1,
          runtimeId: 'codex',
          model: 'fake-model',
          executionContext,
          createdAt: '2026-07-13T00:00:00.000Z'
        }),
        executionContext,
        clientOperationId: 'create-scoped-attachment-preflight-session',
        runtimeId: 'codex',
        role: 'PRIMARY',
        relationshipState: 'ROOT',
        status: 'NOT_MATERIALIZED',
        materialized: false,
        requestedSettings: executionContext.modelSettings
      });
      let run = await runtime.createRun({
        id: 'scoped-run-attachment-preflight',
        owner,
        scope: {
          kind: 'DISCOURSE',
          conversationId: owner.conversationId,
          waveId: 'wave-attachment-preflight',
          jobId: 'job-attachment-preflight',
          contextSnapshotId: 'context-attachment-preflight',
          attemptId: 'attempt-attachment-preflight'
        },
        sessionId: session.id,
        sessionAccessEpoch: session.accessEpoch.epoch,
        purpose: 'DISCOURSE_ANSWER',
        generationKey: 'generation-attachment-preflight',
        clientOperationId: 'create-scoped-attachment-preflight-run',
        requestedSettings: executionContext.modelSettings,
        promptArtifactId: 'scoped-attachment-preflight-prompt',
        outputArtifactId: 'scoped-attachment-preflight-output',
        diagnosticArtifactId: 'scoped-attachment-preflight-diagnostic',
        attachmentSelection: [attachment]
      });
      run = await runtime.updateRun(
        run.id,
        run.recordRevision,
        {
          status: 'STARTING',
          delivery: 'SENDING',
          startedAt: '2026-07-13T00:00:01.000Z'
        },
        'scoped-attachment-preflight-start-intent'
      );
      await fs.unlink(attachmentPath);

      const failure = await adapter
        .startRuntimeTurn({
          session,
          run,
          executionContext,
          prompt: 'Use the selected reference.',
          attachments: [attachment]
        })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AgentRuntimeDeliveryError);
      expect(failure).toMatchObject({
        delivery: 'NOT_DELIVERED',
        message: expect.stringContaining('is missing or no longer accessible')
      });
      const server = (await runtime.snapshot()).servers[0]!;
      const outbound = readOutboundMessages(
        await fs.readFile(server.protocolJournalPath, 'utf8')
      );
      expect(outbound.map((message) => message.method)).not.toContain('thread/start');
      expect(outbound.map((message) => message.method)).not.toContain('turn/start');
    } finally {
      await adapter.shutdown();
      await runtime.close();
    }
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it.each([
    {
      name: 'confirms a scoped interruption by stopping Codex when no terminal arrives',
      mode: 'scoped-interrupt-no-terminal',
      action: 'interrupt',
      terminalStatus: 'INTERRUPTED'
    },
    {
      name: 'persists a scoped interruption that races with the acknowledgement checkpoint',
      mode: 'scoped-interrupt-terminal-race',
      action: 'interrupt',
      terminalStatus: 'INTERRUPTED'
    },
    {
      name: 'settles a scoped owner through the canonical server-loss sweep',
      mode: 'scoped-interrupt-no-terminal',
      action: 'process-loss',
      terminalStatus: 'RECOVERY_REQUIRED'
    }
  ] as const)('$name', async ({ mode, action, terminalStatus }) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-scoped-interrupt-'));
    const executable = await writeFakeCodexExecutable(dir, mode);
    const workspacePath = path.join(dir, 'read-only-workspace');
    await fs.mkdir(workspacePath, { mode: 0o700 });
    const workspace = await fs.realpath(workspacePath);
    const store = new FileTaskStore(path.join(dir, 'task-store'));
    const runtime = new FileAgentRuntimeStore(path.join(dir, 'runtime'));
    await runtime.init();
    const adapter = createCodexAdapter(store, new AppEventBus(), {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      interruptCompletionTimeoutMs: 25,
      restartDelaysMs: [],
      runtimeStore: runtime
    });
    try {
      await adapter.initialize();
      const owner = {
        kind: 'DISCOURSE' as const,
        conversationId: 'conversation-interrupt',
        stableParticipantId: 'participant-interrupt'
      };
      const sessionId = 'scoped-session-interrupt';
      const executionContext = await adapter.buildExecutionContext({
        sessionId,
        primaryCwd: workspace,
        readRoots: [{ canonicalPath: workspace, kind: 'EMPTY_MANAGED' }],
        modelSettings: {
          runtimeId: 'codex',
          model: 'fake-model',
          modelProvider: 'openai',
          reasoningEffort: 'high',
          sandbox: 'READ_ONLY',
          networkAccess: false,
          approvalPolicy: 'NEVER',
          approvalsReviewer: 'user'
        },
        clientOperationId: 'scoped-interrupt-context'
      });
      let session = await runtime.createSession({
        id: sessionId,
        owner,
        accessEpoch: createAgentSessionAccessEpoch({
          owner,
          sessionId,
          epoch: 1,
          runtimeId: 'codex',
          model: 'fake-model',
          executionContext,
          createdAt: '2026-07-13T00:00:00.000Z'
        }),
        executionContext,
        clientOperationId: 'create-scoped-interrupt-session',
        runtimeId: 'codex',
        role: 'PRIMARY',
        relationshipState: 'ROOT',
        status: 'NOT_MATERIALIZED',
        materialized: false,
        requestedSettings: executionContext.modelSettings
      });
      let run = await runtime.createRun({
        id: 'scoped-run-interrupt',
        owner,
        scope: {
          kind: 'DISCOURSE',
          conversationId: owner.conversationId,
          waveId: 'wave-interrupt',
          jobId: 'job-interrupt',
          contextSnapshotId: 'context-interrupt',
          attemptId: 'attempt-interrupt'
        },
        sessionId: session.id,
        sessionAccessEpoch: session.accessEpoch.epoch,
        purpose: 'DISCOURSE_ANSWER',
        generationKey: 'generation-interrupt',
        clientOperationId: 'create-scoped-interrupt-run',
        requestedSettings: executionContext.modelSettings,
        promptArtifactId: 'scoped-interrupt-prompt',
        outputArtifactId: 'scoped-interrupt-output',
        diagnosticArtifactId: 'scoped-interrupt-diagnostic'
      });
      await Promise.all([
        runtime.createArtifact({
          id: run.promptArtifactId,
          owner,
          runId: run.id,
          kind: 'PROMPT',
          clientOperationId: 'create-scoped-interrupt-prompt',
          content: 'Keep this response active until it is interrupted.'
        }),
        runtime.createArtifact({
          id: run.outputArtifactId,
          owner,
          runId: run.id,
          kind: 'OUTPUT',
          clientOperationId: 'create-scoped-interrupt-output',
          content: ''
        }),
        runtime.createArtifact({
          id: run.diagnosticArtifactId,
          owner,
          runId: run.id,
          kind: 'DIAGNOSTIC',
          clientOperationId: 'create-scoped-interrupt-diagnostic',
          content: ''
        })
      ]);
      run = await runtime.updateRun(
        run.id,
        run.recordRevision,
        {
          status: 'STARTING',
          delivery: 'SENDING',
          startedAt: '2026-07-13T00:00:01.000Z'
        },
        'scoped-interrupt-start-intent'
      );
      const started = await adapter.startRuntimeTurn({
        session,
        run,
        executionContext,
        prompt: 'Keep this response active until it is interrupted.',
        attachments: []
      });
      session = (await runtime.getSession(session.id))!;
      session = await runtime.updateSession(
        session.id,
        session.recordRevision,
        {
          providerSessionId: started.providerSessionId,
          ...(started.providerSessionTreeId
            ? { providerSessionTreeId: started.providerSessionTreeId }
            : {}),
          status: 'ACTIVE',
          materialized: true
        },
        'scoped-interrupt-session-ack'
      );
      run = (await runtime.getRun(run.id))!;
      if (action === 'interrupt') {
        run = await runtime.updateRun(
          run.id,
          run.recordRevision,
          {
            serverInstanceId: started.serverInstanceId,
            providerTurnId: started.providerTurnId,
            status: 'INTERRUPTING',
            delivery: 'ACKNOWLEDGED',
            interruptDelivery: 'SENDING',
            stopRequestedAt: '2026-07-13T00:00:02.000Z'
          },
          'scoped-interrupt-stop-intent'
        );
        await adapter.interruptRuntimeTurn({ session, run });
        run = (await runtime.getRun(run.id))!;
        if (run.interruptDelivery === 'SENDING') {
          await runtime.updateRun(
            run.id,
            run.recordRevision,
            { interruptDelivery: 'ACKNOWLEDGED' },
            'scoped-interrupt-ack'
          );
        }
      } else {
        run = await runtime.updateRun(
          run.id,
          run.recordRevision,
          {
            serverInstanceId: started.serverInstanceId,
            providerTurnId: started.providerTurnId,
            status: 'RUNNING',
            delivery: 'ACKNOWLEDGED'
          },
          'scoped-process-loss-ack'
        );
        const supervisor = (
          adapter as unknown as { supervisor: CodexAppServerSupervisor }
        ).supervisor;
        await supervisor.terminateUnresponsive('Injected scoped process loss.');
      }
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        run = (await runtime.getRun(run.id))!;
        if (run.status === terminalStatus) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      await expect(runtime.getRun(run.id)).resolves.toMatchObject(
        action === 'process-loss'
          ? {
              status: 'RECOVERY_REQUIRED',
              delivery: 'AMBIGUOUS',
              recoveryState: 'REQUIRES_USER_ACTION',
              providerTerminalSource: 'PROVIDER_PROCESS_LOSS'
            }
          : {
              status: 'INTERRUPTED',
              delivery: 'TERMINAL',
              interruptDelivery: 'TERMINAL',
              recoveryState: 'NONE',
              providerTerminalSource:
                mode === 'scoped-interrupt-no-terminal'
                  ? 'CONFIRMED_STOP_AFTER_RUNTIME_INTERRUPT'
                  : 'TURN_COMPLETED_NOTIFICATION'
            }
      );
    } finally {
      await adapter.shutdown();
      await runtime.close();
    }
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it.each([
    {
      name: 'fails only after Codex confirms the turn stopped when a request arrives before the local start acknowledgement',
      mode: 'scoped-unexpected-request-before-ack',
      expectedStatus: 'FAILED',
      expectedSource: 'TURN_COMPLETED_NOTIFICATION_AFTER_UNEXPECTED_SERVER_REQUEST',
      terminationFailure: false
    },
    {
      name: 'fails only after Codex confirms the turn stopped when a request arrives after acknowledgement',
      mode: 'scoped-unexpected-request-after-ack',
      expectedStatus: 'FAILED',
      expectedSource: 'TURN_COMPLETED_NOTIFICATION_AFTER_UNEXPECTED_SERVER_REQUEST',
      terminationFailure: false
    },
    {
      name: 'fails after a confirmed local process stop when interrupt delivery is ambiguous',
      mode: 'scoped-unexpected-request-ambiguous-stop',
      expectedStatus: 'FAILED',
      expectedSource: 'CONFIRMED_STOP_AFTER_UNEXPECTED_SERVER_REQUEST',
      terminationFailure: false
    },
    {
      name: 'stops Codex before failing an acknowledged unexpected request with no terminal event',
      mode: 'scoped-unexpected-request-no-terminal',
      expectedStatus: 'FAILED',
      expectedSource: 'CONFIRMED_STOP_AFTER_UNEXPECTED_SERVER_REQUEST',
      terminationFailure: false
    },
    {
      name: 'requires recovery when neither an ambiguous interrupt nor local termination confirms the stop',
      mode: 'scoped-unexpected-request-ambiguous-stop',
      expectedStatus: 'RECOVERY_REQUIRED',
      expectedSource: 'UNEXPECTED_SERVER_REQUEST',
      terminationFailure: true
    }
  ] as const)('$name', async ({
    mode,
    expectedStatus,
    expectedSource,
    terminationFailure
  }) => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-scoped-unexpected-request-')
    );
    const executable = await writeFakeCodexExecutable(dir, mode);
    const workspacePath = path.join(dir, 'read-only-workspace');
    await fs.mkdir(workspacePath, { mode: 0o700 });
    const workspace = await fs.realpath(workspacePath);
    const store = new FileTaskStore(path.join(dir, 'task-store'));
    const runtime = new FileAgentRuntimeStore(path.join(dir, 'runtime'));
    await runtime.init();
    const events = new AppEventBus();
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      interruptRequestTimeoutMs: 40,
      interruptCompletionTimeoutMs: 100,
      restartDelaysMs: [],
      runtimeStore: runtime
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter);
    let terminate: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await orchestrator.initialize();
      if (terminationFailure) {
        const supervisor = (
          adapter as unknown as { supervisor: CodexAppServerSupervisor }
        ).supervisor;
        terminate = vi
          .spyOn(supervisor, 'terminateUnresponsive')
          .mockRejectedValue(new Error('injected unconfirmed process stop'));
      }
      const owner = {
        kind: 'DISCOURSE' as const,
        conversationId: `conversation-${mode}`,
        stableParticipantId: 'participant-unexpected-request'
      };
      const sessionId = `session-${mode}`;
      const executionContext = await orchestrator.buildExecutionContext('codex', {
        sessionId,
        primaryCwd: workspace,
        readRoots: [{ canonicalPath: workspace, kind: 'EMPTY_MANAGED' }],
        modelSettings: {
          runtimeId: 'codex',
          model: 'fake-model',
          modelProvider: 'openai',
          reasoningEffort: 'high',
          sandbox: 'READ_ONLY',
          networkAccess: false,
          approvalPolicy: 'NEVER',
          approvalsReviewer: 'user'
        },
        clientOperationId: `unexpected-request-context-${mode}`
      });
      const prepared = await orchestrator.prepareTurn({
        sessionId,
        runId: `run-${mode}`,
        owner,
        scope: {
          kind: 'DISCOURSE',
          conversationId: owner.conversationId,
          waveId: 'wave-unexpected-request',
          jobId: 'job-unexpected-request',
          contextSnapshotId: 'context-unexpected-request',
          attemptId: 'attempt-unexpected-request'
        },
        runtimeId: 'codex',
        model: 'fake-model',
        purpose: 'DISCOURSE_ANSWER',
        generationKey: `generation-${mode}`,
        executionContext,
        prompt: 'Inspect this repository without changing it.',
        priority: 'DISCOURSE_BACKGROUND',
        clientOperationId: `unexpected-request-run-${mode}`,
        createdAt: new Date().toISOString()
      });

      await orchestrator.startPreparedTurnNow(
        prepared.queueEntry.id,
        `unexpected-request-start-${mode}`
      );
      let settled = await runtime.getRun(prepared.run.id);
      for (let attempt = 0; attempt < 500; attempt += 1) {
        if (settled?.status === expectedStatus) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
        settled = await runtime.getRun(prepared.run.id);
      }

      expect(settled).toMatchObject({
        status: expectedStatus,
        providerTurnId: 'turn-1',
        providerTerminalSource: expectedSource,
        terminalReason: expect.stringContaining(
          'Codex requested item/commandExecution/requestApproval during a read-only turn.'
        )
      });
      if (expectedStatus === 'FAILED') {
        expect(settled).toMatchObject({
          delivery: 'TERMINAL',
          interruptDelivery: 'TERMINAL',
          recoveryState: 'NONE',
          endedAt: expect.any(String)
        });
      } else {
        expect(settled).toMatchObject({
          delivery: 'ACKNOWLEDGED',
          interruptDelivery: 'AMBIGUOUS',
          recoveryState: 'REQUIRES_USER_ACTION'
        });
        expect(settled).not.toHaveProperty('endedAt');
      }
      const diagnostic = await runtime.readArtifact(prepared.run.diagnosticArtifactId);
      expect(diagnostic).toContain(
        'Codex requested item/commandExecution/requestApproval during a read-only turn.'
      );
      expect(Buffer.byteLength(diagnostic, 'utf8')).toBeLessThan(1_024);
      const server = (await runtime.snapshot()).servers[0]!;
      const outbound = readOutboundMessages(
        await fs.readFile(server.protocolJournalPath, 'utf8')
      );
      expect(outbound.find((message) => message.id === 201 && !message.method)).toMatchObject({
        error: {
          code: -32000,
          message: 'Read-only turns cannot request approvals, tools, or user input.'
        }
      });
      expect(outbound.map((message) => message.method)).toContain('turn/interrupt');
    } finally {
      terminate?.mockRestore();
      await orchestrator.shutdown();
      await runtime.close();
    }
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('can initialize again after a confirmed idle shutdown', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-app-server-reenable-'));
    const executable = await writeFakeCodexExecutable(dir);
    const store = new FileTaskStore(path.join(dir, 'store'));
    const adapter = createCodexAdapter(store, new AppEventBus(), {
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
    const adapter = createCodexAdapter(store, new AppEventBus(), {
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
    const adapter = createCodexAdapter(store, new AppEventBus(), {
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
    const adapter = createCodexAdapter(
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
    const adapter = createCodexAdapter(store, new AppEventBus(), {
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
    const adapter = createCodexAdapter(store, new AppEventBus(), {
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
      const session = await createTestAgentSession(store, {
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

  it('scopes the validated Design skill catalog and read root to a Design turn', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-design-skills-app-server-'));
    const executable = await writeFakeCodexExecutable(dir);
    const designSkillRoot = await fs.realpath(path.resolve('resources/design-skills'));
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
      designSkillRoot
    });
    adapter.setDesignBrowserToolHandler(async () => ({ text: 'candidate ready' }));
    const orchestrator = createAgentOrchestrator(store, events, adapter);
    await orchestrator.initialize();
    const { task, iteration, worktree, turnId } = await createDesignTaskContext(
      store,
      dir
    );

    const terminal = waitForAppEvent(events, 'run.terminal');
    const run = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'DESIGN',
      prompt: task.prompt,
      instructionProfile: 'DESIGN',
      generationKey: turnId,
      settings: task.agentSettings
    });
    await terminal;
    expect(await store.getRun(run.id)).toMatchObject({ status: 'COMPLETED' });

    const server = (await store.snapshot()).agentServers[0]!;
    const journal = await fs.readFile(server.protocolJournalPath, 'utf8');
    const messages = readOutboundMessages(journal);
    expect(messages.map((message) => message.method)).not.toContain(
      'skills/extraRoots/set'
    );
    const threadStart = messages.find((message) => message.method === 'thread/start');
    const config = (
      threadStart?.params as {
        config?: {
          default_permissions?: string;
          permissions?: Record<
            string,
            { filesystem?: Record<string, 'read' | 'write'>; network?: { enabled?: boolean } }
          >;
        };
      }
    )?.config;
    const profileId = config?.default_permissions;
    const filesystem = profileId
      ? config?.permissions?.[profileId]?.filesystem
      : undefined;
    expect(filesystem?.[designSkillRoot]).toBe('read');
    expect(filesystem?.[worktree.worktreePath]).toBe('write');
    expect(profileId ? config?.permissions?.[profileId]?.network?.enabled : undefined).toBe(
      false
    );

    const turnStart = messages.find((message) => message.method === 'turn/start');
    const developerInstructions = (
      turnStart?.params as {
        collaborationMode?: { settings?: { developer_instructions?: string } };
      }
    )?.collaborationMode?.settings?.developer_instructions;
    expect(developerInstructions).toContain('Task Monki Design skills:');
    expect(developerInstructions).toContain(
      path.join(designSkillRoot, 'prototype', 'SKILL.md')
    );
    expect(developerInstructions).toContain(
      'Use only inspect_design for rendered verification.'
    );
    expect(developerInstructions).toContain(
      'skill files cannot lower these rules.'
    );

    await orchestrator.shutdown();
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('registers the narrow Design browser tool and omits returned images from durable records', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-design-browser-tool-'));
    const executable = await writeFakeCodexExecutable(dir, 'design-browser');
    const designSkillRoot = await fs.realpath(path.resolve('resources/design-skills'));
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
      designSkillRoot
    });
    const inspect = vi.fn(async () => ({
      text: 'The candidate opened without console errors.',
      image: {
        mimeType: 'image/png' as const,
        bytes: Buffer.from('transient-browser-image'),
        width: 1,
        height: 1
      }
    }));
    adapter.setDesignBrowserToolHandler(inspect);
    const orchestrator = createAgentOrchestrator(store, events, adapter);
    await orchestrator.initialize();
    const { task, iteration, worktree, turnId } = await createDesignTaskContext(
      store,
      dir
    );

    const terminal = waitForAppEvent(events, 'run.terminal');
    const run = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'DESIGN',
      prompt: task.prompt,
      instructionProfile: 'DESIGN',
      generationKey: turnId,
      settings: task.agentSettings
    });
    await terminal;

    expect(inspect).toHaveBeenCalledWith({
      runId: run.id,
      operation: { operation: 'open_candidate' }
    });
    expect(await store.getRun(run.id)).toMatchObject({ status: 'COMPLETED' });
    const snapshot = await store.snapshot();
    const browserItem = snapshot.agentItems.find(
      (item) => item.runId === run.id && item.providerItemId === 'design-browser-call'
    );
    expect(browserItem).toMatchObject({
      status: 'COMPLETED',
      payload: {
        type: 'dynamicToolCall',
        tool: 'inspect_design',
        contentItems: [
          { type: 'inputText', text: 'The candidate opened without console errors.' },
          { type: 'inputImage', imageUrl: '[transient Design screenshot omitted]' }
        ]
      }
    });
    const server = snapshot.agentServers[0]!;
    const journal = await fs.readFile(server.protocolJournalPath, 'utf8');
    expect(journal).not.toContain(Buffer.from('transient-browser-image').toString('base64'));
    expect(journal).toContain('[transient Design screenshot omitted]');
    const threadStart = readOutboundMessages(journal).find(
      (message) => message.method === 'thread/start'
    );
    expect(threadStart?.params).toMatchObject({
      dynamicTools: [
        {
          type: 'function',
          name: 'inspect_design',
          inputSchema: { additionalProperties: false, required: ['operation'] }
        }
      ]
    });

    await orchestrator.shutdown();
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('forks Design history into an exact permission scope when later references change', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-design-reference-scope-'));
    const executable = await writeFakeCodexExecutable(dir, 'profile-rebind');
    const designSkillRoot = await fs.realpath(path.resolve('resources/design-skills'));
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
      designSkillRoot
    });
    adapter.setDesignBrowserToolHandler(async () => ({ text: 'candidate ready' }));
    const orchestrator = createAgentOrchestrator(store, events, adapter);
    await orchestrator.initialize();
    const { task, iteration, worktree, turnId } = await createDesignTaskContext(
      store,
      dir,
      { initialAttachment: { displayName: 'first.txt', body: 'First direction' } }
    );

    const firstTerminal = waitForAppEvent(events, 'run.terminal');
    const firstRun = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'DESIGN',
      prompt: task.prompt,
      instructionProfile: 'DESIGN',
      generationKey: turnId,
      settings: task.agentSettings
    });
    await firstTerminal;

    const laterDraft = await store.createAttachmentDraft();
    await store.stageTaskAttachment({
      draftId: laterDraft.id,
      displayName: 'later.txt',
      bytes: Buffer.from('Later direction')
    });
    const laterTurn = await store.createInlineDesignTurn({
      designId: task.id,
      clientMessageId: 'later-reference-turn',
      message: 'Use only the later direction.',
      referenceIds: [],
      attachmentDraftId: laterDraft.id
    });
    const laterTask = (await store.getTask(task.id))!;
    const laterRun = await orchestrator.startTurn({
      task: laterTask,
      iteration,
      worktree,
      mode: 'DESIGN',
      prompt: 'Use only the later direction.',
      instructionProfile: 'DESIGN',
      generationKey: laterTurn.id,
      settings: laterTask.agentSettings
    });

    const server = (await store.snapshot()).agentServers[0]!;
    const outbound = readOutboundMessages(
      await fs.readFile(server.protocolJournalPath, 'utf8')
    );
    const threadStart = outbound.find((message) => message.method === 'thread/start');
    const profileFork = outbound.find((message) => message.method === 'thread/fork');
    const firstConfig = (threadStart?.params as { config: unknown }).config as {
      default_permissions: string;
    };
    const laterConfig = (profileFork?.params as { config: unknown }).config as typeof firstConfig;
    const runtime = runtimeForTaskStore(store);
    const firstAccess = (await runtime.getSession(firstRun.sessionId))!.executionContext
      .managedAttachments;
    const laterAccess = (await runtime.getSession(laterRun.sessionId))!.executionContext
      .managedAttachments;

    expect(firstConfig.default_permissions).not.toBe(laterConfig.default_permissions);
    expect(laterRun.sessionId).not.toBe(firstRun.sessionId);
    expect(
      (await store.snapshot()).agentSessions.filter(
        (session) => session.taskId === task.id && session.role === 'PRIMARY'
      )
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: firstRun.sessionId, providerSessionId: 'thread-1' }),
        expect.objectContaining({ id: laterRun.sessionId, providerSessionId: 'thread-rebound' })
      ])
    );
    expect(firstAccess).toHaveLength(1);
    expect(laterAccess).toHaveLength(1);
    expect(firstAccess[0]?.attachmentId).not.toBe(laterAccess[0]?.attachmentId);
    expect(JSON.stringify(outbound)).not.toContain(
      `${path.sep}attachments${path.sep}tasks${path.sep}`
    );
    expect(outbound.filter((message) => message.method === 'turn/start')).toHaveLength(2);
    expect(outbound).toContainEqual(
      expect.objectContaining({
        method: 'thread/unsubscribe',
        params: { threadId: 'thread-1' }
      })
    );

    await orchestrator.shutdown();
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('sends a selected Design image as a native input on every turn', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-design-image-turns-'));
    const executable = await writeFakeCodexExecutable(dir, 'profile-rebind');
    const designSkillRoot = await fs.realpath(path.resolve('resources/design-skills'));
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
      designSkillRoot
    });
    adapter.setDesignBrowserToolHandler(async () => ({ text: 'candidate ready' }));
    const orchestrator = createAgentOrchestrator(store, events, adapter);
    await orchestrator.initialize();
    const { task, iteration, worktree, turnId } = await createDesignTaskContext(
      store,
      dir,
      { initialAttachment: { displayName: 'reference.png', body: onePixelPng() } }
    );
    const [reference] = (await store.getDesignDetail(task.id)).references;

    const firstTerminal = waitForAppEvent(events, 'run.terminal');
    const firstRun = await orchestrator.startTurn({
      task,
      iteration,
      worktree,
      mode: 'DESIGN',
      prompt: task.prompt,
      instructionProfile: 'DESIGN',
      generationKey: turnId,
      settings: task.agentSettings
    });
    await firstTerminal;

    const laterTurn = await store.createInlineDesignTurn({
      designId: task.id,
      clientMessageId: 'reuse-image-turn',
      message: 'Use this image again.',
      referenceIds: [reference!.id]
    });
    const laterRun = await orchestrator.startTurn({
      task: (await store.getTask(task.id))!,
      iteration,
      worktree,
      mode: 'DESIGN',
      prompt: 'Use this image again.',
      instructionProfile: 'DESIGN',
      generationKey: laterTurn.id,
      settings: task.agentSettings
    });

    const server = (await store.snapshot()).agentServers[0]!;
    const turnStarts = readOutboundMessages(
      await fs.readFile(server.protocolJournalPath, 'utf8')
    ).filter((message) => message.method === 'turn/start');
    expect(firstRun.sessionId).toBe(laterRun.sessionId);
    expect(turnStarts).toHaveLength(2);
    expect(
      turnStarts.map((message) =>
        (message.params as { input?: Array<{ type?: string }> }).input?.filter(
          (item) => item.type === 'localImage'
        ).length
      )
    ).toEqual([1, 1]);

    await orchestrator.shutdown();
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('releases task-owned permission profile state without deleting provider history', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-codex-release-task-'));
    const executable = await writeFakeCodexExecutable(dir);
    const store = new FileTaskStore(path.join(dir, 'store'));
    const adapter = createCodexAdapter(store, new AppEventBus(), {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    try {
      await adapter.initialize();
      const { task, iteration, worktree } = await createDesignTaskContext(store, dir);
      const created = await createTestAgentSession(store, {
        task,
        iteration,
        worktree,
        runtimeId: 'codex',
        requestedSettings: task.agentSettings
      });
      const session = await updateTestAgentSession(store, created.id, {
        providerSessionId: 'thread-1',
        status: 'IDLE',
        materialized: true
      });
      const internals = (
        adapter as unknown as {
          activePermissionProfiles: Map<
            string,
            { providerSessionId: string; profileId: string }
          >;
          unmaterializedThreadAttestations: Map<string, unknown>;
        }
      );
      const profiles = internals.activePermissionProfiles;
      profiles.set(session.id, {
        providerSessionId: 'thread-1',
        profileId: 'task-monki-profile-1'
      });
      internals.unmaterializedThreadAttestations.set(session.id, {});

      await adapter.releaseTask(task.id);

      expect(profiles.size).toBe(0);
      expect(internals.unmaterializedThreadAttestations.size).toBe(0);
      expect(await taskRuntimeForTaskStore(store).getAgentSession(session.id)).toMatchObject({
        providerSessionId: 'thread-1',
        status: 'NOT_LOADED'
      });
      const server = (await store.snapshot()).agentServers[0]!;
      const outbound = readOutboundMessages(
        await fs.readFile(server.protocolJournalPath, 'utf8')
      );
      expect(outbound).toContainEqual(
        expect.objectContaining({
          method: 'thread/unsubscribe',
          params: { threadId: 'thread-1' }
        })
      );
    } finally {
      await adapter.shutdown();
      await store.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('deletes the complete stored Design thread tree from children to root', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-codex-delete-design-'));
    const executable = await writeFakeCodexExecutable(dir, 'design-delete');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const { task, iteration, worktree } = await createDesignTaskContext(store, dir);
    const adapter = createCodexAdapter(store, new AppEventBus(), {
      cwd: worktree.worktreePath,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    try {
      await adapter.initialize();
      const created = await createTestAgentSession(store, {
        task,
        iteration,
        worktree,
        runtimeId: 'codex',
        requestedSettings: task.agentSettings
      });
      await updateTestAgentSession(store, created.id, {
        providerSessionId: 'thread-1',
        providerSessionTreeId: 'session-tree-1',
        status: 'IDLE',
        materialized: true
      });

      await adapter.deleteDesignTaskThreads(task.id);

      const server = (await store.snapshot()).agentServers[0]!;
      const outbound = readOutboundMessages(
        await fs.readFile(server.protocolJournalPath, 'utf8')
      );
      expect(
        outbound
          .filter((message) => message.method === 'thread/delete')
          .map((message) => (message.params as { threadId: string }).threadId)
      ).toEqual(['thread-child', 'thread-review', 'thread-1']);
      expect(
        outbound.filter((message) => message.method === 'thread/list')
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ params: expect.objectContaining({ archived: false }) }),
          expect.objectContaining({ params: expect.objectContaining({ archived: true }) })
        ])
      );
    } finally {
      await adapter.shutdown();
      await store.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps normal Codex work available when the Design skill pack is missing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-missing-design-skills-'));
    const executable = await writeFakeCodexExecutable(dir);
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
      designSkillRoot: path.join(dir, 'missing-design-skills')
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter);
    await orchestrator.initialize();

    await expect(adapter.capabilities()).resolves.toMatchObject({
      extensions: {
        'task-monki.design-skill-access': { maturity: 'unsupported' }
      }
    });
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
    expect(await store.getRun(run.id)).toMatchObject({ status: 'COMPLETED' });

    await orchestrator.shutdown();
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('completes attachment delivery with Codex external tools enabled', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-app-server-'));
    const executable = await writeFakeCodexExecutable(dir);

    const store = new FileTaskStore(path.join(dir, 'store'));
    const appendArtifact = vi.spyOn(runtimeForTaskStore(store), 'appendArtifact');
    const events = new AppEventBus();
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
      toolSettings: {
        webSearchMode: 'live',
        mcpServers: 'all',
        apps: 'enabled'
      }
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter, {
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
    expect(initializedServer.argv).toEqual(expect.arrayContaining([
      'features.apps=true',
      'web_search="live"'
    ]));
    const initializedJournal = await fs.readFile(
      initializedServer.protocolJournalPath,
      'utf8'
    );
    const initializeMessage = readOutboundMessages(initializedJournal).find(
      (message) => message.method === 'initialize'
    );
    expect(initializeMessage?.params).toMatchObject({
      capabilities: {
        experimentalApi: true,
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
    await git(repositoryDir, ['init']);
    await git(repositoryDir, [
      'config',
      'user.email',
      'codex-adapter@example.invalid'
    ]);
    await git(repositoryDir, ['config', 'user.name', 'Codex Adapter Test']);
    await fs.writeFile(
      path.join(repositoryDir, 'README.md'),
      '# Adapter fixture\n',
      'utf8'
    );
    await git(repositoryDir, ['add', 'README.md']);
    await git(repositoryDir, ['commit', '-m', 'Initial adapter fixture']);
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
    const completed = await taskRuntimeForTaskStore(store).getRun(run.id);
    expect(completed?.status).toBe('COMPLETED');
    expect(completed?.providerTurnId).toBe('turn-1');
    expect(completed?.finalMessage).toBe('Fake task completed.');
    expect(appendArtifact).toHaveBeenCalledTimes(1);
    expect(appendArtifact.mock.calls[0]?.[1]).toContain('Fake task completed.');
    expect(
      await runtimeForTaskStore(store).readArtifact(completed!.outputArtifactId)
    ).toContain(
      'Fake task completed.'
    );
    expect(completed?.attachmentSubmissions).toEqual([
      expect.objectContaining({
        kind: 'image',
        transport: 'native-image',
        correlation: { kind: 'provider-turn', id: 'turn-1' },
        submittedAt: expect.any(String)
      }),
      expect.objectContaining({
        kind: 'text',
        transport: 'managed-path',
        correlation: { kind: 'provider-turn', id: 'turn-1' },
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
    expect(finalJournal).not.toContain(canonicalImagePath);
    expect(finalJournal).not.toContain(canonicalTextPath);
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
      allow_login_shell?: boolean;
      shell_environment_policy?: {
        inherit?: string;
        set?: Record<string, string>;
      };
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
    expect(profile?.filesystem?.[await fs.realpath(path.join(repositoryDir, '.git'))]).toBe(
      'read'
    );
    expect(profile?.network?.enabled).toBe(false);
    expect(profileConfig?.allow_login_shell).toBe(false);
    expect(profileConfig?.shell_environment_policy).toMatchObject({
      inherit: 'all',
      set: {
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_OPTIONAL_LOCKS: '0'
      }
    });
    expect(profileConfig?.shell_environment_policy?.set).not.toHaveProperty('HOME');
    expect(profileConfig?.shell_environment_policy?.set).not.toHaveProperty(
      'XDG_CONFIG_HOME'
    );
    const implementationPath = profileConfig?.shell_environment_policy?.set?.PATH;
    expect(implementationPath).toEqual(expect.any(String));
    if (process.platform === 'darwin') {
      expect(implementationPath?.split(path.delimiter)[0]).not.toBe('/usr/bin');
    }
    const turnInput = (turnStart?.params as {
      input?: Array<{ type?: string; text?: string; path?: string }>;
    } | undefined)?.input;
    const deliveryImagePath = turnInput?.find((item) => item.type === 'localImage')?.path;
    expect(turnInput).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('attachment input omitted')
      }),
      { type: 'localImage', path: deliveryImagePath }
    ]);
    expect(deliveryImagePath).toContain('managed attachment path omitted');

    await orchestrator.shutdown();
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('redacts Codex telemetry before normalized records and output artifacts are persisted', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-codex-redaction-'));
    const executable = await writeFakeCodexExecutable(dir, 'credential-telemetry');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      environment: {
        ...process.env,
        OPENAI_API_KEY: 'opaque-provider-credential-1742'
      },
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter);
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
    const output = await runtimeForTaskStore(store).readArtifact(
      completed.outputArtifactId
    );
    const final = await runtimeForTaskStore(store).readArtifact(
      completed.finalArtifactId!
    );
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
    const adapter = createCodexAdapter(store, new AppEventBus(), {
      cwd: dir,
      environment: {
        OPENAI_API_KEY: 'opaque-provider-credential-1742'
      },
      restartDelaysMs: []
    });
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const session = await createTestAgentSession(store, {
      task,
      iteration,
      worktree,
      runtimeId: 'codex',
      requestedSettings: task.agentSettings
    });
    const run = await createTestRun(store, {
      task,
      session,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      requestedSettings: task.agentSettings
    });
    await updateTestRun(store, run.id, {
      providerTurnId: 'buffered-turn',
      status: 'RUNNING'
    });
    const buffered = adapter as unknown as {
      appendTurnOutput(turnId: string, source: string, text: string): Promise<void>;
      flushBufferedOutput(runId: string, releaseCredentialCarry?: boolean): Promise<void>;
    };
    const runtime = runtimeForTaskStore(store);
    const appendArtifact = runtime.appendArtifact.bind(runtime);
    let releasePersistence!: () => void;
    let markPersistenceStarted!: () => void;
    const persistenceRelease = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const persistenceStarted = new Promise<void>((resolve) => {
      markPersistenceStarted = resolve;
    });
    let appendAttempts = 0;
    vi.spyOn(runtime, 'appendArtifact').mockImplementation(async (...args) => {
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

    const output = await runtimeForTaskStore(store).readArtifact(run.outputArtifactId);
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

    const output = await runtimeForTaskStore(store).readArtifact(run.outputArtifactId);
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

    const output = await runtimeForTaskStore(store).readArtifact(run.outputArtifactId);
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
    const appendArtifact = vi.spyOn(
      runtimeForTaskStore(store),
      'appendArtifact'
    ).mockRejectedValue(
      new AgentRuntimeArtifactMutationAmbiguousError(
        `Artifact ${run.outputArtifactId} append outcome is ambiguous.`,
        { cause: new Error('injected artifact persistence failure') }
      )
    );

    await buffered.appendTurnOutput('buffered-turn', 'agentMessage', 'safe output');
    await expect(buffered.flushBufferedOutput(run.id)).rejects.toBeInstanceOf(
      AgentRuntimeArtifactMutationAmbiguousError
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
      .spyOn(runtimeForTaskStore(store), 'appendArtifact')
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
    const runtime = runtimeForTaskStore(store);
    const writeFinalArtifact = runtime.writeFinalArtifact.bind(runtime);
    let releaseFinalArtifact!: () => void;
    let markFinalArtifactStarted!: () => void;
    const finalArtifactRelease = new Promise<void>((resolve) => {
      releaseFinalArtifact = resolve;
    });
    const finalArtifactStarted = new Promise<void>((resolve) => {
      markFinalArtifactStarted = resolve;
    });
    vi.spyOn(runtime, 'writeFinalArtifact').mockImplementation(async (...args) => {
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
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter);
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const recordAgentRuntimeEvent = store.recordAgentRuntimeEvent.bind(store);
    const runtime = runtimeForTaskStore(store);
    const updateAgentSession = runtime.updateSession.bind(runtime);
    let rejectedTerminalEvent = false;
    let rejectedRecoveryEcho = false;
    vi.spyOn(store, 'recordAgentRuntimeEvent').mockImplementation(async (
      event,
      operationId
    ) => {
      if (!rejectedTerminalEvent && event.type === 'AGENT_RUN_COMPLETED') {
        rejectedTerminalEvent = true;
        throw new Error('injected terminal event persistence failure');
      }
      return recordAgentRuntimeEvent(event, operationId);
    });
    vi.spyOn(runtime, 'updateSession').mockImplementation(async (
      sessionId,
      expectedRevision,
      update,
      operationId
    ) => {
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
      return updateAgentSession(sessionId, expectedRevision, update, operationId);
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
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [5, 10]
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter);
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const recordAgentRuntimeEvent = store.recordAgentRuntimeEvent.bind(store);
    vi.spyOn(store, 'recordAgentRuntimeEvent').mockImplementation(
      async (event, operationId) => {
        if (
          event.type === 'AGENT_RUN_COMPLETED' ||
          event.type === 'AGENT_RUNTIME_RECONCILED'
        ) {
          throw new Error('injected persistent AGENT_RUN_COMPLETED persistence failure');
        }
        return recordAgentRuntimeEvent(event, operationId);
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
    const firstAdapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    await firstAdapter.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const localSession = await createTestAgentSession(store, {
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

    const secondAdapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = createAgentOrchestrator(store, events, secondAdapter);
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
    const snapshot = await store.snapshot();
    expect(
      snapshot.agentSessions.filter(
        (session) => session.providerSessionId === 'thread-1'
      )
    ).toHaveLength(1);
    expect(
      snapshot.agentSessions.find((session) => session.id === localSession.id)
    ).toMatchObject({ status: 'NOT_LOADED', materialized: false });
    expect(
      snapshot.agentSessions.find((session) => session.id === localSession.id)
        ?.providerSessionId
    ).toBeUndefined();

    await orchestrator.shutdown();
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('keeps an empty thread unmaterialized when run startup persistence fails before provider input', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-first-turn-pre-submit-failure-')
    );
    const executable = await writeFakeCodexExecutable(dir);
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter);
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const runtime = runtimeForTaskStore(store);
    const updateRun = runtime.updateRun.bind(runtime);
    let rejectedStartingPersistence = false;
    vi.spyOn(runtime, 'updateRun').mockImplementation(async (
      runId,
      expectedRevision,
      patch,
      operationId
    ) => {
      if (!rejectedStartingPersistence && patch.status === 'STARTING') {
        rejectedStartingPersistence = true;
        throw new Error('injected pre-submit run persistence failure');
      }
      return updateRun(runId, expectedRevision, patch, operationId);
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
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter);
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
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter);
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
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter);
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const runtime = runtimeForTaskStore(store);
    const updateRun = runtime.updateRun.bind(runtime);
    let rejectedTurnEvidence = false;
    vi.spyOn(runtime, 'updateRun').mockImplementation(async (
      runId,
      expectedRevision,
      patch,
      operationId
    ) => {
      if (
        !rejectedTurnEvidence &&
        patch.providerTurnId === 'turn-error-evidence' &&
        patch.status === 'RUNNING'
      ) {
        rejectedTurnEvidence = true;
        throw new Error('injected turn evidence persistence failure');
      }
      return updateRun(runId, expectedRevision, patch, operationId);
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
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter);
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

    const raw = await appendTestProtocolMessage(store,
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
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter);
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const runtime = runtimeForTaskStore(store);
    const updateAgentSession = runtime.updateSession.bind(runtime);
    let injectedDrift = false;
    vi.spyOn(runtime, 'updateSession').mockImplementation(
      async (sessionId, expectedRevision, patch, operationId) => {
        const stored = await updateAgentSession(
          sessionId,
          expectedRevision,
          patch,
          operationId
        );
        if (!injectedDrift && patch.materialized === true) {
          injectedDrift = true;
          const client = (
            adapter as unknown as { boundClient?: CodexRpcClient }
          ).boundClient!;
          const raw = await appendTestProtocolMessage(store,
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
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter, {
    });
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir, {
      withTextAttachment: true
    });
    const runtime = runtimeForTaskStore(store);
    const updateRun = runtime.updateRun.bind(runtime);
    let rejectedAcknowledgement = false;
    vi.spyOn(runtime, 'updateRun').mockImplementation(async (
      runId,
      expectedRevision,
      patch,
      operationId
    ) => {
      if (
        !rejectedAcknowledgement &&
        patch.status === 'RUNNING' &&
        patch.attachmentSubmissions !== undefined
      ) {
        rejectedAcknowledgement = true;
        throw new Error('injected persistence failure');
      }
      return updateRun(runId, expectedRevision, patch, operationId);
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
    expect(firstOutbound.filter((message) => message.method === 'thread/start')).toHaveLength(1);
    expect(firstOutbound.filter((message) => message.method === 'thread/resume')).toHaveLength(0);
    expect(firstOutbound.filter((message) => message.method === 'turn/start')).toHaveLength(1);
    expect(journal).not.toContain(`${path.sep}attachments${path.sep}tasks${path.sep}`);
    const retained = await store.verifyRunAttachments(run!.id, task.id);
    expect(retained).toHaveLength(1);
    await expect(fs.access(retained[0]!.absolutePath)).resolves.toBeUndefined();

    await orchestrator.shutdown();

    const replacementAdapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const replacementOrchestrator = createAgentOrchestrator(
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
    await expect(fs.access(retained[0]!.absolutePath)).resolves.toBeUndefined();
  }, APP_SERVER_INTEGRATION_TIMEOUT_MS);

  it('records recovery before a provider-acknowledged thread/start can be retried', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-thread-start-post-ack-')
    );
    const executable = await writeFakeCodexExecutable(dir, 'ack-only');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter);
    await orchestrator.initialize();
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const runtime = runtimeForTaskStore(store);
    const updateSession = runtime.updateSession.bind(runtime);
    let rejectedAcknowledgement = false;
    vi.spyOn(runtime, 'updateSession').mockImplementation(async (
      sessionId,
      expectedRevision,
      patch,
      operationId
    ) => {
      if (!rejectedAcknowledgement && patch.providerSessionId === 'thread-1') {
        rejectedAcknowledgement = true;
        throw new Error('injected thread ownership persistence failure');
      }
      return updateSession(sessionId, expectedRevision, patch, operationId);
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
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter);
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
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter, {
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

  it('answers a typed mid-turn question once and resumes the same Codex run', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-user-input-'));
    const executable = await writeFakeCodexExecutable(dir, 'user-input');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter);
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
    expect(interaction).toMatchObject({
      providerRequestId: 81,
      type: 'USER_INPUT',
      runId: run.id,
      providerTurnId: 'turn-1',
      request: {
        autoResolutionMs: 120_000,
        questions: [
          {
            id: 'scope',
            isOther: true,
            options: [
              { label: 'Core', description: 'Update core behavior.' },
              { label: 'Renderer', description: 'Update renderer behavior.' }
            ]
          },
          {
            id: 'detail'
          }
        ]
      }
    });
    expect(await store.getRun(run.id)).toMatchObject({
      status: 'AWAITING_USER_INPUT',
      providerTurnId: 'turn-1'
    });
    expect(await store.getAgentSession(interaction.sessionId)).toMatchObject({
      status: 'AWAITING_USER_INPUT'
    });
    const input: RespondToInteractionRequest = {
      taskId: task.id,
      runId: run.id,
      interactionRequestId: interaction.id,
      decision: {
        interactionType: 'USER_INPUT',
        action: 'ANSWER',
        answers: {
          scope: ['Core'],
          detail: ['Preserve existing approval behavior.']
        }
      }
    };

    await orchestrator.respondToInteraction(input);
    await waitForInteraction(store, 'RESOLVED');
    await waitForRunStatus(store, run.id, 'RUNNING');
    expect(await store.getAgentSession(interaction.sessionId)).toMatchObject({
      status: 'ACTIVE'
    });
    await expect(orchestrator.respondToInteraction(input)).rejects.toThrow(
      'expected PENDING'
    );

    await waitForRunStatus(store, run.id, 'COMPLETED');
    expect((await store.snapshot()).runs.filter((candidate) => candidate.id === run.id)).toHaveLength(
      1
    );
    const server = (await store.snapshot()).agentServers[0]!;
    const journal = await fs.readFile(server.protocolJournalPath, 'utf8');
    const outboundMessages = readOutboundMessages(journal);
    const turnStart = outboundMessages.find((message) => message.method === 'turn/start');
    expect(turnStart?.params).toMatchObject({
      collaborationMode: {
        mode: 'plan',
        settings: {
          model: 'fake-model',
          reasoning_effort: 'high',
          developer_instructions: expect.stringContaining('implementation mode')
        }
      }
    });
    const response = outboundMessages.find(
      (message) => message.id === 81 && message.result
    );
    expect(response).toEqual({
      id: 81,
      result: {
        answers: {
          scope: { answers: ['Core'] },
          detail: { answers: ['Preserve existing approval behavior.'] }
        }
      }
    });
    expect(
      outboundMessages.filter((message) => message.id === 81)
    ).toHaveLength(1);
    await orchestrator.shutdown();
  });

  it('clears a canceled typed question without accepting a late answer', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-user-input-clear-'));
    const executable = await writeFakeCodexExecutable(dir, 'user-input-clear');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter);
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

    const pending = await waitForInteraction(store, 'PENDING', {
      runId: run.id,
      providerRequestId: 81
    });
    expect(pending.request).toMatchObject({
      questions: [
        { id: 'scope', isSecret: false },
        { id: 'detail', isSecret: false }
      ]
    });
    expect(pending).toMatchObject({
      allowedActions: ['ANSWER']
    });
    expect(pending.decision).toBeUndefined();
    await orchestrator.interruptRun(run.id);
    const stale = await waitForInteraction(store, 'STALE', {
      runId: run.id,
      providerRequestId: 81
    });
    expect(stale).toMatchObject({
      type: 'USER_INPUT',
      resolution: {
        method: 'serverRequest/resolved',
        clearedWithoutResponse: true
      }
    });
    await waitForRunStatus(store, run.id, 'INTERRUPTED');
    await expect(
      orchestrator.respondToInteraction({
        taskId: task.id,
        runId: run.id,
        interactionRequestId: stale.id,
        decision: {
          interactionType: 'USER_INPUT',
          action: 'ANSWER',
          answers: {
            scope: ['Core'],
            detail: ['Too late.']
          }
        }
      })
    ).rejects.toThrow('expected PENDING');
    await orchestrator.shutdown();
  });

  it('never retries a typed answer whose post-submission delivery is ambiguous', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-user-input-ambiguous-')
    );
    const executable = await writeFakeCodexExecutable(dir, 'user-input');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter);
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
    const interaction = await waitForInteraction(store, 'PENDING', {
      runId: run.id,
      providerRequestId: 81
    });
    expect(interaction).toMatchObject({
      allowedActions: ['ANSWER']
    });
    expect(interaction.decision).toBeUndefined();
    const client = (adapter as unknown as { boundClient?: CodexRpcClient }).boundClient!;
    const respond = vi.spyOn(client, 'respond').mockRejectedValue(
      new CodexAmbiguousMutationError(
        'server-request/response',
        'injected ambiguous user-input delivery'
      )
    );
    const input: RespondToInteractionRequest = {
      taskId: task.id,
      runId: run.id,
      interactionRequestId: interaction.id,
      decision: {
        interactionType: 'USER_INPUT',
        action: 'ANSWER',
        answers: {
          scope: ['Core'],
          detail: ['Preserve existing behavior.']
        }
      }
    };

    await expect(orchestrator.respondToInteraction(input)).rejects.toBeInstanceOf(
      AgentMutationAmbiguousError
    );
    expect(await store.getInteractionRequest(interaction.id)).toMatchObject({
      status: 'STALE',
      resolution: {
        operation: 'server-request/response',
        automaticResubmission: false
      }
    });
    await expect(orchestrator.respondToInteraction(input)).rejects.toThrow(
      'expected PENDING'
    );
    expect(respond).toHaveBeenCalledOnce();
    await orchestrator.shutdown();
  });

  it('keeps a confirmed answer resolved when the runtime disconnects afterward', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-user-input-answer-exit-')
    );
    const executable = await writeFakeCodexExecutable(dir, 'user-input-answer-exit');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter);
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
    const interaction = await waitForInteraction(store, 'PENDING', {
      runId: run.id,
      providerRequestId: 81
    });
    const input: RespondToInteractionRequest = {
      taskId: task.id,
      runId: run.id,
      interactionRequestId: interaction.id,
      decision: {
        interactionType: 'USER_INPUT',
        action: 'ANSWER',
        answers: {
          scope: ['Core'],
          detail: ['Preserve existing behavior.']
        }
      }
    };

    await orchestrator.respondToInteraction(input);
    await waitForInteraction(store, 'RESOLVED', {
      runId: run.id,
      providerRequestId: 81
    });
    const lost = await waitForSnapshot(
      store,
      (snapshot) =>
        snapshot.runs.some(
          (candidate) =>
            candidate.id === run.id && candidate.status === 'RECOVERY_REQUIRED'
        ),
      'runtime loss after confirmed user input'
    );
    expect(
      lost.interactionRequests.find((candidate) => candidate.id === interaction.id)
    ).toMatchObject({
      status: 'RESOLVED',
      resolution: { method: 'serverRequest/resolved' }
    });
    await expect(orchestrator.respondToInteraction(input)).rejects.toThrow(
      'expected PENDING'
    );
    await orchestrator.shutdown();
  });

  it('aborts a pending typed question when the Codex runtime disconnects', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-user-input-exit-'));
    const executable = await writeFakeCodexExecutable(dir, 'user-input-exit');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter);
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

    const aborted = await waitForInteraction(store, 'ABORTED_SERVER_LOST', {
      runId: run.id,
      providerRequestId: 81
    });
    expect(aborted).toMatchObject({
      type: 'USER_INPUT',
      resolution: { reason: 'Codex App Server exited.' }
    });
    expect(await store.getRun(run.id)).toMatchObject({
      status: 'RECOVERY_REQUIRED'
    });
    await expect(
      orchestrator.respondToInteraction({
        taskId: task.id,
        runId: run.id,
        interactionRequestId: aborted.id,
        decision: {
          interactionType: 'USER_INPUT',
          action: 'ANSWER',
          answers: {
            scope: ['Core'],
            detail: ['Too late.']
          }
        }
      })
    ).rejects.toThrow('expected PENDING');
    await orchestrator.shutdown();
  });

  it('does not offer a retry after approval-response delivery becomes ambiguous', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-approval-ambiguous-'));
    const executable = await writeFakeCodexExecutable(dir, 'approval');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter);
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
    const interaction = await waitForInteraction(store, 'PENDING', {
      runId: run.id,
      providerRequestId: 41
    });
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
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter, {});
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
    const priorServer = await createTestAgentServer(store, {
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable,
      argv: ['app-server', '--stdio']
    });
    await updateTestAgentServer(store, priorServer.id, { status: 'RUNNING', pid: 41 });
    let session = await createTestAgentSession(store, {
      task,
      iteration,
      worktree,
      runtimeId: 'codex',
      requestedSettings: task.agentSettings
    });
    session = await updateTestAgentSession(store, session.id, {
      providerSessionId: 'thread-1',
      providerSessionTreeId: 'session-tree-1',
      status: 'NOT_LOADED',
      materialized: true
    });
    const run = await createTestRun(store, {
      task,
      session,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      serverInstanceId: priorServer.id,
      requestedSettings: task.agentSettings
    });
    await updateTestRun(store, run.id, {
      providerTurnId: 'turn-1',
      status: 'RUNNING'
    });
    const priorInteractionRaw = await appendTestProtocolMessage(store,
      priorServer.id,
      'INBOUND',
      '{"method":"item/commandExecution/requestApproval","id":41}'
    );
    const priorInteraction = await taskRuntimeForTaskStore(
      store
    ).createInteractionRequest({
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
    }, `test:interaction:${randomUUID()}`);
    await updateTestAgentServer(store, priorServer.id, {
      status: 'EXITED',
      disconnectedAt: new Date().toISOString(),
      exitedAt: new Date().toISOString(),
      exitReason: 'Injected prior App Server crash.'
    });

    const events = new AppEventBus();
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter);
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
    await store.close();
    const reloaded = new FileTaskStore(path.join(dir, 'store'));
    reloaded.bindAgentRuntime(
      runtimeForTaskStore(store).taskAgentRuntimeAccess((event, operationId) =>
        reloaded.recordAgentRuntimeEvent(event, operationId)
      )
    );
    await expect(reloaded.getRun(run.id)).resolves.toMatchObject({
      status: 'COMPLETED',
      serverInstanceId: interaction.serverInstanceId
    });
    await expect(
      reloaded.getInteractionRequest(priorInteraction.id)
    ).resolves.toMatchObject({
      status: 'ABORTED_SERVER_LOST',
      serverInstanceId: priorServer.id
    });
    await reloaded.close();
  });

  it('adopts and interrupts a goal continuation started by recovery resume', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-recovered-goal-continuation-')
    );
    const executable = await writeFakeCodexExecutable(
      dir,
      'recovery-goal-continuation'
    );
    const store = new FileTaskStore(path.join(dir, 'store'));
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const priorServer = await createTestAgentServer(store, {
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable,
      argv: ['app-server', '--stdio']
    });
    await updateTestAgentServer(store, priorServer.id, {
      status: 'EXITED',
      disconnectedAt: new Date().toISOString(),
      exitedAt: new Date().toISOString(),
      exitReason: 'Injected prior App Server crash.'
    });
    let session = await createTestAgentSession(store, {
      task,
      iteration,
      worktree,
      runtimeId: 'codex',
      requestedSettings: task.agentSettings
    });
    session = await updateTestAgentSession(store, session.id, {
      providerSessionId: 'thread-1',
      providerSessionTreeId: 'session-tree-1',
      status: 'NOT_LOADED',
      materialized: true
    });
    const run = await createTestRun(store, {
      task,
      session,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      serverInstanceId: priorServer.id,
      requestedSettings: task.agentSettings
    });
    await updateTestRun(store, run.id, {
      providerTurnId: 'turn-1',
      status: 'RUNNING'
    });

    const events = new AppEventBus();
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter);
    await orchestrator.initialize();

    const recovered = await waitForSnapshot(
      store,
      (snapshot) =>
        snapshot.runs.some(
          (candidate) =>
            candidate.id === run.id &&
            candidate.status === 'RUNNING' &&
            candidate.recoveryState === 'RECOVERED' &&
            candidate.providerTurnId === 'continued-turn'
        ),
      'provider goal continuation adoption'
    );
    const replacementServer = recovered.agentServers.find(
      (server) => server.runtimeId === 'codex' && server.status === 'READY'
    )!;
    expect(replacementServer.id).not.toBe(priorServer.id);

    await orchestrator.interruptRun(run.id);
    await waitForRunStatus(store, run.id, 'INTERRUPTED');

    const outbound = readOutboundMessages(
      await fs.readFile(replacementServer.protocolJournalPath, 'utf8')
    );
    expect(
      outbound
        .filter((message) => message.method === 'turn/interrupt')
        .map((message) => (message.params as { turnId: string }).turnId)
    ).toEqual(['continued-turn']);
    expect(outbound.filter((message) => message.method === 'turn/start')).toHaveLength(0);

    await orchestrator.shutdown();
  });

  it('replaces a lost typed question during restart and answers only the recovered request', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-recovered-user-input-')
    );
    const executable = await writeFakeCodexExecutable(dir, 'recovery-user-input');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const { task, iteration, worktree } = await createTaskContext(store, dir);
    const priorServer = await createTestAgentServer(store, {
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      executable,
      argv: ['app-server', '--stdio']
    });
    await updateTestAgentServer(store, priorServer.id, { status: 'RUNNING', pid: 41 });
    let session = await createTestAgentSession(store, {
      task,
      iteration,
      worktree,
      runtimeId: 'codex',
      requestedSettings: task.agentSettings
    });
    session = await updateTestAgentSession(store, session.id, {
      providerSessionId: 'thread-1',
      providerSessionTreeId: 'session-tree-1',
      status: 'NOT_LOADED',
      materialized: true
    });
    const run = await createTestRun(store, {
      task,
      session,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      serverInstanceId: priorServer.id,
      requestedSettings: task.agentSettings
    });
    await updateTestRun(store, run.id, {
      providerTurnId: 'turn-1',
      status: 'RUNNING'
    });
    const priorInteractionRaw = await appendTestProtocolMessage(store,
      priorServer.id,
      'INBOUND',
      '{"method":"item/tool/requestUserInput","id":81}'
    );
    const priorInteraction = await taskRuntimeForTaskStore(
      store
    ).createInteractionRequest({
      runtimeId: 'codex',
      serverInstanceId: priorServer.id,
      providerRequestId: 81,
      taskId: task.id,
      iterationId: iteration.id,
      runId: run.id,
      sessionId: session.id,
      providerTurnId: 'turn-1',
      type: 'USER_INPUT',
      request: {
        questions: [
          {
            id: 'scope',
            header: 'Scope',
            question: 'Which scope should the prior turn use?',
            isOther: false,
            isSecret: false,
            options: [{ label: 'Core', description: 'Continue in core.' }]
          }
        ]
      },
      allowedActions: ['ANSWER'],
      policyWarnings: [],
      requestRawMessage: priorInteractionRaw
    }, `test:interaction:${randomUUID()}`);
    await updateTestAgentServer(store, priorServer.id, {
      status: 'EXITED',
      disconnectedAt: new Date().toISOString(),
      exitedAt: new Date().toISOString(),
      exitReason: 'Injected prior App Server crash.'
    });

    const events = new AppEventBus();
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter);
    await orchestrator.initialize();

    const interaction = await waitForInteraction(store, 'PENDING', {
      runId: run.id,
      providerRequestId: 91
    });
    expect(await store.getInteractionRequest(priorInteraction.id)).toMatchObject({
      status: 'ABORTED_SERVER_LOST'
    });
    expect(interaction).toMatchObject({
      type: 'USER_INPUT',
      providerRequestId: 91,
      runId: run.id,
      providerTurnId: 'turn-1'
    });
    expect(interaction.serverInstanceId).not.toBe(priorServer.id);
    expect(await store.getRun(run.id)).toMatchObject({
      serverInstanceId: interaction.serverInstanceId,
      providerTurnId: 'turn-1',
      status: 'AWAITING_USER_INPUT'
    });

    await orchestrator.respondToInteraction({
      taskId: task.id,
      runId: run.id,
      interactionRequestId: interaction.id,
      decision: {
        interactionType: 'USER_INPUT',
        action: 'ANSWER',
        answers: { scope: ['Core'] }
      }
    });
    await waitForRunStatus(store, run.id, 'COMPLETED');
    expect(await store.getInteractionRequest(interaction.id)).toMatchObject({
      status: 'RESOLVED'
    });
    const snapshot = await store.snapshot();
    expect(
      snapshot.interactionRequests.filter(
        (candidate) =>
          candidate.runId === run.id &&
          candidate.status === 'RESOLVED' &&
          candidate.type === 'USER_INPUT'
      )
    ).toHaveLength(1);
    await orchestrator.shutdown();
  });

  it('ignores late notifications and requests from a replaced App Server generation', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-stale-codex-generation-')
    );
    const executable = await writeFakeCodexExecutable(dir, 'stale-generation');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const events = new AppEventBus();
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [0]
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter);

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
            current?.status === 'RUNNING' &&
            current.recoveryState === 'RECOVERED' &&
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

      const staleTurnRaw = await appendTestProtocolMessage(store,
        oldServerId,
        'INBOUND',
        JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-1' } })
      );
      const staleThreadRaw = await appendTestProtocolMessage(store,
        oldServerId,
        'INBOUND',
        JSON.stringify({ method: 'thread/closed', params: { threadId: 'thread-1' } })
      );
      const staleRequestRaw = await appendTestProtocolMessage(store,
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
        status: 'RUNNING',
        recoveryState: 'RECOVERED',
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
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter);
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
      const runtime = runtimeForTaskStore(store);
      const upsertAgentItem = runtime.upsertItem.bind(runtime);
      vi.spyOn(runtime, 'upsertItem').mockImplementation(async (item) => {
        const stored = await upsertAgentItem(item);
        if (stored.providerItemId === 'command-1') durableOrder.push('item');
        return stored;
      });
      const recordAgentRuntimeEvent = store.recordAgentRuntimeEvent.bind(store);
      vi.spyOn(store, 'recordAgentRuntimeEvent').mockImplementation(
        async (event, operationId) => {
          await recordAgentRuntimeEvent(event, operationId);
          if (event.type === 'AGENT_RUNTIME_LOST') {
            durableOrder.push('runtime-loss');
          }
        }
      );
      const createAgentServer = runtime.createAgentServer.bind(runtime);
      vi.spyOn(runtime, 'createAgentServer').mockImplementation(async (input) => {
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
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter, {
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
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter, {
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
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter, {
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
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter, {
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

  it('stops Codex and ignores buffered commands after unsafe live settings are observed', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'task-monki-live-settings-boundary-')
    );
    const executable = await writeFakeCodexExecutable(dir, 'unsafe-live-settings');
    const store = new FileTaskStore(path.join(dir, 'store'));
    const runtime = runtimeForTaskStore(store);
    const updateAgentSession = runtime.updateSession.bind(runtime);
    const updateAgentServer = runtime.updateAgentServer.bind(runtime);
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
    vi.spyOn(runtime, 'updateSession').mockImplementation(async (
      sessionId,
      expectedRevision,
      patch,
      operationId
    ) => {
      if (patch.observedSettings?.sandbox === 'DANGER_FULL_ACCESS') {
        unsafeObservationReached = true;
        markUnsafeObservationBlocked();
        await unsafeObservationRelease;
      }
      return updateAgentSession(sessionId, expectedRevision, patch, operationId);
    });
    vi.spyOn(runtime, 'updateAgentServer').mockImplementation(async (serverId, patch) => {
      if (patch.status === 'EXITED' || patch.status === 'FAILED') {
        markTerminalServerPersistenceBlocked();
        await terminalServerPersistenceRelease;
      }
      return updateAgentServer(serverId, patch);
    });
    const events = new AppEventBus();
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
      enforceBrowserDevBoundary: true
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter, {
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
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: []
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter);
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
    const session = await createTestAgentSession(store, {
      task,
      iteration,
      worktree,
      runtimeId: 'codex',
      requestedSettings: safeSettings
    });
    await updateTestAgentSession(store, session.id, {
      providerSessionId: 'thread-1',
      providerSessionTreeId: 'session-tree-1',
      status: 'ACTIVE'
    });
    const run = await createTestRun(store, {
      task,
      session,
      mode: 'IMPLEMENTATION',
      prompt: task.prompt,
      requestedSettings: safeSettings
    });
    await updateTestRun(store, run.id, {
      providerTurnId: 'turn-1',
      status: 'RUNNING'
    });
    const events = new AppEventBus();
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
      enforceBrowserDevBoundary: true
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter, {
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
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
      interruptRequestTimeoutMs: 40,
      interruptCompletionTimeoutMs: 200
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter, {
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
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
      interruptRequestTimeoutMs: 40,
      interruptCompletionTimeoutMs: 40
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter, {
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
    const adapter = createCodexAdapter(store, events, {
      cwd: dir,
      executable,
      requestTimeoutMs: 2_000,
      restartDelaysMs: [],
      interruptRequestTimeoutMs: 40,
      interruptCompletionTimeoutMs: 40
    });
    const orchestrator = createAgentOrchestrator(store, events, adapter);
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

const runtimeByTaskStore = new WeakMap<FileTaskStore, FileAgentRuntimeStore>();

function runtimeForTaskStore(
  store: FileTaskStore,
  explicit?: FileAgentRuntimeStore
): FileAgentRuntimeStore {
  const current = runtimeByTaskStore.get(store);
  if (current && explicit && current !== explicit) {
    throw new Error('Codex test task store is already bound to another runtime store.');
  }
  const runtime = explicit ?? current ?? new FileAgentRuntimeStore(
    path.join(os.tmpdir(), `task-monki-codex-runtime-${randomUUID()}`)
  );
  if (!current) {
    const taskRuntime = runtime.taskAgentRuntimeAccess((event, operationId) =>
      store.recordAgentRuntimeEvent(event, operationId)
    );
    store.bindAgentRuntime(taskRuntime);
    runtimeByTaskStore.set(store, runtime);
  }
  return runtime;
}

function createCodexAdapter(
  store: FileTaskStore,
  events: AppEventBus,
  options: CodexAppServerAdapterOptions & { runtimeStore?: FileAgentRuntimeStore }
): CodexAppServerAdapter {
  const { runtimeStore: explicitRuntime, ...adapterOptions } = options;
  const runtime = runtimeForTaskStore(store, explicitRuntime);
  return new CodexAppServerAdapter(
    store,
    runtime.taskAgentRuntimeAccess((event, operationId) =>
      store.recordAgentRuntimeEvent(event, operationId)
    ),
    runtime,
    events,
    adapterOptions
  );
}

function createAgentOrchestrator(
  store: FileTaskStore,
  events: AppEventBus,
  adapter: CodexAppServerAdapter,
  options?: ConstructorParameters<typeof AgentOrchestrator>[4]
): AgentOrchestrator {
  return new AgentOrchestrator(
    store,
    runtimeForTaskStore(store),
    events,
    adapter,
    options
  );
}

function taskRuntimeForTaskStore(store: FileTaskStore) {
  return runtimeForTaskStore(store).taskAgentRuntimeAccess((event, operationId) =>
    store.recordAgentRuntimeEvent(event, operationId)
  );
}

async function createTestAgentSession(
  store: FileTaskStore,
  input: {
    task: Task;
    iteration: TaskIteration;
    worktree: WorktreeRecord;
    runtimeId: string;
    role?: AgentSessionRecord['role'];
    requestedSettings?: AgentExecutionSettings;
    parentSessionId?: string;
    forkedFromSessionId?: string;
  }
): Promise<AgentSessionRecord> {
  const id = randomUUID();
  const operationId = `test:session:${id}`;
  const settings = {
    ...(input.requestedSettings ?? input.task.agentSettings),
    runtimeId: input.runtimeId
  };
  const permissionProfileHash = createHash('sha256')
    .update(JSON.stringify({ id, worktreePath: input.worktree.worktreePath, settings }))
    .digest('hex');
  const session = await taskRuntimeForTaskStore(store).createTaskSession({
    id,
    taskId: input.task.id,
    iterationId: input.iteration.id,
    worktreeId: input.worktree.id,
    worktreePath: input.worktree.worktreePath,
    runtimeId: input.runtimeId,
    role: input.role,
    requestedSettings: settings,
    executionContext: {
      attestation: { status: 'ATTESTED' },
      repositoryAccess: 'WRITE',
      primaryCwd: input.worktree.worktreePath,
      readRoots: [
        {
          canonicalPath: input.worktree.worktreePath,
          kind: 'WORKTREE',
          entityId: input.worktree.id
        }
      ],
      managedAttachments: [],
      permissionProfileHash,
      modelSettings: settings,
      externalTools: {
        network: settings.networkAccess === true,
        webSearch: 'disabled',
        mcpServers: false,
        apps: false,
        dynamicTools: input.task.kind === 'DESIGN'
      },
      clientOperationId: operationId
    },
    operationId,
    parentSessionId: input.parentSessionId,
    forkedFromSessionId: input.forkedFromSessionId
  });
  await store.recordAgentSessionCreated(session);
  return session;
}

async function updateTestAgentSession(
  store: FileTaskStore,
  sessionId: string,
  update: Partial<AgentSessionRecord>
): Promise<AgentSessionRecord> {
  return taskRuntimeForTaskStore(store).updateAgentSession(
    sessionId,
    update,
    `test:session-update:${randomUUID()}`
  );
}

async function createTestRun(
  store: FileTaskStore,
  input: {
    task: Task;
    session: AgentSessionRecord;
    mode: AgentRunMode;
    prompt: string;
    serverInstanceId?: string;
    generationKey?: string;
    retryOfRunId?: string;
    continuedFromRunId?: string;
    requestedSettings?: AgentExecutionSettings;
    beforeGitSnapshotId?: string;
  }
): Promise<RunRecord> {
  const id = randomUUID();
  let run = await taskRuntimeForTaskStore(store).createTaskRun({
    id,
    taskId: input.task.id,
    iterationId: input.session.iterationId,
    worktreeId: input.session.worktreeId,
    sessionId: input.session.id,
    mode: input.mode,
    prompt: input.prompt,
    generationKey: input.generationKey,
    requestedSettings: input.requestedSettings,
    beforeGitSnapshotId: input.beforeGitSnapshotId,
    retryOfRunId: input.retryOfRunId,
    continuedFromRunId: input.continuedFromRunId,
    operationId: `test:run:${id}`
  });
  await store.recordAgentRunStarted(run);
  if (input.serverInstanceId) {
    run = await updateTestRun(store, run.id, {
      serverInstanceId: input.serverInstanceId
    });
  }
  return run;
}

async function updateTestRun(
  store: FileTaskStore,
  runId: string,
  update: Partial<RunRecord>
): Promise<RunRecord> {
  const runtime = taskRuntimeForTaskStore(store);
  const current = await runtime.getRun(runId);
  if (current?.status === 'QUEUED' && update.status === 'RUNNING') {
    await runtime.updateRun(
      runId,
      { status: 'STARTING' },
      `test:run-starting:${randomUUID()}`
    );
  }
  return runtime.updateRun(
    runId,
    update,
    `test:run-update:${randomUUID()}`
  );
}

function createTestAgentServer(
  store: FileTaskStore,
  input: Parameters<FileAgentRuntimeStore['createAgentServer']>[0]
) {
  return runtimeForTaskStore(store).createAgentServer(input);
}

function updateTestAgentServer(
  store: FileTaskStore,
  serverId: string,
  update: Parameters<FileAgentRuntimeStore['updateAgentServer']>[1]
) {
  return runtimeForTaskStore(store).updateAgentServer(serverId, update);
}

function appendTestProtocolMessage(
  store: FileTaskStore,
  ...input: Parameters<FileAgentRuntimeStore['appendProtocolMessage']>
) {
  return runtimeForTaskStore(store).appendProtocolMessage(...input);
}

async function createTaskContext(
  store: FileTaskStore,
  dir: string,
  options: { withTextAttachment?: boolean } = {}
) {
  const repositoryDir = path.join(dir, 'repository');
  await fs.mkdir(repositoryDir, { recursive: true });
  await git(repositoryDir, ['init']);
  await git(repositoryDir, [
    'config',
    'user.email',
    'codex-adapter@example.invalid'
  ]);
  await git(repositoryDir, ['config', 'user.name', 'Codex Adapter Test']);
  await fs.writeFile(
    path.join(repositoryDir, 'README.md'),
    '# Adapter fixture\n',
    'utf8'
  );
  await git(repositoryDir, ['add', 'README.md']);
  await git(repositoryDir, ['commit', '-m', 'Initial adapter fixture']);
  const baseSha = (await git(repositoryDir, ['rev-parse', 'HEAD'])).trim();
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
    baseSha
  });
  return { task, iteration, worktree };
}

async function createDesignTaskContext(
  store: FileTaskStore,
  dir: string,
  options: {
    initialAttachment?: { displayName: string; body: string | Uint8Array };
  } = {}
) {
  const repositoryPath = path.join(dir, 'design-repository');
  await fs.mkdir(repositoryPath, { recursive: true });
  await git(repositoryPath, ['init']);
  await git(repositoryPath, ['config', 'user.email', 'design@example.invalid']);
  await git(repositoryPath, ['config', 'user.name', 'Design Test']);
  await fs.writeFile(
    path.join(repositoryPath, 'index.html'),
    '<!doctype html><title>Design fixture</title>\n',
    'utf8'
  );
  await git(repositoryPath, ['add', 'index.html']);
  await git(repositoryPath, ['commit', '-m', 'Initial Design fixture']);
  const headSha = (await git(repositoryPath, ['rev-parse', 'HEAD'])).trim();
  const branch = (await git(repositoryPath, ['branch', '--show-current'])).trim();
  let attachmentDraftId: string | undefined;
  if (options.initialAttachment) {
    const draft = await store.createAttachmentDraft();
    await store.stageTaskAttachment({
      draftId: draft.id,
      displayName: options.initialAttachment.displayName,
      bytes: Buffer.from(options.initialAttachment.body)
    });
    attachmentDraftId = draft.id;
  }
  const created = await store.createDesignBundle({
    request: {
      brief: 'Create a focused launch page with an interactive signup form.',
      creationToken: `design-skill-test-${randomUUID()}`,
      model: 'fake-model',
      reasoningEffort: 'high',
      ...(attachmentDraftId ? { attachmentDraftId } : {})
    },
    repository: {
      id: randomUUID(),
      name: 'Design skill test',
      path: repositoryPath,
      headSha,
      branch,
      checkedAt: new Date().toISOString()
    }
  });
  const { iteration, worktree } = await store.createIterationAndWorktree({
    task: created.task,
    branchName: branch,
    worktreePath: repositoryPath,
    baseSha: headSha
  });
  return {
    task: created.task,
    iteration,
    worktree,
    turnId: created.turn.id
  };
}

async function createBufferedCodexRun(
  directoryPrefix: string,
  credential = 'opaque-provider-credential-1742'
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), directoryPrefix));
  const store = new FileTaskStore(path.join(dir, 'store'));
  const events = new AppEventBus();
  const adapter = createCodexAdapter(store, events, {
    cwd: dir,
    environment: {
      ...process.env,
      OPENAI_API_KEY: credential
    },
    restartDelaysMs: []
  });
  const { task, iteration, worktree } = await createTaskContext(store, dir);
  const session = await createTestAgentSession(store, {
    task,
    iteration,
    worktree,
    runtimeId: 'codex',
    requestedSettings: task.agentSettings
  });
  const created = await createTestRun(store, {
    task,
    session,
    mode: 'IMPLEMENTATION',
    prompt: task.prompt,
    requestedSettings: task.agentSettings
  });
  const run = await updateTestRun(store, created.id, {
    providerTurnId: 'buffered-turn',
    status: 'RUNNING'
  });
  return { adapter, events, run, store };
}

async function waitForInteraction(
  store: FileTaskStore,
  status: 'PENDING' | 'RESPONDING' | 'RESOLVED' | 'ABORTED_SERVER_LOST' | 'STALE',
  ownership: {
    runId?: string;
    providerRequestId?: string | number;
  } = {}
) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const interaction = (await store.snapshot()).interactionRequests.find(
      (candidate) =>
        candidate.status === status &&
        (!ownership.runId || candidate.runId === ownership.runId) &&
        (ownership.providerRequestId === undefined ||
          candidate.providerRequestId === ownership.providerRequestId)
    );
    if (interaction) {
      return interaction;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const snapshot = await store.snapshot();
  throw new Error(
    `Timed out waiting for interaction status ${status}: ${JSON.stringify(
      snapshot.interactionRequests.map((interaction) => ({
        id: interaction.id,
        providerRequestId: interaction.providerRequestId,
        type: interaction.type,
        status: interaction.status,
        runId: interaction.runId,
        allowedActions: interaction.allowedActions,
        decision: interaction.decision
      }))
    )}`
  );
}

async function waitForRunStatus(
  store: FileTaskStore,
  runId: string,
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'INTERRUPTED'
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
): Array<{
  method?: string;
  id?: string | number;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}> {
  return journal
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { direction: string; raw: string })
    .filter((entry) => entry.direction === 'OUTBOUND')
    .map((entry) => JSON.parse(entry.raw) as {
      method?: string;
      id?: string | number;
      params?: unknown;
      result?: unknown;
      error?: unknown;
    });
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
    | 'scoped-interrupt-no-terminal'
    | 'scoped-interrupt-terminal-race'
    | 'scoped-unexpected-request-before-ack'
    | 'scoped-unexpected-request-after-ack'
    | 'scoped-unexpected-request-ambiguous-stop'
    | 'scoped-unexpected-request-no-terminal'
    | 'credential-telemetry'
    | 'empty-models'
    | 'ack-only'
    | 'recovery-notification-echo'
    | 'turn-start-rejected-once'
    | 'turn-start-rejected-with-evidence'
    | 'turn-start-ambiguous-late'
    | 'approval'
    | 'user-input'
    | 'user-input-answer-exit'
    | 'user-input-clear'
    | 'user-input-exit'
    | 'recovery-approval'
    | 'recovery-user-input'
    | 'recovery-goal-continuation'
    | 'stale-generation'
    | 'permission'
    | 'exit'
    | 'clear'
    | 'subagent'
    | 'unsafe-live-settings'
    | 'design-browser'
    | 'profile-rebind'
    | 'design-delete'
    | 'profile-mismatch-create'
    | 'profile-drift'
    | 'unsafe-recovery-resume'
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
const interruptMode = mode === 'interrupt-ambiguous-then-terminal' || mode === 'interrupt-ambiguous-no-terminal';
const scopedMode = mode === 'scoped' || mode === 'scoped-interrupt-no-terminal' || mode === 'scoped-interrupt-terminal-race' || mode.startsWith('scoped-unexpected-request-');
const approvalMode = mode === 'approval' || mode === 'permission' || mode === 'exit' || mode === 'clear' || mode === 'subagent' || mode === 'stale-generation';
const userInputMode = mode === 'user-input' || mode === 'user-input-answer-exit' || mode === 'user-input-clear' || mode === 'user-input-exit';
let goalContinuationStarted = false;
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
let designBrowserToolRegistered = false;
const deletedThreadIds = new Set();
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
  sandbox: scopedMode ? {
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
    if (mode === 'design-browser' && message.id === 101) {
      const image = message.result?.contentItems?.find((item) => item.type === 'inputImage');
      if (message.result?.success !== true || !image?.imageUrl?.startsWith('data:image/png;base64,')) {
        process.exit(19);
        return;
      }
      send({ method: 'serverRequest/resolved', params: {
        threadId: 'thread-1',
        requestId: 101
      } });
      send({ method: 'item/completed', params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        completedAtMs: Date.now(),
        item: {
          type: 'dynamicToolCall',
          id: 'design-browser-call',
          namespace: null,
          tool: 'inspect_design',
          arguments: { operation: 'open_candidate' },
          status: 'completed',
          contentItems: message.result.contentItems,
          success: true
        }
      } });
      send({ method: 'turn/completed', params: {
        threadId: 'thread-1',
        turn: turn('completed')
      } });
      return;
    }
    if (((mode === 'user-input' || mode === 'user-input-answer-exit') && message.id === 81) || (mode === 'recovery-user-input' && message.id === 91)) {
      const requestId = message.id;
      send({ method: 'serverRequest/resolved', params: {
        threadId: 'thread-1',
        requestId
      } });
      if (mode === 'user-input-answer-exit') {
        setTimeout(() => process.exit(17), 25);
        return;
      }
      setTimeout(() => {
        send({ method: 'item/completed', params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          completedAtMs: Date.now(),
          item: {
            type: 'agentMessage',
            id: 'answer-result',
            text: 'Continued with the supplied answers.',
            phase: null,
            memoryCitation: null
          }
        } });
        send({ method: 'turn/completed', params: {
          threadId: 'thread-1',
          turn: turn('completed')
        } });
      }, 100);
    }
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
    case 'collaborationMode/list':
      send({ id: message.id, result: { data: [] } });
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
      designBrowserToolRegistered =
        message.params.dynamicTools?.length === 1 &&
        message.params.dynamicTools[0]?.name === 'inspect_design';
      send({ id: message.id, result: threadResponse(message.params) });
      break;
    case 'thread/resume':
      {
        const recoveringApproval =
          mode === 'recovery-approval' && message.params.threadId === 'thread-1';
        const recoveringUserInput =
          mode === 'recovery-user-input' && message.params.threadId === 'thread-1';
        const recoveringGoalContinuation =
          mode === 'recovery-goal-continuation' &&
          message.params.threadId === 'thread-1';
        const recoveringTurn =
          (recoveringApproval || recoveringUserInput || mode === 'stale-generation') &&
          message.params.threadId === 'thread-1';
        const response = {
          ...threadResponse(message.params),
          thread: {
            ...thread([
              turn(
                recoveringTurn
                  ? 'inProgress'
                  : recoveringGoalContinuation
                    ? 'interrupted'
                    : 'completed'
              )
            ]),
            id:
              mode === 'profile-rebind'
                ? message.params.threadId
                : 'thread-1'
          }
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
        if (recoveringUserInput) {
          setTimeout(() => {
            send({ method: 'item/tool/requestUserInput', id: 91, params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              itemId: 'recovered-question',
              questions: [
                {
                  id: 'scope',
                  header: 'Scope',
                  question: 'Which scope should the recovered turn use?',
                  isOther: false,
                  isSecret: false,
                  options: [
                    { label: 'Core', description: 'Continue in core.' },
                    { label: 'Renderer', description: 'Continue in renderer.' }
                  ]
                }
              ],
              autoResolutionMs: 120000
            } });
          }, 20);
        }
        if (recoveringGoalContinuation) {
          setTimeout(() => {
            goalContinuationStarted = true;
            const goal = {
              threadId: 'thread-1',
              objective: 'Finish the fake task.',
              status: 'active',
              tokenBudget: null,
              tokensUsed: 10,
              timeUsedSeconds: 2,
              createdAt: 1,
              updatedAt: 2
            };
            send({ method: 'thread/goal/updated', params: {
              threadId: 'thread-1',
              turnId: null,
              goal
            } });
            send({ method: 'thread/status/changed', params: {
              threadId: 'thread-1',
              status: { type: 'active', activeFlags: [] }
            } });
            send({ method: 'turn/started', params: {
              threadId: 'thread-1',
              turn: { ...turn('inProgress'), id: 'continued-turn' }
            } });
          }, 1200);
        }
      }
      break;
    case 'thread/read':
      send({ id: message.id, result: {
        thread: thread([
          mode === 'recovery-goal-continuation'
            ? goalContinuationStarted
              ? { ...turn('inProgress'), id: 'continued-turn' }
              : turn('interrupted')
            : turn('completed')
        ])
      } });
      break;
    case 'thread/list': {
      const unrelated = {
        ...thread(),
        id: 'thread-unrelated',
        sessionId: 'session-tree-unrelated',
        cwd: process.cwd() + '/unrelated'
      };
      const available = message.params.archived
        ? [reviewThread()]
        : [thread(), childThread(), unrelated];
      send({ id: message.id, result: {
        data: available.filter((candidate) => !deletedThreadIds.has(candidate.id)),
        nextCursor: null
      } });
      break;
    }
    case 'thread/delete':
      deletedThreadIds.add(message.params.threadId);
      if (mode === 'design-delete' && message.params.threadId === 'thread-child') {
        send({ id: message.id, error: { code: -32603, message: 'response was lost' } });
      } else {
        send({ id: message.id, result: {} });
      }
      break;
    case 'thread/unsubscribe':
      send({ id: message.id, result: { status: 'unsubscribed' } });
      break;
    case 'thread/fork':
      {
        const response = {
          ...threadResponse(message.params),
          thread:
            mode === 'profile-rebind'
              ? { ...thread(), id: 'thread-rebound' }
              : reviewThread()
        };
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
      send({ id: message.id, result: {
        goal: mode === 'recovery-goal-continuation'
          ? {
              threadId: 'thread-1',
              objective: 'Finish the fake task.',
              status: 'active',
              tokenBudget: null,
              tokensUsed: 10,
              timeUsedSeconds: 2,
              createdAt: 1,
              updatedAt: 2
            }
          : null
      } });
      break;
    case 'turn/steer':
      send({ id: message.id, result: { turnId: 'turn-1' } });
      break;
    case 'review/start':
      send({ id: message.id, result: {
        turn: turn('inProgress'),
        reviewThreadId: 'thread-review'
      } });
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
      const unexpectedReadOnlyRequest = () => send({
        method: 'item/commandExecution/requestApproval',
        id: 201,
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          itemId: 'unexpected-command',
          startedAtMs: Date.now(),
          reason: 'Unexpected mutation request',
          command: 'touch should-not-run',
          cwd: message.params.cwd,
          commandActions: []
        }
      });
      if (
        mode === 'scoped-unexpected-request-before-ack' &&
        currentProfileId !== 'task_monki_capability_probe'
      ) {
        unexpectedReadOnlyRequest();
        setTimeout(() => send({ id: message.id, result: {
          turn: turn('inProgress')
        } }), 10);
        return;
      }
      send({ id: message.id, result: {
        turn: mode === 'profile-rebind'
          ? { ...turn('inProgress'), id: 'turn-' + turnStartAttempts }
          : turn('inProgress')
      } });
      if (
        currentProfileId !== 'task_monki_capability_probe' &&
        (mode === 'scoped-unexpected-request-after-ack' ||
          mode === 'scoped-unexpected-request-ambiguous-stop' ||
          mode === 'scoped-unexpected-request-no-terminal')
      ) {
        setTimeout(unexpectedReadOnlyRequest, 20);
        return;
      }
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
              : scopedMode
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
        if (interruptMode || mode === 'scoped-interrupt-no-terminal' || mode === 'scoped-interrupt-terminal-race') {
          return;
        }
        if (mode === 'design-browser') {
          if (!designBrowserToolRegistered) {
            process.exit(18);
            return;
          }
          send({ method: 'item/started', params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            startedAtMs: Date.now(),
            item: {
              type: 'dynamicToolCall',
              id: 'design-browser-call',
              namespace: null,
              tool: 'inspect_design',
              arguments: { operation: 'open_candidate' },
              status: 'inProgress',
              contentItems: null,
              success: null
            }
          } });
          send({ method: 'item/tool/call', id: 101, params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            callId: 'design-browser-call',
            namespace: null,
            tool: 'inspect_design',
            arguments: { operation: 'open_candidate' }
          } });
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
        if (userInputMode) {
          send({ method: 'item/tool/requestUserInput', id: 81, params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'question-1',
            questions: [
              {
                id: 'scope',
                header: 'Scope',
                question: 'Which area should the agent update?',
                isOther: true,
                isSecret: false,
                options: [
                  { label: 'Core', description: 'Update core behavior.' },
                  { label: 'Renderer', description: 'Update renderer behavior.' }
                ]
              },
              {
                id: 'detail',
                header: 'Detail',
                question: 'What should the agent preserve?',
                isOther: false,
                isSecret: false,
                options: null
              }
            ],
            autoResolutionMs: 120000
          } });
          if (mode === 'user-input-exit') {
            setTimeout(() => process.exit(17), 250);
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
          if (mode === 'scoped') {
            setTimeout(() => {
              send({ method: 'item/agentMessage/delta', params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                itemId: 'late-item',
                delta: 'Late output must be ignored.'
              } });
              send({ method: 'item/completed', params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                completedAtMs: Date.now(),
                item: {
                  type: 'agentMessage',
                  id: 'late-item',
                  text: 'Late output must be ignored.',
                  phase: null,
                  memoryCitation: null
                }
              } });
              send({ method: 'turn/completed', params: {
                threadId: 'thread-1',
                turn: turn('failed', { message: 'Late conflicting terminal.' })
              } });
            }, 20);
          }
        };
        if (mode === 'credential-telemetry') {
          setTimeout(finishAgentMessage, 120);
        } else {
          finishAgentMessage();
        }
      }, 10);
      break;
    case 'turn/interrupt':
      if (mode === 'user-input-clear' && message.params.threadId === 'thread-1') {
        send({ id: message.id, result: {} });
        send({ method: 'serverRequest/resolved', params: {
          threadId: 'thread-1',
          requestId: 81
        } });
        send({ method: 'turn/completed', params: {
          threadId: 'thread-1',
          turn: turn('interrupted')
        } });
        break;
      }
      if (mode === 'recovery-goal-continuation') {
        if (message.params.turnId !== 'continued-turn') {
          send({ id: message.id, error: {
            code: -32602,
            message: 'expected active turn id ' + message.params.turnId + ' but found continued-turn'
          } });
          break;
        }
        send({ id: message.id, result: {} });
        send({ method: 'turn/completed', params: {
          threadId: 'thread-1',
          turn: { ...turn('interrupted'), id: 'continued-turn' }
        } });
        break;
      }
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
      if (mode.startsWith('scoped-unexpected-request-')) {
        if (
          mode === 'scoped-unexpected-request-ambiguous-stop' &&
          currentProfileId !== 'task_monki_capability_probe'
        ) break;
        send({ id: message.id, result: {} });
        if (
          mode === 'scoped-unexpected-request-no-terminal' &&
          currentProfileId !== 'task_monki_capability_probe'
        ) break;
        send({ method: 'turn/completed', params: {
          threadId: 'thread-1',
          turn: turn('interrupted')
        } });
        break;
      }
      send({ id: message.id, result: {} });
      if (mode === 'scoped-interrupt-terminal-race') {
        send({ method: 'turn/completed', params: {
          threadId: 'thread-1',
          turn: turn('interrupted')
        } });
      }
      break;
    default:
      send({ id: message.id, error: { code: -32601, message: 'unsupported' } });
  }
});
`;
}
