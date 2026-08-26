// build-themes.mjs — the single source of truth for Task Monki theming.
//
//   node tools/build-themes.mjs          # regenerate themes.css + theme-tokens.json
//   node tools/build-themes.mjs --check  # verify committed output is current + passes floors (CI)
//
// Authored input is SEEDS below: seven values per theme per mode. Everything else
// is derived here. Rules: never hand-edit the generated files, never add a token
// to one theme, never compute a derivation at runtime. See DESIGN.md §2.2–§2.9.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS_OUT = join(ROOT, 'themes.css');
const JSON_OUT = join(ROOT, 'theme-tokens.json');

/* ────────────────────────── seeds ──────────────────────────
   surface   the darkest (dark) / lightest (light) plane
   ink       primary text
   accent    interactive hue
   selection selected-row tint
   added     → --verified      removed → --blocked      skill → --id-*
   Adding a theme = adding one entry here. Nothing else.                   */

const AUTHORED = {
  Graphite: {
    dark:  { surface:'#08090A', ink:'#EDEEF0', accent:'#6E8BFF', selection:'#2E3138', added:'#3BA776', removed:'#E5615A', skill:'#A68CE0' },
    light: { surface:'#FDFDFE', ink:'#14161A', accent:'#3B5BDB', selection:'#DDE1EA', added:'#1A8F5E', removed:'#CF4640', skill:'#8B6FD1' } },
  Umber: {
    dark:  { surface:'#0C0B0A', ink:'#F2F0ED', accent:'#E0A96D', selection:'#37312A', added:'#4FA57C', removed:'#E0655B', skill:'#C79FE8' },
    light: { surface:'#FDFBF8', ink:'#1B1917', accent:'#A9663A', selection:'#DED8CB', added:'#1E8258', removed:'#C24A3F', skill:'#8A5AC0' } },
  Nocturne: {
    dark:  { surface:'#0A0C11', ink:'#E8EBF0', accent:'#7AA2F7', selection:'#232C3E', added:'#56B98A', removed:'#E4726C', skill:'#A48CE8' },
    light: { surface:'#FCFDFF', ink:'#10141C', accent:'#3457B2', selection:'#D5DCEA', added:'#17845A', removed:'#C34A44', skill:'#7C61C9' } },
};

