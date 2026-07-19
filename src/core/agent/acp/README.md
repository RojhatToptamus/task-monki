# ACP runtime family

This directory implements Task Monki's registered Agent Client Protocol (ACP)
compatibility runtime family. ACP is the transport and capability-negotiation
boundary; each agent has a first-class durable runtime identity with its own
descriptor, launch command, credential contract, native session modes,
configuration selectors, models, and extension telemetry. That identity does
not imply a full native product integration: these adapters expose what stable
ACP and explicitly profile-gated extensions can prove.

## Protocol boundary

- Stable ACP wire protocol: `1`.
- Pinned schema artifact used for the typed wire subset: `v1.19.0`.
- Transport: newline-delimited JSON-RPC 2.0 over stdio.
- Client capabilities: `fs.readTextFile=false`, `fs.writeTextFile=false`,
  `terminal=false`, and `session.configOptions.boolean={}`. The last capability
  lets conforming agents expose stable boolean session options without enabling
  any Task Monki filesystem or terminal tools.
- Task Monki never executes an ACP agent's requested filesystem or terminal
  command. Unsupported client requests receive JSON-RPC `-32601`.
- Every inbound and outbound message is appended before it is acted on or
  written. Outbound messages are synced before delivery; inbound stream input
  uses bounded byte/time sync batches, and durable Task Monki record
  publication flushes its referenced journal entries first. Messages,
  per-server journal retention, and diagnostic tails are bounded; known
  credentials, authorization headers, named environment/header values, URL
  userinfo, and credential-shaped stderr values are structurally redacted at
  the durable journal boundary. Free-form session stream fields are replaced by
  a structural marker in the journal, while malformed frames expose only a
  generic marker to diagnostics rather than provider-controlled bytes.

The official `@agentclientprotocol/sdk` is ESM-only while Task Monki's main
process is currently CommonJS. `AcpProtocol.ts` and `AcpRpcClient.ts` therefore
implement a focused typed client against the stable public schema rather than
using an unsafe module shim or adding provider model SDKs. This choice should
be revisited if the main process moves to ESM. Wire compatibility is determined
by `initialize.protocolVersion`; optional behavior is enabled only from the
negotiated capabilities, never from a CLI name or guessed version.

The pinned stable schema defines session modes and configuration options, but
it does not define initialize model metadata, a session `models` response
field, or `session/set_model`. Grok Build's provider-specific model catalog is
therefore isolated behind the profile-owned
`grok-build-acp/session-models@v1` contract: initialize `_meta.modelState`
supplies the pre-session catalog, session setup revalidates
`currentModelId`/`availableModels` for the worktree, and selection uses
`session/set_model({sessionId, modelId})`. When that catalog advertises
reasoning efforts, the same profile-gated mutation carries an explicit effort
in `_meta.reasoningEffort`. Task Monki treats that captured vendor contract as
experimental and never enables it for another ACP profile.

## Provider profiles

| Runtime ID | Native launch form | Non-mutating discovery proof | Default model provider | Child environment contract |
| --- | --- | --- | --- | --- |
| `grok-acp` | `grok --no-auto-update agent stdio` | the matching `agent stdio --help` command identifies Grok's stdio agent | `xai` | `task-monki/grok-acp-environment@v1` |
| `cursor-agent-acp` | `cursor-agent acp`; an explicitly configured `agent acp` is also accepted | `help acp` identifies Cursor Agent ACP | `cursor` | `task-monki/cursor-agent-acp-environment@v1` |
| `claude-agent-acp` | `claude-agent-acp` | bridge-specific `--cli --help` delegation identifies the Claude bridge | `anthropic` | `task-monki/claude-agent-acp-environment@v1` |

Profiles launch installed executables only. Task Monki does not run `npx`,
download agents, self-update providers, or silently fall back to another
runtime. Each profile owns a versioned, exact environment-variable contract for
its credentials and supported cloud configuration. Authentication itself
remains provider-owned. The profile also owns its `TASK_MONKI_*_ACP_BIN`
executable-override key, so adding a runtime does not require a second central
runtime-to-environment mapping. Catalog discovery, preflight, and execution
resolution first probe and cache the installed executable. The long-lived ACP
child starts lazily when the first session is created or attached; Grok also
starts it when its model catalog is requested because the profile-gated catalog
is supplied by ACP initialize rather than a stable global ACP method. A persisted per-runtime executable override is
passed through the same resolver. Every candidate, including an explicit
override, must pass both its version command and its profile-owned launch-
contract probe. Probe output is bounded and checked across both stdout and
stderr. A successful `--version` response proves only that an executable ran;
it never proves ACP support or provider identity. Stable ACP wire compatibility
is still negotiated later by the live `initialize` exchange.

