import { afterEach, describe, expect, it } from 'vitest';
import { readTaskUserContext } from '../prompt/TaskUserContext';
import { openTestPersistence } from '../../testSupport/persistenceFixture';
import { prepareTestWorktree } from '../../testSupport/prepareWorktree';
import {
  TaskMonkiScenarioRegistry
} from '../../testSupport/taskMonkiScenario';

const scenarios = new TaskMonkiScenarioRegistry();
const createTaskMonkiScenario = scenarios.create.bind(scenarios);

afterEach(async () => {
  await scenarios.dispose();
});

describe('TaskManagerService prompt composition', () => {
  it('wraps active-turn steering instructions with Task Monki constraints', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-manager-steer-prompt'
    });
    const task = await scenario.createTask({
      title: 'Steer safely',
      prompt: 'Update the progress panel.'
    });
    await prepareTestWorktree(scenario.service, task.id);
    const run = await scenario.service.startRun({ taskId: task.id });

    await scenario.service.steerRun({
      taskId: task.id,
      runId: run.id,
      instruction: 'Focus on the failing test first.'
    });

    expect(scenario.agent.steeredTurns).toHaveLength(1);
    expect(scenario.agent.steeredTurns[0]?.prompt).toContain(
      'Additional instruction for the active Task Monki turn'
    );
    expect(scenario.agent.steeredTurns[0]?.prompt).toContain(
      'Focus on the failing test first.'
    );
    expect(scenario.agent.steeredTurns[0]?.prompt).toContain(
      'Preserve the authoritative task goal'
    );
    expect(scenario.agent.steeredTurns[0]?.prompt).toContain(
      'Do not commit, push, merge'
    );
  }, 15_000);

  it('allows a recovery-required source run to continue with bounded prior-run context', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-manager-recovery-continuation'
    });
    const task = await scenario.createTask({
      title: 'Recover prompt',
      prompt: 'Recover the task after provider ambiguity.'
    });
    await prepareTestWorktree(scenario.service, task.id);
    const run = await scenario.service.startRun({ taskId: task.id });
    await scenario.transitionRun(
      run.id,
      {
        status: 'RECOVERY_REQUIRED',
        recoveryState: 'REQUIRES_USER_ACTION',
        terminalReason: 'Provider lost the turn/start response.',
        finalMessage: 'The previous attempt inspected the agent panel but did not verify the fix.'
      },
      `prompt-recovery-required:${run.id}`
    );

    const continued = await scenario.service.continueRun({
      taskId: task.id,
      runId: run.id,
      instruction: 'Continue from the current local state.'
    });

    const prompt = await scenario.service.readArtifact({
      artifactId: continued.promptArtifactId
    });
    expect(continued.mode).toBe('FOLLOW_UP');
    expect(continued.continuedFromRunId).toBe(run.id);
    expect(prompt).toContain('Previous run status: RECOVERY_REQUIRED.');
    expect(prompt).toContain('Previous recovery state: REQUIRES_USER_ACTION.');
    expect(prompt).toContain('Previous terminal reason: Provider lost the turn/start response.');
    expect(prompt).toContain(
      'Previous provider final summary excerpt (context only, not verified evidence)'
    );
    expect(
      prompt.endsWith(
        'Additional continuation guidance:\nContinue from the current local state.'
      )
    ).toBe(true);
    await expect(scenario.taskRuntime.getRun(run.id)).resolves.toMatchObject({
      status: 'INTERRUPTED',
      recoveryState: 'NONE',
      terminalReason:
        'Recovery-required run was superseded by an explicit continue or retry action.'
    });
  }, 15_000);

  it('uses a distinct original-goal prompt for Retry implementation', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-manager-implementation-retry'
    });
    const task = await scenario.createTask({
      title: 'Retry prompt',
      prompt: 'Complete the original implementation safely.'
    });
    await prepareTestWorktree(scenario.service, task.id);
    const run = await scenario.service.startRun({ taskId: task.id });
    await scenario.transitionRun(
      run.id,
      { status: 'FAILED', terminalReason: 'Provider process exited.' },
      `prompt-run-failed:${run.id}`
    );

    const retry = await scenario.service.retryRun({
      taskId: task.id,
      runId: run.id,
      strategy: 'SAME_SESSION',
      instruction: 'Keep the correction focused.'
    });

    const prompt = await scenario.service.readArtifact({
      artifactId: retry.promptArtifactId
    });
    expect(retry.mode).toBe('RETRY');
    expect(retry.retryOfRunId).toBe(run.id);
    expect(prompt).toContain('Retry the implementation after unsuccessful run');
    expect(prompt).toContain(
      'Make another attempt to complete the authoritative Task Monki goal stated below.'
    );
    expect(prompt).toContain('do not blindly repeat operations with external side effects');
    expect(prompt).toContain(
      'Authoritative Task Monki goal:\nComplete the original implementation safely.'
    );
    expect(prompt.endsWith('Additional retry guidance:\nKeep the correction focused.')).toBe(
      true
    );
  }, 15_000);

  it('carries saved answers and corrections into retry, continuation, detached review and a fork at its source cutoff', async () => {
    const scenario = await createTaskMonkiScenario({ name: 'task-user-context' });
    const task = await scenario.createTask({ prompt: 'Build a staff inventory page. Keep keyboard access.' });
    await prepareTestWorktree(scenario.service, task.id);
    const run = await scenario.service.startRun({ taskId: task.id });
    await scenario.service.steerRun({ taskId: task.id, runId: run.id, instruction: 'Use French labels.' });
    await scenario.service.queueTaskInstruction({ taskId: task.id, runId: run.id, id: '223e4567-e89b-42d3-a456-426614174000', instruction: 'UNSENT: add a customer storefront.' });
    const server = await scenario.runtimeStore.createAgentServer({ runtimeId: run.runtimeId, runtimeKind: 'APP_SERVER', transport: 'STDIO', executable: 'scenario', argv: [] });
    await scenario.transitionRun(run.id, { status: 'RUNNING', serverInstanceId: server.id });
    const raw = await scenario.runtimeStore.appendProtocolMessage(server.id, 'INBOUND', '{"id":1}');
    const interaction = await scenario.taskRuntime.createInteractionRequest({
      runtimeId: run.runtimeId, serverInstanceId: server.id, providerRequestId: 1,
      taskId: task.id, iterationId: run.iterationId, runId: run.id, sessionId: run.sessionId,
      type: 'USER_INPUT', request: { questions: [{ id: 'stock', header: 'Stock', question: 'Which stock should be shown?', isOther: true, isSecret: false }] },
      allowedActions: ['ANSWER'], policyWarnings: [], requestRawMessage: raw
    }, 'stock-question');
    await scenario.taskRuntime.transitionInteractionRequest(interaction.id, 'PENDING', {
      status: 'STALE', respondedAt: new Date().toISOString(),
      decision: { interactionType: 'USER_INPUT', action: 'ANSWER', answers: { stock: ['Only the Vienna warehouse.'] } }
    }, 'stock-answer');
    await scenario.transitionRun(run.id, { status: 'FAILED', endedAt: new Date().toISOString() });
    const retry = await scenario.service.retryRun({ taskId: task.id, runId: run.id, strategy: 'SAME_SESSION', instruction: 'Correction: use German labels.' });
    const retryPrompt = await scenario.service.readArtifact({ artifactId: retry.promptArtifactId });
    expect(retryPrompt).toContain('Only the Vienna warehouse.');
    expect(retryPrompt).toContain('prior delivery unconfirmed');
    expect(retryPrompt).toContain('Use French labels.');
    expect(retryPrompt).toContain('Correction: use German labels.');
    expect(retryPrompt).toContain('Keep keyboard access.');
    expect(retryPrompt).not.toContain('UNSENT:');
    await scenario.completeRun(retry.id);
    const continued = await scenario.service.continueRun({ taskId: task.id, runId: retry.id, instruction: 'Add low-stock filtering.' });
    const continuedPrompt = await scenario.service.readArtifact({ artifactId: continued.promptArtifactId });
    expect(continuedPrompt).toContain('Only the Vienna warehouse.');
    expect(continuedPrompt).toContain('Correction: use German labels.');
    await scenario.completeRun(continued.id);
    const review = await scenario.service.startReview({ taskId: task.id, runId: continued.id, target: { type: 'UNCOMMITTED_CHANGES' } });
    const reviewPrompt = await scenario.service.readArtifact({ artifactId: review.promptArtifactId });
    expect(review.sessionId).not.toBe(continued.sessionId);
    expect(reviewPrompt).toContain('Only the Vienna warehouse.');
    expect(reviewPrompt).toContain('Correction: use German labels.');
    expect(reviewPrompt).toContain('Add low-stock filtering.');
    await scenario.completeRun(review.id);
    const fork = await scenario.service.retryRun({ taskId: task.id, runId: run.id, strategy: 'FORK' });
    const forkPrompt = await scenario.service.readArtifact({ artifactId: fork.promptArtifactId });
    expect(forkPrompt).toContain('Only the Vienna warehouse.');
    expect(forkPrompt).toContain('Use French labels.');
    expect(forkPrompt).not.toContain('Correction: use German labels.');
    expect(forkPrompt).not.toContain('Add low-stock filtering.');
    expect(forkPrompt).not.toContain('UNSENT:');
    await scenario.completeRun(fork.id);
    await scenario.service.shutdown();
    await scenario.persistence.close();
    const reopened = await openTestPersistence(scenario.persistence.paths.profileRoot);
    const restored = await readTaskUserContext(reopened.tasks, task.id, { throughRunId: retry.id });
    expect(restored).toContain('Only the Vienna warehouse.');
    expect(restored).toContain('Use French labels.');
    expect(restored).toContain('Correction: use German labels.');
    expect(restored).not.toContain('Add low-stock filtering.');
    expect(restored).not.toContain('UNSENT:');
    await reopened.close();
  }, 45_000);

  it('rejects Retry implementation after an ordinary successful completion', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-manager-successful-retry'
    });
    const task = await scenario.createTask({
      title: 'Successful implementation',
      prompt: 'Complete this implementation once.'
    });
    await prepareTestWorktree(scenario.service, task.id);
    const run = await scenario.service.startRun({ taskId: task.id });
    await scenario.transitionRun(
      run.id,
      { status: 'COMPLETED', endedAt: new Date().toISOString() },
      `prompt-run-completed:${run.id}`
    );

    await expect(
      scenario.service.retryRun({
        taskId: task.id,
        runId: run.id,
        strategy: 'SAME_SESSION'
      })
    ).rejects.toThrow(`Run ${run.id} cannot be retried while it is COMPLETED.`);
  }, 15_000);
});
