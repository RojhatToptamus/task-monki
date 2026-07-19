# Codex App Server Architecture

Date: 2026-07-18

This document describes the Codex runtime adapter. The provider-neutral runtime
registry and cross-runtime invariants live in
`docs/architecture/AGENT_RUNTIME_ARCHITECTURE.md`.

## Goal

The Codex integration runs AI coding work through a long-lived Codex App Server
while Task Monki remains authoritative for local evidence and workflow state.

Task Monki owns:

- task records and workflow phases;
- isolated task worktrees and branches;
- Git snapshots, dirty fingerprints, and diff artifacts;
- GitHub branch, PR, check, review, and merge evidence;
- local acceptance and Done transitions.

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
  Orchestrator --> Adapter["AgentRuntimeAdapter"]
  Adapter --> Codex["CodexAppServerAdapter"]
  Codex --> RPC["CodexRpcClient"]
  RPC --> Server["resolved codex app-server stdio transport"]
  RPC --> Journal["Protocol journal"]
  Journal --> Store["FileTaskStore"]
  Service --> Git["GitSnapshotService"]
  Service --> GitHub["GitHubService"]
```

Reasons:

- App Server already supports many provider threads.
- Authentication and model catalog are process-wide.
- Per-turn working directory, sandbox, approval, network, model, and reasoning
  settings keep task execution scoped.
- One process makes request correlation and recovery easier.

The integration follows the public
[Codex App Server contract](https://learn.chatgpt.com/docs/app-server): initialize
once per connection, use version-matched generated schemas, stream thread/turn/item
notifications, and gate experimental methods through negotiated capability. The
stdio transport remains the production default; unsupported experimental
WebSocket transport is not used.

## Important records

- `Task`
  - User intent, workflow phase, current implementation-side run, worktree,
    projections, and evidence pointers. Composer-created tasks may also retain
    an opaque creation token and normalized-request fingerprint so a lost create
    response resolves to the same durable task rather than consuming its draft
    twice.
- `Repository`
  - Stable domain identity plus the mutable local checkout path, availability,
    and observed Git metadata. Tasks and worktrees reference the repository ID.
- `Board`
  - A named saved filter containing repository IDs, workflow phases, and a
    presentation color. It does not contain task membership or workflow truth.
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
  - Bounded append-only NDJSON segments for structurally redacted protocol
    debugging. Segment zero keeps the unnumbered server journal path; rotated
    references carry an explicit segment. Complete old segments are pruned at
    the per-server retention bound. Across every runtime, only the eight newest
    unreferenced terminal server records are retained; referenced and
    nonterminal servers are protected. The store removes a collected server
    record durably before its serialized journal cleanup, and startup
    reconciles safe orphan segments. Debug history is therefore neither a
    lossless provider transcript nor a permanent audit log.
- `StatusProjection`
  - Compact UI-facing state derived from Task Monki domain events.
- `TaskAttachmentRecord`
  - Path-free durable metadata for one app-managed task input. Immutable
    task-owned files live outside Git worktrees and are reverified before
    provider delivery.
- `RunRecord.attachmentSubmissions`
  - Path-free evidence recorded only after `turn/start` succeeds. It identifies
    the verified bytes and submission mode, but does not assert that the model
    read or used them.

## Codex adapter responsibilities

The adapter must:

- resolve, launch, and initialize a compatible App Server runtime;
- probe Codex App Server support by capability rather than rejecting runtimes
  solely because their version is newer than the generated protocol baseline;
- start the embedded App Server from Task Monki's core app settings. The default
  is local-only: apps disabled, web search disabled, and discovered MCP servers
  disabled through per-server runtime config overrides so local coding turns do
  not inherit unrelated user/plugin tool processes;
- allow explicit settings opt-in for cached or live Codex web search, all
  configured Codex MCP servers, and Codex apps/connectors when a task needs
  those external tools in packaged Electron. Browser development forces all
  three modes off, rejects enable attempts, and aborts before App Server launch
  unless every enabled MCP entry can be discovered and explicitly disabled;
- validate settings reported by thread start/resume/fork responses before
  persistence or a subsequent turn/review operation. In browser development,
  an unsafe response or live settings notification latches the adapter closed
  and stops the process before any storage wait;
- avoid copying MCP environment values into stored App Server argv records when
  building those runtime config overrides;
- opt out of high-volume provider delta notifications that Task Monki does not
  use as verified evidence;
- discover account, models, supported reasoning efforts, and settings;
- create, attach, and read provider sessions;
- fork Codex sessions only when the Codex runtime supplies the detached-review path;
- start implementation, follow-up, retry, and review turns;
- correlate provider thread IDs, turn IDs, item IDs, and request IDs;
- materialize useful provider events into Task Monki records;
- keep structurally redacted protocol traffic in the journal;
- recover or locally reconcile when provider delivery is ambiguous;
- resolve attachment records only from Task Monki storage, reverify their
  immutable task-owned files, use native `localImage` inputs when appropriate,
  and persist path-free submission
  evidence on the run without claiming model consumption.

The adapter must not:

- decide Task Monki workflow phase by trusting provider text;
- treat provider debug state as local evidence;
- let detached review runs replace the implementation run;
- expose experimental protocol features without explicit capability gates;
- accept renderer-supplied or canonical task-store file paths, or claim generic
  App Server file or PDF support that the live protocol does not provide.

The complete attachment storage, delivery, cleanup, and security contract is in
`docs/architecture/ATTACHMENT_LIFECYCLE.md`.

## Attachment protocol boundary

The generated Codex protocol currently exposes `text`, `image`, `localImage`,
  `skill`, and `mention` user inputs. It does not expose a generic file or PDF
turn input. Task Monki therefore sends supported images through `localImage`
after reverifying the immutable task-owned file. It provides supported
text-like files through an untrusted-data prompt manifest containing the exact
read-only managed path. Task-owned files remain outside Git worktrees and are
reused across runs and reviews. PDFs, Office files, video, audio, archives,
databases, and arbitrary binaries remain unsupported because they require a
separately secured extraction or tool boundary.

For scoped execution, the adapter supplies a complete, collision-resistant
permission profile through the existing thread-local config layer. It grants
`:minimal`, the exact worktree, and exact verified task attachment files.
Full access instead selects Codex's documented `:danger-full-access` built-in;
Task Monki does not label a worktree-scoped custom profile as unrestricted.
Multi-agent V1/V2 and memories are disabled in both configurations. Runtime
discovery proves the custom-profile surface with a disposable ephemeral thread
before selecting a Codex binary.

Thread create, resume, fork, each ordinary turn, recovery, and the explicit
fork-plus-inline review path all require the returned active profile and sole
runtime workspace root before provider input. Live settings drift terminates
the provider and fails active runs. Attachment reads therefore need no separate
permission escalation or path expansion flow.

Full access remains available for attachment-free tasks and requires the
runtime to attest the exact `:danger-full-access` profile and sole Task Monki
worktree root. It is rejected when attachments are present. Attachment tasks
also force network off and require Codex web search, MCP servers, and apps to be
disabled because filesystem rules do not confine same-user external tools.

Codex serializes a submitted `localImage` into an image data URL in its
model-facing conversation history. Opaque delivery paths can still occur in
the outbound request, provider telemetry, and raw protocol journal, so Task
Monki makes no complete-erasure claim. Normal task snapshots, interaction
requests, approval decisions, and submission evidence remain path-free.
External provider permission paths are redacted and declined. The Debug view
shows the path-free submission record, not proof of model consumption.

Private managed storage, atomic synchronized writes, startup reconciliation,
the HTTP/Vite token boundary, Electron sender guards, and
transport resource limits are Task Monki responsibilities, not provider
capabilities. They are defined in the attachment lifecycle document rather
than inferred from Codex events.

## Turn modes

- `IMPLEMENTATION`
  - First coding run for a task.
- `FOLLOW_UP`
  - Continuation with new instructions, including requested review changes.
- `RETRY`
  - Another attempt after a previous run.
- `REVIEW`
  - Detached read-only quality gate. It inspects the current diff and stores
    `projection.agentReview`.
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

Read `docs/workflows/AGENT_REVIEW_WORKFLOW_LIFECYCLE.md` before changing review
mode or follow-up behavior.

## Local preview control plane

Preview is a separate Task Monki-owned domain, not a Codex turn, agent run mode,
workflow transition, or provider-evidence stream. Its manager, graph, native
launcher, managed OCI and Compose runtimes, encrypted vault, loopback gateway,
store records, stop-only reconciliation, and renderer projection have their own
authority and shutdown boundaries.

The canonical current description is
[Preview Architecture](architecture/PREVIEW_ARCHITECTURE.md). Repository
authors and users should read the [Preview Guide](PREVIEW_GUIDE.md). Those
documents define native and Compose behavior, capability approval, source
generations, private inputs, attached dependencies, exact ownership, destructive
cleanup, shutdown, and recovery without duplicating the App Server lifecycle
here.

Graceful app quit fences new service actions and starts the Preview and Codex
runtime owners' single-flight shutdown paths together. App Server shutdown
cancels pending startup/restart work, drains RPC handling, removes process
listeners, and terminates its portable child process tree. Preview shutdown
independently cancels and joins generation work, watches, sockets, and cleanup.
Preview events never update `Task.workflowPhase` or the agent projection.

## Renderer and development-host trust

The Electron renderer runs with context isolation and sandboxing, without Node
integration. A local CSP permits only packaged renderer assets and the exact
development WebSocket origin when applicable. Typed IPC rejects messages that
do not originate from the expected main frame, and the main process blocks
renderer navigation, popup creation, permission requests, and unexpected
external targets.

The browser development host is a distinct loopback boundary. Its API requires
a short-lived private token transferred to Vite through a one-use local lease,
plus the exact Host, renderer Origin, and Fetch Metadata. It bounds JSON bodies
and event streams and closes both during process shutdown. Browser-hosted agent
runs are non-escalatable: network access and external Codex tools are forced
off, and unsafe persisted settings are refused. Deterministic seed hosts keep
the provider inert so synthetic provider records cannot start a live Codex
process.

## Settings

Task and review execution settings stored on task/run records include:

- model;
- reasoning effort;
- sandbox;
- approval policy;
- approval reviewer;
- network access.

Settings are validated against the live model catalog before a turn starts. An
explicit model must match that catalog exactly, including after one forced
refresh; only an omitted or `default` selection may use the provider default.
Renderer settings should update both implementation defaults and review defaults
so the app uses the configured reasoning level consistently.

App-level user preferences are separate from `FileTaskStore`. The Electron app
stores them in `app-settings.json` directly under `app.getPath('userData')`.
The development HTTP server uses `TASK_MANAGER_APP_SETTINGS_PATH` or an
`app-settings.json` file beside the dev store. These settings include:

- theme, sidebar, and mascot preferences;
- first-launch setup completion;
- default implementation, review, and prompt-refinement models;
- selected repository ID for the new-task default;
- Codex external tool modes for web search, MCP servers, and apps;
- external executable path preferences for Git, Codex CLI, and GitHub CLI;
  other registered runtimes use PATH or their documented environment override;
- the persisted high loopback port used by the local preview gateway.

Empty executable paths mean Auto-detect. The main process resolves and probes
executables live; resolved paths and detected versions are not persisted. Git
and at least one ready agent runtime are required, while GitHub CLI is optional.
The executable environment variables
`TASK_MANAGER_GIT_PATH`, `TASK_MONKI_CODEX_BIN`, and `TASK_MANAGER_GH_PATH`
act as debug overrides ahead of saved settings.

Repository records and boards belong to `FileTaskStore`, not app settings.
Only the current store and settings schema versions are accepted. Older or
invalid versions fail closed with an instruction to discard the local data;
Task Monki does not migrate, reinterpret, or fall back to older shapes. Startup
reconciliation is limited to current-schema runtime evidence such as an
interrupted provider turn and does not repair missing schema fields.

Codex Auto-detect status may display the resolved `codex` path, but that
auto-discovered path is not passed as an explicit App Server runtime. In Auto
mode, App Server startup leaves the executable unset so capability-based
runtime resolution can scan all candidates and choose a compatible runtime.
Saved custom paths, constructor overrides, and `TASK_MONKI_CODEX_BIN` are
intentional and are passed explicitly.

## Runtime resolution

Task Monki resolves a Codex executable before launching the long-lived App
Server. Resolution checks explicit configuration first, then the
`TASK_MONKI_CODEX_BIN` environment override, then every `codex` found on `PATH`,
then known bundled runtimes such as Codex Desktop and the OpenAI Codex VS Code
extension.

Automatic discovery does not fail on the first stale binary. Each candidate is
probed with `--version`, `codex app-server --help`, an isolated temporary
`CODEX_HOME`, `initialize`, and the JSON-RPC methods Task Monki needs. The
newest compatible automatically discovered runtime is selected. An explicit
configured runtime is treated as intentional and must itself be compatible.
`CODEX_HOME` belongs to the versioned Codex child-environment contract; it is
not part of Task Monki's portable process base and is never forwarded to
OpenCode or ACP children.
The selected runtime, all candidate versions, rejected candidates, missing
capabilities, and probe failures are persisted on the App Server instance and
shown only in provider diagnostics/debug surfaces.

The default transport is the documented local stdio App Server transport. Task
Monki prefers `codex app-server --stdio`, uses `--listen stdio://` when that is
the supported stdio form, and can fall back to `codex app-server` only when the
runtime documents default stdio but not a stdio flag.

