import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentInteractionService } from '../AgentInteractionService';
import { AgentMutationAmbiguousError } from '../AgentRuntimeAdapter';
import { AppEventBus } from '../../runner/AppEventBus';
import { FileTaskStore } from '../../storage/FileTaskStore';
import { AcpRuntimeAdapter } from './AcpRuntimeAdapter';
import { GEMINI_ACP_PROFILE, type AcpRuntimeProfile } from './AcpRuntimeProfiles';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

describe('AcpRuntimeAdapter end-to-end', () => {
  it('runs session -> prompt -> stream -> exact permission -> terminal without client tools', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-acp-adapter-'));
    temporaryDirectories.push(directory);
    const agentScript = path.join(directory, 'agent.cjs');
    await fs.writeFile(agentScript, fakeAgentSource(directory), { mode: 0o600 });
    const profile: AcpRuntimeProfile = {
      ...GEMINI_ACP_PROFILE,
      descriptor: { ...GEMINI_ACP_PROFILE.descriptor, id: 'test-acp' },
      executableCandidates: [process.execPath],
      argv: [agentScript],
      allowedEnvironmentKeys: []
    };
    const store = new FileTaskStore(path.join(directory, 'store'));
    const events = new AppEventBus();
    const observedEvents: Array<{ type: string; payload: unknown; runId?: string }> = [];
    events.on((event) => observedEvents.push(event));
    let resolutionCalls = 0;
    const resolvedExecutableOverrides: Array<string | undefined> = [];
    const adapter = new AcpRuntimeAdapter(store, events, profile, {
      cwd: directory,
      // Production uses a 30-second ACP request deadline. Keep the integration
      // fixture realistic because every inbound message is journaled before
      // the terminal response can settle the prompt mutation.
      requestTimeoutMs: 30_000,
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
      model: 'default',
      modelProvider: 'google',
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
      await adapter.preflight();
      await adapter.listModels();
      await adapter.resolveExecution({ settings, attachments: [] });
      expect((await store.snapshot()).agentServers).toHaveLength(0);
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
      expect((await store.snapshot()).agentServers).toHaveLength(0);
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
        status: 'IDLE'
      });
      expect((await store.snapshot()).agentServers).toHaveLength(1);
      const creationJournal = await fs.readFile(
        (await store.snapshot()).agentServers[0]!.protocolJournalPath,
        'utf8'
      );
      expect(
        creationJournal
          .trim()
          .split('\n')
          .map((line) => JSON.parse(JSON.parse(line).raw) as { method?: string })
          .filter((message) => message.method === 'session/new')
      ).toHaveLength(1);
      await expect(adapter.setSessionMode(session.id, 'plan')).resolves.toMatchObject({
        modes: { currentModeId: 'plan' }
      });
      await expect(
        adapter.setSessionConfigOption(session.id, 'telemetry', false)
      ).resolves.toMatchObject({
        configOptions: expect.arrayContaining([
          expect.objectContaining({ id: 'telemetry', currentValue: false })
        ])
      });
      await adapter.releaseSession({
        localSessionId: session.id,
        providerSessionId: session.providerSessionId
      });
      expect((await store.getAgentSession(session.id))?.status).toBe('NOT_LOADED');
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
      const originalServerId = (await store.snapshot()).agentServers[0]!.id;
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
      const journal = await fs.readFile(snapshot.agentServers[0]!.protocolJournalPath, 'utf8');
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
          : undefined
      );
      expect(await adapter.readNativeState()).toMatchObject({
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false
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
        return current?.status === 'COMPLETED' ? current : undefined;
      });

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
      // The fake agent responds after Task Monki's ambiguity deadline. The
      // late response must not silently reverse the recovery decision.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await store.getRun(interruptedRun.id))?.status).toBe('RECOVERY_REQUIRED');

      // Isolate the following process-loss scenario from this deliberately
      // unresolved cancellation.
      await store.updateRun(interruptedRun.id, {
        status: 'INTERRUPTED',
        endedAt: new Date().toISOString()
      });
      await store.updateAgentSession(session.id, { status: 'IDLE' });

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
      expect(submittedPrompts).toHaveLength(7);
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

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for ACP test state.');
}

function itemPayloadText(item: { payload: unknown } | undefined): string {
  if (!item || typeof item.payload !== 'object' || item.payload === null) return '';
  const text = (item.payload as { text?: unknown }).text;
  return typeof text === 'string' ? text : '';
}

function fakeAgentSource(cwd: string): string {
  return `
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
let promptRequestId;
let permissionCount = 0;
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
      agentInfo: { name: 'fake-acp', version: '1.0.0' }
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
      configOptions: [{
        id: 'model', name: 'Model', category: 'model', type: 'select',
        currentValue: 'default', options: [{ value: 'default', name: 'Provider default' }]
      }]
    }});
    return;
  }
  if (message.method === 'session/set_mode') {
    send({ jsonrpc: '2.0', id: message.id, result: {} });
    return;
  }
  if (message.method === 'session/set_config_option') {
    send({ jsonrpc: '2.0', id: message.id, result: {
      configOptions: [
        {
          id: 'model', name: 'Model', category: 'model', type: 'select',
          currentValue: 'default', options: [{ value: 'default', name: 'Provider default' }]
        },
        {
          id: 'telemetry', name: 'Telemetry', category: 'other', type: 'boolean',
          currentValue: message.params.value
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
    if (JSON.stringify(message.params.prompt).includes('hang for interrupt')) {
      return;
    }
    if (JSON.stringify(message.params.prompt).includes('ambiguous disconnect')) {
      process.exit(17);
    }
    if (JSON.stringify(message.params.prompt).includes('definitive failure')) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'provider rejected prompt' } });
      return;
    }
    if (JSON.stringify(message.params.prompt).includes('malformed terminal response')) {
      send({ jsonrpc: '2.0', id: message.id, result: {} });
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
    setTimeout(() => send({
      jsonrpc: '2.0', id: promptRequestId, result: { stopReason: 'cancelled' }
    }), 75);
    return;
  }
  if (typeof message.id === 'string' && message.id.startsWith('permission-native-') && message.result) {
    send({ jsonrpc: '2.0', id: promptRequestId, result: { stopReason: 'end_turn' } });
  }
});
`;
}
