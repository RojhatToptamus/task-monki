# Task Monki — Interface Guide

<!-- Audit revision + colour/edge correction. Deltas vs the audit draft: §2.2 chroma
     rule, §2.6 four line weights and two-layer light shadows, §3 Fields rim,
     §11 borders, A.3 input row, checklist. See report/IMPLEMENTATION.md. -->

The contract for anyone building UI here, human or agent. Read it before writing
markup and check your work against §10 before you open a PR. It is deliberately
short: everything in it is load-bearing. If something you need isn't here, it is
not a licence to invent — see §9.

**The test of this document:** a new 28px button added by someone who has never
seen the app should be indistinguishable from one that shipped a year ago.

---

## 0. Source precedence

When two sources disagree, the higher one wins. Never average them.

1. **The bound design system** — fonts, palette, components, and any existing
   mock of this product. If it has a component for what you're building, fork it.
2. **This document** — the rules that keep additions consistent.
3. **The existing implementation** — match the closest shipped surface for
   anything the two above leave open. "Closest" means same layout archetype
   (§7.1), not merely same page.
4. **Your judgement** — last, and only inside the gate in §9.

Two corollaries. Never introduce a pattern whose only justification is that it
looked good in isolation; and if the existing implementation contradicts §1–§8,
follow this document and flag the divergence rather than propagating it.

---

## 1. Core principles

1. **Meaning over decoration.** Every element carries information. A card, a
   divider, a shadow, a hue — each must answer *what does the user learn from
   this?* If the answer is nothing, delete it.
2. **One fact, one owner.** A value appears once per surface, in the place with
   the authority to state it. Repetition reads as two different facts.
3. **Structure is fill, not outline.** Depth comes from surface steps. Borders
   are for real boundaries, never for defining a control that already has a fill.
4. **Quiet by default, loud on purpose.** Colour, weight and motion are a budget.
   Spend them where the user must act, and nowhere else.
5. **Dark is not inverted light.** It is a first-class palette. Elevation goes
   *lighter* on a near-black ground; shadows carry almost nothing.
6. **Tell the truth about state.** Never show a spinner for something that isn't
   running, a stale value as if it were fresh, or a disabled control with no
   reason attached.
7. **Density with air.** Operators scan long lists. Whitespace organises; it does
   not pad. An empty-feeling panel is a layout problem, not a content gap.
8. **Native desktop, not web page.** No hero sections, no marketing gradients, no
   full-width centred columns, no bouncy easing. The reference points are Linear,
   Codex and macOS system apps.

---

## 2. Colour and tokens

### 2.1 The rule

**A screen never contains a colour literal.** No hex, no `rgb()`, no named
colour, no ad-hoc `rgba()` — including in shadows, hairlines and SVG fills. Every
colour is `var(--token)`. If a value isn't a token, it doesn't exist yet: add it
to the token layer, in both modes, in the same change.

Appendix A is the binding element → token map. Consult it rather than reasoning
from the role names; if an element isn't listed, use its closest structural
equivalent there.

An undefined custom property does not warn and does not fall back — it computes
to nothing, so a selected row silently disappears while the markup still looks
correct. Any file that consumes these components ships the **complete** set,
never a subset trimmed to what it happened to need.

### 2.2 A theme is seven seeds

Themes are authored as seven values per mode — `surface`, `ink`, `accent`,
`selection`, `added`, `removed`, `skill` — and every other token is **derived**
from them by fixed ratios (see `theme-tokens.json`). Consequences:

- Adding a theme means adding seven values. Never hand-pick a `--card`, a
  `--hair` or a shadow for one theme.
- Any new token must be expressible as a function of the seeds, or it belongs in
  the invariant set (§2.6).
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

### 2.3 Surfaces — a strict ladder

Eight planes, one order, both modes. Elevation is **fill**; a plane never
announces itself with a border.

| Token | Role | Position |
|---|---|---|
| `--ground` | window and sidebar rail; the plane everything sits on | bottom |
| `--panel` | secondary rail, inspector, list column | |
| `--surface` | the content sheet | |
| `--well` | code and read-only payload blocks | recessed from the sheet |
| `--field` | inputs, composers | control plane |
| `--sel` | selected row, active tab | |
| `--card` | a raised unit on the sheet | |
| `--overlay` | menus, popovers, modals | top |

Rules, all measured in **CIE L*** — not in mix fractions, which collapse to
nothing near black:

- Adjacent planes are **1.5–3 L*** apart. Ground → overlay spans ~15 L* in dark
  and ~6 L* in light; the whole ladder is deliberately narrow.
- **A control is never less than 2.5 L* from any plane it can sit on.** `--field`
  is checked against both `--surface` and `--card`, because a composer appears on
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

If a container needs a line to be legible against its host, the wrong plane was
chosen. Add the line only after the plane has failed.

### 2.4 States

Ranked by weight: **selected > keyboard focus > pointer focus > active > hover.**
No state changes size, border width or position, and no state may exceed the
resting separation of the thing it is applied to.

| State | Treatment |
|---|---|
| hover | One small fill step in the direction the element already sits — `--hover` on a transparent row, `--field-hover` on a control, `--card-hover` on a card. Never on a text surface; never a shadow change; never another role's token. |
| focus | Text surfaces: `--field-focus` fill plus the resting rim strengthened to `--field-edge-focus` — **neutral, never the accent hue**. Quiet, and it fires however focus arrived — including a plain pointer click. |
| focus-visible | Keyboard traversal only: adds the 3px `--focus-ring` halo. This is the one loud state in the system, and a mouse click must never produce it. |
| active | `--press` over the rest fill. The primary family, whose fill is already ink, uses `--primary-press` — an ink overlay on an ink fill is invisible. |
| selected | `--sel`, one fixed rung: above the hover step, below `--card`. Identical weight in every theme. |
| disabled | `--field-disabled` fill and `--text-disabled` ink. **Never an opacity, and never a weaker boundary** — a disabled control reads *inert*, not *absent*, so its `--control-edge` or `--field-edge` stays at full strength. |

