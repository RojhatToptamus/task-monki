# Task Monki Interface Design Specification

Date: 2026-07-05

This spec defines the durable interface rules for Task Monki. It is grounded in
the current global stylesheet, `src/renderer/styles.css`, and uses its existing
tokens and component classes as the source of truth.

## A. Design Principles

_Reasoning: These rules solve the main interface risk in Task Monki: high-value
workflow evidence can become noisy when every state asks for visual attention.
The chosen treatment keeps the app dense, calm, and operational; decorative
AI-style panels, repeated explanations, and color-heavy status blocks are
deliberately rejected._

1. Meaning over decoration.
   Every element must explain task state, evidence, configuration, or the next
   allowed action. Remove ornament that does not change interpretation.

2. One restrained type scale.
   Use the existing 10.5px-19px operational scale for most UI; reserve 21px and
   26px only for task-detail or page-level titles already modeled in CSS.

3. Tone lives in one small signal.
   Status color belongs in a dot such as `.status-pill__dot`, `.tm-prstatus__dot`,
   `.tm-prcheck__dot`, `.tm-reviewcard__dot`, or `.tm-setup-tools__dot`; labels
   stay `var(--text)`, `var(--text-soft)`, or `var(--muted)`.

4. No AI-slop tells.
   Avoid badge rows, gradient cards, tinted state boxes, decorative icons,
   oversized card titles, repeated tutorial copy, and showcase composition.

5. No repetition.
   State each fact once at the point of use. Do not show the same repository,
   tool status, or finish condition in a step, side card, and button label.

6. Actions placed by purpose.
   The primary action sits near the object it advances. Utility actions use
   compact controls such as `.tm-iconbtn`, `.tm-prstatus__refresh`, or menu items.

7. Progressive disclosure.
   Logs, raw output, findings, check output, and history use expandable rows
   patterned after `.tm-prcheck`, `.tm-finding`, and code blocks using
   `var(--code-bg)` / `var(--code-text)`.

8. Coherence over novelty.
   Reuse `.tm-panel`, `.tm-settings__row`, `.tm-card`, `.tm-tabs`, `.tm-modal`,
   `.tm-taskmenu`, and `.tm-exec` before adding new surface classes.

## B. Foundations

_Reasoning: The app already has a complete foundation. The spec names the real
variables so implementation can stay consistent. New tokens are rejected unless
an existing token cannot express a real repeated need._

### Color Tokens

Use these semantic tokens exactly as defined in `src/renderer/styles.css`.

| Role | Tokens | Use |
| --- | --- | --- |
| App background | `--bg` | Main content floor, empty page floor, code-adjacent quiet backgrounds. |
| Surface | `--surface`, `--surface2` | Panels, cards, rows, selected controls, segmented controls. |
| Separators | `--hair`, `--border`, `--border-strong`, `--border-hover` | Internal row lines, cards, selected/hover emphasis. |
| Text | `--text`, `--text-soft`, `--muted`, `--faint` | Primary labels, supporting text, metadata, disabled/low-value metadata. |
| Accent/action base | `--accent`, `--accent-hover`, `--on-accent` | Primary buttons and selected tab indicators. |
| Code | `--code-bg`, `--code-text` | Logs, diffs, command output, fixed-width evidence. |
| Overlay/elevation | `--scrim`, `--shadow-menu` | Modals, menus, tooltips, drawers. |

Tone colors:

| Tone | Dot token | Text token when needed | Soft/line tokens |
| --- | --- | --- | --- |
| Neutral | `--neutral` | `--muted` | none |
| Info | `--info` | `--info-ink` | `--info-soft`, `--info-line` |
| Action | `--action` | `--action-ink` | `--action-soft`, `--action-line` |
| Success | `--success`, `--success-bright` | `--success-ink` | `--success-soft`, `--success-line` |
| Error | `--error` | `--error-ink` | `--error-soft`, `--error-line` |
| Evidence | `--evidence` | use neutral text | none |

