/* theme-derivation.mjs — the whole theme derivation, as pure functions.
 *
 * Authored input is seven seeds per theme per mode. Everything else is derived
 * here and nowhere else. No node APIs, no I/O: build-themes.mjs is the only
 * file that touches the filesystem, so this module can also be loaded by tests
 * and by the audit tooling.
 *
 * Design contract (DESIGN.md §2):
 *   1. Surfaces are a strictly monotonic ladder in perceived lightness.
 *   2. An interaction step is always SMALLER than the structural step it sits
 *      inside, so state never reads as elevation.
 *   3. Every ink is SOLVED against every plane it can land on, never picked.
 *   4. Two themes may differ in hue and chroma only. All structure is shared.
 *   5. A derivation never ADDS chroma a seed does not have, and never scales
 *      chroma by a quantity that varies per theme. Both are how a rule tuned on
 *      a near-neutral theme silently repaints a chromatic one.
 */

/* ------------------------------------------------------------------ */
/* Colour maths                                                        */
/* ------------------------------------------------------------------ */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function hexToRgb(hex) {
  const h = hex.trim().replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]) {
  const to = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0').toUpperCase();
  return `#${to(r)}${to(g)}${to(b)}`;
}

const toLinear = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const fromLinear = (v) => 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

export function relativeLuminance(rgb) {
  const [r, g, b] = rgb.map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio. Both inputs opaque sRGB. */
export function contrast(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** CIE L* — the scale the audit measures surface steps in. */
export function lstar(rgb) {
  const y = relativeLuminance(rgb);
  return y <= 216 / 24389 ? (y * 24389) / 27 : Math.cbrt(y) * 116 - 16;
}

export function rgbToOklab([r, g, b]) {
  const R = toLinear(r);
  const G = toLinear(g);
  const B = toLinear(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ];
}

export function oklabToRgb([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  ];
}

export function rgbToOklch(rgb) {
  const [L, a, b] = rgbToOklab(rgb);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { L, C: Math.hypot(a, b), h };
}

const inGamut = ([r, g, b]) => [r, g, b].every((v) => v >= -0.5 && v <= 255.5);

/** OKLCH → sRGB, reducing chroma until the result is representable. */
export function oklch({ L, C, h }) {
  const rad = (h * Math.PI) / 180;
  let c = Math.max(0, C);
  for (let i = 0; i < 60; i += 1) {
    const rgb = oklabToRgb([clamp(L, 0, 1), Math.cos(rad) * c, Math.sin(rad) * c]);
    if (inGamut(rgb)) return rgb.map((v) => clamp(v, 0, 255));
    c *= 0.94;
  }
  return oklabToRgb([clamp(L, 0, 1), 0, 0]).map((v) => clamp(v, 0, 255));
}

/** Same hue and chroma, moved to a target CIE L*. */
export function atLstar({ C, h }, target) {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (lstar(oklch({ L: mid, C, h })) < target) lo = mid;
    else hi = mid;
  }
  return oklch({ L: (lo + hi) / 2, C, h });
}

/** Composite an alpha colour over an opaque plane. */
export function over(rgba, plane) {
  const a = rgba[3];
  return [0, 1, 2].map((i) => rgba[i] * a + plane[i] * (1 - a));
}

const rgba = (rgb, a) =>
  `rgba(${rgb.slice(0, 3).map((v) => Math.round(v)).join(',')},${a})`;

/* ------------------------------------------------------------------ */
/* The ladder                                                          */
/* ------------------------------------------------------------------ */

/* CIE L* offsets from the anchor. Dark anchors on --ground (the seed is the
 * darkest plane); light anchors on the seed, which is the top of the ladder.
 *
 * Every step here is deliberate:
 *   - field sits a full step above the sheet in dark mode (was +1.4, invisible)
 *   - card stays above field, so a field on a card still reads as recessed
 *   - overlay is the lightest plane in both modes: the topmost layer is the
 *     lightest layer, which is why light mode no longer ties card to overlay
 *   - state steps (hover/press/focus) are all smaller than the smallest
 *     structural step, so no state can be mistaken for elevation
 */
export const LADDER = {
  dark: {
    ground: 0,
    well: 1.0,
    panel: 1.7,
    surface: 3.6,
    fieldDisabled: 4.8,
    field: 7.2,
    fieldHover: 9.0,
    sel: 7.8,
    card: 10.3,
    fieldFocus: 10.9,
    cardHover: 12.1,
    overlay: 15.0
  },
  light: {
    /* offsets are subtracted from the seed's L* */
    overlay: 0.2,
    card: 1.0,
    fieldFocus: 1.4,
    cardHover: 2.0,
    surface: 2.6,
    panel: 4.0,
    fieldDisabled: 5.0,
    well: 5.2,
    ground: 6.1,
    sel: 6.2,
    field: 7.4,
    fieldHover: 9.2
  }
};

/* Alpha overlays for state. Quieter than the structural steps they sit inside. */
export const ALPHA = {
  dark: { hover: 0.03, press: 0.075, focusLine: 0.5, focusRing: 0.22 },
  light: { hover: 0.04, press: 0.075, focusLine: 0.42, focusRing: 0.18 }
};

/* Line weights, as CONTRAST TARGETS rather than fixed alphas — four jobs:
 *   hair       a divider INSIDE a surface, where content continues
 *   fieldEdge  the resting boundary of a filled control: input, textarea,
 *              composer, select, segmented track, secondary button
 *   edgeRaised the boundary of an OBJECT resting on its plane (a card)
 *   edge       a SEAM between structural planes, and floating overlays
 *
 * A fixed alpha over ink does not land the same way twice: 0.10 over a
 * near-white ink on Nocturne's #0A0C11 ground is a clear rim, and the same 0.10
 * inside a Paper menu at L* 22 is nothing. So each weight states the ratio it
 * must clear against BOTH surfaces it separates, and the alpha is solved per
 * theme per mode — the same discipline the inks already use, and the same reason
 * it is legitimate: a floor is a constraint, not a per-theme preference. */
export const EDGE_TARGETS = {
  dark: { hair: 1.14, fieldEdge: 1.24, edgeRaised: 1.3, edge: 1.4 },
  light: { hair: 1.145, fieldEdge: 1.21, edgeRaised: 1.22, edge: 1.36 }
};

/* Chroma budget for the surface ladder — an absolute lift in OKLCH C across the
 * whole ladder, not a multiplier. See the note in plane(). */
export const PLANE_CHROMA_LIFT = { dark: 0.006, light: 0 };

/* Below this chroma a seed is grey and its hue angle is rounding noise. Nothing
 * derived from it may be tinted. Graphite's #08090A sits just above it — barely
 * cool, and it stays barely cool; Monolith, Harbor and Paper seed r=g=b and get
 * no tint at any rung. */
export const ACHROMATIC = 0.002;

/* Ink targets: contrast floors, solved per theme against every plane. */
export const INK_FLOORS = {
  '--text': 7,
  '--text-soft': 4.5,
  '--muted': 4.5,
  '--placeholder': 4.5,
  '--text-disabled': 3.5,
  '--faint': 3,
  '--idle': 3,
  '--accent-ink': 4.5,
  '--waiting-ink': 4.5,
  '--blocked-ink': 4.5,
  '--verified-ink': 4.5,
  '--id-*': 3
};

/* Solve with a little headroom so a later seed nudge does not break CI. */
const MARGIN = 1.045;

/** The smallest alpha of `ink` that clears `target` against every host it can
 *  be drawn on. A line is composited over the plane it sits on, so the check is
 *  the composite against that same plane — done for each host, worst wins. */
function solveEdgeAlpha(ink, hosts, target) {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i += 1) {
    const a = (lo + hi) / 2;
    const ok = hosts.every((h) => contrast(over([...ink.slice(0, 3), a], h), h) >= target);
    if (ok) hi = a;
    else lo = a;
  }
  return Math.round(hi * 1000) / 1000;
}

