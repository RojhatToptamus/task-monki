import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TASK_MANAGER_APP_SETTINGS,
  type TaskManagerAppSettings
} from '../../shared/agent';
import { SettingsView, type SettingsViewProps } from './SettingsView';

function renderSettings({
  appSettings = DEFAULT_TASK_MANAGER_APP_SETTINGS,
  onSetTheme = vi.fn(),
  onSetAppSettings = vi.fn(),
  onPreviewThemePreset = vi.fn()
}: {
  appSettings?: TaskManagerAppSettings;
  onSetTheme?: SettingsViewProps['onSetTheme'];
  onSetAppSettings?: SettingsViewProps['onSetAppSettings'];
  onPreviewThemePreset?: NonNullable<SettingsViewProps['onPreviewThemePreset']>;
} = {}) {
  render(
    <SettingsView
      theme="device"
      onSetTheme={onSetTheme}
      onPreviewThemePreset={onPreviewThemePreset}
      appSettings={appSettings}
      onSetAppSettings={onSetAppSettings}
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
  return { onSetTheme, onSetAppSettings, onPreviewThemePreset };
}

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

  it('opens Appearance safely when a legacy settings payload has no theme preset', () => {
    renderSettings({
      appSettings: {
        ...DEFAULT_TASK_MANAGER_APP_SETTINGS,
        themePreset: undefined
      } as unknown as TaskManagerAppSettings
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }));
    expect(screen.getByRole('button', { name: /Umber/u })).toBeTruthy();
    expect(screen.getByText(/Umber · (?:light|dark)/u)).toBeTruthy();
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
