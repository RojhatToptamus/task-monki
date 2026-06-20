# UI Redesign Plan — Native macOS Look

**Goal:** Make the Task Manager read like a real, modern macOS app — clean, quiet, professional — in the spirit of the Codex desktop UI (reference). No liquid glass, no gradients-as-decoration, no gimmicks.

Implementation status: applied in Phase 5. See `docs/phases/PHASE_5_STATUS.md`.

---

## 1. Why the current UI reads as "AI-generated"

Before proposing changes, here is the concrete diagnosis. Most of these are individually small but compound into the generic look.

| Symptom | Where | Why it feels off |
| --- | --- | --- |
| Purple→violet gradient buttons + accent glow shadow | `--color-accent`, `--color-accent-2`, `.primary-button`, `--shadow-accent` | Gradient fills and colored drop-shadows are the #1 tell of templated AI dark UIs. macOS uses flat accent fills. |
| Oversized border radii (14–22px) | `--radius-sm/md/lg` | Native macOS controls are ~5–7px; cards ~10px. 18–22px reads as web/landing-page, not app. |
| Translucent panels over a radial gradient background | `body` background, `--color-bg-panel: rgba(255,255,255,0.06)` | The "frosted card floating on a glowing gradient" is exactly the glass/gimmick look to avoid. |
| Heavy panel shadows everywhere | `--shadow-panel: 0 24px 70px rgba(0,0,0,0.24)` | Every panel casts a large shadow, so nothing has hierarchy. Native apps use hairline borders, not shadows, for internal structure. |
| Five saturated semantic colors (mint, amber, hot-pink, two purples) | tokens | Neon-bright, high-saturation accents on dark = the "AI dashboard" palette. Apple's are more muted and desaturated. |
| Very large display type with tight negative tracking | `.detail__header h1 { font-size: 42px; letter-spacing: -0.04em }` | 42px H1 + `-0.04em` is a marketing-hero treatment, not an app titlebar. |
| Uppercase + wide letter-spacing eyebrows everywhere | `.app-kicker`, `.detail__eyebrow`, section titles | Tracked-out uppercase microtext on every label is a strong generic-template signal. |
| Font-weight 800 on buttons and labels | `.primary-button`, `.task-form label span` | macOS UI text tops out around 600 (semibold). 800 looks webby. |
| Action row of ~10 equal-weight buttons | `.detail__actions` | No primary/secondary hierarchy → wall of pill buttons. Native apps group and rank actions. |
| Inter as the primary UI font | `--font-ui` | Fine, but a true native feel comes from `-apple-system` / SF first. Inter-first is a web default. |

**Net:** the bones (sidebar + detail, status badges, timeline, evidence) are good and Codex-like already. The *surface treatment* (gradients, glow, radii, saturation, weight, tracking) is what needs to change.

---

## 2. Design direction

A single, coherent target: **SF-based, hairline-bordered, flat-accent, low-shadow.** Think Xcode / Codex / Linear-on-macOS, not a SaaS landing page.

Principles, in priority order:
1. **Structure with hairlines, not shadows.** One subtle drop shadow allowed: the elevated app chrome. Internal panels separate by 1px borders and background-tone steps.
2. **One accent color, flat.** A single macOS-style blue, used solid (no gradient, no glow) and sparingly — only on the one primary action per view and on selection.
3. **Desaturate the palette.** Status colors stay distinguishable but pulled toward Apple's system palette (less neon).
4. **Quiet typography.** SF system stack, normal tracking, weights capped at 600, smaller display sizes.
5. **Hierarchy in actions.** Exactly one primary button per context; everything else is secondary/tertiary or moved into menus.

---

## 3. Token system (proposed values)

These are concrete replacements for the `:root` block. Two-track (light + dark) is ideal for a native feel; if scoping down, ship **dark first** and keep the variable names so light is a later drop-in.

### Color — dark

