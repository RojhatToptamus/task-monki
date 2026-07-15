import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentModel } from '../../shared/agent';
import { ATTACHMENT_MAX_IMAGE_BYTES } from '../../shared/attachments';
import { ScriptedAgentProviderAdapter } from '../../testSupport/taskMonkiScenario';
import { FileTaskStore } from '../storage/FileTaskStore';
import { TaskManagerService } from './TaskManagerService';

describe('TaskManagerService attachments', () => {
  it('stages one bounded batch atomically through the public boundary', async () => {
    const dir = await temporaryDirectory();
    const store = new FileTaskStore(path.join(dir, 'store'));
    const service = new TaskManagerService(store, dir, undefined, {
      agentProviderAdapter: new ScriptedAgentProviderAdapter(store),
    });
    const draft = await service.stageTaskAttachmentBatch({ attachments: [
      batchFile('client-token-service-0001', 'notes.txt', 'same bytes'),
      batchFile('client-token-service-0002', 'context.json', '{"ok":true}')
    ] });

    expect(draft.attachments.map((item) => item.displayName)).toEqual([
      'notes.txt',
      'context.json'
    ]);
  });

  it('keeps the draft when an image is incompatible with the selected model', async () => {
    const dir = await temporaryDirectory();
    const store = new FileTaskStore(path.join(dir, 'store'));
    const adapter = new ScriptedAgentProviderAdapter(store);
    const service = new TaskManagerService(store, dir, undefined, {
      agentProviderAdapter: adapter,
    });
    const draft = await service.stageTaskAttachmentBatch({ attachments: [{
      clientToken: 'client-token-image-0001',
      displayName: 'screen.png',
      bytes: exactArrayBuffer(onePixelPng())
    }] });

    await expect(
      service.createTaskFromTrustedPath({
        title: 'Inspect screenshot',
        prompt: 'Use the attached screenshot.',
        repositoryPath: dir,
        agentSettings: { model: 'scenario-model' },
        attachmentDraftId: draft.id
      })
    ).rejects.toThrow('does not accept image attachments');

    await expect(store.listAttachmentDraft(draft.id)).resolves.toMatchObject({
      attachments: [expect.objectContaining({ displayName: 'screen.png' })]
    });
    expect((await store.snapshot()).tasks).toEqual([]);
  });

  it('adopts an image only after the provider reports image input support', async () => {
    const dir = await temporaryDirectory();
    const store = new FileTaskStore(path.join(dir, 'store'));
    const adapter = new ScriptedAgentProviderAdapter(store);
    vi.spyOn(adapter, 'listModels').mockResolvedValue([imageModel()]);
    const service = new TaskManagerService(store, dir, undefined, {
      agentProviderAdapter: adapter,
    });
    const draft = await service.stageTaskAttachmentBatch({ attachments: [{
      clientToken: 'client-token-image-0002',
      displayName: 'screen.png',
      bytes: exactArrayBuffer(onePixelPng())
    }] });
    const staged = draft.attachments[0]!;

    const task = await service.createTaskFromTrustedPath({
      title: 'Inspect screenshot',
      prompt: 'Use the attached screenshot.',
      repositoryPath: dir,
      agentSettings: { model: 'vision-model' },
      attachmentDraftId: draft.id
    });

    expect(await store.getTaskAttachments(task.id)).toEqual([
      expect.objectContaining({ id: staged.id, taskId: task.id, kind: 'image' })
    ]);
    const content = await service.readTaskAttachment({ attachmentId: staged.id });
    expect(content.mediaType).toBe('image/png');
    expect(content.bytes.byteLength).toBe(onePixelPng().byteLength);
  });

  it('returns the acknowledged task when a lost response is retried after draft commit', async () => {
    const dir = await temporaryDirectory();
    const store = new FileTaskStore(path.join(dir, 'store'));
    const service = new TaskManagerService(store, dir, undefined, {
      agentProviderAdapter: new ScriptedAgentProviderAdapter(store),
    });
    const draft = await service.stageTaskAttachmentBatch({ attachments: [
      batchFile('client-token-create-retry-0001', 'context.json', '{"safe":true}')
    ] });
    const staged = draft.attachments[0]!;
    const request = {
      title: 'Retry task creation',
      prompt: 'Use the attached context.',
      repositoryPath: dir,
      creationToken: 'task-create-service-retry-0001',
      attachmentDraftId: draft.id
    };

    const created = await service.createTaskFromTrustedPath(request);
    await expect(store.listAttachmentDraft(draft.id)).rejects.toMatchObject({
      code: 'ATTACHMENT_DRAFT_NOT_FOUND'
    });
    const retried = await service.createTaskFromTrustedPath(request);

    expect(retried.id).toBe(created.id);
    const snapshot = await store.snapshot();
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.attachments).toEqual([
      expect.objectContaining({ id: staged.id, taskId: created.id })
    ]);
  });

  it('rejects malformed task creation retry tokens at the service boundary', async () => {
    const dir = await temporaryDirectory();
    const store = new FileTaskStore(path.join(dir, 'store'));
    const service = new TaskManagerService(store, dir, undefined, {
      agentProviderAdapter: new ScriptedAgentProviderAdapter(store),
    });

    await expect(
      service.createTaskFromTrustedPath({
        title: 'Invalid retry token',
        prompt: 'Do not create this task.',
        repositoryPath: dir,
        creationToken: 'short'
      })
    ).rejects.toMatchObject({
      code: 'TASK_CREATION_INVALID_REQUEST',
      httpStatus: 400
    });
    expect((await store.snapshot()).tasks).toEqual([]);
  });

  it('keeps the draft and task store unchanged when full access is selected', async () => {
    const dir = await temporaryDirectory();
    const store = new FileTaskStore(path.join(dir, 'store'));
    const service = new TaskManagerService(store, dir, undefined, {
      agentProviderAdapter: new ScriptedAgentProviderAdapter(store),
    });
    const draft = await service.stageTaskAttachmentBatch({ attachments: [
      batchFile('client-token-full-access-0001', 'notes.txt', 'private context')
    ] });

    await expect(
      service.createTaskFromTrustedPath({
        title: 'Network attachment boundary',
        prompt: 'Use the attachment.',
        repositoryPath: dir,
        agentSettings: { sandbox: 'WORKSPACE_WRITE', networkAccess: true },
        attachmentDraftId: draft.id
      })
    ).rejects.toThrow('Network access must be disabled');

    await expect(
      service.createTaskFromTrustedPath({
        title: 'Unsafe attachment boundary',
        prompt: 'Use the attachment.',
        repositoryPath: dir,
        agentSettings: { sandbox: 'DANGER_FULL_ACCESS' },
        attachmentDraftId: draft.id
      })
    ).rejects.toThrow('Full access cannot safely protect attachment copies');

    await expect(store.listAttachmentDraft(draft.id)).resolves.toMatchObject({
      attachments: [expect.objectContaining({ displayName: 'notes.txt' })]
    });
    expect((await store.snapshot()).tasks).toEqual([]);
  });

  it('rejects malformed and over-limit batch payloads before storage', async () => {
    const dir = await temporaryDirectory();
    const store = new FileTaskStore(path.join(dir, 'store'));
    const service = new TaskManagerService(store, dir, undefined, {
      agentProviderAdapter: new ScriptedAgentProviderAdapter(store),
    });
    await expect(
      service.stageTaskAttachmentBatch({ attachments: [{
        clientToken: 'client-token-invalid-001',
        displayName: 'notes.txt',
        bytes: new Uint8Array([1, 2, 3]) as unknown as ArrayBuffer
      }] })
    ).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID_REQUEST', httpStatus: 400 });
    await expect(
      service.stageTaskAttachmentBatch({ attachments: [{
        clientToken: 'client-token-large-0001',
        displayName: 'screen.png',
        bytes: new ArrayBuffer(ATTACHMENT_MAX_IMAGE_BYTES + 1)
      }] })
    ).rejects.toMatchObject({ code: 'ATTACHMENT_TOO_LARGE', httpStatus: 413 });
  });
});

async function temporaryDirectory(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-service-attachments-'));
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function batchFile(clientToken: string, displayName: string, content: string) {
  return {
    clientToken,
    displayName,
    bytes: exactArrayBuffer(new TextEncoder().encode(content))
  };
}

function onePixelPng(): Uint8Array {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
}

function imageModel(): AgentModel {
  return {
    id: 'vision-model',
    provider: 'codex',
    model: 'vision-model',
    displayName: 'Vision model',
    hidden: false,
    supportedReasoningEfforts: ['low'],
    defaultReasoningEffort: 'low',
    serviceTiers: [],
    inputModalities: ['text', 'image'],
    isDefault: true
  };
}
