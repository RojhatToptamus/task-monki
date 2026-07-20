# Agent Progress Overview

Date: 2026-07-09

Status: authoritative for the Overview agent progress surface, normalized
activity projection, and provider-telemetry boundaries.

This document explains how Task Monki turns provider plan and item telemetry
into the compact progress UI shown in task Overview. It covers implementation
runs, follow-up runs, retries, review activity, Debug output, and the evidence
boundaries that keep provider telemetry separate from Task Monki truth.

## Purpose

The progress surface answers two different questions without making users open
Debug:

1. What is the agent trying to do?
2. What has it been doing recently?

The provider plan remains the primary progress structure. The activity tail is
supporting context only. It summarizes recent provider telemetry such as file
reads, searches, edits, commands, tool calls, approval waits, and short progress
messages.

Provider telemetry is not evidence. Task Monki still owns workflow phase, Git
state, test/verification state, delivery state, review state, and acceptance.

## User Surfaces

### Overview Run Progress

The Overview renders the active or latest implementation-side run with
`RunProgressCard`:

- a `RunHeader` with operation name, scope, elapsed time, and Stop while live;
- a `PlanList` with normalized provider plan steps;
- a live `RunActivityTimeline` while the run is active;
- a completed-run change summary when local diff evidence is available;
- a terminal footer for completed, failed, interrupted, or recovery-required
  runs.

Activity is shown only for running progress. Terminal runs return to plan plus
local-evidence footer. This keeps the plan as the stable history and avoids
making provider item traffic look like a verified transcript.

### Review Panel

Review is a detached quality gate inside the Review phase. `ReviewPanel` uses
the same `RunHeader` pattern while a review run is active, but its activity copy
is a single current-activity sentence, not the full implementation activity
tail. Review activity is still derived from the same normalized run activity
projection so review runs do not get stuck on a generic placeholder when useful
telemetry is available.

### Debug And Provider Details

Debug remains the place for raw provider detail. `ProviderActivityPanel` uses
the normalized projection for curated sections, but it also exposes raw provider
items, provider messages, output, and protocol-level context. Overview must not
render raw stdout/stderr, full protocol payloads, JSON-RPC detail, absolute
local paths, or provider final text.

## Data Flow

The progress path is intentionally layered:

```text
Provider/App Server protocol
  -> provider adapter/materializer
  -> AgentItemRecord / AgentPlanRevisionRecord / InteractionRequestRecord
  -> runActivity model
  -> overviewRunActivity model
  -> runProgress model
  -> RunProgressCard / RunActivityTimeline
```

The renderer does not render raw provider items directly in Overview.

### Stored Records

The source records are:

- `RunRecord`
  - identifies the run, mode, status, timestamps, and terminal state;
- `AgentPlanRevisionRecord`
  - provider plan revisions for a run;
- `AgentItemRecord`
  - provider item telemetry such as messages, command executions, file changes,
    tool calls, web searches, compaction, review, and subagent activity;
- `InteractionRequestRecord`
  - Task Monki interaction requests for approvals, user input, MCP elicitation,
    and dynamic tools;
- `GitSnapshotRecord`
  - local Git evidence used for terminal footer and completed change summary;
- CI/check status
  - local/remote verification evidence used for completed-run footer text.

### Normalized Activity Projection

`src/renderer/model/runActivity.ts` owns the provider-neutral activity model.
Its public output is `RunActivityProjection`:

- `rows`
  - ordered `RunActivityRow` values;
- `sections`
  - grouped sections for Debug/provider panels;
- `outputSummary`
  - compact output summary such as `show full output · N lines`.

Each activity row has:

- `category`
  - `read`, `search`, `list`, `edit`, `write`, `patch`, `bash`, `verify`,
    `git`, `web`, `mcp`, `subagent`, `permission`, `question`, `compaction`,
    `error`, or `other`;
- `label`
  - neutral action copy such as `Read`, `Search`, `Ran`, `Edited`;
- `detail`
  - compact path, command, query, or count;
- `metric`
  - small supporting fact such as `+6 -1`, `for 18s`, or `227 lines`;
- `tone`
  - `neutral`, `success`, `action`, or `error`;
- `status`
  - `active`, `completed`, or `failed`;
- `at`
  - timestamp used for ordering;
- source ids
  - item and interaction ids for traceability.

The projection filters items by `run.id`, maps provider items to normalized
rows, maps interactions to request rows, adds waiting rows for active approval
or input states when no interaction row already covers them, sorts by timestamp,
and groups consecutive context rows.

## Mapping Rules

### Agent Messages

`AGENT_MESSAGE` can become an `other`/`Progress` row only when the text is a
useful progress sentence. The model strips progress prefixes, truncates long
text, rejects provider noise, and avoids final-output-style content. Routine
file reads, searches, commands, and protocol events should come from tool
telemetry instead of agent prose.

