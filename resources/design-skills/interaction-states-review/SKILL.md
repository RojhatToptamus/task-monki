---
name: interaction-states-review
description: Use when the design contains buttons, links, forms, navigation, selection, dialogs, menus, asynchronous actions, or other interactive controls.
---

# Interaction states review

Check each interactive element for the states and feedback that can occur.
Do not add states that the product cannot reach.

## Inventory the controls

List the applicable controls:

- buttons and links
- inputs, selects, checkboxes, radios, and switches
- tabs and navigation items
- selectable cards or rows
- dialogs, menus, popovers, and accordions
- controls that start asynchronous work

## Check applicable states

For each control, check:

- Default: It looks interactive without hover.
- Hover: Pointer users get useful feedback when hover applies.
- Active or selected: The current state is clear without color alone.
- Pressed: The control confirms a direct action when useful.
- Disabled: The state is distinct and the reason is available when needed.
- Focus: Keyboard focus is visible and does not rely on color alone.
- Loading: A real asynchronous action prevents duplicate submission and shows progress.
- Success or error: The action gives clear, recoverable feedback.

Do not require hover movement, shadows, or animation on every element.
Do not use lower opacity as the only hover signal because it can look disabled.
Use the current design-system tokens and interaction patterns.

## Check transitions and motion

Use transitions only when they clarify a state change.
Keep direct control feedback fast.
Use a longer transition only for a larger surface such as a dialog or drawer.
Respect reduced-motion preferences.

## Check behavior

Use semantic controls and expected keyboard behavior.
Keep current tabs, selections, filters, and validation states visible.
Tie form errors to their fields.
Restore focus after a temporary surface closes.

Fix missing applicable states in the same turn.
Run available source and project checks.
Use `browser-verification` to exercise the applicable changed states.
For meaningful motion, inspect enough relevant frames to judge the transition.
Do not use a fixed frame count.
