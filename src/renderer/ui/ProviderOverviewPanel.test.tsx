import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  acpCapabilities,
  GROK_ACP_PROFILE
} from '../../core/agent/acp/AcpRuntimeProfiles';
import type {
  AgentRuntimeState,
  AgentServerInstance,
  AgentSessionRecord,
  Task
} from '../../shared/contracts';
import { taskGoal } from '../../shared/promptTemplates';
import { ProviderOverviewPanel } from './ProviderOverviewPanel';

describe('ProviderOverviewPanel', () => {
  it('compares the provider goal with the goal of a task opened from an issue, which has no request of its own', () => {
    const task = {
      id: 'task-1', prompt: '', runtimeId: 'codex',
      remoteSource: {
        provider: 'GITHUB', host: 'github.com', repositoryPath: 'acme/widgets', kind: 'ISSUE', number: 12,
        url: 'https://github.com/acme/widgets/issues/12', title: 'Crash on save',
        snapshotArtifactId: '6f1c2a5e-8f0e-4c4e-9a52-3d1f0b7c9e21', capturedAt: '2026-07-01T00:00:00.000Z'
      }
    } as Task;
    const session = { id: 'session-1', taskId: task.id, runtimeId: 'codex', providerSessionId: 'thread-1', status: 'IDLE' } as AgentSessionRecord;
    // An earlier sync set the goal; the latest attempt failed, so the goal diagnostics show.
    const html = renderToStaticMarkup(
      <ProviderOverviewPanel
        task={task}
        session={session}
        goalSnapshots={[{
          id: 'goal-1', taskId: task.id, iterationId: 'iteration-1', sessionId: session.id, runtimeId: 'codex',
          taskGoalHash: 'a'.repeat(64), providerObjective: taskGoal(task), syncState: 'SYNC_FAILED', source: 'SYNC_ERROR',
          detail: 'The provider did not answer.', observedAt: '2026-07-01T00:00:00.000Z'
        }]}
        usageSnapshots={[]}
        settingsObservations={[]}
        onSyncGoal={async () => undefined}
        onUpdateNativeSession={async () => undefined}
      />
    );

    expect(html).toContain(`<span class="provider-kv__text">${taskGoal(task)}</span><small>Authoritative task goal</small>`);
    expect(html).toContain('acme/widgets#12');
    expect(html).toContain('Matches the Task Monki goal');
  });

  it('renders runtime resolution diagnostics with rejected candidates', () => {
    const task = { id: 'task-1', prompt: 'Investigate Codex runtime.' } as Task;
    const server: AgentServerInstance = {
      id: 'server-1',
      runtimeId: 'codex',
      runtimeKind: 'APP_SERVER',
      transport: 'STDIO',
      status: 'READY',
      executable: '/Applications/Codex.app/Contents/Resources/codex',
      argv: ['app-server', '--stdio'],
      runtimeVersion: '0.142.4',
      schemaVersion: '0.141.0',
      schemaHash: 'schema-hash',
      protocolJournalPath: '/tmp/task-monki/codex.journal',
      startedAt: '2026-07-01T00:00:00.000Z',
      runtimeResolution: {
        selectedExecutable: '/Applications/Codex.app/Contents/Resources/codex',
        selectedSource: 'codex-app-bundle',
        selectedVersion: '0.142.4',
        selectedLaunchArgv: ['app-server', '--stdio'],
        requiredCapabilities: ['thread/start', 'turn/start', 'review/start'],
        probes: [
          {
            executable: '/opt/homebrew/bin/codex',
            source: 'path',
            explicit: false,
            compatible: false,
            version: '0.22.0',
            detail: 'Codex App Server command or stdio transport was not detected.'
          },
          {
            executable: '/Applications/Codex.app/Contents/Resources/codex',
            source: 'codex-app-bundle',
            explicit: false,
            compatible: true,
            version: '0.142.4',
            launchArgv: ['app-server', '--stdio'],
            launchForm: 'stdio-flag',
            detail: 'Compatible Codex App Server via stdio-flag.'
          }
        ]
      }
    };

    const html = renderToStaticMarkup(
      <ProviderOverviewPanel
        task={task}
        goalSnapshots={[]}
        usageSnapshots={[]}
        settingsObservations={[]}
        server={server}
        onSyncGoal={async () => undefined}
        onUpdateNativeSession={async () => undefined}
      />
    );

    expect(html).toContain('Runtime probes');
    expect(html).toContain('1 rejected');
    expect(html).toContain('/opt/homebrew/bin/codex');
    expect(html).toContain('Codex App Server command or stdio transport was not detected.');
    expect(html).toContain('/Applications/Codex.app/Contents/Resources/codex');
  });

  it('renders only provider-advertised native session controls', () => {
    const task = {
      id: 'task-1',
      prompt: 'Use the provider-native model.',
      runtimeId: 'grok-acp'
    } as Task;
    const session = {
      id: 'local-session-1',
      taskId: task.id,
      runtimeId: 'grok-acp',
      providerSessionId: 'provider-session-1',
      status: 'IDLE'
    } as AgentSessionRecord;
    const runtimeState = {
      preflight: {
        runtime: {
          id: 'grok-acp',
          displayName: 'Grok Build',
          kind: 'ACP_AGENT',
          transport: 'STDIO',
          lifecycleScope: 'APPLICATION'
        },
        readiness: {
          status: 'READY',
          canStart: true,
          summary: 'Ready',
          detail: 'Provider session established.',
          checks: {
            discovery: 'FOUND',
            compatibility: 'COMPATIBLE',
            initialization: 'INITIALIZED',
            authentication: 'PROVIDER_MANAGED',
            modelCatalog: 'AVAILABLE'
          },
          diagnostics: []
        },
        capabilities: acpCapabilities(GROK_ACP_PROFILE)
      },
      models: [],
      sessionControls: [{
        localSessionId: session.id,
        providerSessionId: session.providerSessionId,
        revision: 'revision-1',
        controls: [
          {
            id: 'model', label: 'Model', kind: 'SELECT', value: 'grok-build', mutable: true,
            choices: [
              { value: 'grok-build', label: 'Grok Build' },
              { value: 'grok-composer', label: 'Composer' }
            ]
          },
          {
            id: 'mode', label: 'Mode', kind: 'SELECT', value: 'code', mutable: true,
            choices: [{ value: 'code', label: 'Code' }]
          },
          {
            id: 'config:telemetry', label: 'Telemetry', kind: 'BOOLEAN', value: true,
            mutable: true
          }
        ]
      }],
      refreshedAt: new Date(0).toISOString()
    } as AgentRuntimeState;

    const html = renderToStaticMarkup(
      <ProviderOverviewPanel
        task={task}
        session={session}
        goalSnapshots={[]}
        usageSnapshots={[]}
        settingsObservations={[]}
        runtimeState={runtimeState}
        onSyncGoal={async () => undefined}
        onUpdateNativeSession={async () => undefined}
      />
    );

    expect(html).toContain('Native session controls');
    expect(html).toContain('Grok Build');
    expect(html).toContain('Composer');
    expect(html).toContain('Code');
    expect(html).toContain('Telemetry');
  });
});
