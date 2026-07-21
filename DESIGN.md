# Task Monki Interface Guide

Guidance for agents doing design or frontend work in this repository. Read this
file before changing a screen, interaction, or component. It is a decision
framework, not a substitute for inspecting the product: the rendered app,
nearby components, the ordered `src/renderer/styles.css` manifest, and its
`src/renderer/styles/*` sources remain the source of truth.

The goal is a coherent, macOS-native-feeling operational desktop app that
rewards sustained use. A good Task Monki interface is calm, precise, compact
without feeling cramped, and clear about what is true and what the user can do
next. Light and dark themes are equally important expressions of the same
system.

### Core design principles

1. **Meaning over decoration.** No element exists to fill space or look busy.
   Every visible element and its position must help the user orient, understand
   state, decide, or act.
2. **One restrained type scale.** Use the system's sizes and weights
   consistently. Hierarchy comes from order, weight, spacing, and position—not
   giant titles. Do not put oversized hero text inside operational cards.
3. **Tone lives in one small signal.** For persistent workflow state, start
   with concise text and add at most one supporting treatment only when it
   improves scanning. A status dot is one option, never the default. Do not
   spread the same tone across colored headline text, tinted backgrounds,
   borders, and badges. Text generally stays neutral; color is rare,
   intentional, and never the sole carrier of meaning.
4. **Actions by purpose.** The primary workflow action is prominent and close
   to the thing it advances. Utility actions such as refresh remain minimal—a
   quiet text action or familiar icon, whichever is clearest—and never compete
   with the primary action. Destructive or rare actions appear only when
   meaningful.
5. **Progressive disclosure.** Detail such as logs, raw payloads, and history is
   compact by default and expandable in context, never dumped inline as a wall.
6. **Say it once.** The same fact must not repeat across a title, status,
   sentence, badge, and button. State it in the single highest-value place.
7. **Coherence.** Type roles, spacing rhythm, hairline borders, radii, control
   behavior, and equivalent interaction states form one consistent grammar
   across the app. Composition and density may adapt to the job of the surface,
   but they must still feel like the same product.
8. **Spatial stability.** Interaction and state changes must not make controls,
   content, or surrounding layout jump unexpectedly. A control should remain
   under the pointer while it is being used, and status updates should preserve
   the user's reading position. Layout should move only when the user explicitly
   requests a structural change, such as opening a disclosure or navigating to
   another surface.

### Native desktop quality bar

Task Monki should feel designed for macOS, not like a generic web dashboard
inside a desktop shell. Native quality comes from predictable behavior,
platform-appropriate composition, precise alignment, restrained materials,
excellent keyboard and focus behavior, and polished state transitions—not from
imitating macOS ornament.

- Prefer familiar desktop structures such as sidebars, toolbars, lists,
  inspectors, menus, popovers, and focused sheets when they fit the workflow.
- Use a small number of calm surfaces and clear separators. Do not turn every
  concept into a floating card.
- Match established macOS expectations for selection, disclosure, focus,
  keyboard navigation, contextual actions, and destructive confirmation.
- Do not add blur, translucency, shadows, or platform decoration merely to look
  native. Use them only when the existing product system gives them a purpose.
- The interface must not look generically AI-generated. Reject dashboard card
  mosaics, pill and badge clutter, gradient decoration, glowing accents,
  oversized marketing-style copy, excessive rounded containers, ornamental
  icons, repeated explanatory prose, and a status dot on every row.

---

## 1. Start with the user's question

Design the information order before designing components. A screen should make
the following clear, in roughly this order:

1. Where am I, and what object or workflow am I looking at?
2. What is true now?
3. What needs attention?
4. What can I do next?
5. Where can I inspect supporting evidence or detail?

Use position, alignment, proximity, whitespace, and semantic headings to create
this reading order before reaching for larger type, color, icons, or
containers. The most visually prominent element should answer the most
important current question.

For a material visual or interaction change, write a short design intent that
identifies:

- the user's immediate job;
- the primary object, state, and next action;
- the nearest existing product patterns to reuse;
- the states and content extremes that must work;
- how the result will be verified in the rendered app.

Do not invent product behavior to complete a composition. If the required
workflow or source of truth is unclear, resolve that first.

Small, token-aligned corrections do not need process boilerplate, but they still
require inspection of the nearest established pattern and the affected state.

---

## 2. Reuse the product's visual and interaction grammar

Global style sources live in `src/renderer/styles/*`, with their intentional
cascade order declared by `src/renderer/styles.css`. Inspect the real
variables, classes, components, and nearby compositions before styling
anything. Never guess a token name; an unresolved `var()` is a bug.

Use this order of preference:

1. Inspect two or three comparable surfaces and identify the established
   pattern.
