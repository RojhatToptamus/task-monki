# Agent Review Workflow Lifecycle

Date: 2026-10-10

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
   - A detached AI quality check stored in `projection.agentReview`.
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
- `Task.projection.agentReview`
  - The local review gate projection for the last agent review.
  - Includes the review run id, source run id, reviewed head/dirty fingerprint,
    summary, final artifact id, and structured findings when available.
  - `findingDecisions`: the append-only decisions on this review's findings
    (`src/shared/agentReviewFindings.ts`). Absent in stored projections from
    before decisions existed, which means none.
  - `reviewedTreeSha`: the exact content the review read, as a Git tree kept
    in the profile's review snapshot store (`ReviewSnapshotStore`), set by
    `REVIEW_SNAPSHOT_RECORDED` when the review starts. The store is a private
    bare repository per source repository under the profile that borrows the
    source repository's objects read-only, so nothing is written to the user's
    repository; a ref per task and review keeps each tree, and deleting the task
    lets them go. A capture that does not match the Git snapshot the review
    starts from is dropped, so a review is only ever linked to code it read.
    `readReviewChanges` diffs that tree against the worktree now: the Review
    tab's Since the review (out of date) and Since the last review (a current
    re-review) show exactly what changed between rounds. In Since the review
    the old side is the reviewed code, so the review's findings anchor to the
    line numbers it read there.
  - `requestAnswer`: set by `REVIEW_REQUEST_ANSWERED` once the agent's reply to
    the person's request after this review settles, with whether an item waits
    on the person's decision and which items the agent left to them; it stops
    waiting once the person accepts each of those answers, and is cleared when
    the next turn starts.
  - `requestItemDecisions`: the person's decisions on the agent's answers to
    their requests after this review, in order (`REVIEW_REQUEST_ITEM_DECIDED`):
    `ACCEPT` settles an item and `REOPEN` takes that back
    (`acceptedRequestItems`). Absent before the first; a new review starts
    without them.
  - `walkthrough`: the walkthrough the review wrote with its findings, as
    `STORED` (the review run and its `review-walkthrough` artifact) or
    `UNAVAILABLE` with a reason (`NOT_WRITTEN`, `NO_SECTIONS`, `NOT_RECORDED`,
    `TOO_LARGE`, `UNREADABLE`). A review given no change to describe (its code
    not kept, or the change too large to list) is asked for none and records
    that reason, not `NOT_WRITTEN`.
    A new review keeps a stored one, which names its own review, as earlier
    context until its own outcome replaces it.
- `RunRecord.mode`
  - `IMPLEMENTATION`, `FOLLOW_UP`, and `RETRY` modify the task worktree.
  - `REVIEW` inspects a diff and must use read-only settings.
  - `SIDE_QUESTION` answers a question in Ask, on the same read-only lane. It
    never changes workflow, `currentRunId`, `projection.agentRun` or the review
    gate, and never makes a review stale.
- `AgentSessionRecord`
  - Primary sessions back implementation/follow-up/retry runs.
  - Review sessions use `role: "REVIEW"` and one ordinary read-only turn.

## State flow

### Initial implementation

1. User selects a base, prepares the worktree, and starts a task.
2. `TaskManagerService.startRun` verifies the prepared worktree.
3. `AgentOrchestrator.startTurn` creates a run with `mode: "IMPLEMENTATION"`.
4. Reducer moves the task to `IN_PROGRESS`.
5. Only a successfully completed implementation run moves an `IN_PROGRESS`
   task to `REVIEW`. Failed, interrupted, lost, and recovery-required runs stay
   in `IN_PROGRESS` until the owner retries or continues them.

Expected UI:

- Board column: In Progress while active.
- Card chip: Running, needs approval, needs input, failed, etc.
- After successful completion: Review column.
- After an interrupted, lost, or recovery-required run: In Progress with
  Continue work as the primary action; review is unavailable.
- After a definitive failure or a provider-completed run whose locally verified
  outcome is blocked: In Progress with Retry implementation as the primary
  action; review is unavailable.
- Review gate: `NOT_RUN` unless a previous review exists.

### Starting agent review

1. User starts agent review from Review or In Review (Review with a pull
   request open, where the review leaves the phase as it is), or directly from
   an idle imported task, or a pull request opened as a task, in In Progress
   before its first coding run.
