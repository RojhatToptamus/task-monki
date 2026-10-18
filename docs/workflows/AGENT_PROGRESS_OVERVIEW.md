# Agent session and progress

This document describes the Agent tab, compact Overview, authored instructions,
and provider activity. Task Monki owns workflow and verified local evidence.
Provider messages, plans, and tool reports remain telemetry.

## Surfaces

The task header shows the board's four lanes as the task's lifecycle track
(Ready › In progress › Review › Done) with the repository and branch. The task's
own stage is emphasized and carries a glyph when it needs the user or has
failed, spinning only while an agent run or review is working; its status word
is stated once, by the Overview.

Overview leads with the Now panel: the step the task needs now. Its owner
follows the UI priority in `docs/PRODUCT_WORKFLOW.md`: a pending agent request,
a missing or failed checkout (Retry and Continue cannot run without it),
recovery, work in flight, PR Status while a pull request is unmerged, finishing,
then setup; a closed task shows how and when it ended. A merged pull request
hands the panel to finishing. Each owner brings its existing controls — the
request's decisions, Retry and Continue, Restore or Reconnect, PR Status, the
next-action model, Prepare or Start — so no control gains a second meaning. Its
title states the state in the board card's word, or what the agent is doing
("Codex wants to run a command", "Codex is working", "Codex is reviewing").
While the agent works or reviews, the panel quotes its latest progress beneath
that title; a running review also offers Stop review. A run that
still waits on a request that is no longer open says so rather than reading as
ordinary waiting.

Below the panel, flat sections follow the lifecycle: the request as written
(omitted when it only repeats the title), the result of a completed run — what
the agent reported, attributed to it, above the files Task Monki captured or "No
file changes" — then the agent review once one exists, and PR Status when a pull
request exists and does not hold the panel. Before a pull request exists,
Create draft PR is one of the finishing actions while finishing holds the
panel, and a PR Status section offers it otherwise. A fixed record column holds
Details (agent, model, effort, permissions, network, base, branch), Preview when
a worktree exists, and History: each entry's event, source and time, with its
evidence in the full ledger.

The Agent tab is a chronological conversation with one history scroller and a
pinned composer. The task heading and tabs hide only when the reader scrolls
downward and reappear when they scroll upward; arriving on the tab, following
output, and restoring a position never hide them. Keyboard focus keeps them
visible. Header motion uses
the shared duration and reduced-motion rules. The original request is its first
user message. Authored follow-ups appear when admitted; live instructions appear within the active
response. User messages use the shared filled message surface; agent prose stays
on the content sheet. Exchanges remain readable without opening run accordions.

The active response ends with one working or attention indicator. Stop, provider,
model, and delivery controls live in the composer. Create, Prepare worktree, and
Start implementation remain separate actions before a run. Pre-run model and access
choices use the runtime catalog and pass settings to the existing start operation.
Unmatched saved permissions remain custom settings until a preset is explicitly
chosen. Detached review entries open the existing review surface.

`Conversation`, `Message`, `MessageMarkdown`, `ActivitySteps`, `PlanCard`,
`InteractionPanel`, and `ActionMenu` are shared presentation primitives.
Agent, Design, Discourse, and New task composers use the shared `tm-composer`
field surface and focus boundary. Their controllers retain separate ownership.
Design and Agent activity exclude prose already owned by their conversations.

## History and evidence

`agentSession.sessionEntries` combines authored Task Monki instructions with
normalized agent messages, reasoning summaries, native plans, and tool activity. Provider `USER_MESSAGE` echoes
can contain generated execution prompts and are excluded. A final-message
projection is a fallback when the same text is absent from normalized messages.
Historical instructions without authored records remain available through
View sent prompt. The UI does not reconstruct them by parsing prompt wrappers.

Activity follows the existing provider-neutral projections:

```text
Provider adapter/materializer
  -> AgentItemRecord / AgentPlanRevisionRecord / InteractionRequestRecord
  -> runActivity / overviewRunActivity
  -> agentSession / ActivitySteps
```

Tool rows summarize file reads, searches, edits, commands, verification commands,
web/MCP work, and compaction. Commands and reasoning use compact disclosures;
file paths are relative to the worktree where available. Command wrappers and
sub-second durations do not appear in the conversation. Tools retain their start
position as completion arrives, and grouping does not cross agent prose.
Native plan updates stay at the first plan's position, rendered as a checklist:
a check for done, a dot for the current step, a ring for what is left. The plan
never spins; the running command and the working line carry the motion. A
terminal run marks a stale active step unfinished, stopped, or failed, in words
on that step only, without changing provider steps. No plan data means no
synthetic checklist. An agent review entry names the latest review's verdict
(Passed, Requested changes, Inconclusive); an earlier review says only how its
run ended, because its verdict is no longer recorded. A failed run's own reason
is quoted under the runtime's name.
Tool disclosures show bounded command, output, and error excerpts. Full protocol
payloads and provider diagnostics stay in Debug. A terminal
run cannot leave a stale item looking active. This changes its presentation,
not the historical provider record.

