---
name: final-polish
description: Use for a first complete build, a large redesign, or an explicit final polish request that needs a broad same-turn quality gate before Preview cutover.
---

# Final polish

Use this thin coordinator for a broad quality review.
Do not repeat the detailed checks here.
Read and apply the focused skills in this order:

1. `accessibility-review`
2. `generic-design-review`
3. `hierarchy-rhythm-review`
4. `interaction-states-review` when the surface is interactive

Read each exact skill path from the validated Task Monki catalog.
Run the passes yourself in the current Design turn.
Do not start another agent, reviewer, hidden turn, or screenshot flow.

## Set the scope

Review the complete requested surface for a first build or large redesign.
For an explicit final polish request, inspect the current deliverable and preserve its approved direction.
If the structure is incomplete, finish the requested structure before polish.

## Combine findings before fixes

Collect findings from all applicable focused reviews.
Merge duplicates and group them as:

- accessibility blockers
- product and interaction problems
- hierarchy or consistency problems
- visual polish opportunities

Fix confirmed blockers and product problems first.
Then fix quality issues that remain in scope.
Preserve brand-backed choices and note false positives.

## Verify and report

Run available local lint, type, test, and build checks that match the project.
Recheck the changed source after fixes.
Do not use a canvas screenshot.
Do not claim rendered visual proof.

Report `prototype-ready` when the source and available checks pass.
Do not report `production-ready` without the product, content, browser, accessibility, and deployment checks that production needs.
List known limits briefly.
