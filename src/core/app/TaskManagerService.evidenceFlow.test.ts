import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '../../shared/contracts';
import type {
  AgentInteractionDecision,
  AgentInteractionRequestPayload,
  InteractionRequestType
} from '../../shared/agent';
import { writeNodeExecutable } from '../../testSupport/fakeExecutable';
import {
  createTaskMonkiScenario,
  ScriptedAgentRuntimeAdapter,
  type TaskMonkiScenario
} from '../../testSupport/taskMonkiScenario';
import { AppEventBus } from '../runner/AppEventBus';
import { FileTaskStore } from '../storage/FileTaskStore';
import { TaskManagerService } from './TaskManagerService';

describe('TaskManagerService evidence flow', () => {
  it('observes post-run Git evidence after implementation completes', async () => {
    const scenario = await createTaskMonkiScenario({ name: 'task-monki-evidence-flow' });
    const task = await scenario.createTask({
      title: 'Evidence flow',
      prompt: 'Run through implementation evidence.'
    });

    const run = await scenario.service.startRun({ taskId: task.id });
    expect(run.status).toBe('RUNNING');
    expect(scenario.agent.startedTurns).toHaveLength(1);

    const postRunEvidence = scenario.waitForSnapshot((snapshot) =>
      snapshot.runs.some(
        (candidate) => candidate.id === run.id && Boolean(candidate.afterGitSnapshotId)
      )
    );
    await scenario.completeRun(run.id, 'Implementation finished.');
    const afterRunSnapshot = await postRunEvidence;
    const afterRunTask = afterRunSnapshot.tasks.find((candidate) => candidate.id === task.id);
    const completedRun = afterRunSnapshot.runs.find((candidate) => candidate.id === run.id);

    expect(afterRunTask?.workflowPhase).toBe('REVIEW');
    expect(afterRunTask?.projection.agentRun).toBe('COMPLETED');
    expect(completedRun?.afterGitSnapshotId).toBeTruthy();
  });

  it('keeps a provider-completed implementation in progress when a declined execution produced no Git change', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-declined-no-change'
    });
    const task = await scenario.createTask({
      title: 'Declined command',
      prompt: 'Create a file with a command.'
    });
    const run = await scenario.service.startRun({ taskId: task.id });
    await recordDeclinedCommand(scenario, run);

    const reconciled = scenario.waitForSnapshot((snapshot) => {
      const currentTask = snapshot.tasks.find((candidate) => candidate.id === task.id);
      const currentRun = snapshot.runs.find((candidate) => candidate.id === run.id);
      return Boolean(
        currentRun?.afterGitSnapshotId &&
          currentTask?.workflowPhase === 'IN_PROGRESS' &&
          currentTask.projection.requestedAction === 'FAILED'
      );
    });
    await scenario.completeRun(run.id, 'The requested command was denied.');
    const reviewAttempt = expect(
      scenario.service.startReview({ taskId: task.id, runId: run.id })
    ).rejects.toThrow(/declined.*no Git change/i);
    const snapshot = await reconciled;
    const currentTask = snapshot.tasks.find((candidate) => candidate.id === task.id);
    const currentRun = snapshot.runs.find((candidate) => candidate.id === run.id);

    expect(currentRun?.status).toBe('COMPLETED');
    expect(currentTask?.projection.agentRun).toBe('COMPLETED');
    expect(currentTask?.projection.summary).toMatch(/declined.*no Git change/i);
    expect(
      snapshot.events.some(
        (event) => event.type === 'IMPLEMENTATION_OUTCOME_BLOCKED' && event.runId === run.id
      )
    ).toBe(true);
    await reviewAttempt;
    await expect(
      scenario.service.createDeliveryCommit({ taskId: task.id })
    ).rejects.toThrow(/declined.*no Git change/i);
    await expect(
      scenario.service.transitionTask({ taskId: task.id, toPhase: 'REVIEW' })
    ).rejects.toThrow(/declined.*no Git change/i);
    await expect(
      scenario.service.startRun({ taskId: task.id, mode: 'ANALYSIS' })
    ).rejects.toThrow(/declined.*no Git change/i);
  });

  it('does not treat a declined MCP elicitation as rejected implementation execution', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-declined-mcp-elicitation'
    });
    const task = await scenario.createTask({
      title: 'Declined provider form',
      prompt: 'Finish without the optional provider form.'
    });
    const run = await scenario.service.startRun({ taskId: task.id });
    await recordDeclinedInteraction(scenario, run, {
      type: 'MCP_ELICITATION',
      request: {
        mode: 'form',
        serverName: 'optional-context',
        message: 'Share optional context?',
        requestedSchema: {}
      },
      decision: { interactionType: 'MCP_ELICITATION', action: 'DECLINE' }
    });

    const postRunEvidence = scenario.waitForSnapshot((snapshot) =>
      snapshot.runs.some(
        (candidate) => candidate.id === run.id && Boolean(candidate.afterGitSnapshotId)
      )
    );
    await scenario.completeRun(run.id, 'Finished without optional context.');
    const snapshot = await postRunEvidence;
    const currentTask = snapshot.tasks.find((candidate) => candidate.id === task.id);

    expect(currentTask?.workflowPhase).toBe('REVIEW');
    expect(currentTask?.projection.implementationRetry).toBeUndefined();
  });

  it('allows review when implementation changed Git after an earlier declined execution', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-declined-with-change'
    });
    const task = await scenario.createTask({
      title: 'Declined optional command',
      prompt: 'Make the requested edit without the optional command.'
    });
    const run = await scenario.service.startRun({ taskId: task.id });
    await recordDeclinedCommand(scenario, run);
    const worktree = await scenario.store.getCurrentWorktree(task.id);
    if (!worktree) throw new Error('Scenario worktree was not created.');
    await fs.writeFile(`${worktree.worktreePath}/implemented.txt`, 'implemented\n', 'utf8');

    const postRunEvidence = scenario.waitForSnapshot((snapshot) =>
      snapshot.runs.some(
        (candidate) => candidate.id === run.id && Boolean(candidate.afterGitSnapshotId)
      )
    );
    await scenario.completeRun(run.id, 'Implementation finished without the command.');
    const snapshot = await postRunEvidence;

    expect(snapshot.tasks.find((candidate) => candidate.id === task.id)?.workflowPhase).toBe(
      'REVIEW'
    );
    expect(
      snapshot.events.some(
        (event) => event.type === 'IMPLEMENTATION_OUTCOME_BLOCKED' && event.runId === run.id
      )
    ).toBe(false);
  });

  it('keeps storage open until terminal post-run evidence is recorded', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-evidence-shutdown'
    });
    const task = await scenario.createTask({
      title: 'Shutdown evidence flow',
      prompt: 'Finish while application shutdown begins.'
    });
    const run = await scenario.service.startRun({ taskId: task.id });
    const originalRecordGitSnapshot = scenario.store.recordGitSnapshot.bind(scenario.store);
    let releaseEvidence!: () => void;
    const evidenceGate = new Promise<void>((resolve) => {
      releaseEvidence = resolve;
    });
    let markEvidenceEntered!: () => void;
    const evidenceEntered = new Promise<void>((resolve) => {
      markEvidenceEntered = resolve;
    });
    vi.spyOn(scenario.store, 'recordGitSnapshot').mockImplementation(async (...input) => {
      markEvidenceEntered();
      await evidenceGate;
      return originalRecordGitSnapshot(...input);
    });
    const updateRun = vi.spyOn(scenario.store, 'updateRun');
    const closeStore = vi.spyOn(scenario.store, 'close');

    await scenario.completeRun(run.id, 'Implementation finished during shutdown.');
    await evidenceEntered;
    const shutdown = scenario.service.shutdown();
    await Promise.resolve();
    expect(closeStore).not.toHaveBeenCalled();

    releaseEvidence();
    await expect(shutdown).resolves.toBeUndefined();
    expect(updateRun).toHaveBeenCalledWith(
      run.id,
      expect.objectContaining({ afterGitSnapshotId: expect.any(String) })
    );
    expect(closeStore).toHaveBeenCalledOnce();
  });

  it('reconciles missing post-run outcome evidence when the service restarts', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-evidence-restart'
    });
    const task = await scenario.createTask({
      title: 'Restart reconciliation',
      prompt: 'Create a file after approval.'
    });
    const run = await scenario.service.startRun({ taskId: task.id });
    await recordDeclinedCommand(scenario, run);
    let observeFailedCapture!: () => void;
    const failedCapture = new Promise<void>((resolve) => {
      observeFailedCapture = resolve;
    });
    vi.spyOn(scenario.store, 'recordGitSnapshot').mockImplementationOnce(async () => {
      observeFailedCapture();
      throw new Error('Transient Git inspection failure.');
    });

    await scenario.completeRun(run.id, 'The command was denied.');
    await failedCapture;
    await scenario.service.shutdown();

    const reopenedStore = new FileTaskStore(path.join(scenario.rootDir, 'store'));
    const recoveredAgent = new ScriptedAgentRuntimeAdapter(reopenedStore);
    const recoveredService = new TaskManagerService(
      reopenedStore,
      scenario.repositoryPath,
      new AppEventBus(),
      {
        worktreeRoot: scenario.worktreeRoot,
        agentRuntimeAdapters: [recoveredAgent]
      }
    );
    await recoveredService.init();
    const recovered = await reopenedStore.snapshot();
    const recoveredTask = recovered.tasks.find((candidate) => candidate.id === task.id);
    const recoveredRun = recovered.runs.find((candidate) => candidate.id === run.id);

    expect(recoveredRun?.afterGitSnapshotId).toBeTruthy();
    expect(recoveredTask?.workflowPhase).toBe('IN_PROGRESS');
    expect(recoveredTask?.projection.implementationRetry).toMatchObject({
      runId: run.id,
      reason: expect.stringMatching(/declined.*no Git change/i)
    });
    await recoveredService.shutdown();
  });

  it('reconciles missing post-run evidence before recording a merged GitHub refresh', async () => {
    const ghPath = await writeMergedPullRequestGh();
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-evidence-before-merge',
      ghPath
    });
    const task = await scenario.createTask({
      title: 'Reconcile before merge',
      prompt: 'Create a file after approval.'
    });
    const run = await scenario.service.startRun({ taskId: task.id });
    await recordDeclinedCommand(scenario, run);
    let observeFailedCapture!: () => void;
    const failedCapture = new Promise<void>((resolve) => {
      observeFailedCapture = resolve;
    });
    vi.spyOn(scenario.store, 'recordGitSnapshot').mockImplementationOnce(async () => {
      observeFailedCapture();
      throw new Error('Transient Git inspection failure.');
    });

    await scenario.completeRun(run.id, 'The command was denied.');
    await failedCapture;
    await recordOpenPullRequest(scenario, run);

    await expect(scenario.service.refreshGitHub({ taskId: task.id })).resolves.toMatchObject({
      number: 82,
      status: 'MERGED'
    });
    const snapshot = await scenario.store.snapshot();
    expect(
      snapshot.runs.find((candidate) => candidate.id === run.id)?.afterGitSnapshotId
    ).toBeTruthy();
    expect(snapshot.tasks.find((candidate) => candidate.id === task.id)).toMatchObject({
      workflowPhase: 'IN_PROGRESS',
      resolution: 'NONE',
      projection: {
        merge: 'MERGED',
        implementationRetry: {
          runId: run.id,
          reason: expect.stringMatching(/declined.*no Git change/i)
        }
      }
    });
  });
});

