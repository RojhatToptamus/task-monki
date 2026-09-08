#!/usr/bin/env node
/* build-themes.mjs — the only place theme colour is authored.
 *
 *   node tools/build-themes.mjs           regenerate themes.css + theme-tokens.json
 *   node tools/build-themes.mjs --check   CI: fail if output is stale or a floor breaks
 *
 * Authored input is the seven seeds below. Every other token is derived in
 * theme-derivation.mjs, which also proves the contrast floors and the surface
 * ladder. Nothing in the generated files is hand-picked, and no component
 * overrides them for one theme.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  deriveVariant,
  hexToRgb,
  measureVariant,
  INK_FLOORS,
  PLANE_CHROMA_LIFT,
  PLANE_TOKENS,
  SURFACE_PLANE_TOKENS,
  LADDER
} from './theme-derivation.mjs';

export const DEFAULT_THEME = 'Graphite';

export const GROUPS = {
  Authored: ['Graphite', 'Umber', 'Nocturne'],
  Catalog: [
    'Parchment', 'Harbor', 'Forge', 'Axis', 'Paper', 'Signal', 'Monolith',
    'Workbench', 'Blueprint', 'Brasspants', 'Codechimp', 'Greaseball', 'Sockpuppet'
  ]
};

/* Seven seeds per theme per mode. This is the whole authored surface. */
export const SEEDS = {
  Graphite: {
    light: { surface: '#FDFDFE', ink: '#14161A', accent: '#3B5BDB', selection: '#DDE1EA', added: '#1A8F5E', removed: '#CF4640', skill: '#8B6FD1' },
    dark: { surface: '#08090A', ink: '#EDEEF0', accent: '#6E8BFF', selection: '#2E3138', added: '#3BA776', removed: '#E5615A', skill: '#A68CE0' }
  },
  Umber: {
    light: { surface: '#FDFBF8', ink: '#1B1917', accent: '#A9663A', selection: '#DED8CB', added: '#1E8258', removed: '#C24A3F', skill: '#8A5AC0' },
    dark: { surface: '#0C0B0A', ink: '#F2F0ED', accent: '#E0A96D', selection: '#37312A', added: '#4FA57C', removed: '#E0655B', skill: '#C79FE8' }
  },
  Nocturne: {
    light: { surface: '#FCFDFF', ink: '#10141C', accent: '#3457B2', selection: '#D5DCEA', added: '#17845A', removed: '#C34A44', skill: '#7C61C9' },
    dark: { surface: '#0A0C11', ink: '#E8EBF0', accent: '#7AA2F7', selection: '#232C3E', added: '#56B98A', removed: '#E4726C', skill: '#A48CE8' }
  },
  Parchment: {
    light: { surface: '#f7f4ed', ink: '#241b12', accent: '#876a26', selection: '#E1D8C5', added: '#277c4c', removed: '#a52f27', skill: '#9b36ab' },
    dark: { surface: '#14120f', ink: '#ede9e3', accent: '#cbb072', selection: '#473E2B', added: '#65c387', removed: '#e56e61', skill: '#dc92e7' }
  },
  Harbor: {
    light: { surface: '#fdfdfe', ink: '#1c1e22', accent: '#0a52a3', selection: '#CCDBEC', added: '#277c4c', removed: '#a52f27', skill: '#7436ab' },
    dark: { surface: '#121212', ink: '#ebebeb', accent: '#5399ea', selection: '#24384E', added: '#65c387', removed: '#e56e61', skill: '#c092e7' }
  },
  Forge: {
    light: { surface: '#f9fafb', ink: '#191f29', accent: '#13499a', selection: '#CBD7E8', added: '#277c4c', removed: '#a52f27', skill: '#7036ab' },
    dark: { surface: '#0c1118', ink: '#e6ebef', accent: '#5c91e0', selection: '#223550', added: '#65c387', removed: '#e56e61', skill: '#bd92e7' }
  },
  Axis: {
    light: { surface: '#f6f6f9', ink: '#1d1c26', accent: '#321f8e', selection: '#CFCBE4', added: '#277c4c', removed: '#a52f27', skill: '#9336ab' },
    dark: { surface: '#111013', ink: '#e4e3e8', accent: '#7e6dd0', selection: '#302A48', added: '#65c387', removed: '#e56e61', skill: '#d692e7' }
  },
  Paper: {
    light: { surface: '#fdfdfc', ink: '#22201d', accent: '#2f597f', selection: '#D4DCE3', added: '#277c4c', removed: '#a52f27', skill: '#6836ab' },
    dark: { surface: '#171717', ink: '#e9e9e7', accent: '#7da0bf', selection: '#343D46', added: '#65c387', removed: '#e56e61', skill: '#b792e7' }
  },
  Signal: {
    light: { surface: '#fcf9f8', ink: '#271d1b', accent: '#a11b0c', selection: '#EACDC9', added: '#277c4c', removed: '#a52f27', skill: '#8436ab' },
    dark: { surface: '#141010', ink: '#ebe6e5', accent: '#e86354', selection: '#4F2723', added: '#65c387', removed: '#e56e61', skill: '#cb92e7' }
  },
  Monolith: {
    light: { surface: '#fdfdfd', ink: '#1a1a1a', accent: '#424242', selection: '#D8D8D8', added: '#277c4c', removed: '#a52f27', skill: '#7836ab' },
    dark: { surface: '#0a0a0a', ink: '#ededed', accent: '#c7c7c7', selection: '#3F3F3F', added: '#65c387', removed: '#e56e61', skill: '#c292e7' }
  },
  Workbench: {
    light: { surface: '#f6f7f9', ink: '#181e25', accent: '#1d6690', selection: '#CBDAE4', added: '#277c4c', removed: '#a52f27', skill: '#6836ab' },
    dark: { surface: '#12171c', ink: '#e1e6ea', accent: '#6aacd2', selection: '#2B414F', added: '#65c387', removed: '#e56e61', skill: '#b792e7' }
  },
  Blueprint: {
    light: { surface: '#e9edf7', ink: '#111a30', accent: '#0c2fa1', selection: '#BDC7E6', added: '#277c4c', removed: '#a52f27', skill: '#8b36ab' },
    dark: { surface: '#0b101d', ink: '#dee3ed', accent: '#5678e6', selection: '#202D55', added: '#65c387', removed: '#e56e61', skill: '#d192e7' }
  },
  Brasspants: {
    light: { surface: '#f7f9fb', ink: '#181f28', accent: '#8a6410', selection: '#E1DBCC', added: '#1f7d5c', removed: '#bf3a34', skill: '#2f5fbd' },
    dark: { surface: '#0e1319', ink: '#dfe6ee', accent: '#d9a94b', selection: '#473D27', added: '#54b98c', removed: '#e2645e', skill: '#7fa6e8' }
  },
  Codechimp: {
    light: { surface: '#fbfcfd', ink: '#1a2027', accent: '#12805a', selection: '#CCE3DC', added: '#12805a', removed: '#c33b36', skill: '#4457c9' },
    dark: { surface: '#12161a', ink: '#e4eaef', accent: '#4bbf8a', selection: '#224539', added: '#4bbf8a', removed: '#e8615c', skill: '#8f9ef5' }
  },
  Greaseball: {
    light: { surface: '#faf6ef', ink: '#221d14', accent: '#a35a17', selection: '#E9D7C4', added: '#2f8f3f', removed: '#c2352b', skill: '#8d4fc4' },
    dark: { surface: '#17140f', ink: '#f2ece1', accent: '#e08a4c', selection: '#4F3520', added: '#5fb85f', removed: '#e2564a', skill: '#c98fe0' }
  },
  Sockpuppet: {
    light: { surface: '#fbf7f3', ink: '#241c1b', accent: '#b23b38', selection: '#ECD1CE', added: '#2d8a44', removed: '#b23b38', skill: '#8a4bbd' },
    dark: { surface: '#1a1415', ink: '#f0e6e3', accent: '#d9615c', selection: '#4F2A29', added: '#68b06a', removed: '#e2564a', skill: '#c184d6' }
  }
};

