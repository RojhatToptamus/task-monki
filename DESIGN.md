# Task Monki Interface Guide

Guidance for any AI/coding agent doing **design or frontend work** in this repo.
Read this file **before** you write UI, add a component, or change a screen. The
goal is a coherent, modern, macOS-native-feeling app with zero AI slop. If a
change would violate anything here, stop and ask instead of guessing.

---

## 1. What this app is

Task Monki is a desktop app for managing autonomous coding-agent tasks: a task
board, task detail, PR/CI status, review queues, and agent runs. It is
**dark, calm, dense-but-legible, and operational** — closer to Linear / Codex /
native macOS than to a marketing site. Users are technical and read this UI all
day. Respect their attention.

---

## 2. The source of truth (read before styling anything)

- Global styles live in **`src/renderer/styles.css`**. It defines the real color
  tokens, type scale, spacing, radii, tone colors, and component classes.
- **Use those tokens and classes. Do not invent a parallel system.** No new
  color hexes, no new font, no ad-hoc spacing values, no bespoke button.
- **Never guess a token name.** Open the stylesheet, find the real `--variable`,
  and use it. An unresolved `var()` silently falls back to a browser default —
  that is a bug.
- If the design genuinely needs something the system lacks, add it to the system
  with consistent naming — don't one-off it in a component.

Reuse existing components first. Only create a new component when the pattern
repeats and has real props/state. Match the density, borders, radii, and
hover/active behavior of what's already there.

---

## 3. Design philosophy (non-negotiable)

Every element — and its **position** — must have a reason. If you can't state
why it exists or why it sits where it does, remove it. "One thousand no's for
every yes."

1. **Meaning over decoration.** No element exists to fill space or look busy.
2. **One restrained type scale.** Use the system's sizes/weights consistently.
   Hierarchy comes from weight, spacing, and position — **not** giant titles.
   No oversized hero text inside cards.
3. **Tone lives in one small signal (a status dot), not in colored headline
   text, tinted backgrounds, or colored borders.** Text stays neutral
   (primary/muted). Color is rare and load-bearing.
4. **Actions by purpose.** The primary workflow action is prominent and near the
   thing it advances. Utility actions (refresh, etc.) are minimal — prefer a
   quiet icon over a full button and never let them compete with the primary.
   Destructive/rare actions appear only when meaningful.
5. **Progressive disclosure.** Detail (logs, raw payloads, history) is compact
   by default and expandable in place (GitHub-Actions style), never dumped
   inline as a wall.
6. **Say it once.** The same fact must not repeat across a title + a status + a
   sentence + a button. State it in the single highest-value place.
7. **Coherence.** Spacing, density, hairline borders, radii, and interaction
   states are identical across every screen.

---

## 3a. Status color map (one color per *question*, not per state)

Every status color must answer exactly one question. Pick the color by what the
state is asking of the reader, never by which hue "feels" right. Named aliases
live in `src/renderer/styles.css` (`--state-*`) and resolve to the raw tone tokens; use the
alias so the meaning is legible at the call site.

| Token             | Raw       | Means                    | Covers                                                       |
| ----------------- | --------- | ------------------------ | ------------------------------------------------------------ |
| `--state-working` | `--info`  | The agent is working     | Running, Reviewing, Fixing review feedback, Refining         |
| `--state-waiting` | `--action`| Waiting on **you**       | Needs approval, Ready for review, PR review waiting, stale review |
| `--state-blocked` | `--error` | Blocked / verdict against| Needs changes, blocker findings, failed runs, destructive    |
| `--state-verified`| `--success`| Verified / complete     | Done, review passed, evidence verified, tool available       |
| `--state-idle`    | `--neutral`| Idle / not yet          | Ready, Not run, No PR, backlog                               |

- **One dot, load-bearing.** Tone shows as a single status dot (`.status-pill`,
  `.tm-pulse`, `.tm-plan__dot`), never as tinted boxes, colored borders, or
  colored headline text (see §3.3 and §4).
