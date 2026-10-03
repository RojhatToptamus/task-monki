# Agent session and progress

This document describes the Agent tab, compact Overview, authored instructions,
and provider activity. Task Monki owns workflow and verified local evidence.
Provider messages, plans, and tool reports remain telemetry.

## Surfaces

Overview shows the active or latest implementation run, Stop when available,
an Open Agent action, and captured local changes. Review, PR delivery, Preview,
and acceptance keep their existing owners and controls.

The Agent tab contains one history scroller and a pinned composer. The toolbar
shows the provider, observed model, run state, elapsed time, and Stop. Create,
Prepare worktree, and Start implementation remain separate actions before a run.

The original request and current native plan use disclosures. An absent plan
does not create synthetic steps. Historical turns remain collapsed until opened;
the current turn stays expanded. Session boundaries and detached review runs
remain explicit. A review entry opens the existing review surface.

`MessageHeader`, `MessageMarkdown`, `RunHeader`, `PlanList`, `InteractionPanel`,
and `RunActivityTimeline` are shared presentation primitives. The task composer
uses the existing field and action tokens without coupling task workflow to the
Design or Discourse controllers.

## History and evidence

`agentSession.sessionEntries` combines authored Task Monki instructions with
normalized agent messages and grouped activity. Provider `USER_MESSAGE` echoes
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
web/MCP work, and compaction. Consecutive context and command rows can expand.
Raw output, protocol payloads, and provider diagnostics stay in Debug. A terminal
run cannot leave a stale item looking active. This changes its presentation,
not the historical provider record.

Captured changes come from `GitSnapshotRecord`, independently of agent prose.
Each turn opens its own captured snapshot in Evidence. Provider completion and
claims about tests do not become verified Task Monki outcomes.

The initial history renders 12 turns and 80 entries per expanded turn, with
explicit controls to show earlier content. The current run's plan and request
disclosures are bounded. Scrolling follows new content only while the reader
is near the bottom. Reading older content reveals Jump to latest and does not
move keyboard focus.

## Composer and queue

| State | Primary action | Delivery |
| --- | --- | --- |
| Queued or starting | Disabled | Wait for provider readiness. |
| Running | Queue after run | Store pending task intent. |
| Running, steering supported | Send now, explicitly selected | Apply to the exact active turn through its adapter. |
| Approval or input pending | Answer the structured request | Keep the native interaction contract and responding state. |
| Completed | Follow up | Start a new turn after local evidence capture. |
| Interrupted, lost, recovery required | Continue work | Use existing recovery and session reconciliation. |
| Failed or implementation retry required | Retry implementation | Retry the goal against current worktree files. |

Continue work, Retry implementation, and Fork alternative keep distinct
semantics. Fork starts a separate task from the recorded base. It does not
include current uncommitted work. No action silently substitutes for unsupported
steering. Runtime capability and readiness determine availability.

Plain Enter adds a newline. Cmd/Ctrl+Enter sends, except during IME composition.
An in-flight submission cannot repeat. Successful submission returns focus to
the composer; rejected submission preserves text and exposes the error.
Drafts persist per task across tabs, reloads, and application restarts.

Pending instructions can be edited or removed until claimed. The task queue
dispatches FIFO, one instruction at a time, only after successful completion and
post-run local evidence. The next instruction must still match the task's current
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
- `agentSession.test.ts` checks message de-duplication and terminal activity.
- `TaskDetail.dom.test.tsx` retains historical evidence and workflow coverage.
- Provider adapter tests protect native requests, turn delivery, and reconciliation.
- Seeded browser and desktop verification cover layout, themes, long content,
  focus, scrolling, and real provider execution.