Rules:

- Routine status uses a dot plus neutral text. Do not color the full label.
- Soft/line tone tokens are allowed for blocking banners, explicit test
  feedback, destructive confirmation, or focused validation errors.
- `--evidence` is for verified local evidence, not provider telemetry.
- Do not add gradients. Existing shimmer is only for loading progress.

### Type Scale

Use `--font-ui` for interface text and `--font-mono` for identifiers, paths,
versions, commands, timestamps, and compact evidence.

| Size | Weight | Use |
| --- | --- | --- |
| 9.5px-10.5px | 600-700 | Tiny counters, priority chips, compact evidence IDs. |
| 11px-11.5px | 500-700 | Metadata, badges, timestamps, compact status labels. |
| 12px-12.5px | 500-650 | Settings controls, row copy, tabs, PR/check body text. |
| 13px-13.5px | 500-700 | Navigation, menus, normal card copy, compact buttons. |
| 14px-15px | 650-700 | Panel titles and card headlines. |
| 18px-19px | 700 | Empty-state and modal titles. |
| 21px | 700 | Task detail title only. |
| 26px | 700 | Legacy/full board page title only. |

Use uppercase only for metadata labels already patterned in CSS, such as
requirements titles. Letter spacing should be normal for new UI except existing
uppercase metadata that uses small positive tracking.

### Spacing

Use the current compact scale:

- 2px-4px: segmented gaps, icon alignment, menu item gaps.
- 6px-8px: tabs, button icon gaps, card evidence gaps.
- 9px-12px: card internals, compact rows, menu padding.
- 14px-18px: panels, settings rows, review cards, modal sections.
- 20px-24px: page gutters and major content padding.
- 28px-32px: bottom page padding and large modal/page breathing room.

Layout rules:

- Main content gutters follow `.tm-main__head`, `.tm-board`, `.tm-grid`, and
  `.tm-detail__body`: 24px desktop, narrower only through responsive media rules.
- Repeated rows use hairline separators rather than extra vertical cards.
- Avoid nested cards. Use an internal row list inside one panel.

### Radii, Borders, Elevation, Motion

Radii:

- 4px-6px: tiny chips, chevrons, menu internals.
- 7px-8px: icon buttons, tab focus rings, compact controls.
- 9px-10px: fields, small panels, menus, feedback strips.
- 13px: cards and panels (`.tm-card`, `.tm-panel`, `.tm-settings__card`).
- 14px: modal panel.
- `999px`: pills, status dots that need round capsules, toggles.

Borders:

- Internal separators: `1px solid var(--hair)`.
- Cards/panels: `1px solid var(--border)`.
- Active/hover emphasis: `var(--border-strong)` or `var(--border-hover)`.
- Do not use colored left borders as status.

Elevation:

- Use `--shadow-menu` for overlays only: `.tm-taskmenu__menu`, `.overflow__menu`,
  `.tm-modal__panel`, `.info-tip__bubble`.
- Cards may use the existing subtle 0 1px 2px shadow. Do not stack shadows.

Motion:

- Hover/focus transitions stay 120ms.
- Toggles and disclosure chevrons can use 120ms-160ms.
- `tm-pulse` means running/pending attention.
- `tm-spin` means active work.
- `tm-shimmer` is allowed only for indeterminate progress.

## C. Core Components

_Reasoning: These components are the vocabulary engineers should reuse. The
chosen anatomy is what already exists in the app; new variants should be added
only when they remove duplication across screens._

### Buttons

Anatomy: label, optional leading icon, optional loading text. Icons are
functional, not decorative.

Variants:

- Primary: `.primary-button`, `.tm-newtask`, `.tm-settings__button--primary`.
  Use for the one action that advances the workflow.
- Secondary: `.outline-button`, `.tm-settings__button`.
  Use for configuration, retry, refresh, or alternate paths.
