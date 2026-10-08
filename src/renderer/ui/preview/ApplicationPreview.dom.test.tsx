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
import { ApplicationSourceFolders } from './ApplicationSourceFolders';
import { ApplicationLogs } from './ApplicationLogs';
import { PreviewSecretsSettings } from './PreviewSecretsSettings';
import { ApplicationPreviewPanel } from './ApplicationPreviewPanel';
import type { PreviewAgentActions } from './PreviewAgentActions';
import type { PreviewRecipeGenerationSnapshot } from '../../../shared/contracts';

const api = vi.hoisted(() => ({
  getApplicationPreview: vi.fn(),
  inspectOpenTarget: vi.fn(),
  executeOpenTargetAction: vi.fn(),
  startApplicationPreview: vi.fn(),
  approveApplicationPreview: vi.fn(),
  cancelApplicationPreview: vi.fn(),
  inspectApplicationPreviewConfiguration: vi.fn(),
  readApplicationPreviewFile: vi.fn(),
  saveApplicationPreviewFile: vi.fn(),
  connectApplicationPreviewSource: vi.fn(),
  chooseRepositoryFolder: vi.fn(),
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
    startedAt: '2026-10-08T12:00:00Z',
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
beforeEach(() => {
  vi.resetAllMocks();
  api.readApplicationPreviewFile.mockResolvedValue({});
  api.inspectApplicationPreviewConfiguration.mockResolvedValue(inspected);
  api.readApplicationPreviewLogs.mockResolvedValue({ text: '', cursor: 0, truncated: false });
});
function agentActions(state: PreviewRecipeGenerationSnapshot): PreviewAgentActions {
  return { state, get: vi.fn(async () => state), generate: vi.fn(async () => state),
    validate: vi.fn(async () => ({ status: 'VALID' as const })),
    accept: vi.fn(async () => ({ recipePath: 'preview.yaml' as const })),
    discard: vi.fn(async () => ({ taskId: 'task', status: 'EMPTY' as const })) };
}
const proposal: PreviewRecipeGenerationSnapshot = { taskId: 'task', status: 'READY', draft: {
  id: 'draft', taskId: 'task', fileName: 'preview.yaml', replacesExistingFile: false,
  yaml: 'name: example\ntype: static\ndirectory: .\n', generatedAt: '', validation: { status: 'VALID' },
  report: { summary: 'Serve the static site.', evidence: [], assumptions: [], omissions: [], unresolvedDecisions: [], publicEnvironmentDecisions: [] }
} };

it('keeps an agent question inline and passes the answer without approving a run', async () => {
  api.getApplicationPreview.mockResolvedValue({ name: 'fixture', hasConfigurationFile: false });
  const agent = agentActions({ taskId: 'task', status: 'NEEDS_INPUT', report: {
    summary: 'Two applications are available.', evidence: [], assumptions: [], omissions: [],
    unresolvedDecisions: ['Which application should run: Alpha or Beta?'], publicEnvironmentDecisions: []
  } });
  render(<ApplicationPreviewPanel taskId="task" agent={agent} />);
  expect(await screen.findByText('Which application should run: Alpha or Beta?')).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox', { name: 'What should the Preview agent inspect or change?' }), { target: { value: 'Use Beta.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Draft configuration' }));
  await waitFor(() => expect(agent.generate).toHaveBeenCalledWith('task', 'Use Beta.'));
  expect(api.startApplicationPreview).not.toHaveBeenCalled();
  expect(api.approveApplicationPreview).not.toHaveBeenCalled();
});

it('preserves a reviewed draft across a stale-save rejection and saves without starting', async () => {
  api.getApplicationPreview.mockResolvedValue({ name: 'fixture', hasConfigurationFile: false });
  const agent = agentActions(proposal);
  vi.mocked(agent.accept).mockRejectedValueOnce(new Error('Configuration changed. Reload before replacing it.'));
  render(<ApplicationPreviewPanel taskId="task" agent={agent} />);
  fireEvent.click(await screen.findByRole('tab', { name: 'YAML' }));
  const edited = proposal.draft!.yaml + '# Keep this edit\n';
  fireEvent.change(screen.getByRole('textbox', { name: 'Preview YAML' }), { target: { value: edited } });
  fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Configuration changed');
  expect((screen.getByRole('textbox', { name: 'Preview YAML' }) as HTMLTextAreaElement).value).toBe(edited);
  fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
  await waitFor(() => expect(agent.accept).toHaveBeenCalledTimes(2));
  expect(agent.accept).toHaveBeenLastCalledWith('task', 'draft', edited);
  expect(api.startApplicationPreview).not.toHaveBeenCalled();
  expect(api.approveApplicationPreview).not.toHaveBeenCalled();
});

it('reviews an existing file inline and requires explicit approval before execution', async () => {
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
      approval: {
        secrets: [],
        attemptId: 'pending',
        description: {
          ...inspected.description,
          spec: {
            name: 'fixture',
            type: 'environment',
            primary: 'web',
            timeoutMs: 1000,
            services: {
              web: {
                type: 'command',
                cwd: '/fixture',
                command: ['node', 'server.js'],
                readyPath: '/'
              },
              worker: {
                type: 'worker',
                cwd: '/fixture',
                command: ['node', 'worker.js'],
                ready: {
                  type: 'command',
                  command: ['node', 'check.js'],
                  cwd: '/probe-tools',
                  timeoutMs: 1000
                }
              }
            }
          }
        }
      }
    };
    return snapshot;
  });
  api.approveApplicationPreview.mockResolvedValue(undefined);
  api.cancelApplicationPreview.mockImplementation(async () => {
    snapshot = { name: 'fixture', hasConfigurationFile: true };
    return snapshot;
  });
  render(<ApplicationPreviewPanel taskId="task" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Start preview' }));
  await screen.findByRole('button', { name: 'Approve and start' });
  expect(screen.getByText('/probe-tools', { exact: true })).toBeTruthy();
  expect(
    screen
      .getAllByText('node check.js', { exact: true })
      .some((node) => !node.closest('details'))
  ).toBe(true);
  expect(api.startApplicationPreview).toHaveBeenCalledWith({ taskId: 'task' });
  expect(api.approveApplicationPreview).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole('button', { name: 'Approve and start' }), {
    key: 'Escape'
  });
  await screen.findByRole('button', { name: 'Start preview' });
  expect(api.cancelApplicationPreview).toHaveBeenCalledWith({
    taskId: 'task',
    attemptId: 'pending'
  });
  expect(api.approveApplicationPreview).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Start preview' }));
  await screen.findByRole('button', { name: 'Approve and start' });
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

it('edits the file draft while preserving comments and unrelated secret references', async () => {
  const original = { name: 'preview.yaml' as const, text: '# Project note\nname: fixture\ntype: command\ncwd: .\ncommand: [node, server.js]\nenv:\n  TOKEN: {secret: fixture/dev/token}\n' };
  const onChange = vi.fn();
  const view = render(<ApplicationConfiguration draft={{ original, text: original.text }} view="Configuration" onView={() => {}}
    onChange={onChange} onSave={() => {}} busy={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit Application command' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Application · command' }), { target: { value: '["node", "web.js"]' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply to draft' }));
  expect(onChange.mock.lastCall?.[0]).toContain('# Project note');
  expect(onChange.mock.lastCall?.[0]).toContain('fixture/dev/token');
  expect(onChange.mock.lastCall?.[0]).toContain('web.js');
  expect(api.saveApplicationPreviewFile).not.toHaveBeenCalled();
  view.rerender(<ApplicationConfiguration draft={{ original, text: onChange.mock.lastCall![0] }}
    previous={{ ...original, text: original.text.replace('server.js', 'previous-run.js') }}
    view="Changes" onView={() => {}} onChange={onChange} onSave={() => {}} busy={false} />);
  const changes = screen.getByLabelText('Configuration changes');
  expect(changes.textContent).toContain('server.js');
  expect(changes.textContent).toContain('web.js');
  expect(changes.textContent).not.toContain('previous-run.js');
});

it('ignores late logs, preserves the cursor across hidden tabs, and releases its reader on unmount', async () => {
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
    text: '[fixture] new output\n',
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
      status={{ ...initial, latest: { ...initial.active!, id: 'latest' } }}
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
  fireEvent.change(screen.getByLabelText('Search logs'), {
    target: { value: 'keep filter' }
  });
  view.rerender(
    <ApplicationLogs
      taskId="task"
      status={{ ...initial, latest: { ...initial.active!, id: 'latest' } }}
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
      status={{ ...initial, latest: { ...initial.active!, id: 'latest' } }}
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
  expect(screen.getByText('new output')).toBeTruthy();
  view.unmount();
  fireEvent(document, new Event('visibilitychange'));
  expect(api.readApplicationPreviewLogs).toHaveBeenCalledTimes(3);
});

it('places a terminal marker after final service output and resumes the visible pane consistently', async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  api.readApplicationPreviewLogs.mockResolvedValueOnce({ text: '[check] starting\n', cursor: 17, truncated: false });
  const props = { taskId: 'task', onSelect: () => undefined };
  const services = { check: { type: 'job' as const, state: 'starting' as const }, web: { type: 'static' as const, state: 'waiting' as const } };
  const view = render(<ApplicationLogs {...props} status={{ ...initial, active: undefined, candidate: { ...initial.active!, type: 'environment', state: 'starting', services } }} />);
  await screen.findByText('starting');
  api.readApplicationPreviewLogs.mockResolvedValue({ text: 'preparing\nstarting handler\nError: final startup failure\n[web] Static service canceled\n', cursor: 97, truncated: false });
  view.rerender(<ApplicationLogs {...props} status={{ ...initial, active: undefined, latest: { ...initial.active!, type: 'environment', state: 'failed', services: { check: { ...services.check, state: 'failed', error: { code: 'START_FAILED', message: 'process exited' } }, web: { ...services.web, state: 'canceled' } } } }} />);
  fireEvent(document, new Event('visibilitychange'));
  await screen.findByText('Error: final startup failure');
  const text = screen.getByRole('region', { name: 'Application logs' }).textContent!;
  expect(text.indexOf('Error: final startup failure')).toBeLessThan(text.indexOf('check failed'));
  expect(text).not.toContain('Static service canceled');
  view.rerender(<ApplicationLogs {...props} selection={{ attemptId: initial.active!.id, source: 'check', failure: true }}
    status={{ ...initial, active: undefined, latest: { ...initial.active!, type: 'environment', state: 'failed', services: { check: { ...services.check, state: 'failed' }, web: { ...services.web, state: 'canceled' } } } }} />);
  fireEvent.click(screen.getAllByRole('button', { name: 'Resume follow' })[0]!);
  expect(screen.getByText('Following')).toBeTruthy();
  expect(screen.queryByText('Follow paused')).toBeNull();

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


it('blocks startup until the backend connection is present in the file', async () => {
  api.getApplicationPreview.mockResolvedValue({ name: 'fixture', hasConfigurationFile: true,
    requirements: { sources: [], secrets: [], connections: ['api'] } });
  api.readApplicationPreviewFile.mockResolvedValue({ file: { name: 'preview.yaml', text: 'name: fixture\ntype: environment\nprimary: api\nservices:\n  api: {type: attach}\n' } });
  render(<ApplicationPreviewPanel taskId="task" />);
  expect((await screen.findByRole('button', { name: 'Start preview' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Set address' }));
  await screen.findByRole('button', { name: 'Connect address' });
  expect(api.startApplicationPreview).not.toHaveBeenCalled();
  expect(api.approveApplicationPreview).not.toHaveBeenCalled();
});

it('shows a chosen missing folder before granting access and never starts on Connect', async () => {
  api.getApplicationPreview.mockResolvedValue({ name: 'fixture', hasConfigurationFile: true,
    requirements: { secrets: [], connections: [], sources: ['api', 'migrate'].map(service => ({ service, declaration: '../backend', directory: '/projects/missing-backend', connected: false, missing: true })) } });
  api.chooseRepositoryFolder.mockResolvedValue('/chosen/backend');
  api.connectApplicationPreviewSource.mockResolvedValue(undefined);
  render(<ApplicationPreviewPanel taskId="task" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Choose folder' }));
  expect(screen.getByText('api, migrate')).toBeTruthy();
  expect(await screen.findByText('/chosen/backend')).toBeTruthy();
  expect(api.connectApplicationPreviewSource).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  await waitFor(() => expect(api.connectApplicationPreviewSource).toHaveBeenCalledWith({ taskId: 'task', service: 'api', directory: '/chosen/backend', expected: { active: null, candidate: null, latest: null } }));
  expect(api.startApplicationPreview).not.toHaveBeenCalled();
  expect(api.approveApplicationPreview).not.toHaveBeenCalled();
});

it('saves and replaces a concealed value under the required reference without starting or approving', async () => {
  const reference = 'competitions/dev/api-token';
  const missing: ApplicationPreviewSnapshot = {
    name: 'fixture', hasConfigurationFile: true,
    requirements: { sources: [], connections: [], secrets: [{ id: reference, selected: false, bindings: [{ service: 'api', key: 'TOKEN' }], availability: 'missing' }] }
  };
  api.getApplicationPreview.mockResolvedValue(missing);
  const create = vi.fn(async () => {
    api.getApplicationPreview.mockResolvedValue({ ...missing, requirements: { ...missing.requirements, secrets: missing.requirements!.secrets.map(secret => ({ ...secret, availability: 'available' })) } });
    vi.mocked(window.previewSecrets!.has).mockResolvedValue(true);
  });
  window.previewSecrets = { status: vi.fn(async () => ({ state: 'unlocked' })), has: vi.fn(async () => false), create } as unknown as PreviewSecretsApi;
  render(<ApplicationPreviewPanel taskId="task" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add value' }));
  const form = await screen.findByRole('form', { name: 'Add missing secret' });
  expect(screen.queryByRole('dialog')).toBeNull();
  const input = form.querySelector<HTMLInputElement>('input[type="password"]')!;
  expect(input).toBeTruthy();
  fireEvent.change(input, { target: { value: 'synthetic-verification-value' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));
  await waitFor(() => expect(create).toHaveBeenCalledWith({ id: reference, value: 'synthetic-verification-value' }));
  expect(input.value).toBe('');
  fireEvent.keyDown(screen.getByRole('button', { name: 'More preview actions' }), { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Manage required secrets' }));
  await screen.findByRole('form', { name: 'Replace secret value' });
  expect(screen.getByRole('textbox', { name: 'Secret reference' })).toHaveProperty('value', reference);
  const update = vi.fn(async () => true);
  window.previewSecrets!.update = update;
  fireEvent.change(screen.getByLabelText('Secret value'), { target: { value: 'SYNTHETIC_replacement_with_at_least_32_characters' } });
  fireEvent.click(screen.getByRole('button', { name: 'Replace value' }));
  await waitFor(() => expect(update).toHaveBeenCalledWith({ id: reference, value: 'SYNTHETIC_replacement_with_at_least_32_characters' }));
  await waitFor(() => expect(screen.queryByRole('form', { name: 'Replace secret value' })).toBeNull());
  expect(api.startApplicationPreview).not.toHaveBeenCalled();
  expect(api.approveApplicationPreview).not.toHaveBeenCalled();
});