2. `TaskManagerService.startReview` rejects active implementation-side runs.
3. The current source run must be the latest successfully completed
   implementation-side run. Failed and superseded runs are rejected.
   Imported work, and a pull request opened as a task, can omit the source run
   before its first implementation.
   Git and runtime admission checks must pass. Review still creates no primary
   coding session.
4. `AgentOrchestrator.startReview` creates a `mode: "REVIEW"` run and a review
   agent session. For a direct review of imported work or of a pull request
   opened as a task, the existing SQLite transaction publishes the Review
   transition and run-start event together. A failed write publishes neither.
   An admitted review stays in Review if it fails or is canceled.
5. Task Monki sends the provider-neutral review prompt as a normal read-only turn.
   Before the run starts, the exact code it reads is kept under its run
   (`reviewedTreeSha`), and recorded with the run's start, so even a review that
   ends at once finds that code. The prompt lists that change from the task's
   base, one line per file with its status, counts and hunk ranges, and asks
   for the walkthrough with the findings in its one `agent-review/v1` result.
6. The prompt tells the selected runtime not to modify files.
7. `AgentOrchestrator` records repository state before provider delivery.
8. It compares repository state after terminal output.
9. A changed or unreadable repository fails the review.
10. Task Monki leaves detected changes in place as evidence.
11. Reducer keeps the task workflow phase in Review.
12. `projection.agentReview.status` becomes `RUNNING`.

Imported-work review includes committed and dirty changes against the selected
comparison. A comparison change or external edit makes the review stale.
The read-only integrity check still rejects changed or unreadable input, but
Task Monki does not attribute another editor's changes to the review provider.
Request changes starts the first implementation when no source coding run
exists. Otherwise it continues the current eligible implementation run.

Before a Codex review turn starts, the adapter resolves the selected repository
and task worktree through Git. It canonicalizes
the worktree Git directory and common Git directory, verifies that the
worktree is registered to that repository, and adds only the exact common Git
directory to the review permission profile as read-only. This is required for
linked worktrees whose `.git` pointer names metadata outside the worktree. The
review cwd remains the task worktree. Invalid, missing, symlinked, or unrelated
metadata for the active worktree fails the review before provider input;
unrelated prunable worktree registrations are ignored. Review subprocesses use
the resolved Git executable directly, disable login-shell path rewriting, and
ignore system/user Git configuration so the read-only sandbox does not need
home-directory or temporary-cache grants.

Review execution always requests read-only repository access with no approval exceptions.
Each adapter applies its provider-native restriction when one is available.
Selecting Full access for implementation does not weaken the review policy.

Codex uses an attested read-only permission profile.
OpenCode uses native deny rules in a dedicated `--pure` session.
Grok Build on macOS uses its native read-only sandbox in a dedicated process.
Cursor ACP uses native Ask mode and rejects every permission request.
Claude Agent ACP uses plan mode, but a packaged probe showed that this mode can
still complete a Write tool call. The OpenCode, Cursor, and Claude processes are
not operating-system sandboxes. Task Monki tells every review agent not to modify
files and uses repository comparison as the final acceptance boundary.
Managed attachments use the shared provider delivery path.
Each selected runtime and model must support the attachment type.

The review session must carry the configured runtime, model provider, model,
service tier, cwd, and reasoning effort. Cross-runtime review never reuses a
model identifier from the implementation runtime.

The review session carries the configured reasoning effort through the selected adapter.
Codex sends this value in its ordinary thread and turn settings.

Expected UI:

- Board column: Review.
- Card chip: Reviewing.
- Review panel: running indicator, concise current review activity, and Stop review.
- Finish actions: paused.
- Review actions: paused except Stop review.
- Agent implementation controls should not be shown for the review run as if it
  were the implementation run.

### Review completion

The runtime coordinator compares repository integrity before accepting a
read-only review result. Changed or unreadable repository state fails the run.
Restart recovery repeats an unfinished integrity check before projection. This
check does not prove the review findings or attribute edits to the agent.

Only events for the current review run can update its projection. Late events
for earlier reviews remain in their run history. Terminal events cannot make a
stale review current again; only a Git snapshot of exactly the reviewed diff
can (see Staleness rules). A new review requires an explicit start.

When the review run emits a terminal event:

