import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DiscourseConversationAggregateRecord, DiscourseResponseWaveRecord } from '../../shared/discourse';
import { DiscourseResponseGroup } from './DiscourseResponseGroup';

describe('Discourse response lifecycle', () => {
  it('keeps a completed turn quiet rather than declaring the user decision resolved', () => {
    const wave = { id: 'wave', policy: 'CHAT', status: 'SETTLED', outcome: 'COMPLETE',
      dispatchGate: { status: 'READY' } } as DiscourseResponseWaveRecord;
    const aggregate = { waves: [wave], jobs: [], concerns: [] } as unknown as DiscourseConversationAggregateRecord;
    const view = render(<DiscourseResponseGroup wave={wave} aggregate={aggregate} streamDrafts={{}}
      onRetry={vi.fn()} onConfirm={vi.fn()} onStop={vi.fn()} />);
    expect(view.container.textContent).toBe('');
  });

  it('offers Stop during a peer check without displaying its structured control field', () => {
    const wave = { id: 'wave', policy: 'CHAT', status: 'RUNNING', dispatchGate: { status: 'READY' } } as DiscourseResponseWaveRecord;
    const aggregate = { waves: [wave], concerns: [], jobs: [{ id: 'peer', waveId: 'wave', role: 'ANSWER',
      status: 'RUNNING', assignment: { displayNameSnapshot: 'B', assignmentRole: 'REVIEWER' } }] } as unknown as DiscourseConversationAggregateRecord;
    const stop = vi.fn();
    render(<DiscourseResponseGroup wave={wave} aggregate={aggregate}
      streamDrafts={{ peer: '{"message":"A, consider this","requestAuthorResponse":true}' }}
      onRetry={vi.fn()} onConfirm={vi.fn()} onStop={stop} />);
    expect(screen.getByRole('status').textContent).toContain('B');
    expect(screen.queryByText(/requestAuthorResponse/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(stop).toHaveBeenCalledWith('wave');
  });

  it('requires explicit confirmation after context changes and keeps cancellation available', () => {
    const wave = { id: 'wave', policy: 'CHAT', status: 'PLANNED',
      dispatchGate: { status: 'RECONFIRMATION_REQUIRED' } } as DiscourseResponseWaveRecord;
    const aggregate = { waves: [wave], concerns: [], jobs: [] } as unknown as DiscourseConversationAggregateRecord;
    const confirm = vi.fn(), stop = vi.fn();
    render(<DiscourseResponseGroup wave={wave} aggregate={aggregate} streamDrafts={{}}
      onRetry={vi.fn()} onConfirm={confirm} onStop={stop} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use updated context' }));
    expect(confirm).toHaveBeenCalledWith('wave');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(stop).toHaveBeenCalledWith('wave');
  });
});