/* Emission order, with the section comments that make a diff readable. */
export const SECTIONS = [
  ['surfaces — the elevation ladder', ['--ground', '--panel', '--surface', '--well', '--card', '--card-hover', '--overlay']],
  ['controls', ['--field', '--field-hover', '--field-focus', '--field-disabled', '--focus-ring', '--field-focus-ring', '--control-edge']],
  ['row and control states', ['--hover', '--sel', '--press']],
  ['lines — interior divider, control edge, focused control edge, object edge, structural seam', ['--hair', '--field-edge', '--field-edge-focus', '--edge-raised', '--edge']],
  ['ink', ['--text', '--text-soft', '--muted', '--faint', '--placeholder', '--text-disabled']],
  ['primary action', ['--primary', '--primary-hover', '--primary-press', '--primary-disabled', '--on-primary']],
  ['accent — the interactive and "working" hue', ['--accent', '--accent-ink', '--accent-soft']],
  ['status', ['--waiting', '--waiting-ink', '--waiting-bg', '--blocked', '--blocked-ink', '--blocked-bg', '--blocked-bg-hover', '--verified', '--verified-ink', '--verified-bg', '--idle', '--idle-bg', '--diff-added-bg', '--diff-removed-bg', '--scrim']],
  ['categorical — derived from the skill seed, graphic use only', ['--id-1', '--id-2', '--id-3', '--id-4', '--id-5', '--id-6']],
  ['elevation', ['--shadow-card', '--shadow-card-hover', '--shadow-panel', '--shadow-pop', '--shadow-modal']],
  ['deprecated aliases — delete once no screen references them', ['--working', '--working-ink', '--working-bg', '--ctx-bg', '--amber-bg', '--error-bg']]
];

