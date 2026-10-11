# Task Monki — Interface Guide

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
   mock of this product. Reuse the shared component. Improve it when the
   requirement is shared. Keep workflow-specific behavior with its existing owner.
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
9. **Facts, not instructions.** A title states what is true ("Ready for review",
   "Codex wants to run a command"); a button says what it does. Never a sentence
   that restates the buttons beside it, never a "state — do this" headline, never
   metadata strung together with middle dots. A sentence earns its place only when
   it changes the decision in front of the user.

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
| `--ground` | window frame: titlebar and icon rail; the plane everything sits on | bottom |
| `--panel` | rail inside a sheet: the Review index, the Settings section list, folded code | |
| `--surface` | the content sheet, side panels, modals | |
| `--well` | code and read-only payload blocks | recessed from the sheet |
| `--field` | inputs, secondary buttons, the user's messages | control plane |
| `--sel` | selected row, active tab | |
| `--card` | a raised unit on the sheet; composers, menus and popovers | |
| `--overlay` | tooltips and toasts only | top |

**A floating layer is lifted by its edge and shadow, not by a brighter fill.**
A modal is the surface plane with the `--edge` ring, `--shadow-modal` and the
scrim behind it; a menu is the card plane with the `--edge` ring and
`--shadow-pop`. Painting a modal with `--overlay` makes the largest layer the
brightest object on screen, which is the opposite of focus. Overlay stays for
the two smallest floating things, tooltips and toasts.

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
| active | `--press` over the rest fill. The primary family, whose fill is already ink, uses `--primary-press` — an ink overlay on an ink fill is invisible. Only a control that owns a fill takes it, which is why hover rules set `background-color` and never the shorthand (it would erase the overlay). A tab, a segment, a text link, a disclosure row, a switch and a scrim have no fill to darken and press by ink alone — never a grey box; a menu trigger opens on press, so its open state is its press. |
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

- **Five line weights, one job each.** Every line in the app is one of these,
  and which one you need follows from what the thing *is*:

  | Weight | Belongs to | Examples |
  |---|---|---|
  | `--hair` | an **interior divider** — content continuing on the same plane | rows in a list, a footer inside a card, a settings separator |
  | `--field-edge` | the **resting boundary of a filled control** | input, textarea, composer, select trigger, segmented track, secondary button |
  | `--field-edge-focus` | the same rim while the control **holds focus** — one notch darker/lighter, same hue-free ink | focused input, textarea, composer |
  | `--edge-raised` | the boundary of an **object** resting on its plane | card, panel, response, decision block |
  | `--edge` | a **seam** between structural planes, and **floating** layers | rail↔sheet, drawer edge, menu, popover, modal, tooltip |

  `--control-edge` is separate from these five: an opaque 3:1 line for a control
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
  Do not put two lines on one control or draw a line **instead of** the fill step.
  An object — something with a boundary that sits above its plane and could
  conceptually be picked up — gets `--edge-raised` instead.
- **Polarity is automatic, and it is the whole reason this works in both modes.**
  Every one of them is alpha over `ink`, so the same token is a dark hairline in
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
     control, and a pointer click must never produce it. Like a line, the halo
     is accent at an alpha solved per theme and mode to clear 3:1 over every
     plane (§8); an accent seed that cannot carry it fails the build.

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
**16 themes × 2 modes × 63 tokens**, every set complete.

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
  `--well` and `--overlay` · an accent and waiting hue closer than 24° and 8 L* ·
  a `--focus-ring` under 3:1 over any plane.
  These are precisely the things review cannot see.

Measured worst case across all 32 sets: `--text` 9.63:1, `--text-soft` 5.48,
`--muted` and `--placeholder` 4.68, status inks 4.68 (including on their own
tints), `--text-disabled` 3.63, `--faint` 3.13, `--idle` 3.12, `--id-*` 3.52,
`--focus-ring` 3.00. `theme-tokens.json` records the current values.

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

Two families, both named in the token layer as `--font-ui` and `--font-mono`:
**Instrument Sans** for the interface and **Geist Mono** for machine values,
each one variable file bundled with the app (`@fontsource-variable`, Latin and
Latin Extended; Geist Mono also Cyrillic and box drawing) and never fetched.
The platform faces follow in each stack as the fallback. Instrument Sans keeps
SF Pro's density (slightly narrower at 13px) with tabular figures behind
`tnum`; Geist Mono keeps SF Mono's x-height, slashes its zero and tells I, l
and 1 apart, and every Mac now renders code in the same face. A component
references the tokens and never a family name. Weights: **400 and 500** only
(`--w-medium`; the page title takes `--w-title`, also 500). The hierarchy comes
from size and ink, not weight. No 300, no 700, no italic outside quoted prose. `font-feature-settings:
"tnum"` on every number that sits in a column or updates in place, so digits
don't jitter. Nothing depends on a webfont having loaded to be legible.

### 3.2 Scale

Interface type is one sans; machine values are one mono. No third family.

| Role | Token | Size / weight |
|---|---|---|
| Page title | `--t-title` | 22 / 500 · `-0.02em` |
| Section heading | `--t-heading` | 15 / 500 |
| Panel title, control label | `--t-label` | 13 / 500 |
| Body, prose | `--t-body` | 13 / 400 |
| Secondary, helper | `--t-help` | 12 / 400 `--text-soft` |
| Metadata, counts | `--t-meta` | 11.5 / 400 `--muted` |
| Group label | `--t-group` | 12 / 500 `--muted` |

Every label is sentence case. Nothing is set in capitals with added tracking: an
eyebrow in caps reads as a web template, and a group label is quiet because it is
small and `--muted`, not because it shouts.