Codex protocol detail:

- `turn/start` has a first-class `effort` field.
- `thread/start`, `thread/resume`, and `thread/fork` do not; they must pass
  `model_reasoning_effort` through the request `config` object.
- `thread/start` allocates an empty thread on the current App Server but does
  not create a resumable rollout. The first `turn/start` therefore uses the
  newly attested thread directly; calling `thread/resume` first fails with
  `no rollout found for thread id` on the real runtime. The initial permission
  profile includes the exact storage-verified attachment paths needed by that
  first turn.
- An empty thread is reusable only while the adapter retains its permission
  attestation for the current App Server generation. After a process restart
  or a pre-turn profile change, Task Monki replaces the empty thread with a new
  attested `thread/start`. This is safe because no prompt was submitted. Once
  Task Monki is ready to submit the first `turn/start`, it first persists the
  run as starting, then durably fences the session as potentially materialized.
  It drains queued provider notifications and rechecks the live App Server
  generation and exact permission attestation immediately before submission.
  Therefore a pending permission drift blocks provider input, while a lost
  acknowledgement or post-acknowledgement storage failure can only take the
  resume-and-reconcile path; it can never replace the thread and replay the
  prompt. A definitive JSON-RPC rejection may clear the fence only after queued
  evidence is drained, the local run still has no provider turn identity, and
  no provider notification has failed to materialize since the empty-thread
  attestation and submission boundary. Timeout, transport ambiguity, or failed
  evidence materialization retain it. Provider reads never downgrade a durable
  materialization fence merely because a transient response has no turns. The
  normal resume-and-attest path is required for every later turn.