Inactive-but-enabled is expressed as **ink** — `--muted` text with no fill — never
as opacity on a full-strength row.

**Disabled is a fill and an ink, not a transparency.** Opacity fades the fill, the
glyph, the ring and the explanatory text in one move: a disabled secondary button
loses the very fill that identified it as a button, and its reason drops below
the readability floor. `--text-disabled` is solved to 3.5:1 so the control still
states why it is disabled.

**Hover answers exactly one question: is this clickable.** A surface that is not
itself the target does not get one. Text areas in particular: nothing happens
when the pointer arrives, the caret is the confirmation that matters, and
repainting an 88px composer on pointer-over is pure noise.

### 2.5 Ink

`--text` primary · `--text-soft` secondary prose · `--muted` the floor for small
text, metadata and placeholders · `--faint` labels that are never read as
sentences · `--text-disabled` the ink of a disabled control.

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

### 2.6 Lines, shadows and focus

- **Four line weights, one job each.** Every line in the app is one of these,
  and which one you need follows from what the thing *is*:

  | Weight | Belongs to | Examples |
  |---|---|---|
  | `--hair` | an **interior divider** — content continuing on the same plane | rows in a list, a footer inside a card, a settings separator |
  | `--field-edge` | the **resting boundary of a filled control** | input, textarea, composer, select trigger, segmented track, secondary button |
  | `--field-edge-focus` | the same rim while the control **holds focus** — one notch darker/lighter, same hue-free ink | focused input, textarea, composer |
  | `--edge-raised` | the boundary of an **object** resting on its plane | card, panel, response, decision block |
  | `--edge` | a **seam** between structural planes, and **floating** layers | rail↔sheet, drawer edge, menu, popover, modal, tooltip |

  `--control-edge` is the fifth and separate: an opaque 3:1 line for a control
  with no fill at all to be identified by (an unchecked checkbox, a radio, a
  toggle track in the off position).

- **A line states the ratio it must clear, not its alpha.** Each weight is solved
  per theme and per mode against **both** surfaces it separates — `--hair`
  1.14:1, `--field-edge` 1.21–1.24:1, `--field-edge-focus` 1.75–1.90:1,
  `--edge-raised` 1.22–1.30:1, `--edge` 1.36–1.40:1. A fixed alpha does not land the same way twice: 0.10 over ink on a
  near-black ground is a clear rim, and the same 0.10 inside a light menu at
  L* 22 is nothing.
- **A filled control carries exactly one line: `--field-edge`.** The fill step is
  what says *recessed*; the rim is what says *where*. It is an inset 1px
  box-shadow, never a border, so no geometry moves between rest, hover and focus.
  Focus does not add a second line and does not recolour this one — it swaps the
  same rim to `--field-edge-focus`, one notch up in the identical neutral ink.
  What §11 still rejects is two lines on one control, or a line drawn **instead
  of** the fill step. An object — something with a boundary that sits above its plane and could
  conceptually be picked up — gets `--edge-raised` instead.
- **Polarity is automatic, and it is the whole reason this works in both modes.**
  All three tokens are alpha over `ink`, so the same token is a dark hairline in
  light mode and a light rim in dark mode. That is not a trick, it is the right
  physics: in light mode an object's edge is where it *casts* shade, in dark mode
  it is where it *catches* light. Light mode pairs the hairline with a soft
  shadow; dark mode uses the hairline alone, because a cast shadow on near-black
  is invisible at a 1px scale.
- **Where the plane changes, no divider.** The fill already said it. Two lines
  within 14px of each other means one of them is wrong. A hairline over the sheet
  is a larger local step than the card step above it, so an interior line is the
  more expensive tool, not the cheaper one — reach for the plane first, and let
  the object's own edge do the boundary work.
- **Elevation:** `--shadow-card` for things resting on the sheet,
  `--shadow-card-hover` one step up, `--shadow-panel`, then `--shadow-pop` for
  menus and popovers and `--shadow-modal`. **Light mode only** — in dark, cards
  and panels cast nothing, because a shadow on near-black is invisible and the
  attempt produces mud. A hover never crosses shadow tiers: `--shadow-pop` on a
  card that has not left the sheet is the loudest mistake available here.
- **Neither mode may depend on a cue the other one zeroes out.** Dark has no cast
  shadow; light has a compressed fill step near white. So anything that must read
  as a distinct object carries **two** cues in each mode, and they are not the
  same two: dark leans on the fill step plus `--edge-raised`, light on
  `--edge-raised` plus the shadow. A container drawn only with `--shadow-panel`
  is invisible in dark; one drawn only with a fill step is invisible in light.
- **Every light-mode shadow is two layers**: a 1–4px contact shadow that sets the
  object *on* the plane, plus a wider ambient one. One blurred layer at the same
  total weight reads as a smudge; two read as a resting object. In dark mode a
  floating layer instead gets a 1px top rim (folded into `--shadow-pop` and
  `--shadow-modal`) — the light-from-above read a cast shadow cannot give on
  near-black.
- **Focus, two treatments, and the loud one is keyboard-only:**
  1. Any focus on a text surface, including a pointer click, moves the fill to
     `--field-focus` and strengthens the resting rim from `--field-edge` to
     `--field-edge-focus` — the same neutral ink, one notch up, same 1px inset
     box-shadow. That is the quiet confirmation the caret landed; it is not a
     ring, and it carries **no hue**.
  2. `:focus-visible` — keyboard traversal — adds the 3px `--focus-ring` halo,
     where the job is to *find* the caret rather than confirm it. This is the
     only place the accent hue appears in a focus state, it sits **outside** the
     control, and a pointer click must never produce it.

  **The accent hue is not a focus cue on a resting control.** A coloured rim
  around whatever the caret happens to be in reads as an alert, not as focus: it
  puts the loudest colour in the theme on the most ordinary event in the app, and
  every field on screen competes with it. Hue on a control boundary is reserved
  for meaning that is *about the value* — `--blocked` for a failed field,
  `--waiting` for one under review. Retired: `--field-focus-line`.

  Buttons and other non-text controls show nothing from a pointer click and the
  halo from the keyboard. Geometry never shifts when focus appears. Heavy
  outlines and large borders during ordinary pointer interaction are a defect,
  not a safety feature: polished desktop apps do not do it.
