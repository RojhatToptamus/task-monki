import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentOrchestrator } from '../AgentOrchestrator';
import { AppEventBus } from '../../runner/AppEventBus';
import { FileTaskStore } from '../../storage/FileTaskStore';
import { CodexAppServerAdapter } from './CodexAppServerAdapter';

describe('CodexAppServerAdapter', () => {
  it('discovers models and completes a real thread/turn lifecycle over stdio', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-app-server-'));
    const executable = path.join(dir, 'fake-codex');
    await fs.writeFile(executable, fakeCodexScript(), { mode: 0o755 });

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

    const provider = await orchestrator.getProviderState();
    expect(provider.preflight.ready).toBe(true);
    expect(provider.models[0]?.model).toBe('fake-model');
    expect(provider.models[0]?.supportedReasoningEfforts).toEqual(['low', 'high']);
    const initializedServer = (await store.snapshot()).agentServers[0];
    const initializedJournal = await fs.readFile(
      initializedServer.protocolJournalPath,
      'utf8'
    );
    expect(readOutboundMethods(initializedJournal)).not.toContain(
      'modelProvider/capabilities/read'
    );

    const task = await store.createTask({
      title: 'App Server turn',
      prompt: 'Finish the fake task.',
      repositoryPath: dir,
      agentSettings: {
        model: 'fake-model',
        reasoningEffort: 'high',
        sandbox: 'WORKSPACE_WRITE',
        networkAccess: false,
        approvalPolicy: 'never'
      }
    });
    const { iteration, worktree } = await store.createIterationAndWorktree({
      task,
      branchName: 'codex/fake-app-server',
      worktreePath: dir,
      baseSha: 'base'
    });
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

    const snapshot = await store.snapshot();
    const completed = snapshot.runs.find((candidate) => candidate.id === run.id);
    expect(completed?.status).toBe('COMPLETED');
    expect(completed?.providerTurnId).toBe('turn-1');
    expect(completed?.finalMessage).toBe('Fake task completed.');
    expect(snapshot.agentSessions[0]?.providerSessionId).toBe('thread-1');
    expect(snapshot.agentItems.map((item) => item.type)).toContain('AGENT_MESSAGE');
    expect(snapshot.agentItems.map((item) => item.type)).toContain('REASONING_SUMMARY');
    expect(snapshot.agentItems.map((item) => item.type)).toContain('CONTEXT_COMPACTION');
    expect(snapshot.agentPlanRevisions).toHaveLength(1);
    expect(snapshot.agentPlanRevisions[0]?.steps[0]?.status).toBe('IN_PROGRESS');
    expect(snapshot.agentUsageSnapshots[0]?.total.totalTokens).toBe(120);
    expect(snapshot.agentGoalSnapshots[0]?.syncState).toBe('IN_SYNC');
    expect(snapshot.agentSettingsObservations[0]?.source).toBe(
      'THREAD_START_RESPONSE'
    );
    expect(snapshot.agentServers[0]?.runtimeKind).toBe('APP_SERVER');
    expect(
      snapshot.agentServers.some((server) => server.runtimeKind !== 'APP_SERVER')
    ).toBe(false);

    await orchestrator.shutdown();
  });

  it('submits one typed approval response and waits for server resolution', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-approval-'));
    const executable = path.join(dir, 'fake-codex');
    await fs.writeFile(executable, fakeCodexScript('approval'), { mode: 0o755 });
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
    expect((await store.getTask(task.id))?.projection.tests).toBe('NOT_RUN');
    expect((await store.snapshot()).testRuns).toHaveLength(0);
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

  it('aborts pending approvals when the owning App Server exits', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-approval-loss-'));
    const executable = path.join(dir, 'fake-codex');
    await fs.writeFile(executable, fakeCodexScript('exit'), { mode: 0o755 });
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
    const executable = path.join(dir, 'fake-codex');
    await fs.writeFile(executable, fakeCodexScript('clear'), { mode: 0o755 });
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
    const executable = path.join(dir, 'fake-codex');
    await fs.writeFile(executable, fakeCodexScript('subagent'), { mode: 0o755 });
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

    await orchestrator.shutdown();
  });
});

async function createTaskContext(store: FileTaskStore, dir: string) {
  const task = await store.createTask({
    title: 'Approval turn',
    prompt: 'Finish the fake task.',
    repositoryPath: dir,
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
    worktreePath: dir,
    baseSha: 'base'
  });
  return { task, iteration, worktree };
}

async function waitForInteraction(
  store: FileTaskStore,
  status: 'PENDING' | 'ABORTED_SERVER_LOST' | 'STALE'
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
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
  status: 'COMPLETED'
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await store.getRun(runId);
    if (run?.status === status) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for run ${runId} to reach ${status}.`);
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

function fakeCodexScript(
  mode: 'normal' | 'approval' | 'exit' | 'clear' | 'subagent' = 'normal'
): string {
  return `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.141.0\\n');
  process.exit(0);
}

const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const mode = ${JSON.stringify(mode)};
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
const threadResponse = () => ({
  thread: thread(),
  model: 'fake-model',
  modelProvider: 'openai',
  serviceTier: null,
  cwd: process.cwd(),
  instructionSources: [],
  approvalPolicy: mode === 'normal' ? 'never' : 'on-request',
  approvalsReviewer: 'user',
  sandbox: {
    type: 'workspaceWrite',
    writableRoots: [process.cwd()],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  },
  reasoningEffort: 'high'
});

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
          inputModalities: ['text'],
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
      send({ id: message.id, result: threadResponse() });
      break;
    case 'thread/resume':
      send({ id: message.id, result: { ...threadResponse(), thread: thread([turn('completed')]) } });
      break;
    case 'thread/read':
      send({ id: message.id, result: { thread: thread([turn('completed')]) } });
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
    case 'turn/start':
      send({ id: message.id, result: { turn: turn('inProgress') } });
      setTimeout(() => {
        send({ method: 'turn/started', params: { threadId: 'thread-1', turn: turn('inProgress') } });
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
          send({ method: 'item/commandExecution/requestApproval', id: 52, params: {
            threadId: 'thread-child',
            turnId: 'turn-child',
            itemId: 'child-command',
            startedAtMs: Date.now(),
            reason: 'Verify the delegated test analysis',
            command: 'npm test',
            cwd: process.cwd(),
            commandActions: []
          } });
          return;
        }
        if (mode !== 'normal') {
          send({ method: 'item/started', params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            startedAtMs: Date.now(),
            item: {
              type: 'commandExecution',
              id: 'command-1',
              command: 'npm test',
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
          send({ method: 'item/commandExecution/requestApproval', id: 41, params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'command-1',
            startedAtMs: Date.now(),
            reason: 'Run repository tests',
            command: 'npm test',
            cwd: process.cwd(),
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
      send({ id: message.id, result: {} });
      break;
    default:
      send({ id: message.id, error: { code: -32601, message: 'unsupported' } });
  }
});
`;
}