const INVARIANTS = [
  ':root {',
  "  --font-ui: 'Instrument Sans', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;",
  "  --font-mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;",
  '  --r-xs: 6px; --r-sm: 8px; --r: 10px; --r-md: 12px; --r-lg: 14px; --r-xl: 16px; --r-pill: 999px;',
  '  color-scheme: light dark;',
  '}'
].join('\n');

function block(selector, tokens, pad) {
  const p = pad || '';
  const lines = [p + selector + ' {'];
  for (const section of SECTIONS) {
    lines.push(p + '  /* ' + section[0] + ' */');
    for (const token of section[1]) lines.push(p + '  ' + token + ': ' + tokens[token] + ';');
  }
  lines.push(p + '}');
  return lines.join('\n');
}

export function buildCss(variants) {
  const count = Object.keys(variants.Umber.light.tokens).length;
  const out = [
    '/* themes.css — GENERATED by tools/build-themes.mjs. Do not hand-edit.',
    '   16 themes × 2 modes × ' + count + ' tokens, all derived from seven seeds',
    '   per theme. See DESIGN.md §2.2–§2.10; Appendix A binds each token to elements.',
    '',
    '   Usage:  <html data-theme="graphite" data-mode="dark">',
    '   data-mode: "light" | "dark" | omitted (follows prefers-color-scheme). */',
    '',
    INVARIANTS,
    ''
  ];
  for (const name of GROUPS.Authored.concat(GROUPS.Catalog)) {
    const id = name.toLowerCase();
    out.push('/* ==========================================================');
    out.push('   ' + name);
    out.push('   ========================================================== */');
    out.push(block('[data-theme="' + id + '"], [data-theme="' + id + '"][data-mode="light"]', variants[name].light.tokens));
    out.push('');
    out.push(block('[data-theme="' + id + '"][data-mode="dark"]', variants[name].dark.tokens));
    out.push('');
    out.push('@media (prefers-color-scheme: dark) {');
    out.push(block('[data-theme="' + id + '"]:not([data-mode="light"]):not([data-mode="dark"])', variants[name].dark.tokens, '  '));
    out.push('}');
    out.push('');
  }
  return out.join('\n');
}

