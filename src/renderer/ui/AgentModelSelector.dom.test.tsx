import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeReadiness } from '../../core/agent/AgentRuntimeReadiness';
import { codexCapabilities } from '../../core/agent/codex/codexCapabilities';
import type { AgentModel, AgentRuntimeState } from '../../shared/contracts';
import { AgentModelSelector, AgentModelSetting } from './AgentModelSelector';

const model: AgentModel = {
  id: 'cursor-agent-acp:cursor/default',
  runtimeId: 'cursor-agent-acp',
  modelProvider: 'cursor',
  model: 'default',
  displayName: 'Auto',
  hidden: false,
  isDefault: true,
  supportedReasoningEfforts: [],
  serviceTiers: [],
  inputModalities: ['text']
};

const runtime: AgentRuntimeState = {
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
      modelCatalog: { maturity: 'experimental', activation: 'EXPLICIT' }
    }
  },
  models: [],
  refreshedAt: '2026-07-19T12:00:00.000Z'
};

describe('AgentModelSetting model discovery', () => {
  it('discovers models only after the operator requests it', () => {
    const discover = vi.fn(async () => undefined);
    render(
      <AgentModelSetting
        label="Implementation"
        runtimeId="cursor-agent-acp"
        modelId={model.id}
        models={[model]}
        runtimes={[runtime]}
        onDiscoverModels={discover}
        onSelectionChange={() => undefined}
      />
    );

    expect(discover).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Implementation: Cursor Agent · Auto' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Load models' }));
    expect(discover).toHaveBeenCalledOnce();
    expect(discover).toHaveBeenCalledWith('cursor-agent-acp');
  });

  it('shows the exact reason for a model that the workflow cannot use', () => {
    const onSelectionChange = vi.fn();
    const reason = 'This exact provider version and model failed Design verification.';
    render(
      <AgentModelSelector
        label="Design"
        runtimeId="cursor-agent-acp"
        modelId=""
        models={[model]}
        runtimes={[runtime]}
        modelUnavailableReason={() => reason}
        onSelectionChange={onSelectionChange}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Design: Cursor Agent' }));
    const option = screen.getByRole('menuitemradio', {
      name: `Auto Unavailable ${reason}`
    });

    expect(option).toHaveProperty('disabled', true);
    expect(screen.getByText(reason)).toBeTruthy();
    fireEvent.click(option);
    expect(onSelectionChange).not.toHaveBeenCalled();
  });
});