### Command Execution

`COMMAND_EXECUTION` prefers structured `payload.commandActions`:

- `read`
  - `Read <short path>` with line-count metric when inferable;
- `listFiles`
  - `List <short path or project files>`;
- `search`
  - `Search <query · path>`.

The fallback command path unwraps shell launchers such as `/bin/zsh -lc`, then
classifies recognized commands:

- test/build/typecheck/lint/check commands become `verify`;
- Git status/diff/show/log/rev-parse commands become `git`;
- read-context commands are shown only while active or failed;
- generic commands are shown only while active or failed.

Completed generic commands are intentionally omitted unless structured actions,
verification, Git, or failures make them useful.

### File Changes

`FILE_CHANGE.payload.changes` maps to file rows:

- create/write/add -> `write`;
- modify/edit -> `edit`;
- delete/remove -> `Delete` copy on an edit-category row;
- patch/move/rename -> `patch`;
- failed file changes -> `error`.

Diff snippets are parsed only for compact metrics such as `+6 -1`. The Overview
does not show inline diffs. Review of actual diffs belongs in the Evidence diff
surface.

### Tools, Web, Subagents, Compaction

Tool rows stay compact:

- web search -> `web`;
- MCP and dynamic tools -> `mcp`;
- subagents -> `subagent`;
- context compaction -> `compaction`.

Tool names are compacted and normalized. Raw tool payloads and protocol fields
belong in Debug.

### Interactions And Waiting

Interaction requests map to:

- `permission` for command, file-change, and permission approvals;
- `question` for user input, MCP elicitation, and dynamic tool questions.

When the run status is `AWAITING_APPROVAL` or `AWAITING_USER_INPUT`, the
projection adds a waiting row if no active interaction row already describes the
same wait.

### Context Grouping

Consecutive rows in the same context category are grouped:

- `Read 6 files`;
- `Searched 3 times`;
- `Listed 2 directories`.

Children remain available for expandable UI. Group rows preserve source ids and
status semantics. A group is failed if any child failed, active if any child is
active, otherwise completed.

## Overview Activity Formatting

`src/renderer/model/overviewRunActivity.ts` maps normalized activity rows to
Overview rows. This is a presentation-specific projection, not the source
model.

It assigns:

- row kind
  - `prose`, `command`, `context`, `file`, `tool`, or `request`;
- icon
  - message, terminal, file, search, edit, tool, wait, or error;
- detail kind
  - text, command, path, or count.

Overview-specific formatting includes:

- active command -> `Running <command>`;
- completed command -> `Ran <command> for Ns`;
- failed command -> `Command failed <command>`;
- grouped commands -> expandable `Ran N commands`;
- grouped context -> expandable `Read N files`, `Searched N times`, etc.;
- file changes -> `Wrote`, `Edited`, `Deleted`, or `Patched`;
- agent progress prose -> one prose row when the message is useful.

The overview projection groups consecutive completed commands after generic
activity normalization. This keeps a run that just executed several checks from
becoming a terminal-looking table.

## Run Progress View Model

`src/renderer/model/runProgress.ts` composes the final `RunProgressViewModel`.

It selects a progress run from:

- preferred current run when it is an implementation-side progress mode;
- otherwise the newest run in `ANALYSIS`, `IMPLEMENTATION`, `FOLLOW_UP`, or
  `RETRY`.

It intentionally excludes detached review runs from the main progress card.
Review runs are rendered by `ReviewPanel`.

The view model includes:

- `runId` and `runStatus`;
- normalized run state:
  - `RUNNING`, `COMPLETED`, `FAILED`, `INTERRUPTED`, or `RECOVERY_REQUIRED`;
- `headerLabel`;
- bounded plan steps;
- running-only `activityTail`;
- optional `activityOutputSummary`;
- terminal footer.

### Plan Handling

Plan revisions come from provider telemetry but the plan is the primary progress
structure. `runProgress` chooses the latest non-empty plan revision for the run,
normalizes duplicate/empty labels, and limits display to a compact window around
the active step.

When no provider plan is available:

- active runs show a waiting placeholder step;
- terminal runs show a single terminal fallback step.

Terminal markers are added in `RunProgressCard`, not in the provider plan model:

- failed/recovery runs mark the step where work stopped as failed;
- interrupted runs mark the step as stopped.

### Activity Tail

Only running runs receive an activity tail. `runProgress` builds the full
activity projection, formats it for Overview, then keeps the latest five rows.

The tail is a moving window, not a durable event log. Task history belongs in
Activity Timeline and Debug.

### Terminal Footer

When a run is not active, `runProgress` does not show the live activity tail.
Instead it returns a footer:

- `Completed`
  - combines local changed-file count and verification/check status;
- `Failed`
  - uses terminal reason or a fallback failure sentence;