- `AGENT_RUN_COMPLETED`
  - Parses `agentReviewResult` when provided.
  - Falls back to native/raw review output parsing.
  - Stores structured findings and summary when available.
  - Status becomes:
    - `PASSED` when verdict passes and no blocking findings override it.
    - `NEEDS_CHANGES` when findings require changes.
    - `INCONCLUSIVE` when there is output but no reliable pass/fail verdict.
  - A re-review also records `resolvedFindings` (earlier open findings the code
    now resolves, with a note) and gives each finding that is an earlier one
    still open its `previousFindingId`; the Review tab marks findings Still open
    or New and lists the resolved ones.
  - Checks the walkthrough against the change the review read, inside the same
    outcome, before recording either (`checkReviewWalkthrough`): each file sits
    in the first section that claims it, and files no section claims join a
    last Other changes section; an excerpt or a term must lie inside one hunk
    of its section's files, on the base side only for a deleted file, and a
    term must be an exact phrase of its explanation. What fails is dropped;
    with no section left, nothing is kept. The check reuses the change index
    the review was given at its start, so the runtime's event queue reads no
    diff again; after a restart it is read once more. The kept walkthrough is
    the run's artifact, written once, so an outcome projected again after a
    restart gets it back. A walkthrough that cannot be kept never holds back
    the verdict. The Guide reads it with `readReviewedDiff`, the diff from the
    base to the reviewed code, so its lines match the walkthrough's.
- Every finished review raises a toast, and a review that waits on the person
  enters the Inbox (see Review attention).
- `AGENT_RUN_FAILED` or review policy/runtime failure
  - Status becomes `FAILED`.
- `AGENT_RUN_INTERRUPTED`
  - Status becomes `CANCELED`.
- `AGENT_RUNTIME_RECONCILED`
  - Uses reconciled terminal state to set `INCONCLUSIVE`, `CANCELED`, or
    `FAILED`.

Expected UI:

- `PASSED`
  - Primary path follows the completion policy. Under local acceptance it is
    Mark done (or Commit while the tree is dirty), with Create draft PR among the
    finishing actions until a pull request exists. Once a pull request is open,
    PR Status holds the Overview's Now panel.
  - Secondary/local paths: commit or mark done.
- `NEEDS_CHANGES`
  - The Review tab shows each finding on the code it is about.
  - Primary path: Request changes, from the Review tab.
  - Secondary path: run review again or use the finish-panel Mark done anyway
    owner override.
  - Once no open Blocker or Major finding remains (each is dismissed, withdrawn
    or downgraded), the review no longer asks for changes: open Minor and Nit
    findings are suggestions, finishing is clean without an override, and the
    card stops saying Needs changes.
- `INCONCLUSIVE`
  - Show raw output and any parsed findings.
  - Request changes only through open findings. Prose that explains why the
    review could not finish ("Git metadata is inaccessible") is not work for
    the implementation agent, so with no findings the next step is to run the
    review again (`canRequestReviewChanges`).
- `FAILED` or `CANCELED`
  - Prefer re-run or inspect debug details.
  - Request changes only through open findings, as for an inconclusive review.

### Finding decisions

The person can change what a current review asks for. Every change is an
`AGENT_REVIEW_FINDING_DECIDED` event appended to the review's
`findingDecisions`; the review result itself is never rewritten, and
`effectiveReviewFindings` derives each finding's state (`OPEN` or
`DISMISSED`).

- The person dismisses an open finding with a reason and an optional note of at
  most 500 characters, and can restore it (`decideReviewFinding`). The reason is
  `NOT_A_PROBLEM` (shown as Incorrect: the reviewer was wrong), `ACCEPTED`
  (Intentional: real, and the code is so on purpose) or `DEFERRED` (Won't fix
  now).
- Blocker and Major findings are in Request changes by default; dismissing is
  the only way to leave one out. Minor and Nit findings are suggestions: they
  are sent only when the person adds them, and their inclusion is part of the
  person's review draft for that review run (`planReviewRequest`).
- The person's review (comments on lines, ranges, removed lines and files, the
  suggestions they added, and the note) is saved with the task as it is written
  (`saveTaskReviewDraft`) and cleared once Request changes is sent.
- Decisions are accepted only for the task's current, finished review. A stale,
  running, or replaced review rejects them, and so does a canceled or archived
  task.
