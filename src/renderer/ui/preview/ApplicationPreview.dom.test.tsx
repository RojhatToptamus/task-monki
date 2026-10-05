import {
  act,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type {
  ConfigurationBindingsInspection,
  PreviewStatus,
  LogResult
} from 'previewhost';
import type {
  ApplicationPreviewSnapshot,
  PreviewSecretsApi
} from '../../../shared/applicationPreview';
import { ApplicationConfiguration } from './ApplicationConfiguration';
import { ApplicationActivity } from './ApplicationActivity';
import { ApplicationLogs } from './ApplicationLogs';
import { PreviewSecretsSettings } from './PreviewSecretsSettings';
import { ApplicationPreviewPanel } from './ApplicationPreviewPanel';

const api = vi.hoisted(() => ({
  getApplicationPreview: vi.fn(),
  startApplicationPreview: vi.fn(),
  approveApplicationPreview: vi.fn(),
  inspectApplicationPreviewConfiguration: vi.fn(),
  applyApplicationPreviewConfiguration: vi.fn(),
  readApplicationPreviewLogs: vi.fn()
}));
vi.mock('../../api/taskManagerClient', () => ({ taskManagerApi: api }));
const initial: PreviewStatus = {
  name: 'fixture',
  busy: false,
  active: {
    id: 'serving',
    type: 'command',
    state: 'ready',
    startedAt: '',
    sources: ['/fixture']
  }
};
const inspected: ConfigurationBindingsInspection = {
  description: {
    spec: {
      name: 'fixture',
      type: 'command',
      cwd: '/fixture',
      command: ['node', 'server.js'],
      readyPath: '/',
      timeoutMs: 1000
    },
    envKeys: ['TOKEN'],
    source: 'caller-owned-live-directory',
    cleanup: 'owned-process-group'
  },
  bindings: [{ key: 'TOKEN', value: null }]
};
beforeEach(() => vi.resetAllMocks());

it('reviews an existing configuration before its first start and requires explicit approval', async () => {
  let snapshot: ApplicationPreviewSnapshot = {
    name: 'fixture',
    projectDirectory: '/fixture',
    hasConfigurationFile: true
  };
  api.getApplicationPreview.mockImplementation(async () => snapshot);
  api.startApplicationPreview.mockImplementation(async () => {
    snapshot = {
      ...snapshot,
      status: {
        name: 'fixture',
        busy: false,
        candidate: { ...initial.active!, id: 'pending', state: 'starting' }
      },
      approval: { attemptId: 'pending', description: inspected.description }
    };
    return snapshot;
  });
  api.approveApplicationPreview.mockResolvedValue(undefined);
  render(<ApplicationPreviewPanel taskId="task" />);
  await screen.findByRole('button', { name: 'Start' });
  fireEvent.click(screen.getByRole('tab', { name: 'Configuration' }));
  expect(
    screen.getByRole('heading', { name: 'Configuration ready' })
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Review and start' }));
  await screen.findByRole('dialog', { name: 'Review and start' });
  expect(api.startApplicationPreview).toHaveBeenCalledWith({
    taskId: 'task',
    source: 'file'
  });
  expect(api.approveApplicationPreview).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Approve and start' }));
  await waitFor(() =>
    expect(api.approveApplicationPreview).toHaveBeenCalledWith({
      taskId: 'task',
      attemptId: 'pending'
    })
  );
});

it('shows current retained data after restart and deletion without duplicating services', () => {
  const status: PreviewStatus = {
    name: 'fixture',
    busy: false,
    latest: { ...initial.active!, type: 'environment', state: 'stopped' },
    data: {
      resources: [{ name: 'database', type: 'postgres' }],
      running: false
    }
  };
  const props = {
    busy: false,
    onLogs: vi.fn(),
    onRerun: vi.fn(),
    onConfigure: vi.fn()
  };
  const view = render(<ApplicationActivity {...props} status={status} />);
  expect(screen.getByRole('region', { name: 'Retained data' })).toBeTruthy();
  expect(screen.getByText('database')).toBeTruthy();
  view.rerender(
    <ApplicationActivity
      {...props}
      status={{
        ...status,
        active: {
          ...initial.active!,
          type: 'environment',
          services: { database: { type: 'postgres', state: 'ready' } }
        },
        latest: undefined
      }}
    />
  );
  expect(screen.queryByRole('region', { name: 'Retained data' })).toBeNull();
  expect(screen.getAllByText('database')).toHaveLength(1);
  expect(screen.getByText('Data retained')).toBeTruthy();
  view.rerender(
    <ApplicationActivity
      {...props}
      status={{
        ...status,
        data: undefined,
        latest: {
          ...status.latest!,
          services: { database: { type: 'postgres', state: 'stopped' } }
        }
      }}
    />
  );
  expect(screen.queryByText('Data retained')).toBeNull();
});

it('leaves hidden values unchanged and retains edits when a replacement fails', async () => {
  api.inspectApplicationPreviewConfiguration.mockResolvedValue(inspected);
  const view = render(
    <ApplicationConfiguration
      taskId="task"
      status={initial}
      onChanged={() => undefined}
    />
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save edit' }));
  expect(api.inspectApplicationPreviewConfiguration).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('New value'), {
    target: { value: 'ordinary local value' }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save edit' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  const candidate = {
    ...initial.active!,
    id: 'candidate',
    state: 'starting' as const
  };
  api.applyApplicationPreviewConfiguration.mockResolvedValue({
    status: { ...initial, candidate }
  });
  fireEvent.click(screen.getByRole('button', { name: 'Review and apply' }));
  await waitFor(() =>
    expect(api.applyApplicationPreviewConfiguration).toHaveBeenCalledTimes(1)
  );
  view.rerender(
    <ApplicationConfiguration
      taskId="task"
      status={{
        ...initial,
        latest: {
          ...candidate,
          state: 'failed',
          error: { code: 'START_FAILED', message: 'Local migration failed' }
        }
      }}
      onChanged={() => undefined}
    />
  );
  await screen.findByText('Local migration failed');
  expect(
    (screen.getByLabelText('Configuration attempt') as HTMLSelectElement).value
  ).toBe('serving');
  expect(
    (
      screen.getByRole('button', {
        name: 'Review and apply'
      }) as HTMLButtonElement
    ).disabled
  ).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Review and apply' }));
  await waitFor(() =>
    expect(api.applyApplicationPreviewConfiguration).toHaveBeenCalledTimes(2)
  );
  expect(screen.queryByText('Local migration failed')).toBeNull();
});

it('ignores late logs, preserves clear-view cursors across hidden tabs, and releases its reader on unmount', async () => {
  let resolveOld!: (result: LogResult) => void;
  api.readApplicationPreviewLogs.mockImplementationOnce(
    () =>
      new Promise<LogResult>((resolve) => {
        resolveOld = resolve;
      })
  );
  api.readApplicationPreviewLogs.mockResolvedValue({
    name: 'fixture',
    attemptId: 'latest',
    text: 'new output',
    cursor: 2,
    truncated: false
  });
  const view = render(
    <ApplicationLogs
      taskId="task"
      status={initial}
      selection={{ attemptId: 'serving' }}
      onSelect={() => undefined}
    />
  );
  await waitFor(() =>
    expect(api.readApplicationPreviewLogs).toHaveBeenCalledTimes(1)
  );
  view.rerender(
    <ApplicationLogs
      taskId="task"
      status={initial}
      selection={{ attemptId: 'latest' }}
      onSelect={() => undefined}
    />
  );
  await screen.findByText('new output');
  await act(async () =>
    resolveOld({
      name: 'fixture',
      attemptId: 'serving',
      text: 'wrong old output',
      cursor: 1,
      truncated: false
    })
  );
  expect(screen.queryByText('wrong old output')).toBeNull();
  fireEvent.keyDown(screen.getByRole('button', { name: 'Log actions' }), {
    key: 'Enter'
  });
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Clear view' }));
  fireEvent.change(screen.getByLabelText('Search logs'), {
    target: { value: 'keep filter' }
  });
  view.rerender(
    <ApplicationLogs
      taskId="task"
      status={initial}
      selection={{ attemptId: 'latest' }}
      onSelect={() => undefined}
      active={false}
    />
  );
  fireEvent(document, new Event('visibilitychange'));
  expect(api.readApplicationPreviewLogs).toHaveBeenCalledTimes(2);
  api.readApplicationPreviewLogs.mockResolvedValue({
    name: 'fixture',
    attemptId: 'latest',
    text: '',
    cursor: 2,
    truncated: false
  });
  view.rerender(
    <ApplicationLogs
      taskId="task"
      status={initial}
      selection={{ attemptId: 'latest' }}
      onSelect={() => undefined}
      active
    />
  );
  await waitFor(() =>
    expect(api.readApplicationPreviewLogs).toHaveBeenCalledTimes(3)
  );
  expect(api.readApplicationPreviewLogs.mock.lastCall?.[0].after).toBe(2);
  expect((screen.getByLabelText('Search logs') as HTMLInputElement).value).toBe(
    'keep filter'
  );
  fireEvent.change(screen.getByLabelText('Search logs'), {
    target: { value: '' }
  });
  expect(screen.getByText('No output captured.')).toBeTruthy();
  view.unmount();
  fireEvent(document, new Event('visibilitychange'));
  expect(api.readApplicationPreviewLogs).toHaveBeenCalledTimes(3);
});

it('returns focus after unlocking and clears secret input before transport settles or entry is canceled', async () => {
  let complete!: () => void;
  const secrets: PreviewSecretsApi = {
    status: vi
      .fn<PreviewSecretsApi['status']>(async () => ({
        state: 'unlocked' as const,
        canRemember: false
      }))
      .mockResolvedValueOnce({ state: 'locked', canRemember: false }),
    list: vi.fn(async () => ({ ids: [], usage: {} })),
    unlock: vi.fn(async () => ({
      state: 'unlocked' as const,
      canRemember: false
    })),
    lock: vi.fn(async () => undefined),
    remember: vi.fn(async () => undefined),
    forget: vi.fn(async () => undefined),
    create: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        })
    ),
    update: vi.fn(async () => true),
    remove: vi.fn(async () => undefined)
  };
  window.previewSecrets = secrets;
  const view = render(<PreviewSecretsSettings />);
  const unlock = await screen.findByRole('button', { name: 'Unlock' });
  unlock.focus();
  fireEvent.click(unlock);
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: 'synthetic-password' }
  });
  fireEvent.submit(screen.getByLabelText('Password').closest('form')!);
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'New secret' })
    )
  );
  fireEvent.click(await screen.findByRole('button', { name: 'New secret' }));
  fireEvent.change(screen.getByLabelText('Reference'), {
    target: { value: 'synthetic/dev/test' }
  });
  const input = screen.getByLabelText('Secret value') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'SYNTHETIC_value' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create secret' }));
  expect(input.value).toBe('');
  expect(secrets.create).toHaveBeenCalledWith({
    id: 'synthetic/dev/test',
    value: 'SYNTHETIC_value'
  });
  await act(async () => complete());
  fireEvent.click(screen.getByRole('button', { name: 'New secret' }));
  const canceled = screen.getByLabelText('Secret value') as HTMLTextAreaElement;
  fireEvent.change(canceled, { target: { value: 'SYNTHETIC_canceled' } });
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(canceled.value).toBe('');
  view.unmount();
  delete window.previewSecrets;
});
