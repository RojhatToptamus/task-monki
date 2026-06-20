# Phase 3 Plan: GitHub Delivery and Feedback Carry-in

Date: 2026-06-20  
Status: Implemented  
Depends on: Phase 2 isolated mutating local delivery loop

Implementation status log: `docs/phases/PHASE_3_STATUS.md`

## 1. Phase objective

Phase 3 should turn a locally verified `PR_READY` task into a GitHub-backed delivery flow while preserving the evidence-first status model.

Target flow:

```text
PR_READY local task
  → verify fresh local Git/test evidence
  → detect GitHub remote/auth
  → push task branch
  → create or locate draft PR
  → fetch PR/check/status/review/merge facts
  → show GitHub evidence as separate technical truth
  → move to IN_REVIEW only when GitHub confirms a matching PR
  → move to DONE only when completion policy is satisfied
```

Phase 3 also carries forward the usability feedback in `docs/feedback.md`:

- make Codex/event logs more human-readable;
- add a lightweight Refine Prompt button above task creation;
- refactor styling toward CSS tokens and a cleaner macOS-style design.

## 2. Scope and sequencing decision

The original feasibility report labels GitHub delivery as “Phase 2.” The implementation docs used Phase 2 for the isolated local worktree loop. In this repository, Phase 3 now means:

```text
GitHub delivery on top of the completed Phase 2 local evidence model
```

The correct ordering is:

1. Small UX carry-in from feedback, because it reduces confusion before adding more status dimensions.
2. GitHub publication and reconciliation, because PR/check/review/merge facts depend on stable local branch/head/test evidence.
3. Guarded workflow transitions and UI evidence, because GitHub facts must not collapse into the board phase.

## 3. Non-goals

Phase 3 should not include:

- merging PRs;
- deleting remote branches;
- closing PRs or issues;
- changing repository settings or branch protection;
- GitHub Projects synchronization;
- GitHub App/webhook relay production architecture;
- background daemon/helper recovery;
- SQLite migration unless file-backed storage blocks the GitHub slice;
- broad redesign beyond the CSS-token/macOS-style cleanup requested in feedback.

## 4. Required implementation slices

### Slice 3.1: Feedback carry-in and UI clarity

Implement the low-risk feedback tasks before adding GitHub complexity.

Deliverables:

- Human-readable activity summaries so raw Codex JSON/event names are not the main UI surface.
- Better log labels where practical; if raw events remain available, keep them secondary.
- A `Refine Prompt` button above the Create Task form.
- Prompt refinement that turns a short user input into a structured prompt aligned with the selected repository.
- Minimal prompt-refinement implementation; do not overbuild a separate prompt-workflow product.
- CSS custom properties for colors, surfaces, borders, spacing, typography, and shadows.
- Visual cleanup toward a modern macOS desktop style.

Suggested implementation:

- Add a `PromptRefinementService` in the core layer.
- Use a read-only Codex invocation or deterministic fallback to produce:
  - task goal;
  - repository/context notes;
  - constraints;
  - acceptance criteria;
  - verification expectations.
- Expose it through Electron IPC and the dev API.
- Keep the renderer interaction simple: user writes a short prompt, clicks `Refine Prompt`, gets the textarea replaced or populated.

Acceptance evidence:

- A focused unit test proves event-summary formatting converts common Phase 1/2 event payloads into readable text.
- A focused unit test or service smoke proves prompt refinement returns structured prompt sections from short input.
- `npm run typecheck`, `npm test`, and `npm run build` pass.
- `docs/phases/PHASE_3_STATUS.md` records how to view/test the changes.

### Slice 3.2: GitHub capability preflight

Before mutating GitHub, detect whether the repository can support publication.

Deliverables:

- GitHub remote detection from the task repository/worktree.
- Host/repository owner/name parsing for common GitHub HTTPS and SSH remote URLs.
- `gh` availability and version check.
- `gh auth status --hostname github.com` check.
- Explicit remote/auth status persisted as technical evidence.
- Clear recoverable states for missing remote, missing `gh`, expired auth, unsupported host, and permission/SAML failures.

Rules:

- Do not call `gh auth token`.
- Do not extract or store GitHub tokens.
- Use JSON output when available.
- Keep GitHub status separate from local Git status.

Acceptance evidence:

- Unit tests for GitHub remote URL parsing.
- A fake-CLI test for preflight outcomes.
- UI shows GitHub capability status without creating or pushing anything.

### Slice 3.3: Branch publish service

Push the Phase 2 task branch only after local evidence is fresh enough.

Deliverables:

- Guard that requires:
  - task worktree present;
  - current Git snapshot available;
  - no conflicted/unavailable Git state;
  - current-generation tests passed or an explicit configured override path.
- `git push --set-upstream origin HEAD` or equivalent branch-specific push from the task worktree.
- Remote ref reconciliation after push.
- Ambiguous push outcome handling: fetch/inspect remote before retry.
- Persisted publication attempt and result events.
- Git status update from committed/unpushed/pushed evidence.

