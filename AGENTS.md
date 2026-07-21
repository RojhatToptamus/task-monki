# Agent Guide

This file is the first stop for AI agents working in this repository.

## Project

Task Monki is a local task board for running AI coding work in isolated Git
worktrees. It delegates implementation to first-class agent runtimes while Task
Monki keeps independent evidence for Git, tests, GitHub delivery, workflow
state, and local acceptance.

## Read Before Editing

- `docs/README.md`
  - Documentation map and docs policy.
- `docs/PRODUCT_WORKFLOW.md`
  - Product phases, action rules, and UI priorities.
- `docs/APP_SERVER_ARCHITECTURE.md`
  - Codex-specific App Server process, protocol, and recovery rules.
- `docs/architecture/AGENT_RUNTIME_ARCHITECTURE.md`
  - Runtime registry, identity, provider capability, routing, and recovery
    rules shared across integrations.
- `DESIGN.md`
  - Frontend and design guidance for coherent Task Monki UI changes.
- `docs/workflows/AGENT_REVIEW_WORKFLOW_LIFECYCLE.md`
  - Required reading before changing review, request-changes, stale-review,
    follow-up, or interrupt behavior.
- `docs/workflows/PR_STATUS_CARD_FLOW.md`
  - Required reading before changing PR Status, GitHub delivery evidence, or
    merge/check completion rules.
- `docs/architecture/CODEX_PROTOCOL_AND_COUPLING_NOTES.md`
  - Required reading before changing Codex protocol handling or generated
    bindings.

## Core Invariants

- Task Monki is authoritative for tasks, workflow phase, worktrees, Git state,
  test state, GitHub delivery state, and acceptance.
- Each agent runtime is authoritative only for its own processes, sessions,
  turns, items, approvals, plans, settings, models, and usage events.
- Provider output is telemetry, not verified evidence.
- Local Git/test/GitHub checks must be observed by Task Monki before they affect
  workflow or delivery decisions.
- An agent review is a detached quality gate inside the Review phase.
- Requesting review changes starts follow-up implementation work and belongs in
  In Progress until that work finishes.
- Stale review findings may be shown as context, but they must not be treated as
  current actionable verdicts.

## Common Commands

```sh
npm run typecheck
npm run check:architecture
npm test
npm run test:renderer:dom
npm run build
npm run check:codex-protocol
git diff --check
```

Run targeted tests while iterating, then run the full relevant set before
finishing changes that touch storage, workflow, protocol, or renderer behavior.

## Seeded UI And Workflow Testing

- Before testing UI or workflow states, run `npm run dev:seed` and use the
  generated `.local/task-monki-dev-seed/manifest.json`.
- Start local development from the generated environment:
  `source .local/task-monki-dev-seed/dev-api.env`, then `npm run dev:api` and
  `npm run dev:renderer`.
- Use stable scenario slugs such as `[seed:delivery-checks-failed]` instead of
  guessing app state or manually clicking through setup.
- If an important state is missing, extend `src/dev/seedData.ts` and
  `src/dev/seedData.test.ts`; do not rely on stale static fixtures or
  hand-edited store JSON.
- `scripts/serve-readme-screenshot-data.mjs` is screenshot-only legacy data and
  is not authoritative for workflow testing.

## Development Rules

- Keep edits scoped to the requested behavior.
- Before introducing a patch, understand why the issue happens. Then ask why it
  is happening now, why it did not happen before, and what changed in state,
  data, lifecycle, timing, or dependencies.
- Review nearby code and similar cases elsewhere in the repo before choosing an
  approach. Prefer existing patterns, state transitions, guards, and helper
  APIs over new one-off logic.
- Do not make the first solution "patch until it works." A fix should explain
  the underlying cause, preserve the product invariants, and avoid creating a
  second inconsistent path.
- Do not modify generated protocol files by hand.
- Regenerate protocol bindings only with `npm run generate:codex-protocol`.
- Do not mix protocol regeneration with product behavior changes.
- Keep provider-specific logic inside provider adapters and protocol mapping
  code.
- Keep UI workflow decisions based on Task Monki projections and verified
  evidence, not raw provider events.
- Update docs when behavior or invariants change.
- Do not commit, push, reset, clean, or discard changes unless the user
  explicitly asks. Treat unknown working-tree changes as user-owned.

## Where Code Belongs

- `src/core`
  - Domain logic, storage, projection, orchestration, provider adapters,
    process supervision, Git/test/GitHub services.
- `src/renderer/model`
  - Pure renderer selectors, derived UI state, formatting helpers, and
    testable view-model logic.
- `src/renderer/ui`
  - Presentation components and user interactions. Avoid putting workflow
    truth here.
- `src/shared`
  - Contracts and types shared by core and renderer. Changes here can affect
    stored data and IPC/API compatibility.
- `docs`
  - Current operational docs only. Private plans, status snapshots, mockups,
    screenshots, and roadmap notes should stay ignored.

## Investigation First

When fixing a bug or changing behavior:

1. Reproduce or identify the observed failure.
2. Trace the source of truth: domain event, stored record, projection, selector,
   UI state, provider event, or local evidence.
3. Compare the current path with similar existing paths.
4. Identify the smallest invariant-preserving fix.
5. Add or update tests that would have caught the issue.
6. Run the relevant verification commands.

Avoid fixes that only hide the symptom in the renderer while leaving storage,
projection, or provider state inconsistent.

