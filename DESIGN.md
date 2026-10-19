# Task Monki: interface guide

The contract for anyone building UI here, human or agent. Follow §1 for every
change, check the result against §14 and §15, and look values up in the quick
reference, §7 to §12 and Appendix A. Appendix B records what was decided for
specific screens; the rules above it still apply there. Theme authoring lives in
`docs/design/THEMES.md`.

**The test of this document:** a control added by someone who has never seen the
app is indistinguishable from one that shipped a year ago, in size, words and
place.

## Quick reference

Every value here is a token; the cited section owns the details.

| Need | Value |
|---|---|
| Faces | Instrument Sans (`--font-ui`) for the interface; Geist Mono (`--font-mono`) only for strings the user copies: paths, hashes, branches, commands, payloads (§8) |
| Type | 22 page title, 15 heading, 13 body and labels, 12 help and group labels, 11.5 metadata (`--t-*`); weights 400 and 500 only (`--w-*`) |
| Line boxes | 16, 18, 20 and 28 (`--lh-*`); the 1.55 factor only for multi-line prose |
| Heights | 32 decision controls, 28 toolbar controls and icon buttons, 24 controls inside a row, 28 dense rows, 36 rows and file heads, 40 a toolbar under a head, 48 heads and two-line rows (`--h-*`, §3) |
| Radii | 4 marks and keys, 6 rows and badges, 8 controls and anything shorter than 40px, 10 menus, 12 cards, sheets and tables, 14 modals (`--r-*`, §9) |
| Spacing | 2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 48 (§9) |
| Colour | roles, never values (§7): planes `--ground`, `--panel`, `--surface`, `--well`, `--field`, `--sel`, `--card`, `--overlay`; ink `--text`, `--text-soft`, `--muted`, `--faint`; lines `--hair`, `--field-edge`, `--edge-raised`, `--edge`; `--accent` for action, focus and running work; `--waiting`, `--blocked`, `--verified`, `--idle`, each with `-ink` and `-bg` |
| Buttons | primary (one per surface), secondary, ghost, danger; 32 tall, or 28 with `button--sm`; icon buttons 28, or 24 inside a row (§10) |
| Icons | Lucide at 13, 16 or 18, 12 only inside a 16px mark; `AgentMark` for every agent (§8) |
| Motion | 120ms feedback, 180ms menus, 220ms modals, 280ms drawers, 200ms something moving; every floating layer leaves over 120ms; ease out; nothing animates when a tab opens; keyboard actions are instant (§12) |
| Pending | a control shows pending only after its action has run 300ms (`--pending-delay`, §6.1) |
| Forms | label, control and help 8 apart; fields 16 apart (§9) |
| Cursor | the arrow, everywhere |

---

## 0. Source precedence

When two sources disagree, the higher one wins. Never average them.

1. **This document and the token layer** decide *how*: size, type, weight,
   colour, radius, spacing, motion, and which shared component.
2. **The shipped app** decides anything the document leaves open: match the
   closest shipped surface of the same archetype (§11.1), at its measurements.
3. **A mock, a spec or a reference app** decides *what* is shown and *where*. It
   never decides size, weight, colour or spacing. A header drawn at 40px is built
   at the system's 36px; a reference's purple is this theme's accent.
4. **Your judgement**, last, inside the gate in §16.

If the shipped app contradicts this document, follow the document and flag the
divergence. Never add a pattern whose only justification is that it looked good
in isolation.

---

## 1. How to design a change

Run these steps in order for every UI change, from a new screen to a moved
button. Write the answers to steps 1, 3 and 4 in the plan or the PR. A change
that cannot answer them is not ready to build.

1. **Name the moment.** Which lifecycle stage is the user in
   (`docs/PRODUCT_WORKFLOW.md`, "UI priority"), what must they know, and what is
   their next step? One sentence each.
2. **Find the shipped pattern.** Open the running app and find the closest
   surface of the same archetype (§11.1) and its entry in Appendix B. Reuse its
   component and its measurements (§10 lists the shared components).
3. **List every element and its job.** For each one: what the user learns or does
   with it, and why it sits where it does. Delete any element whose job another
   element already does: a label beside an icon that says the same thing, a
   status the badge already states, a sentence that restates the buttons.
4. **Place it** by §4: on the thing it changes, in space that thing already has.
5. **Size it** by §3: the container decides the control, the icon and the type.
   Nothing is larger than its neighbours.
6. **Write the fewest words** by §5. Then remove one more.
7. **Define every state** by §6: rest, hover, press, keyboard focus, disabled and
   why, pending, empty, error, stale, and the longest real content. Decide what is
   hidden and what is disabled.
8. **Define motion** by §12. The default is none.
9. **Pass the quality gate** (§15) in the running app, on real data, in both
   modes, at the minimum window. Then hand it to an independent reviewer.

**Study references first.** Before designing a surface, look at how the best
professional desktop tools handle the same moment: a diff, a composer, a list, a
settings row. Take the idea: what is shown, what is left out, where the action
lives. Never take the measurements, colours or type; build the idea from this
system's tokens and components. Say in the PR what idea you took. Repository
docs, comments, agent guides and skills never name another company or its
products as a reference; describe the quality instead.

---

## 2. Principles

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
   full-width centred columns, no bouncy easing. The reference points are the
   best professional desktop tools and the operating system's own apps.
9. **Facts, not instructions.** A title states what is true; a button says what
   it does. A sentence earns its place only when it changes the decision in front
   of the user (§5).
10. **App scale.** The app is dense and slim: 28px controls, 36px rows, 12 and
    13px type at two light weights. Nothing is larger, heavier or louder than its
    neighbours (§3).
11. **Coherence over local polish.** A change looks like it shipped with the app.
    A variant that looks better on its own and different from its neighbours is a
    defect (§0).

---

## 3. Scale

Task Monki is a dense desktop app: 28px controls, 24px inside rows, 36px rows,
12 and 13px type at two light weights. A component is sized by the container it
sits in, never by how it looks alone. A mock that is larger than the shipped
surface beside it is built at this table, not at the mock.

| Container | Height | Controls inside | Icon | Text |
|---|---|---|---|---|
| Page head | title line `--lh-title` | `--h-control` buttons, `--h-icon` icon buttons | 16 | 22/500 title |
| Workspace, panel or side panel head | `--h-head` 48 | `--h-toolbar` 28 | 16 | 15/500 |
| Toolbar under a head (the Review bar) | `--h-bar` 40 | 28; a segmented track holds 24px segments | 16 | 13; meta 12 |
| Content row, table head, file head | `--h-row` 36 | `--h-compact` 24 | 13 | 12 to 13 |
| Dense row: rail, index, menu, diff gap | `--h-row-dense` 28 | 24 at most, usually none | 13 | 12 to 13 |
| Two-line row, table row | `--h-row-tall` 48 | 28 | 16 | 13 with 11.5 meta |
| Code line | `--lh-body` 20 | the 16px comment "+" in the gutter | 12 in the 16px mark | mono 12 |
| Decision surface: form, modal, Now panel, Review foot | | `--h-control` 32 | 16 | 13/500 labels |

- **Under 40px, controls are compact.** Anything inside a row shorter than 40px
  is `--h-compact` with a 13px icon. A 28px icon button inside a 36px row is the
  most common scale defect.
- **One height per row.** Never mix two control heights on one line.
- **A disclosure is its row.** A file or section toggle is the 13px chevron and
  its label at the row's own height, never a separate large button.
- **Type is 13 for what is read, 12 for what is scanned, 11.5 for metadata.**
  Nothing in a dense surface is larger than 13 except a page title or a section
  heading. Weight is 400; 500 marks titles, labels and the one emphasised word in
  a row.
- **Heights are tokens.** `height: 36px` is the same error as a hex colour; use
  `--h-row`.
- **Check against the neighbour.** At 100% zoom, beside the closest shipped
  element, a new one must not read bigger, heavier or louder.

| Don't | Do |
|---|---|
| A 40px Review file head with a 28px chevron button and a 28px ⋯ | A 36px head, a 24px toggle and ⋯, a 13px chevron, a 12px path |
| A 22px comment column between the line number and the code | The 16px "+" inside the line-number cell, shown on the hovered row |
| A Review header in a 44px band below the window's top bar | The title in the top bar; the 40px Review bar directly under the tabs |
| A spec mock's 15px brief text and 32px buttons inside a dense tab | The tab's 13px text and 24px controls; the mock decides only what and where |

---

## 4. Placement

Where a thing goes follows from what it acts on and who owns the fact.

