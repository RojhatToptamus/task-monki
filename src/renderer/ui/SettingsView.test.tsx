import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
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
  SettingsView,
  describeExternalToolAvailability,
  selectSettingsModels
} from './SettingsView';
import { AgentModelSetting, agentModelMenuGeometry } from './AgentModelSelector';

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
  it('constrains compact model menus to their scroll sheet', () => {
    expect(agentModelMenuGeometry({
      trigger: { top: 540, right: 292, bottom: 568 },
      boundary: { top: 180, right: 312, bottom: 608, left: 68 },
      constrainWidth: true
    })).toEqual({ placement: 'top', maxHeight: 320, maxWidth: 220 });
    expect(agentModelMenuGeometry({
      trigger: { top: 210, right: 292, bottom: 238 },
      boundary: { top: 180, right: 312, bottom: 608, left: 68 },
      constrainWidth: true
    })).toEqual({ placement: 'bottom', maxHeight: 320, maxWidth: 220 });
  });

  it('shows every agent with its independent enabled state', () => {
    const discoverAgentRuntimeModels = vi.fn(async () => undefined);
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
        onDiscoverAgentRuntimeModels={discoverAgentRuntimeModels}
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
    expect(discoverAgentRuntimeModels).not.toHaveBeenCalled();
  });

  it('offers effort only when the selected model reports effort choices', () => {
    const withoutEffort = renderToStaticMarkup(
      <AgentModelSetting
        label="Implementation"
        runtimeId="codex"
        modelId="codex:no-effort"
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
        onSelectionChange={() => undefined}
        onReasoningEffortChange={() => undefined}
      />
    );
    const withEffort = renderToStaticMarkup(
      <AgentModelSetting
        label="Implementation"
        runtimeId="codex"
        modelId={codexModel.id}
        reasoningEffort="low"
        models={[codexModel]}
        runtimes={runtimes.slice(0, 1)}
        onSelectionChange={() => undefined}
        onReasoningEffortChange={() => undefined}
      />
    );

    expect(withoutEffort).not.toContain('>Reasoning<');
    expect(withEffort).toContain('>Reasoning<');
    expect(withEffort).toContain('>High</small>');
    expect(withEffort).toContain('>X-high</small>');

    const providerDefault = renderToStaticMarkup(
      <AgentModelSetting
        label="Implementation"
        runtimeId="codex"
        modelId="codex:no-effort-default"
        reasoningEffort=""
        models={[
          {
            ...codexModel,
            id: 'codex:no-effort-default',
            model: 'no-effort-default',
            defaultReasoningEffort: undefined
          }
        ]}
        runtimes={runtimes}
        onSelectionChange={() => undefined}
        onReasoningEffortChange={() => undefined}
      />
    );
    expect(providerDefault).toContain('>Default</small>');
  });

  it('offers explicit model loading without starting discovery during render', () => {
    const discoverModels = vi.fn(async () => undefined);
    const html = renderToStaticMarkup(
      <AgentModelSetting
        label="Implementation"
        runtimeId="cursor-agent-acp"
        modelId="cursor-agent-acp:cursor/default"
        models={[
          {
            ...codexModel,
            id: 'cursor-agent-acp:cursor/default',
            runtimeId: 'cursor-agent-acp',
            modelProvider: 'cursor',
            model: 'default',
            displayName: 'Auto',
            supportedReasoningEfforts: [],
            defaultReasoningEffort: undefined
          }
        ]}
        runtimes={[
          {
            preflight: {
              runtime: {
                id: 'cursor-agent-acp',
                displayName: 'Cursor Agent',
                kind: 'ACP_AGENT',
                transport: 'STDIO',
                lifecycleScope: 'APPLICATION'
              },
              readiness: createRuntimeReadiness('DISCOVERED', 'Cursor is available.'),
              capabilities: {
                ...codexCapabilities(),
                runtimeId: 'cursor-agent-acp',
                modelCatalog: {
                  maturity: 'experimental',
                  activation: 'EXPLICIT'
                }
              }
            },
            models: [],
            refreshedAt: '2026-07-18T00:00:00.000Z'
          }
        ]}
        onDiscoverModels={discoverModels}
        onSelectionChange={() => undefined}
      />
    );

    expect(html).toContain('>Load models<');
    expect(discoverModels).not.toHaveBeenCalled();
  });

  it('does not offer a model for an unavailable purpose runtime', () => {
    const html = renderToStaticMarkup(
      <AgentModelSetting
        label="Prompt refinement"
        runtimeId="codex"
        modelId={codexModel.id}
        models={[codexModel]}
        runtimes={[]}
        onSelectionChange={() => undefined}
        onReasoningEffortChange={() => undefined}
      />
    );

    expect(html).toContain('No agent available');
    expect(html).toContain('No agent supports this operation.');
    expect(html).not.toContain('Test model');
    expect(html).not.toContain('>Reasoning<');
    expect(html.match(/disabled=""/gu)).toHaveLength(1);
  });

  it('selects refinement and review models from any capable enabled runtime', () => {
    const providerModel: AgentModel = {
      ...codexModel,
      id: 'provider-runtime:provider/model',
      runtimeId: 'provider-runtime',
      modelProvider: 'provider',
      model: 'model',
      displayName: 'Provider model'
    };
    const providerRuntime: AgentRuntimeState = {
      preflight: {
        runtime: {
          id: 'provider-runtime',
          displayName: 'Provider runtime',
          kind: 'HTTP_AGENT',
          transport: 'HTTP_SSE',
          lifecycleScope: 'APPLICATION'
        },
        readiness: createRuntimeReadiness('READY', 'Ready'),
        capabilities: {
          ...codexCapabilities(),
          runtimeId: 'provider-runtime',
          review: { maturity: 'unsupported' },
          detachedReview: { maturity: 'stable' }
        }
      },
      models: [providerModel],
      refreshedAt: '2026-07-18T00:00:00.000Z'
    };

    const selected = selectSettingsModels(
      [codexModel, providerModel],
      [runtimes[0]!, providerRuntime],
      {
        ...DEFAULT_TASK_MANAGER_APP_SETTINGS,
        promptRefinementRuntimeId: 'provider-runtime',
        promptRefinementModel: 'model',
        promptRefinementModelProvider: 'provider',
        reviewRuntimeId: 'provider-runtime',
        reviewModel: 'model',
        reviewModelProvider: 'provider'
      }
    );

    expect(selected.promptRefinementRuntimeId).toBe('provider-runtime');
    expect(selected.selectedPromptRefinementModel?.id).toBe(providerModel.id);
    expect(selected.reviewRuntimeId).toBe('provider-runtime');
    expect(selected.selectedReviewModel?.id).toBe(providerModel.id);
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
          onDiscoverAgentRuntimeModels={async () => undefined}
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