const CATALOG = {
  Parchment: {
    dark:  { surface:'#14120f', ink:'#ede9e3', accent:'#cbb072', selection:'#473E2B', added:'#65c387', removed:'#e56e61', skill:'#dc92e7' },
    light: { surface:'#f7f4ed', ink:'#241b12', accent:'#876a26', selection:'#E1D8C5', added:'#277c4c', removed:'#a52f27', skill:'#9b36ab' } },
  Harbor: {
    dark:  { surface:'#121212', ink:'#ebebeb', accent:'#5399ea', selection:'#24384E', added:'#65c387', removed:'#e56e61', skill:'#c092e7' },
    light: { surface:'#fdfdfe', ink:'#1c1e22', accent:'#0a52a3', selection:'#CCDBEC', added:'#277c4c', removed:'#a52f27', skill:'#7436ab' } },
  Forge: {
    dark:  { surface:'#0c1118', ink:'#e6ebef', accent:'#5c91e0', selection:'#223550', added:'#65c387', removed:'#e56e61', skill:'#bd92e7' },
    light: { surface:'#f9fafb', ink:'#191f29', accent:'#13499a', selection:'#CBD7E8', added:'#277c4c', removed:'#a52f27', skill:'#7036ab' } },
  Axis: {
    dark:  { surface:'#111013', ink:'#e4e3e8', accent:'#7e6dd0', selection:'#302A48', added:'#65c387', removed:'#e56e61', skill:'#d692e7' },
    light: { surface:'#f6f6f9', ink:'#1d1c26', accent:'#321f8e', selection:'#CFCBE4', added:'#277c4c', removed:'#a52f27', skill:'#9336ab' } },
  Paper: {
    dark:  { surface:'#171717', ink:'#e9e9e7', accent:'#7da0bf', selection:'#343D46', added:'#65c387', removed:'#e56e61', skill:'#b792e7' },
    light: { surface:'#fdfdfc', ink:'#22201d', accent:'#2f597f', selection:'#D4DCE3', added:'#277c4c', removed:'#a52f27', skill:'#6836ab' } },
  Signal: {
    dark:  { surface:'#141010', ink:'#ebe6e5', accent:'#e86354', selection:'#4F2723', added:'#65c387', removed:'#e56e61', skill:'#cb92e7' },
    light: { surface:'#fcf9f8', ink:'#271d1b', accent:'#a11b0c', selection:'#EACDC9', added:'#277c4c', removed:'#a52f27', skill:'#8436ab' } },
  Monolith: {
    dark:  { surface:'#0a0a0a', ink:'#ededed', accent:'#c7c7c7', selection:'#3F3F3F', added:'#65c387', removed:'#e56e61', skill:'#c292e7' },
    light: { surface:'#fdfdfd', ink:'#1a1a1a', accent:'#424242', selection:'#D8D8D8', added:'#277c4c', removed:'#a52f27', skill:'#7836ab' } },
  Workbench: {
    dark:  { surface:'#12171c', ink:'#e1e6ea', accent:'#6aacd2', selection:'#2B414F', added:'#65c387', removed:'#e56e61', skill:'#b792e7' },
    light: { surface:'#f6f7f9', ink:'#181e25', accent:'#1d6690', selection:'#CBDAE4', added:'#277c4c', removed:'#a52f27', skill:'#6836ab' } },
  Blueprint: {
    dark:  { surface:'#0b101d', ink:'#dee3ed', accent:'#5678e6', selection:'#202D55', added:'#65c387', removed:'#e56e61', skill:'#d192e7' },
    light: { surface:'#e9edf7', ink:'#111a30', accent:'#0c2fa1', selection:'#BDC7E6', added:'#277c4c', removed:'#a52f27', skill:'#8b36ab' } },
  Brasspants: {
    dark:  { surface:'#0e1319', ink:'#dfe6ee', accent:'#d9a94b', selection:'#473D27', added:'#54b98c', removed:'#e2645e', skill:'#7fa6e8' },
    light: { surface:'#f7f9fb', ink:'#181f28', accent:'#8a6410', selection:'#E1DBCC', added:'#1f7d5c', removed:'#bf3a34', skill:'#2f5fbd' } },
  Codechimp: {
    dark:  { surface:'#12161a', ink:'#e4eaef', accent:'#4bbf8a', selection:'#224539', added:'#4bbf8a', removed:'#e8615c', skill:'#8f9ef5' },
    light: { surface:'#fbfcfd', ink:'#1a2027', accent:'#12805a', selection:'#CCE3DC', added:'#12805a', removed:'#c33b36', skill:'#4457c9' } },
  Greaseball: {
    dark:  { surface:'#17140f', ink:'#f2ece1', accent:'#e08a4c', selection:'#4F3520', added:'#5fb85f', removed:'#e2564a', skill:'#c98fe0' },
    light: { surface:'#faf6ef', ink:'#221d14', accent:'#a35a17', selection:'#E9D7C4', added:'#2f8f3f', removed:'#c2352b', skill:'#8d4fc4' } },
  Sockpuppet: {
    dark:  { surface:'#1a1415', ink:'#f0e6e3', accent:'#d9615c', selection:'#4F2A29', added:'#68b06a', removed:'#e2564a', skill:'#c184d6' },
    light: { surface:'#fbf7f3', ink:'#241c1b', accent:'#b23b38', selection:'#ECD1CE', added:'#2d8a44', removed:'#b23b38', skill:'#8a4bbd' } },
};

const SEEDS = { ...AUTHORED, ...CATALOG };
const GROUPS = { Authored: Object.keys(AUTHORED), Catalog: Object.keys(CATALOG) };
const DEFAULT_THEME = 'Umber';