- `Interrupted`
  - uses terminal reason or a fallback interruption sentence;
- `Recovery required`
  - tells the user recovery is needed before continuation.

For completed runs, the footer says the completion state and local-evidence
facts, for example:

```text
Completed: 10 files changed · verification not run
```

The file count and verification status are Task Monki evidence, not provider
claims.

## Renderer Components

### `RunProgressCard`

`src/renderer/ui/RunProgressCard.tsx` renders the progress view model. It is
presentation-only: it receives an already-built `RunProgressViewModel`, optional
completed-change summary content, and callbacks for Stop and Debug.

It owns UI-only terminal markers for the plan and footer rendering. It does not
parse provider payloads, choose workflow state, or infer evidence.

### `RunActivityTimeline`

`src/renderer/ui/RunActivityTimeline.tsx` renders `OverviewActivityRow[]`.

It:

- returns `null` for empty rows;
- renders the `Activity / following tail` header;
- renders grouped rows with native `<details>`;
- preserves user toggles in local component state during live rerenders;
- shows `show full output · N lines` as a Debug button when available.

It does not fetch raw output. Clicking output should take the user to Debug.

### `RunHeader`

`src/renderer/ui/RunHeader.tsx` is shared by implementation progress and review
progress. It renders one status dot, operation name, optional scope, elapsed
timer, and Stop button.

Elapsed time is UI-only. It does not affect workflow state.

### `ReviewPanel`

`src/renderer/ui/ReviewPanel.tsx` renders detached review state. It stays
provider-neutral in product copy even though the stored contract is currently
named `agentReview`.

While review is running, it shows one current-activity row. While resting, it
shows review status, reviewed diff, findings, stale context, raw review output
disclosure, and a quiet `Run review again` utility when valid.

## Evidence Boundaries

These boundaries are core product invariants:

- Provider plan and item telemetry can explain activity, but cannot decide task
  workflow phase.
- Provider command text and output do not prove tests passed.
- `COMMAND_EXECUTION` may say a command ran, but verification status must come
  from Task Monki evidence before it affects completion or delivery decisions.
- File-change provider items may explain what the agent attempted, but local
  Git snapshots prove what changed.
- Review telemetry explains review progress; review verdicts must be stored in
  the review gate projection before they affect actions.
- GitHub delivery state comes from Task Monki GitHub evidence records, not
  provider prose.
- Raw protocol data stays in Debug/provider panels.

Overview copy should never imply that provider telemetry is proof. Use neutral
verbs such as `Running`, `Ran`, `Read`, `Edited`, or `Waiting`, and rely on
footer/evidence surfaces for verified outcomes.

## Storage And Schema

The progress feature does not require a storage/schema change. It derives from
existing durable records:

- run records;
- provider item records;
- plan revision records;
- interaction request records;
- Git snapshots;
- artifacts for raw output and diffs.

Do not mutate historical provider items to make Overview easier to render.
Add renderer projections or core materialization fields only when the provider
records lack necessary stable structure.

## Performance And Bounds

The progress UI must stay compact and bounded:

- plan display is limited to a small active window;
- Overview activity tail is limited to five rows;
- context and command groups collapse repeated detail;
- text labels are truncated/compacted;
- raw output is summarized as a line count and shown in Debug, not in Overview.

Projection work is pure and synchronous over the current task snapshot. If item
volume grows enough to make this expensive, optimize the selector/model layer
instead of adding imperative state copying in React components.

## Testing Expectations

Focused coverage should live where the logic lives:

- `runActivity.test.ts`
  - provider item and interaction normalization, grouping, sanitization,
    command/file/tool mapping, stale-run exclusion;
- `overviewRunActivity.test.ts`
  - Overview row copy, command grouping, child rows, stable keys, useful prose;
- `runProgress.test.ts`
  - run selection, plan fallback, activity tail cap, terminal footers, stale run
    behavior, review-run exclusion;
- `RunActivityTimeline.test.tsx`
  - grouped row rendering and output link;
- `RunProgressCard.test.tsx`
  - running/terminal presentation;
- `ReviewPanel.test.tsx`
  - running review activity and stale/resting review states;
- seed tests
  - active and completed scenarios with realistic command actions and file
    changes.

Before merging changes that touch progress behavior, run:

```sh
npm run typecheck
npm test
npm run build
git diff --check
```

Run `npm run check:codex-protocol` when protocol bindings or provider protocol
handling are touched.

## Change Checklist

When changing agent progress:

- keep Overview provider-neutral and compact;
- keep raw provider detail in Debug;
- preserve the plan as the primary progress structure;
- do not show live activity tails for terminal runs;
- do not use provider telemetry as workflow or delivery evidence;
- update projection tests before relying on new provider item shapes;
- update seeded UI states when new activity categories or render states matter;
- update this document when data flow, invariants, or model boundaries change.
