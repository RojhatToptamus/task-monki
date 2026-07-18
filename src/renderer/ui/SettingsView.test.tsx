import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TASK_MANAGER_APP_SETTINGS,
  type AgentModel,
  type AgentRuntimeState
} from '../../shared/contracts';
import { createRuntimeReadiness } from '../../core/agent/AgentRuntimeReadiness';
import {
  CODEX_RUNTIME_DESCRIPTOR,
  codexCapabilities
} from '../../core/agent/codex/codexCapabilities';
import {
  ModelSettingRow,
  SettingsView,
  describeExternalToolAvailability
} from './SettingsView';

const codexModel: AgentModel = {
  id: 'codex:test-model',
  runtimeId: 'codex',
  modelProvider: 'openai',
  model: 'test-model',
  displayName: 'Test model',
  hidden: false,
  isDefault: true,
  supportedReasoningEfforts: ['low', 'high', 'xhigh'],
  defaultReasoningEffort: 'low',
  serviceTiers: [],
  inputModalities: ['text']
};

const runtimes: AgentRuntimeState[] = [
  {
    preflight: {
      runtime: CODEX_RUNTIME_DESCRIPTOR,
      readiness: createRuntimeReadiness('READY', 'Ready'),
      capabilities: codexCapabilities()
    },
    models: [codexModel],
    refreshedAt: '2026-07-18T00:00:00.000Z'
  },
  {
    preflight: {
      runtime: {
        id: 'opencode',
        displayName: 'OpenCode',
        kind: 'HTTP_AGENT',
        transport: 'HTTP_SSE',
        lifecycleScope: 'SESSION'
      },
      readiness: createRuntimeReadiness('DISABLED', 'Disabled'),
      capabilities: { ...codexCapabilities(), runtimeId: 'opencode' }
    },
    models: [],
    refreshedAt: '2026-07-18T00:00:00.000Z'
  }
];

describe('SettingsView', () => {
  it('shows every agent with its independent enabled state', () => {
    const html = renderToStaticMarkup(
      <SettingsView
        theme="device"
        onSetTheme={() => undefined}
        appSettings={{
          ...DEFAULT_TASK_MANAGER_APP_SETTINGS,
          disabledRuntimeIds: ['opencode']
        }}
        onSetAppSettings={() => undefined}
        agentRuntimesLoading={false}
        onRefreshExternalTools={async () => {
          throw new Error('not called during render');
        }}
        onRefreshAgentRuntimes={async () => undefined}
        onTestExternalTool={async () => {
          throw new Error('not called during render');
        }}
        models={[codexModel]}
        runtimes={runtimes}
      />
    );

    expect(html).toContain('aria-label="Settings sections"');
    expect(html).toContain('>Agents<');
    expect(html).toContain('>Models<');
    expect(html).toContain('>Tools<');
    expect(html).toContain('>Appearance<');
    expect(html).toContain('aria-label="Codex enabled"');
    expect(html).toMatch(/aria-checked="true" aria-label="Codex enabled"/u);
    expect(html).toContain('Used by Implementation.');
    expect(html).toMatch(/aria-label="Codex enabled"[^>]*disabled=""/u);
    expect(html).toContain('aria-label="OpenCode enabled"');
    expect(html).toMatch(/aria-checked="false" aria-label="OpenCode enabled"/u);
    expect(html).not.toContain('Repository');
  });

  it('offers effort only when the selected model reports effort choices', () => {
    const withoutEffort = renderToStaticMarkup(
      <ModelSettingRow
        label="Implementation"
        runtimeId="codex"
        value="codex:no-effort"
        models={[
          {
            ...codexModel,
            id: 'codex:no-effort',
            model: 'no-effort',
            supportedReasoningEfforts: [],
            defaultReasoningEffort: undefined
          }
        ]}
        runtimes={runtimes.slice(0, 1)}
        onRuntimeChange={() => undefined}
        onModelChange={() => undefined}
        onEffortChange={() => undefined}
      />
    );
    const withEffort = renderToStaticMarkup(
      <ModelSettingRow
        label="Implementation"
        runtimeId="codex"
        value={codexModel.id}
        effortValue="low"
        models={[codexModel]}
        runtimes={runtimes.slice(0, 1)}
        onRuntimeChange={() => undefined}
        onModelChange={() => undefined}
        onEffortChange={() => undefined}
      />
    );

    expect(withoutEffort).not.toContain('>Effort<');
    expect(withEffort).toContain('>Effort<');
    expect(withEffort).toContain('<option value="high">High</option>');
    expect(withEffort).toContain('<option value="xhigh">X-high</option>');
  });

  it('does not offer a model for an unavailable purpose runtime', () => {
    const html = renderToStaticMarkup(
      <ModelSettingRow
        label="Prompt refinement"
        runtimeId="codex"
        value={codexModel.id}
        models={[codexModel]}
        runtimes={[]}
        onRuntimeChange={() => undefined}
        onModelChange={() => undefined}
        onEffortChange={() => undefined}
      />
    );

    expect(html).toContain('Not available');
    expect(html).not.toContain('Test model');
    expect(html).not.toContain('>Effort<');
    expect(html.match(/disabled=""/gu)).toHaveLength(2);
  });

  it('renders intentional agent catalog loading and empty states', () => {
    const renderCatalogState = (agentRuntimesLoading: boolean) =>
      renderToStaticMarkup(
        <SettingsView
          theme="device"
          onSetTheme={() => undefined}
          appSettings={DEFAULT_TASK_MANAGER_APP_SETTINGS}
          onSetAppSettings={() => undefined}
          agentRuntimesLoading={agentRuntimesLoading}
          onRefreshExternalTools={async () => undefined}
          onRefreshAgentRuntimes={async () => undefined}
          onTestExternalTool={async () => {
            throw new Error('not called during render');
          }}
          models={[]}
          runtimes={[]}
        />
      );

    const loading = renderCatalogState(true);
    const empty = renderCatalogState(false);
    expect(loading).toContain('role="status"');
    expect(loading).toContain('Checking agents…');
    expect(empty).toContain('No agent runtimes found.');
    expect(empty).not.toContain('role="status"');
  });

  it('keeps unchecked tool status neutral', () => {
    expect(describeExternalToolAvailability(undefined)).toEqual({
      tone: 'muted',
      label: 'Not checked'
    });
  });
});