Environment contracts are exact key allowlists, never prefix or wildcard
rules. The shared provider-key groups and sensitive-key classifications live in
`../ProviderEnvironmentPolicy.ts`; each profile composes the exact keys it
needs in `AcpRuntimeProfiles.ts`. Provider children also receive only the small
portable base environment from `../../process/ProcessSupervisor.ts`. Sensitive
values from the same contract are redacted from diagnostics, and executable
override variables are resolver inputs rather than child environment entries.

This distinction prevents an unrelated executable from being treated as an ACP
agent. Task Monki never executes a generic PATH `agent` during
discovery. That Cursor alias is accepted only when the user
configures it explicitly and `agent help acp` proves the expected contract. Changing a saved
executable invalidates discovery and safely restarts an idle runtime; an active
or recovery-ambiguous prompt is never terminated to apply a settings change.

## Readiness and setup diagnostics

Executable discovery, live protocol initialization, provider authentication,
account compatibility, and model access are separate checks:

- `NOT_INSTALLED` means no candidate executable could be launched.
- `INCOMPATIBLE` means an executable was found but failed its provider-specific
  launch contract or live ACP negotiation.
- `DISCOVERED` means the launch contract is present. It is startable, but a
  provider session has not yet proved account and model access.
- `READY` means a provider session was created or resumed successfully.
- `AUTHENTICATION_REQUIRED` and `ACCOUNT_UNSUPPORTED` distinguish a missing
  provider sign-in from a signed-in account path the runtime cannot use.
- `FAILED` and `DEGRADED` retain bounded, redacted diagnostics and an explicit
  next action instead of collapsing every failure into “not installed.”

The Provider inspector shows readiness checks, stable diagnostic codes, the
selected executable and launch form, and rejected discovery probes. Runtime
readiness is separate from run recovery: `RECOVERY_REQUIRED` means a submitted
mutation has an ambiguous outcome and must never be automatically replayed.

## Native capability preservation

ACP session modes, configuration selectors, and model values required for
operation retain their exact provider IDs. Persisted native-state views are
schema-selected, bounded, and credential-redacted; sensitive config selectors
and opaque `_meta` fields are never copied into those surfaces.
Structurally complete, credential-redacted wire data and extension
notifications remain available only through the protected protocol journal.
Stable ACP agents may advertise a `category=model` config selector, which
remains a native configuration path. The Grok profile additionally parses its
versioned initialize and session model catalogs. The initialize catalog is safe
for runtime selection and publishes its provider-selected default; the session
response revalidates the exact ID before any prompt. Those IDs also remain in
the session's typed control set and are changed through its provider-owned
`session/set_model`. Other profiles ignore those non-standard fields. Cursor
instead uses the captured
`cursor-agent-acp/parameterized-model-picker@v1` extension. Its initialize
request alone advertises `_meta.parameterizedModelPicker`; after an explicit
Cursor selection, the adapter calls `cursor/list_available_models` before any
`session/new`. The response supplies exact model values plus per-model config
options, including `category=thought_level` reasoning choices. Auto is the exact
value `default`. Model selection is applied first because Cursor can replace
the config catalog for the selected model; reasoning is validated and applied
against that acknowledged replacement. The catalog is cached only for the
current application-scoped Cursor process and is cleared on shutdown, process
loss, executable reconfiguration, or an observed authentication/account
failure. External CLI authentication changes are not observable while the
cached process remains healthy; changing or restarting the configured runtime
establishes a new cache boundary, and a provider-reported authentication failure
clears it. Task Monki does not poll, discover at startup, discover merely because
New Task or Settings opened, create an orphan session, or persist the catalog as
a task-owned settings observation. Selected-runtime surfaces offer an explicit
Load models action and turn a failed request into Retry; the adapter retains a
typed catalog failure until retry succeeds. Other stable ACP session-only
catalogs remain scoped to the provider session that advertised them and do not
leak into New Task selection.

The Provider inspector renders only the safe semantic-neutral `BOOLEAN` and
`SELECT` controls projected for the attached session. Each control retains its
provider-owned ID, label, grouping, exact value/choices, and mutability, while
the enclosing set carries local/provider session ownership and a revision of
the catalog the user saw. The renderer never parses the opaque native blob to
discover actions. Electron IPC and the authenticated development HTTP API send
only `{controlId, value, revision}` plus durable ownership. The service rejects
active or recovery-required runs; the adapter rejects stale revisions, wrong
types, unknown controls, and choices the provider did not advertise before
mapping the control internally to the exact ACP or profile-extension method.
No arbitrary ACP RPC or opaque provider metadata is accepted from the
renderer.

