import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { VerifiedAgentTurnAttachment } from '../AgentAttachmentDelivery';
import {
  CODEX_ATTACHMENT_PROMPT_MARKER,
  prepareCodexAttachmentDelivery
} from './CodexAttachmentDelivery';

describe('Codex attachment delivery', () => {
  it('uses exact restricted file grants and sends selected images on every turn', () => {
    const text = attachment('text-1', 0, 'text', 'notes.txt');
    const image = attachment('image-1', 1, 'image', 'reference.png');
    const input = {
      prompt: 'Use both references.',
      sandbox: 'restricted' as const,
      attachments: [text, image]
    };

    const first = prepareCodexAttachmentDelivery(input);
    const later = prepareCodexAttachmentDelivery(input);

    expect(first.exactGrantPaths).toEqual([text.path, image.path]);
    expect(first.exactGrantPaths).not.toContain(path.dirname(text.path));
    expect(first.localImagePaths).toEqual([image.path]);
    expect(later.localImagePaths).toEqual([image.path]);
    expect(first.prompt).toContain(CODEX_ATTACHMENT_PROMPT_MARKER);
    expect(attachmentMetadata(first.prompt, text.attachmentId)).toMatchObject({
      readOnlyPath: text.path
    });
    expect(first.submissions).toEqual([
      expect.objectContaining({ attachmentId: text.attachmentId, transport: 'managed-path' }),
      expect.objectContaining({ attachmentId: image.attachmentId, transport: 'native-image' })
    ]);
  });

  it('uses native paths without adding a managed grant in Full access', () => {
    const text = attachment('text-1', 0, 'text', 'notes.txt');
    const image = attachment('image-1', 1, 'image', 'reference.png');
    const prepared = prepareCodexAttachmentDelivery({
      prompt: 'Use both.',
      sandbox: 'danger-full-access',
      attachments: [text, image]
    });

    expect(prepared.exactGrantPaths).toEqual([]);
    expect(prepared.localImagePaths).toEqual([image.path]);
    expect(attachmentMetadata(prepared.prompt, text.attachmentId)).toMatchObject({
      readOnlyPath: text.path
    });
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

function attachmentMetadata(
  prompt: string,
  attachmentId: string
): Record<string, unknown> {
  const prefix = 'Attachment metadata: ';
  const line = prompt
    .split('\n')
    .find(
      (candidate) =>
        candidate.startsWith(prefix) &&
        candidate.includes(`"attachmentId":"${attachmentId}"`)
    );
  if (!line) throw new Error(`Missing metadata for attachment ${attachmentId}.`);
  return JSON.parse(line.slice(prefix.length)) as Record<string, unknown>;
}
