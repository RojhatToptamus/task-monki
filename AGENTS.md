# Agent Guide

This file is the first stop for AI agents working in this repository.

## Project

Task Monki is a local task board for running AI coding work in isolated Git
worktrees. It delegates implementation to Codex App Server, while Task Monki
keeps independent evidence for Git, tests, GitHub delivery, workflow state, and
local acceptance.

## Read Before Editing

- `docs/README.md`
  - Documentation map and docs policy.
- `docs/PRODUCT_WORKFLOW.md`
  - Product phases, action rules, and UI priorities.
- `docs/APP_SERVER_ARCHITECTURE.md`
  - App Server process model, records, adapter responsibilities, and recovery
    rules.
- `docs/research/CODEX_REVIEW_WORKFLOW_LIFECYCLE.md`
  - Required reading before changing review, request-changes, stale-review,
    follow-up, or interrupt behavior.
- `docs/research/CODEX_PROTOCOL_AND_COUPLING_NOTES.md`
  - Required reading before changing Codex protocol handling or generated
    bindings.

## Core Invariants

- Task Monki is authoritative for tasks, workflow phase, worktrees, Git state,
  test state, GitHub delivery state, and acceptance.
- Codex is authoritative only for its own App Server, threads, turns, items,
  approvals, plans, settings, models, and usage events.
- Provider output is telemetry, not verified evidence.
- Local Git/test/GitHub checks must be observed by Task Monki before they affect
  workflow or delivery decisions.
- A Codex review is a detached quality gate inside the Review phase.
- Requesting review changes starts follow-up implementation work and belongs in
  In Progress until that work finishes.
- Stale review findings may be shown as context, but they must not be treated as
  current actionable verdicts.

## Common Commands

```sh
npm run typecheck
npm test
npm run build
npm run check:codex-protocol
git diff --check
```

Run targeted tests while iterating, then run the full relevant set before
finishing changes that touch storage, workflow, protocol, or renderer behavior.

## Development Rules

- Keep edits scoped to the requested behavior.
- Do not modify generated protocol files by hand.
- Regenerate protocol bindings only with `npm run generate:codex-protocol`.
- Do not mix protocol regeneration with product behavior changes.
- Keep provider-specific logic inside provider adapters and protocol mapping
  code.
- Keep UI workflow decisions based on Task Monki projections and verified
  evidence, not raw provider events.
- Update docs when behavior or invariants change.

## Docs Policy

Tracked docs should explain current behavior and architecture. Keep private
strategy, future opportunity lists, phase snapshots, generated mockups,
screenshots, and status handoffs out of git. Use `docs/private/`,
`docs/plans/`, or an external private workspace for that material.
