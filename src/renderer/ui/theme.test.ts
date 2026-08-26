import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME_PRESET,
  applyThemeToRoot,
  resolveTheme,
  resolveThemePreset
} from './theme';

describe('theme runtime behavior', () => {
  it('resolves explicit modes and follows the OS only in device mode', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('device', true)).toBe('dark');
    expect(resolveTheme('device', false)).toBe('light');
  });

  it('uses the generated default for an untrusted preset', () => {
    expect(resolveThemePreset('not-a-theme')).toBe(DEFAULT_THEME_PRESET);
    expect(resolveThemePreset('harbor')).toBe('harbor');
  });

  it('applies the preset and explicit mode only to the document root', () => {
    const root = { dataset: {} } as HTMLElement;
    applyThemeToRoot(root, 'nocturne', 'dark');
    expect(root.dataset).toEqual({ theme: 'nocturne', mode: 'dark' });

    applyThemeToRoot(root, 'umber', 'device');
    expect(root.dataset).toEqual({ theme: 'umber' });
  });

  it('starts the document on the generated default preset', async () => {
    const html = await readFile(new URL('../../../index.html', import.meta.url), 'utf8');
    expect(html).toContain(`<html lang="en" data-theme="${DEFAULT_THEME_PRESET}">`);
  });
});
