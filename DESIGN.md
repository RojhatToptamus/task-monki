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

### 2.3 Surfaces — a strict ladder

| Token | Role |
|---|---|
| `--ground` | window and sidebar rail; the plane everything sits on |
| `--panel` | secondary rail, inspector, list column |
| `--surface` | the content sheet |
| `--field` | inputs, composers, recessed wells |
| `--card` | a raised unit on the sheet |
| `--overlay` | menus, popovers, modals |
| `--well` | code and read-only payload blocks |

Rules: the rail is always `--ground`; the content sheet is always lighter than
the rail (both modes); a raised or selected thing goes **lighter** than what it
sits on, never darker; and in light mode nothing is `#fff` — the lightest value
in the set is `--card`.

### 2.4 Row states

`--hover` on pointer-over, `--sel` for the selected row or active tab, `--press`
while held. Inactive is expressed as **ink** — `--muted` text with no fill —
never as opacity on a full-strength row. Opacity ghosting is reserved for
`:disabled` (0.45).

### 2.5 Ink

`--text` primary · `--text-soft` secondary prose · `--muted` the floor for small
text and metadata · `--faint` inactive labels, counts, placeholders.

Every ink value is **solved per theme** against all nine planes it can land on —
`--ground`, `--panel`, `--surface`, `--card`, `--overlay`, `--well`, `--field`,
`--field-hover`, `--sel` — not merely against the sheet. Measured floors:
`--text` ≥7:1, `--text-soft` and `--muted` ≥4.5:1, every status `-ink` ≥4.5:1,
`--faint` and `--idle` ≥3:1 (they label, they don't carry prose).

Never set small text below `--muted`. Never put prose on a status hue's base
value — that's what the `-ink` variant is for. Re-solve whenever any plane or
either end of the ramp moves; a hand-nudged ink is how a menu becomes unreadable
in one theme only.

### 2.6 Lines, shadows and focus

- `--hair` divides content **inside** a surface. `--edge` marks a real structural
  boundary. Both are alpha over ink, so they stay correct on a warm theme and a
  cool one.
- **Elevation:** `--shadow-card` (light mode only; in dark, cards have no shadow
  at all — the surface step is the depth), `--shadow-panel`, `--shadow-pop` for
  menus and popovers, `--shadow-modal`. Shadow appears only on things that
  genuinely leave the plane.
- **Focus** is the one place a stroke lands on a field: 1px inset `--accent` plus
  a 3px soft ring at 18–22%. Focus is visible on every interactive element, and
  geometry does not shift when it appears.
- The waiting hue is held constant across all themes so "needs you" reads
  identically everywhere. Radii, spacing, motion and layer indices are likewise
  theme-independent.

### 2.7 Accent and status

`--primary` is the highest-contrast neutral (near-black on light, near-white on
dark) and belongs to the single primary action. `--accent` is the interactive hue
— links, focus, selection, one categorical dot. For text, use `--accent-ink`;
raw accent fails as link ink in low-chroma themes.

Status hues are `--working`, `--waiting`, `--blocked`, `--verified`, `--idle`,
each with an `-ink` variant for when the hue sets **text**. Some themes have an
accent equal to a status hue — never put the accent on a status pill.

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
seven seeds per theme and derives everything else, emitting two generated files:
`themes.css` (what the app loads) and `theme-tokens.json` (the same data plus
seeds, floors and measurements, for tooling). **16 themes × 2 modes × 53 tokens**,
every set complete.

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
- Add `--check` to CI. It verifies the committed output is current, every set is
  complete, and every contrast floor holds — the three things review cannot see.

Measured worst case across all 32 sets: `--text` 10.29:1, `--text-soft` 5.75,
`--muted` 4.50, status inks 4.52, `--faint`/`--idle` 3.01, `--id-*` 3.56.

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

| Role | Size / weight |
|---|---|
| Page title | 22–24 / 600 · `-0.02em` |
| Section heading | 15 / 600 |
| Panel title, control label | 13 / 600 |
| Body, prose | 13 / 400 |
| Secondary, helper | 12 / 400 `--text-soft` |
| Metadata, counts | 11.5 / 400 `--muted` |
| Group label | 9.5 / 600 caps · `0.10em` `--faint` |

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

Radii: **6** chips and dots · **8** buttons, rows, small fields · **10–12**
cards, composers, popovers · **14–16** the shell and full-height sheets. Concentric
things step inward by 2–3px; never nest equal radii.

Control heights: **34** decision surface · **30** toolbar · **26** compact and
inline. Never mix two heights in one row. Hit targets never below 28px on
desktop, 44px on touch.

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

**States must not move geometry.** Size, padding, border width and radius are
identical across rest, hover, active, focus and disabled — only fill, ink and
ring change. A disabled control states why, adjacent or in a tooltip.

**Fields.** A filled well (`--field`), no resting border. Hover lifts to
`--field-hover`; focus per §2.6; placeholder is `--faint`. Label above at 13/600,
help text below at 12 `--muted`, error text replaces help text and carries
`--blocked-ink`. Never rely on placeholder as the label.

**Composer — one pattern everywhere** (briefs, messages, follow-ups): context
chips above the text area, run configuration below it, primary action bottom-right,
keyboard hint at 11 `--muted`. The composer is a single `--field` surface — not a
bordered box, not a stack of separately outlined parts.

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
- Contrast: `--text` ≥7:1, `--muted` and any status ink ≥4.5:1 on every plane
  they can land on, ≥3:1 for control edges and focus rings.
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
- [ ] `--muted` and every status ink measured ≥4.5:1 against the actual surface
      behind them, in both modes.
- [ ] No control shifts size or position between rest, hover, focus and active.

**Both modes**
- [ ] Light and dark screenshotted; no mode-specific override was needed.
- [ ] Light mode contains no pure white; dark cards carry no shadow.
- [ ] Sheet reads lighter than the rail; selected rows read lighter than the
      track.

**States**
- [ ] Empty, loading, error, stale, disabled and overflow all rendered once.
- [ ] One status mark per surface; collections use words.
- [ ] Every disabled control explains itself.

**Structure**
- [ ] Spacing values all on the scale; groups laid out with `gap`.
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
- Opacity used to express "inactive" on a row.

**Borders**
- A 1px outline on something that already has its own fill — inputs, selects,
  cards, menu items, composers. This is the single most common regression here.
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
| Card | `--card` | — | `--shadow-card` |
| Card, hover (clickable) | `--field-hover` | — | `--shadow-card` |
| Card internal divider | — | `--hair` | — |
| Settings panel | `--surface` | — | `--shadow-panel` |
| Settings row separator | — | `--hair` | — |
| Popover, dropdown, context menu | `--overlay` | — | `--shadow-pop` |
| Menu item, hover | `--hover` | — | — |
| Menu item, selected | `--sel` | — | — |
| Menu separator | — | `--hair` | — |
| Modal | `--overlay` | — | `--shadow-modal` |
| Modal scrim | `--ground` at 60% | — | — |
| Drawer | `--surface` | `--edge` on the attached edge | `--shadow-pop` |
| Drawer footer | `--surface` | `--hair` above | — |
| Tooltip | `--overlay` | — | `--shadow-pop` |
| Code / payload block | `--well` | — | — |
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
| Destructive button, rest | `--error-bg` | `--blocked-ink` | — |
| Any button, active/pressed | `--press` over its rest fill | unchanged | — |
| Any button, focus | unchanged | unchanged | `--accent` inset 1px + `--field-focus-ring` 3px |
| Any button, disabled | rest fill at 45% | rest ink at 45% | — |
| Input / textarea, rest | `--field` | `--text` | `--field-ring` (optional) |
| Input, hover | `--field-hover` | `--text` | — |
| Input, focus | `--field-focus` | `--text` | `--accent` + `--field-focus-ring` |
| Input, error | `--field` | `--text` | `--blocked` inset 1px |
| Placeholder | — | `--placeholder` | — |
| Composer surface | `--field` | `--text` | as input |
| Composer hint / affordance row | — | `--muted` | — |
| Segmented track | `--field` | — | — |
| Segmented item, inactive | — | `--muted` | — |
| Segmented item, active | `--card` | `--text` (600) | — |
| Select trigger | `--field` | `--text`, chevron `--muted` | as input |
| Checkbox / radio, unchecked | `--field` | — | `--edge` inset 1px |
| Checkbox / radio, checked | `--accent` | `--on-primary` | — |
| Toggle track, off / on | `--edge` / `--accent` | — | — |
| Toggle knob | `--card` | — | `--shadow-card` |
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
| Row, disabled | — | `--faint` |
| Row secondary line | — | `--muted` |
| Row separator | `--hair` | — |
| Table header | — | `--muted` |
| Table header separator | `--hair` | — |
| Zebra striping | never | — |

### A.6 Status, progress and data

A status pill is a `-bg` fill with the matching `-ink` text. A status dot or bar
uses the base hue. Never the reverse.

| Element | Fill | Ink |
|---|---|---|
| Working pill / dot | `--ctx-bg` / `--working` | `--working-ink` |
| Waiting pill / dot | `--amber-bg` / `--waiting` | `--waiting-ink` |
| Blocked, error pill / dot | `--error-bg` / `--blocked` | `--blocked-ink` |
| Verified, merged pill / dot | `--verified` at 12% / `--verified` | `--verified-ink` |
| Idle, draft pill / dot | `--field` / `--idle` | `--muted` |
| Neutral count badge | `--field` | `--muted` |
| Progress track / fill | `--field` / `--accent` | — |
| Progress step, done / active / pending | `--verified` / `--accent` / `--idle` | `--muted` label |
| Stale ribbon | `--amber-bg` | `--waiting-ink` |
| Skeleton / loading placeholder | `--field` | — |
| Diff added / removed | `--verified` at 10% / `--blocked` at 10% | `--verified-ink` / `--blocked-ink` |
| Accent-tinted surface (selected filter, active pill, `@`-mention chip) | `--accent-soft` | `--accent-ink` |
| Categorical dot / bar (repo, agent, saved view) | `--id-1` … `--id-6` (§2.8) | label stays `--text` / `--muted` |
| Avatar fallback | `--field` | `--muted` |
| Focus ring, anywhere | — | `--accent` + `--field-focus-ring` |

`--id-*` are derived from the `skill` seed by the rotation in §2.8, carry no
semantics, and are never used for text — never reuse a status hue for a category,
or an `--id-*` for a state.

---

## Appendix B — where things live

- **`tools/build-themes.mjs`** — the seven seeds per theme and the whole
  derivation. The only file where theme colour is authored.
- **`themes.css`** — generated; what the app loads. 16 themes as
  `[data-theme][data-mode]` blocks, plus `--font-*` and `--r-*`.
- **`theme-tokens.json`** — generated; same data plus seeds, contrast floors and
  measurements, for tooling.
- **Appendix A** — the binding element → token map. First place to look when
  building anything.
- Visual reference: the theme direction board and theme picker in this project.
  The picker is the reference integration — it sets `data-theme`/`data-mode` on
  `<html>` and computes no colour of its own.