async function recordDeclinedCommand(
  scenario: TaskMonkiScenario,
  run: RunRecord
): Promise<void> {
  return recordDeclinedInteraction(scenario, run, {
    type: 'COMMAND_APPROVAL',
    request: {
      command: 'touch implemented.txt',
      startedAtMs: Date.now()
    },
    decision: { interactionType: 'COMMAND_APPROVAL', action: 'DECLINE' }
  });
}

async function recordOpenPullRequest(
  scenario: TaskMonkiScenario,
  run: RunRecord
): Promise<void> {
  const worktree = await scenario.store.getCurrentWorktree(run.taskId);
  if (!worktree) throw new Error('Scenario worktree was not created.');
  await scenario.store.recordPullRequestSync({
    pullRequest: {
      taskId: run.taskId,
      iterationId: run.iterationId,
      worktreeId: run.worktreeId,
      number: 82,
      url: 'https://github.com/example/repo/pull/82',
      status: 'OPEN_READY',
      state: 'OPEN',
      isDraft: false,
      headRefName: worktree.branchName,
      headRefOid: 'head',
      baseRefName: 'main'
    },
    ci: {
      taskId: run.taskId,
      iterationId: run.iterationId,
      worktreeId: run.worktreeId,
      pullRequestNumber: 82,
      headSha: 'head',
      status: 'PASSING',
      requiredStatus: 'PASSING',
      totalCount: 1,
      pendingCount: 0,
      passingCount: 1,
      failingCount: 0,
      skippedCount: 0,
      canceledCount: 0,
      checkDetails: []
    },
    reviews: {
      taskId: run.taskId,
      iterationId: run.iterationId,
      worktreeId: run.worktreeId,
      pullRequestNumber: 82,
      headSha: 'head',
      status: 'NOT_REQUESTED'
    },
    merge: {
      taskId: run.taskId,
      iterationId: run.iterationId,
      worktreeId: run.worktreeId,
      pullRequestNumber: 82,
      headSha: 'head',
      status: 'NOT_MERGED'
    }
  });
}

