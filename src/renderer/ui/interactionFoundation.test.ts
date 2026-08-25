import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { readRendererStyles } from '../../testSupport/rendererStyles';

describe('renderer interaction foundation styles', () => {
  it('uses the canonical theme-aware focus and control boundaries', async () => {
    const css = await readRendererStyles();
    const umberLight = '[data-theme="umber"], [data-theme="umber"][data-mode="light"]';
    expect(themeTokenValue(css, umberLight, '--hair')).toBe('rgba(27,25,23,0.09)');
    expect(themeTokenValue(css, umberLight, '--edge')).toBe('rgba(27,25,23,0.15)');
    expect(css).toMatch(/@media \(forced-colors: active\)[\s\S]*outline: 1px solid Highlight/);
    expect(css).toMatch(
      /\.app-shell\[data-input-modality='pointer'\] :where\([^)]*button[^)]*\):focus \{\s*outline: none/
    );
    expect(css).toMatch(
      /\.app-shell\[data-input-modality='keyboard'\] :where\([^)]*button[^)]*\):focus \{[^}]*inset 0 0 0 1px var\(--accent\)[^}]*0 0 0 3px var\(--field-focus-ring\)/
    );

    const fieldFocus = ruleBody(
      css,
      ".app-shell[data-input-modality='keyboard'] .tm-theme-picker__trigger:focus,\n" +
        ".app-shell[data-input-modality='keyboard'] .tm-agent-console__trigger:focus,\n" +
        ".app-shell[data-input-modality='keyboard'] .tm-settings__select:focus,\n" +
        ".app-shell[data-input-modality='keyboard'] .tm-settings__input:focus"
    );
    expect(fieldFocus).toContain('background: var(--field-focus)');
    expect(fieldFocus).toContain('inset 0 0 0 1px var(--accent)');
    expect(fieldFocus).toContain('0 0 0 3px var(--field-focus-ring)');
    expect(fieldFocus).not.toContain('border-color');
    expect(css).not.toContain('var(--focus-ring)');

    const feedback = ruleBody(css, '.tm-error');
    expect(feedback).toContain('background: var(--error-bg)');
    expect(feedback).not.toContain('border:');
  });

  it('uses only the canonical role vocabulary outside the token foundation', async () => {
    const css = await readRendererStyles();
    const deprecated = [
      'bg', 'surface2', 'border', 'border-strong', 'control-border', 'lift',
      'lift-shadow', 'code-bg', 'shadow-menu', 'handle-hover', 'tooltip',
      'tooltip-text', 'ctx-border', 'success-bg', 'info-bg', 'warning-bg',
      'error-line', 'on-accent'
    ];

    for (const token of deprecated) {
      expect(css).not.toContain(`var(--${token})`);
    }
    expect(css).not.toMatch(/var\(--state-[a-z-]+\)/);
  });

  it('keeps raw color computation inside the token foundation', async () => {
    const featureStyles = await Promise.all([
      'agent-and-evidence.css',
      'app-shell.css',
      'base-components.css',
      'designs.css',
      'discourse.css',
      'new-task.css',
      'task-detail.css'
    ].map((name) => readFile(new URL(`../styles/${name}`, import.meta.url), 'utf8')));
    const css = featureStyles.join('\n');

    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    expect(css).not.toMatch(/rgba?\(/u);
    expect(css).not.toContain('color-mix(');
  });

  it('maps shared surfaces and state fills to the Appendix A roles', async () => {
    const css = await readRendererStyles();

    expect(ruleBody(css, '.tm-card:hover')).toContain('background: var(--field-hover)');
    expect(ruleBody(css, '.status-pill--success')).toContain('background: var(--verified-bg)');
    expect(ruleBody(css, '.tm-modal__scrim')).toContain('background: var(--scrim)');
    expect(ruleBody(css, '.tm-diffline--addition')).toContain('background: var(--diff-added-bg)');
    expect(ruleBody(css, '::-webkit-scrollbar-thumb')).toContain('background: var(--edge)');
    expect(ruleBody(css, '.network-toggle__switch--on span')).toContain('background: var(--card)');
    expect(css).toMatch(/\.tm-panel-resize:hover::before,[^{]+\{\s*background: var\(--edge\)/u);
    expect(css).toMatch(
      /\.tm-diffline--deletion \{[^}]*background: var\(--diff-removed-bg\)/u
    );
  });

  it('maps container boundaries and elevation to the Appendix A catalog', async () => {
    const css = await readRendererStyles();

    for (const selector of ['.tm-settings__list', '.tm-model-defaults']) {
      const panel = ruleBody(css, selector);
      expect(panel).toContain('border: 0');
      expect(panel).toContain('background: var(--surface)');
      expect(panel).toContain('box-shadow: var(--shadow-panel)');
      expect(panel).not.toContain('var(--shadow-card)');
    }

    const drawer = ruleBody(css, '.tm-reviewdrawer__panel');
    expect(drawer).toContain('border-left: 1px solid var(--edge)');
    expect(drawer).toContain('background: var(--surface)');
    expect(drawer).toContain('box-shadow: var(--shadow-pop)');
    expect(drawer).not.toContain('var(--shadow-modal)');

    const popover = ruleBody(css, '.tm-repository-select__popover');
    expect(popover).toContain('border: 0');
    expect(popover).toContain('background: var(--overlay)');
    expect(popover).toContain('box-shadow: var(--shadow-pop)');

    const modal = ruleBody(css, '.tm-modal__panel');
    expect(modal).toContain('border: 0');
    expect(modal).toContain('background: var(--overlay)');
    expect(modal).toContain('box-shadow: var(--shadow-modal)');
  });

  it('does not raise persistent selection states as cards', async () => {
    const css = await readRendererStyles();
    const selectedControls = [
      '.tm-nav__item--active',
      ".tm-designs-rail__filter button[aria-pressed='true'],\n" +
        ".tm-design-layout button[aria-pressed='true']",
      ".tm-design-canvas__devices button[aria-pressed='true']",
      ".tm-discourse-rail__filter button[aria-pressed='true']",
      '.tm-agent-console__reasoning button.is-selected',
      ".tm-diffscope-tabs button[aria-pressed='true'],\n" +
        '.tm-diffscope-tabs__tab--active'
    ];

    for (const selector of selectedControls) {
      expect(ruleBody(css, selector)).not.toContain('box-shadow: var(--shadow-card)');
    }

    expect(ruleBody(css, '.tm-nav__item--active')).toContain('background: var(--sel)');
    expect(
      ruleBody(css, ".tm-design-canvas__devices button[aria-pressed='true']")
    ).toContain('background: var(--card)');
    expect(
      ruleBody(css, ".tm-discourse-rail__filter button[aria-pressed='true']")
    ).toContain('background: var(--card)');
  });

  it('keeps status actions and relationship cards free of decorative outlines', async () => {
    const css = await readRendererStyles();

    expect(ruleBody(css, '.tm-discourse-status-banner button')).toContain('border: 0');
    expect(css).not.toContain('.subagent-node--contradictory > details');
    expect(css).not.toContain('.subagent-node--unresolved > details');
  });

  it('keeps one custom search clear target and suppresses the native WebKit control', async () => {
    const css = await readRendererStyles();
    const clearRule = ruleBody(css, '.tm-filefilter__clear');
    const nativeRule = ruleBody(
      css,
      '.tm-filefilter__search input::-webkit-search-cancel-button'
    );

    expect(clearRule).toContain('width: 28px');
    expect(clearRule).toContain('height: 28px');
    expect(nativeRule).toContain('display: none');
    expect(nativeRule).toContain('-webkit-appearance: none');
  });

  it('keeps compact interactive targets at least 28px tall', async () => {
    const css = await readRendererStyles();

    for (const selector of [
      '.tm-nav__saved-add',
      '.tm-designs-rail__filter button',
      '.tm-design-layout button',
      '.tm-design-canvas__devices button',
      '.tm-discourse-rail__filter button',
      '.tm-design-ready-menu .tm-taskmenu__trigger',
      '.tm-design-files__head > button',
      '.tm-design-canvas__versions button,\n.tm-design-canvas__versions > span',
      '.task-attachment__remove',
      '.tm-discourse-response > header button',
      '.tm-discourse-selection-bar button',
      '.tm-preview-icon-button',
      '.tm-prstatus__refresh',
      '.tm-preview-scenario-control select'
    ]) {
      expect(ruleBody(css, selector)).toMatch(/height:\s*(?:28|30)px/);
    }
    for (const selector of [
      '.tm-discourse-load-older',
      '.tm-taskactivity__viewall',
      '.tm-reviewcard__stale button',
      '.tm-discourse-status-banner button',
      '.tm-discourse-agent-config .tm-agent-console__reasoning button',
      '.tm-discourse-composer__requirement button',
      '.tm-preview-logdock select',
      '.tm-requestcard__prompt > summary'
    ]) {
      expect(ruleBody(css, selector)).toContain('min-height: 28px');
    }
  });

  it('reserves scrollbar space in every primary independent scroll region', async () => {
    const css = await readRendererStyles();

    for (const selector of [
      '.tm-detail__body',
      '.tm-col__cards',
      '.tm-settings',
      '.slideover__body',
      '.tm-designs-rail__list',
      '.tm-design-conversation__transcript',
      '.tm-discourse-rail__list',
      '.tm-discourse-transcript',
      '.tm-discourse-inspector'
    ]) {
      expect(ruleBody(css, selector)).toContain('scrollbar-gutter: stable');
    }
  });

  it('keeps flush panel titles from displacing shared disclosure chevrons', async () => {
    const css = await readRendererStyles();
    const flushTitle = ruleBody(css, '.tm-panel__title.tm-panel__title--flush');

    expect(flushTitle).toContain('margin: 0');
  });

  it('separates the Design history well from the primary work surface', async () => {
    const css = await readRendererStyles();

    expect(ruleBody(css, '.tm-designs')).toContain('background: var(--surface)');
    expect(ruleBody(css, '.tm-designs-rail')).toContain('background: var(--panel)');
    expect(ruleBody(css, '.tm-designs-main')).toContain('background: var(--surface)');
    expect(ruleBody(css, '.tm-design-create')).toContain('background: var(--surface)');
  });

  it('anchors Design device previews without moving the surrounding workspace', async () => {
    const css = await readRendererStyles();
    const stage = ruleBody(css, '.tm-design-canvas__stage');
    const viewport = ruleBody(css, '.tm-design-canvas__viewport');
    const deviceSize = ruleBody(css, '.tm-design-canvas__device-size');

    expect(stage).toContain('justify-content: flex-start');
    expect(viewport).not.toContain('transition: width');
    expect(deviceSize).toContain('flex: 0 0 68px');
  });

  it('keeps the expanded navigation sidebar within its bounded resize range', async () => {
    const css = await readRendererStyles();
    const navigation = ruleBody(css, '.tm-nav');

    expect(navigation).toContain('min-width: 176px');
    expect(navigation).toContain('max-width: 240px');
    expect(navigation).toContain('var(--app-sidebar-width, 176px)');
  });

  it('uses one visible focus boundary for repository search', async () => {
    const css = await readRendererStyles();
    const repositorySearchFocus = ruleBody(css, '.tm-repository-picker__search input:focus');

    expect(repositorySearchFocus).toContain('outline: 0');
    expect(repositorySearchFocus).toContain('box-shadow: none');
  });

  it('aligns Discourse panel headers on one shared divider', async () => {
    const css = await readRendererStyles();
    const conversationHeader = ruleBody(css, '.tm-discourse-header');
    const inspectorHeader = ruleBody(css, '.tm-discourse-inspector__head');

    expect(conversationHeader).toContain('min-height: 58px');
    expect(inspectorHeader).toContain('min-height: 58px');
    expect(css).toMatch(
      /\.tm-discourse-rail,\s*\.tm-discourse-inspector,\s*\.tm-discourse-loading-rail\s*\{[^}]*background: var\(--panel\)/
    );
    expect(ruleBody(css, '.tm-discourse-inspector')).toContain('background: var(--panel)');
  });

  it('maps the New Task drawer and field states to the Appendix A roles', async () => {
    const css = await readRendererStyles();

    const drawer = ruleBody(css, '.slideover__panel');
    expect(drawer).toContain('border-left: 1px solid var(--edge)');
    expect(drawer).toContain('background: var(--surface)');
    expect(drawer).toContain('box-shadow: var(--shadow-pop)');

    for (const selector of [
      '.slideover__header',
      '.slideover__body',
      '.slideover__footer'
    ]) {
      expect(ruleBody(css, selector)).not.toContain('background:');
    }

    expect(
      ruleBody(css, '.field input::placeholder,\n.field textarea::placeholder')
    ).toContain('color: var(--placeholder)');
    expect(ruleBody(css, '.field__refine')).toContain('color: var(--accent-ink)');
    expect(ruleBody(css, '.form-error')).toContain('color: var(--blocked-ink)');
    expect(
      ruleBody(
        css,
        '.field > input:not(:disabled):hover,\n' +
          '.field > textarea:not(:disabled):hover,\n' +
          '.field > select:not(:disabled):hover'
      )
    ).toContain('background: var(--field-hover)');
    expect(
      ruleBody(css, '.field__prompt-shell:has(textarea:not(:disabled)):hover')
    ).toContain('background: var(--field-hover)');
    expect(
      ruleBody(
        css,
        '.field input:disabled,\n.field textarea:disabled,\n.field select:disabled'
      )
    ).toContain('opacity: 0.45');
    expect(ruleBody(css, 'button:disabled')).toContain('opacity: 0.45');
    expect(ruleBody(css, '.field__refine:not(:disabled):hover')).toContain(
      'text-decoration: underline'
    );

    const modelError = ruleBody(css, '.tm-agent-console__trigger--error');
    expect(modelError).toContain('background: var(--field)');
    expect(modelError).toContain('inset 0 0 0 1px var(--blocked)');
    expect(
      ruleBody(
        css,
        ".tm-agent-console__trigger--error:not(:disabled):hover,\n" +
          ".tm-agent-console__trigger--error[aria-expanded='true']"
      )
    ).toContain('background: var(--field-hover)');
    expect(ruleBody(css, '.tm-agent-console__trigger:disabled')).not.toContain('opacity:');
    expect(
      ruleBody(css, '.tm-agent-console__reasoning button:disabled')
    ).not.toContain('opacity:');
    expect(ruleBody(css, '.tm-access-select__option:disabled')).not.toContain('opacity:');
    expect(
      ruleBody(
        css,
        '.tm-access-select__trigger:not(:disabled):hover,\n' +
          '.tm-access-select.is-open .tm-access-select__trigger'
      )
    ).toContain('background: var(--field-hover)');
    expect(ruleBody(css, '.tm-access-select__menu')).toContain('bottom: calc(100% + 6px)');
  });

  it('keeps selected Inbox counts readable in the collapsed sidebar', async () => {
    const css = await readRendererStyles();
    const selectedUrgentCount = ruleBody(
      css,
      '.tm-nav--collapsed .tm-nav__item--active.tm-nav__item--overlap-count .tm-nav__count'
    );

    expect(selectedUrgentCount).toContain('background: var(--waiting)');
    expect(selectedUrgentCount).toContain('color: var(--on-primary)');
    expect(selectedUrgentCount).toContain('border-color: var(--sel)');
  });

  it('provides immediate press feedback without changing control geometry', async () => {
    const css = await readRendererStyles();
    const active = ruleBody(
      css,
      ":where(button, [role='button']):not(:disabled):active"
    );

    expect(active).toContain('background-image: linear-gradient(var(--press), var(--press))');
    expect(active).not.toContain('transform');
    expect(active).not.toContain('filter');
  });

  it('keeps the three-step ink floor readable and supports contrast and transparency preferences', async () => {
    const css = await readRendererStyles();
    const umberLight = '[data-theme="umber"], [data-theme="umber"][data-mode="light"]';
    const lightMuted = themeToken(css, umberLight, '--muted');
    const lightSurface = themeToken(css, umberLight, '--surface');

    expect(contrast(lightMuted, lightSurface)).toBeGreaterThanOrEqual(4.5);
    expect(ruleBody(css, umberLight)).toContain('--faint:');
    expect(css).toMatch(
      /@media \(prefers-reduced-transparency: reduce\)[\s\S]*backdrop-filter: none/
    );
    expect(css).toMatch(/@media \(prefers-contrast: more\)[\s\S]*--edge/);
  });

  it('does not retain the unused parallel tm-btn family', async () => {
    const css = await readRendererStyles();
    expect(css).not.toMatch(/\.tm-btn(?:--[a-z-]+)?\s*\{/);
  });

  it('uses the compact interface metadata scale for PR supporting text', async () => {
    const css = await readRendererStyles();
    const panelTitle = ruleBody(css, '.tm-panel__title');
    const prTitle = ruleBody(css, '.tm-prstatus__titleline .tm-panel__title');
    const identity = ruleBody(css, '.tm-prstatus__identity');
    const metadata = ruleBody(css, '.tm-prstatus__meta');

    expect(panelTitle).toContain('font-size: 12.5px');
    expect(panelTitle).toContain('font-weight: 600');
    expect(prTitle).toContain('font-size: 12.5px');
    expect(identity).toContain('font: 500 11.5px/1.45 var(--font-ui)');
    expect(metadata).toContain('margin-top: 0');
    expect(metadata).not.toMatch(/margin-top:\s*-/);
  });

  it('stops every continuous status animation when reduced motion is requested', async () => {
    const css = await readRendererStyles();
    const reducedMotionStart = css.lastIndexOf('@media (prefers-reduced-motion: reduce)');
    const lastComponentAnimation = css.lastIndexOf('animation: tm-');
    const reducedMotion = css.slice(reducedMotionStart);

    expect(reducedMotionStart).toBeGreaterThan(lastComponentAnimation);

    for (const selector of [
      '.tm-status-glyph--working',
      '.tm-exec__spinner'
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

function themeTokenValue(css: string, selector: string, token: string): string {
  const body = ruleBody(css, selector);
  const match = body.match(new RegExp(`${token}:\\s*([^;]+)`));
  expect(match?.[1]).toBeTruthy();
  return match![1].trim();
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
