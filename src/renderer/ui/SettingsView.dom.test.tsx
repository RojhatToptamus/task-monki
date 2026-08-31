import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TASK_MANAGER_APP_SETTINGS,
  type AgentModel,
  type AgentRuntimeState,
  type TaskManagerAppSettings
} from '../../shared/agent';
import { createRuntimeReadiness } from '../../core/agent/AgentRuntimeReadiness';
import {
  CODEX_RUNTIME_DESCRIPTOR,
  codexCapabilities
} from '../../core/agent/codex/codexCapabilities';
import { SettingsView, type SettingsViewProps } from './SettingsView';
import type { SoftwareUpdateState } from '../../shared/softwareUpdate';

const softwareUpdateState: SoftwareUpdateState = {
  status: 'idle',
  currentVersion: '0.2.0',
  availableVersion: null,
  lastCheckedAt: null,
  progress: null,
  errorMessage: null
};

function renderSettings({
  appSettings = DEFAULT_TASK_MANAGER_APP_SETTINGS,
  onSetTheme = vi.fn(),
  onSetAppSettings = vi.fn(),
  onPreviewThemePreset = vi.fn(),
  updateState = softwareUpdateState,
  onCheckForSoftwareUpdates = vi.fn(async () => undefined),
  onDownloadSoftwareUpdate = vi.fn(async () => undefined),
  onInstallSoftwareUpdate = vi.fn(async () => undefined),
  models = [],
  runtimes = []
}: {
  appSettings?: TaskManagerAppSettings;
  onSetTheme?: SettingsViewProps['onSetTheme'];
  onSetAppSettings?: SettingsViewProps['onSetAppSettings'];
  onPreviewThemePreset?: NonNullable<SettingsViewProps['onPreviewThemePreset']>;
  updateState?: SoftwareUpdateState;
  onCheckForSoftwareUpdates?: SettingsViewProps['onCheckForSoftwareUpdates'];
  onDownloadSoftwareUpdate?: SettingsViewProps['onDownloadSoftwareUpdate'];
  onInstallSoftwareUpdate?: SettingsViewProps['onInstallSoftwareUpdate'];
  models?: AgentModel[];
  runtimes?: AgentRuntimeState[];
} = {}) {
  render(
    <SettingsView
      theme="device"
      onSetTheme={onSetTheme}
      onPreviewThemePreset={onPreviewThemePreset}
      appSettings={appSettings}
      onSetAppSettings={onSetAppSettings}
      softwareUpdateState={updateState}
      onCheckForSoftwareUpdates={onCheckForSoftwareUpdates}
      onDownloadSoftwareUpdate={onDownloadSoftwareUpdate}
      onInstallSoftwareUpdate={onInstallSoftwareUpdate}
      agentRuntimesLoading={false}
      onRefreshExternalTools={async () => undefined}
      onRefreshAgentRuntimes={async () => undefined}
      onDiscoverAgentRuntimeModels={async () => undefined}
      onTestExternalTool={async () => {
        throw new Error('not called');
      }}
      models={models}
      runtimes={runtimes}
    />
  );
  return {
    onSetTheme,
    onSetAppSettings,
    onPreviewThemePreset,
    onCheckForSoftwareUpdates,
    onDownloadSoftwareUpdate,
    onInstallSoftwareUpdate
  };
}

const previewModel: AgentModel = {
  id: 'codex:preview-model',
  runtimeId: 'codex',
  modelProvider: 'openai',
  model: 'preview-model',
  displayName: 'Preview model',
  hidden: false,
  isDefault: true,
  supportedReasoningEfforts: [],
  serviceTiers: [],
  inputModalities: ['text']
};

const readyCodexRuntime: AgentRuntimeState = {
  preflight: {
    runtime: CODEX_RUNTIME_DESCRIPTOR,
    readiness: createRuntimeReadiness('READY', 'Ready'),
    capabilities: codexCapabilities()
  },
  models: [previewModel],
  refreshedAt: '2026-08-31T00:00:00.000Z'
};