2. Reuse an existing component, class, interaction, or layout rhythm.
3. Add a semantic variant when the same pattern needs a real product state.
4. Create or extract a component when it owns meaningful semantics, behavior,
   accessibility, or lifecycle; share it when that ownership recurs.
5. Introduce new visual language only when the current system cannot express a
   concrete requirement.

Reuse is about shared grammar, not identical layouts. Controls, type roles,
radii, status meaning, and interaction behavior should stay consistent while
composition and density adapt to the job of the surface.

The stylesheet has established colors and many reusable patterns, but it is not
a complete token scale for every spacing, type, or radius decision. When no
token exists, reuse the nearest established value and rhythm from comparable
UI. Add a named token only when the value repeats or represents a genuine
system decision. Do not create a parallel design system inside a component.

---

## 3. Give each concept one owner and one clear home

A fact, status, or workflow action should have one canonical owner in the UI.
Do not repeat renderer-local versions across a page header, card, rail, modal,
and button. When a local surface owns the current primary action, global actions
should recede.

Product truth about tasks and workflow belongs in domain projections and pure
renderer selectors or view models. Components may own ephemeral interaction
state such as an open popover, search text, focus, or disclosure state; they
must not become a second source of repository, workflow, Git, review, or
delivery truth.

Place information and actions consistently across states. Loading, error, or
partial data should not move the same concept to a surprising new location.

---

## 4. Use boundaries to express real structure

Add a card, panel, divider, or nested surface only when it communicates a real
boundary: independent action, selection, scrolling, state, lifecycle, or
ownership. If headings, spacing, alignment, and a hairline can express the
relationship, prefer them.

- Keep distinct concepts in distinct surfaces when they have different state,
  actions, or lifecycle. Visual similarity alone is not a reason to merge them.
- Avoid nested cards, decorative containers, and dashboard mosaics that turn
  every fact into a tile.
- Use intentional empty space to group and separate. Do not fill space merely
  to make a screen appear designed.
- Compact by omission, not compression: remove repeated labels, redundant
  borders, empty rows, and unnecessary controls before shrinking text, hit
  targets, or useful spacing.
- Scanning surfaces may be denser than decision, editing, or destructive
  surfaces. Preserve a shared rhythm rather than forcing identical density.

Every abstraction and every visible boundary must solve a current requirement.
Repetition is not the only reason to componentize: a meaningful semantic unit,
focused behavior, accessibility contract, or lifecycle boundary can also
justify a component. Avoid speculative wrappers and generic frameworks.

---

## 5. Establish hierarchy with restraint

- Use the existing type roles and weights. Hierarchy should come mainly from
  order, weight, spacing, and contrast—not oversized headings.
- Use monospace for technical values such as identifiers, branches, commands,
  hashes, paths, and counts. Use the interface typeface for labels, actions,
  prose, and status words.
- Give each view or section one dominant purpose. Primary actions should be
  prominent and close to the object they advance; secondary and utility
  actions should remain available without competing.
- Choose an icon, text label, or both according to clarity and available space.
  Do not prefer an icon merely because it is quieter. Familiarity,
  discoverability, and an unambiguous accessible name matter more.
- Say each fact once in the highest-value location. Do not restate it as a
  heading, badge, sentence, and button.
- Keep supporting evidence visually subordinate but easy to reach through
  progressive disclosure.

Avoid ornamental gradients, glows, shadows, decorative icons, oversized
padding, badge walls, tinted card mosaics, and explanatory copy that merely
narrates the interface. Reserve strong area tint, borders, and warnings for
states that genuinely require emphasis.

---

## 6. Communicate state explicitly

Persistent workflow status, urgency, availability, and progress must be named
in visible text and exposed programmatic state. Color, dots, icons, tint, and
motion may reinforce the meaning but must not replace it. Interactive states
such as selected, checked, and expanded need the correct programmatic state and
must not rely on color alone; use a conventional control state, shape, icon, or
text as appropriate.

Use the smallest sufficient treatment for the context: concise status text with
at most one supporting signal such as a dot, icon, or restrained pill. Do not
repeat the same tone across a unit's border, background, heading, and badge.
Decorative indicators should be hidden from assistive technology when the text
already names the state.

Do not add a dot merely because a row contains state. Use one only where rapid
scanning materially benefits and where it does not duplicate an equally clear
label or control state. If text and hierarchy already communicate the state,
stop there.

The semantic aliases in `src/renderer/styles/foundation.css` answer these
questions:

| Token | Meaning |
| --- | --- |
| `--state-working` | Work is actively in progress. |
| `--state-waiting` | The workflow is waiting for the user. |
| `--state-blocked` | Progress is blocked or a verdict is against the change. |
| `--state-verified` | The outcome is verified or complete. |
| `--state-idle` | Work is idle, ready, or not yet started. |