- **Differentiate urgency by weight, not hue.** A decision that blocks the
  pipeline (Needs approval) gets the filled treatment + an Inbox count; passive
  waiting (Ready for review) gets a dot + text only. Both are amber.
- **Mono is for values, sans for status words.** Status words render in sans
  chips (`.status-pill__label`); mono (`.status-pill__value`) is reserved for
  ids, branches, and counts — never for status words.
- There is no `--evidence` status color. Teal is not a state; do not reintroduce
  it as a status dot (it is indistinguishable from `--success` in dark mode).

---

## 4. Hard bans (this is what "AI slop" means here — do not ship these)

- ❌ Rows/walls of badges or pills; the same label repeated as a badge and as text.
- ❌ Tinted boxes with a colored left-border accent stripe.
- ❌ Big, bold, **colored** headlines (e.g. a 20px green "Merged").
- ❌ Gratuitous gradients, glows, or drop shadows that aren't in the system.
- ❌ Emoji as UI (unless the system explicitly uses them).
- ❌ Decorative icons that carry no information.
- ❌ Repeated didactic/explanatory sentences ("This is where you can…").
- ❌ "Showcase"/demo panels disconnected from the real product surface.
- ❌ Inventing product features, data, or copy that weren't specified.
- ❌ Heavy borders, oversized padding, or a density that doesn't match the app.

---

## 5. Frontend code quality

- **Match existing patterns.** Before adding code, read a neighboring component
  and follow its structure, naming, and style approach.
- **Use the design tokens/classes**, not magic numbers. No hardcoded colors or
  one-off spacing when a token exists.
- **Semantic, accessible markup.** Real buttons for actions, labels tied to
  inputs, keyboard-operable disclosures, sufficient contrast, focus states,
  hit targets ≥ the system's minimum. Add `aria-*`/`title` where an icon-only
  control needs a name.
- **All states, not just the happy path.** Every component handles
  default / hover / active / disabled / loading / empty / error. Empty states
  must look intentional, not broken.
- **No dead or speculative code.** No unused props, commented-out blocks, or
  "just in case" abstractions. Componentize only when a thing repeats and has
  real props/state — otherwise keep it inline and readable.
- **Small, purposeful diffs.** When asked for a targeted change, change only
  that. Don't restyle, "improve," or redesign untouched areas. Preserve
  existing layout, spacing, and behavior you weren't asked to touch.
- **No new dependencies** for something the stack already does.

---

## 6. How to approach a design task

1. **Read** this file, the global stylesheet, and the nearest existing
   components/screens.
2. **State the plan first**: the information hierarchy (what's most important and
   why), which existing components you'll reuse, and what — if anything — is new.
3. **Justify each element** as you place it. Prefer removing over adding. When
   unsure, choose the quieter option.
4. **Ask** if scope, audience, priority, or the intended behavior is ambiguous.
   Don't assume product decisions.
5. **Self-review** against the checklist below before finishing.

---

## 7. Pre-submit checklist (agent must pass all)

- [ ] Built on the real tokens/classes from the global stylesheet — no invented
      colors, fonts, spacing, or components.
- [ ] Every element and its position has a stated reason; nothing is filler.
- [ ] One consistent type scale; no oversized or colored headline text.
- [ ] Tone shown via a single dot; text is neutral; no tinted boxes, no colored
      borders, no badge walls.
- [ ] No fact is repeated across title/status/sentence/button.
- [ ] Primary action is prominent and correctly placed; utility actions are
      quiet and don't compete.
- [ ] Detail is progressively disclosed, not dumped inline.
- [ ] All states handled (incl. empty + error) and they look intentional.
- [ ] Accessible: semantic markup, labels, focus, contrast, hit targets.
- [ ] Diff is minimal and scoped to the request; untouched UI is unchanged.
- [ ] Density, borders, radii, and hover/active states match the rest of the app.

If any box is unchecked, fix it or ask before submitting.
