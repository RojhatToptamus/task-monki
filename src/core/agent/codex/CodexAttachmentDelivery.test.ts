import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { VerifiedAgentTurnAttachment } from '../AgentAttachmentDelivery';
import {
  CODEX_ATTACHMENT_PROMPT_MARKER,
  CODEX_ATTACHMENT_WIRE_MAX_BYTES,
  assertCodexInlineRequestSize,
  codexAttachmentSupport,
  prepareCodexAttachmentDelivery
} from './CodexAttachmentDelivery';

describe('Codex attachment delivery', () => {
  it('qualifies exact files and restricted images only for tested App Server versions', () => {
    expect(codexAttachmentSupport(undefined)).toEqual({
      exactFileAccess: false,
      restrictedLocalImages: false
    });
    expect(codexAttachmentSupport('0.140.9')).toEqual({
      exactFileAccess: false,
      restrictedLocalImages: false
    });
    expect(codexAttachmentSupport('0.141.0')).toEqual({
      exactFileAccess: true,
      restrictedLocalImages: true
    });
  });

  it('uses exact restricted file grants and sends selected images on every turn', () => {
    const text = attachment('text-1', 0, 'text', 'notes.txt');
    const image = attachment('image-1', 1, 'image', 'reference.png');
    const input = {
      prompt: 'Use both references.',
      sandbox: 'restricted' as const,
      attachments: [text, image],
      support: codexAttachmentSupport('0.141.0')
    };

    const first = prepareCodexAttachmentDelivery(input);
    const later = prepareCodexAttachmentDelivery(input);

    expect(first.exactGrantPaths).toEqual([text.path, image.path]);
    expect(first.exactGrantPaths).not.toContain(path.dirname(text.path));
    expect(first.localImagePaths).toEqual([image.path]);
    expect(later.localImagePaths).toEqual([image.path]);
    expect(first.prompt).toContain(CODEX_ATTACHMENT_PROMPT_MARKER);
    expect(first.prompt).toContain(text.path);
    expect(first.submissions).toEqual([
      expect.objectContaining({ attachmentId: text.attachmentId, transport: 'managed-path' }),
      expect.objectContaining({ attachmentId: image.attachmentId, transport: 'native-image' })
    ]);
  });

  it('falls back to verified inline text without widening restricted filesystem access', () => {
    const text = {
      ...attachment('text-1', 0, 'text', 'notes.txt'),
      bytes: Buffer.from('verified reference text', 'utf8')
    };
    const prepared = prepareCodexAttachmentDelivery({
      prompt: 'Summarize it.',
      sandbox: 'restricted',
      attachments: [text],
      support: codexAttachmentSupport('0.140.9')
    });

    expect(prepared.exactGrantPaths).toEqual([]);
    expect(prepared.localImagePaths).toEqual([]);
    expect(prepared.hasInlineText).toBe(true);
    expect(prepared.prompt).toContain('verified reference text');
    expect(prepared.prompt).not.toContain(text.path);
    expect(prepared.submissions).toEqual([
      expect.objectContaining({ attachmentId: text.attachmentId, transport: 'text-block' })
    ]);
  });

  it('fails before submission when an older restricted runtime cannot deliver images', () => {
    expect(() =>
      prepareCodexAttachmentDelivery({
        prompt: 'Inspect it.',
        sandbox: 'restricted',
        attachments: [attachment('image-1', 0, 'image', 'reference.png')],
        support: codexAttachmentSupport('0.140.9')
      })
    ).toThrow('cannot safely deliver images');
  });

  it('uses native paths without adding a managed grant in Full access', () => {
    const text = attachment('text-1', 0, 'text', 'notes.txt');
    const image = attachment('image-1', 1, 'image', 'reference.png');
    const prepared = prepareCodexAttachmentDelivery({
      prompt: 'Use both.',
      sandbox: 'danger-full-access',
      attachments: [text, image],
      support: codexAttachmentSupport(undefined)
    });

    expect(prepared.exactGrantPaths).toEqual([]);
    expect(prepared.localImagePaths).toEqual([image.path]);
    expect(prepared.prompt).toContain(text.path);
  });

  it('rejects a complete inline request above the Codex wire limit', () => {
    expect(() => assertCodexInlineRequestSize({ prompt: 'small' })).not.toThrow();
    expect(() =>
      assertCodexInlineRequestSize({
        prompt: 'x'.repeat(CODEX_ATTACHMENT_WIRE_MAX_BYTES)
      })
    ).toThrow('above');
  });
});

function attachment(
  attachmentId: string,
  ordinal: number,
  kind: 'image' | 'text',
  displayName: string
): VerifiedAgentTurnAttachment {
  return {
    attachmentId,
    ordinal,
    displayName,
    kind,
    mediaType: kind === 'image' ? 'image/png' : 'text/plain',
    byteCount: 12,
    sha256: 'a'.repeat(64),
    path: path.join(
      path.parse(process.cwd()).root,
      'task-monki',
      'attachments',
      'tasks',
      'task-1',
      displayName
    ),
    verifiedAt: '2026-08-29T10:00:00.000Z'
  };
}
