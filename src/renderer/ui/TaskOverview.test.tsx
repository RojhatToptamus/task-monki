import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { TaskAttachmentRecord } from '../../shared/attachments';
import { OverviewRequest } from './TaskOverview';

describe('Overview request', () => {
  it('shows durable attachment metadata without active or internal-path previews', () => {
    const attachments: TaskAttachmentRecord[] = [
      attachment({
        id: 'attachment-image',
        ordinal: 0,
        displayName: 'reference.png',
        kind: 'image',
        mediaType: 'image/png',
        byteCount: 1024 * 1024
      }),
      attachment({
        id: 'attachment-svg',
        ordinal: 1,
        displayName: '<unsafe>.svg',
        kind: 'text',
        mediaType: 'image/svg+xml',
        byteCount: 42 * 1024
      })
    ];

    const html = renderToStaticMarkup(
      <OverviewRequest prompt="Implement the task." attachments={attachments} />
    );

    expect(html).toContain('aria-label="Task attachments"');
    expect(html).toContain('reference.png');
    expect(html).toContain('&lt;unsafe&gt;.svg');
    // Kind and size are separate facts, not a dot-joined label.
    expect(html).toContain('<span>Image</span><span>1 MB</span>');
    expect(html).toContain('<span>Text</span><span>42 KB</span>');
    expect(html).toContain('Implement the task.');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<object');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('sha-image');
  });
});

function attachment(
  input: Pick<
    TaskAttachmentRecord,
    'id' | 'ordinal' | 'displayName' | 'kind' | 'mediaType' | 'byteCount'
  >
): TaskAttachmentRecord {
  return {
    ...input,
    taskId: 'task-1',
    sha256: `sha-${input.kind}`,
    createdAt: '2026-07-10T00:00:00.000Z'
  };
}
