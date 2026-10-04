import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskMonkiScenarioRegistry, createScriptedAgentRuntimeFixture } from '../../testSupport/taskMonkiScenario';
import { prepareTestWorktree } from '../../testSupport/prepareWorktree';
import { openTestPersistence } from '../../testSupport/persistenceFixture';
import { AgentMutationAmbiguousError } from '../agent/AgentRuntimeAdapter';
import { TaskManagerService } from './TaskManagerService';

const scenarios = new TaskMonkiScenarioRegistry();
afterEach(() => scenarios.dispose());

async function running() {
  const scenario = await scenarios.create({ name: 'task-instruction-lifecycle' });
  const task = await scenario.createTask();
  const worktree = await prepareTestWorktree(scenario.service, task.id);
  const run = await scenario.service.startRun({ taskId: task.id });
  const queue = (instruction: string) => scenario.service.queueTaskInstruction({ taskId: task.id, runId: run.id, id: randomUUID(), instruction });
  return { ...scenario, task, worktree, run, queue };
}

describe('Task instructions', () => {
  it('saves the initial prompt before preparation and never rewrites an executed prompt', async () => {
    const s = await scenarios.create({ name: 'initial-prompt-edit' });
    const task = await s.createTask();
    await s.service.saveTaskPrompt({ taskId: task.id, prompt: 'An unfinished edit', draftOnly: true });
    expect((await s.store.getTaskDetail(task.id)).task).toMatchObject({ prompt: task.prompt, promptDraft: 'An unfinished edit' });
    const files = await s.service.stageTaskAttachmentBatch({ attachments: [{ clientToken: randomUUID(), displayName: 'requirements.txt', bytes: new TextEncoder().encode('Report parser errors.').buffer }] });
    await s.service.saveTaskPrompt({ taskId: task.id, prompt: 'Read the parser and summarize its errors.', attachmentDraftId: files.id });
    await prepareTestWorktree(s.service, task.id);
    const run = await s.service.startRun({ taskId: task.id });
    expect(s.agent.startedTurns[0]?.prompt).toContain('Read the parser and summarize its errors.');
    expect(s.agent.startedTurns[0]?.attachments).toEqual([expect.objectContaining({ displayName: 'requirements.txt' })]);
    await expect(s.service.saveTaskPrompt({ taskId: task.id, prompt: 'Rewrite history' })).rejects.toThrow('already run');
    await expect(s.service.saveTaskPrompt({ taskId: task.id, prompt: 'Rewrite history', draftOnly: true })).rejects.toThrow('already run');
    expect((await s.store.getTaskDetail(task.id)).task.prompt).toBe('Read the parser and summarize its errors.');
    await s.completeRun(run.id);
  }, 25_000);

  it('delivers queued files only with their owning message and preserves the earlier run selection', async () => {
    const s = await running();
    const draft = await s.service.stageTaskAttachmentBatch({ attachments: [{
      clientToken: randomUUID(), displayName: 'queued-context.txt', bytes: new TextEncoder().encode('Only the queued response receives this context.').buffer
    }] });
    await s.service.saveTaskAgentDraft({ taskId: s.task.id, text: 'Read the attached context.', attachmentDraftId: draft.id });
    const request = { taskId: s.task.id, runId: s.run.id, id: randomUUID(), instruction: 'Read the attached context.', attachmentDraftId: draft.id };
    const queued = await s.service.queueTaskInstruction(request);
    expect(queued.attachmentIds).toHaveLength(1);
    expect((await s.store.getRun(s.run.id))?.attachmentSelection).toEqual([]);
    expect((await s.store.prepareRunAttachments(s.run.id, s.task.id))).toEqual([]);
    expect((await s.service.queueTaskInstruction(request)).id).toBe(queued.id);
    await s.service.cancelRun({ runId: s.run.id });
    const next = await s.service.sendTaskInstruction({ taskId: s.task.id, id: queued.id, runId: s.run.id });
    expect(next.attachmentSelection.map((file) => file.attachmentId)).toEqual(queued.attachmentIds);
    expect(s.agent.startedTurns.at(-1)?.attachments).toEqual([expect.objectContaining({ displayName: 'queued-context.txt' })]);
  }, 25_000);

  it('claims FIFO instructions once after local evidence, preserving authored text and the exact predecessor', async () => {
    const s = await running();
    await s.service.saveTaskAgentDraft({ taskId: s.task.id, text: 'First queued instruction.' });
    const first = await s.queue('First queued instruction.');
    expect((await s.store.getTaskDetail(s.task.id)).task.agentDraft ?? '').toBe('');
    const second = await s.queue('Second queued instruction.');
    await s.service.editTaskInstruction({ taskId: s.task.id, id: second.id, instruction: 'Edited second instruction.' });
    await fs.writeFile(path.join(s.worktree.worktreePath, 'change.txt'), 'changed\n');
    expect(s.agent.startedTurns).toHaveLength(1);
    await s.completeRun(s.run.id);
    const snapshot = await s.waitForSnapshot((state) => state.taskInstructions.some((item) => item.id === first.id && item.status === 'SUBMITTED'));
    const submitted = snapshot.taskInstructions.find((item) => item.id === first.id)!;
    const followUp = snapshot.runs.find((run) => run.id === submitted.runId)!;
    expect(followUp).toMatchObject({ mode: 'FOLLOW_UP', continuedFromRunId: s.run.id });
    expect(snapshot.runs.find((run) => run.id === s.run.id)?.afterGitSnapshotId).toBeTruthy();
    expect(snapshot.taskInstructions.find((item) => item.id === second.id)).toMatchObject({ status: 'QUEUED', sourceRunId: followUp.id });
    await expect(s.service.editTaskInstruction({ taskId: s.task.id, id: first.id, instruction: 'Late edit' })).rejects.toThrow('claimed');
    const duplicate = await s.service.queueTaskInstruction({ taskId: s.task.id, runId: s.run.id, id: first.id, instruction: first.text });
    expect(duplicate.runId).toBe(followUp.id);
    expect(s.agent.startedTurns).toHaveLength(2);
    // A repeated terminal notification for the predecessor must not hold the advanced queue.
    s.events.emit({ type: 'run.terminal', taskId: s.task.id, runId: s.run.id, payload: { status: 'COMPLETED' }, at: new Date().toISOString() });
    await s.completeRun(followUp.id);
    const drained = await s.waitForSnapshot((state) => state.taskInstructions.every((item) => item.status === 'SUBMITTED'));
    const last = drained.runs.find((run) => run.id === drained.taskInstructions.find((item) => item.id === second.id)?.runId)!;
    expect(last.continuedFromRunId).toBe(followUp.id);
    expect(s.agent.startedTurns[2]?.prompt).toContain('Edited second instruction.');
  }, 25_000);

  it('holds the whole queue before Stop reaches the provider and sends only the explicitly selected follow-up', async () => {
    const s = await running();
    const first = await s.queue('Keep this instruction.');
    const second = await s.queue('Wait for me.');
    const interrupt = s.agent.interruptTurn.bind(s.agent);
    vi.spyOn(s.agent, 'interruptTurn').mockImplementation(async (input) => {
      expect((await s.store.getTaskDetail(s.task.id)).taskInstructions.map((item) => item.status)).toEqual(['HELD', 'HELD']);
      await interrupt(input);
    });
    await s.service.cancelRun({ runId: s.run.id });
    const followUp = await s.service.sendTaskInstruction({ taskId: s.task.id, id: first.id, runId: s.run.id });
    expect(followUp.mode).toBe('FOLLOW_UP');
    await s.completeRun(followUp.id);
    const detail = await s.store.getTaskDetail(s.task.id);
    expect(detail.taskInstructions.find((item) => item.id === second.id)?.status).toBe('HELD');
    expect(s.agent.startedTurns).toHaveLength(2);
    await s.service.editTaskInstruction({ taskId: s.task.id, id: second.id });
    expect((await s.store.getTaskDetail(s.task.id)).taskInstructions).toHaveLength(1);
  }, 25_000);

  it('retains uncertain live delivery without resending and holds queued work', async () => {
    const s = await running();
    await s.queue('Next instruction');
    vi.spyOn(s.agent, 'steerTurn').mockRejectedValue(new AgentMutationAmbiguousError('turn/steer', 'Connection lost after send'));
    const input = { taskId: s.task.id, runId: s.run.id, clientMessageId: randomUUID(), instruction: 'Change direction now.' };
    await expect(s.service.steerRun(input)).rejects.toThrow('Connection lost');
    await expect(s.service.steerRun(input)).rejects.toThrow('Connection lost');
    expect(s.agent.steerTurn).toHaveBeenCalledTimes(1);
    const detail = await s.store.getTaskDetail(s.task.id);
    expect(detail.taskInstructions.find((item) => item.id === input.clientMessageId)).toMatchObject({ status: 'UNCERTAIN', text: input.instruction });
    expect(detail.taskInstructions.find((item) => item.mode === 'QUEUE')?.status).toBe('HELD');
  }, 25_000);

  it('does not replay an ambiguous follow-up and retains the draft when submission rejects', async () => {
    const s = await running();
    await s.completeRun(s.run.id);
    s.agent.ambiguousStart = true;
    const input = { taskId: s.task.id, runId: s.run.id, clientMessageId: randomUUID(), instruction: 'Continue with this exact instruction.' };
    await s.service.saveTaskAgentDraft({ taskId: s.task.id, text: input.instruction });
    await expect(s.service.continueRun(input)).rejects.toThrow('lost the start response');
    const admitted = await s.service.continueRun(input);
    expect(admitted.status).toBe('RECOVERY_REQUIRED');
    expect(s.agent.startedTurns).toHaveLength(2);
    const detail = await s.store.getTaskDetail(s.task.id);
    expect(detail.task.agentDraft).toBe(input.instruction);
    expect(detail.taskInstructions).toEqual([expect.objectContaining({ id: input.clientMessageId, runId: admitted.id, status: 'SUBMITTED' })]);
  }, 25_000);

  it('retries an unadmitted follow-up once with the same message and retained files', async () => {
    const s = await running();
    await s.completeRun(s.run.id);
    const draft = await s.service.stageTaskAttachmentBatch({ attachments: [{
      clientToken: randomUUID(), displayName: 'retry.txt', bytes: new TextEncoder().encode('Keep these bytes.').buffer
    }] });
    const input = { taskId: s.task.id, runId: s.run.id, clientMessageId: randomUUID(),
      instruction: 'Read the file and continue.', attachmentDraftId: draft.id };
    await s.service.saveTaskAgentDraft({ taskId: s.task.id, text: input.instruction, attachmentDraftId: draft.id });
    const resolve = s.agent.resolveExecution.bind(s.agent);
    vi.spyOn(s.agent, 'resolveExecution').mockImplementationOnce(resolve)
      .mockRejectedValueOnce(new Error('Model catalog temporarily unavailable.'));

    await expect(s.service.continueRun(input)).rejects.toThrow('temporarily unavailable');
    const failed = (await s.store.getTaskDetail(s.task.id)).taskInstructions[0]!;
    expect(failed.status).toBe('FAILED');
    expect(await s.store.getRun(failed.runId!)).toBeUndefined();
    expect((await s.store.getTaskDetail(s.task.id)).task.agentDraft).toBe(input.instruction);
    expect(s.agent.startedTurns).toHaveLength(1);

    const retried = await s.service.continueRun(input);
    expect(retried.id).toBe(failed.runId);
    expect(retried.attachmentSelection.map((file) => file.attachmentId)).toEqual(failed.attachmentIds);
    expect(new TextDecoder().decode((await s.service.readTaskAttachment({ attachmentId: failed.attachmentIds![0]! })).bytes)).toBe('Keep these bytes.');
    expect((await s.service.continueRun(input)).id).toBe(retried.id);
    expect(s.agent.startedTurns).toHaveLength(2);
    expect((await s.store.getTaskDetail(s.task.id)).task.agentDraft).toBe('');
  }, 25_000);

  it('rejects a combined prompt and message file selection before adopting the message', async () => {
    const s = await scenarios.create({ name: 'combined-message-attachments' });
    const task = await s.createTask();
    const initial = await s.service.stageTaskAttachmentBatch({ attachments: [{
      clientToken: randomUUID(), displayName: 'initial.txt', bytes: new TextEncoder().encode('Initial context').buffer
    }] });
    await s.service.saveTaskPrompt({ taskId: task.id, prompt: task.prompt, attachmentDraftId: initial.id });
    await prepareTestWorktree(s.service, task.id);
    const run = await s.service.startRun({ taskId: task.id });
    const draft = await s.service.stageTaskAttachmentBatch({ attachments: Array.from({ length: 10 }, (_, index) => ({
      clientToken: randomUUID(), displayName: `context-${index}.txt`, bytes: new TextEncoder().encode('Message context').buffer
    })) });
    const request = { taskId: task.id, runId: run.id, id: randomUUID(), instruction: 'Use these files.', attachmentDraftId: draft.id };
    await expect(s.service.queueTaskInstruction(request)).rejects.toThrow('initial prompt');
    expect((await s.store.getTaskDetail(task.id)).taskInstructions).toEqual([]);
    expect(await s.store.getTaskAttachments(task.id)).toHaveLength(1);
    expect((await s.store.listAttachmentDraft(draft.id)).attachments).toHaveLength(10);
    expect(s.agent.startedTurns).toHaveLength(1);
  }, 25_000);

  it('saves prompt files locally and validates image support at execution', async () => {
    const s = await scenarios.create({ name: 'local-prompt-attachment-save' });
    const [model] = await s.agent.listModels();
    const models = vi.spyOn(s.agent, 'listModels').mockResolvedValue([{ ...model!, inputModalities: ['text'] }]);
    const task = await s.createTask();
    const draft = await s.service.stageTaskAttachmentBatch({ attachments: [{
      clientToken: randomUUID(), displayName: 'screen.png', bytes: Uint8Array.from(Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'
      )).buffer
    }] });
    await s.service.saveTaskPrompt({ taskId: task.id, prompt: 'Inspect the image.', attachmentDraftId: draft.id });
    await prepareTestWorktree(s.service, task.id);
    await expect(s.service.startRun({ taskId: task.id })).rejects.toThrow('does not accept image attachments');
    expect(s.agent.startedTurns).toEqual([]);
    expect((await s.store.getTaskDetail(task.id)).task.prompt).toBe('Inspect the image.');
    models.mockRestore();
    await s.service.startRun({ taskId: task.id });
    expect(s.agent.startedTurns[0]?.attachments).toEqual([expect.objectContaining({ displayName: 'screen.png' })]);
  }, 25_000);

  it('holds work on restart and explicitly resends an unadmitted message with its files', async () => {
    const s = await running();
    const queueFiles = await s.service.stageTaskAttachmentBatch({ attachments: [{ clientToken: randomUUID(), displayName: 'queued.txt', bytes: new TextEncoder().encode('Queued bytes').buffer }] });
    const queued = await s.service.queueTaskInstruction({ taskId: s.task.id, runId: s.run.id, id: randomUUID(), instruction: 'Wait until I return.', attachmentDraftId: queueFiles.id });
    const draftFiles = await s.service.stageTaskAttachmentBatch({ attachments: [{ clientToken: randomUUID(), displayName: 'draft.txt', bytes: new TextEncoder().encode('Unsent bytes').buffer }] });
    await s.service.saveTaskAgentDraft({ taskId: s.task.id, text: 'An unfinished thought.', attachmentDraftId: draftFiles.id });
    await s.service.cancelRun({ runId: s.run.id });
    const failedFiles = await s.service.stageTaskAttachmentBatch({ attachments: [{
      clientToken: randomUUID(), displayName: 'retry.txt', bytes: new TextEncoder().encode('Resend these bytes.').buffer
    }] });
    const failedInput = { taskId: s.task.id, runId: s.run.id, clientMessageId: randomUUID(),
      instruction: 'Continue with the attached file.', attachmentDraftId: failedFiles.id };
    const resolve = s.agent.resolveExecution.bind(s.agent);
    vi.spyOn(s.agent, 'resolveExecution').mockImplementationOnce(resolve).mockRejectedValueOnce(new Error('Temporary model failure'));
    await expect(s.service.continueRun(failedInput)).rejects.toThrow('Temporary model failure');
    await s.service.shutdown();
    await s.persistence.close();
    const persistence = await openTestPersistence(s.persistence.paths.profileRoot);
    const fixture = createScriptedAgentRuntimeFixture(persistence);
    const restarted = new TaskManagerService(persistence.tasks, s.repositoryPath, undefined, { worktreeRoot: s.worktreeRoot, ...fixture.serviceOptions });
    try {
      await restarted.init();
      const detail = await restarted.getTaskDetail(s.task.id);
      expect(detail.task.agentDraft).toBe('An unfinished thought.');
      expect(detail.taskInstructions[0]?.status).toBe('HELD');
      expect(detail.taskInstructions[0]?.attachmentIds).toEqual(queued.attachmentIds);
      expect(detail.agentAttachmentDraft?.attachments[0]?.displayName).toBe('draft.txt');
      expect(new TextDecoder().decode((await restarted.readTaskAttachment({ attachmentId: queued.attachmentIds![0]! })).bytes)).toBe('Queued bytes');
      expect(fixture.adapter.startedTurns).toEqual([]);
      const failed = detail.taskInstructions.find((item) => item.id === failedInput.clientMessageId)!;
      expect(failed.status).toBe('FAILED');
      await restarted.editTaskInstruction({ taskId: s.task.id, id: failed.id, instruction: 'Read the retained file and continue.' });
      const resumed = await restarted.sendTaskInstruction({ taskId: s.task.id, id: failed.id, runId: s.run.id });
      expect(resumed.id).toBe(failed.runId);
      expect(fixture.adapter.startedTurns).toHaveLength(1);
      expect(fixture.adapter.startedTurns[0]?.attachments).toEqual([expect.objectContaining({ displayName: 'retry.txt' })]);
      expect((await restarted.sendTaskInstruction({ taskId: s.task.id, id: failed.id, runId: s.run.id })).id).toBe(resumed.id);
      expect(fixture.adapter.startedTurns).toHaveLength(1);
      expect((await restarted.getTaskDetail(s.task.id)).taskInstructions.find((item) => item.id === queued.id)?.status).toBe('HELD');
    } finally { await restarted.shutdown(); await persistence.close(); }
  }, 25_000);
});