- Destructive: `.danger-button`, `.outline-button--danger`.
  Use only for irreversible or removal actions.
- Icon-only: `.tm-iconbtn`, `.tm-prstatus__refresh`,
  `.tm-taskmenu__trigger`.
  Use for utility actions and repeated row actions.

Sizing:

- 36px height for primary page/task actions.
- 32px height for settings and compact panel actions.
- 30px or 28px square for icon-only controls.

States:

- Hover changes background or border only.
- Active/selected uses `var(--surface2)` or `var(--accent)` depending on role.
- Disabled uses reduced opacity and neutral text; keep disabled reason in a
  title/tooltip or nearby existing status row.
- Loading keeps the action label stable and uses disabled or busy state for
  feedback. Do not resize buttons by swapping labels during work.

Do: keep `Finish setup` as the only primary action in the setup footer.
Do not: place another primary `Finish setup` or large repeated Settings button
elsewhere on the same screen.

### Inputs And Controls

Anatomy: label (`.tm-settings__k`), hint (`.tm-settings__hint`), control group
(`.tm-settings__controls`), value/input/select.

Variants:

- Full form fields: `.field input`, `.field textarea`, `.field select`.
- Settings controls: `.tm-settings__select`, `.tm-settings__input`.
- Segmented controls: `.tm-segtoggle`, `.segmented`, `.segmented-effort`.
- Toggle: `.network-toggle`.

Sizing:

- Full form controls are 42px tall.
- Settings controls are 32px tall.
- Segmented settings buttons are 26px-30px tall.

States:

- Focus uses the existing outline or box-shadow based on `var(--accent)`.
- Custom executable paths use the Settings executable row pattern, not a new
  setup-only editor.
- Test feedback uses `.tm-exec__test`; passive status stays compact.

Do: reuse `ModelSettingRow`, `ExternalToolSettingRow`, and
`ExecutableSettingRow`.
Do not: duplicate settings persistence or path validation inside a first-launch
component.

### Status Dot

Anatomy: 6px-9px dot, neutral label, optional mono value.

Implementation anchors:

- `.status-pill__dot`
- `.tm-prstatus__dot`
- `.tm-prcheck__dot`
- `.tm-reviewcard__dot`
- `.tm-setup-tools__dot`
- `.tm-modal__requirement-dot`

States:

- Neutral: `--neutral`
- Info/running: `--info`, optional `tm-pulse`
- Action/waiting: `--action`, optional `tm-pulse`
- Success: `--success`
- Error: `--error`

Do: show `dot + Available` with `Available` in neutral text.
Do not: make `Available` green, add a green border, and tint the row.

### Card And Panel

Anatomy: title/header, compact body, optional action cluster, optional row list.

Variants:

- Task card: `.tm-card`
- Generic panel: `.tm-panel`
- Settings card: `.tm-settings__card`
- Review gate: `.tm-reviewcard`
- Setup surface: `.tm-setup__panel`

Sizing:

- Border radius 13px.
- Border `1px solid var(--border)`.
- Internal padding 11px-18px depending density.

States:

- Hover changes border only.
- Selected uses `var(--surface2)` or `var(--border-strong)`.
- Error state should use a dot or concise banner, not a colored card shell.

Do: one panel containing related rows.
Do not: put card-looking sections inside a card-looking parent.

### List Row

Anatomy: leading dot/icon if stateful, primary label, muted hint, trailing value
or action.

Implementation anchors:

- `.tm-settings__row`
- `.tm-setup-tools__row`
- `.tm-prcheck > summary`
- `.tm-finding summary`
- `.tm-modal__requirement`

Sizing:

- 8px-14px vertical padding for dense lists.
- Use `var(--hair)` between rows.

States:

- Hover background may be `var(--surface2)` for clickable rows.
- Disabled values use `var(--faint)`.
- Trailing mono values use `--font-mono`.

Do: show Git status once in the validation list.
Do not: repeat it in a second summary card unless the second placement enables a
different action.