/* ── contrast floors. Text needs 4.5; marks that only ever label need 3. ── */
const FLOORS = {
  '--text': 7, '--text-soft': 4.5, '--muted': 4.5,
  '--faint': 3, '--idle': 3, '--id-*': 3,
  '--accent-ink': 4.5, '--working-ink': 4.5, '--blocked-ink': 4.5, '--verified-ink': 4.5, '--waiting-ink': 4.5,
};

// Every plane a colour can land on. Getting this list wrong is the classic bug:
// solve --muted against the sheet only and it fails on menus (--overlay).
const PLANES = ['--ground','--panel','--surface','--card','--field','--field-hover','--sel','--overlay','--well'];

/* ────────────────────── colour maths ────────────────────── */
const hex2rgb = h => { h = h.replace('#',''); if (h.length === 3) h = h.split('').map(c=>c+c).join('');
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)]; };
const rgb2hex = c => '#' + c.map(v => Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,'0')).join('').toUpperCase();
const mix = (a,b,t) => { const A = hex2rgb(a), B = hex2rgb(b); return rgb2hex([0,1,2].map(i => A[i] + (B[i]-A[i])*t)); };
const rgba = (h,a) => { const c = hex2rgb(h); return `rgba(${c[0]},${c[1]},${c[2]},${a})`; };
const toLin = v => { v /= 255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); };
const lum = h => { const c = hex2rgb(h).map(toLin); return 0.2126*c[0] + 0.7152*c[1] + 0.0722*c[2]; };
const contrast = (a,b) => { const x = lum(a), y = lum(b); return (Math.max(x,y)+0.05) / (Math.min(x,y)+0.05); };

const gam = v => v <= 0.0031308 ? v*12.92 : 1.055*Math.pow(v,1/2.4) - 0.055;
const rgb2oklab = ([r,g,b]) => { r = toLin(r); g = toLin(g); b = toLin(b);
  const l = Math.cbrt(0.4122214708*r + 0.5363325363*g + 0.0514459929*b),
        m = Math.cbrt(0.2119034982*r + 0.6806995451*g + 0.1073969566*b),
        s = Math.cbrt(0.0883024619*r + 0.2817188376*g + 0.6299787005*b);
  return [0.2104542553*l + 0.7936177850*m - 0.0040720468*s,
          1.9779984951*l - 2.4285922050*m + 0.4505937099*s,
          0.0259040371*l + 0.7827717662*m - 0.8086757660*s]; };
const oklab2rgb = ([L,A,B]) => {
  const l = (L + 0.3963377774*A + 0.2158037573*B)**3,
        m = (L - 0.1055613458*A - 0.0638541728*B)**3,
        s = (L - 0.0894841775*A - 1.2914855480*B)**3;
  return [gam( 4.0767416621*l - 3.3077115913*m + 0.2309699292*s),
          gam(-1.2684380046*l + 2.6097574011*m - 0.3413193965*s),
          gam(-0.0041960863*l - 0.7034186147*m + 1.7076147010*s)].map(v => v*255); };
const hex2lch = h => { const [L,A,B] = rgb2oklab(hex2rgb(h)); return [L, Math.hypot(A,B), (Math.atan2(B,A)*180/Math.PI + 360) % 360]; };
const lch2hex = (L,C,H) => { // reduce chroma until in sRGB gamut
  for (let c = C; c > 0; c -= 0.004) {
    const h = H*Math.PI/180, rgb = oklab2rgb([L, c*Math.cos(h), c*Math.sin(h)]);
    if (rgb.every(v => v >= -0.5 && v <= 255.5)) return rgb2hex(rgb);
  }
  return rgb2hex(oklab2rgb([L,0,0])); };

const ID_BAND = { dark: { L:[0.72,0.80], C:[0.075,0.135] }, light: { L:[0.46,0.54], C:[0.085,0.150] } };
const clamp = (v,[a,b]) => Math.min(b, Math.max(a, v));

