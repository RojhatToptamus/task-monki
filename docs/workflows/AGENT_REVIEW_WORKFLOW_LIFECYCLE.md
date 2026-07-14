# Agent Review Workflow Lifecycle

Date: 2026-07-11

Status: authoritative for review, follow-up, stale-review, and review
interruption behavior.

This document defines the Task Monki review workflow model and the operational
rules for agent review runs, follow-up implementation runs, cancellation,
recovery, and board state. Use it when changing review/session code or
debugging bugs where the UI shows the wrong run as active.

## Conceptual model

Task Monki has two separate concepts that both use the word review:

1. Board Review phase
   - A task workflow phase.
   - Means implementation work is ready for inspection, acceptance, commit, or
     PR creation.
   - The task belongs in the Review board column.

2. Agent review gate
   - A detached AI quality check stored in `projection.codexReview`.
   - Runs as its own `RunRecord` with `mode: "REVIEW"`.
   - Does not become the task's implementation run.
   - Can be `NOT_RUN`, `RUNNING`, `PASSED`, `NEEDS_CHANGES`, `INCONCLUSIVE`,
     `FAILED`, `CANCELED`, or `STALE`.

The important product rule is:

> An agent review is a check inside the Review phase. Requested changes are new
> implementation work and therefore belong in In Progress until the follow-up
> run finishes.

## Main records

- `Task.workflowPhase`
  - Board-level state: Ready, In Progress, Review, Done, etc.
- `Task.currentRunId`
  - The current implementation, follow-up, or retry run.
  - Detached review runs do not replace this as the source implementation run.
- `Task.projection.agentRun`
  - The active or terminal state for the current implementation-side run.
- `Task.projection.codexReview`
  - The local review gate projection for the last agent review. The field name
    is retained for schema-12 store compatibility.
  - Includes the review run id, source run id, reviewed head/dirty fingerprint,
    summary, final artifact id, and structured findings when available.
- `RunRecord.mode`
  - `IMPLEMENTATION`, `FOLLOW_UP`, and `RETRY` modify the task worktree.
  - `REVIEW` inspects a diff and should use read-only settings.
- `AgentSessionRecord`
  - Primary sessions back implementation/follow-up/retry runs.
  - Review sessions use `role: "REVIEW"`. A runtime may use a native review
    primitive, or Task Monki may start an ordinary read-only review turn.

## State flow

### Initial implementation

1. User starts a task.
2. `TaskManagerService.startRun` prepares or verifies the worktree.
3. `AgentOrchestrator.startTurn` creates a run with `mode: "IMPLEMENTATION"`.
4. Reducer moves the task to `IN_PROGRESS`.
5. When the run completes, fails, or is interrupted, reducer moves an
   `IN_PROGRESS` task to `REVIEW`.

Expected UI:

- Board column: In Progress while active.
- Card chip: Running, needs approval, needs input, failed, etc.
- After terminal run: Review column.
- Review gate: `NOT_RUN` unless a previous review exists.

### Starting agent review

1. User clicks Run agent review from a task in Review.
2. `TaskManagerService.startReview` rejects active implementation-side runs.
3. The current source run is kept as the implementation source.
4. `AgentOrchestrator.startReview` creates a `mode: "REVIEW"` run and a review
   agent session.
5. When the selected review runtime is the source runtime and advertises a
   native review primitive, its adapter uses that primitive. Otherwise Task
   Monki materializes a review session in the selected runtime and starts the
   provider-neutral read-only review prompt as a normal turn only when that
   runtime advertises stable detached-review isolation. Runtimes without either
   capability are not eligible review runtimes.
6. Reducer keeps the task workflow phase in Review.
7. `projection.codexReview.status` becomes `RUNNING`.

The review session must carry the configured runtime, model provider, model,
service tier, cwd, and reasoning effort. Cross-runtime review never reuses a
model identifier from the implementation runtime.

For Codex's native path, reasoning effort for `thread/fork` is exposed through the
request `config.model_reasoning_effort` field rather than a top-level `effort`
field. If that config is omitted, the fork can run at the provider default or an
inherited effort such as `xhigh`, making reviews much slower than the user's
selected review setting.

On that Codex path, after creating the review fork, Task Monki must call
`review/start` with
`delivery: "inline"` on that fork. Asking `review/start` for another detached
thread can cause the provider to create a second review thread with a different
cwd, so the AI reviews unrelated local changes instead of the task worktree.