## React And Renderer Rules

- Before adding `useEffect`, read the React escape-hatches guidance:
  https://react.dev/learn/escape-hatches
- Treat effects as synchronization with systems outside React, not as the
  default way to derive render data or handle user events.
- If an effect subscribes, starts timers, launches async work, observes DOM, or
  touches external state, it must have clear cleanup or cancellation behavior.
- Prefer derived values, event handlers, reducers, selectors, or explicit state
  transitions over effect-driven state copying.
- Keep expensive filtering, grouping, parsing, and projection work out of hot
  render paths. Use existing selectors or memoization only when it removes real
  repeated work.
- Do not let UI-only state become a second source of truth for task workflow,
  run status, review status, Git state, or delivery state.

## UI Design Rules

- UI changes must feel like they belong to the existing app. Do not create
  disconnected, novelty, or "showcase" components for a single feature.
- Reuse existing layout patterns, components, typography, spacing, buttons,
  chips, cards, panels, and CSS tokens from the shared styles before adding new
  classes.
- Add new CSS only when the existing system cannot express the needed state, and
  keep it consistent with the surrounding selectors in the appropriate
  `src/renderer/styles/*` feature stylesheet. Keep `src/renderer/styles.css`
  limited to the intentional cascade import order.
- Do not add explanatory product copy just to justify an implementation detail.
  If behavior changes, reflect it through the correct state, available actions,
  disabled reasons, and concise labels.
- Avoid awkward labels that narrate internal logic, such as "review without
  changing status" or similar implementation disclaimers. Users should see what
  state the task is in and what they can do next.
- Keep provider/debug terminology out of primary workflow UI unless the user is
  explicitly in a debug surface.
- Prefer clear action labels over instructional paragraphs. Use detailed text
  only when it prevents a risky or irreversible user mistake.
- Before shipping a UI change, compare nearby screens and states so the new
  state does not create a one-off visual language.

## UI Verification

- For visible UI changes, run or inspect the rendered app when feasible. Do not
  rely only on static code review for layout, hierarchy, or state clarity.
- Check the affected states, not only the default happy path: empty, loading,
  running, disabled, error, stale, canceled, and completed.
- When a change is theme-sensitive, check both light and dark themes.
- Check common viewport widths when touching layout, headers, sidebars, panels,
  cards, drawers, or modals.
- Verify that disabled actions explain the reason in the existing UI style
  without adding noisy implementation copy.

## Implementation Quality And Performance

- Consider performance, memory, CPU usage, and lifecycle cleanup as part of each
  feature, not as a later cleanup pass.
- Avoid designs that introduce orphaned processes, leaked file descriptors,
  unbounded buffers, unbounded protocol journals in memory, repeated expensive
  recomputation, unnecessary background polling, or main-thread blocking.
- Bound growth for provider items, transcripts, protocol-derived views,
  search/filter results, cached previews, artifacts, and other accumulative
  state.
- Keep long-running or cancelable work tied to explicit lifecycle ownership:
  task, run, session, server instance, request, or component.
- Prefer immutable records and derived projections for workflow state. Do not
  mutate historical provider evidence to make the current UI easier.
- Keep provider telemetry compact in normal UI. Raw protocol detail belongs in
  debug surfaces and artifacts.

## Storage And Schema Rules

- Treat stored contracts as durable. Changes to `src/shared` contracts,
  `FileTaskStore`, domain events, run/session records, artifacts, or projections
  need explicit compatibility thinking.
- If stored shape changes, update schema/version intentionally and add tests for
  initialization, loading, repair, or rejection behavior.
- Do not silently reinterpret old data unless there is a tested repair or
  migration path.
- Keep raw provider protocol data separate from normalized Task Monki records
  and projections.
- Projection changes must preserve the core invariants: Task Monki owns
  workflow and evidence; provider state is telemetry.

## Testing Rules

- Write tests to discover real issues in the app, not tests shaped only to pass
  the current implementation.
- Cover realistic workflows, edge cases, failure paths, regressions, and
  cross-component behavior when a change touches app-level state.
- A passing test suite is not enough if the tests do not exercise the risky
  behavior introduced or changed by the feature.
- Put pure domain logic in `src/core` and cover it with focused Vitest tests.
- Put renderer-only pure logic in `src/renderer/model` or small testable helpers
  and cover it with Vitest tests.
- Add regression tests for workflow transitions, provider-run reconciliation,
  review lifecycle, stale review handling, cancellation/interrupt behavior,
  settings persistence, Git/test evidence projection, and request/approval
  state when those areas change.
- Regression tests should fail on the old bug. Prefer assertions against
  user-visible behavior or domain state over brittle implementation details.
- For React UI behavior, prefer small model/selector seams plus focused
  component-level or browser/manual verification until a broader UI test target
  exists.
- When provider behavior is involved, include tests for stale IDs, ambiguous
  delivery, missing terminal events, process loss, and local reconciliation when
  feasible.

## Completion Report

- Summarize what changed and why.
- List the tests or verification commands that ran.
- Call out anything not verified.
- Do not claim a behavior is fixed unless it was exercised by tests, manual
  verification, or a clearly explained code-path check.

## Docs Policy

Tracked docs should explain current behavior and architecture. Keep private
strategy, future opportunity lists, phase snapshots, generated mockups,
screenshots, and status handoffs out of git. Use `docs/private/`,
`docs/plans/`, or an external private workspace for that material.
