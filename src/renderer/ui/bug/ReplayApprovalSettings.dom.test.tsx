import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BugReplayKeptApproval } from '../../../shared/bugReplay';
import { taskManagerApi } from '../../api/taskManagerClient';
import { ReplayApprovalSettings } from './ReplayApprovalSettings';

vi.mock('../../api/taskManagerClient', () => ({
  taskManagerApi: { listBugReplayApprovals: vi.fn(), revokeBugReplayApproval: vi.fn() }
}));

const kept: BugReplayKeptApproval = {
  id: '7f4c1a52-0d6e-4b8a-9c3f-2e1d5a6b7c8d',
  repositoryId: 'repository-1',
  repositoryName: 'checkout-shop',
  commands: [
    { service: 'install', command: 'npm ci --no-audit --no-fund', directory: '.' },
    { service: 'web', command: 'node server.js', directory: '.' }
  ],
  envFiles: ['.env'],
  calls: ['https://api.example.com'],
  keptAt: new Date().toISOString()
};

describe('Replay approvals in Settings', () => {
  it('lists what each repository keeps approved and revokes one from its row, keeping focus in the list', async () => {
    vi.mocked(taskManagerApi.listBugReplayApprovals).mockResolvedValue([kept]);
    vi.mocked(taskManagerApi.revokeBugReplayApproval).mockResolvedValue([]);
    render(<ReplayApprovalSettings />);

    const table = await screen.findByRole('table');
    const [repository, runs] = within(table).getAllByRole('cell');
    expect(repository.textContent).toBe('checkout-shop');
    // The recipe's own command identifies it, with what else replays get; the install Task Monki
    // adds reads the same in every repository.
    for (const shown of ['node server.js', '.env', 'https://api.example.com']) expect(within(runs).getByText(shown)).toBeDefined();
    expect(within(runs).queryByText('npm ci --no-audit --no-fund')).toBeNull();

    fireEvent.keyDown(screen.getByRole('button', { name: 'Actions for checkout-shop, node server.js, .env, https://api.example.com' }), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Revoke approval' }));

    await waitFor(() => expect(taskManagerApi.revokeBugReplayApproval).toHaveBeenCalledWith({ approvalId: kept.id }));
    expect(await screen.findByText('No replay approvals')).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
    expect(document.activeElement?.contains(screen.getByText('No replay approvals'))).toBe(true);
  });
});