Expected UI:

- Board column: Review.
- Card chip: AI reviewing.
- Review panel: running indicator, concise current review activity, and Stop review.
- Finish actions: paused.
- Review actions: paused except Stop review.
- Agent implementation controls should not be shown for the review run as if it
  were the implementation run.

### Review completion

When the review run emits a terminal event:

- `AGENT_RUN_COMPLETED`
  - Parses `codexReviewResult` when provided.
  - Falls back to native/raw review output parsing.
  - Stores structured findings and summary when available.
  - Status becomes:
    - `PASSED` when verdict passes and no blocking findings override it.
    - `NEEDS_CHANGES` when findings require changes.
    - `INCONCLUSIVE` when there is output but no reliable pass/fail verdict.
- `AGENT_RUN_FAILED` or review policy/runtime failure
  - Status becomes `FAILED`.
- `AGENT_RUN_INTERRUPTED`
  - Status becomes `CANCELED`.
- `AGENT_RUNTIME_RECONCILED`
  - Uses reconciled terminal state to set `INCONCLUSIVE`, `CANCELED`, or
    `FAILED`.

Expected UI:

- `PASSED`
  - Primary path: create draft PR.
  - Secondary/local paths: commit or mark done.
  - Optional path: run review again.
- `NEEDS_CHANGES`
  - Show structured findings by severity.
  - Primary path: Request changes.
  - Secondary path: run review again or use the finish-panel Mark done anyway
    owner override.
- `INCONCLUSIVE`
  - Show raw output and any parsed findings.
  - Allow request changes only because the output is current to this reviewed
    diff.
- `FAILED` or `CANCELED`
  - Prefer re-run or inspect debug details.
  - Request changes is only valid if current review output exists and is useful.

### Requesting changes after review

1. User clicks Request changes from a current actionable review result.
2. The drawer lets the user select findings and edit the instruction.
3. `TaskManagerService.continueRun` starts a `mode: "FOLLOW_UP"` run from the
   source implementation run.
4. Reducer moves the task to `IN_PROGRESS`.
5. Reducer marks the old agent review `STALE`.
6. The old review findings remain visible only as previous-review context.

Expected UI while follow-up is active:

- Board column: In Progress.
- Card chip: Fixing review feedback.
- Old review panel: visible as read-only context if a previous review exists.
- Review actions hidden or disabled:
  - no Request changes
  - no Run review again
  - no Mark done anyway
  - no Mark done
  - no Commit
  - no Create draft PR
- When the review gate is `NOT_RUN` but another task action pauses review
  actions, keep `Run agent review` visible and disabled with the pause reason
  on hover instead of replacing it with inline explanatory text.
- Header and evidence-side delivery actions are also disabled while review
  actions are paused, so Commit/Create PR cannot bypass the active follow-up.
- Active agent controls remain available:
  - add instruction
  - answer approval/input prompts
  - interrupt the active follow-up run

This avoids the misleading state where a task looks reviewable while the agent
is still changing the implementation.

### Follow-up completion

When the follow-up terminal event arrives:

1. Reducer moves the task from `IN_PROGRESS` back to `REVIEW`.
2. The old agent review remains `STALE`.
3. The task needs a fresh review because the implementation diff changed.

Expected UI:

- Board column: Review.
- Card chip: Needs re-review.
- Review panel: stale/needs re-review.
- Old findings: still visible as context, not as current actionable verdict.
- Primary next action: Run review again.

## Staleness rules

An agent review becomes stale when:

- a new non-review agent run starts after a terminal review result; or
- a new Git snapshot has a different head SHA or dirty fingerprint than the
  reviewed diff, except when a Task Monki delivery commit records the
  still-current reviewed worktree into Git.

Stale findings must not be treated as current findings. They are useful context
for what was previously wrong, but the correct action is to re-run review on the
current diff before marking done or sending more review-derived changes.

## Cancellation and interruption

Task Monki interruption uses `TaskManagerService.cancelRun` ->
`AgentOrchestrator.interruptRun` -> provider `turn/interrupt`.

Expected behavior:

- Review running:
  - Stop review sends interrupt to the review run.
  - Review gate becomes `CANCELED` if interruption is confirmed or locally
    reconciled.
  - Task stays in Review.
