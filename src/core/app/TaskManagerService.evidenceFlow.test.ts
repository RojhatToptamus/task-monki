import { describe, expect, it, vi } from 'vitest';
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

  it('keeps storage open until terminal post-run evidence is recorded', async () => {
    const scenario = await createTaskMonkiScenario({
      name: 'task-monki-evidence-shutdown'
    });
    const task = await scenario.createTask({
      title: 'Shutdown evidence flow',
      prompt: 'Finish while application shutdown begins.'
    });
    const run = await scenario.service.startRun({ taskId: task.id });
    const originalRefresh = scenario.service.refreshEvidence.bind(scenario.service);
    let releaseEvidence!: () => void;
    const evidenceGate = new Promise<void>((resolve) => {
      releaseEvidence = resolve;
    });
    let markEvidenceEntered!: () => void;
    const evidenceEntered = new Promise<void>((resolve) => {
      markEvidenceEntered = resolve;
    });
    vi.spyOn(scenario.service, 'refreshEvidence').mockImplementation(async (input) => {
      markEvidenceEntered();
      await evidenceGate;
      return originalRefresh(input);
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
});
