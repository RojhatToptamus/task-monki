---
name: aesthetic-direction
description: Use for greenfield visual work with no existing brand or design system, or for an explicit major visual redesign.
---

# Aesthetic direction

Commit to a visual system before you build high-fidelity greenfield work.
A vague goal such as "modern and clean" usually produces a generic result.

## Confirm the starting point

Inspect the project for a brand, product style, design system, theme, tokens, components, and local fonts.
Inspect active references and the latest ready source.

If a system exists, preserve it unless the user requests a redesign.
Use `design-system-inspection` instead of inventing a new system.

If no system exists and the brief is clear, choose a direction yourself.
If the missing direction can change the main result, use one combined discovery round.

## Connect the direction to the brief

Choose three useful qualities for the intended experience.
Connect every choice to the audience, subject, and main action.
Add one signature idea that gives the work a clear identity.
Do not add decoration that has no product purpose.

Commit on these axes:

- Typography: Select one or two local or browser-safe font families with clear roles.
- Color: Select a warm, cool, or neutral tone with clear surface, text, action, and state roles.
- Density: Select compact, normal, or spacious spacing for the product use.
- Shape: Select a consistent radius, border, and elevation approach.
- Components: Select clear primary and secondary control styles.
- Imagery: Use licensed local assets or honest placeholders.
- Motion: Use quiet, expressive, or no motion based on the task.

Do not assume paid fonts, remote fonts, remote images, or public icon packages.
Do not choose a familiar AI house style without a reason from the brief.
Warm editorial styling, bright gradients, large rounded cards, and glass effects are valid only when the context supports them.

## Define the system in source

Create a small set of CSS custom properties or use the current project's token format.
Define only values that the requested interface needs.
Do not create a separate token document or framework for a small prototype.
Use the selected values consistently instead of adding unrelated inline values.

Build the complete requested surface with this direction.
Review the result with `generic-design-review` and `hierarchy-rhythm-review` when the change is broad.