**Seven sizes, and they are tokens.** A component sets `font-size: var(--t-label)`
and never a literal. A size that is not on this list does not exist: the reason
to name them is that an unnamed scale is not a scale, and the renderer had
drifted to 22 distinct sizes against these seven.

**Times follow the system clock format everywhere** — "5:29 PM" or "17:29"
as the OS says, never a forced 24-hour clock or a zero-padded hour; a date is
added ("Oct 10, 5:29 PM") where the time alone could mean another day.

**Mono is for strings the user copies or compares character for character** —
branches, commit hashes, paths, commands, payloads, token names. Model names,
counts, dates, durations and setting values ("Restricted", "Low") are set in the
interface face: a column of monospace values reads as a terminal, not as an app.
Mono never sets prose, labels or buttons.

Never use size alone to build hierarchy where weight and colour will do it.
Never centre a paragraph. `text-wrap: pretty` on prose. Truncate with ellipsis
and keep the full value in `title`; never wrap a machine value mid-token.

### 3.3 Icons

**One set, outline only.** Never mix an outline set with a filled one, and never
substitute an emoji, a glyph from the mono font, or a hand-drawn SVG for a missing
icon — use the nearest icon in the set or a word.

Sizes **13 / 16 / 18**, matched to the row they sit in (13 in compact rows, 16
everywhere else, 18 on the rail). **One line weight at every size:** every
stroke icon draws `--icon-stroke` (1.25px) in screen pixels, set once in
`base-components.css` with a non-scaling stroke, so a component never passes a
`strokeWidth`. `stroke="currentColor"`, `fill="none"` — an icon inherits ink
from its row so it dims with `--muted` automatically and needs no colour of its
own. Never a coloured icon where a status word or dot would do.

**One agent mark.** Every agent in the app — the implementation agent's side
question, the reviewer, the Preview agent, prompt refinement — is marked with
`AgentMark` (Lucide `Sparkles`) and nothing else. Agents never get a chat
bubble, a robot or a comment icon; the same mark everywhere is how a user
learns "an agent answers here".

Icons are decoration next to a label and information when alone: an icon-only
control carries an `aria-label` and a `Tooltip`; a native `title` is not a
tooltip. Optically centre against text
rather than aligning boxes, and keep 8–9px between icon and label.

---

## 4. Spacing and geometry

Use the shared spacing and geometry defaults below. Align related headings,
content, fields, and actions to common edges. Keep spacing within a group smaller
than spacing between groups. Give containers consistent internal padding,
including expanded and error states. Place actions beside the content they affect
or in its established footer. Add a container only when it communicates a
meaningful grouping or boundary.

| Thing | Padding / gap |
|---|---|
| Card | 11–12 pad, 6–8 internal gap |
| Panel / settings block | 16–18 pad, 15 row rhythm |
| List row | 8 horizontal, 26–30 tall |
| Sheet | 14–16 pad |
| Between cards | 10–12 |
| Section separation | 24–32 |

Radii are tokens, not literals, and each step has one job:

| Token | Radius | Used for |
|---|---|---|
| `--r-2xs` | 4 | keyboard keys, tiny inline marks |
| `--r-xs` | 6 | badges, menu items, list and index rows |
| `--r-sm` | 8 | buttons, fields, icon buttons, rail items |
| `--r` | 10 | menus, finding threads, comments |
| `--r-md` | 12 | sheets, side panels, cards, composers, tables |
| `--r-lg` | 14 | modals |
| `--r-pill` | 999 | counts and dots |

Concentric things step inward; never nest equal radii.

Control heights are tokens too: `--h-control` 32 decision surface ·
`--h-toolbar` 28 toolbar and compact buttons · `--h-compact` 24 inline ·
`--h-icon` 28 icon button. Never mix two heights in one row. Hit targets never
below 24px on desktop, 44px on touch.

Writing `border-radius: 9px` or `height: 36px` is the same class of error as
writing a hex colour: it is a value the system already has an answer for.

### 4.1 Fixed geometry

These are settled. Use the value, don't re-derive it.

| | |
|---|---|
| Titlebar | 44 tall (`TITLEBAR_HEIGHT`), shares the ground with the rail |
| Rail | 56 wide, icon-only, permanent; 36px items |
| Content sheet | inset 8px from the window's right and bottom edges, `--r-md` |
| Secondary list column | 268 default, resizable 220–360 |
| Toolbar / panel header | 48 tall |
| Page gutter | 24 at minimum width · 32 wide |
| Reading column (settings, prose) | 880 max; tables and lists go full width |
| List row | 26 compact · 30 default · 36 two-line |
| Button | 32 tall (28 with `button--sm`), 12 horizontal pad, 64 min width |
| Icon button | 28 square (24 compact, `--h-compact`), 16 glyph (13 compact) |
| Single-line field | 32 tall, 12 horizontal pad |
| Textarea / composer | 88 min body plus the 42 toolbar, 10–12 pad |
| Popover / menu | 220–280 wide, 4 pad, 28 rows |
| Modal | 440 confirm · 560 form · 640 creation · 720 payload |
| Side panel | 380 docked, resizable 320–560; floats over the content below a 560px content floor |
| Settings section list | 212 |
| Review index | 248 (208 below 1100) |

Widths are the design intent, not a hard cap: a panel may be resized by the user,
but it opens at these values and never below the minimum.

---

## 5. Component contracts

Reuse components for equivalent content and interactions across screens. Similar
appearance alone does not justify a shared abstraction. When an existing component
fails the required interaction, improve or replace it and remove the superseded
implementation. Adapt established primitives, including shadcn/ui or AI Elements,
to Task Monki's tokens and behavior. Adopting UI primitives does not require
replacing the runtime.

