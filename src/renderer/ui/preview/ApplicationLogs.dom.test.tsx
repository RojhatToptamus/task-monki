import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { PreviewStatus } from 'previewhost';
import { ApplicationLogs } from './ApplicationLogs';

const api = vi.hoisted(() => ({
  inspectApplicationPreviewConfiguration: vi.fn(),
  readApplicationPreviewLogs: vi.fn()
}));
vi.mock('../../api/taskManagerClient', () => ({ taskManagerApi: api }));

const status: PreviewStatus = {
  name: 'fixture',
  busy: false,
  active: {
    id: 'serving',
    type: 'environment',
    state: 'ready',
    startedAt: '2026-10-08T12:00:00Z',
    sources: ['/fixture'],
    services: {
      api: { type: 'command', state: 'ready' },
      web: { type: 'command', state: 'ready' }
    }
  }
} as PreviewStatus;

beforeEach(() => {
  vi.resetAllMocks();
  api.inspectApplicationPreviewConfiguration.mockRejectedValue(new Error('unavailable'));
  api.readApplicationPreviewLogs.mockResolvedValue({
    text: '[api] listening on 4000\n[web] Ready in 2s\n',
    cursor: 40,
    truncated: false
  });
});

it('searches split panes as one list in reading order, including the status markers people see', async () => {
  render(<ApplicationLogs taskId="task" status={status} onSelect={() => undefined} />);
  await screen.findByText('listening on 4000');
  fireEvent.click(screen.getByRole('button', { name: 'Side by side' }));
  const apiPane = screen.getByRole('region', { name: 'api log pane' });
  const webPane = screen.getByRole('region', { name: 'web log pane' });
  const search = screen.getByLabelText('Search logs');
  fireEvent.change(search, { target: { value: 'ready' } });
  // "api ready" and "web ready" are markers; "Ready in 2s" is output.
  expect(screen.getByText('0 of 3')).toBeTruthy();
  expect(apiPane.querySelectorAll('mark')).toHaveLength(1);
  expect(webPane.querySelectorAll('mark')).toHaveLength(2);
  const current = () => document.querySelector('[data-current-match="true"]');
  fireEvent.keyDown(search, { key: 'Enter' });
  expect(screen.getByText('1 of 3')).toBeTruthy();
  expect(apiPane.contains(current())).toBe(true);
  fireEvent.keyDown(search, { key: 'Enter' });
  expect(webPane.contains(current())).toBe(true);
  expect(current()!.closest('.tm-preview-log-marker')).not.toBeNull();
  fireEvent.keyDown(search, { key: 'Enter' });
  expect(screen.getByText('3 of 3')).toBeTruthy();
  expect(current()!.textContent).toBe('Ready');
  expect(document.querySelectorAll('[data-current-match="true"]')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Matches only' }));
  expect(within(apiPane).queryByText('listening on 4000')).toBeNull();
  expect(apiPane.textContent).toContain('api ready');
  expect(webPane.textContent).toContain('Ready in 2s');
});
