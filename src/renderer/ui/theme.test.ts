import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import generatedThemeCatalog from '../../../theme-tokens.json';
import {
  DEFAULT_THEME_PRESET,
  applyThemeToRoot,
  resolveTheme,
  resolveThemePreset,
  THEME_PRESETS,
  themeTokens,
  type ThemePreset
} from './theme';

const EXPECTED_PRESETS: ThemePreset[] = [
  'graphite', 'umber', 'nocturne', 'parchment', 'harbor', 'forge', 'axis', 'paper',
  'signal', 'monolith', 'workbench', 'blueprint', 'brasspants', 'codechimp',
  'greaseball', 'sockpuppet'
];

describe('resolveTheme', () => {
  it('returns explicit modes and follows the OS only for device mode', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('device', true)).toBe('dark');
    expect(resolveTheme('device', false)).toBe('light');
  });
});

describe('generated theme registry', () => {
  it('registers every generated palette in the product order', () => {
    expect(THEME_PRESETS.map(({ id }) => id)).toEqual(EXPECTED_PRESETS);
    expect(THEME_PRESETS.filter(({ group }) => group === 'Authored')).toHaveLength(3);
    expect(THEME_PRESETS.filter(({ group }) => group === 'Catalog')).toHaveLength(13);
    expect(DEFAULT_THEME_PRESET).toBe('umber');
  });

  it('reads every token from the generated catalog without runtime derivation', () => {
    const roles = Object.keys(themeTokens('umber', 'light')).sort();
    expect(roles).toHaveLength(53);

    for (const preset of THEME_PRESETS) {
      const generated = generatedThemeCatalog.themes[preset.label as keyof typeof generatedThemeCatalog.themes];
      expect(generated).toBeTruthy();
      for (const mode of ['light', 'dark'] as const) {
        const tokens = themeTokens(preset.id, mode);
        expect(tokens).toEqual(generated[mode].tokens);
        expect(Object.keys(tokens).sort()).toEqual(roles);
        expect(Object.values(tokens).every(Boolean)).toBe(true);
        expect(tokens['--id-2']).not.toBe(tokens['--id-1']);
        expect(tokens['--id-2']).not.toBe(tokens['--id-3']);
      }
    }
  });

  it('ships the shared status, diff, and scrim derivations in every set', () => {
    for (const preset of THEME_PRESETS) {
      for (const mode of ['light', 'dark'] as const) {
        expect(themeTokens(preset.id, mode)).toMatchObject({
          '--verified-bg': 'color-mix(in srgb, var(--verified) 12%, transparent)',
          '--diff-added-bg': 'color-mix(in srgb, var(--verified) 10%, transparent)',
          '--diff-removed-bg': 'color-mix(in srgb, var(--blocked) 10%, transparent)',
          '--scrim': 'color-mix(in srgb, var(--ground) 60%, transparent)'
        });
      }
    }
  });

  it('publishes the measured floors from the checked generator output', () => {
    expect(generatedThemeCatalog.measured).toMatchObject({
      '--text': 10.29,
      '--muted': 4.5,
      '--faint': 3.01,
      '--idle': 3.01,
      '--id-*': 3.56,
      '--blocked-ink': 4.52,
      '--verified-ink': 4.57
    });
  });

  it('falls back to Umber for legacy or invalid settings payloads', () => {
    expect(resolveThemePreset(undefined)).toBe('umber');
    expect(resolveThemePreset('not-a-theme')).toBe('umber');
    expect(resolveThemePreset('harbor')).toBe('harbor');
  });

  it('applies palette and mode only to the document root', () => {
    const root = { dataset: {} } as HTMLElement;
    applyThemeToRoot(root, 'nocturne', 'dark');
    expect(root.dataset.theme).toBe('nocturne');
    expect(root.dataset.mode).toBe('dark');

    applyThemeToRoot(root, 'umber', 'device');
    expect(root.dataset.theme).toBe('umber');
    expect(root.dataset.mode).toBeUndefined();
  });

  it('loads generated selectors on html and starts with an Umber device fallback', async () => {
    const [css, html] = await Promise.all([
      readFile(new URL('../../../themes.css', import.meta.url), 'utf8'),
      readFile(new URL('../../../index.html', import.meta.url), 'utf8')
    ]);

    expect(css).toContain('[data-theme="umber"][data-mode="dark"]');
    expect(css).toContain('[data-theme="umber"]:not([data-mode="light"]):not([data-mode="dark"])');
    expect(css).toContain('--id-1:');
    expect(css).toContain('--id-6:');
    expect(html).toContain('<html lang="en" data-theme="umber">');
  });
});