- Reviews use `thread/fork` before `review/start`, so review latency depends on
  this config being set correctly.
- Task Monki starts `review/start` inline on that fork. Requesting a second
  detached review thread can lose the fork cwd and review unrelated local
  changes.

## Recovery rules

Provider delivery can be ambiguous. The app must handle:

- a provider mutation that is acknowledged before Task Monki can durably save
  the provider session, turn identity, or attachment submission evidence;
- stale provider turn IDs;
- `no active turn to interrupt`;
- App Server exit during interrupt or review;
- late protocol errors after a server already reached a terminal state;
- missing terminal events after interruption.

Recovery must prefer a truthful local state over an endlessly running UI. An
acknowledged mutation followed by local persistence failure is not safe to
replay as a new mutation: keep the run in recovery-required state for
reconciliation. If first-turn acknowledgement persistence fails, the durable
pre-submit materialization fence prevents empty-thread replacement and Task
Monki stops the owning App Server process before returning the ambiguity. The
process and client are fenced before Task Monki attempts to persist the final
lost-process diagnostic; even diagnostic persistence failure cannot leave a
reusable client alive. A process that cannot be confirmed stopped latches the
supervisor lifecycle closed. Attachments remain immutable task-owned inputs and
are reused after reconciliation; there is no disposable run-specific
attachment copy. If the provider cannot confirm a terminal event, record the
ambiguity and reconcile locally when the evidence proves the run is no longer
active.

