import { describe, expect, it } from 'vitest';
import { createTaskMonkiScenario } from '../../testSupport/taskMonkiScenario';

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
});