- The waiting hue is held near-constant across all themes so "needs you" reads
  identically everywhere, and is separated from that theme's accent by **≥24° of
  hue or ≥8 L***. Radii, spacing, motion and layer indices are likewise
  theme-independent.

### 2.7 Accent and status

`--primary` is the highest-contrast neutral (near-black on light, near-white on
dark) and belongs to the single primary action. `--accent` is the interactive hue
— links, focus, selection, one categorical dot. For text, use `--accent-ink`;
raw accent fails as link ink in low-chroma themes.

Status hues are `--waiting`, `--blocked`, `--verified` and `--idle`, each with an
`-ink` variant for when the hue sets **text**, and a `-bg` variant for the pill
fill. "Working" is not a separate hue — running work is the *active* state, so it
uses `--accent` / `--accent-ink` / `--accent-soft` and says so by name.

Five meanings, five treatments, no sharing: accent is interactive and running,
waiting is attention, blocked is failure, verified is success, idle is neutral
and carries no hue at all. Two hues that cannot be told apart are one hue — if a
proposed token would resolve to the same value as an existing one in every theme,
it is an alias, and it should be written as an alias or not at all.

### 2.8 Categorical hues (`--id-1` … `--id-6`)

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

**These are graphic-only tokens.** They clear 3:1 against every plane they can
land on (measured floor 3.56:1) — enough for a dot, bar, or 2px marker, not for
text. A category label is `--text` or `--muted` next to its dot, never the id hue
itself. Assign by stable hash of the entity id so a repo keeps its colour, and
never reuse a status hue for a category or an `--id-*` for a state. Where an
existing product control persists an explicit category slot, as saved-view
markers do, map its six slots directly to `--id-1` … `--id-6`; do not reinterpret
the legacy slot names as semantic colour or status names.

### 2.9 Completeness and integration

`tools/build-themes.mjs` is the only place theme colour is authored. It holds the
seven seeds per theme; `tools/theme-derivation.mjs` holds the derivation itself as
pure functions — the ladder, the ink solver and the measurement pass — so they can
be read and tested on their own. Together they emit two generated files:
`themes.css` (what the app loads) and `theme-tokens.json` (the same data plus
seeds, floors, ladder offsets and measurements, for tooling).
**16 themes × 2 modes × 68 tokens**, every set complete.

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
  `--well` and `--overlay` · an accent and waiting hue closer than 24° and 8 L*.
  These are precisely the things review cannot see.

Measured worst case across all 32 sets: `--text` 11.40:1, `--text-soft` 6.02,
`--muted` and `--placeholder` 4.71, status inks 4.63 (including on their own
tints), `--text-disabled` 3.66, `--faint`/`--idle` 3.13, `--id-*` 3.18.

### 2.10 Necessary distinction vs. noise

Before adding contrast, a border, a shadow or a tint, name the question the user
is asking at that moment.

| The user is asking | Answered by | Not by |
|---|---|---|
| Can I type here? | the field's fill | a border, a hover |
| Is this clickable? | one hover step | a shadow, a colour change |
| Where am I? | `--sel` | a stripe, a bold border |
| Did that work? | one status tone, one carrier | a tint on the mark *and* the heading *and* the border |
| What is on top? | the plane, plus a shadow in light mode | a shadow in dark mode |
| What is this thing? | `--id-*` on a dot | a coloured label |

If a treatment answers none of them, it is decoration; remove it. If two
treatments answer the same one, one of them is noise. Use the lightest treatment
that works, and exactly one per question.

This cuts both ways, and the second direction is the one that gets missed. Dark
themes read as a wireframe of near-identical grey boxes when contrast has been
spent on distinctions nobody asked about — a divider beside a plane change, a
stripe beside a pill — while the distinctions that were asked about, like *can I
type here*, went unfunded. The remedy is not more contrast. It is fewer, larger,
better-aimed steps.

---

## 3. Typography and icons

### 3.1 Families

Two families, both named in the token layer as `--font-ui` and `--font-mono`.
A component references those tokens and never a family name. Weights: **400,
500, 600** only — no 300, no 700, no italic outside quoted prose. `font-feature-settings:
"tnum"` on every number that sits in a column or updates in place, so digits
don't jitter. System fallbacks in the token, `font-display: swap`, and nothing
that depends on a webfont having loaded to be legible.

Inter and Inter Tight are out.

### 3.2 Scale

Interface type is one sans; machine values are one mono. No third family.

| Role | Token | Size / weight |
|---|---|---|
| Page title | `--t-title` | 24 / 600 · `-0.02em` |
| Section heading | `--t-heading` | 15 / 600 |
| Panel title, control label | `--t-label` | 13 / 600 |
| Body, prose | `--t-body` | 13 / 400 |
| Secondary, helper | `--t-help` | 12 / 400 `--text-soft` |
| Metadata, counts | `--t-meta` | 11.5 / 400 `--muted` |
| Group label | `--t-group` | 9.5 / 600 caps · `0.10em` `--faint` |

**Seven sizes, and they are tokens.** A component sets `font-size: var(--t-label)`
and never a literal. A size that is not on this list does not exist: the reason
to name them is that an unnamed scale is not a scale, and the renderer had
drifted to 22 distinct sizes against these seven.

**Mono is for machine values only** — paths, hashes, branches, models, counts,
times, payloads, token names. It never sets prose, labels or buttons. This split
is what makes a scan legible: prose is the sentence, mono is the fact.

