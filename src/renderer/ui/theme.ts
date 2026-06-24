export const THEME_STORAGE_KEY = 'task-monki-theme';

export const THEME_OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'sunset', label: 'Sunset' }
] as const;

export type ThemePreference = (typeof THEME_OPTIONS)[number]['value'];

function isThemePreference(value: string | null): value is ThemePreference {
  return THEME_OPTIONS.some((theme) => theme.value === value);
}

export function getInitialTheme(): ThemePreference {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (isThemePreference(stored)) {
    return stored;
  }

  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