**Buttons — four families, no fifth.** Primary (`--primary` fill, `--on-primary`
ink; one per surface), secondary (`--field` fill with the `--field-edge` rim),
ghost (transparent, `--hover` on hover; the compact toolbar family, 28 tall),
destructive (soft tint, never a filled red block). Labels are 13/500. Primary,
secondary and destructive share the decision geometry so a pair aligns;
`button--sm` puts any of them on the toolbar height. Choose button emphasis by
action priority, not by whether the button contains an icon or a label.
Icon-only buttons (`tm-iconbtn`, 28 square) use a 16px glyph and always carry an
`aria-label` and a `Tooltip`, never a native `title`. Every button settles to
`scale(0.97)` while pressed (§9); a menu trigger does not, because its menu is
already open beside it.

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
`--placeholder` (= `--muted`). Label above at `--t-label`/500, help text below at
`--t-help` `--muted`, error text replaces help text and carries `--blocked-ink`.
Never rely on placeholder as the label.

**Text areas take no hover fill.** Nothing happens when the pointer arrives and
the caret is the real confirmation; a multi-line surface repainting under the
mouse is the noisiest thing a quiet app can do.

**Conversations.** Keep messages chronological and readable. Distinguish authors
through consistent placement and treatment. Show identity labels when they resolve
ambiguity. Keep tools, plans, and diagnostics subordinate to the exchange.
Collapse verbose supporting detail, not entire messages. A finished answer's
footer is its time, and a duration when the work took one; never the word
"Completed", and never "Failed" under a notice that already says the run failed.
A tool step expands only to show something its row does not: a command it ran
in place of the row's text, an error, output. The command, error and output are
one `--well` block divided by hairlines.

**Requests.** Every request card ends the same way: actions at the right,
declining first and the primary action last, and cancelling the whole request
apart at the left. A provider's own options are put in that order too. A
multi-question request says how many are answered beside a disabled Submit.

**Composers.** Present text, attachments, pending messages, and delivery controls
as one interaction. Use the shared composer surface without another input-shaped
container inside it. The composer is raised on the card plane and the user's
messages use the field fill, so the place to type never looks like something
already sent. Inside a form (New task, a new Design) it is one more field and
takes the field fill like the inputs beside it. Separate mode selection from actions. Make delivery timing
and held states clear where the user sends or edits a message. Preserve the draft
and selected files through supported navigation, failure, and restart paths.

One toolbar anatomy everywhere (`AttachmentComposerShell`, `ConversationPanel`):
the paperclip as an icon button with a tooltip, then the chips — model
(`AgentModelSelector` compact), access (`AccessMenu`, which holds network
access too), profile (`AgentProfileSelect`, shown only when profiles exist) —
then at most one line of state, then the actions. A chip has no fill or rim
until hovered or open (`.tm-composer-chip`); the same chips outside a composer
sit in a `.tm-chip-row`. The hint states a reason or a state that changes what
sending does; it never explains the control ("Paste or drop files", "Read-only",
"Task prompt" are not hints). Placeholders end without an ellipsis.

**Before the first run, the Agent tab is one composer**, centred in the tab: the
prompt, saved attachments, and the toolbar with model and access chips and the
step (Prepare worktree or Start). Starting saves the prompt; there is no
separate save. New task uses the same chips in its description's toolbar.

**Badges.** A state word on a 12–14% tint of its tone (`status-pill`, the
`Chip` component): 20 tall, `--r-xs`, `--t-meta`/500, no border, no dot, and
nothing in it moves. One size everywhere.

**Tables and comparable lists.** One container (`tm-table`, and the Inbox list):
the `--edge-raised` ring drawn over the rows, `--r-md`, no fill of its own,
`--hair` dividers, a 36px header in `--muted` `--t-help`, 48px rows that take
`--hover` on hover, row actions in a menu revealed on hover and focus. Settings
lists use the same container; a settings row is never a card.

**Tooltips.** The `Tooltip` component (Radix) on `--overlay` with the `--edge`
ring: 500ms before the first, instant between neighbours, the name and an
optional shortcut, never information the decision needs.

**Segmented vs menu.** Segmented for 2–4 options whose labels fit on one line at
the narrowest width the container reaches; a dropdown for anything longer or
open-ended. A wrapping segmented control is a bug. There is one segmented
control (`.segmented`); a list column's status filter (Designs, Discourse) adds
`.segmented--fill` so its options share the column's width.

**Selects.** A native `<select>` draws the same chevron as the custom pickers —
two 1.5px `--muted` strokes, 10px from the right edge — from one rule in
`base-components.css`. A rule that colours a select sets `background-color`,
never the `background` shorthand, which would erase the chevron.

**Menus and popovers.** `ActionMenu` (Radix): `--card` + `--edge` ring +
`--shadow-pop`, `--r`, 4px pad, 28px rows with `--r-xs` items in `--text`,
group labels per §3. Destructive item last, separated by a `--hair`. Escape
closes, arrow keys move, focus returns to the trigger. A new menu uses
`ActionMenu`; hand-built menus are legacy.

**Settings row.** A setting is a row, not a card: label left, control right,
optional one-line description under the label (`SettingsRow`). Rows are
separated by `--hair` inside one `tm-settings__list`, the table container
with no fill of its own. The label is `--t-label`/500 and the description
`--t-help` `--muted` on every pane; controls in a row share `--h-control`, so
a button beside a select is a full-height button. Never wrap each setting in
its own card. A pane that is unavailable says so in one muted line where its
rows would be.

**Task collection cards — fixed content order.** The top line holds the
repository in `--muted` sans on the left, only when the view spans repositories,
and the state badge on the right, only when it refines the lane (a Ready task
in Backlog / Ready has none); then the title at `--t-body`/500, with the actions
menu revealed on hover beside it; then, when there is one, a fork's lineage or
the In review view's finding count as one quiet line; then the pull request:
GitHub's icon for its state and its number, plus delivery progress only when the
badge does not already say it, so "Checks failed" never sits beside "checks
failing". No rule inside the card, no card inside a card. The whole card
carries the hover fill and there is no separate "Open" link.

