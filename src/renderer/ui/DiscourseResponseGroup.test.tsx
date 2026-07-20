import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type {
  DiscourseAgentJobRecord,
  DiscourseConversationAggregateRecord,
  DiscourseResponseWaveRecord
} from '../../shared/discourse';
import { DiscourseResponseGroup } from './DiscourseResponseGroup';

describe('DiscourseResponseGroup', () => {
  it('presents an acknowledged stop without offering duplicate cancellation', () => {
    const wave = {
      id: 'wave-1',
      policy: 'DIRECT',
      status: 'STOPPING',
      assignments: [{ displayNameSnapshot: 'Lead' }],
      dispatchGate: {
        status: 'READY',
        previewFingerprint: 'preview-1',
        confirmedAtRevision: 1
      }
    } as DiscourseResponseWaveRecord;
    const job = {
      id: 'job-1',
      waveId: wave.id,
      role: 'ANSWER',
      status: 'CANCEL_REQUESTED',
      assignment: { displayNameSnapshot: 'Lead', model: 'gpt-test' }
    } as DiscourseAgentJobRecord;
    const aggregate = {
      waves: [wave],
      jobs: [job],
      concerns: []
    } as unknown as DiscourseConversationAggregateRecord;

    const html = renderToStaticMarkup(
      <DiscourseResponseGroup
        aggregate={aggregate}
        wave={wave}
        streamDrafts={{}}
        onStop={vi.fn()}
        onConfirm={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    expect(html).toContain('tm-discourse-response--working');
    expect(html).toContain('Stopping response');
    expect(html).toContain('<button type="button" disabled="">Stopping…</button>');
    expect(html).not.toContain('>Stop</button>');
  });
});