Never use size alone to build hierarchy where weight and colour will do it.
Never centre a paragraph. `text-wrap: pretty` on prose. Truncate with ellipsis
and keep the full value in `title`; never wrap a machine value mid-token.

### 3.3 Icons

**One set, outline only.** Never mix an outline set with a filled one, and never
substitute an emoji, a glyph from the mono font, or a hand-drawn SVG for a missing
icon — use the nearest icon in the set or a word.

Sizes **13 / 16 / 20**, matched to the row they sit in (13 in compact rows, 16
everywhere else, 20 only in empty states). Stroke 1.5 at 16px, scaled
proportionally. `stroke="currentColor"`, `fill="none"` — an icon inherits ink
from its row so it dims with `--muted` automatically and needs no colour of its
own. Never a coloured icon where a status word or dot would do.

Icons are decoration next to a label and information when alone: an icon-only
control carries an `aria-label` and a tooltip. Optically centre against text
rather than aligning boxes, and keep 8–9px between icon and label.

---

## 4. Spacing and geometry

4px grid. The whole vocabulary: **4 · 6 · 8 · 10 · 12 · 14 · 16 · 20 · 24 · 32**.
Lay sibling groups out with flex/grid `gap` — never per-child margins, never
whitespace between inline elements.

| Thing | Padding / gap |
|---|---|
| Card | 11–12 pad, 6–8 internal gap |
| Panel / settings block | 16–18 pad, 15 row rhythm |
| List row | 8 horizontal, 26–30 tall |
| Sheet | 14–16 pad |
| Between cards | 10–12 |
| Section separation | 24–32 |

Radii are tokens, not literals: `--r-xs` 6 chips and dots · `--r-sm` 8 buttons,
rows, small fields · `--r` 10 and `--r-md` 12 cards, composers, popovers ·
`--r-lg` 14 and `--r-xl` 16 the shell and full-height sheets · `--r-pill` for
dots and pills. Concentric things step inward by 2–3px; never nest equal radii.

Control heights are tokens too: `--h-control` 34 decision surface · `--h-toolbar`
30 toolbar · `--h-compact` 26 compact and inline · `--h-icon` 28 icon button.
Never mix two heights in one row. Hit targets never below 28px on desktop, 44px
on touch.

Writing `border-radius: 9px` or `height: 36px` is the same class of error as
writing a hex colour: it is a value the system already has an answer for.

### 4.1 Fixed geometry

These are settled. Use the value, don't re-derive it.

| | |
|---|---|
| Sidebar rail | 56 collapsed · 224 expanded |
| Secondary list column | 280 min · 360 default |
| Toolbar / panel header | 44 tall |
| Page gutter | 24 at minimum width · 32 wide |
| Reading column (settings, prose) | 880 max; tables and lists go full width |
| List row | 26 compact · 30 default · 36 two-line |
| Button | 34/30/26 tall, 12–15 horizontal pad, 64 min width |
| Icon button | 28 square (26 compact), 16 glyph |
| Single-line field | 34 tall, 12 horizontal pad |
| Textarea / composer | 88 min body, 96 min total, 10–12 pad |
| Popover / menu | 220–280 wide, 6 pad, 30 rows |
| Modal | 440 confirm · 560 form · 720 payload |
| Drawer | 380 narrow · 480 default · 640 wide, full height |

Widths are the design intent, not a hard cap: a panel may be resized by the user,
but it opens at these values and never below the minimum.

---

## 5. Component contracts

A component is a reusable pattern: if it appears twice, or plausibly will, it is
one component with props — not two similar blocks. Before adding a new one,
answer §9.

**Buttons — four families, no fifth.** Primary (`--primary` fill, `--on-primary`
ink; one per surface), secondary (`--field` fill), ghost (transparent, `--hover`
on hover), destructive (soft tint, never a filled red block). Primary and
secondary share geometry so a pair aligns. Icon-only buttons are ghost, 16px
glyph, and always carry an `aria-label`.

Primary and secondary are **one geometry with different fills** — same height,
same padding, same radius, same minimum width — so a pair aligns to the pixel. A
transparent border on one of them to "reserve space" is not that: it offsets the
label by its own width.

**States must not move geometry.** Size, padding, border width and radius are
identical across rest, hover, active, focus and disabled — only fill, ink and
ring change. A disabled control states why, adjacent or in a tooltip, in
`--text-disabled`.

**Fields.** A filled well (`--field`) carrying one line, `--field-edge`, as an
inset 1px box-shadow — separated from its host by ≥2.5 L* so the fill still
carries it on both a sheet and a card, with the rim making the boundary
unambiguous where the two planes are close. Single-line controls are
`--h-control` tall with `--r-sm`. Hover lifts to `--field-hover`; focus per §2.6
— `--field-focus` fill and the same rim swapped to the neutral
`--field-edge-focus`, never an accent border; placeholder is
`--placeholder` (= `--muted`). Label above at `--t-label`/600, help text below at
`--t-help` `--muted`, error text replaces help text and carries `--blocked-ink`.
Never rely on placeholder as the label.

**Text areas take no hover fill.** Nothing happens when the pointer arrives and
the caret is the real confirmation; a multi-line surface repainting under the
mouse is the noisiest thing a quiet app can do.

**Composer — one pattern everywhere** (briefs, messages, follow-ups): context
chips above the text area, run configuration below it, primary action bottom-right,
keyboard hint at `--t-meta` `--muted`. The composer is a single `--field` surface
at `--r-md` with its toolbar inside the same fill divided by a `--hair` — not a
bordered box, not a stack of separately outlined parts, and not a surface that
changes colour when the pointer crosses it. Drag-over is a fill step plus a 1px
accent line, on the same element that will receive the drop.

**Segmented vs menu.** Segmented for 2–4 options whose labels fit on one line at
the narrowest width the container reaches; a dropdown for anything longer or
open-ended. A wrapping segmented control is a bug.

**Menus and popovers.** `--overlay` + `--shadow-pop`, r12, 6px pad, 30px rows,
group labels per §3. Destructive item last, separated by a `--hair`. Escape
closes, arrow keys move, focus returns to the trigger.

