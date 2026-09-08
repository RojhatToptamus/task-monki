import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentModel } from '../../shared/agent';
import {
  AgentAttachmentDeliveryError,
  assertAgentTurnAttachmentSelection,
  assertModelSupportsAttachments,
  toAgentAttachmentSelection,
  toAgentTurnAttachments,
  verifyAgentTurnAttachments,
  type AgentTurnAttachment
} from './AgentAttachmentDelivery';

describe('agent attachment delivery', () => {
  it('maps verified run copies without exposing their storage key', () => {
    const [mapped] = toAgentTurnAttachments(
      [{
        record: {
          id: 'attachment-1',
          taskId: 'task-1',
          ordinal: 0,
          displayName: 'data.json',
          kind: 'text',
          mediaType: 'application/json',
          byteCount: 2,
          sha256: 'a'.repeat(64),
          createdAt: '2026-07-10T00:00:00.000Z'
        },
        absolutePath: '/private/run-deliveries/run-1/000-file.json'
      }],
      '2026-07-10T01:00:00.000Z'
    );

    expect(mapped).toEqual({
      attachmentId: 'attachment-1',
      ordinal: 0,
      displayName: 'data.json',
      kind: 'text',
      mediaType: 'application/json',
      byteCount: 2,
      sha256: 'a'.repeat(64),
      path: '/private/run-deliveries/run-1/000-file.json',
      verifiedAt: '2026-07-10T01:00:00.000Z'
    });
    expect(mapped).not.toHaveProperty('storageKey');
  });

  it('requires the provider inputs to match the ordered durable selection', () => {
    const attachments = [attachment({ ordinal: 0 })];
    const selection = toAgentAttachmentSelection(attachments);
    expect(() =>
      assertAgentTurnAttachmentSelection(selection, attachments)
    ).not.toThrow();
    expect(() =>
      assertAgentTurnAttachmentSelection(selection, [
        attachment({ ordinal: 0, sha256: 'b'.repeat(64) })
      ])
    ).toThrow(AgentAttachmentDeliveryError);
  });

  it('rejects images for a text-only model without silently dropping them', () => {
    expect(() =>
      assertModelSupportsAttachments(model(['text']), [
        attachment({ kind: 'image', mediaType: 'image/png' })
      ])
    ).toThrow('does not accept image attachments');

    expect(() =>
      assertModelSupportsAttachments(model(['text', 'image']), [
        attachment({ kind: 'image', mediaType: 'image/png' })
      ])
    ).not.toThrow();
  });

  it('rechecks read-only managed bytes immediately before delivery', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-delivery-'));
    const filePath = path.join(directory, 'attachment.txt');
    const bytes = Buffer.from('verified attachment');
    await fs.writeFile(filePath, bytes, { mode: 0o400 });
    await setReadOnlyOnPosix(filePath);
    const candidate = attachment({
      path: filePath,
      byteCount: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex')
    });

    const [verified] = await verifyAgentTurnAttachments([candidate], {
      includeBytes: () => true
    });
    expect(verified?.verifiedAt).not.toBe(candidate.verifiedAt);
    expect(Buffer.from(verified?.bytes ?? []).toString('utf8')).toBe(
      'verified attachment'
    );
  });

  it.runIf(process.platform !== 'win32')(
    'rejects a managed attachment that becomes writable',
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-delivery-'));
      const filePath = path.join(directory, 'attachment.txt');
      const bytes = Buffer.from('verified attachment');
      await fs.writeFile(filePath, bytes, { mode: 0o400 });
      await fs.chmod(filePath, 0o600);
      const candidate = attachment({
        path: filePath,
        byteCount: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex')
      });

      await expect(verifyAgentTurnAttachments([candidate])).rejects.toMatchObject({
        code: 'ATTACHMENT_NOT_READ_ONLY'
      });
    }
  );

  it('fails closed when managed attachment bytes are missing or changed', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-delivery-'));
    const filePath = path.join(directory, 'attachment.txt');
    await fs.writeFile(filePath, 'changed', { mode: 0o400 });
    await setReadOnlyOnPosix(filePath);
    const candidate = attachment({
      path: filePath,
      byteCount: 7,
      sha256: 'b'.repeat(64)
    });

    await expect(verifyAgentTurnAttachments([candidate])).rejects.toMatchObject({
      code: 'ATTACHMENT_HASH_MISMATCH'
    });
    await fs.unlink(filePath);
    await expect(verifyAgentTurnAttachments([candidate])).rejects.toMatchObject({
      code: 'ATTACHMENT_MISSING'
    });
  });

  it('never follows a symbolic link at the provider boundary', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-delivery-'));
    const targetPath = path.join(directory, 'target.txt');
    const linkPath = path.join(directory, 'attachment.txt');
    const bytes = Buffer.from('linked attachment');
    await fs.writeFile(targetPath, bytes, { mode: 0o400 });
    await setReadOnlyOnPosix(targetPath);
    await fs.symlink(targetPath, linkPath);

    await expect(
      verifyAgentTurnAttachments([
        attachment({
          path: linkPath,
          byteCount: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex')
        })
      ])
    ).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_REGULAR' });
  });
});

async function setReadOnlyOnPosix(filePath: string): Promise<void> {
  if (process.platform !== 'win32') await fs.chmod(filePath, 0o400);
}

function attachment(
  overrides: Partial<AgentTurnAttachment> = {}
): AgentTurnAttachment {
  return {
    attachmentId: 'attachment-1',
    ordinal: 1,
    displayName: 'file.txt',
    kind: 'text',
    mediaType: 'text/plain',
    byteCount: 12,
    sha256: 'a'.repeat(64),
    path: '/managed/run-1/file.txt',
    verifiedAt: '2026-07-10T00:00:00.000Z',
    ...overrides
  };
}

function model(inputModalities: string[]): AgentModel {
  return {
    id: 'model-1',
    runtimeId: 'codex',
    modelProvider: 'openai',
    model: 'model-1',
    displayName: 'Model One',
    hidden: false,
    supportedReasoningEfforts: [],
    serviceTiers: [],
    inputModalities,
    isDefault: true
  };
}
