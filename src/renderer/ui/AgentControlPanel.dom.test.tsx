import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { makeRunRecord } from '../../testSupport/rendererRecords';
import { AgentControlPanel } from './AgentControlPanel';

describe('AgentControlPanel actions', () => {
  it('submits retry and fork controls with their distinct strategies', async () => {
    const onRetry = vi.fn().mockResolvedValue(undefined);
    const callbacks = {
      interactions: [],
      onSteer: vi.fn(),
      onInterrupt: vi.fn(),
      onContinue: vi.fn(),
      onRetry
    };
    const failedRun = makeRunRecord({
      status: 'FAILED',
      endedAt: '2026-07-19T12:01:00.000Z'
    });
    const first = render(<AgentControlPanel run={failedRun} {...callbacks} />);

    fireEvent.click(screen.getByRole('button', { name: 'Retry implementation' }));
    const retryButtons = screen.getAllByRole('button', { name: 'Retry implementation' });
    fireEvent.click(retryButtons.at(-1)!);
    await waitFor(() => expect(onRetry).toHaveBeenCalledWith('run-1', 'SAME_SESSION', undefined));

    first.unmount();
    onRetry.mockClear();
    render(
      <AgentControlPanel
        run={makeRunRecord({
          id: 'run-2',
          status: 'COMPLETED',
          endedAt: '2026-07-19T12:01:00.000Z'
        })}
        {...callbacks}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Fork alternative' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start alternative' }));
    await waitFor(() => expect(onRetry).toHaveBeenCalledWith('run-2', 'FORK', undefined));
  });
});
