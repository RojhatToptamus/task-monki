import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { CAPTURE_ID, CASE_ID, bugCaseRecord, captureRecord } from '../../testSupport/bugReplay/bugReplayFixtures';
import { prepareTestWorktree } from '../../testSupport/prepareWorktree';
import { TaskMonkiScenarioRegistry } from '../../testSupport/taskMonkiScenario';

const scenarios = new TaskMonkiScenarioRegistry();
afterEach(() => scenarios.dispose());

const REQUEST = 'Fix the recorded bug.';

/**
 * A task with a prepared worktree and a recorded bug kept without a check. With `whileRunning`,
 * the agent's first turn started before the bug was recorded and is still running.
 */
async function recordedBug(name: string, options: { whileRunning?: boolean } = {}) {
  const scenario = await scenarios.create({ name, bugReplay: true });
  const task = await scenario.createTask({ title: 'Checkout total', prompt: 'Fix the coupon total.' });
  await prepareTestWorktree(scenario.service, task.id);
  const run = options.whileRunning ? await scenario.service.startRun({ taskId: task.id }) : undefined;
  const store = scenario.persistence.bugReplay;
  await store.write((tx) => {
    store.insertCapture(tx, captureRecord({ taskId: task.id }));
    store.insertCase(tx, bugCaseRecord({ taskId: task.id }));
  });
  return { ...scenario, task, run };
}

describe('Sending a recorded bug to the agent', () => {
  it('starts the agent with the brief in the turn prompt, once', async () => {
    const s = await recordedBug('bug-handoff-first-turn');

    const sent = await s.service.sendBugToAgent({ taskId: s.task.id, clientOperationId: randomUUID() });

    expect(sent.activeCase?.gate.handoff).toMatchObject({ status: 'RUNNING' });
    expect(s.agent.startedTurns).toHaveLength(1);
    // The first turn works on the task's goal with the recorded bug beside it.
    const prompt = s.agent.startedTurns[0].prompt;
    expect(prompt).toContain('Authoritative Task Monki goal:\nFix the coupon total.\n\nRecorded bug\nTask Monki recorded this bug in a clean copy of the app');
    expect(prompt).toContain('1. Open /\n2. Type "SAVE5" into "Coupon code"\n3. Click "Apply coupon"');
    expect(prompt).toContain('Task Monki will not verify this fix automatically.');

    // A second send while the agent has it starts nothing.
    await expect(s.service.sendBugToAgent({ taskId: s.task.id, clientOperationId: randomUUID() })).rejects.toThrow('The agent already has this bug.');
    expect(s.agent.startedTurns).toHaveLength(1);

    // Once that turn ends, sending again continues the same conversation with a fresh brief.
    await s.completeRun(sent.activeCase!.gate.handoff!.runId!);
    await s.waitForSnapshot(() => true);
    const again = await s.service.sendBugToAgent({ taskId: s.task.id, clientOperationId: randomUUID() });
    expect(again.activeCase?.gate.handoff?.status).toBe('RUNNING');
    expect(s.agent.startedTurns).toHaveLength(2);
    expect(s.agent.startedTurns[1].prompt).toContain('Recorded bug\n');
  }, 60_000);

  it('starts the task’s first turn with its recorded bug, so starting and sending are one step', async () => {
    const s = await recordedBug('bug-start-carries-bug');

    const run = await s.service.startRun({ taskId: s.task.id });

    expect(s.agent.startedTurns[0].prompt).toContain('Fix the coupon total.\n\nRecorded bug\nTask Monki recorded this bug in a clean copy of the app');
    const snapshot = await s.service.getBugReplay({ taskId: s.task.id });
    expect(snapshot.activeCase?.gate.handoff).toMatchObject({ status: 'RUNNING', runId: run.id });
    // Once a turn ran, Send to agent is how the bug goes back to the agent.
    await s.completeRun(run.id);
    await s.waitForSnapshot(() => true);
    const after = await s.service.getBugReplay({ taskId: s.task.id });
    expect(after.activeCase?.startSendsBug).toBeUndefined();
    expect(after.activeCase?.actions).toContain('send-to-agent');
  }, 60_000);

  it('queues the bug behind the running turn as the person’s words, with the brief added only when it is sent', async () => {
    const s = await recordedBug('bug-handoff-queued', { whileRunning: true });
    const run = s.run!;
    const id = randomUUID();

    const sent = await s.service.sendBugToAgent({ taskId: s.task.id, clientOperationId: id });

    expect(sent.activeCase?.gate.handoff).toMatchObject({ status: 'QUEUED', handoffId: id });
    const queued = (await s.store.getTaskDetail(s.task.id)).taskInstructions.find((item) => item.id === id);
    expect(queued).toMatchObject({ status: 'QUEUED', text: REQUEST, bugCase: { caseId: CASE_ID, captureId: CAPTURE_ID } });
    expect(s.agent.startedTurns[0].prompt).not.toContain('Recorded bug');

    await s.completeRun(run.id);
    await s.waitForSnapshot((state) => state.taskInstructions.some((item) => item.id === id && item.status === 'SUBMITTED'));
    expect(s.agent.startedTurns).toHaveLength(2);
    expect(s.agent.startedTurns[1].prompt).toContain(REQUEST);
    expect(s.agent.startedTurns[1].prompt).toContain('Recorded bug\nTask Monki recorded this bug');
  }, 60_000);

  it('tells the agent when the person removed the bug before its queued turn ran', async () => {
    const s = await recordedBug('bug-handoff-removed', { whileRunning: true });
    const run = s.run!;
    const id = randomUUID();
    await s.service.sendBugToAgent({ taskId: s.task.id, clientOperationId: id });

    await s.service.removeBug({ taskId: s.task.id });
    await s.completeRun(run.id);
    await s.waitForSnapshot((state) => state.taskInstructions.some((item) => item.id === id && item.status === 'SUBMITTED'));

    const prompt = s.agent.startedTurns.at(-1)!.prompt;
    expect(prompt).toContain('The person removed or replaced the bug "Coupon total is wrong" after sending it. Task Monki will not verify this fix.');
    expect(prompt).not.toContain('1. Open /');
  }, 60_000);

  it('never lets a request from the window attach a bug to its own instruction', async () => {
    const s = await recordedBug('bug-handoff-smuggled', { whileRunning: true });
    const run = s.run!;

    const queued = await s.service.queueTaskInstruction({
      taskId: s.task.id,
      runId: run.id,
      id: randomUUID(),
      instruction: 'Also tidy the cart page.',
      bugCase: { caseId: CASE_ID, captureId: CAPTURE_ID }
    } as Parameters<typeof s.service.queueTaskInstruction>[0]);

    expect(queued.bugCase).toBeUndefined();
    await s.completeRun(run.id);
    await s.waitForSnapshot((state) => state.taskInstructions.some((item) => item.id === queued.id && item.status === 'SUBMITTED'));
    expect(s.agent.startedTurns.at(-1)!.prompt).not.toContain('Recorded bug');
  }, 60_000);
});
