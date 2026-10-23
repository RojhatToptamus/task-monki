# Theme authoring

How Task Monki's themes are authored and derived, and the floors every token is
held to. Read this only to change a theme or add a token; building UI needs
`DESIGN.md` and the tokens, never these internals.

## A theme is seven seeds

Themes are authored as seven values per mode — `surface`, `ink`, `accent`,
`selection`, `added`, `removed`, `skill` — and every other token is **derived**
from them by fixed ratios (see `theme-tokens.json`). Consequences:

- Adding a theme means adding seven values. Never hand-pick a `--card`, a
  `--hair` or a shadow for one theme.
- Any new token must be expressible as a function of the seeds, or it belongs in
  the invariant set (DESIGN.md §7.5).
- Two themes may not differ structurally. If a theme needs a component-level
  override to look right, the derivation is wrong, not the component.
- **A derivation may scale lightness. It may only offset chroma.** Chroma moves
  by an absolute amount, identical in every theme, and not at all when the seed
  is achromatic (C < 0.002 — below that its hue angle is rounding noise). Never
  multiply chroma, and never clamp it *upward* toward a target: a floor on chroma
  is an instruction to invent colour. A rule whose **output** varies per theme is
  per-theme authorship wearing a formula — scaling plane chroma by the ladder
  offset over the theme's own ground lightness is invisible on a near-neutral
  theme and turns a chromatic one into a Solarized variant of itself.
- Exactly two quantities may legitimately differ per theme: the seven **seeds**,
  which are authored, and any value **solved against a stated floor** — the inks
  and the line weights. A floor is a constraint. A preference is not.

## The surface ladder in L*

Rules, all measured in **CIE L*** — not in mix fractions, which collapse to
nothing near black:

- Adjacent planes are **1.5–3 L*** apart. Ground → overlay spans ~15 L* in dark
  and ~6 L* in light; the whole ladder is deliberately narrow.
- **A control is never less than 2.5 L* from any plane it can sit on.** `--field`
  is checked against both `--surface` and `--card`, because a field appears on
  each.
- **Every state step is smaller than the smallest structural step.** If hovering a
  thing moves it further than the thing is separated from its background, the
  interaction reads as elevation and the structure reads as nothing.
- Direction is a mode decision: a field is **recessed** in light and **raised** in
  dark. The distance is not a mode decision.
- The rail is always `--ground`; the sheet is always lighter than the rail; and
  in light mode nothing is `#fff` — the lightest value in the set is `--overlay`.
- Chroma rises slightly with each rung in dark mode, which is what keeps a warm
  theme warm as it lightens instead of drifting grey.

## Ink floors

Every ink value is **solved per theme** against all twelve planes it can land on —
`--ground`, `--panel`, `--surface`, `--well`, `--field`, `--field-hover`,
`--field-focus`, `--field-disabled`, `--sel`, `--card`, `--card-hover`,
`--overlay` — not merely against the sheet. Measured floors: `--text` ≥7:1,
`--text-soft` and `--muted` ≥4.5:1, every status `-ink` ≥4.5:1,
`--text-disabled` ≥3.5:1, `--faint` and `--idle` ≥3:1 (they label, they don't
carry prose).

A status `-ink` is additionally solved against **its own tint over every host the
pill can sit on** — `--waiting-ink` on `--waiting-bg` over `--card`, over
`--overlay`, over `--well`. A pill that is legible on the sheet and muddy in a
menu is the classic version of this bug.

**`--placeholder` is `--muted`, not `--faint`.** Placeholder text is prose the
user reads before typing, so it takes a prose floor. Defining it as an alias of
the label ink is what produced 3.0:1 placeholders and four screens quietly
substituting their own value.

Never set small text below `--muted`. Never put prose on a status hue's base
value — that's what the `-ink` variant is for. Re-solve whenever any plane or
either end of the ramp moves; a hand-nudged ink is how a menu becomes unreadable
in one theme only.

Dark mode is not a place where the floors relax. Same numbers, same twelve
planes.

## Line ratios

- **A line states the ratio it must clear, not its alpha.** Each weight is solved
  per theme and per mode against **both** surfaces it separates — `--hair`
  1.14:1, `--field-edge` 1.21–1.24:1, `--field-edge-focus` 1.75–1.90:1,
  `--edge-raised` 1.22–1.30:1, `--edge` 1.36–1.40:1. A fixed alpha does not land the same way twice: 0.10 over ink on a
  near-black ground is a clear rim, and the same 0.10 inside a light menu at
  L* 22 is nothing.

## Polarity

- **Polarity is automatic, and it is the whole reason this works in both modes.**
  Every one of them is alpha over `ink`, so the same token is a dark hairline in
  light mode and a light rim in dark mode. That is not a trick, it is the right
  physics: in light mode an object's edge is where it *casts* shade, in dark mode
  it is where it *catches* light. Light mode pairs the hairline with a soft
  shadow; dark mode uses the hairline alone, because a cast shadow on near-black
  is invisible at a 1px scale.

## Shadow layers

- **Every light-mode shadow is two layers**: a 1–4px contact shadow that sets the
  object *on* the plane, plus a wider ambient one. One blurred layer at the same
  total weight reads as a smudge; two read as a resting object. In dark mode a
  floating layer instead gets a 1px top rim (folded into `--shadow-pop` and
  `--shadow-modal`) — the light-from-above read a cast shadow cannot give on
  near-black.