/* ────────────────────── the derivation ────────────────────── */
function derive(seed, variant) {
  const S = seed.surface, I = seed.ink, A = seed.accent, W = '#FFFFFF', K = '#000000';
  const dark = variant === 'dark';

  // Surface ladder. Dark rises off a near-black ground; light drops the ground
  // BELOW the card so the sheet still reads lighter than the rail and nothing is #fff.
  const t = dark ? {
    '--ground': S,               '--panel': mix(S,I,0.022),  '--surface': mix(S,I,0.045),
    '--field':  mix(S,I,0.058),  '--card':  mix(S,I,0.085),  '--overlay': mix(S,I,0.13),
    '--well':   mix(S,I,0.018),  '--field-hover': mix(S,I,0.095), '--field-focus': mix(S,I,0.095),
    '--hover': rgba(I,0.04), '--sel': mix(S,seed.selection,0.62), '--press': rgba(I,0.09),
    '--field-ring': rgba(I,0.06), '--field-focus-ring': rgba(A,0.22),
    '--hair': rgba(I,0.07), '--edge': rgba(I,0.13),
    '--text': I, '--text-soft': mix(I,S,0.26),
    '--primary': mix(I,W,0.18), '--primary-hover': W, '--on-primary': mix(S,K,0.25),
    '--accent': A, '--accent-soft': rgba(A,0.13), '--working': A,
    '--waiting': '#DEA35E', '--waiting-ink': '#E4B478',
    '--blocked': seed.removed, '--verified': seed.added,
    '--amber-bg': 'rgba(222,163,94,.13)', '--ctx-bg': rgba(A,0.12), '--error-bg': rgba(seed.removed,0.12),
    '--verified-bg': 'color-mix(in srgb, var(--verified) 12%, transparent)',
    '--diff-added-bg': 'color-mix(in srgb, var(--verified) 10%, transparent)',
    '--diff-removed-bg': 'color-mix(in srgb, var(--blocked) 10%, transparent)',
    '--scrim': 'color-mix(in srgb, var(--ground) 60%, transparent)',
    '--shadow-card': 'none', '--shadow-panel': 'none',
    '--shadow-pop': `0 22px 50px ${rgba(mix(S,K,0.85),0.62)}`,
    '--shadow-modal': `0 40px 90px ${rgba(mix(S,K,0.9),0.74)}`,
  } : {
    '--card': S,                 '--overlay': S,             '--surface': mix(S,I,0.022),
    '--panel': mix(S,I,0.042),   '--well': mix(S,I,0.055),   '--ground': mix(S,I,0.065),
    '--field': mix(S,I,0.085),   '--field-hover': mix(S,I,0.115), '--field-focus': mix(S,I,0.012),
    '--hover': rgba(I,0.045), '--sel': mix(S,seed.selection,0.55), '--press': rgba(I,0.08),
    '--field-ring': rgba(I,0.06), '--field-focus-ring': rgba(A,0.18),
    '--hair': rgba(I,0.09), '--edge': rgba(I,0.15),
    '--text': I, '--text-soft': mix(I,S,0.24),
    '--primary': mix(I,K,0.06), '--primary-hover': mix(mix(I,K,0.06),S,0.07), '--on-primary': mix(S,W,0.6),
    '--accent': A, '--accent-soft': mix(S,A,0.11), '--working': A,
    '--waiting': '#A9740F', '--waiting-ink': '#7E540A',
    '--blocked': seed.removed, '--verified': seed.added,
    '--amber-bg': mix(S,'#C9924A',0.16), '--ctx-bg': mix(S,A,0.09), '--error-bg': mix(S,seed.removed,0.09),
    '--verified-bg': 'color-mix(in srgb, var(--verified) 12%, transparent)',
    '--diff-added-bg': 'color-mix(in srgb, var(--verified) 10%, transparent)',
    '--diff-removed-bg': 'color-mix(in srgb, var(--blocked) 10%, transparent)',
    '--scrim': 'color-mix(in srgb, var(--ground) 60%, transparent)',
    '--shadow-card': `0 1px 2px ${rgba(I,0.07)}`, '--shadow-panel': `0 2px 8px ${rgba(I,0.06)}`,
    '--shadow-pop': `0 18px 40px ${rgba(I,0.16)}`, '--shadow-modal': `0 32px 80px ${rgba(I,0.24)}`,
  };

  const planes = () => PLANES.map(k => t[k]);
  const worst = c => Math.min(...planes().map(p => contrast(c,p)));

  // Ink ramp: walk toward the ground until the floor is met, so a theme with a
  // pale ground gets darker muted text automatically.
  const solveRamp = (floor, start) => { let f = start;
    while (f > 0.02 && worst(mix(I, t['--ground'], f)) < floor) f -= 0.01; return f; };
  const fMuted = solveRamp(FLOORS['--muted'], 0.50);
  t['--muted'] = mix(I, t['--ground'], fMuted);
  const fFaint = solveRamp(FLOORS['--faint'], Math.min(fMuted + 0.20, 0.74));
  t['--faint'] = mix(I, t['--ground'], fFaint);
  t['--placeholder'] = t['--faint'];
  t['--idle'] = t['--faint'];

  // Status/accent inks: push the hue toward white (dark) or black (light) until legible.
  const toward = dark ? W : K;
  for (const [key, base] of [['--accent-ink',A], ['--working-ink',A],
                             ['--blocked-ink',seed.removed], ['--verified-ink',seed.added]]) {
    let m = dark ? 0.22 : 0.14;
    while (m < 0.85 && worst(mix(base, toward, m)) < FLOORS[key]) m += 0.03;
    t[key] = mix(base, toward, m);
  }

  // Categorical hues: six 60° rotations of `skill`, normalised to one L and C
  // so no category shouts. --id-2 is skill itself.
  const [L0,C0,H0] = hex2lch(seed.skill), band = ID_BAND[variant];
  const L = clamp(L0, band.L), C = clamp(C0, band.C);
  for (let n = 1; n <= 6; n++) t[`--id-${n}`] = lch2hex(L, C, (H0 + (n-2)*60 + 360) % 360);

  return t;
}

