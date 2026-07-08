import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentServerInstance, Task } from '../../shared/contracts';
import { ProviderOverviewPanel } from './ProviderOverviewPanel';

describe('ProviderOverviewPanel', () => {
  it('renders runtime resolution diagnostics with rejected candidates', () => {
    const task = { id: 'task-1', prompt: 'Investigate Codex runtime.' } as Task;
    const server: AgentServerInstance = {
      id: 'server-1',
      provider: 'codex',
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
      />
    );

    expect(html).toContain('Runtime probes');
    expect(html).toContain('1 rejected');
    expect(html).toContain('/opt/homebrew/bin/codex');
    expect(html).toContain('Codex App Server command or stdio transport was not detected.');
    expect(html).toContain('/Applications/Codex.app/Contents/Resources/codex');
  });
});