Inbound notifications follow the same no-resend rule. After the RPC client has
journaled a notification, the adapter serializes its normalized storage writes
on one inbound queue. A failed notification write increments the empty-thread
materialization generation before recovery, so a concurrent first turn cannot
cross that failed-evidence boundary. For a notification that identifies a
Task Monki thread or submitted turn, the adapter then performs one targeted
`thread/resume` snapshot reconciliation on that run; it never replays
`turn/start`. A terminal snapshot retries the idempotent final-artifact and
terminal-event materialization, while a live or uncertain snapshot leaves an
explicit recovery-required run. Notifications emitted for that same thread or
turn while its snapshot recovery is in flight remain serialized, but they do
not start a nested recovery loop; the resume response is the authoritative
recovery snapshot. Concurrent notifications for other runs retain their own
recovery path.

If that targeted path cannot durably leave the run terminal or
recovery-required, the adapter latches readiness failed, clears its live
attestations and deadlines, and stops the owning App Server through a one-way
supervisor fence. The fenced generation is not automatically restarted. Only
after the process boundary is closed does Task Monki best-effort record runtime
loss for every run and pending interaction owned by that server. Failures in
that loss sweep are diagnostic-only and do not recursively invoke notification
recovery; a new application/runtime supervisor must reconcile the durable
records later. Thus a dropped terminal write cannot leave a reusable provider
generation silently running behind a local `RUNNING` record.

Intentional shutdown uses the same serialized runtime-loss settlement before it
returns. On application startup, active runs and actionable interactions are
reconciled even when their owning server record already reached `EXITED`,
`FAILED`, or `LOST`; a terminal process record never makes active ownership
safe by itself.

## Verification

Use these before merging App Server or workflow changes:

```sh
npm run typecheck
npm test
npm run build
npm run check:codex-protocol
git diff --check
```
