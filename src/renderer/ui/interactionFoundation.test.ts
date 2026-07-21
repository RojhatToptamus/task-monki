import { describe, expect, it } from 'vitest';
import { readRendererStyles } from '../../testSupport/rendererStyles';

describe('renderer interaction foundation styles', () => {
  it('uses theme-aware focus and control boundaries with at least 3:1 contrast', async () => {
    const css = await readRendererStyles();
    const light = themeToken(css, ':root', '--control-border');
    const lightSurface = themeToken(css, ':root', '--surface');
    const lightSurface2 = themeToken(css, ':root', '--surface2');
    const dark = themeToken(css, ".app-shell[data-theme='dark']", '--control-border');
    const darkSurface = themeToken(css, ".app-shell[data-theme='dark']", '--surface');
    const darkSurface2 = themeToken(css, ".app-shell[data-theme='dark']", '--surface2');

    expect(contrast(light, lightSurface)).toBeGreaterThanOrEqual(3);
    expect(contrast(light, lightSurface2)).toBeGreaterThanOrEqual(3);
    expect(contrast(dark, darkSurface)).toBeGreaterThanOrEqual(3);
    expect(contrast(dark, darkSurface2)).toBeGreaterThanOrEqual(3);
    expect(css).toContain('--focus-ring: var(--info)');
    expect(css).toMatch(/@media \(forced-colors: active\)[\s\S]*outline-color: Highlight/);
    expect(css).toContain(".app-shell[data-input-modality='pointer'] button:focus-visible");
    expect(css).toContain(".app-shell[data-input-modality='keyboard'] button:focus");
    expect(css).toContain("[role='menu']:focus-visible");

    const settingsSelectFocus = ruleBody(css, '.tm-settings__select:focus-visible');
    expect(settingsSelectFocus).toContain('border-color: var(--focus-ring)');
    expect(settingsSelectFocus).not.toContain('box-shadow');
  });

  it('keeps one custom search clear target and suppresses the native WebKit control', async () => {
    const css = await readRendererStyles();
    const clearRule = ruleBody(css, '.tm-filefilter__clear');
    const nativeRule = ruleBody(
      css,
      '.tm-filefilter__search input::-webkit-search-cancel-button'
    );

    expect(clearRule).toContain('width: 24px');
    expect(clearRule).toContain('height: 24px');
    expect(nativeRule).toContain('display: none');
    expect(nativeRule).toContain('-webkit-appearance: none');
  });

  it('keeps selected Inbox counts readable in the collapsed sidebar', async () => {
    const css = await readRendererStyles();
    const selectedUrgentCount = ruleBody(
      css,
      '.tm-nav--collapsed .tm-nav__item--active .tm-nav__count--urgent'
    );

    expect(selectedUrgentCount).toContain('background: var(--action)');
    expect(selectedUrgentCount).toContain('color: var(--on-accent)');
    expect(selectedUrgentCount).toContain('border-color: var(--surface2)');
  });

  it('provides immediate press feedback without changing control geometry', async () => {
    const css = await readRendererStyles();
    const active = ruleBody(
      css,
      ":where(button, [role='button']):not(:disabled):active"
    );

    expect(active).toContain('filter: brightness(0.88)');
    expect(active).not.toContain('transform');
  });

  it('keeps faint annotation text readable and supports contrast and transparency preferences', async () => {
    const css = await readRendererStyles();
    const lightFaint = themeToken(css, ':root', '--faint');
    const lightSurface = themeToken(css, ':root', '--surface');
    const darkFaint = themeToken(css, ".app-shell[data-theme='dark']", '--faint');
    const darkSurface = themeToken(css, ".app-shell[data-theme='dark']", '--surface');

    expect(contrast(lightFaint, lightSurface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(darkFaint, darkSurface)).toBeGreaterThanOrEqual(4.5);
    expect(css).toMatch(
      /@media \(prefers-reduced-transparency: reduce\)[\s\S]*backdrop-filter: none/
    );
    expect(css).toMatch(/@media \(prefers-contrast: more\)[\s\S]*--border-strong/);
  });

  it('does not retain the unused parallel tm-btn family', async () => {
    const css = await readRendererStyles();
    expect(css).not.toMatch(/\.tm-btn(?:--[a-z-]+)?\s*\{/);
  });

  it('uses the compact interface metadata scale for PR supporting text', async () => {
    const css = await readRendererStyles();
    const identity = ruleBody(css, '.tm-prstatus__identity');
    const metadata = ruleBody(css, '.tm-prstatus__meta');

    expect(identity).toContain('font: 500 11.5px/1.45 var(--font-ui)');
    expect(metadata).toContain('margin-top: -4px');
  });

  it('stops every continuous status animation when reduced motion is requested', async () => {
    const css = await readRendererStyles();
    const reducedMotionStart = css.lastIndexOf('@media (prefers-reduced-motion: reduce)');
    const lastComponentAnimation = css.lastIndexOf('animation: tm-');
    const reducedMotion = css.slice(reducedMotionStart);

    expect(reducedMotionStart).toBeGreaterThan(lastComponentAnimation);

    for (const selector of [
      '.status-pill--running .status-pill__dot',
      '.tm-pulse',
      '.tm-exec__spinner',
      '.tm-preview-recipe-progress__dot',
      '.tm-prstatus__dot--pulse',
      '.tm-prcheck__dot--pending',
      '.tm-reviewcard--info .tm-reviewcard__dot'
    ]) {
      expect(reducedMotion).toContain(selector);
    }
    expect(reducedMotion).toMatch(/animation: none/);
    expect(reducedMotion).toMatch(/\.tm-detail__mascot-video\s*\{[^}]*transition: none/);
  });
});

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart = css.indexOf('{', start) + 1;
  return css.slice(bodyStart, css.indexOf('}', bodyStart));
}

function themeToken(css: string, selector: string, token: string): string {
  const body = ruleBody(css, selector);
  const match = body.match(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`));
  expect(match?.[1]).toBeTruthy();
  return match![1];
}

function contrast(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
