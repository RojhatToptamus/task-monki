---
name: accessibility-review
description: Use for interactive work, forms, navigation, broad first builds, major redesigns, or an explicit accessibility review.
---

# Accessibility review

Review the changed source against WCAG 2.2 AA and inclusive interaction practices.
Use source evidence and available project checks.
Use `browser-verification` for applicable keyboard, focus, state, and bounded audit checks.
Use a screenshot only when visual judgment is relevant.
Do not claim that one audit or screenshot proves complete accessibility.

## Pass 1: Structure and content

Check that headings follow a meaningful hierarchy.
WCAG does not require exactly one `h1` on every page.
Use semantic landmarks when they clarify the page.
Use a real button for an action and a real link for navigation.
Give every form control an accessible name.
Use useful alt text for meaningful images and empty alt text for decorative images.
Use ARIA only when native HTML cannot express the behavior.

## Pass 2: Keyboard and focus

Check that each interactive element is keyboard reachable.
Keep tab order consistent with reading order.
Avoid positive `tabindex` values.
Keep focus visible with sufficient contrast.
Support the keyboard pattern for each custom control.
For dialogs, move focus into the dialog, support Escape when appropriate, and restore focus on close.

## Pass 3: Color and contrast

For resolved colors, check WCAG contrast:

- 4.5:1 for normal text
- 3:1 for large text
- 3:1 for essential interface components and focus indicators

Do not use color as the only state signal.
Add text, shape, icon, or position as another signal.
Treat toned whites and blacks as a design choice, not a WCAG rule.

## Pass 4: Forms, targets, and motion

Use specific errors and connect each error to its field.
Use suitable input types and autocomplete values.
Mark required fields in text or semantics, not color alone.
Prevent accidental duplicate submission when a real asynchronous action runs.

WCAG 2.2 AA target size is at least 24 by 24 CSS pixels, with defined exceptions.
Use larger targets when the product context benefits from them.
Do not apply a universal 44-by-44 rule to every desktop control.

Respect `prefers-reduced-motion` for non-essential motion.
Avoid flashing content.

## Fix and report

Complete all applicable passes before you edit.
Merge duplicate findings and fix confirmed issues in the same turn.
Run available lint, type, test, or build checks.
State which checks ran and which visual or assistive-technology checks remain unverified.