/* The planes an ink can land on. Solved against all of them, not just the sheet. */
export const PLANE_TOKENS = [
  '--ground',
  '--panel',
  '--surface',
  '--well',
  '--field',
  '--field-hover',
  '--field-focus',
  '--field-disabled',
  '--sel',
  '--card',
  '--card-hover',
  '--overlay'
];

/* Planes derived from the surface seed. --sel is deliberately excluded: it is
 * derived from the independent selection seed and has its own chroma ceiling. */
export const SURFACE_PLANE_TOKENS = [
  '--ground',
  '--panel',
  '--surface',
  '--well',
  '--field',
  '--field-hover',
  '--field-focus',
  '--field-disabled',
  '--card',
  '--card-hover',
  '--overlay'
];

/** The waiting hue is shared by every theme so "needs you" reads the same
 *  everywhere — it is the one hue that must not be theme-specific, and that
 *  includes the four themes whose own accent is also warm. Moving it out of
 *  their way (−0.09 L, +0.02 C) cost more than it bought: it made the one
 *  constant in the system read as a second, muddier brown in Umber, Parchment,
 *  Brasspants and Greaseball — the themes least able to absorb another warm
 *  hue — while leaving the other twelve alone. The collision is real and it is
 *  resolved by form, not by hue: a status is a -bg pill with -ink text beside a
 *  word, and the accent never appears on a status pill (DESIGN §2.7). The
 *  proximity is reported by the build instead of corrected in the colour. */
