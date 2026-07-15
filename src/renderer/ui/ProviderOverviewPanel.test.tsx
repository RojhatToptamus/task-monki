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
import { ProviderOverviewPanel } from './ProviderOverviewPanel';

describe('ProviderOverviewPanel', () => {
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