**Settings row.** A setting is a row, not a card: label left, control right,
optional one-line description under the label. Rows are separated by `--hair`
inside one panel. Never wrap each setting in its own card.

**Cards — fixed content order.** Machine context and status on the first line
(context left in mono `--muted`, status pill right), then the title at 12–12.5/600
over at most two lines, then a `--hair`, then a metadata footer in mono `--faint`.
Actions live in the footer or a hover-revealed ghost button — never a row of
buttons in the header. No card inside a card. If the whole card is clickable, the
whole card carries the hover fill and there is no separate "Open" link.

Use a card when a unit has mixed content types (status + prose + metadata) and
stands alone. Use a row when items are compared against each other. A list of
cards is almost always a list of rows wearing costumes.

**Drawers, modals, sheets — pick by interruption cost.** A drawer for detail and
editing alongside the list (right edge, full height, dismissed by Escape, a click
outside, or the same control that opened it; the list stays live behind it and
selection follows). A modal only when the app genuinely cannot proceed —
confirmation of something destructive, or a short blocking form. A page for
anything a user might link to, bookmark, or spend minutes in. Never stack two
modals; never open a drawer from a modal. Drawer anatomy is fixed: 44 header with
title left and close right, scrolling body, pinned footer holding the primary
action bottom-right.

**Destructive actions.** Prefer undo over confirm. Confirm only when the action
is unrecoverable, and then name the object in the button ("Delete branch", not
"OK") and put the cancel first.

**Button copy.** Sentence case, a verb the object can hear — "Save changes", not
"Submit". Never a bare "OK", never a gerund as the resting label ("Saving…" is a
state, not a label). Labels don't change on hover.

**Empty state.** One sentence naming what the surface is waiting for, plus the
single action that resolves it. No illustration, no second button.

### 5.1 Interaction behaviour

- **Single click selects, Enter or double-click opens.** A click never mutates
  data; that needs an explicit control.
- **Hover reveals, it does not relocate.** Actions that appear on hover occupy
  reserved space at rest so nothing shifts. No hover-only affordance may be the
  only route to an action — it must also exist in a menu or on the detail surface.
- **Optimistic where the action is local and reversible** (rename, reorder,
  toggle), pending where it leaves the app (run, merge, deploy). A pending
  control shows the pending state on itself, not a global overlay, and stays
  disabled until it resolves.
- **Autosave settings, submit forms.** A settings row applies on change with no
  Save button. A form with interdependent fields submits explicitly.
- **Selection survives** a refresh, a filter change, and a drawer opening; it is
  cleared only by the user. Scroll position is restored when returning to a list.
- **Tooltips are for names and shortcuts**, delayed ~400ms, never for information
  needed to make the decision in front of you.
- **One primary action per surface**, and it is the same action the Enter key
  performs.

---

## 6. Status and progress

- **In a collection, state is a word, not a mark.** A column of coloured dots is
  unreadable; a column of words is scannable. Marks belong on a detail surface.
- **One mark per surface.** The status mark is the loudest thing available. If a
  panel already carries one, the second becomes a word.
- **One tone per unit, carried by one element.** Never tint the mark, the heading
  and the border of the same card. A tinted pill is the usual carrier.
- **Progress is one component at two sizes**, not two designs. Steps read
  `label … state`, right-aligned state in `--muted` unless it is terminal. An
  indeterminate phase says what it is waiting for, in words.
- **Stale is one ribbon**, with the same wording wherever it appears: the evidence
  shown no longer matches the current diff, and here is the one action that
  refreshes it. A ribbon or a state word — never both.
- Failures state what failed, what it means, and the next action. Never a raw
  error string alone; put the raw output behind a disclosure.

---

## 7. Shell, layout and responsive invariants

### 7.1 Layout archetypes — pick one, don't blend

1. **List + detail** — the default for any collection. Rail, list column, detail
   pane or drawer. The list keeps its own scroll and selection.
2. **Single sheet** — one subject, full remaining width, own header. For a task,
   a run, a document.
3. **Settings** — 880 reading column of `--hair`-separated rows inside one panel
   (§5, settings row).
4. **Workspace** — a persistent working surface with its own toolbar and one
   focused artefact; side panels are collapsible and their state persists per
   user. Discourse and design review are this archetype: the conversation or
   artefact holds the centre at full height, context collapses, and nothing about
   the shell changes when you enter or leave.

Every page has exactly one header: title at 22–24/600, one line of context under
it in `--muted`, actions right-aligned on the title line. No breadcrumbs (the
rail is the location), no duplicate title inside the body, no tab bar that
repeats what the rail already says.

### 7.2 Shell invariants

- **The rail is permanent** and always `--ground`; because it never leaves,
  focused modes need no "Exit" control and no breadcrumb.
- **The sidebar is one surface at two widths** — icons collapsed, icons plus
  labels expanded. Not two components.
- Each panel scrolls its own body; headers and footers stay pinned. Overflow is
  clipped by the panel, never leaked into the shell.
- Every boundary between two panels is a resize handle: 5px hit area, visible
  only on hover, with a keyboard-reachable equivalent.
- **Degrade by dropping, not by shrinking.** As width goes, the secondary column
  collapses to a toggle and the primary task keeps its size and order. Semantic
  order never changes across widths. Nothing below the app's minimum width
  (1024) may hide a primary action.
- Content extremes are part of the design: test with a 120-character title, a
  4-digit count, an empty list, and 500 rows.
- **Layer order** is fixed: content → pinned headers → drawer → popover → modal →
  toast. Escape closes the topmost only. A popover never survives the scroll of
  the surface it is anchored to.
- Panel widths, collapse state and the active theme persist per user and restore
  on load. Nothing the user arranged is reset by a navigation.

### 7.3 Responsive rules