Use these aliases by meaning, not by preferred hue. Differentiate urgency with
clear language, hierarchy, and placement rather than inventing another color.
Status words use the interface typeface; monospace remains reserved for values.
Status aliases are not selection, navigation, repository identity, or
decorative colors. Use the established tokens for those purposes unless the
object itself genuinely carries the status.

Design the full state model before the happy path alone. Consider default,
hover, focus, selected, expanded, disabled, loading, busy, empty, success,
error, stale, missing, unavailable, disconnected, and completed states as
applicable. Define which state takes precedence when several are true. Preserve
the user's context and valid actions during async transitions.

When a disabled reason is not self-evident, or the user may reasonably expect
the action to work, make the reason discoverable in the existing UI style.
Opacity or a `title` attribute alone is not an explanation. Errors belong near
the relevant action or field and should state the recovery path when one exists.

---

## 7. Make interactions predictable

- Use native controls and familiar desktop behavior before custom interaction
  models.
- When native controls do not fit, implement one recognized composite pattern
  completely: role, name, state, keyboard model, and focus behavior. Do not mix
  menu, listbox, checkbox, or dialog semantics into a one-off interaction.
- Make selection distinct from invoking an action. The selected object and the
  action that will run on it must both be clear.
- Menus and popovers support short, contextual choices. Dialogs interrupt for a
  focused decision. Drawers support longer inspection or editing without
  losing the parent context. Do not choose an overlay only to save layout work.
- Disclosures should expand in place when the detail belongs to the current
  concept. Preserve the trigger and surrounding context.
- Give actions immediate feedback. For asynchronous work, show what is pending,
  prevent accidental duplicates, and keep success or failure tied to the
  initiating action.
- Keep interactive geometry stable across default, hover, focus, pressed,
  selected, disabled, loading, success, and error states. Do not change border
  thickness, padding, font weight, icon allocation, or label width in a way that
  moves the control or its neighbors. Prefer outlines, inset treatments, and
  preallocated icon or progress space when feedback would otherwise change the
  box.
- Keep status, count, validation, and progress updates inside a stable owned
  region. When variable content cannot be reserved without creating waste,
  place it where growth does not push unrelated controls or move the user's
  current anchor. Do not let routine background updates reorder content under
  the pointer or change the scroll position.
- Intentional expansion, collapse, insertion, removal, and navigation may
  change layout, but the initiating control should remain a stable visual
  anchor and the resulting movement should be direct, predictable, and local.
- Destructive or hard-to-reverse actions need appropriate separation and
  confirmation using existing patterns. Do not make routine actions noisy.
- Hover may reveal supplemental information but must not be required to operate
  or understand the interface.

Effects and local UI state should coordinate genuine external behavior, not
copy derived product state. Prefer explicit event handling, selectors, and
state transitions over effect-driven synchronization.

---

## 8. Treat accessibility as part of the composition

- Align visual order, DOM reading order, and keyboard order. Give the current
  view or landmark a clear top-level heading and use a logical heading and
  landmark hierarchy beneath it.
- Prefer native semantic elements: buttons for actions, links for navigation,
  lists for collections, fieldsets and legends for grouped inputs, and native
  checkboxes, radios, and disclosure elements when they fit.
- Give controls stable, contextual accessible names. An icon-only action needs
  a real accessible label; `title` may provide a tooltip but is not a substitute
  for naming or describing the control.
- Associate labels, help, validation, and errors with their fields. Use live
  regions only for important asynchronous changes that would otherwise be
  missed.
- Support complete keyboard operation without positive `tabindex`. Focus must
  be visible, follow a predictable order, move intentionally into modal
  surfaces, and return to a sensible trigger or next location when they close.
  Hover-only content must also work on focus.
- Give pointer targets adequate size and separation: at least 24 by 24 CSS
  pixels or equivalent spacing where the standard exceptions apply, and larger
  when the surface's density permits.
- Normal text must meet a 4.5:1 contrast ratio. Large text and visual information
  necessary to identify controls or states—including meaningful icons and focus
  indicators—must meet 3:1 against adjacent colors in every relevant state and
  theme. Inactive controls are exempt from this threshold but must remain
  understandable.
- Do not use placeholder text as the only label or mute essential information
  until it becomes difficult to read.

The interface must remain understandable with reduced color perception,
keyboard-only input, a screen reader, increased text size, and reduced motion.

---

## 9. Preserve meaning across widths and content extremes

Responsive behavior should preserve semantic order and the primary task, not
create a second information architecture.

- Define what stays, wraps, truncates, moves, collapses, or becomes
  progressively disclosed as space narrows.
- Stack or regroup before controls clip or primary workflows require horizontal
  scrolling.
