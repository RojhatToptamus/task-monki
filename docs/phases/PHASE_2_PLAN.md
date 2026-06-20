# Phase 2 Plan: Isolated Mutating Local Delivery Loop

Date: 2026-06-20  
Status: Implemented  
Depends on: Phase 1 read-only Codex run monitor

Implementation evidence: `docs/phases/PHASE_2_STATUS.md`

## 1. Phase objective

Phase 2 turns the Phase 1 read-only monitor into a controlled local implementation loop:

```text
task intent
  → create isolated branch/worktree
  → run Codex with mutation limited to that worktree
  → capture process and Codex evidence
  → inspect Git delta
  → run configured local checks
  → project truthful workflow/readiness status
  → let the human decide whether to prepare delivery
```

Phase 2 should not create, push, merge, close, or delete GitHub pull requests. GitHub delivery belongs after the local generation, Git snapshot, and test evidence model is reliable.

## 2. Why this phase comes before GitHub delivery

The feasibility and status-model reports both identify evidence integrity as the core product risk. GitHub PR status is only meaningful when it is bound to the correct branch and head SHA.

Phase 2 therefore establishes:

- one task iteration owns one branch and one worktree;
- Codex mutates only the task worktree;
- Git snapshots distinguish dirty, committed, unpushed, pushed, conflicted, and missing states;
- test results bind to the exact `HEAD` and dirty-worktree fingerprint they verified;
- workflow movement is guarded by evidence instead of Codex prose.

Once this exists, a later GitHub delivery phase can safely create PRs, read check/status rollups, fetch reviews, and observe merge state.

## 3. Non-goals

Phase 2 intentionally does not include:

- GitHub PR creation or merging;
- remote branch deletion;
- protected-branch or repository settings changes;
- GitHub Projects or issue tracker sync;
- SQLite migration unless the file-backed store blocks the phase;
- Codex App Server integration;
- background job recovery across app restarts beyond what is necessary to show honest orphaned/unknown state.

## 4. Required implementation slices

### Slice 2.1: Task iteration and action model

Add explicit task iteration/action data so mutating work is not confused with the Phase 1 read-only run.

Deliverables:

- `TaskIteration` concept or equivalent persisted structure.
- `ActionRequest`/attempt identity for start, cancel, test, and refresh operations.
- Generation keys that bind worktree, Codex run, Git snapshot, and tests.
- Projection changes that keep workflow phase separate from technical truth.

Acceptance evidence:

- Existing Phase 1 tests still pass.
- New tests prove an old Codex run cannot overwrite the current task iteration projection.
- Status document updated with what changed and how to test it.

### Slice 2.2: Worktree and branch service

Add an app-owned worktree service around Git.

Deliverables:

- Worktree root under an app-controlled local path, configurable for development.
- Branch naming policy, for example `codex/task-<task-id>-<short-title>`.
- `git worktree add` wrapper with structured errors.
- `git worktree list --porcelain -z` parser.
- Worktree verification and ownership metadata.
- Guard preventing two active tasks from owning the same branch/worktree.
- Safe cleanup policy that never force-removes dirty worktrees automatically.

Acceptance evidence:

- Unit tests for worktree list parsing and branch naming.
- Integration smoke that creates a temporary worktree from this repo in `/private/tmp`, verifies it, and removes it only when clean.
- UI shows worktree status: creating, present, missing, error, or unknown.

### Slice 2.3: Mutating Codex run inside isolated worktree

Run Codex implementation prompts in the task worktree instead of the main repository.

Deliverables:

- Runner mode that uses `--cd <task-worktree>`.
- Explicit sandbox and approval policy per action.
- Prompt preamble that includes task scope and safety constraints.
- Cancellation behavior that records both requested cancellation and terminal process/Codex facts.
- Raw stdout/stderr/JSONL artifacts retained as in Phase 1.

Acceptance evidence:

- A smoke test proves the main repository remains unchanged while the task worktree receives any generated edits.
- A fake-runner test proves process completion alone does not imply delivery.
- UI clearly labels the worktree path used for the run.

### Slice 2.4: Git snapshot and diff evidence

Add structured Git state capture for task worktrees.

Deliverables:

- Snapshot fields for repo root, worktree path, branch/ref, `HEAD`, base SHA, upstream, ahead/behind counts, staged/unstaged/untracked/conflicted counts, operation-in-progress, and diff stat.
- Dirty fingerprint for staged, unstaged, and relevant untracked content.
- Diff artifact capture suitable for human review.
- Projection status for Git: clean, dirty, committed-unpushed, pushed, conflicted, diverged, unavailable, unknown.

Acceptance evidence:

- Unit tests for porcelain status parsing.
- Integration smoke creates a harmless file in a temporary worktree and verifies Git snapshot/diff projection.
- UI evidence panel shows diff summary and artifact link/content.

### Slice 2.5: Local test runner and stale-test detection

Add a test/check runner that evaluates the exact current generation.

Deliverables:

- Configurable test command per repository or task.
- Process-supervised test execution with stdout/stderr artifacts.
- Test statuses: not configured, not run, queued, running, passed, failed, error, canceled, stale, unknown.
- Binding to tested `HEAD` and dirty fingerprint.
- Stale marking when `HEAD` or dirty fingerprint changes after a test run.

Acceptance evidence:

- Unit tests for stale detection.
- Integration smoke runs a safe configured command such as `npm run typecheck` or `npm test`.
- UI separates Codex completion from local test result.

### Slice 2.6: Guarded workflow transitions

Make card movement reflect evidence-backed workflow, not direct technical mutation.

Deliverables:

- Guarded transition rules for `READY → IN_PROGRESS`, `IN_PROGRESS → REVIEW`, `REVIEW → TESTING`, and `TESTING → PR_READY`.
- Clear blocked/warning findings when evidence is missing or contradictory.
- No general `FAILED` workflow phase.
- Retry and refresh actions that re-run evidence gathering without erasing history.

Acceptance evidence:

- Tests for transition guards.
- UI shows why a transition is blocked or recommended.
- Status document includes example card states and how to reproduce them.

## 5. Phase 2 completion criteria

Phase 2 is complete only when all are true:

- A task can create or reuse an isolated app-owned worktree.
- A mutating Codex run can execute in that worktree without modifying the main checkout.
- The app records Codex, process, worktree, Git, and artifact evidence separately.
- The app captures a Git diff summary/artifact after the run.
- A configured local test command can run and bind its result to the current Git generation.
- Test results become stale after code changes.
- UI exposes workflow phase plus technical evidence badges.
- At least one end-to-end local smoke test is documented in `docs/phases/PHASE_2_STATUS.md`.
- `npm run typecheck`, `npm test`, and `npm run build` pass.

## 6. Status update requirement

After each Phase 2 slice, update `docs/phases/PHASE_2_STATUS.md` before handing off or committing.

Each update must include:

- what was implemented;
- files changed;
- how to view or test the implemented behavior;
- exact verification commands and results;
- known limitations;
- the next intended slice.

This is mandatory because future agents should not need the chat history to understand the current implementation state.

## 7. GitHub readiness notes for the next phase

Phase 2 should preserve enough evidence for GitHub delivery:

- stable branch name;
- base ref and base SHA;
- current head SHA;
- clean/dirty state;
- test result bound to current generation;
- PR-ready workflow state that means “safe to publish,” not “delivered.”

The following GitHub work is deferred until the next phase:

- detecting or creating a draft PR from the task branch;
- fetching PR state, check rollups, reviews, mergeability, and merge status;
- reconciling manual GitHub changes;
- treating merge observation as completion evidence.