- **Buttons collapse label-last.** Full label → icon plus label → icon only, in
  that order, and never past icon-only for the primary action on a surface. A
  button that has collapsed keeps its tooltip.
- Toolbars overflow into a trailing "more" menu rather than wrapping. The primary
  action never enters the overflow.
- Segmented controls become a dropdown at the width where their labels would
  wrap (§5).
- Cards reflow by column count, never by shrinking below their minimum: 3 → 2 →
  1, and a one-column card is full width.
- Tables drop the lowest-priority columns first, in a documented order; they do
  not scroll horizontally inside a panel.

---

## 8. Accessibility

- Visual order, DOM order and tab order agree.
- Focus is always visible (§2.6) and never removed; a modal traps focus and
  returns it to the trigger on close.
- Every icon-only control has an `aria-label`; a tooltip is not a label.
- Colour is never the only carrier of meaning — pair every hue with a word or a
  glyph.
- Contrast: `--text` ≥7:1, `--muted`, `--placeholder` and any status ink ≥4.5:1
  on every plane they can land on — and status ink also on its own tint over
  those planes — `--text-disabled` ≥3.5:1, ≥3:1 for control edges, focus rings
  and `--faint`. Dark mode uses the same numbers.
- Focus is never removed and never conditional on input device for **text
  entry**; the keyboard-only halo is an addition to that, not a replacement.
- Live regions announce state changes that happen without user action (a run
  finishing, a review arriving).
- Honour `prefers-reduced-motion`: transitions collapse, nothing loops.
- Keyboard: Escape closes the topmost layer, Enter activates the default action,
  arrow keys move within a list or segmented control, and every action reachable
  by mouse is reachable by keyboard.

---

## 9. Adding something new

Before adding a component, token, hue, or surface, answer all five:

1. Does an existing pattern cover this with a prop? (If yes, use it.)
2. What does the user learn or do that they couldn't before?
3. Which token roles does it use — and does it need a new one? A new token must
   derive from the seven seeds (§2.2) and be added to every mode.
4. What are its rest, hover, active, focus, disabled, loading, empty, error and
   overflow states?
5. How does it behave at the minimum width, with the longest realistic content,
   and under reduced motion?

If any answer is "unclear", the design isn't finished. Ship the existing pattern
and raise the gap.

**Motion**: 120ms for state feedback, 180ms for surfaces entering, 240ms for
layout; ease-out entering, ease-in leaving. Motion communicates continuity,
causality or genuinely active work — never decoration. Nothing loops unless work
is actually running.

---

## 10. Verification checklist

Run this before submitting. Measure, don't eyeball — the first three are
invisible to review and trivial to check in the inspector.

**Measured**
- [ ] No colour literal anywhere in the diff (grep the diff for `#`, `rgb`,
      `rgba`, colour names — including SVG and shadows).
- [ ] Every `var(--x)` used is defined in **both** modes.
- [ ] `--muted`, `--placeholder` and every status ink measured ≥4.5:1 against the
      actual surface behind them, in both modes — pills against their own tint.
- [ ] No control shifts size or position between rest, hover, focus and active.
- [ ] No focused field carries an accent-coloured rim: the focus boundary is
      `--field-edge-focus`, and the only hue in a focus state is the keyboard-only
      `--focus-ring` sitting outside the control.
- [ ] No `opacity` expressing a state. Disabled uses `--field-disabled` and
      `--text-disabled`.
- [ ] Every state step measured smaller than the resting separation of the thing
      it applies to.
- [ ] Clicked into every text field with the mouse: the caret's host is visible,
      and no halo appeared. Tabbed to it: the halo appeared.

**Both modes**
- [ ] Light and dark screenshotted; no mode-specific override was needed.
- [ ] Light mode contains no pure white; dark cards carry no shadow but do carry
      `--edge-raised`.
- [ ] Every line in the diff is one of `--hair` / `--field-edge` /
      `--edge-raised` / `--edge`, and matches what the thing is (divider /
      filled control / object / seam). No control carries two.
- [ ] Sheet reads lighter than the rail; selected rows read lighter than the
      track.

**States**
- [ ] Empty, loading, error, stale, disabled and overflow all rendered once.
- [ ] One status mark per surface; collections use words.
- [ ] Every disabled control explains itself.

**Structure**
- [ ] Spacing values all on the scale; groups laid out with `gap`.
- [ ] Radii and control heights come from `--r-*` and `--h-*`, not literals;
      font sizes from `--t-*`.
- [ ] One control height per row; radii step concentrically.
- [ ] Mono used only for machine values.

**Keyboard and a11y**
- [ ] Tabbed the whole surface: order matches the layout, focus always visible.
- [ ] Escape, Enter and arrow keys behave per §8.
- [ ] Icon-only controls have labels; console is clean.

**Width**
- [ ] Checked at minimum width and at a wide window; primary task unchanged in
      order and prominence.
- [ ] Buttons collapsed label-last; no wrapped toolbar or segmented control.

**Visual**
- [ ] Screenshotted and actually looked at — not assumed from the markup.
- [ ] Compared side by side with the nearest existing surface of the same
      archetype (§7.1); a stranger could not tell which one is new.
- [ ] Scanned for the four cheap tells: an outline on a filled control, an
      off-scale gap, two control heights in a row, mono setting prose.
- [ ] Optical check at 50% zoom: the intended reading order is what stands out,
      and no single element pulls the eye without earning it.

---

## 11. Anti-patterns — reject on sight

**Colour and surfaces**
- A hex or `rgba()` in a component.
- A hand-picked value "just for this theme".
- Pure white in light mode; a black shadow used as a divider.
- A darker fill for a selected or raised element in dark mode.
- Opacity used to express "inactive", or `opacity` used for `:disabled`.
- A hover fill on a text area or composer.
- A hover that moves an element further than its resting separation, or onto
  another role's token (`--field-hover` on a card).