**Inbox rows.** The Inbox is one list in the table container. Each row leads
with a 28px tile: the glyph for the kind of decision (approval, question, retry,
failure, checkout, Git, delivery, finish) on a tint of its tone; then the title
with what it needs beneath it — the reason in its tone ink, then one recorded
fact, the agent's question or the command; the repository when it
distinguishes; the age; and, for a plain command approval only, its decisions
in place. The whole row opens the task; there is no "Open task" button.

Use a card when a unit has mixed content types (status + prose + metadata) and
stands alone. Use a row when items are compared against each other. A list of
cards is almost always a list of rows wearing costumes.

**The Now panel.** A single sheet that asks the user for a step has exactly one
raised element: the Now panel, at the top of the work column. It holds the step
the subject needs now, and its owner follows the UI priority in
`docs/PRODUCT_WORKFLOW.md` — a pending request, the checkout, recovery, running
work, an unmerged pull request, finishing, setup, or how a closed subject ended.
Each owner brings the controls it already has; the panel only decides which one
leads, so the next step never moves between cards. When the board card's word
for the task is the agent review asking for action, finishing holds the panel
even while a pull request is open: the next step is the review's. A review asks
for action only while a finding is open; once the user dismisses the last one,
the pull request leads again. Its anatomy
is fixed: a factual title, at most one line of facts or of quoted provider text,
then the actions. The title is the board card's word for the task, unless that
would only repeat the lifecycle stage. An owner with something more specific to
say keeps its own words: "Codex wants to run a command", "Codex is working".
While no pull request exists and finishing holds the panel, opening one is a
finishing action here; otherwise PR Status offers it as a section, so it appears
exactly once on the page. Marking done despite open evidence is the owner's
override: never the filled primary, always last. Three actions sit side by
side; past three, the first two stay and the rest — the overrides — move under
a More menu, each keeping its disabled reason inline.

Provider text is quoted, never set as Task Monki's own: under a title or caption
that names the agent, with a 2px `--edge-raised` rule along its left edge.

Everything else on the page is a section: a quiet label (`--t-help`/500,
`--muted`), then content. Space separates sections; no rule runs under a label.
The story's sections (request, result) are flat: no card, no fill. Record
content — Details, the preview, History, and the agent review and pull request
in the story — is an inset group: `--panel` fill, `--r-md` corners, a 16px 18px
inset, no ring or shadow. Recessed reads as reference and raised as "act", so
the groups never compete with the Now panel. Record groups sit 12px apart. The panel's primary is the page's primary; actions in a
section stay secondary. A disabled action keeps its place, and its reason is
stated once beside the actions and tied with `aria-describedby` (a disabled
button cannot take focus, so a tooltip alone never reaches the keyboard).

**A task page reads in lifecycle order.** The work column is the story: the Now
panel, the request (omitted when it only repeats the title), the result (what
the agent reported, attributed, above the files Task Monki captured, or "No file
changes"), the agent review once one exists, and the pull request. A fixed
300px record column beside it holds Details (one label and value per row; a
setting's companion, such as the effort beside the model, follows in muted ink
and wraps beneath rather than being cut off), the preview, and History: the date
once per day, then what happened with its time on the right and who recorded it
beneath, with each entry's evidence left to the full ledger in Debug. An empty section is never
rendered: the Now panel offers what has not happened yet.

**The Review tab.** The change is read in the order that matters, with the
reviewer's findings and the person's own comments on the code they are about.
The page head stays folded on this tab: the title sits in the window's top bar
and the code gets the room. Nothing on the tab explains itself in words a
control's icon, state or tooltip already carries.

- *Toolbar* (40px). The navigator's switch (Files, with viewed progress as
  "2/7", and Feedback) sits over the navigator; then the review in one phrase in
  its tone's ink and its time; then Compare (All changes, Committed,
  Uncommitted, Since the review once the review is stale), a View icon (By
  importance, By path; expand or collapse every file), and the review action.
  A stale review keeps Run review again as the primary there.
- *Navigator* (248px on `--panel`). Files by importance: files with an open
  Blocker or Major, then code with each test right after the code it covers,
  then styles and markup, configuration, documentation, and generated files,
  collapsed. One 28px row each: the name in mono, its folder muted, a comment
  count when it has feedback, then the counts or the viewed check. Feedback
  lists every finding and comment by what happens to it: To send, Suggestions,
  Settled.
- *Brief.* Facts before opinions: the request, what the agent reported (quoted),
  then the review's summary. Open on the first visit to a review run; folded, it
  is the request's first line.
- *Files.* Each file is an `--edge-raised` ring (`--r-md`) with a 36px sticky
  head at table-row scale: the chevron and path as one toggle (⌥: every file),
  the directory muted before the name, a word only for New, Deleted or a rename,
  the open findings in words, the counts, the shared checkbox for viewed (no
  label), and ⋯ (Comment on file, then where it opens). A viewed or generated
  file collapses, but its open findings stay as one-line rows: Viewed never
  hides a finding.
