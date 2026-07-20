import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DiscourseContextPreview } from '../../shared/discourse';
import { ContextPreview } from './DiscourseOverlays';

describe('Discourse context preview', () => {
  it('describes the user-visible context boundary without exposing internal fingerprints', () => {
    const preview = {
      fingerprint: 'private-internal-fingerprint',
      expiresAt: '2026-07-20T10:00:00.000Z',
      references: [],
      deduplicatedRepositoryIds: [],
      filesystemRootCount: 0,
      metadataOnly: true,
      policy: {
        filesystem: 'READ_ONLY',
        writes: false,
        network: false,
        externalTools: false,
        approvals: 'NEVER'
      },
      exclusions: []
    } satisfies DiscourseContextPreview;
    const html = renderToStaticMarkup(<ContextPreview preview={preview} onClose={vi.fn()} />);

    expect(html).toContain('Preview for this message');
    expect(html).toContain('Context preview');
    expect(html).not.toContain('private-internal-fingerprint');
    expect(html).not.toContain('Provisional context manifest');
  });
});
