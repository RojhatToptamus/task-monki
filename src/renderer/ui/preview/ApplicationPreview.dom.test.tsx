import {
  act,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { createRef } from 'react';
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
import { ApplicationSourceFolders } from './ApplicationSourceFolders';
import { ApplicationLogs } from './ApplicationLogs';
import { PreviewSecretsSettings } from './PreviewSecretsSettings';
import { ApplicationPreviewPanel } from './ApplicationPreviewPanel';
import { ApplicationPreviewSetup } from './ApplicationPreviewSetup';
import { PreviewRecipeGenerationModal } from './PreviewRecipeGenerationModal';
import type { PreviewRecipeGenerationSnapshot } from '../../../shared/contracts';

const api = vi.hoisted(() => ({
  getApplicationPreview: vi.fn(),
  inspectOpenTarget: vi.fn(),
  executeOpenTargetAction: vi.fn(),
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

it('lets the user answer missing setup decisions before generating another draft', async () => {
  const regenerate = vi.fn(async () => {});
  const state: PreviewRecipeGenerationSnapshot = {
    taskId: 'task', status: 'NEEDS_INPUT', report: {
      summary: 'Two applications are available.', evidence: [], assumptions: [], omissions: [],
      unresolvedDecisions: ['Which application should run: Alpha or Beta?'], publicEnvironmentDecisions: []
    }
  };
  render(<PreviewRecipeGenerationModal taskId="task" state={state}
    onClose={() => {}} onRegenerate={regenerate} onDiscard={async () => {}}
    onValidate={async () => ({ status: 'VALID' })} onAccept={async () => ({ recipePath: 'preview.yaml' })}
    fallbackReturnFocusRef={{ current: null }} modalRootRef={{ current: null }} onModalOpenChange={() => {}} />);
  expect(screen.getByText('Which application should run: Alpha or Beta?')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByRole('textbox', { name: 'Setup details' }), { target: { value: 'Use Beta.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(regenerate).toHaveBeenCalledWith('Use Beta.'));
});

it('preserves draft edits when a configuration appears during review and allows save recovery', async () => {
  const fallbackReturnFocusRef = createRef<HTMLDivElement>();
  let snapshot: ApplicationPreviewSnapshot = { name: 'fixture', hasConfigurationFile: false };
  api.getApplicationPreview.mockImplementation(async () => snapshot);
  const accept = vi.fn().mockRejectedValueOnce(new Error('A Preview recipe already exists.'))
    .mockResolvedValue({ recipePath: 'preview.yaml' });
  const state: PreviewRecipeGenerationSnapshot = { taskId: 'task', status: 'READY', draft: {
    id: 'draft', taskId: 'task', yaml: 'name: example\ntype: static\ndirectory: .\n', generatedAt: '', validation: { status: 'VALID' },
    report: { summary: 'Serve the static site.', evidence: [], assumptions: [], omissions: [], unresolvedDecisions: [], publicEnvironmentDecisions: [] }
  } };
  render(<div ref={fallbackReturnFocusRef} tabIndex={-1}><ApplicationPreviewPanel taskId="task" setup={
    <ApplicationPreviewSetup taskId="task" worktreeId="worktree" state={state}
      get={async () => state} generate={async () => state} discard={async () => ({ taskId: 'task', status: 'EMPTY' })}
      validate={async () => ({ status: 'VALID' })} accept={accept} writeManually={async () => {}}
      fallbackReturnFocusRef={fallbackReturnFocusRef} onModalOpenChange={() => {}} />
  } /></div>);
  fireEvent.click(await screen.findByRole('button', { name: 'Generate with agent' }));
  const edited = `${state.draft!.yaml}# Keep this edit\n`;
  fireEvent.change(await screen.findByRole('textbox', { name: 'Preview recipe YAML' }), { target: { value: edited } });
  snapshot = { ...snapshot, hasConfigurationFile: true };
  fireEvent(document, new Event('visibilitychange'));
  await screen.findByRole('heading', { name: 'Configuration ready' });
  expect((screen.getByRole('textbox', { name: 'Preview recipe YAML' }) as HTMLTextAreaElement).value).toBe(edited);
  fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
  expect((await screen.findByRole('alert')).textContent).toContain('already exists');
  expect(screen.getByRole('textbox', { name: 'Preview recipe YAML' }).hasAttribute('disabled')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(accept).toHaveBeenLastCalledWith('task', 'draft', edited);
  await waitFor(() => expect(document.activeElement).toBe(fallbackReturnFocusRef.current));
});

it('reviews an existing configuration before its first start and requires explicit approval', async () => {
  let snapshot: ApplicationPreviewSnapshot = {
    name: 'fixture',
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
      approval: { secrets: [], attemptId: 'pending', description: inspected.description }
    };
    return snapshot;
  });
  api.approveApplicationPreview.mockResolvedValue(undefined);
  render(<ApplicationPreviewPanel taskId="task" />);
  await screen.findByRole('button', { name: 'Review and start' });
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
    taskId: 'task',
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
    has: vi.fn(async () => false),
    status: vi
      .fn<PreviewSecretsApi['status']>(async () => ({
        state: 'unlocked' as const,
        canRemember: false
      }))
      .mockResolvedValueOnce({ state: 'locked', canRemember: false })
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
  fireEvent.change(await screen.findByLabelText('Password'), {
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
  const input = await screen.findByLabelText('Secret value') as HTMLInputElement;
  expect(input.type).toBe('password');
  fireEvent.paste(input, { clipboardData: { getData: () => 'SYNTHETIC_value\nsecond line' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create secret' }));
  expect(input.value).toBe('');
  expect(secrets.create).toHaveBeenCalledWith({
    id: 'synthetic/dev/test',
    value: 'SYNTHETIC_value\nsecond line'
  });
  await act(async () => complete());
  fireEvent.click(screen.getByRole('button', { name: 'New secret' }));
  const canceled = await screen.findByLabelText('Secret value') as HTMLInputElement;
  fireEvent.change(canceled, { target: { value: 'SYNTHETIC_canceled' } });
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(canceled.value).toBe('');
  view.unmount();
  delete window.previewSecrets;
});


it('opens the selected source through desktop actions and keeps a failed open retryable', async () => {
  api.executeOpenTargetAction.mockResolvedValueOnce({ ok: false, message: 'Path is missing.' })
    .mockResolvedValue({ ok: true });
  api.inspectOpenTarget.mockResolvedValue({
    target: { type: 'previewSource', kind: 'directory' },
    apps: [{ id: 'vscode', label: 'VS Code' }, { id: 'default', label: 'Default app' }],
    preferredAppId: 'vscode', revealLabel: 'Reveal in Finder',
    canOpen: true, canReveal: true, canOpenTerminal: false, canCopyFileContents: false
  });
  render(<ApplicationSourceFolders taskId="task" attemptId="attempt" sources={['/project/frontend', '/other/repository/backend']} />);
  fireEvent.click(screen.getByText('Source folders'));
  const target = { type: 'previewSource', taskId: 'task', attemptId: 'attempt', sourceIndex: 1 };
  fireEvent.click(screen.getByRole('button', { name: 'Open folder backend' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Path is missing.');
  expect(api.executeOpenTargetAction).toHaveBeenLastCalledWith({ target, action: 'open', appId: 'default' });
  fireEvent.click(screen.getByRole('button', { name: 'Open folder backend' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Folder actions for backend' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Open in VS Code' }));
  await waitFor(() => expect(api.executeOpenTargetAction).toHaveBeenLastCalledWith({ target, action: 'open', appId: 'vscode' }));
  expect(api.inspectOpenTarget).toHaveBeenCalledWith({ target });
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  try {
    api.executeOpenTargetAction.mockResolvedValue({ ok: true, clipboardText: '/other/repository/backend' });
    const trigger = screen.getByRole('button', { name: 'Folder actions for backend' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy path' }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(writeText).toHaveBeenCalledWith('/other/repository/backend');
    expect(document.activeElement).toBe(trigger);
  } finally {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
  const trigger = screen.getByRole('button', { name: 'Folder actions for backend' });
  fireEvent.click(trigger);
  await screen.findByRole('menuitem', { name: 'Copy path' });
  fireEvent.scroll(screen.getByRole('menu'));
  expect(screen.getByRole('menu')).toBeTruthy();
  fireEvent.scroll(screen.getByRole('list'));
  expect(screen.queryByRole('menu')).toBeNull();
  fireEvent.click(trigger);
  await screen.findByRole('menuitem', { name: 'Copy path' });
  fireEvent.resize(window);
  expect(screen.queryByRole('menu')).toBeNull();
});