## Waiting hue and invariants

- The waiting hue is held near-constant across all themes so "needs you" reads
  identically everywhere, and is separated from that theme's accent by **≥24° of
  hue or ≥8 L***. Radii, spacing, motion and layer indices are likewise
  theme-independent.

## Categorical hues

Categorical hues identify a thing (a repo, an agent, a saved view). They carry no
state and are **derived, not seeded** — the `skill` seed is the only authored
value behind them:

> `--id-N` = `skill` converted to OKLCH, then hue-rotated by `(N − 2) × 60°`, with
> L and C clamped into the per-mode band — dark `L 0.72–0.80`, `C 0.075–0.135`;
> light `L 0.46–0.54`, `C 0.085–0.150` — and chroma reduced until the result is
> in sRGB gamut. `--id-2` keeps the `skill` hue (zero rotation); the same
> lightness, chroma, and gamut constraints still apply.

Six evenly spaced hues at one lightness and one chroma, so they read as one
family and no single category shouts. Resolved values for all 16 themes are in
`theme-tokens.json`; no theme hand-picks them.

## Syntax inks

Code is coloured by kind in three hues and a comment ink (`SYNTAX` in
`tools/theme-derivation.mjs`):

| Token | Kinds | OKLCH hue |
|---|---|---|
| `--syn-keyword` | keywords; `--syn-attribute`: attributes and the keys of JSON, YAML and CSS | 305° |
| `--syn-string` | strings; `--syn-number`: numbers and constants | 195° |
| `--syn-function` | functions; `--syn-type` and `--syn-tag`: types and markup tags | 250° |
| `--syn-comment` | comments | the `ink` seed's |

- **Hue and chroma are fixed,** the same in every theme, like the waiting hue,
  so code reads alike everywhere: chroma 0.085 dark and 0.10 light, from a
  designed L* of 74 dark and 42 light. Only lightness is solved.
- **The hues sit between the status hues** (blocked ~25°, waiting ~75°,
  verified ~150°): no token reads as a state, and a changed line's tint keeps
  its meaning.
- **Each ink clears 4.5:1 on every plane code sits on:** `--surface`, `--well`
  and `--card`, and the diff tints (`--verified` and `--blocked` at 10%) over
  `--surface` and `--well`.
- **A comment is the theme's own ink,** its chroma offset by +0.02 (none for an
  achromatic ink), solved outward from the sheet's lightness so it lands on the
  4.5 floor. It recedes by lightness, never by italics.
- A kind that needs no hue of its own is an alias, so the token layer alone
  decides whether two kinds share a colour. Plain identifiers and punctuation
  take the line's ink.

## Completeness and integration

`tools/build-themes.mjs` is the only place theme colour is authored. It holds the
seven seeds per theme; `tools/theme-derivation.mjs` holds the derivation itself as
pure functions — the ladder, the ink solver and the measurement pass — so they can
be read and tested on their own. Together they emit two generated files:
`themes.css` (what the app loads) and `theme-tokens.json` (the same data plus
seeds, floors, ladder offsets and measurements, for tooling).
**16 themes × 2 modes × 71 tokens**, every set complete.

Both files live in the repository. A derivation that exists only on one machine
makes the committed output the de-facto rule, and the output is the one artefact
review cannot check.

```bash
node tools/build-themes.mjs           # regenerate both files
node tools/build-themes.mjs --check   # CI: fails if output is stale or a floor breaks
```

The theme carrier is the **root element**:

```html
<html data-theme="umber" data-mode="dark">
```

Theme names lowercase; `data-mode` is `light`, `dark`, or **omitted** to follow
`prefers-color-scheme`. It must sit on `<html>` — put it on an inner wrapper and
`body` falls outside the token scope, which forces someone to hardcode a
background and breaks overscroll, print and browser UI in every light theme.

Rules that follow:

- Read values from the generated CSS. Never compute a derivation at runtime,
  never hand-pick a value for one theme, never hand-edit the generated files.
- Adding a theme = adding one seven-value entry to the generator. Adding a token
  = adding it to the generator so all 32 sets get it in the same change. A token
  present in 31 sets is a blank surface in the 32nd, and blanks do not warn.
- Add `--check` to CI. It fails on: a stale generated file · an incomplete token
  set · a ladder that is not monotonic in either mode · a `--field` closer than
  2.5 L* to a host plane · a state step larger than the smallest structural step ·
  any ink under its floor, including a status ink on its own tint over `--card`,
  `--well` and `--overlay` · a syntax ink under 4.5:1 on a code plane or a diff
  tint · an accent and waiting hue closer than 24° and 8 L* · a `--focus-ring`
  under 3:1 over any plane.
  These are precisely the things review cannot see.

Measured worst case across all 32 sets: `--text` 9.63:1, `--text-soft` 5.48,
`--muted` and `--placeholder` 4.68, status inks 4.68 (including on their own
tints), `--syn-*` 4.67 (on the diff tints), `--text-disabled` 3.63, `--faint`
3.13, `--idle` 3.12, `--id-*` 3.52, `--focus-ring` 3.00. `theme-tokens.json`
records the current values.