- Follow-up running:
  - Interrupt controls belong to the active agent controls, not the review
    panel.
  - The task stays In Progress until the interruption is terminally recorded.
  - Terminal interruption returns it to Review and leaves the review gate stale.

Provider edge cases:

- The provider may report a stale turn id.
  - Adapter retargets to the active provider turn when it can prove the active
    turn from provider events.
- The provider may report `no active turn to interrupt`.
  - For review runs this can mean the provider already stopped. Task Monki
    should locally stop/reconcile the review instead of leaving the UI stuck in
    Reviewing.
- The provider may not emit a terminal event after interruption.
  - Task Monki records ambiguous delivery, then locally reconciles if timeout
    recovery proves the run should stop.
- The selected agent runtime may exit or lose its event stream.
  - Runtime loss/recovery events must reconcile the run before the UI offers
    actions that assume a live active turn.
  - Late protocol errors after an App Server has already reached `EXITED`,
    `FAILED`, or `LOST` must not attempt a second terminal server transition.

## Provider session model

Implementation/follow-up:

- Usually uses the primary provider session.
- `continueRun` starts a new turn on the same session and sets
  `continuedFromRunId`.
- If the provider thread is missing, the orchestrator can recreate the provider
  session and retry starting the turn.
- Fork alternatives do not reuse or fork this provider session. They create a
  separate task and start a fresh implementation session in that task's own
  worktree.

Agent review:

- Uses a local review session with `role: "REVIEW"`.
- May use a different registered runtime from the source implementation.
- Uses native fork/review APIs only when the owning runtime advertises them.
- Otherwise, only when stable detached-review isolation is advertised, creates
  a fresh provider session and starts a normal read-only review turn against
  the same Task Monki worktree.
- The review run id is tracked through `projection.codexReview.runId`.

The review session must not be confused with the task's active implementation
session. That distinction is what keeps Review phase checks separate from
implementation work.

## Board state rules

Use these as invariants:

- Running implementation/follow-up/retry:
  - `workflowPhase: IN_PROGRESS`
  - board: In Progress
  - card: Running or Fixing review feedback
- Running agent review:
  - `codexReview.status: RUNNING`
  - board: Review, even if workflow data is stale
  - card: AI reviewing
- Terminal implementation/follow-up/retry from In Progress:
  - `workflowPhase: REVIEW`
  - board: Review
- Terminal review:
  - workflow phase remains Review
  - card reflects review gate result
- Stale review after follow-up:
  - board: Review after follow-up completes
  - card: Needs re-review
  - old findings: context only

## Debugging checklist

When the UI shows the wrong state:

1. Check `Task.workflowPhase`.
2. Check `Task.currentRunId`.
3. Check the current run's `mode`, `status`, `sessionId`, `providerTurnId`,
   `continuedFromRunId`, and `retryOfRunId`.
4. Check `Task.projection.agentRun`.
5. Check `Task.projection.codexReview.status`, `runId`, `sourceRunId`,
   `reviewedHeadSha`, and `reviewedDirtyFingerprint`.
6. Check whether the visible run is a review run or implementation-side run.
7. Check latest Git snapshot head and dirty fingerprint.
8. Check audit events around:
   - `AGENT_RUN_STARTED`
   - `AGENT_RUN_COMPLETED`
   - `AGENT_RUN_FAILED`
   - `AGENT_RUN_INTERRUPTED`
   - `AGENT_MUTATION_AMBIGUOUS`
   - `AGENT_RUNTIME_LOST`
   - `AGENT_RUNTIME_RECONCILED`
   - `GIT_SNAPSHOT_CAPTURED`
9. If Stop review fails, compare local `providerTurnId` with provider
   `turn/started` events. A mismatch means interruption must retarget or
   reconcile.

## UI rules

- Do not show Request changes for a stale review.
- Do not show review completion actions while any implementation-side run is
  active.
- Apply that pause consistently across review cards, finish panels, header
  buttons, and evidence-side delivery controls.
- Disabled workflow actions should keep their normal button position and expose
  pause/blocker reasons through the existing hover-title style, not dangling
  helper text.
- Do not move a task to Review while requested changes are still being
  implemented.
- Do not hide the previous review completely during follow-up work. It is useful
  context for the agent and the user.
- Do not treat provider-reported debug state as authoritative when verified
  local evidence disagrees.
- Keep verified Git/test/PR state visibly separate from provider telemetry.
