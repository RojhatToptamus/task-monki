---
name: design-system-inspection
description: Use when the project or references contain an existing brand, theme, component library, token system, or visual language that the new work must preserve.
---

# Design system inspection

Read the real source before you design.
Do not rely on memory or invent replacement values.

## Find the sources of truth

Inspect the files and components that own:

- brand and semantic colors
- surface and text roles
- font families, sizes, weights, and line heights
- spacing and layout scales
- radii, borders, shadows, and elevation
- breakpoints and container widths
- motion duration and easing
- common controls, navigation, forms, and content patterns

Check local brand assets and references.
Trace values to their real definitions.
Read representative components to understand how tokens are used.

## Record only useful findings

Keep a short working note or source comment when needed.
Record exact names and values that the current request will use.
Identify gaps and conflicting definitions.
Do not silently merge near-duplicate values.
Do not create a token file, inventory document, or new component library unless the user asks for that deliverable.

## Apply the existing vocabulary

Reuse current components and patterns before you create a new one.
Match the established tone, density, radius, border, elevation, interaction, and copy style.
Preserve current build tools and file organization.

Add a new value only when the requested design needs it and the current system has no suitable value.
Place it in the existing source of truth.
Do not add an isolated value only for convenience.

If the user requests a major redesign, state which current rules you changed and preserve unrelated system choices.