- *Rows.* The gutter is the line number (the old side's on a removed line),
  sized per file so the comment "+" fits beside the largest number; the "+"
  shows on the row under the pointer and fills when the pointer is on the
  number. Pressing a number, or dragging across several, opens one comment for
  that line or range. Then the marker and code that wraps; the gutter takes the
  row's tint. Threads and comments start at the code column.
- *Findings.* A thread under the last line of its range, on `--card` with the
  `--edge-raised` ring, its severity as a word (blocker and major in
  `--blocked-ink`), and its actions on the title line: Add to request on a Minor
  or Nit (Blocker and Major are in by default), Ask, and Dismiss, a menu of
  reasons (Not a problem, Acceptable as is, With a note…). A dismissed finding
  folds to one line with Restore.
- *Comments* sit on `--field` with icon-only Edit and Delete; they can be written
  any time the current diff is shown and are saved with the task as written.
- *Foot.* Always present: when something is queued, its summary ("1 fix, 2
  comments"), which opens the request sheet; a note that grows to four lines;
  and one primary: Request changes when something is queued, otherwise the step
  that finishes the task. The sheet lists what goes out in send order, what is
  left out, and the instruction, one disclosure away.
- *Stale.* An out-of-date review keeps its threads as earlier context, without
  Ask or Dismiss; its findings are never sent, the person's comments still are.
- *Keys.* J/K files, N/P open findings, V viewed and on to the next unviewed
  file, D dismiss, A ask, F add or take out a suggestion, C comment on the
  chosen lines, ⌘↵ the request sheet and then send.

**Side panels.** An assistant panel (Ask reviewer on Review, Side question on
Agent, Preview agent on Preview) is its own sheet beside the task page, 380px by default and resizable
from 320 to 560, toggled from the right end of the tab bar with the agent mark.
It stays a separate sheet in every window that can hold it: a narrow window
lends it less width, down to 320, before the page would drop below 560px, and
only below that does it float over the page, sliding in 8% with the drawer
curve. Its resize edge is the sheet's own left edge; hover and focus draw a 2px
line there.

With a panel docked, the two sheets read as one layout: the task page keeps only
its 48px tab bar, which shares the panel head's line and hairline, and the
task's title moves to the window's top bar beside the back and forward arrows
(it does the same when the title scrolls away on the Agent tab). The head folds
rather than disappearing, so the tab bar glides up into the shared line. The panel's
content keeps a 16px inset; its composer has the main composer's height and
ends 16px above the sheet, as the main composer and the Review foot do,
so every input box shares one bottom line. Its head is
48px: mark, name, the runtime that answers, close. Escape closes it and focus
returns to the toggle. An empty panel says in one muted sentence what it is
for; each answer it can act on carries that action under it ("Use in
follow-up"). The Preview renders its agent into the sheet's slot; a Preview
shown without a task page (a repository Design) keeps its own toggle and opens
the same panel as a floating sheet over itself.

A side question goes to the model chosen in the panel's composer (the task's
own until another is picked; any enabled runtime) in a fresh read-only session,
so the implementation keeps working; while it works, the question reads a
snapshot taken when it was asked. In a narrow composer the model and effort chips
show as their marks alone (a brain, a gauge), each named in a tooltip. Closing the panel ends the thread and
removes the snapshot. Nothing reaches the main conversation unless the user
uses an answer in a follow-up, which puts it in the composer under the question
it answers.

**Drawers, modals, sheets — pick by interruption cost.** A drawer for detail and
editing alongside the list (right edge, full height, dismissed by Escape, a click
outside, or the same control that opened it; the list stays live behind it and
selection follows). A modal when the app genuinely cannot proceed —
confirmation of something destructive, a short blocking form — or for focused
creation such as New task: 640 wide, anchored near the top so a changing height
never moves its header, dismissed by Escape, its close button or a click
outside, with the draft text kept. A page for anything a user might link to,
bookmark, or spend minutes in. Never stack two
modals; never open a drawer from a modal. A modal is the surface plane with the
`--edge` ring and `--shadow-modal` over the scrim, `--r-lg`, and enters with
the modal motion (§9). Its anatomy is a title, at most one paragraph, the
content, and the actions; no icon tile beside the title, because the title
already names the act. A character count appears only near the limit.

**Destructive actions.** Prefer undo over confirm. Confirm only when the action
is unrecoverable, and then name the object in the button ("Delete branch", not
"OK") and put the cancel first.

**Button copy.** Sentence case, a verb the object can hear — "Save changes", not
"Submit". Never a bare "OK", never a gerund as the resting label ("Saving…" is a
state, not a label). Labels don't change on hover.

**Empty state.** One sentence naming what the surface is waiting for, plus the
single action that resolves it. No illustration, no second button.

**Links to another tab** ("Open conversation", "Open review", "View diff",
"Full history") are `tm-osection__link`: accent ink, no fill, at the right of
the header of the section they belong to.

**List rails** (the Designs and Discourse history) share the `.tm-listrail__*`
elements: the heading centred on a 28px New, a 32px search field, the status filter, then
50px rows that overhang the fields by 4px on each side. A row is the title and
one meta line — a status word in its tone, a neutral unread count, the time at
the right. An empty rail is one line.

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
  Save button and no toast. A form with interdependent fields submits explicitly.
- **Feedback lands where the action happened.** A sent message appears in the
  conversation, Stop becomes "Stopping…", an answered request closes its card;
  none of these also raises a toast. A success toast is for an outcome the user
  cannot see from where they are — a commit or pull request created, a
  repository added, a worktree restored, something archived — and an error
  toast for a failure with no surface of its own.
- **Selection survives** a refresh, a filter change, and a drawer opening; it is
  cleared only by the user. Scroll position is restored when returning to a list.
- **Tooltips are for names and shortcuts**, delayed 500ms, never for information
  needed to make the decision in front of you.
- **The arrow cursor everywhere.** A desktop app does not turn controls into
  links: no pointer hand on buttons, rows, tabs or cards. Text fields keep the
  text cursor and resize handles their resize cursor. `check:themes` refuses
  `cursor: pointer`.
- **Menus are one component.** Every menu, including a right-click menu, is
  `ActionMenu` (or `ActionContextMenu` at the pointer), with submenus for a
  choice inside a choice ("Open with"). Menu rows are words; no app icons.
- **One primary action per surface.** Use the established keyboard behavior for
  each control. Multiline editing and input composition must not trigger
  accidental submission.

---

## 6. Status and progress

- **In a collection, state is a word, never a bare mark.** A column of coloured
  dots is unreadable; words are scannable. On task cards the word is a badge in
  the card's top-right corner; in the Inbox it is the reason line beside the
  tile; elsewhere it is ink. Nothing in a badge or a status word moves.
- **Activity is shown, not spun.** No spinner anywhere. Work in flight is a
  still half-filled circle (`StatusGlyph` "working") wherever its state sits —
  the lifecycle track, a status word, a run header. Motion is kept for the one
  line of live text on a surface — a conversation's working line, the running
  step when it is the latest thing said, "Reviewing" — which takes a slow text
  shimmer (`.tm-shimmer`, 2.4s) beside a ticking elapsed time. The shimmer
  clears the glyphs with the text fill colour, so a label's own ink or a hover
  never paints over it; reduced motion leaves the words still in that ink.
  Loading copy ("Loading conversation…") is a still, muted line: loading is not
  live work. A pending button keeps its own icon and is disabled;
  its label changes only when it has one ("Checking…").
- **A checklist is read by its marks.** An agent's plan is the one collection
  whose state is a mark, because every checklist reads that way: shapes, not
  colours — a check for done, a dot for the current step, a ring for what is
  left. A word appears only on the step where a run failed or stopped. The plan
  never moves; the live words below it carry the motion.
- **One tone per unit, carried by one element.** Never tint the mark, the heading
  and the border of the same card. The badge or the status word carries it: the
  waiting tone when the user owes a step, the blocked tone when something
  failed, the accent while work runs, neutral otherwise.
- **One state, one word.** Task cards, the task page and every Tasks view read
  the same status function, so a state never has a second name on another
  surface.
- **The task page shows its lifecycle, not a pill.** Under the title, the board's
  four lanes read as a track in fixed words — Ready › In progress › Review ›
  Done — except where the task's phase is not its lane's stage: a backlog item
  reads Backlog, a canceled or archived task reads Canceled or Archived. Past
  stages are `--muted`, future ones `--faint`, and the task's stage is
  `--text`/500 with a glyph only when it needs the user, has failed, or is
  working (the still half-filled circle). Its status word
  is announced to assistive technology and stated in words by the Now panel. The
  track never repeats that word. The order is a decision the user owes, a broken checkout and
  recovery (an interrupted run included), work in flight, verified local and
  delivery evidence (a pull request's own progress among it), the agent review
  gate, then the phase.
  "Reviewing" means a review is running; once a pull request carries delivery,
  an absent or passed agent review is not the task's state — the phase is.
- Place current activity beside the work it describes. Distinguish execution
  status, provider-exposed reasoning, plans, and final results. Derive progress
  from observed state; never invent steps, percentages, or reasoning.
- **Stale is one ribbon**, with the same wording wherever it appears: the evidence
  shown no longer matches the current diff, and here is the one action that
  refreshes it. A ribbon or a state word — never both.
- Present each status or error once within the interaction. State what happened
  and the available next action. A failed Design update is stated by its turn;
  the canvas repeats the reason only while the conversation is hidden, and no
  footer repeats the header's status. Keep raw diagnostics available through secondary
  details. Add explanatory copy only when it changes the user's decision or
  prevents a likely mistake.

---

## 7. Shell, layout and responsive invariants

### 7.1 Layout archetypes — pick one, don't blend

1. **List + detail** — the default for any collection. Rail, list column, detail
   pane or drawer. The list keeps its own scroll and selection.
2. **Single sheet** — one subject, full remaining width, own header. For a task,
   a run, a document.
3. **Settings** — the sheet holds its own section list (212px, title on top)
   beside an 880 reading column of tables and `--hair`-separated rows (§5).
4. **Workspace** — a persistent working surface with its own toolbar and one
   focused artefact; side panels are collapsible and their state persists per
   user. Discourse and design review are this archetype: the conversation or
   artefact holds the centre at full height, context collapses, and nothing about
   the shell changes when you enter or leave.

Every page has exactly one header: title at `--t-title`/500, at most one line of
context under it in `--muted` (only when it says something the page does not),
actions right-aligned on the title line. A collection's views are tabs under
its title — the Tasks page shows All, Running, In review, Done, then saved
views with their marker and a control that adds one. No breadcrumbs (the
rail is the location), no duplicate title inside the body, no tab bar that
repeats what the rail already says. A task's context line is its lifecycle track,
then its repository and branch, each marked by an icon instead of a separator.
Page tabs are 13/400 words on the bar's baseline, a 1px `--hair` inset line;
the selected one changes only its ink to `--text` and takes that baseline in
`--text`, 1px with square ends, so it covers the hairline rather than sitting on
it. A tab's weight never changes and a tab never carries a count.

On the Agent tab the page head rides above the conversation: its title and
lifecycle slide away (200ms, `--ease-drawer`) once the first message has passed
beneath and the reader keeps scrolling down, and return on the way up (240ms);
the tab bar stays pinned. Only keyboard focus inside the head holds it.

A list-detail workspace (Designs, New Design, Discourse) has a 48px head: the
panel toggle, a 15/500 title with its state beside it on the same line, then the
actions. Side panels and the Discourse settings share that 48px line, so every
hairline under a head lines up. New Design is one centred column at the Agent
conversation's width: the source switch, then a single composer holding the
brief, the model and profile chips, the reason a run cannot start, and Create.

### 7.2 Shell invariants

- **The frame is the ground.** The 44px titlebar (Back, Forward, New task) and the
  56px rail share `--ground` with nothing between them, so they read as one
  L-shaped frame. Every page is one sheet inset 8px from the window's right and
  bottom edges, on `--surface` with `--r-md` corners and a `--hair` seam.
- **The rail is permanent and icon-only:** Inbox, Tasks, Designs, Previews,
  Discourse, then the update control and Settings at the foot. It never
  expands; names are tooltips. Something waiting on the user is a 7px accent
  dot at the icon's corner, ringed in the ground; how many is in the tooltip
  ("Inbox · 20 waiting") and on the page itself, never a number over the icon. Repositories are managed in Settings; New task opens on the
  repository used last.
- Give each workspace a clear scroll owner. Keep navigation and actions reachable
  without unnecessarily reducing the reading area. Menus and popovers must escape
  clipping containers and remain within the window.
- Related tabs share the same shell geometry. Switching tabs must not introduce
  unexplained gutters, background seams, or header movement.
- Every boundary between two panels is a resize handle: an 8px hit area on the
  boundary's hairline that draws a 2px `--edge` line on hover and focus, with a
  keyboard-reachable equivalent. A handle on the edge of a
  sheet that clips its overflow lies inside that edge, or nothing can grab it.
- **Degrade by dropping, not by shrinking.** As width goes, the secondary column
  collapses to a toggle and the primary task keeps its size and order. Semantic
  order never changes across widths. Nothing at the app's minimum window
  (1100 × 720) may hide a primary action.
- Content extremes are part of the design: test with a 120-character title, a
  4-digit count, an empty list, and 500 rows.
- **Layer order** is fixed: content → pinned headers → side panel → popover →
  tooltip → modal → toast. Escape closes the topmost only. A popover never survives the scroll of
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
- The board is not a card grid: its four phase lanes stay side by side at every
  supported window width, with a 188px lane floor. When a wide rail leaves less
  than that floor, the lanes scroll horizontally; phases never stack inside the
  app's minimum window. A card's status keeps its whole word; in a lane too
  narrow for both, the pull request wraps beneath it rather than clipping either.
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
- Use the established keyboard behavior for each control. Multiline editing and
  input composition must not trigger accidental submission. Escape closes the
  topmost layer. Arrow keys move within a list or segmented control. Every action
  reachable by mouse is reachable by keyboard.
- Preserve normal selection and copying of messages, code, and filenames. Drag
  regions and click handlers must not intercept those interactions.

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

**Motion.** Small and fast. Motion communicates continuity, causality or
genuinely active work — never decoration. Animate `transform` and `opacity`
only (fills and ink may transition on hover); enter with ease-out, never ease
in; leave faster than you arrive. Keyboard actions and anything done many times
an hour are instant. Nothing loops unless work is actually running.

| Element | From | Duration | Easing token |
|---|---|---|---|
| Hover and state feedback, a field's focus rim | — | `--motion-fast` 120ms | `--ease-out` |
| Button press | scale 0.97 | 120ms | `--ease-out` |
| Tooltip | scale 0.97, after 500ms; instant between neighbours | 125ms | `--ease-out` |
| Menu, popover, picker | scale 0.96 from its trigger; leaves at 120ms | `--motion-standard` 180ms | `--ease-out` |
| Submenu | opacity only; leaves at once | `--motion-fast` 120ms | `--ease-out` |
| Modal | scale 0.97; the scrim (every scrim) fades over `--motion-standard` | `--motion-modal` 220ms | `--ease-out` |
| Floating side panel | 8% from its edge | `--motion-slow` 280ms | `--ease-drawer` |
| Docked side panel | its content fades in; the page makes room at once | `--motion-standard` 180ms | `--ease-out` |
| Task head, as a panel docks | its row folds closed while it fades and lifts 6px; the title rises 6px into the top bar 60ms later, and both reverse | `--motion-slow` 280ms | `--ease-drawer` |
| Disclosure content | opacity; the height changes at once; not when it mounts open | `--motion-fast` 120ms | `--ease-out` |
| Jump to latest | 4px up; leaves at 120ms; stays mounted | `--motion-standard` 180ms | `--ease-out` |
| Toast | 8px up; leaves 4px down at 120ms | `--motion-toast` 240ms | `--ease-out` |
| Something moving on screen | its current position | 200ms | `--ease-in-out` |

Nothing animates because a tab or page was opened: a surface that is already
there when its tab mounts (a request bar, a disclosure mounted open, the task
head folded or open, the title in the top bar beside a docked panel) appears still. A hand-built chevron does
not flip when its menu opens; the open fill says so, as on every `ActionMenu`.

`--ease-out` is `cubic-bezier(0.23, 1, 0.32, 1)`, `--ease-in-out`
`cubic-bezier(0.77, 0, 0.175, 1)`, `--ease-drawer` `cubic-bezier(0.32, 0.72, 0, 1)`.
Under `prefers-reduced-motion` every transition and animation collapses to an instant change.

---

## 10. Verification

Follow the UI implementation and verification procedure in `AGENTS.md`. Use this
guide's component contracts to assess the rendered result. Run the repository's
applicable theme, architecture, and behavior checks.

---

## Appendix A — element → token map

The binding reference. Every element in the app appears here; if a surface you
are building is not listed, use the row for the closest structural equivalent —
do not choose a colour. Blank means the property is not set at all (which is the
correct answer far more often than a border is).

### A.1 Shell

| Element | Background | Text | Border / divider | Shadow |
|---|---|---|---|---|
| Window / app root, titlebar | `--ground` | `--text` | — | — |
| Rail | `--ground` | — | — | — |
| Rail item, rest | — | `--muted` | — | — |
| Rail item, hover | `--hover` | `--text-soft` | — | — |
| Rail item, selected | `--card` (raised, clearly apart from hover) | `--text` | — | — |
| Rail dot, waiting on you or an update | `--accent` | — | 2px ring in the item's fill | — |
| Content sheet | `--surface` | `--text` | `--hair` seam (outset) | — |
| Rail inside a sheet (Review index, Settings sections) | `--panel` or none | `--text-soft` | `--hair` on the attached edge | — |
| Panel header / toolbar | inherits parent | `--text` | `--hair` below | — |
| Panel boundary, structural | — | — | `--edge` | — |
| Resize handle, hover | `--edge` | — | — | — |
| Scrollbar thumb | `--edge` | — | — | — |

### A.2 Type roles

| Element | Token |
|---|---|
| Page title, section heading, card title | `--text` |
| Body prose, secondary sentence | `--text-soft` |
| Helper text, metadata, timestamps, counts, group labels | `--muted` |
| Placeholders | `--placeholder` (the `--muted` floor) |
| Inactive counts, disabled meta | `--faint` |
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
| Settings panel / large settings group | — | `--edge-raised` ring, as `tm-table` | — |
| Settings row separator | — | `--hair` | — |
| Popover, dropdown, context menu | `--card` | `--edge` | `--shadow-pop` |
| Menu item, hover | `--hover` | — | — |
| Menu item, selected | `--sel` | — | — |
| Menu separator | — | `--hair` | — |
| Modal | `--surface` | `--edge` | `--shadow-modal` |
| Modal scrim | `--scrim` | — | — |
| Now panel | `--card` | `--edge-raised` | `--shadow-card` |
| Overview record group (Details, preview, History, agent review, PR) | `--panel` | — | — |
| Section label | — | — | — (text `--muted`, `--t-help`/500) |
| Side panel, docked | `--surface` (its own sheet) | `--hair` seam | — |
| Side panel, floating | `--surface` | `--edge` | `--shadow-pop` |
| Tooltip, toast | `--overlay` | `--edge` | `--shadow-pop` |
| Table / comparable list | — | `--edge-raised` ring over the rows; `--hair` between rows | — |
| Review finding thread | `--card` | `--edge-raised`; the finding jumped to, or keyboard focus: a 1px `--focus-ring` rim | `--shadow-card` |
| Review finding, earlier review | `--panel` | `--hair` | — |
| User's line comment | `--field` | `--field-edge` | — |
| Code / payload block | `--well` | — | — |
| Composer surface | `--card` | `--field-edge`; focused: `--field-edge-focus` | — |
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
| Destructive menu item, rest and highlighted | the menu's own (none, then `--hover`) | `--blocked-ink` | a hairline separator above it |
| Primary button, active | `--primary-press` | `--on-primary` | — |
| Any other button, active | `--press` over its rest fill | unchanged | — |
| Any button, focus (pointer) | unchanged | unchanged | — |
| Any button, focus-visible | unchanged | unchanged | `--focus-ring` 3px |
| Primary button, disabled | `--primary-disabled` | `--text-disabled` | `--field-edge` inset 1px — the fill alone reads absent on its host |
| Any other button, disabled | `--field-disabled` | `--text-disabled` | — |
| Input / textarea, rest | `--field` | `--text` | `--field-edge` inset 1px |
| Input, hover (single-line only) | `--field-hover` | `--text` | — |
| Input, focus (any) | `--field-focus` | `--text` | `--field-edge-focus` inset 1px (neutral) |
| Input, focus-visible | `--field-focus` | `--text` | + `--focus-ring` 3px |
| Input, error | `--field` | `--text` | `--blocked` inset 1px |
| Input, disabled | `--field-disabled` | `--text-disabled` | — |
| Placeholder | — | `--placeholder` | — |
| Composer surface | `--card` | `--text` | edge as input, no hover |
| Composer hint / affordance row | — | `--muted` | — |
| Segmented track | `--field`, `--r-sm` | — | `--field-edge` inset |
| Segmented item, inactive | — | `--muted` | — |
| Segmented item, active | `--card`, `--r-xs` | `--text` (weight unchanged) | `--edge-raised` inset |
| Select trigger | `--field` | `--text`, chevron `--muted` | as input |
| Checkbox / radio, unchecked | `--field` | — | `--control-edge` inset 1px |
| Checkbox / radio, checked | `--accent` | `--on-primary` | — |
| Toggle track, off | `--field` | `--control-edge` inset 1px | — |
| Toggle track, on | `--accent` | — (the fill is unmistakable) | — |
| Toggle track, disabled | `--field-disabled` | `--control-edge` inset 1px | — |
| Toggle knob, off / disabled | `--overlay` | `--edge-raised` inset 1px | `--shadow-card` |
| Toggle knob, on | `--control-knob-on` | `--edge-raised` inset 1px | `--shadow-card` |
| Slider track / fill / knob | `--field` / `--accent` / `--card` | — | — |
| Search field | `--field` | `--text`, icon `--faint` | as input |
| Filter chip, rest / active | `--field` / `--sel` | `--muted` / `--text` | — |
| Tab, inactive / active | — | `--muted` / `--text` (400 both), active underline 1px `--text` over the 1px `--hair` baseline | — |
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
| Lifecycle stage, done / current / upcoming | — | `--muted` / `--text` 500 / `--faint`; current glyph per status |
| Task state badge (card) | the tone's `-bg` (`--accent-soft` while running) | the tone's `-ink` |
| Inbox reason and tile | tile: the tone's `-bg` | `--waiting-ink` / `--blocked-ink`; neutral reasons `--muted` |
| Plan step, done / current / pending | — | label `--muted` / `--text` 500 / `--text-soft`; mark `--muted` / `--text` / `--faint` (check / dot / ring) |
| History row | — | title `--text`, source `--text-soft`, time `--muted`; no mark |
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
