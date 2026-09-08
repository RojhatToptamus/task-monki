import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeReadiness } from '../../core/agent/AgentRuntimeReadiness';
import {
  CODEX_RUNTIME_DESCRIPTOR,
  codexCapabilities
} from '../../core/agent/codex/codexCapabilities';
import {
  DEFAULT_TASK_MANAGER_APP_SETTINGS,
  type AgentModel,
  type ExternalToolProbeResult
} from '../../shared/contracts';
import { FirstLaunchSetup } from './FirstLaunchSetup';

const model: AgentModel = {
  id: 'codex:test-model',
  runtimeId: 'codex',
  modelProvider: 'openai',
  model: 'test-model',
  displayName: 'Test model',
  hidden: false,
  isDefault: true,
  supportedReasoningEfforts: ['low'],
  defaultReasoningEffort: 'low',
  serviceTiers: [],
  inputModalities: ['text']
};

const tool = (
  id: ExternalToolProbeResult['tool'],
  label: string,
  required: boolean
): ExternalToolProbeResult => ({
  tool: id,
  label,
  required,
  source: 'auto',
  configuredPath: null,
  executable: id,
  resolvedPath: `/usr/bin/${id}`,
  status: 'ok',
  version: `${id} 1.2.3`,
  error: null
});

describe('FirstLaunchSetup', () => {
  it('lets a user enter Designs while repository setup remains incomplete', () => {
    const onGoToDesigns = vi.fn();
    const onAddRepository = vi.fn(async () => true);
    render(
      <FirstLaunchSetup
        state="needsRepository"
        addingRepository={false}
        appSettings={DEFAULT_TASK_MANAGER_APP_SETTINGS}
        externalToolStatus={{
          refreshedAt: '2026-09-02T12:00:00.000Z',
          tools: {
            git: tool('git', 'Git', true),
            codex: tool('codex', 'Codex', true),
            gh: tool('gh', 'GitHub CLI', false)
          }
        }}
        models={[model]}
        runtimes={[
          {
            preflight: {
              runtime: CODEX_RUNTIME_DESCRIPTOR,
              readiness: createRuntimeReadiness('READY', 'Ready'),
              capabilities: codexCapabilities(),
              runtimeVersion: '0.151.0'
            },
            models: [model],
            refreshedAt: '2026-09-02T12:00:00.000Z'
          }
        ]}
        activeRepositoryPath=""
        onAddRepository={onAddRepository}
        onFinishSetup={async () => undefined}
        onGoToDesigns={onGoToDesigns}
        onRefreshExternalTools={async () => undefined}
        onDiscoverAgentRuntimeModels={async () => undefined}
        onSetAppSettings={() => undefined}
      />
    );

    expect(screen.getByText('No repository yet')).toBeTruthy();
    expect(screen.getByText('Design projects do not need one.')).toBeTruthy();
    expect(screen.getByText('Default model')).toBeTruthy();
    expect(screen.getByText('Needs on this machine')).toBeTruthy();
    expect(
      within(screen.getByLabelText('Needs on this machine')).getAllByText('Codex')
    ).toHaveLength(1);
    expect(
      screen.getByRole('button', { name: 'Finish setup' }).hasAttribute('disabled')
    ).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go to Designs' }));

    expect(onAddRepository).toHaveBeenCalledOnce();
    expect(onGoToDesigns).toHaveBeenCalledOnce();
  });
});
