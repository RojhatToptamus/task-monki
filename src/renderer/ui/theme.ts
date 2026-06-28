export type ThemePreference = 'light' | 'dark' | 'device';
export type ResolvedTheme = 'light' | 'dark';

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === 'device') {
    return prefersDark ? 'dark' : 'light';
  }
  return preference;
}
