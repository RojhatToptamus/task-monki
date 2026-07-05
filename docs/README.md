# Task Monki Documentation

Date: 2026-07-02

This folder is the operating context for Task Monki development. It should help
humans and AI agents understand what is current without reading stale planning
snapshots.

## Public Docs

These docs are safe to keep in the repository because they describe current
behavior and architecture, not private roadmap sequencing.

### Workflow And Evidence

1. `docs/PRODUCT_WORKFLOW.md`
   - Product model, board phases, action rules, and UI priority.
2. `docs/workflows/PR_STATUS_CARD_FLOW.md`
   - Current PR Status card behavior, GitHub evidence model, action pauses,
     render matrix, and merge/check completion coupling.
3. `docs/workflows/CODEX_REVIEW_WORKFLOW_LIFECYCLE.md`
   - Authoritative review workflow lifecycle. Read before touching review,
     follow-up, stale-review, or interrupt behavior.

### Architecture

1. `docs/APP_SERVER_ARCHITECTURE.md`
   - Current Codex App Server integration architecture and responsibility
     boundaries.
2. `docs/architecture/CODEX_PROTOCOL_AND_COUPLING_NOTES.md`
   - Protocol compatibility, generated bindings, and provider-coupling rules.

### User And Maintainer Docs

1. `docs/INSTALL.md`
   - User-facing install, prerequisite, unsigned-build, and manual update
     instructions.
2. `docs/RELEASING.md`
   - Maintainer workflow for unsigned GitHub Releases.

### Interface Design

1. `docs/DESIGN_SPEC.md`
   - Current interface principles, CSS token usage, component rules, status
     semantics, screen patterns, and content guidelines.

For agent-specific working instructions, start at root `AGENTS.md`.

## Private Or Ignored Docs

Do not publish roadmap, competitive strategy, temporary status handoffs,
generated mockups, screenshots, or broad opportunity lists. Keep those in one
of:

- `docs/private/`
- `docs/plans/`
- an external private workspace

## Documentation rules

- Prefer one current source of truth over many dated phase notes.
- Keep active behavior docs in `docs/workflows/` or `docs/architecture/`.
  Historical research notes should not be used as the current source of truth.
- When code changes alter workflow behavior, update the matching workflow doc in
  the same change.
- If a doc is a mockup export, temporary screenshot bundle, or old phase status,
  remove it once the durable decision has been captured in markdown.
- Do not let provider telemetry docs override Task Monki's local evidence model.

## Core invariants

- Task Monki is authoritative for tasks, workflow phase, worktrees, Git state,
  GitHub delivery, and acceptance.
- Codex is authoritative only for its own server, thread, turn, item, approval,
  plan, model, settings, and usage events.
- Provider reports are useful context, not verified evidence.
- Git and GitHub evidence must be observed independently by Task Monki.
- A Codex review is a check inside the Review phase; requested changes are
  implementation work and belong in In Progress while they run.

## Useful commands

```sh
npm run typecheck
npm test
npm run build
npm run check:codex-protocol
git diff --check
```

Run targeted tests when iterating, but use the full set above before merging
workflow, storage, protocol, or renderer changes.
