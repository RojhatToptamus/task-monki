---
name: prototype
description: Use when the user requests an interactive prototype, demo, form, application flow, working states, or behavior that must respond to input.
---

# Interactive prototype

Build a working flow with real input, state, and feedback.
A set of static screens is not an interactive prototype.

## Map the requested behavior

Before you build, list the screens or main states in a short source comment or working plan.
For each transition, identify:

- the user action
- the next state
- data that must remain available
- applicable validation
- loading, success, empty, or error feedback

Use the fidelity, device, brand, and sample content from the brief and current project.
If no visual system exists, use `aesthetic-direction`.

## Build in the current stack

Preserve the current framework, components, tokens, and build tools.
For a blank managed Design project, use clean local HTML, CSS, JavaScript, and SVG.
Keep structure and content in `index.html`, styles in `styles.css`, behavior in
`app.js`, and local editable files in `assets/`.
Use the scaffold's relative links. Do not add a framework, package manager,
build step, or dependency.
Use plausible content from the brief.
Do not invent material facts.

Keep one clear primary action in each state.
Keep secondary actions available without giving them equal visual weight.

## Implement applicable states

Wire every requested interaction.
Cover only states that can occur in this prototype:

- navigation and back behavior
- input and selection changes
- specific field validation
- disabled controls with a clear reason
- real loading behavior when an operation is asynchronous
- success, empty, and recoverable error feedback
- modal, menu, or popover focus behavior

Do not add fake delay only to display a loading state.
Do not add `localStorage`, cookies, or other persistence unless the request needs persistence.

Use semantic controls.
Make keyboard order logical.
Keep focus visible.
Return focus when a modal or temporary surface closes.
Support Escape where the interaction pattern requires it.
Respect reduced-motion preferences when motion exists.

## Verify honestly

Inspect the full source flow.
Run available local lint, type, test, or build checks.
Use `interaction-states-review` and `accessibility-review` for the applicable surface.
Use `browser-verification` to exercise the changed controls and states.
Use a screenshot only when appearance needs visual judgment.
Open and verify a fresh candidate after a source correction.
Report untested behavior and simulated data clearly.