Captured changes come from `GitSnapshotRecord`, independently of agent prose.
File summaries open their exact captured snapshot in Evidence. Empty captures
and consecutive captures of unchanged Git state do not repeat in the conversation.
A later changed worktree marks the earlier summary as historical. Provider completion and
claims about tests do not become verified Task Monki outcomes.

The initial conversation renders about 80 blocks, with an explicit control to
load another page. Run boundaries stay internal; page boundaries keep an outcome
with at least its last entry. Output appends without advancing the loaded
start. Prepending history preserves the reader's offset. Scrolling follows output
only while the reader is near the bottom; Jump to latest resumes following.
Because the control disappears once the view is at the end, activating it from
the keyboard hands focus to the history. The last viewed task's loaded start and reading
position survive tab changes and renderer reloads within the window session.

The response footer's secondary Response details menu opens the sent execution
prompt or Debug. Run identifiers and terminal diagnostics stay in Debug. Task
request configuration and attachment metadata remain in Overview's Request section.

## Composer and queue

| State | Primary action | Delivery |
| --- | --- | --- |
| Queued or starting | Disabled | Wait for provider readiness. |
| Running | Queue after run | Store pending task intent. |
| Running, steering supported | Send now, explicitly selected | Apply to the exact active turn through its adapter. |
| Approval or input pending | Answer the structured request | Keep the native interaction contract and responding state. |
| Completed | Send | Start a new turn after local evidence capture. |
| Interrupted, lost, recovery required | Continue | Use existing recovery and session reconciliation. |
| Failed or implementation retry required | Retry | Retry the goal against current worktree files. |

Continue work, Retry implementation, and Fork alternative keep distinct
semantics. Fork starts a separate task from the recorded base. It does not
include current uncommitted work. No action silently substitutes for unsupported
steering. Runtime capability and readiness determine availability.

Plain Enter adds a newline. Cmd/Ctrl+Enter sends, except during IME composition.
An in-flight submission cannot repeat. Successful submission returns focus to
the composer; rejected submission preserves text and exposes the error.
Drafts persist per task across tabs, reloads, and application restarts.

Agent and Design use `MessageQueue` for a bounded pending list inside the composer.
Design keeps pending turns out of the transcript until execution starts. Its queue
offers cancellation through the existing Design turn operation. Agent retains its
own edit, remove, and held-instruction controls.
The action row uses shared controls with accessible labels and tooltips.
Its delivery menu distinguishes an active-run message from an after-response queue.
Agent, Design, and Discourse action menus use Radix for
portals, viewport collision handling, dismissal, and keyboard navigation.
Pending Agent instructions can be edited or removed until claimed. Editing uses the same text field
while keeping the unsent draft separate. Cmd/Ctrl+Enter saves an edit; Escape cancels
it. A rejected edit keeps its text. Save and Cancel return focus to the composer
without changing its draft.

The task queue dispatches FIFO, one instruction at a time, only after successful
completion and post-run local evidence. The next instruction must still match the task's current
iteration, worktree, source run, and session. An active run, pending interaction,
recovery requirement, or blocked implementation prevents dispatch.

Stop holds the entire queue before asking the provider to interrupt. Failures,
restart, review handoff, and ownership changes also hold the queue. Continuing
one held instruction leaves the rest held. It never arms all pending work.

## Ownership and recovery

`TaskManagerService` owns authored instruction admission and pending task intent.
`task_instructions` is its durable collection. `Task.agentDraft` owns unsent text.
The runtime store continues to own sessions, runs, delivery, items, interactions,
and recovery. An instruction receipt says whether a runtime operation was
admitted; it does not reproduce execution status.

Stable client message IDs prevent repeated UI/API delivery. A claimed follow-up
reserves a runtime run ID before the existing start path admits it. Restart
correlates that ID with the runtime store. Ambiguous steering remains uncertain,
and ambiguous turn submission remains under runtime recovery. Neither is
automatically resent. An explicit retry can reuse a failed instruction’s files and
reserved ID only when the runtime store confirms that no run was admitted and the
original task, worktree, and session still match. Matching draft clearing shares
the admission transaction.

SQLite migration 8 adds the task instruction table. Old tasks have an empty
queue and optional empty draft. Existing runtime and prompt artifacts remain
readable. See `../architecture/PERSISTENCE_ARCHITECTURE.md` for storage limits
and `AGENT_REVIEW_WORKFLOW_LIFECYCLE.md` for review transitions.

## Verification ownership

- `TaskManagerService.instructions.integration.test.ts` exercises FIFO admission,
  duplicate notifications, Stop, ambiguous delivery, and restart with real SQLite.
- `AgentSession.dom.test.tsx` exercises delivery choices, capability gating,
  rejection, duplicate submission, IME behavior, and focus.
- `agentSession.test.ts` checks provider echoes, tool chronology, relative paths,
  and terminal activity.
- `TaskDetail.dom.test.tsx` retains historical evidence and workflow coverage.
- Provider adapter tests protect native requests, turn delivery, and reconciliation.
- Seeded browser and desktop verification cover layout, themes, long content,
  focus, scrolling, and real provider execution.