```
--color-bg:            #1e1e1e   /* window content, flat — no gradient */
--color-bg-sidebar:    #252526   /* slightly raised sidebar */
--color-bg-panel:      #252526   /* opaque, not rgba over a gradient */
--color-bg-panel-2:    #2d2d30   /* nested / inset surfaces */
--color-bg-field:      #1b1b1b   /* inputs, code blocks */
--color-text:          #e4e4e6
--color-text-muted:    #a0a0a6
--color-text-subtle:   #6e6e76
--color-border:        rgba(255,255,255,0.08)   /* hairline */
--color-border-strong: rgba(255,255,255,0.14)
--color-accent:        #0a84ff   /* macOS system blue (dark) — flat */
--color-accent-text:   #ffffff
--color-success:       #30d158   /* system green, dark */
--color-warning:       #ffd60a   /* system yellow, dark */
--color-danger:        #ff453a   /* system red, dark */
--color-info:          #64d2ff   /* system teal/blue, dark */
```

### Radii, spacing, shadow

```
--radius-sm: 5px    /* controls: buttons, inputs, badges-as-rect */
--radius-md: 8px    /* cards, panels */
--radius-lg: 10px   /* outer app chrome only */
--shadow-chrome: 0 1px 3px rgba(0,0,0,0.3), 0 8px 24px rgba(0,0,0,0.18)  /* app window only */
/* remove --shadow-accent entirely; remove per-panel shadows */
```

Keep the existing `--space-*` scale — it's fine.

### Type

```
--font-ui:   -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif;
--font-mono: "SF Mono", "SFMono-Regular", ui-monospace, Menlo, monospace;
```

> Note: if a custom face is wanted, SF is the native answer and is already on the machine via `-apple-system`. Keep Inter only as a fallback.

### Optional: light mode

Because `color-scheme` is already set, a light track is low-effort and is what makes an app feel truly native (respects system appearance). Mirror values: `--color-bg: #ffffff`, sidebar `#f5f5f7`, text `#1d1d1f`, accent `#0066cc`, hairlines `rgba(0,0,0,0.10)`. Gate with `@media (prefers-color-scheme: light)`.

---

## 4. Component-level changes

### Window chrome / shell (`.app-shell`, `body`)
- **Remove** the radial + linear gradient `body` background; use flat `--color-bg`.
- Keep the two-column grid. Narrow sidebar from `420px` → **300–320px** (Codex-like proportion).
- Drop the `1px` grid gap "seam"; use a real `border-right` hairline on the sidebar instead.
- Consider a subtle inset top region to read as a titlebar (optional; only if the Electron window is frameless).

### Sidebar (`.sidebar`)
- Flat `--color-bg-sidebar`, hairline right border, no shadow.
- Header: drop the "PHASE 2" tracked-uppercase eyebrow, or demote it to a small muted tag. Title "Task Manager" at ~17–20px, weight 600, **no negative tracking**.
- Connection dot: keep, but shrink the glow ring or remove it (the `box-shadow: 0 0 0 6px` halo is a glow gimmick).

### Task create form (`.task-form`)
- Inputs: `--radius-sm` (5px), `--color-bg-field`, hairline border. Focus ring = 2px `--color-accent` at low alpha (no 4px purple bloom).
- Labels: weight 500–600, sentence case, **not** uppercase, normal tracking, ~12px.
- "Create task" = the one primary (flat blue) button. "Refine Prompt" = secondary.

### Task cards (`.task-card`)
- `--radius-md` (8px), flat `--color-bg-panel`, hairline border, **no shadow**.
- Selected state: flat blue-tinted background + 1px accent border (not the current heavy purple wash).
- Reduce badge count on the card to the 3–4 most decision-relevant; the rest live in detail. A 7-badge grid per card is noisy.

### Status badges (`.status-badge`, `StatusBadge.tsx`)
- This is the highest-leverage change for the "native" feel. Two options:
  - **A (recommended): dot + text.** Small colored dot + muted label + value. Quieter, very macOS. e.g. `● Tests  PASSED`.
  - **B: keep pill** but lower-radius (full-round is fine for status), desaturate fills to ~10–12% alpha of the new system colors, value text weight 500.
- Cap value text weight at 600; currently fine. Ensure tones map to the new desaturated `--color-*`.
- No behavior/logic change to `toneForValue` — only the visual tokens it resolves to.

### Status row (`.status-strip` in `TaskDetail.tsx:184-199`)