- Preserve the primary action and the context it acts on at narrow widths.
- Prefer wrapping primary identity in focused surfaces. In dense scanning
  surfaces, primary or supporting values may truncate when enough identity
  remains to distinguish them and the full value is available through an
  accessible existing pattern.
- Keep overlays within the viewport and avoid shifting surrounding layout when
  they open or when scrollbars appear. Nested scrolling must be intentional.
- Test long names, identical labels, long paths, large counts, translated or
  expanded copy, missing values, and large collections—not only seed-default
  strings.

As current QA checkpoints, inspect narrow, medium, and wide layouts around 400,
760, and 1280 CSS pixels, plus 200% zoom. If the product's supported window
sizes change, use those canonical limits instead. The primary workflow must not
become clipped, overlapping, unreachable, or dependent on page-level horizontal
scrolling.

---

## 10. Use motion only to explain change

Motion should communicate continuity, causality, or genuinely active work. It
must not be the only indication of a state.

- Prefer brief, consistent transitions using existing motion patterns.
- Avoid ambient animation, flashing, layout churn, and multiple competing
  animations.
- Prefer opacity and transform when animation is justified; avoid animating
  layout dimensions without a strong reason.
- Honor `prefers-reduced-motion` and provide a still, equally understandable
  experience.
- Give users control over motion or media that continues beyond a brief
  transition.

---

## 11. Write interface copy for utility

Use concise, exact labels that describe the object, state, or action in the
user's language. Prefer clear actions over instructional paragraphs. Keep
provider and debug terminology out of primary workflow surfaces unless the user
is explicitly inspecting debug information.

Do not add copy to justify an implementation detail. Add detail only when it
prevents a consequential mistake, explains why an action is unavailable, or
provides a concrete recovery path.

---

## 12. Implementation and verification workflow

1. Read this guide, the relevant workflow or architecture docs, the global
   stylesheet, and nearby components.
2. Trace the source of truth and define the information hierarchy, interaction
   contract, state matrix, and responsive priorities.
3. Identify the patterns being reused and the smallest coherent change. Explain
   why any new abstraction or visual rule is necessary.
4. Implement domain-derived UI through pure selectors or view models and keep
   components focused on presentation and interaction.
5. Add tests for new selector, state, or interaction behavior. Tests do not
   replace rendered inspection of hierarchy, spacing, overflow, focus, or theme
   quality.
6. Inspect the real seeded app. Compare the result with adjacent surfaces and
   capture rendered evidence when layout or hierarchy materially changes.
7. Review the focused diff. Remove dead code, duplicate truth, one-off styling,
   and abstractions without a current requirement.

For visible UI changes, verify as applicable:

- default, hover, focus, selected, expanded, disabled, loading, empty, error,
  stale, unavailable, disconnected, and completed states;
- light and dark themes;
- keyboard-only operation, focus entry and return, and accessible names;
- contrast, reduced motion, 200% zoom, and semantic reading order;
- narrow, medium, and wide windows;
- short, long, missing, duplicated, and high-volume content;
- alignment, control heights, line length, edge rhythm, intentional empty
  space, overflow, scrollbar stability, and overlay placement.

Do not claim a visible behavior is complete from static code review alone when
the rendered state can be exercised.

---

## 13. Pre-submit checklist

- [ ] The screen's reading order makes location, current truth, attention,
      primary action, and supporting detail clear.
- [ ] Each fact, status, and action has one owner and one canonical home.
- [ ] Components, tokens, values, and interaction patterns were reused from
      comparable product surfaces before anything new was introduced.
- [ ] Cards, dividers, and nested surfaces correspond to real boundaries rather
      than decoration.
- [ ] The design is compact by omission, with legible type, usable targets, and
      intentional spacing preserved.
- [ ] Status is explicit in text and semantics; color, icons, and motion only
      reinforce it.
- [ ] Primary, secondary, utility, and destructive actions have appropriate
      prominence and placement.
- [ ] Product truth comes from the correct projection or selector; local state
      is limited to interaction concerns.
- [ ] Keyboard, focus, naming, contrast, zoom, reduced motion, and semantic
      structure have been checked.
- [ ] The layout preserves meaning across themes, widths, states, and content
      extremes.
- [ ] Hover, focus, press, loading, validation, and status changes preserve
      control geometry, reading position, and scroll position unless the user
      explicitly requested a structural layout change.
- [ ] The rendered result was compared with nearby surfaces and inspected for
      visual finish.
- [ ] The diff is focused, tested in proportion to risk, and contains no
      speculative abstraction or parallel design language.

If a true product invariant cannot be preserved, stop and request direction.
For reversible visual decisions within the request, use nearby patterns and
rendered evidence to make the best judgment rather than blocking on preference.