async function writeMergedPullRequestGh(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-merged-gh-'));
  return writeNodeExecutable(
    dir,
    'gh',
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'view') {
  console.log(JSON.stringify({
    number: 82,
    url: 'https://github.com/example/repo/pull/82',
    state: 'MERGED',
    isDraft: false,
    headRefName: 'codex/reconcile-before-merge',
    headRefOid: 'head',
    baseRefName: 'main',
    title: 'Reconcile before merge',
    mergedAt: '2026-07-19T12:00:00.000Z',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    statusCheckRollup: []
  }));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'checks') {
  console.log('[]');
  process.exit(0);
}
console.error('Unexpected gh invocation: ' + args.join(' '));
process.exit(1);
`
  );
}

async function recordDeclinedInteraction(
  scenario: TaskMonkiScenario,
  run: RunRecord,
  input: {
    type: InteractionRequestType;
    request: AgentInteractionRequestPayload;
    decision: AgentInteractionDecision;
  }
): Promise<void> {
  const server = await scenario.store.createAgentServer({
    runtimeId: run.runtimeId,
    runtimeKind: 'APP_SERVER',
    transport: 'STDIO',
    executable: 'scenario-agent',
    argv: ['serve']
  });
  await scenario.store.updateRun(run.id, { serverInstanceId: server.id });
  const rawMessage = await scenario.store.appendProtocolMessage(
    server.id,
    'INBOUND',
    JSON.stringify({
      method: 'session/request_permission',
      id: `declined-${input.type.toLowerCase()}`
    })
  );
  const interaction = await scenario.store.createInteractionRequest({
    runtimeId: run.runtimeId,
    serverInstanceId: server.id,
    providerRequestId: `declined-${input.type.toLowerCase()}`,
    taskId: run.taskId,
    iterationId: run.iterationId,
    runId: run.id,
    sessionId: run.sessionId,
    providerTurnId: run.providerTurnId,
    type: input.type,
    request: input.request,
    allowedActions: ['DECLINE'],
    policyWarnings: [],
    requestRawMessage: rawMessage
  });
  await scenario.store.transitionInteractionRequest(interaction.id, 'PENDING', {
    status: 'RESPONDING',
    decision: input.decision,
    respondedAt: new Date().toISOString()
  });
  await scenario.store.transitionInteractionRequest(interaction.id, 'RESPONDING', {
    status: 'DECLINED',
    resolution: { outcome: 'declined' },
    resolvedAt: new Date().toISOString()
  });
}