The dot+text restyle helped, but the status row's **information design** is still the weakest part of the view: 14 equal-weight items in one flat wrapping row, no grouping, dead `NOT_APPLICABLE` states competing with live data, and the `Health` verdict buried last. This needs more than a style tweak, so it has its own focused spec: **see [STATUS_ROW_REDESIGN.md](./STATUS_ROW_REDESIGN.md).**

### Detail header (`.detail__header`)
- H1: **24–28px**, weight 600, tracking `-0.01em` max (not `-0.04em`). Title should look like a document title, not a hero.
- Eyebrow "Phase 2 isolated worktree · #id": demote to a single muted line, sentence case, no wide tracking.
- Summary paragraph: `--color-text-muted`, ~13px.

### Action bar (`.detail__actions`) — biggest UX/visual win
- Today: ~10 equal pill buttons wrapping right-aligned. Replace with **hierarchy**:
  - **One primary** contextual action (flat blue): e.g. "Start implementation" when runnable.
  - **A few secondary** buttons for the current step (Prepare worktree, Run tests, Cancel).
  - **Overflow** the rest (Check GitHub, Create draft PR, Refresh GitHub, Refresh evidence, delivery commit) into a single "…" menu or a segmented "GitHub" group.
- Buttons: `--radius-sm`, weight 500–600, no gradient, no glow. Secondary = hairline border on `--color-bg-panel`.
- This can be done purely as styling + light grouping in `TaskDetail.tsx`; the handlers and `can*` guards stay identical.

### Panels (`.panel`)
- Flat `--color-bg-panel`, hairline border, `--radius-md`, **no shadow**.
- Panel header `h3`: 13–14px, weight 600, sentence case. Drop tracked-uppercase on the right-side `span`; make it muted regular text.
- `prompt-box` / `pre`: `--font-mono`, `--color-bg-field`, hairline, 12–13px, comfortable line-height. This already looks closest to Codex — keep it.

### Activity timeline (`.timeline`)
- Already close to Codex's diff/event list. Keep the 3-column grid. Use hairline row separators (already there) but lighten to the new border token. Time in mono/tabular figures, muted.

### Evidence panel (`.metadata-grid`, `.artifact-box`)
- Metadata grid: keep label/value layout; labels muted regular (not weight 700), values mono. Tighten the label column.
- Artifact `pre`: same mono treatment as prompt box. This is the most Codex-like region — leave structurally intact.

### Findings (`.finding`)
- Keep the left accent rule but switch from amber `#ffc55f` to the resolved `--color-warning`/`--color-danger` per severity. Sentence-case the code or render it as a small monospace tag.

---

## 5. Suggested sequencing

Each step is independently shippable and visible.

1. **Tokens.** Swap the `:root` palette/radii/shadow/type values (Section 3). This alone removes ~70% of the AI look with zero structural risk. Verify nothing depends on the old gradient/glow vars.
2. **Backgrounds & shadows.** Flatten `body`, remove per-panel shadows, convert the grid-gap seam to real borders.
3. **Typography pass.** Cap weights at 600, sentence-case labels, remove tracked-uppercase eyebrows, shrink H1.
4. **Status badges.** Pick option A or B; restyle. Highest "native" payoff after tokens.
5. **Action-bar hierarchy.** Primary/secondary/overflow grouping in `TaskDetail.tsx`.
6. **Sidebar width + card density.** Narrow sidebar, trim card badges.
7. **(Optional) Light mode** via `prefers-color-scheme`.

---

## 6. Out of scope / explicitly avoided

- No liquid glass, backdrop-blur "frosted" panels, or translucency-over-gradient.
- No decorative gradients, colored glows, or animated background.
- No new dependencies or design-system library — this is achievable with the existing CSS variables and class structure.
- No logic, data-flow, selector, or contract changes. All `can*` guards, handlers, and projection mappings stay as-is; this is purely presentation.

---

## 7. Open questions for the user

1. **Light + dark, or dark only** for the first pass?
2. **Status badges:** dot-plus-text (quieter, more macOS) or keep desaturated pills?
3. **Accent color:** standard macOS system blue, or match a specific brand color?
4. **Action overflow:** collapse GitHub/secondary actions into a "…" menu / segmented group, or keep them all visible but de-emphasized?
