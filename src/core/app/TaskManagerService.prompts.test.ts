import { describe, expect, it } from 'vitest';
import { createTaskMonkiScenario } from '../../testSupport/taskMonkiScenario';

describe('TaskManagerService prompt composition', () => {
  it('wraps active-turn steering instructions with Task Monki constraints', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-manager-steer-prompt'
    });
    const task = await scenario.createTask({
      title: 'Steer safely',
      prompt: 'Update the progress panel.'
    });
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
  });

  it('allows a recovery-required source run to continue with bounded prior-run context', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-manager-recovery-continuation'
    });
    const task = await scenario.createTask({
      title: 'Recover prompt',
      prompt: 'Recover the task after provider ambiguity.'
    });
    const run = await scenario.service.startRun({ taskId: task.id });
    await scenario.store.updateRun(run.id, {
      status: 'RECOVERY_REQUIRED',
      recoveryState: 'REQUIRES_USER_ACTION',
      terminalReason: 'Provider lost the turn/start response.',
      finalMessage: 'The previous attempt inspected the agent panel but did not verify the fix.'
    });

    const continued = await scenario.service.continueRun({
      taskId: task.id,
      runId: run.id,
      instruction: 'Continue from the current local state.'
    });

    const prompt = await scenario.store.readArtifact(continued.promptArtifactId);
    expect(continued.mode).toBe('FOLLOW_UP');
    expect(continued.continuedFromRunId).toBe(run.id);
    expect(prompt).toContain('Previous run status: RECOVERY_REQUIRED.');
    expect(prompt).toContain('Previous recovery state: REQUIRES_USER_ACTION.');
    expect(prompt).toContain('Previous terminal reason: Provider lost the turn/start response.');
    expect(prompt).toContain(
      'Previous provider final summary excerpt (context only, not verified evidence)'
    );
    expect(prompt).toContain('Continue from the current local state.');
    await expect(scenario.store.getRun(run.id)).resolves.toMatchObject({
      status: 'INTERRUPTED',
      recoveryState: 'NONE',
      terminalReason:
        'Recovery-required run was superseded by an explicit continue or retry action.'
    });
  });
});