export function buildJson(variants) {
  const worst = {};
  for (const name of Object.keys(variants)) {
    for (const mode of ['light', 'dark']) {
      for (const r of variants[name][mode].measured.results) {
        const key = r.token.indexOf('--id-') === 0 ? '--id-*' : r.token;
        if (!worst[key] || r.ratio < worst[key]) worst[key] = Number(r.ratio.toFixed(2));
      }
    }
  }
  const themes = {};
  for (const name of Object.keys(variants)) {
    themes[name] = {
      light: { seeds: SEEDS[name].light, tokens: variants[name].light.tokens, steps: variants[name].light.measured.steps },
      dark: { seeds: SEEDS[name].dark, tokens: variants[name].dark.tokens, steps: variants[name].dark.measured.steps }
    };
  }
  return {
    generated: new Date().toISOString().slice(0, 10),
    note: 'GENERATED by tools/build-themes.mjs. Do not hand-edit. Authored input is seven seeds per theme+mode; every token here is derived. See DESIGN.md §2.2–§2.10.',
    defaultTheme: DEFAULT_THEME,
    groups: GROUPS,
    contrastFloors: INK_FLOORS,
    planes: PLANE_TOKENS,
    ladder: LADDER,
    measured: worst,
    themes: themes
  };
}

export function buildAll() {
  const variants = {};
  const problems = [];
  const notes = [];
  for (const name of GROUPS.Authored.concat(GROUPS.Catalog)) {
    variants[name] = {};
    for (const mode of ['light', 'dark']) {
      const derived = deriveVariant(SEEDS[name][mode], mode);
      const measured = measureVariant(derived.tokens);
      variants[name][mode] = { tokens: derived.tokens, measured: measured };
      for (const token of SURFACE_PLANE_TOKENS) {
        const delta = derived.planeChromaDeltas[token];
        if (delta > PLANE_CHROMA_LIFT[mode] + 0.00001) {
          problems.push(
            name + ' ' + mode + ': ' + token + ' chroma differs from its surface seed by ' +
              delta.toFixed(6) + ', limit ' + PLANE_CHROMA_LIFT[mode].toFixed(3)
          );
        }
      }
      const surfaceRgb = hexToRgb(SEEDS[name][mode].surface);
      if (surfaceRgb[0] === surfaceRgb[1] && surfaceRgb[1] === surfaceRgb[2]) {
        for (const token of SURFACE_PLANE_TOKENS) {
          const rgb = hexToRgb(derived.tokens[token]);
          if (rgb[0] !== rgb[1] || rgb[1] !== rgb[2]) {
            problems.push(name + ' ' + mode + ': neutral surface seed tinted ' + token);
          }
        }
      }
      if (derived.accentNearWaiting) {
        notes.push(name + ' ' + mode + ': accent is within ' + 24 + '\u00b0 of the waiting hue \u2014 never put the accent on a status pill here');
      }
      for (const f of measured.failures) {
        problems.push(name + ' ' + mode + ': ' + f.token + ' is ' + f.ratio.toFixed(2) + ':1, floor ' + f.floor);
      }
      if (!measured.monotonic) problems.push(name + ' ' + mode + ': surface ladder is not monotonic');
      if (!measured.separated) problems.push(name + ' ' + mode + ': --field is not separated from its host planes');
      if (!measured.edgeFocusSeparated) {
        problems.push(name + ' ' + mode + ': --field-edge-focus is too close to --field-edge');
      }
    }
  }
  return { variants: variants, problems: problems, notes: notes };
}

/* --- CLI --- */
const here = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(here, '../themes.css');
const jsonPath = resolve(here, '../theme-tokens.json');
const result = buildAll();

if (result.problems.length) {
  console.error('Theme derivation failed its own floors:\n' + result.problems.map((p) => '  ' + p).join('\n'));
  process.exit(1);
}

const css = buildCss(result.variants);
const json = JSON.stringify(buildJson(result.variants), null, 2) + '\n';
const strip = (s) => s.replace(/"generated": "[^"]*",/, '');
const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

if (process.argv.includes('--check')) {
  const stale = [];
  if (read(cssPath) !== css) stale.push('themes.css');
  if (strip(read(jsonPath)) !== strip(json)) stale.push('theme-tokens.json');
  if (stale.length) {
    console.error('Stale generated output: ' + stale.join(', ') + '. Run: node tools/build-themes.mjs');
    process.exit(1);
  }
  console.log('themes.css and theme-tokens.json are current; all floors hold across 32 sets.');
} else {
  writeFileSync(cssPath, css);
  writeFileSync(jsonPath, json);
  console.log('Wrote themes.css and theme-tokens.json — 16 themes × 2 modes.');
}