Stable session features are negotiated independently:

- `session/new`, `session/prompt`, `session/cancel`, and `session/update` are
  baseline.
- `session/resume` is used only when advertised.
- `session/load` is the fallback only when `loadSession` is advertised. Its
  replayed history is isolated from live run output.
- The stable `category=model` config selector remains the baseline model path.
  Only the Grok profile may use its captured session `models` catalog and
  `session/set_model` extension. Grok's versioned `_x.ai/models/update`
  notification atomically replaces its pre-session catalog; removed models do
  not remain available. Notifications arriving beside the initialize response
  are buffered until the server's initialized state is durable, so the initial
  catalog cannot overwrite a newer provider update. An explicit model or
  reasoning effort fails clearly when the profile did not offer that exact
  value.

Session setup preserves evidence at the boundary where it was observed.
`session/new` is recorded as the provider-selected pre-configuration state
with that response's journal reference. Requested mode, model, and config
mutations are applied afterward; their projected final state is recorded as a
`TASK_MONKI_RESOLUTION`, optionally citing the final mutation response, and is
never relabeled as provider-reported settings. A later real settings update or
resume response can independently provide provider-confirmed state. Immediately
before every prompt, Task Monki revalidates the complete requested native state
and applies only values that differ. Config mutations are accepted only when
the response returns the complete configuration and confirms the requested
value. An explicit reasoning effort uses an advertised stable
`thought_level` selector or Grok's profile-gated model-mutation metadata; no
other catalog metadata is assumed writable.

Streaming materializes agent text/thoughts, tool calls and diffs, plans, usage,
native config updates, artifacts, and structured app events. Every text delta
remains an individual protocol journal entry. The normalized projection uses
one ordered per-run buffer instead of rewriting the full item and run snapshot
per token: output is appended at a 75 ms or 64 KiB boundary, while item records
are materialized at prompt terminal, runtime loss, shutdown, or an explicit
memory bound. Exact inherited credentials are redacted across delta boundaries;
an unresolved terminal prefix becomes a marker in its owning item rather than
being persisted as provider text. A 256-transition output bound also flushes
pathological streams that alternate text and reasoning on every delta. The
adapter retains at most eight live text parts per run and 4 MiB across the
runtime, counting normalized item text, its artifact copy, and redaction carry.
Capacity eviction materializes the oldest part without dropping its journal
evidence. Buffered text is stored in bounded-size segments so tiny or empty
deltas cannot create an unbounded chunk array. Ordinary artifact append failures
are attempted at most three times. An append whose outcome is ambiguous is
never retried; either exhausted path discards retained bytes, quarantines that
process generation, and requires explicit run recovery. A coalesced item
publishes one activity event, whose `coalescedEvents` count makes the compaction
visible. Permission choices retain the provider's opaque option IDs. Task Monki
intersects the offered choices with its own command/path/network policy and
sends back the exact ID selected under the provider's own label; it never
chooses the first option merely because two options share a semantic kind.
Cursor and Grok preserve a provider's remembered option when the profile and
current operation pass Task Monki's policy; the UI warns that the provider owns
its scope, storage, lifetime, and revocation, which may extend beyond the ACP
process. Remembered rejection remains available when offered. Reserved Git/GitHub delivery
commands, outside-worktree file scope, and disabled-network requests fail
closed. When Cursor omits command details for a terminal request, its profile
may expose the provider's exact one-time and provider-remembered approval
options. The user chooses among them under Ask for approval; no access mode ever
automatically selects the remembered option. Task Monki does not infer its
scope. Other ACP profiles fail closed
on opaque execution scope. Task Monki never implements a provider grant by
writing repository files or silently changing global configuration.
Only `end_turn` completes a prompt successfully. `cancelled` interrupts it;
`refusal`, `max_tokens`, and `max_turn_requests` fail it with a bounded provider
diagnostic. Cursor currently reports its exact `Upgrade your plan to continue`
account or usage gate as ordinary message text followed by `end_turn`. The
Cursor profile recognizes only that complete message as a failed turn; Task
Monki preserves the provider text and leaves implementation in a retryable
state. Other empty, read-only, and no-change `end_turn` responses remain valid
completions.

## Security and execution policy

ACP does not attest an OS filesystem or network sandbox for the provider
process. Claude and unrecognized profiles therefore expose only **Ask for
approval**. Cursor and Grok expose **Ask for approval**, **Auto-accept edits**, and **Full
access**, all with `DANGER_FULL_ACCESS`, required network, and the user as
reviewer. These policies control only responses to permission requests the
provider sends: Ask for approval asks the user, Auto-accept edits chooses an
exact `allow_once` only for verified in-worktree mutations, and Full access
automatically chooses only an exact `allow_once`. Remembered options always
require an explicit user choice and remain provider-owned. These modes do not change Cursor into its
read-only native `ask` mode and do not claim process confinement. Restricted
workspace, read-only, network-disabled, and automated-reviewer settings are
rejected instead of being silently downgraded.