- What the workflow acts on is `effectiveReviewGateStatus`: the gate rule
  (`reviewGateStatusFor`: a NEEDS_CHANGES verdict or any BLOCKER/MAJOR finding
  asks for changes) applied to the findings still open once every decision
  applies. A NEEDS_CHANGES verdict with findings asks for changes only while
  an open BLOCKER or MAJOR finding remains, because that is what a request would
  send by default; it keeps asking when the review recorded no findings
  (raw-output reviews). Decisions move it both ways: a BLOCKER or MAJOR finding
  added or raised makes a passed or inconclusive review ask for changes, and
  dismissing, withdrawing or downgrading those findings returns it to its
  verdict. An inconclusive verdict never reads as passed, because the reviewer
  never reached one. The finish policy, the next action, the board card and the
  board summary (`effectiveStatus`) all read this one rule.
- A new review starts with no decisions. Its prompt lists the earlier review's
  findings by id with their states, notes and reasons. It never raises a finding
  the person marked incorrect, or one withdrawn, again; raises one marked
  intentional again only if the code around it changed materially; leaves a
  deferred one alone; and, as a re-review, reports new findings only at BLOCKER
  or MAJOR.

### Ask

The agent is the only conversation; the reviewer is a fresh, read-only reporter.
Questions about the task go to Ask, on Overview, Agent and Review.

1. The person asks in the Ask panel (`askSideQuestion`, idempotent by message
   id). A question can carry a subject: a finding of the current review
   (`FINDING`, refused once that review is no longer current) or lines of the
   diff (`LINES`). It is stored as a `TaskInstruction` with `role: "SIDE"`, its
   thread and its subject.
2. A `SIDE_QUESTION` run answers it in a fresh read-only session on the task's
   runtime, reading the recent conversation, the current review with its
   findings and decisions, the subject with its diff, and the thread's earlier
   exchanges. While the implementation agent works, it reads a snapshot of the
   worktree taken when the question was asked.
3. One question runs at a time per thread. A question reading the live worktree
   holds other work until it ends or is stopped.
4. Nothing reaches the agent unless the person uses an answer: Use in follow-up
   puts it in the agent's composer, and on Review, Add to request adds it to the
   request's note.

### Requesting changes after review

1. The Review tab's request bar says what will be sent: every open Blocker and
   Major finding, the suggestions the person added, the pull request
   discussions the person added, and their own line comments, with an optional
   note. Comments can be sent on their own, even without an actionable review.
   A pull request discussion (a review thread, a review's summary or a
   conversation comment, read from GitHub or GitLab with each PR refresh) is
   other people's words: it goes only when the person adds it
   (`TaskReviewDraft.includedDiscussionIds`), never once resolved. Address
   comments on PR Status adds every unresolved thread and review requesting
   changes that was not sent since someone other than the person last wrote on
   it, and opens the request sheet; sending stays the person's step.
2. `buildReviewRequestInstruction` numbers the findings, then the discussions,
   then the comments, in one sequence. Discussions are quoted with every
   comment's author inside boundary lines that carry the stored feedback's id,
   framed as data that grants no permission. It names the dismissed findings as
   context the agent must leave alone, and asks the agent to end its reply with
   a `task-monki-review-response` block answering every item: `FIXED`,
   `NOT_CHANGED` (and why) or `NEEDS_DECISION` (and the question).
3. `TaskManagerService.continueRun` starts a `mode: "FOLLOW_UP"` run from the
   source implementation run. The follow-up message carries the request item by
   item (`TaskInstruction.reviewRequest`, validated by
   `assertReviewRequestRecord`), so the Agent conversation shows it as a card of
   those items rather than the instruction text. Before the task's first turn,
   such as on an opened pull request, `startRun` takes the request with its
   instruction and records it as that turn's `FOLLOW_UP` message, so it reads
   and is answered the same way. The instruction that starts the first coding
   turn on existing work is recorded the same way, so later turns read it from
   the task's instructions. It is recorded before the turn starts and kept with
   a turn that failed to start, so a retry still carries it; a start refused
   before any run exists records nothing. A discussion the request sent shows as Sent,
   or with the agent's answer, until someone other than the person writes on it
   again.
4. Reducer moves the task to `IN_PROGRESS`.
5. The review stays as it was: a follow-up continues the reviewed work, and only
   a diff that differs from the reviewed one makes the review stale.
