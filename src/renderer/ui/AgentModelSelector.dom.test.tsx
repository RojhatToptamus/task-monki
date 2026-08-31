import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const readyRuntime: AgentRuntimeState = {
  ...runtime,
  preflight: {
    ...runtime.preflight,
    readiness: createRuntimeReadiness('READY', 'Cursor is ready.', {
      checks: { modelCatalog: 'AVAILABLE' }
    })
  }
};

describe('AgentModelSelector', () => {
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
    fireEvent.click(screen.getByRole('option', { name: 'Load models via Cursor Agent' }));
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
        runtimes={[readyRuntime]}
        modelUnavailableReason={() => reason}
        onSelectionChange={onSelectionChange}
      />
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Design: Cursor Agent · Provider default' })
    );
    const option = screen.getByRole('option', {
      name: `Auto via Cursor Agent, unavailable. ${reason}`
    });

    expect(option.getAttribute('aria-disabled')).toBe('true');
    expect(option.getAttribute('title')).toBe(reason);
    expect(screen.queryByText(reason)).toBeNull();
    fireEvent.click(option);
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it('searches model and provider names while keeping matching provider groups intact', () => {
    const cursorLarge: AgentModel = {
      ...model,
      id: 'cursor-agent-acp:cursor/large',
      model: 'large',
      displayName: 'Cursor Large',
      isDefault: false
    };
    const codexRuntime: AgentRuntimeState = {
      ...readyRuntime,
      preflight: {
        ...readyRuntime.preflight,
        runtime: {
          ...readyRuntime.preflight.runtime,
          id: 'codex',
          displayName: 'Codex'
        }
      }
    };
    const luna: AgentModel = {
      ...model,
      id: 'codex:gpt-5.6-luna',
      runtimeId: 'codex',
      modelProvider: 'openai',
      model: 'gpt-5.6-luna',
      displayName: 'Luna'
    };
    render(
      <AgentModelSelector
        label="Implementation"
        runtimeId={model.runtimeId}
        modelId={model.id}
        models={[model, cursorLarge, luna]}
        runtimes={[readyRuntime, codexRuntime]}
        onSelectionChange={() => undefined}
      />
    );

    const trigger = screen.getByRole('button', {
      name: 'Implementation: Cursor Agent · Auto'
    });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const search = screen.getByRole('combobox', {
      name: 'Search models and providers'
    });

    fireEvent.change(search, { target: { value: 'Codex' } });
    expect(screen.getByRole('option', { name: 'Luna via Codex' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Auto via Cursor Agent' })).toBeNull();

    fireEvent.change(search, { target: { value: 'Cursor Agent' } });
    expect(screen.getByRole('option', { name: 'Auto via Cursor Agent' })).toBeTruthy();
    expect(
      screen.getByRole('option', { name: 'Cursor Large via Cursor Agent' })
    ).toBeTruthy();

    fireEvent.change(search, { target: { value: 'not-a-model' } });
    expect(screen.getByText(/No model matches/u)).toBeTruthy();
  });

  it('keeps focus in search and selects available options with the keyboard', async () => {
    const onSelectionChange = vi.fn();
    const nextModel: AgentModel = {
      ...model,
      id: 'cursor-agent-acp:cursor/next',
      model: 'next',
      displayName: 'Next',
      isDefault: false
    };
    const blockedModel: AgentModel = {
      ...nextModel,
      id: 'cursor-agent-acp:cursor/blocked',
      model: 'blocked',
      displayName: 'Blocked'
    };
    render(
      <AgentModelSelector
        label="Implementation"
        runtimeId={model.runtimeId}
        modelId={model.id}
        models={[model, blockedModel, nextModel]}
        runtimes={[readyRuntime]}
        modelUnavailableReason={(candidate) =>
          candidate.id === blockedModel.id ? 'Not available for this workflow.' : undefined
        }
        onSelectionChange={onSelectionChange}
      />
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Implementation: Cursor Agent · Auto' })
    );
    const search = screen.getByRole('combobox', {
      name: 'Search models and providers'
    });
    await waitFor(() => expect(document.activeElement).toBe(search));

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(search.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'Next via Cursor Agent' }).id
    );
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: 'Enter' });

    expect(onSelectionChange).toHaveBeenCalledWith(model.runtimeId, nextModel.id);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Implementation: Cursor Agent · Auto' })
      )
    );
  });

  it('closes when its scrolling container moves', () => {
    render(
      <div data-testid="scroll-container" style={{ overflowY: 'auto' }}>
        <AgentModelSelector
          label="Implementation"
          runtimeId={model.runtimeId}
          modelId={model.id}
          models={[model]}
          runtimes={[readyRuntime]}
          onSelectionChange={() => undefined}
        />
      </div>
    );

    const trigger = screen.getByRole('button', {
      name: 'Implementation: Cursor Agent · Auto'
    });
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    fireEvent.scroll(screen.getByTestId('scroll-container'));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
});