| Thing | Goes | Never |
|---|---|---|
| The page's title | the page head; on a task's working tabs (Agent, Review, Preview), and on a reading page scrolled past its head, the window's top bar | a second bar inside the page that repeats it |
| The surface's one primary action | where the eye ends: the right end of the Now panel, a modal, the Review foot | among secondary actions in a toolbar |
| An action on one item | on the item: its row's hover slot, its head, its ⋯ menu | in a page toolbar away from the item |
| An action on a line of code | in the line-number gutter | in a new column that pushes the code right |
| A link to another tab | the right end of its section's header | inside body text |
| A state | once, in its owner: the badge on a card, the reason line in the Inbox, the Now panel title on a task page, the toolbar headline on the Review tab | as chip, headline and section label together |
| A count | beside what it counts: a segment, a heading, a summary button | on a page tab; as a number over a rail icon |
| A disabled action's reason | beside the actions, once, tied by `aria-describedby` | under every disabled button; in a tooltip alone |
| Overrides and rare actions | last, under More | before the primary |
| A destructive action | last in its menu after a `--hair`; in a confirm, Cancel comes first | a filled red block beside the primary |
| Scope and view controls | the toolbar: scope on the left, view on the right | inside the content |

- **Use the space the element already has** before adding any: a gutter, a
  head, a hover slot reserved at rest, a menu. A new bar, column or row is the
  last option. A bar that repeats the window's top bar is never an option.
- **Near what it changes.** An action whose effect is out of view is in the
  wrong place.
- **The title moves with its row, and nothing it carried is dropped.** Wherever
  a page's title sits in the window's top bar, its row comes with it: the task
  menu, the head's steps the tab does not offer itself (Run agent review on
  imported work, Move to review), and Go to request where the tab does not show
  the request. A fact the tab's own surface states stays there: the Review bar
  carries the agent's request, a stopped run and Run review, so the title row
  does not repeat them.
- **The same thing sits in the same place on every surface.** Actions at the
  right, declining before accepting, the primary last, cancelling the whole
  request apart at the left.

---

## 5. Words

Copy is held to the same budget as colour. The best label is no label.

**Words or none.** Before writing any text, ask in order:

1. Does an icon, a state, a position or the control's own label already say it?
   Then write nothing. An icon-only control is named by its tooltip.
2. Does it change what the user does next, or prevent a likely mistake? If not,
   write nothing.
3. Is it a fact about this subject right now? Then write one short fact, never an
   instruction about how to use the interface.

**Rules**

