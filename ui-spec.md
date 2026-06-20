# Task Manager — Layout Redesign Implementation Spec

A prompt/spec to implement the redesigned Task Manager layout. The previous UI used **three competing columns** (New-task form · Tasks list · Detail). This redesign collapses navigation into **one sidebar** and gives the detail view the full remaining width. The new-task form moves out of a permanent column into an **on-demand slide-over panel**.

---

## 1. App shell

- Full-viewport flex row, no page scroll: `display:flex; height:100vh; overflow:hidden`.
- Two regions only: **Sidebar** (fixed `312px`) + **Main** (`flex:1`, internal scroll).
- Base font: `Inter Tight` for UI, `JetBrains Mono` for IDs / paths / values.
- Palette: surface `#fbfbfc`, app bg `#f1f2f4`, borders `#e6e8eb`, text `#1c2024`, muted `#8b9197`, primary `#2563eb`.
- Status dot colors: green `#16a06a`, amber `#f5a623`, neutral `#c2c7cc`.

## 2. Sidebar (replaces the old form + list columns)

Single vertical stack:

1. **Brand row** — 30px rounded gradient logo tile + “Task Manager” (16px/700).
2. **Primary “+ New task” button** — full-width, 38px, `#2563eb`, white, 9px radius. Opens the slide-over panel (does NOT navigate). This is the only entry point to task creation now.
3. **Section header** — “TASKS” (11px uppercase, `.07em` tracking, muted) with a count pill on the right.
4. **Scrollable task list** — `flex:1; overflow-y:auto`, 6px gap between cards.

**Task card:**
- 11px radius, 12–13px padding, 1px border.
- Selected state: border `#2563eb`, bg `#f4f7fe`, subtle blue shadow. Unselected: border `#e6e8eb`, white bg, hover border `#cfd9f5`.
- Contents: `#id` (mono 11px) + flow badge → title (13.5px/600) → wrap row of status chips (dot + label, 10.5px).
- Clicking a card selects it and shows its detail in Main.

## 3. Main — top bar

- Surface `#fbfbfc`, bottom border, `16px 24px` padding.
- **Row 1:** left = `Task #id` (mono) + “Healthy” green pill, then the task title `<h1>` (22px/700, `-.02em`). Right = action cluster.
- **Action cluster (consolidated — was a long button row):**
  - A **segmented group** in a `#eceef0` pill for low-emphasis actions: *Run tests · Refresh evidence · Commit* (30px, ghost, white on hover).
  - One **outline** button: *Move to review*.
  - One **primary** button: *Create draft PR*.
  - One **⋯ overflow** icon button for the rest (Check GitHub, Refresh GitHub, Cancel run…).
- **Row 2 — status strip:** replaces the dense label grid with a wrap of compact **chips**, each `dot + label(muted) + VALUE(mono/600)` in a white pill: Phase, Repo, Worktree, Git, Tests, Codex, GitHub.

## 4. Main — body

- Scroll container `padding:20px 24px 28px`.
- **2-column grid:** `grid-template-columns: minmax(0,1.5fr) minmax(0,1fr); gap:16px`.
- **Left col:**
  - *Prompt & config* card — header (“Prompt & config” + “53 lines” + “Show prompt ▾”), then key/value rows (label 120px muted · mono value, break-all).
  - *Activity* card — header + “109 events” pill; scrollable feed (`max-height:360px`). Each row = mono timestamp (74px) · colored dot · event title (13px/600) + mono detail.
- **Right col:**
  - *Evidence* card — “Run …” mono label, a chip row (Worktree/Git/Process/Codex/Exit), then key/value rows.
  - *Codex final artifact* card — **dark** (`#0e1116`) terminal-style `<pre>`, mono 11.5px, `#b9c0c8` text, scrollable.

All cards: white, 14px radius, 1px `#e6e8eb` border, 14–18px header with bottom divider.

## 5. New-task slide-over panel (the big interaction change)

Triggered by the sidebar “+ New task” button.

- **Overlay:** `position:fixed; inset:0; background:rgba(16,19,24,.35); z-index:40`, content right-aligned. Click on the scrim closes; click inside stops propagation.
- **Panel:** `460px` (max `92vw`), full height, `#fbfbfc`, left shadow `-12px 0 40px rgba(16,19,24,.18)`, vertical flex.
- **Header:** “New task” (18px/700) + subtitle, and a 32px ✕ close button.
- **Body (scroll):** stacked fields, each = 12px/600 label + control:
  - Title (text), Repository (mono, prefilled path), Test command (mono, “npm test”).
  - Prompt — label row with a “Refine” text-button on the right; textarea `min-height:150px`, vertical resize.
  - Inputs: 40px, 9px radius, `#d3d7db` border; focus = blue border + 3px `rgba(37,99,235,.12)` ring.
- **Footer:** left helper text “Creates a task without starting implementation.”; right = *Cancel* (outline) + *Create task* (primary).
- State: a single `view` flag (`'detail' | 'new'`). `New task → view:'new'`; Cancel / ✕ / scrim → `view:'detail'`.

## 6. Summary of changes vs. old layout

| Area | Before | After |
|---|---|---|
| New-task form | Permanent left column | On-demand right slide-over panel |
| Navigation | Two columns (form + list) | One 312px sidebar |
| Detail width | Cramped right pane | Full remaining width, 2-col grid |
| Top actions | Long flat button row | Segmented ghost group + outline + primary + ⋯ overflow |
| Status block | Dense label/value grid | Compact wrap of pill chips |
| Codex artifact | Plain box | Dark terminal panel |

## 7. Acceptance checks

- Sidebar fixed 312px; only the task list and detail body scroll; page never scrolls.
- Selecting any card updates the detail and its selected styling.
- “+ New task” opens the panel; scrim / ✕ / Cancel close it; clicking inside does not close it.
- Top-bar actions fit one row at ≥1280px; secondary actions collapse into ⋯ below that.
- Status and evidence values render in monospace; long paths wrap/break rather than overflow.