6. Review actions pause until the follow-up ends.

Expected UI while follow-up is active:

- Board column: In Progress.
- Card chip: Fixing review feedback.
- Review tab: the diff and findings stay; the headline says Fixing review
  feedback, or the agent's pending request ("Codex asked a question") with Go to
  request, since the Review tab has no page head to carry it.
- Review actions hidden or disabled:
  - no Request changes
  - no Run review again
  - no Mark done anyway
  - no Mark done
  - no Commit
  - no Create draft PR
- When the review gate is `NOT_RUN` but another task action pauses review
  actions, keep `Run agent review` visible and disabled, with the pause reason
  stated once beside the actions instead of replacing the button.
- Header and evidence-side delivery actions are also disabled while review
  actions are paused, so Commit/Create PR cannot bypass the active follow-up.
- Active agent controls remain available:
  - add instruction
  - answer approval/input prompts
  - interrupt the active follow-up run

This avoids the misleading state where a task looks reviewable while the agent
is still changing the implementation.

### Follow-up completion

When the follow-up completes successfully:

1. Reducer moves the task from `IN_PROGRESS` back to `REVIEW`.
2. The post-run Git snapshot decides the review: a changed diff makes it
   `STALE` and the task needs a fresh review; a follow-up that changed nothing
   (it answered or asked a question, say) leaves the review current.
3. When the follow-up answered a request, `REVIEW_REQUEST_ANSWERED` records how
   many items the agent answered and how many need the person's decision
   (`parseReviewResponse` over its reply). The answers show as a list under the
   reply in the Agent conversation, and on the Review tab's brief until the next
   review reads them; the next review's prompt carries the request and each
   answer, as claims to check against the code.
4. On the Review tab each answered item of the latest request after the review
   (`latestReviewRequest`: the newest sent message carrying a request for it)
   shows its answer on its own band, in both modes: the finding, the pull
   request thread, or the person's comment, which comes back to its lines
   since sending it emptied the draft. The answer is the band's state under the
   agent's mark (Fixed, Not changed, Needs your decision), its note is quoted
   under the agent's name and time, and the choices are Accept answer and Add
   to request. The agent's Fixed settles nothing: only Accept answer does
   (`decideReviewRequestItem`), which folds a finding or a comment to a line
   with Reopen and marks the item Accepted in the brief. Core takes a decision
   only for the gate's review, out of date or not, on its latest request once
   the reply finished, on an item of that request; it refuses accepting twice
   and reopening what is not accepted. Add to request opens a comment on the
   item's lines that starts from a quote of it, or puts the quote in the note
   for an item with no place in the files, so an out-of-date review's finding
   is never sent as a finding again.

Expected UI when the diff changed:

- Board column: Review.
- Card chip: Needs re-review.
- Review tab: Review out of date, leading with the files that changed since the
  reviewed capture (All changes when nothing did; never an empty scope); the
  earlier findings stay on the code as context without Ask or Dismiss.
- Primary next action: Run review again.

### Review attention

Auto re-review stays off, so a finished review waits on the person. The Inbox
and the board card name it in one of four words (`describeTaskAttention`):

- Agent asked a question: the agent's answer to a request has an item that
  needs the person's decision. Replying starts a turn, which clears it.
- Review failed.
- Fixes ready for review: the agent answered a request and the diff changed.
- Needs changes: the review asks for changes and the person decides what to
  send.

If the follow-up fails, is interrupted, is lost, or requires recovery, it stays
in `IN_PROGRESS`. Retry the implementation after a definitive failure, or
continue unfinished work after interruption, loss, or ambiguous recovery,
before a fresh review is allowed; the previous review remains stale context
only.

## Staleness rules

An agent review becomes stale when:

- a new Git snapshot has a different head SHA or dirty fingerprint than the
  reviewed diff, except when a Task Monki delivery commit records the
  still-current reviewed worktree into Git; or
- a non-review run that is not an implementation turn (analysis, compaction)
  starts after a terminal review result, leaving the review with no
  implementation run to belong to.

A follow-up or retry starting never makes a review stale by itself. A Git
snapshot that matches the reviewed head SHA and dirty fingerprint again makes a
stale review with a result current again, with its decisions intact.

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
  - Terminal interruption keeps it In Progress; the review gate is whatever the
    last Git snapshot decided.