### Tabs

Anatomy: `.tm-tabs` container, `.tm-tab`, optional `.tm-tab__badge`.

Rules:

- Active tab uses neutral text and a 2px `var(--accent)` underline.
- Badges are counters, not status indicators.
- Tabs switch information mode; they do not trigger workflow actions.

Do: Overview / Diff / Evidence / Review.
Do not: use tabs for Add repository / Verify tools / Finish setup.

### Disclosure

Anatomy: `details` row, summary, chevron, compact body.

Implementation anchors:

- `.tm-prcheck`
- `.tm-finding`
- `.tm-reviewcard__raw`

Rules:

- Summary shows the decision-critical fact.
- Body contains logs, raw output, file refs, and detailed evidence.
- Code output uses `var(--code-bg)`, `var(--code-text)`, and `--font-mono`.

Do: collapsed checks with failed output expanded by user.
Do not: dump all logs inline in the panel body.

### Empty State

Anatomy: modest title, one sentence of context, one primary action, optional
secondary action.

Implementation anchors:

- `.detail--empty`
- `.board-empty`
- `.tm-setup`

Rules:

- Empty states are work surfaces, not landing pages.
- Title uses 18px-19px, not hero scale.
- Copy explains the next action, not the product.
- First-launch setup is the empty repository state and should reuse Settings
  rows/validation logic.

Do: `Add repository` as the first primary action when no repo exists.
Do not: show a blank board or a marketing-style welcome panel.

### Toolbar

Anatomy: title/selection context, utility actions, one primary action.

Implementation anchors:

- `.tm-titlebar`
- `.tm-main__head`
- `.tm-detail__actions`
- `.tm-prstatus__head`
- `.tm-agent__actions`

Rules:

- Utility actions are icon buttons when repeated or low-frequency.
- Keep primary action right-aligned only when it advances the current view.
- Do not place duplicate primary actions in toolbar and panel footer.

### Menu

Anatomy: trigger, menu surface, text actions, danger action if needed.

Implementation anchors:

- `.tm-taskmenu`
- `.tm-taskmenu__menu`
- `.overflow__menu`
- `.tm-filefilter__menu`

Rules:

- Surface uses `--shadow-menu`, `var(--surface)`, radius 10px.
- Menu items are 12px-13px, 6px-7px radius.
- Danger items use error text only; no red filled menu rows.

### Modal

Anatomy: scrim, panel, title, short body, optional requirement list, action row.

Implementation anchors:

- `.tm-modal`
- `.tm-modal__panel`
- `.tm-modal__requirements`
- `.tm-delete-modal`

Rules:

- Use modals for destructive confirmation or blocking choices only.
- Requirement rows use dots; avoid colored panels unless the user may lose data.
- Action row is right-aligned with destructive action visually distinct.

## D. Status & Tone System

_Reasoning: Task Monki has many evidence sources. A consistent dot-led tone
system prevents every source from inventing its own color grammar._

Status anatomy:

1. Dot: 5px-9px, colored by state.
2. Label: neutral text, concise.
3. Optional value: mono text for version, path, branch, SHA, or timestamp.
4. Optional detail: hidden in disclosure or muted line.

Tone mapping:

| Product state | Dot | Label text | Notes |
| --- | --- | --- | --- |
| Idle / not checked / skipped | `--neutral` | `var(--muted)` | No pulse. |
| Informational / running provider context | `--info` | `var(--text)` | Pulse only while active. |
| Waiting for user / pending action | `--action` | `var(--text)` | Primary action should be nearby. |
| Verified success | `--success` | `var(--text)` | Use only after Task Monki observes local evidence. |
| Failure / blocked | `--error` | `var(--text)` | Explain remedy in muted supporting copy. |
| Local evidence | `--evidence` | `var(--text)` | Use for observed Git/test/GitHub facts. |

Color is allowed for:

- Dots.
- Critical errors and destructive confirmation.
- Test feedback after explicit user action.
- The primary button fill.
- Focus rings and selected tab underline.

