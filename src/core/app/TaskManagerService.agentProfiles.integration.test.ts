import { afterEach, describe, expect, it } from 'vitest';
import { TaskMonkiScenarioRegistry } from '../../testSupport/taskMonkiScenario';
import { openTestPersistence } from '../../testSupport/persistenceFixture';
import path from 'node:path';

const scenarios = new TaskMonkiScenarioRegistry();
afterEach(() => scenarios.dispose());

describe('Task agent profiles', () => {
  it('keeps exact assigned guidance through library changes, follow-ups, detached review, and reload', async () => {
    const scenario = await scenarios.create({ name: 'task-profiles' });
    const settings = await scenario.service.saveAgentProfile({
      name: 'Protocol',
      description: 'Trace producer and consumer.',
      instructions: '  Check actual wire requests.\nDo not infer successful delivery.\n'
    });
    const original = settings.agentProfiles[0]!;
    const request = {
      title: 'Profile persistence',
      prompt: 'Repair the event consumer.',
      repositoryId: scenario.repositoryId,
      creationToken: 'a151beeb-cfa9-46f0-91d7-f62f5cbbaed2',
      agentSettings: { model: 'scenario-model', reasoningEffort: 'low' },
      agentProfileId: original.id,
      agentProfile: { ...original, instructions: 'Caller-supplied false instructions.' }
    };
    const task = await scenario.service.createTask(request);
    await scenario.service.saveAgentProfile({
      ...original,
      instructions: 'Updated library instructions.'
    });
    const run = await scenario.service.startRun({ taskId: task.id });
    const prompt = await scenario.runtimeStore.readArtifact(run.promptArtifactId);
    expect(prompt).toContain(original.instructions);
    expect(prompt).not.toContain('Updated library instructions.');
    expect(prompt).not.toContain('Caller-supplied false instructions.');
    expect(scenario.agent.startedTurns[0]?.prompt).toBe(prompt);
    await scenario.completeRun(run.id, 'Profile claims tests passed.');

    const review = await scenario.service.startReview({ taskId: task.id, runId: run.id });
    const reviewPrompt = await scenario.runtimeStore.readArtifact(review.promptArtifactId);
    expect(reviewPrompt).not.toContain(original.instructions);
    expect(scenario.agent.startedRuntimeTurns.find((turn) => turn.run.id === review.id)?.prompt).toBe(reviewPrompt);
    expect(
      (await scenario.store.snapshot()).agentSessions.find(
        (session) => session.id === review.sessionId
      )?.requestedSettings.sandbox
    ).toBe('READ_ONLY');
    await scenario.completeRun(review.id);

    const repeatedReview = await scenario.service.startReview({ taskId: task.id, runId: run.id });
    expect(repeatedReview.sessionId).not.toBe(review.sessionId);
    expect(await scenario.runtimeStore.readArtifact(repeatedReview.promptArtifactId)).toBe(reviewPrompt);
    await scenario.completeRun(repeatedReview.id);

    await scenario.service.deleteAgentProfile(original.id);
    await expect(scenario.service.createTask(request)).resolves.toMatchObject({
      id: task.id,
      agentProfile: original
    });
    await expect(
      scenario.service.createTask({
        ...request,
        creationToken: '96781b23-04a0-4880-a5ac-b2af95a13a34'
      })
    ).rejects.toThrow('no longer in the library');
    const followUp = await scenario.service.continueRun({
      taskId: task.id,
      runId: run.id,
      instruction: 'Check cancellation too.'
    });
    const followUpPrompt = await scenario.runtimeStore.readArtifact(followUp.promptArtifactId);
    expect(followUpPrompt).toContain(original.instructions);
    expect(followUpPrompt).toContain('Check cancellation too.');
    await scenario.completeRun(followUp.id);
    const fork = await scenario.store.createForkedAlternativeTask({
      title: 'Alternative protocol approach',
      prompt: task.prompt,
      repositoryId: task.repositoryId,
      agentSettings: task.agentSettings,
      sourceTaskId: task.id,
      sourceRunId: followUp.id
    });
    expect(fork.agentProfile).toEqual(original);

    await scenario.service.shutdown();
    await scenario.persistence.close();
    const reloaded = await openTestPersistence(path.join(scenario.rootDir, 'profile'));
    try {
      await reloaded.tasks.init();
      expect((await reloaded.tasks.getTask(fork.id))?.agentProfile).toEqual(original);
      expect((await reloaded.tasks.getTask(task.id))?.agentProfile).toEqual(original);
      expect(await reloaded.agentRuntime.readArtifact(run.promptArtifactId)).toBe(prompt);
    } finally {
      await reloaded.close();
    }
  }, 30_000);
});