Provider edge cases:

- The provider may report a stale turn id.
  - Adapter retargets to the active provider turn when it can prove the active
    turn from provider events.
- The provider may report `no active turn to interrupt`.
  - For review runs this can mean the provider already stopped. Task Monki
    should locally stop/reconcile the review instead of leaving the UI stuck in
    Reviewing.
- The provider may not emit a terminal event after interruption.
  - Task Monki uses the owning runtime's bounded interruption deadline and
    reconciles authoritative provider snapshots without replaying the prompt.
  - An acknowledged interrupt plus provider terminal evidence becomes
    interrupted. If evidence remains inconclusive, confirmed termination of the
    owning local runtime becomes a local interruption; an unconfirmed stop
    remains recovery-required and fenced from reuse.
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
- Creates a fresh provider session for one normal read-only review turn.
- Each explicit rerun uses its own session and run operation identities, even when the reviewed diff is unchanged.
- Tells the selected runtime not to modify files and applies its native restriction when available.
- Uses the same `AgentOrchestrator` and `SqliteAgentRuntimeStore` lifecycle as other turns.
- The review run id is tracked through `projection.agentReview.runId`.

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
  - `agentReview.status: RUNNING`
  - board: Review, even if workflow data is stale
  - card: Reviewing
- Successfully completed implementation/follow-up/retry from In Progress:
  - `workflowPhase: REVIEW`
  - board: Review
- Failed, interrupted, lost, or recovery-required implementation/follow-up/retry:
  - `workflowPhase: IN_PROGRESS`
  - board: In Progress
  - primary recovery action:
    - Retry implementation for a definitive failure
    - Continue work for interruption, loss, or ambiguous recovery
  - agent review unavailable
  - store initialization repairs a persisted `REVIEW` mismatch back to
    `IN_PROGRESS` when the current implementation-side run has one of these
    unsuccessful states
- Terminal review:
  - workflow phase remains Review
  - card reflects review gate result
- Stale review after follow-up:
  - board: Review after follow-up completes
  - card: Needs re-review
  - old findings: context only
- Historical review after newer non-implementation work:
  - a completed analysis or compaction run remains the exact current run
  - board: In Progress; the historical review remains visible as read-only context
  - no review or review-derived follow-up action may target the older implementation
  - store initialization must not promote the task to Review from that older
    review; only the exact current completed implementation-side run is a valid
    review source

## Debugging checklist

When the UI shows the wrong state:

1. Check `Task.workflowPhase`.
2. Check `Task.currentRunId`.
3. Check the current run's `mode`, `status`, `sessionId`, `providerTurnId`,
   `continuedFromRunId`, and `retryOfRunId`.
4. Check `Task.projection.agentRun`.
5. Check `Task.projection.agentReview.status`, `runId`, `sourceRunId`,
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

- A stale review's findings are context only: no Dismiss or Ask, and they are
  never sent. The person's own comments on the current code can still be sent
  with Request changes.
- Comments can be written whenever the current diff is shown, including while
  a review runs; only sending waits for the review.
- Keep `SIDE_QUESTION` runs and `SIDE` messages in Ask, out of the Agent tab
  and the task's run selection (`partitionAgentRecords`).
- Show a reply to a review request as its prose, with the
  `task-monki-review-response` block taken out and shown as the answer list.
- Derive every review entry action from the exact current completed
  implementation-side run. Never fall back to the source of a historical
  review or another completed run in the iteration.
- Do not show review completion actions while any implementation-side run is
  active.
- Apply that pause consistently across review cards, finish panels, header
  buttons, and evidence-side delivery controls.
- Disabled workflow actions keep their normal button position. On a decision
  surface (the Overview's Now panel, a dialog) the pause or blocker reason
  is stated once beside the actions and tied to them with `aria-describedby`:
  a disabled button cannot take focus, so a hover title alone is unreachable
  from the keyboard. Icon-only toolbar controls keep hover titles.
- Do not move a task to Review while requested changes are still being
  implemented.
- Do not hide the previous review completely during follow-up work. It is useful
  context for the agent and the user.
- Do not treat provider-reported debug state as authoritative when verified
  local evidence disagrees.
- Keep verified Git/test/PR state visibly separate from provider telemetry.
