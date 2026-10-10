import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
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
import { PreviewAttemptConfiguration } from './PreviewAttemptConfiguration';
import { ApplicationLogs } from './ApplicationLogs';
import { PreviewSecretsSettings } from './PreviewSecretsSettings';
import { ApplicationPreviewPanel } from './ApplicationPreviewPanel';
import { persistPreviewAgentOpen } from '../../model/workspaceLayout';
import type { PreviewAgentConversation, PreviewProposalActions } from './PreviewAgentProps';
import { createRuntimeReadiness } from '../../../core/agent/AgentRuntimeReadiness';
import { CODEX_RUNTIME_DESCRIPTOR, codexCapabilities } from '../../../core/agent/codex/codexCapabilities';
import type {
  AgentModel, AgentRuntimeState, InteractionRequestRecord, PreviewRecipeGenerationSnapshot, RunRecord, TaskInstruction, WorktreeRecord
} from '../../../shared/contracts';

const api = vi.hoisted(() => ({
  getApplicationPreview: vi.fn(),
  inspectApplicationPreviewSetup: vi.fn(),
  startRetainedApplicationPreview: vi.fn(),
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
  readApplicationPreviewLogs: vi.fn(),
  openApplicationPreview: vi.fn()
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
const worktree = (status: WorktreeRecord['status']): WorktreeRecord => ({
  id: 'wt', taskId: 'task', iterationId: 'it', repositoryId: 'repo', ownership: 'MANAGED', worktreePath: '/fixture',
  branchName: 'codex/fixture', baseRef: 'main', baseSha: 'abcdef1234567890', headSha: 'f390644abcdef0', status,
  createdAt: '2026-10-08T12:00:00Z', updatedAt: '2026-10-08T12:00:00Z'
});
beforeEach(() => {
  vi.resetAllMocks();
  window.localStorage.clear();
  api.readApplicationPreviewFile.mockResolvedValue({});
  api.inspectApplicationPreviewSetup.mockResolvedValue({ projectDirectory: '/fixture', recommendations: [], facts: [] });
  api.inspectApplicationPreviewConfiguration.mockResolvedValue(inspected);
  api.readApplicationPreviewLogs.mockResolvedValue({ text: '', cursor: 0, truncated: false });
});
function proposalActions(state: PreviewRecipeGenerationSnapshot): PreviewProposalActions {
  return { state, get: vi.fn(async () => state),
    validate: vi.fn(async () => ({ status: 'VALID' as const })),
    accept: vi.fn(async () => ({ recipePath: 'preview.yaml' as const })),
    discard: vi.fn(async () => ({ taskId: 'task', status: 'EMPTY' as const })) };
}
const scenarioModel: AgentModel = {
  id: 'codex:openai/scenario-model', runtimeId: 'codex', modelProvider: 'openai', model: 'scenario-model', displayName: 'Scenario model',
  hidden: false, supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low', serviceTiers: [], inputModalities: ['text'], isDefault: true
};
const codexRuntime: AgentRuntimeState = {
  preflight: { runtime: CODEX_RUNTIME_DESCRIPTOR, readiness: createRuntimeReadiness('READY', 'Codex is ready.'), capabilities: codexCapabilities() },
  models: [scenarioModel],
  refreshedAt: '2026-10-09T10:00:00Z'
};
const previewRun = (status: RunRecord['status'], id = 'preview-run'): RunRecord => ({
  id, runtimeId: 'codex', taskId: 'task', iterationId: 'it', worktreeId: 'wt', sessionId: 'preview-session', mode: 'PREVIEW', origin: 'USER',
  status, recoveryState: 'NONE', requestedSettings: { runtimeId: 'codex', model: 'scenario-model', modelProvider: 'openai' },
  promptArtifactId: 'p', outputArtifactId: 'o', diagnosticArtifactId: 'd', providerTurnId: 'turn', startedAt: '2026-10-09T10:00:00Z', eventCount: 1,
  attachmentSelection: []
} as unknown as RunRecord);
const previewMessage = (id: string, text: string, status: TaskInstruction['status'], runId?: string): TaskInstruction => ({
  id, taskId: 'task', iterationId: 'it', worktreeId: 'wt', sourceRunId: 'preview-run', sessionId: 'preview-session', order: 1, text,
  mode: runId ? 'FOLLOW_UP' : 'QUEUE', status, role: 'PREVIEW', runId, createdAt: '2026-10-09T10:00:00Z', updatedAt: '2026-10-09T10:00:00Z'
});
function agentConversation(overrides: Partial<PreviewAgentConversation> = {}): PreviewAgentConversation {
  return {
    runs: [], items: [], instructions: [], interactions: [], sessions: [], plans: [],
    models: [scenarioModel], runtimes: [codexRuntime], defaults: { runtimeId: 'codex', model: scenarioModel.model, modelProvider: scenarioModel.modelProvider, reasoningEffort: 'low' },
    send: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), editQueued: vi.fn(async () => undefined), respond: vi.fn(async () => undefined),
    ...overrides
  };
}
const proposal: PreviewRecipeGenerationSnapshot = { taskId: 'task', status: 'READY', draft: {
  id: 'draft', taskId: 'task', fileName: 'preview.yaml', replacesExistingFile: false,
  yaml: 'name: example\ntype: static\ndirectory: .\n', generatedAt: '', validation: { status: 'VALID' },
  report: { summary: 'Serve the static site.', notes: [] }
} };

it('opens the conversation for a pending question, answers it in place, and never starts or approves a run from an answer', async () => {
  api.getApplicationPreview.mockResolvedValue({ name: 'fixture', hasConfigurationFile: false });
  const question: InteractionRequestRecord = {
    id: 'question', taskId: 'task', iterationId: 'it', worktreeId: 'wt', runId: 'preview-run', sessionId: 'preview-session', runtimeId: 'codex',
    type: 'USER_INPUT', status: 'PENDING', requestedAt: '2026-10-09T10:01:00Z', allowedActions: ['ANSWER'], policyWarnings: [],
    request: { questions: [{ id: 'app', header: 'Application', question: 'Which application should run: Alpha or Beta?', isOther: true, isSecret: false, options: [] }] }
  } as unknown as InteractionRequestRecord;
  const agent = agentConversation({
    runs: [previewRun('AWAITING_USER_INPUT')],
    instructions: [previewMessage('m1', 'Draft a preview configuration for this project.', 'SUBMITTED', 'preview-run')],
    interactions: [question]
  });
  render(<ApplicationPreviewPanel taskId="task" worktree={worktree('PRESENT')} agent={agent} proposals={proposalActions({ taskId: 'task', status: 'EMPTY' })} />);
  const panel = await screen.findByRole('complementary', { name: 'Preview agent conversation' });
  expect(panel.textContent).toContain('Draft a preview configuration for this project.');
  expect(panel.textContent).toContain('Which application should run: Alpha or Beta?');
  expect((screen.getByRole('button', { name: 'Agent' }) as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true');
  expect((screen.getByRole('button', { name: 'Queue' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByRole('textbox', { name: 'Which application should run: Alpha or Beta?' }), { target: { value: 'Alpha' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }));
  await waitFor(() => expect(agent.respond).toHaveBeenCalledWith(question, {
    interactionType: 'USER_INPUT', action: 'ANSWER', answers: { app: ['Alpha'] }
  }));
  expect(api.startApplicationPreview).not.toHaveBeenCalled();
  expect(api.approveApplicationPreview).not.toHaveBeenCalled();
  expect(screen.queryByRole('tab', { name: 'Configuration' })).toBeNull();
});

it.each(['header', 'chat'] as const)('preserves edits across a stale-save rejection and uses the shared save flow from %s', async (source) => {
  api.getApplicationPreview.mockResolvedValue({ name: 'fixture', hasConfigurationFile: false });
  const proposals = proposalActions(proposal);
  vi.mocked(proposals.accept).mockRejectedValueOnce(new Error('Configuration changed. Reload before replacing it.'));
  render(<ApplicationPreviewPanel taskId="task" worktree={worktree('PRESENT')} agent={agentConversation()} proposals={proposals} />);
  expect(await screen.findByLabelText('Configuration changes')).toBeTruthy();
  expect(screen.getByText('Proposal ready')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'YAML' }));
  const edited = proposal.draft!.yaml + '# Keep this edit\n';
  fireEvent.change(screen.getByRole('textbox', { name: 'Preview YAML' }), { target: { value: edited } });
  if (source === 'chat' && !screen.queryByRole('button', { name: 'Save and review' })) fireEvent.click(screen.getByRole('button', { name: 'Agent' }));
  fireEvent.click(screen.getByRole('button', { name: source === 'chat' ? 'Save and review' : 'Save' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Configuration changed');
  expect(api.startApplicationPreview).not.toHaveBeenCalled();
  expect((screen.getByRole('textbox', { name: 'Preview YAML' }) as HTMLTextAreaElement).value).toBe(edited);
  if (source === 'chat' && !screen.queryByRole('button', { name: 'Save and review' })) fireEvent.click(screen.getByRole('button', { name: 'Agent' }));
  fireEvent.click(screen.getByRole('button', { name: source === 'chat' ? 'Save and review' : 'Save' }));
  await waitFor(() => expect(proposals.accept).toHaveBeenCalledTimes(2));
  expect(proposals.accept).toHaveBeenLastCalledWith('task', 'draft', edited);
  if (source === 'chat') await waitFor(() => expect(api.startApplicationPreview).toHaveBeenCalledWith({ taskId: 'task' }));
  else expect(api.startApplicationPreview).not.toHaveBeenCalled();
  expect(api.approveApplicationPreview).not.toHaveBeenCalled();
});

it('returns to first-time setup after discarding an unsaved proposal', async () => {
  api.getApplicationPreview.mockResolvedValue({ name: 'fixture', hasConfigurationFile: false });
  const proposals = proposalActions(proposal);
  render(<ApplicationPreviewPanel taskId="task" worktree={worktree('PRESENT')} agent={agentConversation()} proposals={proposals} />);
  await screen.findByLabelText('Configuration changes');
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  await waitFor(() => expect(proposals.discard).toHaveBeenCalled());
  expect(await screen.findByRole('button', { name: 'Draft with Preview agent' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  expect(api.saveApplicationPreviewFile).not.toHaveBeenCalled();
});

it('reviews an existing file inline and requires explicit approval before execution', async () => {
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
  render(<ApplicationPreviewPanel taskId="task" worktree={{ ...worktree('PRESENT'), worktreePath: '/worktree-symlink' }} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Start preview' }));
  await screen.findByRole('button', { name: 'Approve and start' });
  expect(screen.getByText('Task worktree', { exact: true })).toBeTruthy();
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
  const props = { onLogs: vi.fn(), onAsRun: vi.fn() };
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
  expect(screen.getByText('Data kept')).toBeTruthy();
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
  expect(screen.queryByText('Data kept')).toBeNull();
  expect(screen.getByRole('button', { name: /Run configuration at/ })).toBeTruthy();
});

it('explains external service log ownership and offers a reviewed configuration change', () => {
  const onConfigureLogs = vi.fn();
  const onLogs = vi.fn();
  render(<ApplicationActivity status={{ ...initial, active: { ...initial.active!, type: 'environment', services: {
    backend: { type: 'external-tcp', state: 'ready' }, app: { type: 'command', state: 'ready' }
  } } }} onLogs={onLogs} onAsRun={() => undefined} onConfigureLogs={onConfigureLogs} />);
  expect(screen.getByText('External TCP')).toBeTruthy();
  expect(screen.getByText(/backend runs outside Preview/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Logs for backend' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Ask agent to enable logs' }));
  expect(onConfigureLogs).toHaveBeenCalledWith(['backend']);
  expect(onLogs).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Logs for app' }));
  expect(onLogs).toHaveBeenCalledWith('serving', 'app', false);
});

it('edits a command in place without touching comments or other references, refusing text that is not a command', async () => {
  const original = { name: 'preview.yaml' as const, text: '# Project note\nname: fixture\ntype: command\ncwd: .\ncommand: [node, server.js]\nenv:\n  TOKEN: {secret: fixture/dev/token}\n' };
  const onChange = vi.fn();
  const view = render(<ApplicationConfiguration draft={{ original, text: original.text }} view="Configuration" onView={() => {}}
    onChange={onChange} onSave={() => {}} busy={false} />);
  const row = screen.getByRole('button', { name: /^fixture/, expanded: false });
  fireEvent.click(row);
  const command = screen.getByRole('textbox', { name: 'Command' });
  fireEvent.change(command, { target: { value: 'node "web.js' } });
  fireEvent.blur(command);
  expect(screen.getByRole('alert').textContent).toBe('Close the quoted argument.');
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.change(command, { target: { value: 'node web.js "--title=Two words"' } });
  fireEvent.keyDown(command, { key: 'Enter' });
  expect(onChange.mock.lastCall?.[0]).toBe(original.text.replace('[node, server.js]', '[node, web.js, --title=Two words]'));
  expect(api.saveApplicationPreviewFile).not.toHaveBeenCalled();
  view.rerender(<ApplicationConfiguration draft={{ original, text: onChange.mock.lastCall![0] }} view="Configuration" onView={() => {}}
    onChange={onChange} onSave={() => {}} busy={false} />);
  fireEvent.keyDown(command, { key: 'Escape' });
  expect(row.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(row);
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

it('splits chosen log sources into live panes and falls back to one stream when fewer than two remain', async () => {
  api.inspectApplicationPreviewConfiguration.mockRejectedValue(new Error('unavailable'));
  api.readApplicationPreviewLogs.mockResolvedValue({ text: '[backend] API ready\n[app] Frontend ready\n[install] Installed\n', cursor: 60, truncated: false });
  const services = { backend: { type: 'command' as const, state: 'ready' as const }, app: { type: 'command' as const, state: 'starting' as const }, install: { type: 'job' as const, state: 'succeeded' as const } };
  const selection = { attemptId: 'serving', source: 'app' };
  const view = render(<ApplicationLogs taskId="task" status={{ ...initial, active: { ...initial.active!, type: 'environment', services } }}
    selection={selection} onSelect={() => undefined} />);
  await screen.findByText('Frontend ready');
  const sideBySide = screen.getByRole('button', { name: 'Side by side' });
  expect(sideBySide.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(sideBySide);
  expect(screen.queryByRole('region', { name: 'app log pane' })).toBeNull();
  fireEvent.keyDown(screen.getByRole('button', { name: 'Log sources' }), { key: 'ArrowDown' });
  const backend = screen.getByRole('menuitemcheckbox', { name: 'backend' });
  fireEvent.click(backend);
  // The menu stays open for multi-select.
  expect(screen.getByRole('menuitemcheckbox', { name: 'backend' }).getAttribute('aria-checked')).toBe('true');
  fireEvent.keyDown(backend, { key: 'Escape' });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Log sources' })));
  fireEvent.click(screen.getByRole('button', { name: 'Side by side' }));
  expect(screen.getByRole('region', { name: 'backend log pane' }).textContent).toContain('API ready');
  expect(screen.getByRole('region', { name: 'app log pane' }).textContent).not.toContain('API ready');
  fireEvent.click(screen.getByRole('button', { name: 'Pause backend logs' }));
  expect(screen.getByRole('button', { name: 'Resume backend logs' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Pause app logs' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Resume backend logs' }));
  expect(screen.getByRole('button', { name: 'Pause backend logs' })).toBeTruthy();
  // Choosing sources while split updates the panes in place.
  fireEvent.keyDown(screen.getByRole('button', { name: 'Log sources' }), { key: 'ArrowDown' });
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'install' }));
  expect(screen.getByRole('region', { name: 'install log pane' }).textContent).toContain('Installed');
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'install' }));
  fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'backend' }));
  expect(screen.getByRole('region', { name: 'Combined log pane' }).textContent).not.toContain('API ready');
  expect(screen.getByRole('button', { name: 'Side by side' }).getAttribute('aria-pressed')).toBe('false');
  expect(screen.getByRole('menuitemcheckbox', { name: 'app' }).getAttribute('aria-disabled')).toBe('true');
  view.rerender(<ApplicationLogs taskId="task" status={{ ...initial, active: { ...initial.active!, type: 'environment', services: {
    ...services, app: { ...services.app, state: 'ready' }, backend: { ...services.backend, state: 'starting' }
  } } }} selection={selection} onSelect={() => undefined} />);
  expect(screen.getByRole('region', { name: 'Combined log pane' }).textContent).toContain('Frontend ready');
  expect(screen.getByRole('region', { name: 'Combined log pane' }).textContent).not.toContain('API ready');
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
  fireEvent.click(screen.getByRole('button', { name: 'Resume logs' }));
  expect(screen.getByRole('button', { name: 'Pause logs' })).toBeTruthy();

});

it('keeps a ready marker where it was observed while the service keeps logging', async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  api.readApplicationPreviewLogs.mockResolvedValueOnce({ text: '[api] Listening on 60312\n', cursor: 24, truncated: false });
  const props = { taskId: 'task', onSelect: () => undefined };
  const services = { api: { type: 'command' as const, state: 'starting' as const }, web: { type: 'command' as const, state: 'waiting' as const } };
  const status = (apiState: 'starting' | 'ready') => ({ ...initial, active: undefined,
    candidate: { ...initial.active!, type: 'environment' as const, state: 'starting' as const, services: { ...services, api: { ...services.api, state: apiState } } } });
  const view = render(<ApplicationLogs {...props} status={status('starting')} />);
  await screen.findByText('Listening on 60312');
  api.readApplicationPreviewLogs.mockResolvedValue({ text: '[api] GET /api/notes 200\n', cursor: 49, truncated: false });
  view.rerender(<ApplicationLogs {...props} status={status('ready')} />);
  fireEvent(document, new Event('visibilitychange'));
  await screen.findByText('GET /api/notes 200');
  const text = screen.getByRole('region', { name: 'Application logs' }).textContent!;
  expect(text.indexOf('Listening on 60312')).toBeLessThan(text.indexOf('api ready'));
  expect(text.indexOf('api ready')).toBeLessThan(text.indexOf('GET /api/notes 200'));
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
  api.inspectApplicationPreviewConfiguration.mockResolvedValue({ ...inspected, description: { ...inspected.description, spec: {
    name: 'fixture', type: 'environment', primary: 'web', timeoutMs: 1000,
    services: { web: { type: 'command', cwd: '/project/frontend', command: ['npm', 'run', 'dev'] }, api: { type: 'command', cwd: '/other/repository/backend', command: ['npm', 'start'] } }
  } } });
  const attempt = { ...initial.active!, id: 'attempt', type: 'environment' as const, state: 'failed' as const, sources: ['/project/frontend', '/other/repository/backend'],
    services: { web: { type: 'command' as const, state: 'skipped' as const }, api: { type: 'command' as const, state: 'failed' as const, error: { code: 'START_FAILED', message: 'api exited with code 127' } as never } } };
  render(<PreviewAttemptConfiguration taskId="task" attempt={attempt} status={{ ...initial, active: undefined, latest: attempt }} projectDirectory="/project" onBack={() => undefined} />);
  expect((await screen.findByLabelText('Configuration used for this run')).textContent).toContain('read-only');
  expect(screen.getByText('Failed').parentElement?.textContent).toContain('exit 127');
  expect(screen.getByText('Not started')).toBeTruthy();
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
  fireEvent.scroll(screen.getByLabelText('Configuration used for this run'));
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
  render(<ApplicationPreviewPanel taskId="task" worktree={worktree('PRESENT')} />);
  expect((await screen.findByRole('button', { name: 'Start preview' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Set address' }));
  // The service without an address opens straight to its Address field.
  expect(await screen.findByRole('textbox', { name: 'Address' })).toBeTruthy();
  expect(api.startApplicationPreview).not.toHaveBeenCalled();
  expect(api.approveApplicationPreview).not.toHaveBeenCalled();
});

it('shows a chosen missing folder before granting access and never starts on Connect', async () => {
  api.getApplicationPreview.mockResolvedValue({ name: 'fixture', hasConfigurationFile: true,
    requirements: { secrets: [], connections: [], sources: ['api', 'migrate'].map(service => ({ service, declaration: '../backend', directory: '/projects/missing-backend', connected: false, missing: true })) } });
  api.chooseRepositoryFolder.mockResolvedValue('/chosen/backend');
  api.connectApplicationPreviewSource.mockResolvedValue(undefined);
  render(<ApplicationPreviewPanel taskId="task" worktree={worktree('PRESENT')} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Choose folder' }));
  expect(screen.getByText('Used by api, migrate')).toBeTruthy();
  expect((await screen.findAllByTitle('/chosen/backend'))[0]!.textContent).toBe('backend');
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
    requirements: { sources: [], connections: [], secrets: [reference, 'competitions/dev/other-token'].map(id => ({ id, selected: false, bindings: [{ service: 'api', key: 'TOKEN' }], availability: 'missing' as const })) }
  };
  api.getApplicationPreview.mockResolvedValue(missing);
  const create = vi.fn(async () => {
    api.getApplicationPreview.mockResolvedValue({ ...missing, requirements: { ...missing.requirements, secrets: missing.requirements!.secrets.map(secret => ({ ...secret, availability: 'available' })) } });
    vi.mocked(window.previewSecrets!.has).mockResolvedValue(true);
  });
  window.previewSecrets = { status: vi.fn(async () => ({ state: 'unlocked' })), has: vi.fn(async () => false), create } as unknown as PreviewSecretsApi;
  render(<ApplicationPreviewPanel taskId="task" worktree={worktree('PRESENT')} />);
  const addButtons = await screen.findAllByRole('button', { name: /Add value/ });
  fireEvent.click(addButtons[1]!);
  await screen.findByRole('form', { name: 'Add missing secret' });
  fireEvent.change(await screen.findByLabelText('TOKEN'), { target: { value: 'discard-this-unsaved-value' } });
  fireEvent.click(addButtons[0]!);
  await waitFor(() => expect(addButtons[0]!.getAttribute('aria-expanded')).toBe('true'));
  expect(await screen.findByLabelText('TOKEN')).toHaveProperty('value', '');
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
  expect(screen.getByLabelText('Secret reference')).toHaveProperty('value', reference);
  const update = vi.fn(async () => true);
  window.previewSecrets!.update = update;
  fireEvent.change(screen.getByLabelText('TOKEN'), { target: { value: 'SYNTHETIC_replacement_with_at_least_32_characters' } });
  fireEvent.click(screen.getByRole('button', { name: 'Replace value' }));
  await waitFor(() => expect(update).toHaveBeenCalledWith({ id: reference, value: 'SYNTHETIC_replacement_with_at_least_32_characters' }));
  await waitFor(() => expect(screen.queryByRole('form', { name: 'Replace secret value' })).toBeNull());
  expect(api.startApplicationPreview).not.toHaveBeenCalled();
  expect(api.approveApplicationPreview).not.toHaveBeenCalled();
});

it('carries a missing worktree inside the panel with Restore as the only primary and no Configuration tab', async () => {
  const stopped: PreviewStatus = { name: 'fixture', busy: false, latest: { ...initial.active!, type: 'environment', state: 'stopped' } };
  api.getApplicationPreview.mockResolvedValue({ name: 'fixture', hasConfigurationFile: false, status: stopped, restoredRun: true });
  const onRestoreWorktree = vi.fn(async () => undefined);
  render(<ApplicationPreviewPanel taskId="task" worktree={worktree('MISSING')} onRestoreWorktree={onRestoreWorktree} />);
  const block = await screen.findByRole('region', { name: 'Worktree missing' });
  expect(block.textContent).toContain('f390644');
  expect(block.textContent).toContain('Git checkout hooks');
  expect(screen.getAllByText('Worktree missing')).toHaveLength(2);
  const primaries = screen.getAllByRole('button').filter((button) => button.className.includes('primary-button'));
  expect(primaries.map((button) => button.textContent)).toEqual(['Restore worktree']);
  expect(screen.getByRole('tab', { name: 'Activity' })).toBeTruthy();
  expect(screen.queryByRole('tab', { name: 'Configuration' })).toBeNull();
  expect(screen.getByText('Stopped when Task Monki quit')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Restore worktree' }));
  expect(onRestoreWorktree).toHaveBeenCalledTimes(1);
  expect(api.startApplicationPreview).not.toHaveBeenCalled();
  expect(api.startRetainedApplicationPreview).not.toHaveBeenCalled();
});

it('opens a past run’s configuration read-only from the runs list and returns to the file', async () => {
  const stopped: PreviewStatus = { name: 'fixture', busy: false, latest: { ...initial.active!, type: 'environment', state: 'stopped', startedAt: '2026-10-09T13:58:00Z',
    services: { web: { type: 'command', state: 'stopped' } } } };
  api.getApplicationPreview.mockResolvedValue({ name: 'fixture', hasConfigurationFile: true, status: stopped });
  api.readApplicationPreviewFile.mockResolvedValue({ file: { name: 'preview.yaml', text: 'name: fixture\ntype: command\ncwd: .\ncommand: [node, server.js]\n' } });
  render(<ApplicationPreviewPanel taskId="task" worktree={worktree('PRESENT')} />);
  fireEvent.click(await screen.findByRole('button', { name: /Run configuration at/ }));
  const view = await screen.findByLabelText('Configuration used for this run');
  expect(view.textContent).toContain('read-only');
  expect(await screen.findByRole('region', { name: 'Services' })).toBeTruthy();
  expect(view.querySelector('textarea')).toBeNull();
  expect(screen.getByRole('tab', { name: 'Configuration' }).getAttribute('aria-selected')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Back to preview.yaml' }));
  await waitFor(() => expect(api.readApplicationPreviewFile).toHaveBeenCalledWith({ taskId: 'task' }));
  expect(await screen.findByText('preview.yaml')).toBeTruthy();
  expect(screen.queryByLabelText('Configuration used for this run')).toBeNull();
});

it('restores a docked Preview agent the person left open without taking focus from the page', async () => {
  persistPreviewAgentOpen(true);
  const stopped: PreviewStatus = { name: 'fixture', busy: false, latest: { ...initial.active!, type: 'environment', state: 'stopped' } };
  api.getApplicationPreview.mockResolvedValue({ name: 'fixture', hasConfigurationFile: true, status: stopped });
  render(<ApplicationPreviewPanel taskId="task" worktree={worktree('PRESENT')} agent={agentConversation()} proposals={proposalActions({ taskId: 'task', status: 'EMPTY' })} />);
  const panel = await screen.findByRole('complementary', { name: 'Preview agent conversation' });
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  expect(panel.contains(document.activeElement)).toBe(false);
});

it('opens the Preview agent from its own button, sends with the selected model, queues behind a turn, and stops it', async () => {
  const stopped: PreviewStatus = { name: 'fixture', busy: false, latest: { ...initial.active!, type: 'environment', state: 'stopped' } };
  api.getApplicationPreview.mockResolvedValue({ name: 'fixture', hasConfigurationFile: true, status: stopped });
  const agent = agentConversation();
  const view = render(<ApplicationPreviewPanel taskId="task" worktree={worktree('PRESENT')} agent={agent} proposals={proposalActions({ taskId: 'task', status: 'EMPTY' })} />);
  const toggle = await screen.findByRole('button', { name: 'Agent' });
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(toggle);
  const panel = await screen.findByRole('complementary', { name: 'Preview agent conversation' });
  expect(panel.textContent).toContain('Scenario model');
  // Opened by the person, the docked panel takes focus in its composer.
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Ask about the preview or request a configuration…' })));
  fireEvent.click(screen.getByRole('tab', { name: 'Logs' }));
  expect(screen.getByRole('complementary', { name: 'Preview agent conversation' })).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox', { name: 'Ask about the preview or request a configuration…' }), { target: { value: 'Add a Redis service' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(agent.send).toHaveBeenCalledWith('Add a Redis service', expect.any(String), { runtimeId: 'codex', model: 'scenario-model', modelProvider: 'openai', reasoningEffort: 'low' }));
  expect(api.startApplicationPreview).not.toHaveBeenCalled();

  // While the agent works, the composer queues and Stop interrupts; the model cannot change mid-turn.
  const working = agentConversation({
    runs: [previewRun('RUNNING')],
    instructions: [previewMessage('m1', 'Add a Redis service', 'SUBMITTED', 'preview-run'), previewMessage('m2', 'Also a worker', 'QUEUED')]
  });
  view.rerender(<ApplicationPreviewPanel taskId="task" worktree={worktree('PRESENT')} agent={working} proposals={proposalActions({ taskId: 'task', status: 'EMPTY' })} />);
  expect(screen.getByRole('list', { name: 'Pending instructions' }).textContent).toContain('Also a worker');
  expect(screen.getByRole('button', { name: 'Queue' })).toBeTruthy();
  expect((screen.getByRole('button', { name: /^Preview agent model:/ }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  await waitFor(() => expect(working.stop).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: 'Remove instruction 1' }));
  await waitFor(() => expect(working.editQueued).toHaveBeenCalledWith('m2'));

  // Docked beside the Preview it is part of the page: Escape elsewhere leaves it open, Escape inside closes it.
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.getByRole('complementary', { name: 'Preview agent conversation' })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Queue a message for after this response' }), { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Preview agent conversation' })).toBeNull());
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Agent' }));
  expect(screen.getByRole('button', { name: 'Agent' }).getAttribute('aria-pressed')).toBe('false');
  // Closed while the agent works, the entry still says so.
  expect(screen.getByRole('button', { name: 'Agent' }).getAttribute('aria-describedby')).toBe(screen.getByText('Agent working').id);
  expect(api.cancelApplicationPreview).not.toHaveBeenCalled();
});

it('offers the retained run as the primary when the file is gone and shows its configuration read-only', async () => {
  const stopped: PreviewStatus = { name: 'fixture', busy: false, latest: { ...initial.active!, type: 'environment', state: 'stopped', services: { web: { type: 'command', state: 'stopped' } } } };
  api.getApplicationPreview.mockResolvedValue({ name: 'fixture', hasConfigurationFile: false, status: stopped });
  api.startRetainedApplicationPreview.mockResolvedValue(undefined);
  render(<ApplicationPreviewPanel taskId="task" worktree={worktree('PRESENT')} agent={agentConversation()} proposals={proposalActions({ taskId: 'task', status: 'EMPTY' })} />);
  const block = await screen.findByRole('region', { name: 'Configuration file missing' });
  expect(screen.getByRole('button', { name: 'Start from last run' }).className).toContain('primary-button');
  expect(screen.getByRole('button', { name: 'Draft with Preview agent' }).className).not.toContain('primary-button');
  fireEvent.click(block.querySelector('button')!);
  expect((await screen.findByLabelText('Configuration used for this run')).textContent).toContain('read-only');
  fireEvent.click(screen.getByRole('button', { name: 'Start from last run' }));
  await waitFor(() => expect(api.startRetainedApplicationPreview).toHaveBeenCalledWith({ taskId: 'task' }));
  expect(api.approveApplicationPreview).not.toHaveBeenCalled();
});


it('continues the saved Preview model before its catalog loads and leaves provider selection usable when that runtime is unavailable', async () => {
  api.getApplicationPreview.mockResolvedValue({ name: 'fixture', hasConfigurationFile: false });
  const agent = agentConversation({ runs: [previewRun('COMPLETED')], models: [] });
  const view = render(<ApplicationPreviewPanel taskId="task" worktree={worktree('PRESENT')} agent={agent} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Agent' }));
  expect(screen.getByRole('button', { name: /Preview agent model:.*scenario-model/ })).toBeTruthy();
  fireEvent.change(screen.getByRole('textbox', { name: 'Ask for a change or an explanation…' }), { target: { value: 'Continue our previous conversation.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(agent.send).toHaveBeenCalledWith('Continue our previous conversation.', expect.any(String), expect.objectContaining({ model: 'scenario-model', modelProvider: 'openai' })));
  view.rerender(<ApplicationPreviewPanel taskId="task" worktree={worktree('PRESENT')} agent={{ ...agent, runtimes: [{ ...codexRuntime, preflight: { ...codexRuntime.preflight, readiness: createRuntimeReadiness('DISABLED', 'Connection unavailable.') } }] }} />);
  expect((screen.getByRole('button', { name: /Preview agent model:/ }) as HTMLButtonElement).disabled).toBe(false);
});


it('selects the exact log run when two attempts have the same displayed time', async () => {
  api.readApplicationPreviewLogs.mockResolvedValue({ text: '', cursor: 0, truncated: false });
  const onSelect = vi.fn();
  render(<ApplicationLogs taskId="task" status={{ ...initial, latest: { ...initial.active!, id: 'failed', state: 'failed' } }} onSelect={onSelect} />);
  fireEvent.keyDown(screen.getByRole('button', { name: 'Log run' }), { key: 'ArrowDown' });
  const runs = screen.getAllByRole('menuitemradio');
  expect(runs.map((run) => run.getAttribute('aria-checked')).sort()).toEqual(['false', 'true']);
  fireEvent.click(runs.find((run) => run.getAttribute('aria-checked') === 'false')!);
  expect(onSelect).toHaveBeenCalledWith({ attemptId: 'failed' });
});

it('keeps start blockers in Activity only and leads there from the status row', async () => {
  const stopped: PreviewStatus = { name: 'fixture', busy: false, latest: { ...initial.active!, type: 'environment', state: 'stopped' } };
  api.getApplicationPreview.mockResolvedValue({ name: 'fixture', hasConfigurationFile: true, status: stopped,
    requirements: { secrets: [], connections: [], sources: [{ service: 'api', declaration: '../backend', directory: '/projects/backend', connected: false }] } });
  render(<ApplicationPreviewPanel taskId="task" worktree={worktree('PRESENT')} />);
  const block = await screen.findByRole('region', { name: 'Before this runs' });
  expect(block.closest('[role="tabpanel"]')?.id).toBe('preview-panel-Activity');
  fireEvent.click(screen.getByRole('tab', { name: 'Logs' }));
  expect(block.closest('[hidden]')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '1 to resolve' }));
  expect(screen.getByRole('tab', { name: 'Activity' }).getAttribute('aria-selected')).toBe('true');
  await waitFor(() => expect(document.activeElement).toBe(block.closest('[data-preview-attention]')));
  expect(api.startApplicationPreview).not.toHaveBeenCalled();
});

it('enters every missing value in one form, one reference after another', async () => {
  const references = ['fixture/dev/client-id', 'fixture/dev/client-secret'];
  const snapshot = (saved: number): ApplicationPreviewSnapshot => ({ name: 'fixture', hasConfigurationFile: true,
    requirements: { sources: [], connections: [], secrets: references.map((id, i) => ({ id, selected: false, bindings: [{ service: 'backend', key: i ? 'CLIENT_SECRET' : 'CLIENT_ID' }], availability: i < saved ? 'available' as const : 'missing' as const })) } });
  api.getApplicationPreview.mockResolvedValue(snapshot(0));
  // A saved value is available on the next poll; the form must keep the list it opened with.
  const create = vi.fn(async () => {
    api.getApplicationPreview.mockResolvedValue(snapshot(create.mock.calls.length));
  });
  window.previewSecrets = { status: vi.fn(async () => ({ state: 'unlocked' })), has: vi.fn(async () => false), create } as unknown as PreviewSecretsApi;
  try {
    render(<ApplicationPreviewPanel taskId="task" worktree={worktree('PRESENT')} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add all values' }));
    fireEvent.change(await screen.findByLabelText('CLIENT_ID'), { target: { value: 'synthetic-id' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));
    const polls = api.getApplicationPreview.mock.calls.length;
    await waitFor(() => expect(api.getApplicationPreview.mock.calls.length).toBeGreaterThan(polls + 1), { timeout: 3000 });
    expect(screen.getByText(/2 of 2/)).toBeTruthy();
    expect(screen.queryByLabelText('Secret reference')).toBeNull();
    fireEvent.change(await screen.findByLabelText('CLIENT_SECRET'), { target: { value: 'synthetic-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));
    await waitFor(() => expect(screen.queryByLabelText('CLIENT_SECRET')).toBeNull());
    expect(create.mock.calls).toEqual([[{ id: references[0], value: 'synthetic-id' }], [{ id: references[1], value: 'synthetic-secret' }]]);
    expect(api.startApplicationPreview).not.toHaveBeenCalled();
  } finally {
    delete window.previewSecrets;
  }
});

it('opens the agent as a drawer when the Preview is narrow and returns focus to its entry on Escape', async () => {
  const stopped: PreviewStatus = { name: 'fixture', busy: false, latest: { ...initial.active!, type: 'environment', state: 'stopped' } };
  api.getApplicationPreview.mockResolvedValue({ name: 'fixture', hasConfigurationFile: true, status: stopped });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const width = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 700 } as DOMRect);
  try {
    render(<ApplicationPreviewPanel taskId="task" worktree={worktree('PRESENT')} agent={agentConversation()} proposals={proposalActions({ taskId: 'task', status: 'EMPTY' })} />);
    const toggle = await screen.findByRole('button', { name: 'Agent' });
    toggle.focus();
    fireEvent.click(toggle);
    const panel = await screen.findByRole('complementary', { name: 'Preview agent conversation' });
    expect(panel.closest('.tm-preview-agent-drawer')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Preview agent' })).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Preview agent conversation' })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(toggle));
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
  } finally {
    width.mockRestore();
    vi.unstubAllGlobals();
  }
});

it('opens and copies each service at its own routed host name, and Open app uses the primary host, never the numeric address', async () => {
  const route = 'tm-6ef76297-2457-4e2a-a3ad-a6d0cbac62b0';
  const host = (name: string) => `http://${route}--${name}.localhost:62492`;
  api.getApplicationPreview.mockResolvedValue({ name: 'fixture', hasConfigurationFile: true, status: { name: 'fixture', busy: false, url: 'http://127.0.0.1:62492', active: {
    ...initial.active!, type: 'environment', services: {
      api: { type: 'command', state: 'ready', browserUrl: host('api') },
      web: { type: 'command', state: 'ready', url: 'http://127.0.0.1:62492', browserUrl: host('web') },
      queue: { type: 'command', state: 'ready', browserUrl: host('queue') }
    } } } });
  api.openApplicationPreview.mockImplementation(async ({ service }: { service?: string }) => ({ url: service ? host(service) : 'http://127.0.0.1:62492', opened: true }));
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  try {
    render(<ApplicationPreviewPanel taskId="task" worktree={worktree('PRESENT')} />);
    const table = await screen.findByRole('region', { name: 'Preview services' });
    for (const name of ['api', 'web', 'queue']) {
      expect(within(table).getByTitle(host(name)).textContent).toBe(`tm-6ef7…--${name}.localhost:62492`);
      fireEvent.click(within(table).getByRole('button', { name: `Open ${name}` }));
      await waitFor(() => expect(api.openApplicationPreview).toHaveBeenLastCalledWith({ taskId: 'task', attemptId: 'serving', service: name }));
      fireEvent.click(within(table).getByRole('button', { name: `Copy address of ${name}` }));
      await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(host(name)));
    }
    // The primary's numeric address would be another origin than the one the app allows (CORS).
    expect(screen.queryByText('127.0.0.1:62492')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open app' }));
    await waitFor(() => expect(api.openApplicationPreview).toHaveBeenLastCalledWith({ taskId: 'task', attemptId: 'serving', service: 'web' }));
  } finally {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
});

it('reverts unsaved edits to the file without writing it', async () => {
  const text = 'name: fixture\ntype: command\ncwd: .\ncommand: [node, server.js]\n';
  api.getApplicationPreview.mockResolvedValue({ name: 'fixture', hasConfigurationFile: true, status: { name: 'fixture', busy: false, latest: { ...initial.active!, state: 'stopped' } } });
  api.readApplicationPreviewFile.mockResolvedValue({ file: { name: 'preview.yaml', text } });
  const onNotify = vi.fn();
  render(<ApplicationPreviewPanel taskId="task" worktree={worktree('PRESENT')} onNotify={onNotify} />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Configuration' }));
  fireEvent.click(await screen.findByRole('button', { name: 'YAML' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Preview YAML' }), { target: { value: `${text}# not wanted\n` } });
  fireEvent.click(await screen.findByRole('button', { name: 'Revert changes' }));
  await waitFor(() => expect((screen.getByRole('textbox', { name: 'Preview YAML' }) as HTMLTextAreaElement).value).toBe(text));
  expect(screen.queryByRole('button', { name: 'Revert changes' })).toBeNull();
  expect(onNotify).toHaveBeenCalledWith('Changes reverted');
  expect(api.saveApplicationPreviewFile).not.toHaveBeenCalled();
});