describe('Model settings', () => {
  it('stores the Preview generation runtime and model together', () => {
    const onSetAppSettings = vi.fn();
    renderSettings({
      onSetAppSettings,
      models: [previewModel],
      runtimes: [readyCodexRuntime]
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Models' }));
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Preview generation: Codex · Preview model'
      })
    );
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Preview model/u }));

    expect(onSetAppSettings).toHaveBeenCalledWith({
      previewRecipeGenerationRuntimeId: 'codex',
      previewRecipeGenerationModel: 'preview-model',
      previewRecipeGenerationModelProvider: 'openai'
    });
  });

  it('shows a missing saved Preview model instead of displaying a fallback', () => {
    renderSettings({
      appSettings: {
        ...DEFAULT_TASK_MANAGER_APP_SETTINGS,
        previewRecipeGenerationRuntimeId: 'codex',
        previewRecipeGenerationModel: 'removed-model',
        previewRecipeGenerationModelProvider: 'openai'
      },
      models: [previewModel],
      runtimes: [readyCodexRuntime]
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Models' }));

    const trigger = screen.getByRole('button', {
      name: 'Preview generation: Codex · removed-model'
    });
    expect(trigger.getAttribute('aria-invalid')).toBe('true');
    expect(
      screen.getByText(
        'The selected Preview agent or model is no longer available. Choose another selection.'
      )
    ).not.toBeNull();
  });

  it('shows the configured Preview agent readiness error before a missing model error', () => {
    const authenticationDetail = 'Sign in to the configured agent, then try again.';
    renderSettings({
      appSettings: {
        ...DEFAULT_TASK_MANAGER_APP_SETTINGS,
        previewRecipeGenerationRuntimeId: 'codex',
        previewRecipeGenerationModel: 'saved-model',
        previewRecipeGenerationModelProvider: 'openai'
      },
      models: [],
      runtimes: [
        {
          ...readyCodexRuntime,
          preflight: {
            ...readyCodexRuntime.preflight,
            readiness: createRuntimeReadiness(
              'AUTHENTICATION_REQUIRED',
              authenticationDetail
            )
          },
          models: []
        }
      ]
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Models' }));

    const previewSelector = screen.getByRole('button', {
      name: 'Preview generation: Codex · saved-model'
    });
    const previewSetting = previewSelector.closest<HTMLElement>('.tm-model-default');
    expect(previewSetting).not.toBeNull();
    expect(within(previewSetting!).getByRole('status').textContent).toBe(authenticationDetail);
    expect(
      screen.queryByText(
        'The selected Preview agent or model is no longer available. Choose another selection.'
      )
    ).toBeNull();
  });

  it('keeps a missing saved Preview agent visible instead of showing another agent', () => {
    renderSettings({
      appSettings: {
        ...DEFAULT_TASK_MANAGER_APP_SETTINGS,
        previewRecipeGenerationRuntimeId: 'removed-agent',
        previewRecipeGenerationModel: 'removed-model',
        previewRecipeGenerationModelProvider: 'removed-provider'
      },
      models: [previewModel],
      runtimes: [readyCodexRuntime]
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Models' }));

    const trigger = screen.getByRole('button', {
      name: 'Preview generation: removed-agent · removed-model'
    });
    expect(trigger.getAttribute('aria-invalid')).toBe('true');
    expect(
      screen.getByText(
        'The selected Preview agent or model is no longer available. Choose another selection.'
      )
    ).not.toBeNull();
  });
});

describe('Update settings', () => {
  it('checks for updates when no update is active', () => {
    const onCheckForSoftwareUpdates = vi.fn(async () => undefined);
    renderSettings({ onCheckForSoftwareUpdates });

    fireEvent.click(screen.getByRole('tab', { name: 'Updates' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));

    expect(onCheckForSoftwareUpdates).toHaveBeenCalledOnce();
  });

  it('downloads an available update and persists install-on-quit directly', () => {
    const onDownloadSoftwareUpdate = vi.fn(async () => undefined);
    const { onSetAppSettings } = renderSettings({
      updateState: {
        ...softwareUpdateState,
        status: 'available',
        availableVersion: '0.2.1',
        lastCheckedAt: '2026-08-26T12:00:00.000Z'
      },
      onDownloadSoftwareUpdate
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Updates' }));
    expect(screen.getByText('0.2.0')).toBeTruthy();
    expect(screen.getByText('Version 0.2.1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    fireEvent.click(
      screen.getByRole('switch', {
        name: 'Automatically install downloaded updates when Task Monki quits'
      })
    );

    expect(onDownloadSoftwareUpdate).toHaveBeenCalledOnce();
    expect(onSetAppSettings).toHaveBeenCalledWith({ autoInstallUpdatesOnQuit: false });
  });
});

describe('Appearance settings', () => {
  it('selects palette and mode independently and previews the active roles', () => {
    const { onSetTheme, onSetAppSettings } = renderSettings();

    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }));
    expect(screen.getByText('Palette only — typeface and density are set separately.')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Theme preview' })).toBeTruthy();
    expect(screen.getByText(/Umber · (?:light|dark)/u)).toBeTruthy();
    expect(screen.getByText('[seed:completion-manual-merged] Manual completion with merged PR')).toBeTruthy();
    expect(screen.getByText('Write a message… Type @ for agents, tasks, or repositories')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Umber/u }));
    expect(screen.getAllByRole('option')).toHaveLength(16);
    expect(screen.getByRole('group', { name: 'Authored' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Catalog' })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: 'Nocturne' }));
    expect(onSetAppSettings).toHaveBeenCalledWith(
      { themePreset: 'nocturne' },
      'Theme preset updated.'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(onSetTheme).toHaveBeenCalledWith('dark');
  });

  it('previews keyboard navigation and restores the persisted theme on Escape', async () => {
    const { onPreviewThemePreset, onSetAppSettings } = renderSettings();
    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }));

    const trigger = screen.getByRole('button', { name: /Umber/u });
    fireEvent.click(trigger);
    const umber = screen.getByRole('option', { name: 'Umber' });
    await waitFor(() => expect(document.activeElement).toBe(umber));

    fireEvent.keyDown(umber, { key: 'ArrowDown' });
    const nocturne = screen.getByRole('option', { name: 'Nocturne' });
    await waitFor(() => expect(document.activeElement).toBe(nocturne));
    expect(onPreviewThemePreset).toHaveBeenLastCalledWith('nocturne');
    expect(screen.getByText(/Nocturne · (?:light|dark)/u)).toBeTruthy();

    fireEvent.keyDown(nocturne, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(onPreviewThemePreset).toHaveBeenLastCalledWith(null);
    expect(screen.getByText(/Umber · (?:light|dark)/u)).toBeTruthy();
    expect(onSetAppSettings).not.toHaveBeenCalled();
  });

  it('commits the keyboard-previewed theme with Enter', async () => {
    const { onPreviewThemePreset, onSetAppSettings } = renderSettings();
    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }));

    const trigger = screen.getByRole('button', { name: /Umber/u });
    fireEvent.click(trigger);
    const umber = screen.getByRole('option', { name: 'Umber' });
    await waitFor(() => expect(document.activeElement).toBe(umber));
    fireEvent.keyDown(umber, { key: 'ArrowDown' });
    const nocturne = screen.getByRole('option', { name: 'Nocturne' });
    await waitFor(() => expect(document.activeElement).toBe(nocturne));
    fireEvent.keyDown(nocturne, { key: 'Enter' });

    await waitFor(() => {
      expect(onSetAppSettings).toHaveBeenCalledWith(
        { themePreset: 'nocturne' },
        'Theme preset updated.'
      );
    });
    expect(onPreviewThemePreset).toHaveBeenLastCalledWith(null);
  });
});