/* ── emit order. Also the completeness contract: every set has all of these. ── */
const ORDER = [
  '--ground','--panel','--surface','--card','--overlay','--well',
  '--field','--field-hover','--field-focus','--field-ring','--field-focus-ring',
  '--hover','--sel','--press','--hair','--edge',
  '--text','--text-soft','--muted','--faint','--placeholder',
  '--primary','--primary-hover','--on-primary',
  '--accent','--accent-soft','--accent-ink',
  '--working','--working-ink','--waiting','--waiting-ink',
  '--blocked','--blocked-ink','--verified','--verified-ink','--idle',
  '--amber-bg','--ctx-bg','--error-bg',
  '--verified-bg','--diff-added-bg','--diff-removed-bg','--scrim',
  '--id-1','--id-2','--id-3','--id-4','--id-5','--id-6',
  '--shadow-card','--shadow-panel','--shadow-pop','--shadow-modal',
];

/* ────────────────────── build + verify ────────────────────── */
const themes = {};
for (const [name, modes] of Object.entries(SEEDS)) {
  themes[name] = {};
  for (const variant of ['dark','light'])
    themes[name][variant] = { seeds: modes[variant], tokens: derive(modes[variant], variant) };
}

const failures = [];
const stats = {};
for (const [name, modes] of Object.entries(themes)) {
  for (const [variant, { tokens }] of Object.entries(modes)) {
    const where = `${name}/${variant}`;
    for (const k of ORDER) if (tokens[k] === undefined) failures.push(`${where} missing ${k}`);

    const planes = PLANES.map(k => tokens[k]);
    const worst = k => Math.min(...planes.map(p => contrast(tokens[k], p)));
    for (const [k, floor] of Object.entries(FLOORS)) {
      const keys = k === '--id-*' ? [1,2,3,4,5,6].map(n => `--id-${n}`) : [k];
      for (const key of keys) {
        const r = worst(key);
        if (r < floor) failures.push(`${where} ${key} ${r.toFixed(2)}:1 < ${floor}`);
        stats[k] = Math.min(stats[k] ?? Infinity, r);
      }
    }
    // structural invariants from DESIGN.md §2.3 / §2.6
    const L = k => lum(tokens[k]);
    if (L('--surface') <= L('--ground')) failures.push(`${where} sheet not lighter than rail`);
    if (variant === 'dark') {
      if (L('--card') <= L('--surface')) failures.push(`${where} card not lighter than sheet`);
      if (tokens['--shadow-card'] !== 'none') failures.push(`${where} dark card must not carry a shadow`);
    } else {
      for (const k of ['--ground','--panel','--surface','--card','--overlay','--field'])
        if (['#FFFFFF','#FFF'].includes(tokens[k].toUpperCase())) failures.push(`${where} ${k} is pure white`);
    }
  }
}
if (failures.length) { console.error('FAILED:\n  ' + failures.join('\n  ')); process.exit(1); }

