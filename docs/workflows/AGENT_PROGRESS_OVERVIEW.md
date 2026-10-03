# Agent session and progress

This document describes the Agent tab, compact Overview, authored instructions,
and provider activity. Task Monki owns workflow and verified local evidence.
Provider messages, plans, and tool reports remain telemetry.

## Surfaces

Overview shows one Agent conversation link with the current action state and
captured local changes. Recovery context lives beside that link. Review, PR delivery, Preview,
and acceptance keep their existing owners and controls. When implementation needs
retry and no PR exists, Overview omits the inactive PR card. The Agent summary
owns the recovery explanation; existing PR evidence remains visible.

The Agent tab is a chronological conversation with one history scroller and a
pinned composer. The task heading and tabs scroll with the conversation rather
than reserving a fixed header. The original request is its first user message. Authored
follow-ups appear when admitted; live instructions appear within the active
response. User messages use the shared filled message surface; agent prose stays
on the content sheet. Exchanges remain readable without opening run accordions.

The active response ends with one working or attention indicator. Stop, provider,
model, and delivery controls live in the composer. Create, Prepare worktree, and
Start implementation remain separate actions before a run. Detached review
entries open the existing review surface.

`MessageContent`, `MessageMarkdown`, `PlanList`, `InteractionPanel`,
`RunActivityTimeline`, and `ActionMenu` are shared presentation primitives.
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
  -> agentSession / RunActivityTimeline
```

Tool rows summarize file reads, searches, edits, commands, verification commands,
web/MCP work, and compaction. Commands and reasoning use compact disclosures;
file paths are relative to the worktree where available. Command wrappers and
sub-second durations do not appear in the conversation. Tools retain their start
position as completion arrives, and grouping does not cross agent prose.
Native plan updates stay at the first plan's position. A terminal run marks a
stale active step unfinished, stopped, or failed without changing provider steps.
No plan data means no synthetic checklist.
Tool disclosures show bounded command, output, and error excerpts. Full protocol
payloads and provider diagnostics stay in Debug. A terminal
run cannot leave a stale item looking active. This changes its presentation,
not the historical provider record.

Captured changes come from `GitSnapshotRecord`, independently of agent prose.
File summaries open their exact captured snapshot in Evidence. Empty captures
and consecutive captures of unchanged Git state do not repeat in the conversation.
A later changed worktree marks the earlier summary as historical. Provider completion and
claims about tests do not become verified Task Monki outcomes.

The initial conversation renders up to 80 entries, with an explicit control to
load 80 earlier entries at a time. Output appends without advancing the loaded
start. Prepending history preserves the reader's offset. Scrolling follows output
only while the reader is near the bottom; Jump to latest resumes following
without moving keyboard focus. The last viewed task's loaded start and reading
position survive tab changes and renderer reloads within the window session.

Run identifiers, terminal diagnostics, and sent execution prompts remain in the
response footer's secondary Run details disclosure. Task request configuration and
attachment metadata remain in Overview's Request section.

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

Pending instructions appear in a bounded, collapsible list inside the composer.
The action row uses shared icon controls with accessible labels and tooltips.
Its delivery menu distinguishes an active-run message from an after-response queue.
Agent, Design, and Discourse action menus use Radix (the shadcn foundation) for
portals, viewport collision handling, dismissal, and keyboard navigation.
Pending instructions can be edited or removed until claimed. Editing uses the same text field
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
automatically resent. Matching draft clearing shares the admission transaction.

SQLite migration 7 adds the task instruction table. Old tasks have an empty
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