- A shadow tier change on hover; any shadow at all on a dark card.
- A focus ring, heavy outline or border-width change from a pointer click.
- **An accent-coloured border, rim or outline on a focused input, textarea,
  composer or select.** The focus rim is neutral (`--field-edge-focus`); hue on a
  control boundary means the value is blocked or waiting, nothing else.
- `--field-focus` equal to `--field-hover`: focus must outrank hover.
- `--field-edge-focus` within 0.25 of `--field-edge`'s ratio: the swap must be
  visible without being loud.
- A new token that resolves to an existing one in every theme.

**Borders**
- A **second** line on something that already carries one — a border *and* an
  inset ring on an input, an edge on a card that already has `--edge-raised`, a
  rim on a `--well`. One boundary per boundary. (A filled control carries
  `--field-edge` and nothing else; a line drawn **instead of** the fill step is
  still the regression this rule was written against.)
- Conversely: an **object** with no edge at all — a card, panel, popover or modal
  drawn only as a fill step. In dark mode, where the cast shadow is `none`, that
  leaves nothing whatsoever describing its boundary.
- A box drawn around a **region** that a single seam line would separate, or a
  divider sitting immediately beside a plane change.
- A decorative left-border accent stripe on a card.
- Border colour used to signal state instead of fill or ink.

**Status**
- A column of coloured dots in a list.
- Two status marks on one surface.
- A tinted mark plus tinted heading plus tinted border for one state.
- A spinner for something that is not running; a pill that restates the sentence
  next to it.

**Type, icons and layout**
- A third font family; mono setting prose; Inter or Inter Tight; weight 300 or 700.
- A filled icon in an outline set; an emoji or mono glyph standing in for a
  missing icon; a coloured icon doing a status word's job.
- Proportional digits in a column of numbers.
- Centred paragraphs; a marketing hero; a full-width centred content column.
- Off-scale spacing (13, 15, 18, 22); margins where `gap` belongs.
- Two control heights in one row; equal nested radii.

**Structure and behaviour**
- A new component that duplicates an existing one with different padding.
- A card wrapping every single setting; a card inside a card; a list of cards
  where rows would compare better.
- A modal for something that doesn't need to block; two stacked modals; a drawer
  opened from a modal; a toast for something the user must act on.
- A hover-only affordance that is the sole route to an action; hover actions that
  shift the row when they appear.
- Breadcrumbs, a duplicate in-body page title, or a tab bar repeating the rail.
- A single click that mutates data; a confirm dialog where undo would serve.
- Geometry that moves on hover or focus.
- Emoji as UI, decorative gradients, looping animation with no running work.
- A raw error string as the whole error state.

---

## Appendix A — element → token map

The binding reference. Every element in the app appears here; if a surface you
are building is not listed, use the row for the closest structural equivalent —
do not choose a colour. Blank means the property is not set at all (which is the
correct answer far more often than a border is).

### A.1 Shell

| Element | Background | Text | Border / divider | Shadow |
|---|---|---|---|---|
| Window / app root | `--ground` | `--text` | — | — |
| Sidebar rail | `--ground` | — | — | — |
| Rail app title, logo mark | `--primary` fill, `--on-primary` glyph | `--text` | — | — |
| Rail nav item, rest | — | `--muted` | — | — |
| Rail nav item, hover | `--hover` | `--text-soft` | — | — |
| Rail nav item, selected | `--sel` | `--text` (600) | — | — |
| Rail group label | — | `--faint` | — | — |
| Rail count / badge | — | `--faint` | — | — |
| Rail section divider | — | — | `--hair` | — |
| Content sheet | `--surface` | `--text` | — | — |
| Secondary list column / inspector | `--panel` | `--text` | — | — |
| Panel header / toolbar | inherits parent | `--text` | `--hair` below | — |
| Panel boundary, structural | — | — | `--edge` | — |
| Resize handle, hover | `--edge` | — | — | — |
| Scrollbar thumb | `--edge` | — | — | — |

### A.2 Type roles

| Element | Token |
|---|---|
| Page title, section heading, card title | `--text` |
| Body prose, secondary sentence | `--text-soft` |
| Helper text, metadata, timestamps, counts | `--muted` |
| Group labels, placeholders, inactive counts, disabled meta | `--faint` |
| Link, rest | `--accent-ink` |
| Link, hover | `--accent` |
| Machine values (paths, hashes, branches) | `--muted`, or `--faint` when secondary |
| Text on a primary button | `--on-primary` |
| Error message under a field | `--blocked-ink` |
| Text selection highlight | `--sel` |

### A.3 Containers

| Element | Background | Border | Shadow |
|---|---|---|---|
| Card | `--card` | `--edge-raised` | `--shadow-card` |
| Card, hover (clickable) | `--card-hover` | `--edge-raised` | `--shadow-card-hover` |
| Card internal divider | — | `--hair` | — |
| Settings panel / large settings group | `--card` | `--edge-raised` | `--shadow-panel` (light only) |
| Settings row separator | — | `--hair` | — |
| Popover, dropdown, context menu | `--overlay` | `--edge` | `--shadow-pop` |
| Menu item, hover | `--hover` | — | — |
| Menu item, selected | `--sel` | — | — |
| Menu separator | — | `--hair` | — |
| Modal | `--overlay` | `--edge` | `--shadow-modal` |
| Modal scrim | `--scrim` | — | — |
| Drawer | `--surface` | `--edge` on the attached edge | `--shadow-pop` |
| Drawer footer | `--surface` | `--hair` above | — |
| Tooltip | `--overlay` | `--edge` | `--shadow-pop` |
| Code / payload block | `--well` | — | — |
| Composer surface | `--field` | — | — |
| Empty state container | — | — | — |

### A.4 Controls

