# Task Monki Documentation

Date: 2026-07-14

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
3. `docs/workflows/AGENT_REVIEW_WORKFLOW_LIFECYCLE.md`
   - Authoritative review workflow lifecycle. Read before touching review,
     follow-up, stale-review, or interrupt behavior.
4. `docs/workflows/AGENT_PROGRESS_OVERVIEW.md`
   - Authoritative Overview agent progress and activity model documentation:
     data flow, renderer behavior, evidence boundaries, and invariants.
5. `docs/DEV_SEEDING.md`
   - Deterministic local seed data for UI and workflow testing.
6. `docs/PROVIDER_SMOKE_TESTING.md`
   - Live provider/model verification through TaskManagerService in a clean,
     remote-free throwaway Git repository.

### Architecture

1. `docs/architecture/AGENT_RUNTIME_ARCHITECTURE.md`
   - Current multi-runtime registry, durable identity, routing, capability,
     security, recovery, and extension boundaries.
2. `docs/architecture/PROVIDER_RUNTIME_COMPATIBILITY.md`
   - Current support tiers, native and ACP runtime matrix, readiness
     conditions, provider-specific limits, and execution security boundaries.
3. `docs/architecture/PREVIEW_ARCHITECTURE.md`
   - Canonical Preview authority, lifecycle, native/Compose runtime, security,
     ownership, storage, shutdown, and recovery architecture.
4. `docs/architecture/PREVIEW_RECIPE_GENERATION.md`
   - Agent-assisted Preview recipe authoring, sanitized repository evidence,
     structured drafts, review UX, validation, and exact acceptance boundary.
5. `docs/APP_SERVER_ARCHITECTURE.md`
   - Current Codex App Server integration architecture and responsibility
     boundaries.
6. `docs/architecture/CODEX_PROTOCOL_AND_COUPLING_NOTES.md`
   - Protocol compatibility, generated bindings, and provider-coupling rules.
7. `docs/architecture/ATTACHMENT_LIFECYCLE.md`
   - Current restricted attachment formats (and explicitly unsupported generic
     files/PDFs), composer normalization, durable storage and retry rules,
     Codex delivery, HTTP/Electron trust boundaries, resource limits,
     portability, cleanup, and deletion semantics.

### User And Maintainer Docs

1. `docs/PREVIEW_GUIDE.md`
   - Public Preview workflow, UI actions, recipe reference, native and Compose
     examples, private inputs, attachments, data effects, and troubleshooting.
2. `docs/INSTALL.md`
   - User-facing install, prerequisite, unsigned-build, and manual update
     instructions.
3. `docs/RELEASING.md`
   - Maintainer workflow for unsigned GitHub Releases.

### Interface Design

1. Root `DESIGN.md`
   - Current interface principles, CSS-token rules, component guidance, status
     semantics, accessibility expectations, and UI review checklist.

Window behavior is implemented in `src/electron/main.ts`,
`src/electron/windowChrome.ts`, and `src/renderer/styles.css`. There is no
separate window-chrome design document.

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
- Each runtime is authoritative only for its own process, session, turn, item,
  approval, plan, model, settings, and usage events.
- Provider reports are useful context, not verified evidence.
- Git and GitHub evidence must be observed independently by Task Monki.
- An agent review is a check inside the Review phase; requested changes are
  implementation work and belong in In Progress while they run.

## Useful commands

```sh
npm run typecheck
npm test
npm run build
npm run check:codex-protocol
git diff --check
```

For deterministic UI and workflow testing, start from `npm run dev:seed` and the
generated `.local/task-monki-dev-seed/manifest.json`.

Run targeted tests when iterating, but use the full set above before merging
workflow, storage, protocol, or renderer changes.