const json = JSON.stringify({
  generated: new Date().toISOString().slice(0,10),
  note: 'GENERATED by tools/build-themes.mjs. Do not hand-edit. Authored input is seven seeds per theme+mode; every token here is derived. See DESIGN.md §2.2–§2.9.',
  defaultTheme: DEFAULT_THEME, groups: GROUPS, contrastFloors: FLOORS, planes: PLANES,
  measured: Object.fromEntries(Object.entries(stats).map(([k,v]) => [k, +v.toFixed(2)])),
  themes,
}, null, 2) + '\n';

const block = (sel, t, ind = '  ') => `${sel} {\n${ORDER.map(k => `${ind}${k}: ${t[k]};`).join('\n')}\n}`;
let css = `/* themes.css — GENERATED by tools/build-themes.mjs. Do not hand-edit.
   ${Object.keys(themes).length} themes × 2 modes × ${ORDER.length} tokens, all derived from seven seeds
   per theme. See DESIGN.md §2.2–§2.9; Appendix A binds each token to elements.

   Usage:  <html data-theme="${DEFAULT_THEME.toLowerCase()}" data-mode="dark">
   data-mode: "light" | "dark" | omitted (follows prefers-color-scheme). */

:root {
  --font-ui: 'Instrument Sans', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  --font-mono: 'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --r-xs: 6px; --r-sm: 8px; --r: 10px; --r-md: 12px; --r-lg: 14px; --r-xl: 16px; --r-pill: 999px;
  color-scheme: light dark;
}
`;
for (const [name, modes] of Object.entries(themes)) {
  const s = name.toLowerCase();
  css += `\n/* ${'='.repeat(58)}\n   ${name}\n   ${'='.repeat(58)} */\n`;
  css += block(`[data-theme="${s}"], [data-theme="${s}"][data-mode="light"]`, modes.light.tokens) + '\n\n';
  css += block(`[data-theme="${s}"][data-mode="dark"]`, modes.dark.tokens) + '\n\n';
  css += `@media (prefers-color-scheme: dark) {\n`
       + block(`  [data-theme="${s}"]:not([data-mode="light"]):not([data-mode="dark"])`, modes.dark.tokens, '    ')
       + `\n}\n`;
}

if (process.argv.includes('--check')) {
  const stale = [[CSS_OUT, css], [JSON_OUT, json]].filter(([p, want]) =>
    !existsSync(p) || readFileSync(p, 'utf8').replace(/"generated": "[^"]*"/, '') !== want.replace(/"generated": "[^"]*"/, ''));
  if (stale.length) { console.error('STALE (run without --check):\n  ' + stale.map(([p]) => p).join('\n  ')); process.exit(1); }
  console.log(`ok — ${Object.keys(themes).length} themes × 2 modes × ${ORDER.length} tokens, all floors met`);
} else {
  writeFileSync(CSS_OUT, css);
  writeFileSync(JSON_OUT, json);
  console.log(`wrote themes.css + theme-tokens.json — ${Object.keys(themes).length} themes × 2 modes × ${ORDER.length} tokens`);
  console.log('measured worst case: ' + Object.entries(stats).map(([k,v]) => `${k} ${v.toFixed(2)}`).join(' · '));
}
