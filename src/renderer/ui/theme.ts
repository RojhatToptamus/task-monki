import {
  TASK_MANAGER_THEME_PRESETS,
  isTaskManagerThemePreset,
  type TaskManagerThemePreset
} from '../../shared/agent';
import generatedThemeCatalog from '../../../theme-tokens.json';

export type ThemePreference = 'light' | 'dark' | 'device';
export type ResolvedTheme = 'light' | 'dark';
export type ThemePreset = TaskManagerThemePreset;
export type ThemeTokens = Record<`--${string}`, string>;

export interface ThemeSeed {
  surface: string;
  ink: string;
  accent: string;
  selection: string;
  added: string;
  removed: string;
  skill: string;
}

interface GeneratedThemeVariant {
  seeds: ThemeSeed;
  tokens: ThemeTokens;
}

interface GeneratedTheme {
  light: GeneratedThemeVariant;
  dark: GeneratedThemeVariant;
}

interface GeneratedThemeCatalog {
  defaultTheme: string;
  groups: Record<'Authored' | 'Catalog', string[]>;
  themes: Record<string, GeneratedTheme>;
}

export interface ThemePresetDefinition {
  id: ThemePreset;
  label: string;
  group: 'Authored' | 'Catalog';
  seeds: Record<ResolvedTheme, ThemeSeed>;
  variants: Record<ResolvedTheme, ThemeTokens>;
}

const themeCatalog = generatedThemeCatalog as GeneratedThemeCatalog;

export const DEFAULT_THEME_PRESET = themeCatalog.defaultTheme.toLowerCase() as ThemePreset;

function catalogEntry(id: ThemePreset): [string, GeneratedTheme] {
  const entry = Object.entries(themeCatalog.themes).find(
    ([label]) => label.toLowerCase() === id
  );
  if (!entry) throw new Error(`Generated theme data is missing for ${id}.`);
  return entry;
}

export const THEME_PRESETS: readonly ThemePresetDefinition[] = TASK_MANAGER_THEME_PRESETS.map(
  (id) => {
    const [label, theme] = catalogEntry(id);
    const group = themeCatalog.groups.Authored.includes(label) ? 'Authored' : 'Catalog';
    return {
      id,
      label,
      group,
      seeds: { light: theme.light.seeds, dark: theme.dark.seeds },
      variants: { light: theme.light.tokens, dark: theme.dark.tokens }
    };
  }
);

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  return preference === 'device' ? (prefersDark ? 'dark' : 'light') : preference;
}

export function resolveThemePreset(value: unknown): ThemePreset {
  return isTaskManagerThemePreset(value) ? value : DEFAULT_THEME_PRESET;
}

export function themePresetDefinition(id: ThemePreset): ThemePresetDefinition {
  const definition = THEME_PRESETS.find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`Theme preset ${id} is not registered.`);
  return definition;
}

export function themeTokens(id: ThemePreset, mode: ResolvedTheme): ThemeTokens {
  return themePresetDefinition(id).variants[mode];
}

/**
 * Generated selectors are rooted at <html>. Device mode removes data-mode so
 * the generated prefers-color-scheme rule remains authoritative.
 */
export function applyThemeToRoot(
  root: HTMLElement,
  preset: ThemePreset,
  preference: ThemePreference
): void {
  root.dataset.theme = preset;
  if (preference === 'device') {
    delete root.dataset.mode;
    return;
  }
  root.dataset.mode = preference;
}