For the same reason, Task Monki attachment delivery is currently unsupported
for ACP. Agents may negotiate native ACP image/resource blocks, and that state
is preserved as a native capability, but managed attachment copies are not sent
until a concrete profile can attest the required confidentiality boundary.
Browser-development mode is also unsupported because ACP capability negotiation
does not attest process, filesystem, and network isolation.

Both execution resolution and turn start reject every nonempty managed
attachment list before executable discovery, provider process startup, session
creation, or prompt submission. The adapter contains no dormant ACP attachment
serialization path.

## Recovery semantics

ACP stable v1 has no prompt-status read method. `session/prompt` is a long-lived
request whose response marks completion of the whole provider turn, so Task
Monki deliberately gives it no generic RPC completion timeout. Setup and
control requests remain bounded. A slow but healthy coding turn therefore does
not enter recovery merely because it outlives the control-request deadline.

If the process disconnects, Task Monki cannot durably acknowledge a submitted
prompt, an interrupt deadline expires, or Task Monki restarts mid-turn, the run
becomes `RECOVERY_REQUIRED`. Task Monki may resume/load the provider session
when that capability exists, but it never automatically replays the ambiguous
prompt. Pending interactions are made stale or aborted on terminal/runtime
loss. Once an interrupt deadline or runtime loss makes a prompt ambiguous, late
prompt responses, stream updates, and permission requests cannot silently
reverse the recovery decision.

All current ACP profiles use one application-scoped child process per runtime
identity. Sessions are never shared across Grok, Cursor, and Claude,
but several sessions belonging to one profile can be loaded in that profile's
process. Stable ACP session updates do not identify a Task Monki prompt/run.
Consequently, an ambiguous prompt, cancellation, permission response, or
session-control update quarantines the entire profile process: Task Monki
invalidates its client generation before shutdown, unloads every attached
session, marks affected active work for explicit recovery, and never resends
the uncertain mutation. Idle sessions may attach again through a newly started
process. This application-wide blast radius is a documented ACP compatibility
limitation, not native per-session lifecycle parity.

Every inbound notification and permission request is tagged with the bound
client generation and server instance. Once quarantine or replacement
invalidates that generation, queued or late messages from the old process are
ignored even after a new process starts. They cannot append output, complete a
run, change a plan, or create an interaction on the replacement generation.
Process exit and orderly shutdown first drain every complete frame already
accepted from stdout. A failed drain safety-fences the runtime instead of
publishing a clean shutdown or allowing a replacement process to start. After
an unexpected exit, a replacement process also waits for the exact prior
client's already-accepted adapter callbacks and loss reconciliation to settle.

Application startup passively reconciles persisted ACP runs independently of
executable discovery. Stale process records become lost and ambiguous runs
advance to a user-actionable recovery state even when the configured CLI is no
longer installed, without starting an ACP process, attaching the provider
session, or submitting any prompt.

## Deliberately unsupported today

- Active-turn steering, true pause, session fork, provider goals, general user
  input, and standardized subagent lifecycle (not in stable ACP v1).
- A provider-native detached review primitive. Higher-level generic review must
  remain gated on an attested read-only execution policy.
- Full token input/output/cache breakdown: stable ACP reports current context
  `used`/`size` and optional cost, not the richer common breakdown.
- Automatic authentication flows, session list/delete/close UI, and MCP servers
  supplied by Task Monki. Their native/negotiated metadata is retained for a
  future dedicated surface. Runtime cleanup does use stable `session/close`
  when the connected agent advertises it; release never starts a process merely
  to close a session and never closes a session with active or ambiguous work.

Focused tests include strict framing and bounds, stable-schema parsing, profile
launch-contract identity, Grok extension gating and `session/set_model`, config
mapping, all opaque permission option kinds, policy intersection, ACP
process negotiation, and an end-to-end fake ACP agent covering session
creation, streaming, permission response, plans, and terminal completion,
definitive and ambiguous failures, durable-response failure, runtime loss, and
interrupt timeout with a late provider response. A long-turn regression proves
that `session/prompt` can outlive the bounded control timeout. A high-volume
regression verifies 512 ordered deltas remain 512 protocol journal messages
while producing one normalized item write and bounded output events.
Real provider smoke tests still require each external CLI, provider
credentials/account state, and explicit integration in application
composition; tests never contact provider services.
