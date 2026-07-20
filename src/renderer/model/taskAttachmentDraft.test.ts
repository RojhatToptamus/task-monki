import { describe, expect, it, vi } from 'vitest';
import {
  admitAttachmentFiles,
  createAttachmentClientToken,
  formatAttachmentBytes,
  modelAcceptsImageAttachments,
  prepareImageAttachment
} from './taskAttachmentDraft';

describe('task attachment draft model', () => {
  it('admits only bounded allowlisted files', () => {
    const files = [
      candidate('notes.md', 20),
      candidate('archive.zip', 20),
      candidate('large.txt', 3 * 1024 * 1024)
    ];
    const result = admitAttachmentFiles(files, { count: 0, byteCount: 0 });

    expect(result.admitted.map(({ file }) => file.name)).toEqual(['notes.md']);
    expect(result.rejected.map(({ file }) => file.name)).toEqual([
      'archive.zip',
      'large.txt'
    ]);
  });

  it('normalizes an image and closes decoder resources', async () => {
    const close = vi.fn();
    const encode = vi.fn(async () => new Blob(['normalized'], { type: 'image/png' }));
    const preview = vi.fn(async () => new Blob(['preview'], { type: 'image/png' }));
    const file = new File([new Uint8Array([1])], 'screen.png', { type: 'image/png' });

    const prepared = await prepareImageAttachment(file, async () => ({
      width: 100,
      height: 80,
      encode,
      encodePreview: preview,
      close
    }));

    expect(prepared.file.name).toBe('screen.png');
    expect(prepared.file.type).toBe('image/png');
    expect(prepared.preview?.type).toBe('image/png');
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects unsafe decoded dimensions before encoding', async () => {
    const close = vi.fn();
    await expect(
      prepareImageAttachment(
        new File([new Uint8Array([1])], 'screen.png', { type: 'image/png' }),
        async () => ({
          width: 100_000,
          height: 100_000,
          encode: vi.fn(),
          close
        })
      )
    ).rejects.toThrow('16 megapixel');
    expect(close).toHaveBeenCalledOnce();
  });

  it('creates validated tokens and formats byte counts', () => {
    expect(createAttachmentClientToken(() => 'client-token-renderer-0001')).toBe(
      'client-token-renderer-0001'
    );
    expect(() => createAttachmentClientToken(() => '../bad')).toThrow('unavailable');
    expect(formatAttachmentBytes(512)).toBe('512 B');
    expect(formatAttachmentBytes(1024)).toBe('1 KB');
    expect(formatAttachmentBytes(2 * 1024 * 1024)).toBe('2 MB');
  });

  it('checks image capability from model input modalities', () => {
    expect(modelAcceptsImageAttachments(undefined)).toBe(false);
    expect(modelAcceptsImageAttachments(model(['text']))).toBe(false);
    expect(modelAcceptsImageAttachments(model(['text', 'image']))).toBe(true);
  });
});

function candidate(name: string, size: number) {
  return {
    name,
    size,
    type: '',
    arrayBuffer: async () => new ArrayBuffer(size)
  };
}

function model(inputModalities: string[]) {
  return {
    id: 'model',
    runtimeId: 'codex',
    modelProvider: 'openai',
    model: 'model',
    displayName: 'Model',
    hidden: false,
    isDefault: true,
    supportedReasoningEfforts: [],
    serviceTiers: [],
    inputModalities
  };
}
