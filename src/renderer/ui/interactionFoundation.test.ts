import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { readRendererStyles } from '../../testSupport/rendererStyles';

describe('renderer style policies', () => {
  it('keeps feature styles on the generated theme token boundary', async () => {
    const styleDirectory = new URL('../styles/', import.meta.url);
    const featureFiles = (await readdir(styleDirectory))
      .filter((name) => name.endsWith('.css') && name !== 'foundation.css')
      .sort();
    const featureStyles = await Promise.all(
      featureFiles.map((name) => readFile(new URL(name, styleDirectory), 'utf8'))
    );
    const css = featureStyles.join('\n');
    const deprecatedRoles = [
      'bg', 'surface2', 'border', 'border-strong', 'control-border', 'lift',
      'lift-shadow', 'code-bg', 'shadow-menu', 'handle-hover', 'tooltip',
      'tooltip-text', 'ctx-border', 'success-bg', 'info-bg', 'warning-bg',
      'error-line', 'on-accent'
    ];

    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    expect(css).not.toMatch(/rgba?\(/u);
    expect(css).not.toContain('color-mix(');
    for (const role of deprecatedRoles) {
      expect(css).not.toContain(`var(--${role})`);
    }
    expect(css).not.toMatch(/var\(--state-[a-z-]+\)/);
  });

  it('honors operating-system accessibility preferences', async () => {
    const css = await readRendererStyles();

    expect(css).toMatch(
      /\.app-shell\s+:where\([\s\S]*textarea[\s\S]*\):focus[\s\S]*var\(--field-edge-focus\)/
    );
    expect(css).toMatch(
      /\.app-shell\[data-input-modality='keyboard'\][\s\S]*:focus[\s\S]*var\(--focus-ring\)/
    );
    expect(css).not.toContain('var(--field-focus-line)');
    expect(css).not.toContain('var(--field-focus-ring)');
    expect(css).toMatch(
      /\.app-shell\[data-input-modality='pointer'\][\s\S]*:focus \{\s*outline: none/
    );
    expect(css).toMatch(/@media \(forced-colors: active\)[\s\S]*outline: 1px solid Highlight/);
    expect(css).toMatch(/@media \(prefers-contrast: more\)[\s\S]*--edge/);
    expect(css).toMatch(
      /@media \(prefers-reduced-transparency: reduce\)[\s\S]*backdrop-filter: none/
    );
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\*,\s*\*::before,\s*\*::after[\s\S]*animation-iteration-count: 1 !important/
    );
  });

  it('keeps the Design canvas device presets at their safe maximum widths', async () => {
    const css = await readRendererStyles();

    expect(css).toMatch(
      /\.tm-design-canvas__viewport\s*\{[^}]*width: min\(1280px, 100%\)/u
    );
    expect(css).toMatch(
      /\.tm-design-canvas__viewport\[data-device='tablet'\]\s*\{[^}]*width: min\(768px, 100%\)/u
    );
    expect(css).toMatch(
      /\.tm-design-canvas__viewport\[data-device='phone'\]\s*\{[^}]*width: min\(390px, 100%\)/u
    );
  });
});