| Element | Background | Text / glyph | Ring |
|---|---|---|---|
| Primary button, rest | `--primary` | `--on-primary` | — |
| Primary button, hover | `--primary-hover` | `--on-primary` | — |
| Secondary button, rest | `--field` | `--text` | — |
| Secondary button, hover | `--field-hover` | `--text` | — |
| Ghost / icon button, rest | — | `--muted` | — |
| Ghost / icon button, hover | `--hover` | `--text` | — |
| Destructive button, rest | `--blocked-bg` | `--blocked-ink` | — |
| Destructive button, hover | `--blocked-bg-hover` | `--blocked-ink` | — |
| Primary button, active | `--primary-press` | `--on-primary` | — |
| Any other button, active | `--press` over its rest fill | unchanged | — |
| Any button, focus (pointer) | unchanged | unchanged | — |
| Any button, focus-visible | unchanged | unchanged | `--focus-ring` 3px |
| Primary button, disabled | `--primary-disabled` | `--text-disabled` | — |
| Any other button, disabled | `--field-disabled` | `--text-disabled` | — |
| Input / textarea, rest | `--field` | `--text` | `--field-edge` inset 1px |
| Input, hover (single-line only) | `--field-hover` | `--text` | — |
| Input, focus (any) | `--field-focus` | `--text` | `--field-edge-focus` inset 1px (neutral) |
| Input, focus-visible | `--field-focus` | `--text` | + `--focus-ring` 3px |
| Input, error | `--field` | `--text` | `--blocked` inset 1px |
| Input, disabled | `--field-disabled` | `--text-disabled` | — |
| Placeholder | — | `--placeholder` | — |
| Composer surface | `--field` | `--text` | as input, no hover |
| Composer hint / affordance row | — | `--muted` | — |
| Segmented track | `--field` | — | — |
| Segmented item, inactive | — | `--muted` | — |
| Segmented item, active | `--card` | `--text` (600) | — |
| Select trigger | `--field` | `--text`, chevron `--muted` | as input |
| Checkbox / radio, unchecked | `--field` | — | `--control-edge` inset 1px |
| Checkbox / radio, checked | `--accent` | `--on-primary` | — |
| Toggle track, off | `--field` | `--control-edge` inset 1px | — |
| Toggle track, on | `--accent` | — (the fill is unmistakable) | — |
| Toggle track, disabled | `--field-disabled` | `--control-edge` inset 1px | — |
| Toggle knob, off / disabled | `--overlay` | `--edge-raised` inset 1px | `--shadow-card` |
| Toggle knob, on | `--on-primary` | `--edge-raised` inset 1px | `--shadow-card` |
| Slider track / fill / knob | `--field` / `--accent` / `--card` | — | — |
| Search field | `--field` | `--text`, icon `--faint` | as input |
| Filter chip, rest / active | `--field` / `--sel` | `--muted` / `--text` | — |
| Tab, inactive / active | — / `--sel` | `--muted` / `--text` | — |
| Keyboard hint (⌘↵) | `--field` | `--faint` | — |

### A.5 Rows and tables

| Element | Background | Text |
|---|---|---|
| Row, rest | — | `--text` |
| Row, hover | `--hover` | `--text` |
| Row, selected | `--sel` | `--text` |
| Row, pressed | `--press` | `--text` |
| Row, disabled | — | `--text-disabled` |
| Row secondary line | — | `--muted` |
| Row separator | `--hair` | — |
| Table header | — | `--muted` |
| Table header separator | `--hair` | — |
| Zebra striping | never | — |

### A.6 Status, progress and data

A status pill is a `-bg` fill with the matching `-ink` text. A status dot or bar
**standing alone** uses the base hue. Never the reverse. A glyph *inside* a pill
inherits the pill's ink — the pill already carries the tone, and a second tone
inside it reads as a second fact.

| Element | Fill | Ink |
|---|---|---|
| Working, running pill / dot | `--accent-soft` / `--accent` | `--accent-ink` |
| Waiting pill / dot | `--waiting-bg` / `--waiting` | `--waiting-ink` |
| Blocked, error pill / dot | `--blocked-bg` / `--blocked` | `--blocked-ink` |
| Verified, merged pill / dot | `--verified-bg` / `--verified` | `--verified-ink` |
| Idle, draft pill / dot | `--idle-bg` / `--idle` | `--muted` |
| Neutral count badge | `--field` | `--muted` |
| Progress track / fill | `--field` / `--accent` | — |
| Progress step, done / active / pending | `--verified` / `--accent` / `--idle` | `--muted` label |
| Stale ribbon | `--waiting-bg` | `--waiting-ink` |
| Skeleton / loading placeholder | `--field-disabled` | — |
| Diff added / removed | `--verified` at 10% / `--blocked` at 10% | `--verified-ink` / `--blocked-ink` |
| Accent-tinted surface (selected filter, active pill, `@`-mention chip) | `--accent-soft` | `--accent-ink` |
| Categorical dot / bar (repo, agent, saved view) | `--id-1` … `--id-6` (§2.8) | label stays `--text` / `--muted` |
| Avatar fallback | `--field` | `--muted` |
| Focus rim, text entry | — | `--field-edge-focus` inset 1px (neutral) |
| Focus halo, keyboard only | — | `--focus-ring` 3px |

`--id-*` are derived from the `skill` seed by the rotation in §2.8, carry no
semantics, and are never used for text — never reuse a status hue for a category,
or an `--id-*` for a state.

---

## Appendix B — where things live

- **`tools/build-themes.mjs`** — the seven seeds per theme, emission, and
  `--check`. The only file where theme colour is authored.
- **`tools/theme-derivation.mjs`** — the derivation as pure functions: the surface
  ladder, the ink solver, the measurement pass. No I/O, so it is unit-testable and
  readable on its own.
- **`themes.css`** — generated; what the app loads. 16 themes as
  `[data-theme][data-mode]` blocks, plus `--font-*` and `--r-*`.
- **`theme-tokens.json`** — generated; same data plus seeds, contrast floors and
  measurements, for tooling.
- **Appendix A** — the binding element → token map. First place to look when
  building anything.
- Visual reference: the theme direction board and theme picker in this project.
  The picker is the reference integration — it sets `data-theme`/`data-mode` on
  `<html>` and computes no colour of its own.
