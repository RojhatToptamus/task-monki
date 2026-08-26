import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TASK_MANAGER_APP_SETTINGS,
  type TaskManagerAppSettings
} from '../../shared/agent';
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
  onInstallSoftwareUpdate = vi.fn(async () => undefined)
}: {
  appSettings?: TaskManagerAppSettings;
  onSetTheme?: SettingsViewProps['onSetTheme'];
  onSetAppSettings?: SettingsViewProps['onSetAppSettings'];
  onPreviewThemePreset?: NonNullable<SettingsViewProps['onPreviewThemePreset']>;
  updateState?: SoftwareUpdateState;
  onCheckForSoftwareUpdates?: SettingsViewProps['onCheckForSoftwareUpdates'];
  onDownloadSoftwareUpdate?: SettingsViewProps['onDownloadSoftwareUpdate'];
  onInstallSoftwareUpdate?: SettingsViewProps['onInstallSoftwareUpdate'];
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
      models={[]}
      runtimes={[]}
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
