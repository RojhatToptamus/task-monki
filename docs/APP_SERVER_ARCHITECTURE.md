# Codex App Server Architecture

Date: 2026-06-29

This document describes the current architecture, not an old migration plan.

## Goal

Task Monki runs AI coding work through a long-lived Codex App Server while
keeping Task Monki authoritative for local evidence and workflow state.

Task Monki owns:

- task records and workflow phases;
- isolated task worktrees and branches;
- Git snapshots, dirty fingerprints, and diff artifacts;
- test execution and test artifacts;
- GitHub branch, PR, check, review, and merge evidence;
- local completion and Done transitions.

Codex owns:

- App Server lifecycle;
- provider threads and turns;
- provider items, approvals, plans, settings, usage, and subagent events;
- model catalog and supported reasoning efforts.

## Process topology

Task Monki uses one Codex App Server process per running app process.

```mermaid
flowchart LR
  UI["Renderer"] --> IPC["Typed IPC / API client"]
  IPC --> Service["TaskManagerService"]
  Service --> Orchestrator["AgentOrchestrator"]
  Orchestrator --> Adapter["AgentProviderAdapter"]
  Adapter --> Codex["CodexAppServerAdapter"]
  Codex --> RPC["CodexRpcClient"]
  RPC --> Server["codex app-server --stdio"]
  RPC --> Journal["Protocol journal"]
  Journal --> Store["FileTaskStore"]
  Service --> Git["GitSnapshotService"]
  Service --> Tests["LocalTestRunner"]
  Service --> GitHub["GitHubService"]
```

Reasons:

- App Server already supports many provider threads.
- Authentication and model catalog are process-wide.
- Per-turn working directory, sandbox, approval, network, model, and reasoning
  settings keep task execution scoped.
- One process makes request correlation and recovery easier.

## Important records

- `Task`
  - User intent, workflow phase, current implementation-side run, worktree,
    projections, and evidence pointers.
- `RunRecord`
  - One implementation, follow-up, retry, review, or provider-origin child run.
    Fork alternatives are represented as a new `Task` with its own
    implementation run, not as a run inside the source task.
- `AgentSessionRecord`
  - Provider thread/session metadata. Primary sessions are used for
    implementation-side work. Review sessions use `role: "REVIEW"`.
- `AgentServerInstance`
  - Codex App Server process state, runtime version, schema hash, and status.
- `AgentProtocolJournal`
  - Append-only raw protocol messages for debugging and reconstruction.
- `StatusProjection`
  - Compact UI-facing state derived from Task Monki domain events.

## Provider adapter responsibilities

The adapter must:

- launch and initialize the App Server;
- start the embedded App Server from Task Monki's core app settings. The default
  is local-only: apps disabled, web search disabled, and discovered MCP servers
  disabled through per-server runtime config overrides so local coding turns do
  not inherit unrelated user/plugin tool processes;
- allow explicit settings opt-in for cached or live Codex web search, all
  configured Codex MCP servers, and Codex apps/connectors when a task needs
  those external tools;
- avoid copying MCP environment values into stored App Server argv records when
  building those runtime config overrides;
- opt out of high-volume provider delta notifications that Task Monki does not
  use as verified evidence;
- discover account, models, supported reasoning efforts, and settings;
- create, attach, and read provider sessions;
- fork provider sessions only for detached Codex review when supported;
- start implementation, follow-up, retry, and review turns;
- correlate provider thread IDs, turn IDs, item IDs, and request IDs;
- materialize useful provider events into Task Monki records;
- keep raw protocol traffic in the journal;
- recover or locally reconcile when provider delivery is ambiguous.

The adapter must not:

- decide Task Monki workflow phase by trusting provider text;
- treat provider debug state as local evidence;
- let detached review runs replace the implementation run;
- expose experimental protocol features without explicit capability gates.

## Turn modes

- `IMPLEMENTATION`
  - First coding run for a task.
- `FOLLOW_UP`
  - Continuation with new instructions, including requested review changes.
- `RETRY`
  - Another attempt after a previous run.
- `REVIEW`
  - Detached read-only quality gate. It inspects the current diff and stores
    `projection.codexReview`.
- Provider-origin child runs
  - Observed child/subagent activity. These do not replace the task workflow.

Fork alternatives are intentionally not a `RunRecord.mode`. They are created by
Task Monki as a new task with a separate worktree, branch, iteration, fresh
provider session, and implementation run. The source task stores the alternative
task id, and the alternative stores its source task/run ids for traceability.
After creation, workflow and delivery actions on either task are independent.
If worktree or run startup fails after the alternative task is stored, Task
Monki leaves the alternative visible and blocked rather than silently hiding the
partial candidate.

Read `docs/research/CODEX_REVIEW_WORKFLOW_LIFECYCLE.md` before changing review
mode or follow-up behavior.

## Settings

Task and review execution settings include:

- model;
- reasoning effort;
- sandbox;
- approval policy;
- network access;
- test command.

Settings are validated against the live model catalog before a turn starts.
Renderer settings should update both implementation defaults and review defaults
so the app uses the configured reasoning level consistently.

Core app settings also include Codex external tool settings:

- web search mode: disabled, cached, or live;
- MCP servers: disabled or all configured servers;
- apps/connectors: disabled or enabled.

These settings are persisted outside the task store schema and apply before the
embedded App Server starts. If they change while no agent turn is active, Task
Monki restarts the App Server so the new launch config is effective immediately.
If an agent turn is active, the setting is stored and applies after the App
Server restarts.

Prompt refinement uses a short-lived `codex exec --json --ephemeral` subprocess
rather than the persistent App Server. Task Monki applies the same external tool
settings to that subprocess and supplies compact local repository context itself.
The refinement prompt must not ask the subprocess to inspect the repository with
shell commands; prompt refinement is a fast rewrite step, not a detached agent
investigation.

Codex protocol detail:

- `turn/start` has a first-class `effort` field.
- `thread/start`, `thread/resume`, and `thread/fork` do not; they must pass
  `model_reasoning_effort` through the request `config` object.
- Reviews use `thread/fork` before `review/start`, so review latency depends on
  this config being set correctly.
- Task Monki starts `review/start` inline on that fork. Requesting a second
  detached review thread can lose the fork cwd and review unrelated local
  changes.

## Recovery rules

Provider delivery can be ambiguous. The app must handle:

- stale provider turn IDs;
- `no active turn to interrupt`;
- App Server exit during interrupt or review;
- late protocol errors after a server already reached a terminal state;
- missing terminal events after interruption.

Recovery must prefer a truthful local state over an endlessly running UI. If the
provider cannot confirm a terminal event, record the ambiguity and reconcile
locally when the evidence proves the run is no longer active.

## Verification

Use these before merging App Server or workflow changes:

```sh
npm run typecheck
npm test
npm run build
npm run check:codex-protocol
git diff --check
```
