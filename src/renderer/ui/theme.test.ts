import { describe, expect, it, vi } from 'vitest';

import { getInitialTheme, THEME_OPTIONS, THEME_STORAGE_KEY } from './theme';

function setThemeStorage(value: string | null) {
  if (value === null) {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
  } else {
    window.localStorage.setItem(THEME_STORAGE_KEY, value);
  }
}

describe('getInitialTheme', () => {
  const mediaQuery = 'prefers-color-scheme: dark';

  it('returns a valid stored theme', () => {
    for (const option of THEME_OPTIONS) {
      setThemeStorage(option.value);
      expect(getInitialTheme()).toBe(option.value);
    }
  });

  it('falls back to dark when OS preference is dark and value is invalid', () => {
    setThemeStorage('invalid');
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
      media: mediaQuery,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    } as MediaQueryList);

    expect(getInitialTheme()).toBe('dark');
  });

  it('falls back to light when OS preference is not dark and value is invalid', () => {
    setThemeStorage('invalid');
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: false,
      media: mediaQuery,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    } as MediaQueryList);

    expect(getInitialTheme()).toBe('light');
  });
});
