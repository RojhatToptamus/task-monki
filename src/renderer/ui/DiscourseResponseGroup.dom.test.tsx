import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DiscourseConversationAggregateRecord, DiscourseResponseWaveRecord } from '../../shared/discourse';
import { DiscourseResponseGroup } from './DiscourseResponseGroup';
import { taskManagerApi } from '../api/taskManagerClient';

vi.mock('../api/taskManagerClient', () => ({ taskManagerApi: { readArtifact: vi.fn() } }));

describe('Discourse response lifecycle', () => {
  it('keeps a completed turn quiet rather than declaring the user decision resolved', () => {
    const wave = { id: 'wave', policy: 'CHAT', status: 'SETTLED', outcome: 'COMPLETE',
      dispatchGate: { status: 'READY' } } as DiscourseResponseWaveRecord;
    const aggregate = { waves: [wave], jobs: [], concerns: [] } as unknown as DiscourseConversationAggregateRecord;
    const view = render(<DiscourseResponseGroup wave={wave} aggregate={aggregate} streamDrafts={{}}
      onRetry={vi.fn()} onConfirm={vi.fn()} onStop={vi.fn()} />);
    expect(view.container.textContent).toBe('');
  });

  it('keeps peer control fields private and leaves Stop to the composer', () => {
    const wave = { id: 'wave', policy: 'CHAT', status: 'RUNNING', dispatchGate: { status: 'READY' } } as DiscourseResponseWaveRecord;
    const aggregate = { waves: [wave], concerns: [], jobs: [{ id: 'peer', waveId: 'wave', role: 'ANSWER',
      status: 'RUNNING', assignment: { displayNameSnapshot: 'B', assignmentRole: 'REVIEWER' } }] } as unknown as DiscourseConversationAggregateRecord;
    const stop = vi.fn();
    render(<DiscourseResponseGroup wave={wave} aggregate={aggregate}
      streamDrafts={{ peer: '{"message":"A, consider this","requestAuthorResponse":true}' }}
      onRetry={vi.fn()} onConfirm={vi.fn()} onStop={stop} />);
    expect(screen.getByRole('status').textContent).toContain('Checking answer');
    expect(screen.getByText('B')).toBeTruthy();
    expect(screen.queryByText(/requestAuthorResponse/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(stop).not.toHaveBeenCalled();
  });

  it('restores stopped partial output without presenting it as a completed answer', async () => {
    vi.mocked(taskManagerApi.readArtifact).mockResolvedValue('First, make cancellation idempotent.');
    const wave = { id: 'wave', policy: 'CHAT', status: 'SETTLED', outcome: 'CANCELED', settlementReason: 'STOPPED',
      dispatchGate: { status: 'READY' } } as DiscourseResponseWaveRecord;
    const aggregate = { waves: [wave], concerns: [], jobs: [{ id: 'main', waveId: 'wave', role: 'ANSWER',
      status: 'CANCELED', outputArtifactId: 'partial', assignment: { model: 'gpt-6-astra', assignmentRole: 'PRIMARY' } },
      { id: 'unstarted', waveId: 'wave', role: 'ANSWER', status: 'CANCELED',
        assignment: { model: 'grok', assignmentRole: 'PRIMARY' } }] } as unknown as DiscourseConversationAggregateRecord;
    const retry = vi.fn();
    render(<DiscourseResponseGroup wave={wave} aggregate={aggregate} streamDrafts={{}} onRetry={retry} onConfirm={vi.fn()} onStop={vi.fn()} />);
    await screen.findByText('First, make cancellation idempotent.');
    expect(screen.getByText(/not a completed answer/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ask again' }));
    expect(retry).toHaveBeenCalledWith('wave');
    expect(taskManagerApi.readArtifact).toHaveBeenCalledWith({ artifactId: 'partial' });
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