- A title states what is true ("Ready for review", "The agent wants to run a
  command", with the runtime's name from data in place of "The agent"); a button says what it does, as a verb and an object: "Request
  changes", "Delete branch", never "Submit" or a bare "OK". Sentence case, no
  closing period, no ellipsis on a resting label, and a gerund only as a state
  ("Saving…"). Labels don't change on hover.
- One fact per line. Never join two facts with a middle dot, a bullet or a dash;
  separate them with space, a column or ink.
- No em-dash in interface copy, and no "state, do this" or "do X, or Y"
  headlines.
- A state has one name, the one the status function returns, on every surface.
  It is said once per surface.
- An empty surface shows nothing, or one noun phrase stating the fact: "No file
  changes", "No findings". It never says what the surface is for or how to fill
  it. If one action resolves it, the action stands alone. No illustration, no
  second button.
- An empty side panel shows its composer; the placeholder names what to ask.
- A disabled reason names the missing precondition in a few words: "1 of 2
  answered", "Write a message first". When the reason is that there is nothing to
  act on, hide or replace the action instead (§6).
- A composer shows at most the reason sending is blocked. No hints that explain
  a control ("Paste or drop files", "Read-only" and "Task prompt" are not hints).
  Placeholders end without an ellipsis.
- Name roles, not vendors, in copy Task Monki writes: "the agent", "the
  reviewer", or the runtime's name read from data. Never a runtime's name
  written into the copy itself.
- Numbers are digits in tabular figures: "2/7", "1 fix, 2 comments".
- Never "Click", "Please", "successfully", "Note:", "Tip:", an exclamation
  mark, an emoji, or a marketing word.
- Provider text is quoted and attributed, never set as Task Monki's own.

**Real cases**

| Don't | Do | Why |
|---|---|---|
| "Viewed" beside a file's checkbox | the checkbox alone; tooltip "Viewed (V)" | the checkbox's state is the fact |
| "In the request · blocks finishing" under a finding | nothing; the foot's summary counts what goes out | restates a known rule, with a middle dot |
| "Nothing to send" beside a disabled Request changes | the foot shows the finishing step instead | disables a button to explain an absence |
| "Starts a follow-up…" under Request changes | nothing | the verb already says it |
| Composer hint "Paste or drop files" | the paperclip with its tooltip | explains a control |
| A side panel's empty state "Answers read the task without interrupting it." | the composer, placeholder "Ask about the work" | an instruction where a placeholder works |
| "Ready for review" headline, a "Review" chip, a "Review" section label | the Now panel title alone; the track names the stage | one state, three carriers |
| "Review ready, request changes or finish" | "Ready for review" and the two buttons | a state-plus-instruction headline |
| `main · a1b2c3d4` | `main` then `a1b2c3d4` in mono `--muted`, 8px apart | one fact per span; no separator glyph |
| Tooltip "Inbox · 20 waiting" | "Inbox, 20 waiting" | no middle dots, anywhere |
| A finished answer's footer "Completed" | its time, and a duration when the work took one | the absence of an error already says it |
| "Checks failed" badge beside "checks failing" | the badge alone | the same fact twice |

---

## 6. States and behaviour

### 6.1 Show, disable or hide

- **Hide** an action the user cannot take in this state and would not look for:
  Request changes when nothing is queued. Show what the moment needs instead,
  such as the finishing step.
- **Disable** an action the user expects here but cannot take yet, and state the
  precondition once beside the actions: Submit on a two-question request with
  one answer reads "1 of 2 answered".
- **A control that looks enabled succeeds.** Check preconditions before the
  click, not after. If a run cannot start, Start is disabled with its reason; it
  never fails into a toast.
- A pending control shows pending on itself and stays disabled until it
  resolves. It shows pending only once the action has run for
  `--pending-delay` (300ms), so an action that ends almost at once changes
  nothing on screen: until then the control, and every control the action
  holds, keeps its look, while the disabled attribute already refuses a second
  press. The label is a `PendingLabel` ("Save", then "Saving…" in the same
  width); mark the control, or the surface whose controls the action holds,
  with `data-pending`. Assistive technology hears the pending label at once.

### 6.2 Defaults are never empty

A default view, scope, tab or filter is chosen from the data so that it shows
something. "Since the review" leads only when something changed since the
review; a scope with no files is not offered. An empty section is not rendered.

### 6.3 Nothing shifts

- Variable text never moves a fixed edge. Give it its own track
  (`grid-template-columns: auto minmax(0, 1fr) auto`) or place it after the fixed
  controls, so a neighbour appearing or growing moves nothing else.
- Counts, times and line numbers use tabular figures and a minimum width for
  their largest real value (`min-width: 3ch` for three digits).
- A label that changes ("Stop" to "Stopping…") keeps the control's width: stack
  both labels in one grid cell and show one.
- Actions revealed on hover hold their space at rest (`opacity`, never
  `display`).
- Loading reserves the loaded size. Content arriving above the reading position
  does not move what the user is reading.

### 6.4 One truth

Every surface reads a state from the same selector. A component never computes
a state on its own. When two surfaces disagree, fix the selector, not the copy.

### 6.5 Interaction behaviour

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
- **One primary action per surface.**

### 6.6 Status and progress

- **In a collection, state is a word, never a bare mark.** A column of coloured
  dots is unreadable; words are scannable. On task cards the word is a badge in
  the card's top-right corner; in the Inbox it is the reason line beside the
  tile; elsewhere it is ink. Nothing in a badge or a status word moves.
- **Activity is shown, not spun.** No spinner anywhere. Work in flight is a
  still half-filled circle (`StatusGlyph` "working") wherever its state sits —
  the lifecycle track, a status word, a run header. Motion is kept for the one
  line of live text on a surface — a conversation's working line, the running
  step when it is the latest thing said, "Reviewing" — which takes a slow text
  shimmer (`.tm-shimmer`, 2.4s) beside a ticking elapsed time. That time, and
  a finished turn's "Worked for", counts the work alone: while a question or an
  approval waits on the person, it does not count. The shimmer
  clears the glyphs with the text fill colour, so a label's own ink or a hover
  never paints over it; reduced motion leaves the words still in that ink.
  Loading copy ("Loading conversation…") is a still, muted line: loading is not
  live work. A pending button keeps its own icon and is disabled;
  its label changes only when it has one ("Checking…"), and only after the
  pending delay (§6.1).
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
- **Derive progress from observed state.** Never invent steps, percentages or
  reasoning, and keep activity beside the work it describes.
- **Stale is one ribbon**, with the same wording wherever it appears: the evidence
  shown no longer matches the current diff, and here is the one action that
  refreshes it. A ribbon or a state word — never both.
- **Each status or error once.** A failed Design update is stated by its turn;
  the canvas repeats the reason only while the conversation is hidden, and no
  footer repeats the header's status. Raw diagnostics sit behind a disclosure.

---

## 7. Colour and tokens

### 7.1 The rule

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

Theme colour is authored only in `tools/build-themes.mjs`, from seven seeds per
theme and mode, and derived from them; how, and the floors it is held to, are in
`docs/design/THEMES.md`. Never hand-pick a value for one theme and never edit the
generated `themes.css` or `theme-tokens.json`.

### 7.2 Surfaces, a strict ladder

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

If a container needs a line to be legible against its host, the wrong plane was
chosen. Add the line only after the plane has failed.

### 7.3 States

Ranked by weight: **selected > keyboard focus > pointer focus > active > hover.**
No state changes size, border width or position, and no state may exceed the
resting separation of the thing it is applied to.

| State | Treatment |
|---|---|
| hover | One small fill step in the direction the element already sits — `--hover` on a transparent row, `--field-hover` on a control, `--card-hover` on a card. Never on a multi-line text surface (a single-line field lifts to `--field-hover`); never a shadow change; never another role's token. |
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

### 7.4 Ink

`--text` primary · `--text-soft` secondary prose · `--muted` the floor for small
text, metadata and placeholders · `--faint` labels that are never read as
sentences · `--text-disabled` the ink of a disabled control.

`--placeholder` is `--muted`: placeholder text is prose read before typing.
Never set small text below `--muted`, and never put prose on a status hue's base
value; that is what its `-ink` variant is for. Every ink is solved per theme
against every plane it can land on (`docs/design/THEMES.md`); never nudge one by
hand.

### 7.5 Lines, shadows and focus

- **Five line weights, one job each.** Every line in the app is one of these,
  and which one you need follows from what the thing *is*:

  | Weight | Belongs to | Examples |
  |---|---|---|
  | `--hair` | an **interior divider** — content continuing on the same plane | rows in a list, a footer inside a card, a settings separator |
  | `--field-edge` | the **resting boundary of a filled control** | input, textarea, composer, select trigger, segmented track, secondary button |
  | `--field-edge-focus` | the same rim while the control **holds focus** — one notch darker/lighter, same hue-free ink | focused input, textarea, composer |
  | `--edge-raised` | the boundary of an **object** resting on its plane | card, panel, response, decision block |
  | `--edge` | a **floating** layer's boundary, and a drawer's edge | drawer edge, menu, popover, modal, tooltip |

  Two structural planes meet on a `--hair` seam (the rail and a sheet, a sheet
  and a docked side panel); `--edge` is only for what floats or slides over.

  `--control-edge` is separate from these five: an opaque 3:1 line for a control
  with no fill at all to be identified by (an unchecked checkbox, a radio, a
  toggle track in the off position).

- **A filled control carries exactly one line: `--field-edge`.** The fill step is
  what says *recessed*; the rim is what says *where*. It is an inset 1px
  box-shadow, never a border, so no geometry moves between rest, hover and focus.
  Focus does not add a second line and does not recolour this one — it swaps the
  same rim to `--field-edge-focus`, one notch up in the identical neutral ink.
  Do not put two lines on one control or draw a line **instead of** the fill step.
  An object — something with a boundary that sits above its plane and could
  conceptually be picked up — gets `--edge-raised` instead.
- **Where the plane changes, no divider.** The fill already said it. Two lines
  within 14px of each other means one of them is wrong. A hairline over the sheet
  is a larger local step than the card step above it, so an interior line is the
  more expensive tool, not the cheaper one — reach for the plane first, and let
  the object's own edge do the boundary work.
- **Elevation:** `--shadow-card` for things resting on the sheet,
  `--shadow-panel`, then `--shadow-pop` for
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
     plane (§13); an accent seed that cannot carry it fails the build.

  The halo is a token, `--focus-halo`, and it **adds** to a control's resting
  rim: a control that rests on a rim (a secondary button, the selected segment)
  writes `box-shadow: <its rim>, var(--focus-halo)`, so focus never erases the
  edge. A row inside a scrolling or clipped list, where an outside halo would be
  cut, takes `--focus-halo-inset` (2px, inward). Finding threads and comments
  keep their 1px `--focus-ring` rim. One mechanism: the input modality on the
  document root, which the shared focus and disabled rules key on, so a dialog
  or drawer portaled outside `.app-shell` looks like the page beneath it; never
  a workspace-wide copy. A menu draws its own edge and shadow and takes no halo.

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

### 7.6 Accent and status

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

### 7.7 Categorical hues (`--id-1` to `--id-6`)

Categorical hues identify a thing (a repo, an agent, a saved view). They carry no
state, and they are derived from the theme's `skill` seed
(`docs/design/THEMES.md`).

**These are graphic-only tokens.** They clear 3:1 against every plane they can
land on (measured floor 3.56:1) — enough for a dot, bar, or 2px marker, not for
text. A category label is `--text` or `--muted` next to its dot, never the id hue
itself. Assign by stable hash of the entity id so a repo keeps its colour, and
never reuse a status hue for a category or an `--id-*` for a state. Where an
existing product control persists an explicit category slot, as saved-view
markers do, map its six slots directly to `--id-1` … `--id-6`; do not reinterpret
the legacy slot names as semantic colour or status names.

### 7.8 Necessary distinction vs. noise

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

## 8. Type and icons

### 8.1 Families

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

### 8.2 Scale

Interface type is one sans; machine values are one mono. No third family.

| Role | Token | Size / weight |
|---|---|---|
| Page title | `--t-title` | 22 / 500 · `-0.02em` |
| Section heading | `--t-heading` | 15 / 500 |
| Panel title, control label | `--t-label` | 13 / 500 |
| Body, prose | `--t-body` | 13 / 400 — the body's own size, so text with no size of its own is 13, never the browser's 16 |
| Secondary, helper | `--t-help` | 12 / 400 `--muted` |
| Metadata, counts | `--t-meta` | 11.5 / 400 `--muted` |
| Group and section label | `--t-group` | 12 / 500 `--muted` |

Line boxes are whole pixels in single-line controls, rows, headings and code:
`--lh-meta` 16, `--lh-ui` 18, `--lh-body` 20 (13px text in a control or row, a
15px heading, and 12px code, so a diff row is exactly 20), and `--lh-title` 28
for a page title. Only multi-line
reading text uses the `--lh-prose` factor (1.55). A single-line control's height
comes from its height token, never from a line-height times a size plus padding.
The regular weight is `--w-regular` (400), never a literal.

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

Never centre a paragraph. `text-wrap: pretty` on prose. Truncate with ellipsis
and keep the full value in `title`; never wrap a machine value mid-token.

### 8.3 Icons

**One set, outline only.** Never mix an outline set with a filled one, and never
substitute an emoji, a glyph from the mono font, or a hand-drawn SVG for a missing
icon — use the nearest icon in the set or a word.

Sizes **13 / 16 / 18**, 12 only for a glyph inside a 16px mark, matched to the row they sit in (13 in compact rows, 16
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
rather than aligning boxes. An icon sits 6px from its label inside a button,
chip or trigger, and 8px from a block of text in a row or a disclosure label.

A glyph inside a 16px mark (a checkbox's check, the diff's comment "+") is 12px,
so it lands on whole pixels; a mark always sits in a hit area of at least 24px,
its label's or a 24px wrapper's.

---

## 9. Spacing, radii and geometry

Use the shared spacing and geometry defaults below. Align related headings,
content, fields, and actions to common edges. Keep spacing within a group smaller
than spacing between groups. Give containers consistent internal padding,
including expanded and error states. Place actions beside the content they affect
or in its established footer. Add a container only when it communicates a
meaningful grouping or boundary.

Spacing comes from one scale: **2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 48**.
10 is for compact controls only: `button--sm`, composer toolbar buttons and
textarea padding. A value off
it is drift, with two exceptions: one pixel less beside a 1px border or ring,
which keeps the visual distance on the scale, and a value derived for alignment
(an indent equal to a 13px icon plus its 8px gap, say), commented where it is set.

| Thing | Padding / gap |
|---|---|
| Card | 12 pad, 6–8 internal gap |
| Panel / settings block | 16 pad, 16 row rhythm |
| Form (Settings, New task, dialogs) | a field is its label, its control and its help or error, 8 apart (`.field`); fields 16 apart; a notice is one more row, 16 below; groups 24 apart |
| List row | 8 horizontal |
| Sheet | 16 pad |
| Between cards | 12 |
| Section separation | 24–32 |

A field's label is its control's label: 13/500 `--text`, a fieldset's legend
included. Help sits under the control, outside the label element, so it never
becomes part of the control's name; tie it with `aria-describedby`.

Radii are tokens, not literals, and each step has one job:

| Token | Radius | Used for |
|---|---|---|
| `--r-2xs` | 4 | keyboard keys, checkboxes, tiny inline marks such as the diff's comment "+" |
| `--r-xs` | 6 | badges, menu items, list and index rows |
| `--r-sm` | 8 | buttons, fields, icon buttons, rail items; review files and everything in the diff |
| `--r` | 10 | menus and anchored popovers, the Review request sheet included |
| `--r-md` | 12 | sheets, side panels, cards, composers, tables, a floating side sheet |
| `--r-lg` | 14 | modals |
| `--r-pill` | 999 | counts, dots and radios |

Floating surfaces: a tooltip is `--r-xs`, a toast `--r-sm`, a menu or popover
`--r`, a modal `--r-lg`.

Concentric things step inward; never nest equal radii. A corner follows the
smallest height its element can take: anything that can be shorter than 40px, such
as a review file collapsed to its head, takes `--r-sm` or less, because a 12px
corner on a row that short reads as a pill.

Nested corners follow a formula: the inner radius is the outer radius minus the
inset (and minus a border), rounded down to a token and never below `--r-2xs`;
when the inset is as large as the outer radius, the inner element takes its own
role's token. So a 28px icon button is `--r-sm`, a 24px one `--r-xs`, and a
segment in its track `--r-xs`. A full-bleed child (a row, a head, a band) has no
radius of its own: the container's clip rounds it.

**Sticky heads in rounded containers** are square, paint the host plane, own
only a bottom `--hair`, and take their corners from the container's clip at
rest. Their `top` is the negative of the scroller's top padding, so they pin
flush to the scrollport and never show content above or beside their corners.

**Edges over painted children.** A container whose children paint to its edges
(tinted diff rows, a sticky head, hovered table rows) draws its edge above them:
a 1px border with `overflow: clip`, or the ring on `::after` as `tm-table` does.
Never an inset ring its children cover, and never a second ring on a child to
redraw the container's edge; a child marks a division with a `--hair` seam.

Heights are tokens too: `--h-control` 32 on a decision surface, `--h-toolbar`
28 for toolbar and compact buttons, `--h-icon` 28 for an icon button,
`--h-compact` 24 inside a row; `--h-row-dense` 28, `--h-row` 36 and
`--h-row-tall` 48 for rows; `--h-bar` 40 for a toolbar under a head; `--h-head`
48 for a head (§3). Never mix two heights in one row. Hit targets never
below 24px on desktop, 44px on touch.

Writing `border-radius: 9px` or `height: 36px` is the same class of error as
writing a hex colour: it is a value the system already has an answer for.

### 9.1 Fixed geometry

These are settled. Use the value, don't re-derive it.

| | |
|---|---|
| Titlebar | 44 tall (`TITLEBAR_HEIGHT`), shares the ground with the rail |
| Rail | 56 wide, icon-only, permanent; 36px items |
| Content sheet | inset 8px from the window's right and bottom edges, `--r-md` |
| Secondary list column | 268 default, resizable 220–360 |
| Workspace / panel head | exactly 48 (`height: var(--h-head)`), no vertical padding, its hairline an inset `--hair` shadow in its last row, so its 28px controls sit on whole pixels and every head's hairline meets its neighbour's |
| Toolbar under a head | exactly 40 (the Review bar), built the same way; a segmented track in a head or toolbar is `.segmented--compact`, 28 with 24px segments |
| Page gutter | 24 at minimum width · 32 wide |
| Reading column (settings, prose) | 880 max; tables and lists go full width |
| Row | 28 in rails, indexes and menus · 36 in content lists and table heads · 48 two-line and table rows · 60 Inbox items (title, detail and inline approvals) |
| Button | 32 tall with 12 horizontal pad and 64 min width; `button--sm` 28 tall with 10 pad |
| Icon button | 28 square (24 compact, `--h-compact`), 16 glyph (13 compact) |
| Single-line field | 32 tall, 12 horizontal pad, value text 13/400 on `--lh-body` (field-style triggers too; a composer chip is 12/400, the ghost label size) |
| Textarea / composer | 88 min body plus the 42 toolbar, 10–12 pad, text on `--lh-body` |
| Popover / menu | 220–280 wide, 4 pad, rows at least 28 (4×8 padding around a 20 line; a two-line row grows) |
| Pane status footer | 28 tall, 16 side pad |
| Floating control (jump to latest, new responses) | 28 tall, `--r-sm`, `--card` with the `--edge` ring and `--shadow-pop` |
| Modal | 440 confirm · 560 form · 640 creation (880 and the modal's full height when New task is expanded; remembered) · 720 payload |
| Side panel | 380 docked, resizable 320–560; floats over the content below a 560px content floor |
| Settings section list | 212 |
| Review index | 248 (208 below 1100) |

Widths are the design intent, not a hard cap: a panel may be resized by the user,
but it opens at these values and never below the minimum.

---

## 10. Components

Use the shared component for equivalent content and interaction. When it fails
the need, improve it for everyone and remove the variant; never build a local
copy.

**Shared components.**

- Buttons: `primary-button`, `outline-button`, `ghost-button`, `danger-button`,
  `tm-iconbtn`, sized with `button--sm`; icon-only controls wrap in `Tooltip`.
- Menus: `ActionMenu` (`ActionContextMenu` at the pointer). Badges: `Chip`.
  Comparable lists: the `tm-table` container. Modals: `ModalFrame` (the
  `tm-modal` layer and its scrim) around the panel, with
  `useDialogFocusBoundary` on the panel.
- Leaving: every floating layer its owner renders conditionally sits in a
  `Presence`, which keeps it on screen while it leaves (§12); a layer that
  stays mounted and hides takes `useExit`.
- Choices: `.segmented` (`.segmented--fill` in a list column); native selects
  take the shared chevron, so colour them with `background-color`.
- Settings: `SettingsPane` and `SettingsRow` inside `tm-settings__list`.
- Side conversations: `ConversationPanel` in `DockedSidePanel` or
  `FloatingSidePanel`; `SessionTurns` holds their turns.
- Composers: `AttachmentComposerShell` or `ConversationPanel`, with the chips
  (`AgentModelSelector` compact, `AccessMenu`, `AgentProfileSelect`).
- Activity: `StatusGlyph` "working" is still; live text takes `.tm-shimmer`.
  Never a spinner.
- Notices: `.tm-notice` in its container (`data-tone="waiting"` for a
  warning), `.tm-notice--page` on a page, `.tm-notice--band` across a pane.
- Pending labels: `PendingLabel`, with `data-pending` on what the action holds
  (§6.1).
- Agents: `AgentMark`, the only icon for any agent.
- Expand: `ExpandToggle`, at the end of a surface's head and before Close
  (Maximize2/Minimize2, named Expand and Collapse, or what it shows when the
  head's disclosure already owns those words), ⌘⇧F. Escape collapses before it
  closes; the surface keeps its expanded state only where it is an arrangement
  (New task).

**Which container.** Pick by what the content is, and use exactly one:

| Content | Container |
|---|---|
| Items compared against each other | rows in the `tm-table` container |
| The one step the sheet asks for | the Now panel, the sheet's only raised card |
| Reference or record content | an inset group on `--panel`, no ring |
| The story: request, result | a flat section, a quiet label then content |
| Code and raw payloads | a `--well` |
| A warning or error inside a surface | a notice in its tone |
| Something the user wrote | the `--field` plane |
| A unit with mixed content that stands alone | a card |

A list of cards is almost always a list of rows wearing costumes.

**Buttons — four families, no fifth.** Primary (`--primary` fill, `--on-primary`
ink; one per surface), secondary (`--field` fill with the `--field-edge` rim),
ghost (transparent, `--hover` on hover; the compact toolbar family, 28 tall),
destructive (soft tint, never a filled red block). Labels are 13/500 at the
decision height and 12/500 on `button--sm` and ghost (`--t-help`). Primary,
secondary and destructive share the decision geometry so a pair aligns;
`button--sm` puts any of them on the toolbar height. Choose button emphasis by
action priority, not by whether the button contains an icon or a label.
Icon-only buttons (`tm-iconbtn`, 28 square) use a 16px glyph and always carry an
`aria-label` and a `Tooltip`, never a native `title`. Every button settles to
`scale(0.97)` while pressed (§12); a menu trigger does not, because its menu is
already open beside it.

Primary and secondary are **one geometry with different fills** — same height,
same padding, same radius, same minimum width — so a pair aligns to the pixel. A
transparent border on one of them to "reserve space" is not that: it offsets the
label by its own width.

**States must not move geometry.** Size, padding, border width and radius are
identical across rest, hover, active, focus and disabled — only fill, ink and
ring change. A disabled control's reason is stated once beside the actions and
tied with `aria-describedby`; a tooltip alone never reaches the keyboard. When
there is nothing to act on, hide the action instead (§6.1).

**Fields.** A filled well (`--field`) carrying one line, `--field-edge`, as an
inset 1px box-shadow — separated from its host by ≥2.5 L* so the fill still
carries it on both a sheet and a card, with the rim making the boundary
unambiguous where the two planes are close. Single-line controls are
`--h-control` tall with `--r-sm`. Hover lifts to `--field-hover`; focus per §7.5
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
then the reason sending is blocked when it is, then the actions. A chip has no fill or rim
until hovered or open (`.tm-composer-chip`); the same chips outside a composer
sit in a `.tm-chip-row`. No other hint (§5).

**Counts.** One neutral count: 18 tall, `--r-pill`, `--field` with `--muted`
ink, `--t-meta`/500 with tabular figures. A plain-text count in `--faint` is
allowed only beside a heading, a segment's label, or inside a filled button
(where a pill would have no edge against the button's own fill).

**Drop targets.** A surface that takes dropped files shows it while a file is
over it: `--field-focus` fill and a 1px `--accent` line, the composer's
treatment, easing at `--motion-fast`. It is the one place hue marks a control's
boundary for something other than its value, because the drop is about to set
the value.

**Notices.** One inline notice for a warning or an error about a surface or its
action, and one class for it everywhere: `.tm-notice`. `--r-sm`, 8×12
padding, `--t-help` on `--lh-ui`, the blocked tone's `-bg` and `-ink` by
default and the waiting tone's with `data-tone="waiting"`, and an optional
16px glyph that leads it. A title is `.tm-notice__title` on its own line;
actions are `.tm-notice__actions`, ghost buttons in the notice's ink at its
end. Everything inside it, a quoted reason or a caption included, takes the
tone's ink: `--muted` and `--text-soft` are not solved against tints. A
full-bleed notice across a pane, under its bar (Stale, a failed recording
step), is `.tm-notice--band`: square, its words on the pane's inset; on a page
it is `.tm-notice--page`, on the gutter. A surface never styles a notice of its
own; it only places one. A message about one field is not a notice: it is that
field's error or warning text (`.form-error`, `.form-warning`) in place of its
help.

**Wells.** A code or payload block is `--well`, `--r-sm`, mono `--t-meta` on
`--lh-meta` at 400, padded 8×12; inline code is `--r-2xs`. A well that is itself
a working surface (the log surface) is `--r-md`. `--well` holds code and raw
payloads (commands and their output, JSON, protocol messages, logs), never
notices, metrics, prose, or structured records that render as fields.

**Quoting provider text.** An agent's own words, quoted, sit behind a 2px
`--edge-raised` rule with 12px padding, attributed above.

**Cards whose head paints to the edge** (a summary band, a sticky head) draw
the card's edge as a 1px `--edge-raised` border with `overflow: clip`, per
"Edges over painted children"; every other card uses the inset ring.

**Badges.** A state word on a 12–14% tint of its tone (`status-pill`, the
`Chip` component): 20 tall, `--r-xs`, `--t-meta`/500, 8px side padding and a 6px
glyph gap, no border, no dot, and nothing in it moves. One size everywhere. A
neutral label (a source, a kind) is the same shape on `--field` with `--muted`
ink.

**Key and value lists** inside a card or panel (read-only facts) take the table
container's `--edge-raised` ring and `--hair` seams with 36px rows and no hover;
they are not clickable, so nothing lights up.

**Tables and comparable lists.** One container (`tm-table`, and the Inbox list):
the `--edge-raised` ring drawn over the rows, `--r-md`, no fill of its own,
`--hair` dividers, a 36px header in `--muted` `--t-help`, 48px rows that take
`--hover` on hover, row actions in a menu revealed on hover and focus. Settings
lists use the same container; a settings row is never a card.

**Tooltips.** The `Tooltip` component (Radix) on `--overlay` with the `--edge`
ring: 500ms before the first, instant between neighbours, the name and an
optional shortcut, never information the decision needs. It leaves at once, so
a neighbour's tooltip never overlaps it. Focus opens one only
for someone moving by keyboard; after a click, focus a dialog places on its
close button shows nothing. A dialog that is mostly read opens with focus on
what it is read by (its scrolling content, or the switch between its sides),
never on a close button whose tooltip would take the first Escape.

**Segmented vs menu.** Segmented for 2–4 options whose labels fit on one line at
the narrowest width the container reaches; a dropdown for anything longer or
open-ended. A wrapping segmented control is a bug. There is one segmented
control (`.segmented`); a list column's status filter (Designs, Discourse) adds
`.segmented--fill` so its options share the column's width, and one in a head, a
bar or a row adds `.segmented--compact` (24px segments with 12px labels in a 28px
track), so it is as tall as the controls beside it.

**Selects.** A native `<select>` draws the same chevron as the custom pickers —
two 1.5px `--muted` strokes, 10px from the right edge — from one rule in
`base-components.css`. A rule that colours a select sets `background-color`,
never the `background` shorthand, which would erase the chevron.

**Menus and popovers.** `ActionMenu` (Radix): `--card` + `--edge` ring +
`--shadow-pop`, `--r`, 4px pad, 28px rows with `--r-xs` items in `--text`,
group labels per §8. Destructive item last, separated by a `--hair`. Escape
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
`--edge` ring and `--shadow-modal` over the scrim, `--r-lg`, enters with
the modal motion and leaves faster (§12). Its anatomy is a title, at most one paragraph, the
content, and the actions; no icon tile beside the title, because the title
already names the act. A character count appears only near the limit.

**Destructive actions.** Prefer undo over confirm. Confirm only when the action
is unrecoverable, and then name the object in the button ("Delete branch", not
"OK") and put the cancel first.

**Links to another tab** ("Open conversation", "Open review", "View diff",
"Full history") are `tm-osection__link`: accent ink, no fill, at the right of
the header of the section they belong to.

**List rails** (the Designs and Discourse history) share the `.tm-listrail__*`
elements: the heading centred on a 28px New, a 32px search field, the status filter, then
48px rows, 2px apart, on the fields' edges, so every word in the rail starts on the head's
16px line. A row is the title and
one meta line — a status word in its tone, a neutral unread count, the time at
the right. An empty rail is one line.

---

## 11. Layout and shell

### 11.1 Layout archetypes: pick one, don't blend

1. **List + detail** — the default for any collection. Rail, list column, detail
   pane or drawer. The list keeps its own scroll and selection.
2. **Single sheet** — one subject, full remaining width, own header. For a task,
   a run, a document.
3. **Settings** — the sheet holds its own section list (212px, title on top)
   beside an 880 reading column of tables and `--hair`-separated rows (§10).
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
A task page has two kinds of tab. The reading tabs (Overview, Debug) keep the
page head (title, lifecycle track, repository and branch, task menu), which
scrolls with the page while the tab bar stays pinned at the sheet's top. The working tabs (Agent, Review, Preview) have no head:
their title row stands in the window's top bar from the moment the tab opens,
and the tab bar is the sheet's first line, so it sits in the same place on all
three and shares a docked side panel's 48px head line. The lifecycle, repository
and branch belong to the record, on the Overview; each working tab states its
live state where it is acted on.
Page tabs are 13/400 words on the bar's baseline, a 1px `--hair` inset line;
the selected one changes only its ink to `--text` and takes that baseline in
`--text`, 1px with square ends, so it covers the hairline rather than sitting on
it. A tab's weight never changes and a tab never carries a count.

### 11.2 Shell invariants

- **The frame is the ground.** The 44px titlebar (Back, Forward, New task) and the
  56px rail share `--ground` with nothing between them, so they read as one
  L-shaped frame. Every page is one sheet inset 8px from the window's right and
  bottom edges, on `--surface` with `--r-md` corners and a `--hair` seam.
- **The rail is permanent and icon-only:** Inbox, Tasks, Designs, Previews,
  Discourse, then the update control and Settings at the foot. It never
  expands; names are tooltips. Something waiting on the user is a 7px accent
  dot at the icon's corner, ringed in the ground; how many is in the tooltip
  ("Inbox, 20 waiting") and on the page itself, never a number over the icon. Repositories are managed in Settings; New task opens on the
  repository used last.
- **The window's top bar carries a page title only when the page's own title is
  not on screen**: a task's working tabs, or a reading page scrolled past its
  head. The title row is the title at 13/500 `--text` (48vw at most, the full
  title in its tooltip), then the task's ⋯, then Go to request and any step as
  `button--sm` secondary buttons. A workspace whose 48px head never leaves the
  view (Designs, New Design, Discourse) keeps its title there.
- Every boundary between two panels is a resize handle: an 8px hit area on the
  boundary's `--hair` seam that draws a 2px `--edge` line on hover and focus, with a
  keyboard-reachable equivalent. A handle on the edge of a
  sheet that clips its overflow lies inside that edge, or nothing can grab it.
- **One scroll owner per workspace**; its head and composer stay put while it
  scrolls. Menus and popovers escape clipping containers and stay inside the
  window. Switching tabs never moves the shell: no new gutter, seam or header
  shift.
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

### 11.3 Responsive rules

- **Buttons collapse label-last.** Full label → icon plus label → icon only, in
  that order, and never past icon-only for the primary action on a surface. A
  button that has collapsed keeps its tooltip.
- Toolbars overflow into a trailing "more" menu rather than wrapping. The primary
  action never enters the overflow.
- Segmented controls become a dropdown at the width where their labels would
  wrap (§10).
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

## 12. Motion

Small and fast. Motion shows continuity, cause or work in progress, never
decoration. Animate `transform` and `opacity`; fills and ink may transition on
hover. Layout never animates: heights and positions change at once, and only
opacity and transform move. Anything entering or
responding eases out. Something already on screen moving to a new place uses
`--ease-in-out`. Never `ease-in`, `ease` or `linear` (the shimmer is the one
linear loop). Leave faster than you arrive. Keyboard actions, tab switches and
anything done many times an hour are instant. Nothing loops unless work is
actually running. Durations and curves are tokens.

| Element | From | Duration | Easing token |
|---|---|---|---|
| Hover and state feedback, a field's focus rim | — | `--motion-fast` 120ms | `--ease-out` |
| Button press | scale 0.97 | 120ms | `--ease-out` |
| Tooltip | scale 0.97, after 500ms; instant between neighbours; leaves at once | `--motion-fast` 120ms | `--ease-out` |
| Menu, popover, picker | scale 0.96 from its trigger; leaves at 120ms | `--motion-standard` 180ms | `--ease-out` |
| Submenu | opacity only; leaves at once | `--motion-fast` 120ms | `--ease-out` |
| Modal | scale 0.97; the scrim (every scrim) fades over `--motion-standard`; leaves at 120ms, settling to 0.98 as it fades with its scrim | `--motion-modal` 220ms | `--ease-out` |
| Floating side panel, the replay drawer | 8% from its edge; leaves at 120ms, back 4% as it fades | `--motion-slow` 280ms | `--ease-drawer` |
| A list column that is a drawer in a narrow window (Designs, Discourse) | slides in from its edge over its scrim; leaves the same way at 120ms | `--motion-slow` 280ms | `--ease-drawer` |
| Docked side panel | its content fades in; the page makes room at once | `--motion-standard` 180ms | `--ease-out` |
| Title row in the top bar, as a reading tab's head scrolls away | 6px up while it fades in; leaves at 120ms; still when a tab opens | `--motion-standard` 180ms | `--ease-out` |
| Disclosure content | opacity; the height changes at once; not when it mounts open | `--motion-fast` 120ms | `--ease-out` |
| Arrivals: a row that joins an open live list (a recorded step, a replay, an expectation) | opacity, once; the list makes room at once; never on the list's first render, a re-sort or growing text | `--motion-standard` 180ms | `--ease-out` |
| Live text: the one line that says work is running | a highlight crossing the words; still under reduced motion | `--motion-shimmer` 2.4s | linear |
| Jump to latest (stays mounted), New responses | 4px up; leaves at 120ms | `--motion-standard` 180ms | `--ease-out` |
| Toast | 8px up; leaves 4px down at 120ms | `--motion-toast` 240ms | `--ease-out` |
| Something moving on screen | its current position | `--motion-move` (200ms) | `--ease-in-out` |
| Expanding or collapsing a surface (a side panel, New task) | its old box, its children held at their size | `--motion-slow` 280ms | `--ease-drawer` |
| A Review file shown full screen, and back | its place in the list | `--motion-move` 200ms | `--ease-in-out` |

**Leaving.** A layer that closes stays on screen while it leaves (`Presence`,
or `useExit` for one that stays mounted): it is inert at once, its dialog
boundary hands focus back to what opened it as it starts to go, and it unmounts
when its exit ends. Every exit takes `--motion-fast` and `--ease-out`; a menu or
picker opened or closed from the keyboard comes and goes at once. A native view
a layer covered (the recorded page) returns only once the layer has left.

Nothing animates because a tab or page was opened: a surface that is already
there when its tab mounts (a request bar, a disclosure mounted open, the task
head, the title row in the top bar) appears still. A hand-built chevron does
not flip when its menu opens; the open fill says so, as on every `ActionMenu`.

A size change is a FLIP transform (`expandMotion.ts`): the surface takes its new
layout at once, its box is drawn from the old box to the new one, and its
children are counter-scaled and pinned to the corner holding the control. Never
animate width or height.

`--ease-out` is `cubic-bezier(0.23, 1, 0.32, 1)`, `--ease-in-out`
`cubic-bezier(0.77, 0, 0.175, 1)`, `--ease-drawer` `cubic-bezier(0.32, 0.72, 0, 1)`.
Under `prefers-reduced-motion` every transition and animation collapses to an instant change. The
pending delay (§6.1) is not motion and stays, so a quick action flashes nothing there either.

---

## 13. Accessibility

- Visual order, DOM order and tab order agree.
- Focus is always visible (§7.5) and never removed; a modal traps focus and
  returns it to the trigger on close.
- Every icon-only control has an `aria-label`; a tooltip is not a label.
- Colour is never the only carrier of meaning — pair every hue with a word or a
  glyph.
- Contrast floors are solved in the token layer, the same in both modes
  (`docs/design/THEMES.md`): `--text` 7:1; `--muted`, `--placeholder` and status
  ink 4.5:1; `--text-disabled` 3.5:1; control edges, focus rings and `--faint`
  3:1. Using the right token is how a screen meets them.
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

## 14. Details that make it look finished

Check every element you touched against this list.

- [ ] **Centred glyphs.** A fixed-size button centres its icon with
  `display: grid; place-items: center`. The base reset already removes browser
  padding; never add it back. The icon's centre is within 0.5px of the button's,
  and its size lands on whole pixels (a 12px glyph in a 16px mark, 16 in 28, 13
  in 24).
- [ ] **Radius follows height.** A 16px mark takes `--r-2xs`; 20 to 24px takes
  `--r-xs`; 28 to 36px takes `--r-sm`; a container 40px or taller that never
  collapses takes `--r-md`. A collapsible thing takes the radius of its collapsed
  height. Nested: the outer radius minus the inset (§9).
- [ ] **One edge per boundary.** A container draws its edge and children never
  redraw it. When children paint to the edge, the edge is a `border` with
  `overflow: clip`, or a ring on `::after`. Two lines within 14px means one is
  wrong.
- [ ] **Whole-pixel line boxes.** Single-line text sits on `--lh-meta`,
  `--lh-ui` or `--lh-body`. A control's height comes from its height token with
  `align-items: center`, never from padding plus line-height.
- [ ] **Nothing inherited by accident.** No 16px text, no browser bold, no
  generic monospace, no native button padding, no native select arrow, no blue
  link, no browser focus outline.
- [ ] **Mono only for strings the user copies**: paths, hashes, branches,
  commands, payloads. Never durations, counts, status words or prose.
- [ ] **Tabular figures** on every count, time, line number and value that
  updates.
- [ ] **Every state drawn.** Hover is one fill step; press is `--press`, or scale
  0.97 on a button; keyboard focus adds the halo to the resting rim; disabled is
  a fill and an ink. A pointer click on a button shows nothing.
- [ ] **Truncation.** One line, an ellipsis, the full value in a tooltip; a
  machine value never wraps mid-token.
- [ ] **Alignment.** Text in adjacent rows starts on one column; an icon sits
  6px from a button's label and 8px from row text, optically centred.
- [ ] **No content shift** when hovering, toggling, loading or counting (§6.3).
- [ ] **Empty, loading, error, stale and longest-content states** rendered and
  looked at, not assumed.
- [ ] **Both modes.** Nothing relies only on a shadow, which is invisible in
  dark, or only on a fill step, which is weak in light.

---

## 15. Quality gate

A UI change is done when every line below is true and the PR says how each one
was checked.

1. **Real app, real data.** Run the desktop app from this branch with a fresh
   profile (`--user-data-dir=<scratch dir>`, never the installed app's profile)
   on a disposable testing repository, with real tasks and real agent runs. Use
   the dev seed only for a state a real run cannot reach, and name it.
2. **Every state you touched, reached for real**: rest, hover, press, keyboard
   focus, disabled with its reason, pending, empty, error, stale, and the longest
   real content (a 120-character title, a four-digit count, 500 rows).
3. **Both modes**, in Graphite and in one warm theme.
4. **Two windows**: the minimum, 1100 × 720, and a wide one, each with and
   without a docked side panel.
5. **At 100% zoom, beside the closest shipped surface.** If the new one reads
   bigger, heavier, busier or wordier, fix it.
6. **Measured.** Read the computed height, font size, family, weight,
   line-height, radius and icon box of each new element and compare them with
   §3 and §9. Run `tools/design-audit.js` on the screen (see its header) and
   clear what it lists.
7. **Keyboard.** Tab order follows the visual order; the halo appears only from
   the keyboard; Escape closes the topmost layer; every action works without a
   mouse.
8. **Motion.** Tab switches and keyboard actions are instant, nothing animates
   on mount, and reduced motion makes every change instant.
9. **Words.** Read every string you added and delete any that an icon, a state
   or a tooltip already carries (§5).
10. **Independent review.** Someone who did not build it reviews the
    screenshots with the brief below. Fix what they find and re-run the gate on
    what changed.
11. `npm run check:themes`, `npm run typecheck` and the affected tests pass.

Report what ran, what was seeded or simulated, and what was not verified.

**Reviewer brief**

> You did not build this. Open each screenshot at 100% beside the closest shipped
> screen. List every element that: is larger or heavier than its neighbours; has
> words an icon, a state or a tooltip already carries; states a fact twice; moves
> when something near it changes; uses a middle dot, a bullet or an em-dash in
> copy; has a radius too round for its height, a doubled edge or a missing edge;
> sits far from what it changes; or would look out of place in the best
> professional desktop tools. Cite the DESIGN.md section for each.

---

## 16. Adding something new

§1 covers every change. Before adding a new component, token, hue or surface,
also answer all five:

1. Does an existing pattern cover this with a prop? (If yes, use it.)
2. What does the user learn or do that they couldn't before?
3. Which token roles does it use — and does it need a new one? A new token must
   derive from the seven seeds (`docs/design/THEMES.md`) and be added to every mode.
4. What are its rest, hover, active, focus, disabled, loading, empty, error and
   overflow states?
5. How does it behave at the minimum width, with the longest realistic content,
   and under reduced motion?

If any answer is "unclear", the design isn't finished. Ship the existing pattern
and raise the gap.

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
| Panel boundary, structural | — | — | `--hair` seam | — |
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
| Card, hover (clickable) | `--card-hover` | `--edge-raised` | `--shadow-card` (unchanged: hover is a fill step) |
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
| Any other button, disabled | `--field-disabled` | `--text-disabled` | its resting rim, unchanged (§7.3) |
| Input / textarea, rest | `--field` | `--text` | `--field-edge` inset 1px |
| Input, hover (single-line only) | `--field-hover` | `--text` | — |
| Input, focus (any) | `--field-focus` | `--text` | `--field-edge-focus` inset 1px (neutral) |
| Input, focus-visible | `--field-focus` | `--text` | + `--focus-ring` 3px |
| Input, error | `--field` | `--text` | `--blocked` inset 1px |
| Input, disabled | `--field-disabled` | `--text-disabled` | `--field-edge`, unchanged (§7.3) |
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
| Categorical dot / bar (repo, agent, saved view) | `--id-1` … `--id-6` (§7.7) | label stays `--text` / `--muted` |
| Avatar fallback | `--field` | `--muted` |
| Focus rim, text entry | — | `--field-edge-focus` inset 1px (neutral) |
| Focus halo, keyboard only | — | `--focus-ring` 3px |

`--id-*` are derived from the `skill` seed by the rotation in `docs/design/THEMES.md`, carry no
semantics, and are never used for text — never reuse a status hue for a category,
or an `--id-*` for a state.

---

## Appendix B — Surface specs

What was decided for specific screens. Every rule above still applies; these
record the screen-level choices so the next change starts from them.

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
failure, checkout, Git, review, delivery, finish) on a tint of its tone; then the title
with what it needs beneath it — the reason in its tone ink, then one recorded
fact, the agent's question or the command; the repository when it
distinguishes; the age; and, for a plain command approval only, its decisions
in place. The whole row opens the task; there is no "Open task" button. A
finished review waits on the person in one of four words, as the board card
says it too: Agent asked a question (an answer to a request needs their
decision), Review failed, Fixes ready for review (the agent answered a request
and the code changed), Needs changes. A review that finishes also says so in a
toast, wherever the person is.

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
say keeps its own words, with the runtime's name from data: "… wants to run a
command", "… is working".
While no pull request exists and finishing holds the panel, opening one is a
finishing action here; otherwise PR Status offers it as a section, so it appears
exactly once on the page. Marking done despite open evidence is the owner's
override: never the filled primary, always last. Three actions sit side by
side; past three, the first two stay and the rest — the overrides — move under
a More menu, each keeping its disabled reason inline. An approval in the panel
ends as request cards do: declining first, the primary last, and its other
answers between them.

Provider text is quoted, never set as Task Monki's own: under a title or caption
that names the agent, with a 2px `--edge-raised` rule along its left edge.

Everything else on the page is a section: a quiet label (`--t-help`/500,
`--muted`), then content. Space separates sections; no rule runs under a label.
The story's sections (request, result) are flat: no card, no fill. Record
content — Details, the preview, History, and the agent review and pull request
in the story — is an inset group: `--panel` fill, `--r-md` corners, a 16px
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
Like every working tab, Review has no page head: the title row sits in the
window's top bar and the code gets the room. Nothing on the tab explains itself in words a
control's icon, state or tooltip already carries.

- *Toolbar* (40px). The navigator's switch (Files, with viewed progress as
  "2/7", and Feedback) sits over the navigator; then the review in one phrase in
  its tone's ink and its time (Fixing review feedback while the agent takes a
  turn after the review; the agent's request, such as "… asked a question" with the
  runtime's name,
  with Go to request while it waits on the person; a turn that stopped, such as
  "Recovery required", with Go to agent); then Compare (All changes,
  Committed, Uncommitted, and the round: Since the review once an out-of-date
  review has changes since it, which it then leads with, or Since the last review
  once a re-review is current; each is exactly what changed from the code that
  review read, kept when it started, so an out-of-date review's findings sit on
  the lines it read, on the old side; never an empty scope), a View icon (By
  importance, By path; expand or collapse every file), and the review action.
  A stale review keeps Run review again as the primary there; a finished,
  current one offers it as an icon beside its time.
- *Navigator* (248px on `--panel`). Files by importance: files with an open
  Blocker or Major, then code with each test right after the code it covers,
  then styles and markup, configuration, documentation, and generated files,
  collapsed. One 28px row each: the name in mono, its folder muted, a comment
  count when it has feedback, then the counts or the viewed check. Feedback
  lists every finding and comment by what happens to it: To send, Suggestions,
  Settled, and after a re-review Resolved (a check and the reviewer's note; it
  has no place in the code to go to).
- *Brief.* Facts before opinions: the request, what the agent reported (quoted),
  then the review's summary. After the agent answers a request, its answer to
  each item spans the brief under them (Fixed, Not changed, Needs your decision,
  or No answer, then its note; the location goes to the finding or file), with
  Reply when an item waits on the person, until the next review reads them. Open
  on the first visit to a review run and again when new answers arrive; folded,
  it is the request's first line.
- *Files.* Each file is a 1px `--edge-raised` border (`--r-sm`; it collapses to
  its 36px head) with a sticky head at table-row scale and no edge of its own,
  only a `--hair` seam under it while open: the chevron and path as one toggle (⌥: every file),
  the directory muted before the name, a word only for New, Deleted or a rename,
  the open findings in words, the counts, the shared checkbox for viewed (no
  label), ⋯ (Comment on file, Show whole file, then where it opens), then Full
  screen: the file takes the whole page, its head the sheet's 48px first line,
  while the tab bar, toolbar, navigator, brief and foot step aside; J/K and N/P
  move it to the next file or finding, and Escape or the same control returns. A viewed or generated
  file collapses, but its open findings stay as one-line rows: Viewed never
  hides a finding.
- *Rows.* The gutter is the line number (the old side's on a removed line),
  one width for the whole review so the comment "+" (16px, `--r-2xs`, its
  glyph centered) fits beside the largest number and code starts on one column; the "+"
  shows on the row under the pointer and fills when the pointer is on the
  number. Pressing a number, or dragging across several, opens one comment for
  that line or range. Then the marker and code that wraps; the gutter takes the
  row's tint. Threads and comments start at the code column.
- *Gaps.* The unchanged lines between hunks are one 28px row on `--panel`: the
  count in words at the code column ("19 unchanged lines") and the enclosing
  symbol in mono `--faint`. When the checkout still holds the captured file
  (its blob is the capture's new side and every hunk line reads the same), the
  row is the control: its label opens every hidden line, and a gap longer than
  20 lines also opens 20 at a time from two fixed 24px steps in its gutter, up
  from the change below and down from the change above (the file's first gap
  opens only up, its last only down). The lines after the last hunk have a gap
  row too. Revealed lines are ordinary context rows; the gap shrinks or goes,
  the height changes at once, and nothing above the gap moves. The file's ⋯
  shows the whole file and goes back with "Show changes only". When the checkout
  no longer matches, the gaps stay words and that item is disabled with
  "Differs from the checkout". An earlier capture never opens its gaps. The
  review holds only changed files; any other file opens in the editor from ⋯.
- *Findings.* A thread under the last line of its range, on `--card` with the
  `--edge-raised` ring (`--r-sm`), its severity as a word (blocker and major in
  `--blocked-ink`), in a re-review "Still open" or "New" beside it, and its
  actions on the title line: Add to request on a Minor or Nit (Blocker and Major
  are in by default), Ask (opens Ask about this finding), and Dismiss, a menu of
  reasons (Incorrect, Intentional, Won't fix now, With a note…). The next review
  never raises an Incorrect finding again, raises an Intentional one only when
  the code around it changed, and leaves a deferred one alone. A dismissed
  finding folds to one line with its reason and Restore.
- *Comments* sit on `--field` (`--r-sm`, as does the composer in the diff) with icon-only Edit and Delete; they can be written
  any time the current diff is shown and are saved with the task as written.
  The line composer's Ask, at its left, hands the lines and the text to Ask
  instead of the request.
- *Foot.* Always present: when something is queued, its summary ("1 fix, 2
  comments"), which opens the request sheet; a note that grows to four lines;
  and one primary: Request changes when something is queued, otherwise the step
  that finishes the task. The sheet lists what goes out in send order, what is
  left out, and the instruction, one disclosure away. A request goes out
  numbered, findings then comments; in the Agent conversation it reads as a
  card of those items, and the agent's reply ends with its answer to each,
  shown as a list under the reply. A review asks for changes only while an open
  Blocker or Major would be sent.
- *Stale.* A review goes out of date only when the diff differs from the one it
  reviewed, which the next Git snapshot decides; a follow-up or retry that
  changes nothing leaves it current, and a diff back to exactly what was
  reviewed makes it current again. Any other turn (analysis, compaction) leaves
  it with no implementation run to belong to, so it becomes earlier context. An
  out-of-date review keeps its threads as earlier context, without Ask or
  Dismiss; its findings are never sent, the person's comments still are.
- *Keys.* J/K files, N/P open findings, V viewed and on to the next unviewed
  file, D dismiss, A ask, F add or take out a suggestion, C comment on the
  chosen lines, ⌘↵ the request sheet and then send, ⌘⇧F the file being read
  full screen and back (Escape returns).

**Side panels.** An assistant panel (Ask on Overview, Agent and Review, the
Preview agent on Preview) is its own sheet beside the task page, 380px by default and resizable
from 320 to 560, toggled from the right end of the tab bar with the agent mark.
It stays a separate sheet in every window that can hold it: a narrow window
lends it less width, down to 320, before the page would drop below 560px, and
only below that does it float over the page, sliding in 8% with the drawer
curve. Its resize edge is the sheet's own left edge; hover and focus draw a 2px
line there.

With a panel docked, the two sheets read as one layout: the task page's tab bar,
the first line of its sheet on every working tab, shares the panel head's line
and hairline. The title is already in the window's top bar, so docking or
closing a panel moves nothing above the tab bar. The panel's
content keeps a 16px inset; its composer has the main composer's height and
ends 16px above the sheet, as the main composer and the Review foot do,
so every input box shares one bottom line. Its head is
48px: mark, name, the runtime that answers, Expand, Close. Expanded, the panel
covers the task page and its tab bar as one sheet, its thread in the Agent
tab's 760 column, while the page underneath keeps its layout; closing ends it. Escape closes it and focus
returns to the toggle. An empty panel shows its composer, and the placeholder names what to ask; each
answer it can act on carries that action under it ("Use in
follow-up"). The Preview renders its agent into the sheet's slot; a Preview
shown without a task page (a repository Design) keeps its own toggle and opens
the same panel as a floating sheet over itself.

The agent is the only conversation; the reviewer is a read-only reporter, not a
chat. Ask is the one read-only place for questions about the task. A question
goes to the model chosen in the panel's composer (the task's own until another
is picked) in a fresh read-only session that also reads the current review, so
the implementation keeps working; while it works, the question reads a snapshot
taken when it was asked. A question can be about a finding or lines of the diff:
their title or location shows above the field with a control that clears it,
and above the question once asked. In a narrow composer the model and effort
chips show as their marks alone (a brain, a gauge), each named in a tooltip.
Closing the panel ends the thread and removes the snapshot. Nothing reaches the
agent unless the person uses an answer: "Use in follow-up" puts it in the
composer under the question it answers; on Review, "Add to request" adds it to
the request's note.

**Before the first run, the Agent tab is one composer**, centred in the tab: the
prompt, saved attachments, and the toolbar with model and access chips and the
step (Prepare worktree or Start). Starting saves the prompt; there is no
separate save. New task uses the same chips in its description's toolbar.

On the Agent tab the conversation starts under the tab bar, which stays pinned
while it scrolls; the title row is in the window's top bar, and nothing slides
away.

A list-detail workspace (Designs, New Design, Discourse) has a 48px head: the
panel toggle, a 15/500 title with its state beside it on the same line, then the
actions, every control 28 tall (a layout switch is a 28px track of 24px
segments). Side panels stand beside the head, not under it: a Design's
References and the Discourse settings start at the sheet's top, so their heads
share that 48px line and every hairline under a head lines up. A head holds one
line; it never explains itself in a second. A Design's canvas toolbar under the
head is the 40px bar. New Design is one centred column at the Agent
conversation's width: the source switch, then a single composer holding the
brief, the model and profile chips, the reason a run cannot start, and Create.

---

**Recorded bugs.** Record bug is a secondary action in the Preview status row
and, while a Ready task has no bug yet, beside Start implementation in the Now
panel, with its reason in full when it waits. A recording takes the Preview's
place as one workspace. Its 40px head names one state in neutral ink, the only
live region: Starting the app, Recording, Point at what's wrong, Mark the bug,
Recording stopped, or Record a bug over a decision; the elapsed time sits beside
it, and the state word carries the live shimmer while something counts. Steps
(when the rail does not fit), Back to recording, Discard and the primary Mark
bug sit on the right. A step that fails says so in a `.tm-notice--band` under
the head, never in a toast the page could cover. Env files, approving
replays and a failure are decision blocks in the page's place, Cancel first.

The page is a native view in a framed card, top-anchored, at its recorded 16:10
size and never enlarged, with its own bar: Reload, the address (a field that
takes the start page until the first step, plain text after) and the recorded
size. While the copy starts, the frame holds the startup as a checklist
(installs, then databases, jobs and processes, each with its time) with a
failed step marked. The view is placed again whenever the space around it moves
and hidden whenever a modal, a menu or a floating panel covers it; the Preview
agent's panel steps aside until the recording ends. From a 1180px workspace the
steps rail sits beside the page and lists what is recorded as it happens:
numbered steps with their kind's icon, requests the app answered with a 4xx in
muted ink, server errors, unanswered requests and page errors in error ink, a
refused host as a warning. It follows the newest row unless the person scrolled
up.

Marking puts the 380px capture panel in the rail's place, with its own scroll
and a fixed foot. Bug comes first; its name follows the first expectation until
the person writes one, stating what should be true. Then Notes, then Expected:
one row per expectation, numbered like its outline on the page, added from Add
expectation (an element, No page error, a request, a value) and removed with
its ×. A new element's expected value takes focus with its text selected. Stop
pointing replaces Add expectation while the page waits for a click, and Escape
works. A click in an embedded frame picks nothing; one muted line ends Expected
and says why until pointing starts again. Steps and Page errors are disclosures.
The foot holds Save steps only,
then the primary Save and reproduce, at their labels' width, with the reason
beneath and the bug a save replaces named on its own line above; only a change
to an expectation asks again whether the bug reproduces, and the last answer
stands meanwhile. A stopped recording's foot holds Record again, then the
primary Save steps only. Below 760px the page and the panel alternate. Focus
moves to the bug's name when marking starts and back to Mark bug on return.
Labels that turn pending keep their width. An element has one name everywhere:
on its outline, in its expectation and in the results.

On the Overview the bug is a record group after the request: its name with the
state word, the person's notes and the reason, then Before and After side by
side at 2:1, each framed on the checked element with its numbered outline and
captioned with its side and age; either opens the compare view, which holds
both sides in one place with a switch and the arrow keys between them. Under
them a table: Expected, Before, After, each side a check or a cross with the
value seen; After is quiet and labelled "earlier code" when the code changed
since or could not be checked again. Replays and Steps are disclosures. Each
replay row opens a 560px drawer under the title bar: the end of the page,
framed on its outlined elements, what each expectation saw, the steps with the
failed one marked, and where it ran; focus starts on the drawer and returns to
the row. A replay of expectations the person has since changed reads "earlier
expectations" beside its side with its word in neutral ink, and its drawer lists
them as Earlier expectations with quiet marks. Edit expectations opens the same
drawer as a form: the capture panel's rows (28px controls) without outline
numbers, each with what the recording showed, focus on the first value, and a
foot whose reason sits beside Cancel and the primary Save and reproduce. Save
stays disabled until something changes, and an untouched form explains nothing;
a reason appears only for a change that cannot be saved. Removing a row moves focus to the row that takes its place, and closing
returns it to what opened the drawer. The
actions wait in a 24px ⋯ menu, each with its reason when it cannot run yet.
When the person owes the bug a step, the Now panel takes it and the section
drops its state word: the state as title and the fact that drives the step as
its line, never the bug's title. Approving replays reads as a request card:
Cancel replays, Always approve in this repository, then the primary Approve
replays, with what runs under Details; while replays wait on it, the panel holds
that decision alone and the bug's other steps wait in its ⋯ menu. The turn that
hands the bug to the agent carries it as an attachment that opens it. Discard
recording, Remove bug and Delete evidence are 440px confirms with Keep first.
Debug's Earlier bugs is a table: Bug, Ended, When, Evidence and a row menu
holding Delete evidence. Settings' Repositories section lists the approvals
kept for a repository under Replay approvals: a table of Repository, What runs
(the recipe's commands, and under them at meta size the env files and outside
hosts replays get) and Approved, with Revoke approval in the row menu and no
confirm, since approving again restores it. It appears once something is kept;
revoking the last one leaves "No replay approvals" until Settings closes.

## Appendix C — where things live

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
- **`docs/design/THEMES.md`** — how themes are authored and derived, the floors
  every token is held to, and the generator workflow.