Color is not allowed for:

- Routine success labels.
- Section titles.
- Card borders for ordinary status.
- Decorative badges.
- Repeated status summaries.

## E. Screen Patterns

_Reasoning: Screens should differ by workflow need, not by decorative layout.
The board scans tasks, detail resolves one task, PR/CI validates delivery, and
review/agent panels expose evidence progressively._

### First-Launch Setup / Empty Repository

Purpose: get from no usable repository to a usable board without duplicating
Settings.

Appearance:

- Use `.tm-setup` as a focused work surface inside `.tm-main`.
- Use one primary panel based on `.tm-settings__card` / `.tm-setup__panel`.
- Replace large numbered step boxes with compact row anatomy:
  status dot, row label, one muted hint, trailing action or value.
- Keep one compact validation rail only if it adds information not present in
  the rows. Otherwise remove the side status card.
- The finish action appears once, in the bottom-right or final row, using
  `.tm-settings__button--primary`.

Flow:

- Appears when `resolveRepositorySetupState` returns `loading`,
  `needsRepository`, or `needsReview`, and the current view is not Settings.
- Does not appear after `firstLaunchSetupCompleted` is true and an active
  repository exists.
- Settings remains accessible as the full configuration surface through normal
  navigation, but setup must not include a Settings button that pulls users out
  of the first-launch flow.
- The setup page reuses `selectSettingsModels`, `ModelSettingRow`,
  `ExecutableSettingRow`, `ExternalToolSettingRow`, `onRefreshExternalTools`,
  `onTestExternalTool`, and `onSetAppSettings`.
- When discovery cannot find Git, Codex, or GitHub CLI, setup reveals the shared
  `ExecutableSettingRow` inline for that tool. Healthy auto-detected tools stay
  as compact status rows.
- Repository validation shows selected repo, Git, Codex, and optional GitHub CLI.
  Git and Codex block finishing; GitHub CLI affects PR delivery only.
- Finishing setup re-checks Git and Codex, then persists
  `firstLaunchSetupCompleted: true` and returns to the board.

Screenshot review decision:

- Do not render a repeated right-side `Setup status` when the validation rows
  already show Repository, Git, Codex, and GitHub CLI.
- Remove large numeric boxes; use dots or compact step labels.
- Keep `Re-check` as one quiet icon/action, not both a row button and a status
  card button.
- Do not place a Settings action inside setup; defaults that matter for first
  launch should be editable inline.
- Keep success text neutral; only the dot uses `--success`.

### Board

Purpose: scan pipeline state.

Layout:

- `.tm-board` with 24px side padding and horizontal columns.
- `.tm-col__head` uses dot, label, count.
- `.tm-card` carries task title, ID, repo metadata, and a short evidence strip.

Hierarchy:

1. Column label and count.
2. Card title.
3. Task ID/repo metadata.
4. Evidence dots and compact mono facts.
5. Hover-only card menu.

Rules:

- Cards do not use tinted backgrounds for status.
- Attention appears once per card.
- Empty columns use dashed/quiet empty copy, not full panels.

### Task Detail, Two Column

Purpose: resolve one task with action and evidence in view.

Layout:

- Header: `.tm-detail__head`, title, IDs, action cluster.
- Tabs: `.tm-tabs`, `.tm-tab`.
- Body: `.tm-overview` with primary column `1.55fr` and secondary column `1fr`.
- Panels: `.tm-panel`, 16px gaps.

Hierarchy:

1. Task title and current workflow actions.
2. Current decision/review/PR status.
3. Evidence and agent activity.
4. Raw provider/debug detail behind tabs or disclosure.

Rules:

- Keep action labels direct: Start, Continue, Request review, Draft PR, Merge.
- Provider terminology belongs in panels, not top-level headers, unless the user
  is in a debug/evidence tab.

### PR / CI Status

Purpose: answer whether delivery can proceed.