Acceptance evidence:

- Fake/safe integration test that pushes to a local bare remote, not GitHub.
- Guard test that blocks publish when tests are stale/failing.
- Status doc includes exact commands used for local push smoke.

### Slice 3.4: Draft PR creation and idempotent PR discovery

Create or locate a draft PR for the intended branch/head SHA.

Deliverables:

- PR description artifact generated from:
  - task title/prompt;
  - local test result;
  - Git diff summary;
  - Codex final artifact summary if available;
  - known limitations.
- Idempotent “create or find PR” service:
  - search for existing open PR from intended head branch;
  - verify PR head SHA/branch before reusing;
  - create draft PR only if no matching PR exists;
  - treat ambiguous create failures as reconciliation-required.
- Persisted `pull_request_snapshot`.
- `IN_REVIEW` workflow transition only after GitHub confirms a matching open PR.

Acceptance evidence:

- Fake `gh` tests for existing PR, new draft PR, and ambiguous failure.
- If live GitHub testing is authorized later, use a temporary branch/PR and do not merge/close/delete.
- UI shows PR URL, draft/open state, head SHA, and last fetched time.

### Slice 3.5: PR/check/status/review/merge reconciliation

Fetch and persist GitHub delivery truth.

Deliverables:

- PR snapshot fields:
  - number;
  - URL;
  - state;
  - draft flag;
  - head ref;
  - head SHA;
  - base ref;
  - merged flag/time.
- CI/check evidence for the exact PR head SHA:
  - check runs;
  - legacy commit statuses;
  - all-observed rollup;
  - required-check rollup when branch/rules visibility allows it;
  - `UNKNOWN` when required-check visibility is unavailable.
- Review evidence:
  - review decision;
  - latest review states where available;
  - requested reviewers where available;
  - stale review concerns bound to head SHA.
- Merge evidence:
  - merged versus closed-unmerged distinction;
  - merge observation as authoritative completion evidence.
- Freshness/staleness timestamps and visible last-synced state.

Rules:

- Do not aggregate checks across old head SHAs.
- Do not treat no checks as passing when permissions/API visibility is unknown.
- Do not infer merge from local ancestry.
- Do not move to `DONE` unless completion policy is satisfied.

Acceptance evidence:

- Unit tests for rollup logic around passing/failing/pending/stale/unknown check data.
- Fake `gh` JSON fixtures for PR/check/review/merge states.
- UI shows GitHub PR/check/review/merge as separate badges.

### Slice 3.6: Guarded GitHub workflow transitions

Connect GitHub evidence to workflow movement without corrupting technical truth.

Deliverables:

- `PR_READY → IN_REVIEW` guard requires matching open PR for intended branch/head SHA.
- `IN_REVIEW → DONE` guard requires configured completion policy.
- Default PR-based completion policy: `MERGED`.
- Closed-unmerged PR creates a blocked/warning finding, not `DONE`.
- Stale/offline GitHub state blocks hard delivery transitions.
- Manual override path records reason and remains visually distinct from normal success.

Acceptance evidence:

- Transition guard tests for:
  - no PR;
  - matching draft PR;
  - checks pending/failing;
  - merged PR;
  - closed-unmerged PR;
  - stale GitHub state.
- Status doc includes example states and how to reproduce them.

## 5. Phase 3 completion criteria

Phase 3 is complete only when all are true:

- Feedback tasks from `docs/feedback.md` are implemented or explicitly deferred with reason in status docs.
- The app can detect GitHub remote/auth capability without storing tokens.
- The app can push the task branch after local evidence guards pass.
- The app can create or locate a draft PR idempotently.
- The app persists GitHub PR, check/status, review, and merge evidence separately from local Git/tests/Codex.
- The UI shows GitHub evidence as separate dimensions.
- `PR_READY → IN_REVIEW` is blocked until a matching GitHub PR exists.
- `IN_REVIEW → DONE` is blocked until the configured completion policy is satisfied.
- GitHub stale/offline/unknown states do not become success.
- Focused tests cover parsing, idempotency, rollups, and transition guards.
- `docs/phases/PHASE_3_STATUS.md` contains implementation notes and how to view/test.
- `npm run typecheck`, `npm test`, and `npm run build` pass.

## 6. Documentation update requirement

After each Phase 3 slice, update `docs/phases/PHASE_3_STATUS.md`.

Each update must include:

- what was implemented;
- files changed;
- how to view/test;
- verification evidence;
- known limitations;
- remaining feedback items;
- next intended slice.

Before starting any Phase 3 implementation turn, read:

```text
docs/feedback.md
docs/phases/PHASE_3_PLAN.md
docs/phases/PHASE_3_STATUS.md
STATUS_MODEL_REPORT.md
```

Do not let feedback or GitHub behavior assumptions live only in chat.