const WAITING = {
  dark: { L: 0.79, C: 0.11, h: 69 },
  light: { L: 0.6, C: 0.122, h: 76 }
};
const HUE_SEPARATION = 24;

function hueDistance(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/* Designed ink ladder, in CIE L*. These are the values the product already
 * reads well at; the solver only moves an ink when a plane change would push it
 * under its floor. An ink is never picked to "look right" and never left
 * unverified. */
const INK_TARGETS = {
  dark: { textSoft: 73.4, muted: 60.5, faint: 48.2, disabled: 53.5, idle: 48.5 },
  light: { textSoft: 33.5, muted: 42.1, faint: 53.7, disabled: 49.5, idle: 53.5 }
};

/** Verify at a designed L*, then push away from the planes only as far as the
 *  floor demands. Returns sRGB. */
function solveInk({ C, h }, planes, floor, mode, designedLstar) {
  const target = floor * MARGIN;
  const worst = (rgb) => planes.reduce((min, p) => Math.min(min, contrast(rgb, p)), Infinity);
  const start = designedLstar === undefined ? (mode === 'dark' ? 55 : 55) : designedLstar;
  let candidate = atLstar({ C, h }, start);
  if (worst(candidate) >= target) return candidate;
  const dir = mode === 'dark' ? 1 : -1;
  for (let l = start + dir * 0.5; l >= 0 && l <= 100; l += dir * 0.5) {
    candidate = atLstar({ C, h }, l);
    if (worst(candidate) >= target) return candidate;
  }
  return candidate;
}

/* ------------------------------------------------------------------ */
/* Derivation                                                          */
/* ------------------------------------------------------------------ */

export function deriveVariant(seeds, mode) {
  const dark = mode === 'dark';
  const step = LADDER[mode];
  const alpha = ALPHA[mode];

  const seedSurface = hexToRgb(seeds.surface);
  const seedInk = hexToRgb(seeds.ink);
  const accentSeed = rgbToOklch(hexToRgb(seeds.accent));
  const selSeed = rgbToOklch(hexToRgb(seeds.selection));
  const addedSeed = rgbToOklch(hexToRgb(seeds.added));
  const removedSeed = rgbToOklch(hexToRgb(seeds.removed));
  const skillSeed = rgbToOklch(hexToRgb(seeds.skill));

  const surfaceChroma = rgbToOklch(seedSurface);
  const anchor = lstar(seedSurface);

  /* Chroma is HELD across the ladder, with one small absolute lift in dark mode
   * so a tint does not thin out as its plane lightens.
   *
   * The previous rule multiplied chroma by (1 + 0.9 × offset / anchor), clamped
   * at 4× — it held *saturation* constant rather than chroma. On a near-black
   * ground the denominator is 3–11 L*, so the multiplier ran 2.2–5× and reached
   * its clamp: the lighter the plane, the more colour it gained. On Graphite
   * (seed C 0.006) 4× is 0.024 and invisible, which is why the rule read as
   * harmless; on Blueprint (seed C 0.047) it emitted an 0.108 overlay — a
   * saturated navy menu — and Forge, Nocturne and Brasspants the same. The
   * amplification was inversely proportional to how dark a theme's ground is,
   * so it hit hardest exactly the dark chromatic themes.
   *
   * The lift below is absolute: the same amount of colour in every theme rather
   * than a multiple of what the theme already has, and none at all for an
   * achromatic seed. L* is untouched, so every ladder step and every contrast
   * ratio measured on the previous derivation still holds. */
  const span = Math.max(...Object.values(step));
  const plane = (offset) => {
    const L = dark ? anchor + offset : anchor - offset;
    const lift =
      surfaceChroma.C < ACHROMATIC ? 0 : PLANE_CHROMA_LIFT[mode] * (offset / span);
    return atLstar({ C: surfaceChroma.C + lift, h: surfaceChroma.h }, L);
  };

  const ground = plane(step.ground);
  const panel = plane(step.panel);
  const surface = plane(step.surface);
  const well = plane(step.well);
  const field = plane(step.field);
  const fieldHover = plane(step.fieldHover);
  const fieldFocus = plane(step.fieldFocus);
  const fieldDisabled = plane(step.fieldDisabled);
  const card = plane(step.card);
  const cardHover = plane(step.cardHover);
  const overlay = plane(step.overlay);

  /* Selection is derived, not seeded: one fixed step on the ladder, tinted with
   * the selection seed's own hue. Equal weight across themes comes from the L*
   * step, which is identical everywhere; the chroma is a CEILING, not a target.
   * Clamping it up to a fixed value painted a tint onto the themes whose
   * selection seed is grey — Monolith 0 → 0.021, Paper 0.012 → 0.021 — at a hue
   * angle that is rounding noise, and doubled Graphite's. */
  const selC = selSeed.C < ACHROMATIC ? 0 : Math.min(selSeed.C, dark ? 0.021 : 0.017);
  const sel = atLstar(
    { C: selC, h: selSeed.h },
    dark ? anchor + step.sel : anchor - step.sel
  );

  const planes = [
    ground, panel, surface, well, field, fieldHover, fieldFocus, fieldDisabled, sel, card, cardHover, overlay
  ];
  const surfacePlanes = {
    '--ground': ground,
    '--panel': panel,
    '--surface': surface,
    '--well': well,
    '--field': field,
    '--field-hover': fieldHover,
    '--field-focus': fieldFocus,
    '--field-disabled': fieldDisabled,
    '--card': card,
    '--card-hover': cardHover,
    '--overlay': overlay
  };

  /* ---- ink ---- */
  const inkOk = rgbToOklch(seedInk);
  const T = INK_TARGETS[mode];
  const text = solveInk(inkOk, planes, INK_FLOORS['--text'], mode, lstar(seedInk));
  const textSoft = solveInk({ C: inkOk.C * 0.85, h: inkOk.h }, planes, INK_FLOORS['--text-soft'], mode, T.textSoft);
  const muted = solveInk({ C: inkOk.C * 0.8, h: inkOk.h }, planes, INK_FLOORS['--muted'], mode, T.muted);
  const textDisabled = solveInk({ C: inkOk.C * 0.8, h: inkOk.h }, planes, INK_FLOORS['--text-disabled'], mode, T.disabled);
  const faint = solveInk({ C: inkOk.C * 0.8, h: inkOk.h }, planes, INK_FLOORS['--faint'], mode, T.faint);

  /* A tinted pill is a plane too. Status ink is solved against its own tint
   * over every host it can sit on, which is what stops a pill from being
   * readable on the sheet and unreadable in a menu. */
  const tintPct = dark ? 0.14 : 0.12;
  const withTints = (hueRgb) => [
    ...planes,
    ...[surface, card, overlay, field].map((p) => over([...hueRgb.slice(0, 3), tintPct], p))
  ];

  /* ---- accent and status hues ---- */
  const accent = oklch(accentSeed);
  const accentInk = solveInk(
    { C: accentSeed.C * 0.78, h: accentSeed.h },
    withTints(accent),
    INK_FLOORS['--accent-ink'],
    mode,
    dark ? Math.max(lstar(accent) + 6, 74) : Math.min(lstar(accent) - 8, 42)
  );

  const waitingOk = WAITING[mode];
  /* An achromatic accent cannot be confused with amber, so only a chromatic
   * accent close in hue is worth reporting. */
  const accentNearWaiting =
    accentSeed.C > 0.04 && hueDistance(accentSeed.h, waitingOk.h) < HUE_SEPARATION;
  const waiting = oklch(waitingOk);
  const waitingInk = solveInk(
    { C: waitingOk.C * 0.78, h: waitingOk.h },
    withTints(waiting),
    INK_FLOORS['--waiting-ink'],
    mode,
    dark ? Math.max(lstar(waiting) + 5, 76) : 39
  );

  const blocked = oklch(removedSeed);
  const blockedInk = solveInk(
    { C: removedSeed.C * 0.78, h: removedSeed.h },
    withTints(blocked),
    INK_FLOORS['--blocked-ink'],
    mode,
    dark ? Math.max(lstar(blocked) + 8, 66) : 41.5
  );
  const verified = oklch(addedSeed);
  const verifiedInk = solveInk(
    { C: addedSeed.C * 0.78, h: addedSeed.h },
    withTints(verified),
    INK_FLOORS['--verified-ink'],
    mode,
    dark ? Math.max(lstar(verified) + 8, 70) : 41.7
  );

  /* Idle is a graphic hue (dot, bar), never prose: 3:1 like --faint. */
  const idle = solveInk({ C: inkOk.C * 0.6, h: inkOk.h }, planes, INK_FLOORS['--idle'], mode, T.idle);

  /* ---- primary ---- */
  /* The primary action is the ink extreme, so it carries the ink's cast rather
   * than the surface's: a cool theme keeps a cool near-black button. */
  const primaryOk = { C: inkOk.C * 1.2, h: inkOk.h };
  const primary = atLstar(primaryOk, dark ? clamp(anchor + 92, 0, 96) : clamp(anchor - 90, 4, 100));
  const primaryHover = atLstar(primaryOk, lstar(primary) + (dark ? 2.6 : 7.5));
  const primaryPress = atLstar(primaryOk, lstar(primary) + (dark ? -3.4 : 4));
  const onPrimary = dark
    ? atLstar({ C: surfaceChroma.C, h: surfaceChroma.h }, Math.max(anchor - 0.8, anchor * 0.6))
    : plane(step.overlay);

  /* ---- categorical hues: skill, rotated, one L and one C ---- */
  const idBand = dark ? { L: [0.72, 0.8], C: [0.075, 0.135] } : { L: [0.46, 0.54], C: [0.085, 0.15] };
  const idL = clamp(skillSeed.L, idBand.L[0], idBand.L[1]);
  const idC = clamp(skillSeed.C, idBand.C[0], idBand.C[1]);
  const ids = [1, 2, 3, 4, 5, 6].map((n) =>
    oklch({ L: idL, C: idC, h: (skillSeed.h + (n - 2) * 60 + 360) % 360 })
  );

  /* ---- lines, rings, shadows ---- */
  const inkAlpha = (a) => rgba(seedInk, a);
  const shadowInk = dark
    ? oklch({ L: 0.03, C: 0, h: 0 })
    : atLstar({ C: inkOk.C, h: inkOk.h }, 8);

  const tint = (token, pct) => `color-mix(in oklab, var(${token}) ${pct}%, transparent)`;

  /* Line weights, solved against the planes each one can be drawn on. */
  const target = EDGE_TARGETS[mode];
  const hairA = solveEdgeAlpha(seedInk, [panel, surface, card, overlay, field], target.hair);
  const fieldEdgeA = solveEdgeAlpha(seedInk, [field, surface, card, overlay], target.fieldEdge);
  const edgeRaisedA = solveEdgeAlpha(seedInk, [panel, surface, card], target.edgeRaised);
  const edgeA = solveEdgeAlpha(seedInk, [ground, panel, surface], target.edge);

  const tokens = {
    /* surfaces */
    '--ground': rgbToHex(ground),
    '--panel': rgbToHex(panel),
    '--surface': rgbToHex(surface),
    '--well': rgbToHex(well),
    '--card': rgbToHex(card),
    '--card-hover': rgbToHex(cardHover),
    '--overlay': rgbToHex(overlay),

    /* controls */
    '--field': rgbToHex(field),
    '--field-hover': rgbToHex(fieldHover),
    '--field-focus': rgbToHex(fieldFocus),
    '--field-disabled': rgbToHex(fieldDisabled),
    '--field-focus-line': rgba(accent, alpha.focusLine),
    '--focus-ring': rgba(accent, alpha.focusRing),
    '--field-focus-ring': 'var(--focus-ring)',

    /* row and control states */
    '--hover': inkAlpha(alpha.hover),
    '--sel': rgbToHex(sel),
    '--press': inkAlpha(alpha.press),
    '--hair': inkAlpha(hairA),
    '--field-edge': inkAlpha(fieldEdgeA),
    '--edge-raised': inkAlpha(edgeRaisedA),
    '--edge': inkAlpha(edgeA),
    '--control-edge': rgbToHex(
      solveInk({ C: inkOk.C * 0.6, h: inkOk.h }, [field, card, surface], 3, mode, dark ? 45 : 58)
    ),

    /* ink */
    '--text': rgbToHex(text),
    '--text-soft': rgbToHex(textSoft),
    '--muted': rgbToHex(muted),
    '--faint': rgbToHex(faint),
    '--placeholder': 'var(--muted)',
    '--text-disabled': rgbToHex(textDisabled),

    /* primary action */
    '--primary': rgbToHex(primary),
    '--primary-hover': rgbToHex(primaryHover),
    '--primary-press': rgbToHex(primaryPress),
    '--primary-disabled': rgbToHex(fieldDisabled),
    '--on-primary': rgbToHex(onPrimary),

    /* accent — also the "working / active" hue */
    '--accent': rgbToHex(accent),
    '--accent-ink': rgbToHex(accentInk),
    '--accent-soft': tint('--accent', dark ? 14 : 12),

    /* status */
    '--waiting': rgbToHex(waiting),
    '--waiting-ink': rgbToHex(waitingInk),
    '--waiting-bg': tint('--waiting', dark ? 14 : 12),
    '--blocked': rgbToHex(blocked),
    '--blocked-ink': rgbToHex(blockedInk),
    '--blocked-bg': tint('--blocked', dark ? 14 : 12),
    '--blocked-bg-hover': tint('--blocked', dark ? 22 : 19),
    '--verified': rgbToHex(verified),
    '--verified-ink': rgbToHex(verifiedInk),
    '--verified-bg': tint('--verified', dark ? 14 : 12),
    '--idle': rgbToHex(idle),
    '--idle-bg': 'var(--field)',
    '--diff-added-bg': tint('--verified', 10),
    '--diff-removed-bg': tint('--blocked', 10),
    '--scrim': `color-mix(in srgb, var(--ground) ${dark ? 68 : 60}%, transparent)`,

    /* categorical */
    ...Object.fromEntries(ids.map((rgb, i) => [`--id-${i + 1}`, rgbToHex(rgb)])),

    /* elevation. In dark mode a cast shadow is invisible, so the object edge
     * does that work instead (--edge-raised) and only genuinely floating
     * layers get a shadow — plus a 1px top rim, which is the light-from-above
     * read a shadow cannot give on near-black. In light mode every shadow is
     * two layers: a 1–4px contact shadow that puts the object on the plane, and
     * a wider ambient one. One blurred layer at the same total weight reads as
     * a smudge; two read as a resting object. */
    '--shadow-card': dark
      ? 'none'
      : `0 1px 1px ${rgba(shadowInk, 0.04)}, 0 2px 4px ${rgba(shadowInk, 0.05)}`,
    '--shadow-card-hover': dark
      ? 'none'
      : `0 1px 2px ${rgba(shadowInk, 0.05)}, 0 4px 10px ${rgba(shadowInk, 0.08)}`,
    '--shadow-panel': dark
      ? 'none'
      : `0 1px 2px ${rgba(shadowInk, 0.04)}, 0 4px 12px ${rgba(shadowInk, 0.05)}`,
    '--shadow-pop': dark
      ? `inset 0 1px 0 ${rgba(seedInk, 0.06)}, 0 22px 50px ${rgba(shadowInk, 0.62)}`
      : `0 2px 6px ${rgba(shadowInk, 0.06)}, 0 16px 36px ${rgba(shadowInk, 0.14)}`,
    '--shadow-modal': dark
      ? `inset 0 1px 0 ${rgba(seedInk, 0.07)}, 0 40px 90px ${rgba(shadowInk, 0.74)}`
      : `0 4px 12px ${rgba(shadowInk, 0.08)}, 0 32px 72px ${rgba(shadowInk, 0.2)}`,

    /* deprecated aliases — remove once no screen references them */
    '--working': 'var(--accent)',
    '--working-ink': 'var(--accent-ink)',
    '--working-bg': 'var(--accent-soft)',
    '--ctx-bg': 'var(--accent-soft)',
    '--amber-bg': 'var(--waiting-bg)',
    '--error-bg': 'var(--blocked-bg)'
  };

  const planeChromaDeltas = Object.fromEntries(
    SURFACE_PLANE_TOKENS.map((token) => [
      token,
      Math.abs(rgbToOklch(surfacePlanes[token]).C - surfaceChroma.C)
    ])
  );

  return { tokens, accentNearWaiting, planeChromaDeltas };
}

/* ------------------------------------------------------------------ */
/* Verification                                                        */
/* ------------------------------------------------------------------ */

export function measureVariant(tokens) {
  const resolve = (t) => {
    let v = tokens[t];
    let guard = 0;
    while (typeof v === 'string' && v.startsWith('var(') && guard < 5) {
      v = tokens[v.slice(4, -1).trim()];
      guard += 1;
    }
    return hexToRgb(v);
  };
  const isDark = lstar(resolve('--overlay')) > lstar(resolve('--ground'));
  const planes = PLANE_TOKENS.map(resolve);
  const check = (token, floor) => {
    const rgb = resolve(token);
    const worstPlane = planes.reduce(
      (acc, p, i) => {
        const c = contrast(rgb, p);
        return c < acc.ratio ? { ratio: c, plane: PLANE_TOKENS[i] } : acc;
      },
      { ratio: Infinity, plane: '' }
    );
    return { token, floor, ...worstPlane, pass: worstPlane.ratio >= floor };
  };

  const results = [
    check('--text', 7),
    check('--text-soft', 4.5),
    check('--muted', 4.5),
    check('--placeholder', 4.5),
    check('--text-disabled', 3.5),
    check('--faint', 3),
    check('--idle', 3),
    check('--accent-ink', 4.5),
    check('--waiting-ink', 4.5),
    check('--blocked-ink', 4.5),
    check('--verified-ink', 4.5),
    ...[1, 2, 3, 4, 5, 6].map((n) => check(`--id-${n}`, 3))
  ];

  /* Status ink must also clear its own tint, composited over the planes a pill
   * can sit on. The tint is alpha, so the check is real rather than notional. */
  const tintPct = isDark ? 0.14 : 0.12;
  for (const [ink, hue] of [
    ['--waiting-ink', '--waiting'],
    ['--blocked-ink', '--blocked'],
    ['--verified-ink', '--verified'],
    ['--accent-ink', '--accent']
  ]) {
    const inkRgb = resolve(ink);
    const hueRgb = resolve(hue);
    for (const host of ['--surface', '--card', '--overlay', '--field']) {
      const bg = over([...hueRgb, tintPct], resolve(host));
      results.push({
        token: `${ink} on ${hue}-bg over ${host}`,
        floor: 4.5,
        ratio: contrast(inkRgb, bg),
        plane: host,
        pass: contrast(inkRgb, bg) >= 4.5
      });
    }
  }

  /* The ladder itself: monotonic in elevation, and every state step smaller
   * than the smallest structural step. --field is a control plane, not an
   * elevation rung: it is recessed in light and raised in dark, so it is
   * checked for separation rather than for order. */
  const L = (t) => lstar(resolve(t));
  const ladder = ['--ground', '--panel', '--surface', '--card', '--overlay'];
  const rising = L('--overlay') > L('--ground');
  const monotonic = ladder.every(
    (t, i) => i === 0 || (rising ? L(t) > L(ladder[i - 1]) : L(t) < L(ladder[i - 1]))
  );
  const separated =
    Math.abs(L('--field') - L('--surface')) >= 2.5 && Math.abs(L('--field') - L('--card')) >= 2.5;
  const steps = {
    'field vs surface': L('--field') - L('--surface'),
    'card vs surface': L('--card') - L('--surface'),
    'card vs field': L('--card') - L('--field'),
    'overlay vs card': L('--overlay') - L('--card'),
    'sel vs surface': L('--sel') - L('--surface'),
    'field-hover vs field': L('--field-hover') - L('--field'),
    'field-focus vs field': L('--field-focus') - L('--field'),
    'card-hover vs card': L('--card-hover') - L('--card')
  };

  return { results, steps, monotonic, separated, failures: results.filter((r) => !r.pass) };
}