Layout:

- `.tm-prstatus` inside a panel.
- Head row uses title and quiet refresh icon.
- Headline row uses one status dot and one neutral headline.
- Check rows use `.tm-prcheck` disclosures.

Hierarchy:

1. Delivery headline with dot.
2. PR identity/branch/check summary.
3. Primary action if unblocked.
4. Check rows collapsed by default.
5. Failed output only inside expanded `pre`.

Rules:

- Do not duplicate the status in title, headline, and action.
- Failed check label may use `--error-ink`; the row shell stays neutral.
- Refresh is utility, never a primary button.

### Review And Agent Panels

Purpose: make autonomous work auditable without flooding the detail view.

Layout:

- Review gate uses `.tm-reviewcard`.
- Agent controls use `.tm-agent__head`, `.tm-agent__note`, `.tm-agent__actions`.
- Findings use `.tm-reviewfindings` and `.tm-finding`.
- Raw provider data remains collapsed.

Hierarchy:

1. Current review/agent state dot and title.
2. Short state-specific summary.
3. Primary next action.
4. Counts/findings.
5. Raw notes/logs disclosed in place.

Rules:

- Running state may use spinner/progress; completed state does not animate.
- Findings use severity dots and neutral titles.
- Do not treat provider output as verified evidence unless Task Monki observed
  it through local Git/test/GitHub checks.

## F. Content & Voice

_Reasoning: Dense tools become usable when labels are short and non-repetitive.
Task Monki should sound like a local operations tool, not a tutorial._

Style:

- Use sentence case.
- Prefer verbs for actions: Add repository, Re-check, Finish setup, Draft PR.
- Prefer nouns for sections: Repository, Tool status, Review, Evidence.
- Use one short sentence for supporting text.
- Use mono text for paths, versions, branches, IDs, and commands.
- Avoid product education unless it prevents a real mistake.

Terseness rules:

- Titles: 1-4 words.
- Hints: one line where possible.
- Buttons: 1-3 words.
- Error remedy: one clear next step.
- Empty state: title, one sentence, one action.

Anti-repetition checklist:

- Is the same state in both title and body?
- Does a colored dot already communicate the tone?
- Is the action label repeating the explanatory sentence?
- Is the side panel summarizing rows visible in the main panel?
- Can this detail move into disclosure?
- Is this Settings logic already expressed by a shared Settings row?

## G. What We Reject

_Reasoning: These patterns make Task Monki look generated and make workflow
state harder to trust. They are rejected even when they are easy to implement._

- Tinted success/error/info cards for routine status.
  Example to reject: a green bordered card saying `Repository ready` when a
  small success dot and repo name would do.

- Colored status labels.
  Example to reject: green `Available` text in every row. Use a success dot and
  neutral `Available`.

- Badge clusters.
  Example to reject: rows of pills for Git, Codex, branch, PR, review, CI when
  only one or two facts change the next action.

- Large numbered onboarding steps.
  Example to reject: 28px step boxes competing with row labels. Use compact row
  order and one active action.

- Duplicate primary actions.
  Example to reject: `Settings` and `Finish setup` repeated in a side card and
  main panel.

- Decorative icons.
  Example to reject: icons beside every heading. Keep icons for buttons,
  disclosure, menus, and status semantics.

- Gradients, orbs, showcase panels, and hero composition.
  Example to reject: a marketing welcome screen before the board. First launch
  is a setup task.

- Raw logs inline by default.
  Example to reject: full check output visible in the PR card. Use `.tm-prcheck`
  disclosure.

- Provider/debug language in primary workflow UI.
  Example to reject: raw Codex protocol labels in board cards. Keep provider
  detail in evidence/debug surfaces.

- New one-off CSS vocabulary for existing patterns.
  Example to reject: a separate setup-only button/input/card system instead of
  `.tm-settings__button`, `.tm-settings__row`, `.tm-panel`, and `.tm-exec`.
