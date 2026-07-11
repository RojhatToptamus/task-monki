import { describe, expect, it } from 'vitest';
import { ATTACHMENT_MAX_IMAGE_BYTES } from '../shared/attachments';
import {
  AttachmentIpcLimitError,
  AttachmentIpcOperationGate,
  assertAttachmentIpcBatch
} from './attachmentIpcSecurity';

describe('attachment IPC security', () => {
  it('rejects malformed and oversized renderer payloads before invoking IPC', () => {
    expect(() =>
      assertAttachmentIpcBatch({ attachments: [{
        clientToken: '../unsafe', displayName: 'notes.txt', bytes: new ArrayBuffer(1)
      }] })
    ).toThrow('invalid');
    expect(() =>
      assertAttachmentIpcBatch({ attachments: [{
        clientToken: 'client-token-invalid-001', displayName: 'notes.txt',
        bytes: new Uint8Array([1]) as unknown as ArrayBuffer
      }] })
    ).toThrow('invalid');
    expect(() =>
      assertAttachmentIpcBatch({ attachments: [{
        clientToken: 'client-token-large-0001', displayName: 'screen.png',
        bytes: new ArrayBuffer(ATTACHMENT_MAX_IMAGE_BYTES + 1)
      }] })
    ).toThrow('too large');
  });

  it('bounds concurrent attachment operations and releases capacity', async () => {
    const gate = new AttachmentIpcOperationGate();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = gate.run(ATTACHMENT_MAX_IMAGE_BYTES, () => blocked);
    const second = gate.run(ATTACHMENT_MAX_IMAGE_BYTES, () => blocked);
    await expect(gate.run(1, async () => undefined)).rejects.toBeInstanceOf(
      AttachmentIpcLimitError
    );
    release();
    await Promise.all([first, second]);
    await expect(gate.run(1, async () => 'ok')).resolves.toBe('ok');
  });
});
