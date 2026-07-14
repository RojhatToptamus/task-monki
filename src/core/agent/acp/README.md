# ACP runtime family

This directory implements Task Monki's first-class Agent Client Protocol (ACP)
runtime family. ACP is the transport and capability-negotiation boundary; each
agent remains a distinct runtime with its own descriptor, launch command,
credentials, native session modes, configuration selectors, models, and
extension telemetry.

## Protocol boundary

- Stable ACP wire protocol: `1`.
- Pinned schema artifact used for the typed wire subset: `v1.19.0`.
- Transport: newline-delimited JSON-RPC 2.0 over stdio.
- Client capabilities: `fs.readTextFile=false`, `fs.writeTextFile=false`, and
  `terminal=false`.
- Task Monki never executes an ACP agent's requested filesystem or terminal
  command. Unsupported client requests receive JSON-RPC `-32601`.
- Every inbound and outbound message is appended before it is acted on or
  written. Outbound messages are synced before delivery; inbound stream input
  uses bounded byte/time sync batches, and durable Task Monki record
  publication flushes its referenced journal entries first. Messages,
  per-server journal retention, and diagnostic tails are bounded; known
  credentials and credential-shaped stderr values are redacted.

The official `@agentclientprotocol/sdk` is ESM-only while Task Monki's main
process is currently CommonJS. `AcpProtocol.ts` and `AcpRpcClient.ts` therefore
implement a focused typed client against the stable public schema rather than
using an unsafe module shim or adding provider model SDKs. This choice should
be revisited if the main process moves to ESM. Wire compatibility is determined
by `initialize.protocolVersion`; optional behavior is enabled only from the
negotiated capabilities, never from a CLI name or guessed version.

## Provider profiles

| Runtime ID | Native launch form | Default model provider |
| --- | --- | --- |
| `gemini-acp` | `gemini --acp` | `google` |
| `grok-acp` | `grok --no-auto-update agent stdio` | `xai` |
| `cursor-agent-acp` | `cursor-agent acp` (with installed `agent` fallback) | `cursor` |
| `claude-agent-acp` | `claude-agent-acp` | `anthropic` |

Profiles launch installed executables only. Task Monki does not run `npx`,
download agents, self-update providers, or silently fall back to another
runtime. Each profile has a narrow environment-variable allowlist for its own
credentials. Authentication itself remains provider-owned. Catalog discovery,
preflight, model listing, and execution resolution only probe and cache the
installed executable; the long-lived ACP child starts lazily when the first
session is created or attached. A persisted per-runtime executable override is
passed through the same resolver. Changing it invalidates discovery and safely
restarts an idle runtime; an active or recovery-ambiguous prompt is never
terminated to apply a settings change.

The generic Cursor `agent` fallback is ambiguous on `PATH`, so a successful
`--version` probe is insufficient. It is selected only when bounded
`agent help acp` output proves Cursor ACP identity; otherwise discovery skips it
and tries `cursor-agent` or fails closed. An explicit custom wrapper can still
be configured through the per-runtime executable override.

## Native capability preservation

ACP session modes, configuration selectors, and model values required for
operation retain their exact provider IDs. Renderer and persisted native-state
views are schema-selected, bounded, and credential-redacted; sensitive config
selectors and opaque `_meta` fields are never copied into those surfaces.
Lossless wire data and extension notifications remain available only through
the protected protocol journal. Model selectors create runtime-qualified model
records, and dedicated ACP methods expose exact native mode and config updates
without pretending those controls exist on every provider. Task Monki exposes
those two operations through a discriminated service contract, Electron IPC,
and the development HTTP/renderer client API. The service validates task,
session, and runtime ownership and rejects changes during active or
recovery-required runs; it does not expose arbitrary ACP RPC.

Stable session features are negotiated independently:

- `session/new`, `session/prompt`, `session/cancel`, and `session/update` are
  baseline.
- `session/resume` is used only when advertised.
- `session/load` is the fallback only when `loadSession` is advertised. Its
  replayed history is isolated from live run output.
- Model configuration is applied only through an advertised `category=model`
  selector. An explicit model fails clearly when the agent exposes no selector
  or does not offer that value.

Streaming materializes agent text/thoughts, tool calls and diffs, plans, usage,
native config updates, artifacts, and structured app events. Every text delta
remains an individual raw journal entry. The normalized projection uses one
ordered per-run buffer instead of rewriting the full item and run snapshot per
token: output is appended at a 75 ms or 64 KiB boundary, while item records are
materialized at prompt terminal, runtime loss, shutdown, or an explicit memory
bound. A 256-transition output bound also flushes pathological streams that
alternate text and reasoning on every delta. The adapter retains at most eight
live text parts per run and 4 MiB of text across the runtime; capacity eviction
materializes the oldest part without dropping its raw evidence. Buffered text
is stored in bounded-size segments so tiny or empty deltas cannot create an
unbounded chunk array. A coalesced item publishes one activity event, whose
`coalescedEvents` count makes the compaction visible. Permission choices retain
the provider's opaque option IDs. Task Monki intersects the offered choices
with its own command/path/network policy and sends back the exact ID;
unverifiable scope and reserved Git/GitHub delivery commands fail closed.

## Security and execution policy

ACP does not attest an OS filesystem or network sandbox for the provider
process. The current profiles therefore expose one truthful preset:
`provider-controlled-full-access` (`DANGER_FULL_ACCESS`, network required,
on-request approvals, user reviewer). Restricted workspace, read-only,
network-disabled, automated-reviewer, and `never`-approval settings are rejected
instead of being silently downgraded.

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

ACP stable v1 has no prompt-status read method. If a submitted prompt times out,
the process disconnects, or Task Monki restarts mid-turn, the run becomes
`RECOVERY_REQUIRED`. Task Monki may resume/load the provider session when that
capability exists, but it never automatically replays the ambiguous prompt.
Pending interactions are made stale or aborted on terminal/runtime loss. Once
an interrupt deadline or runtime loss makes a prompt ambiguous, late prompt
responses, stream updates, and permission requests cannot silently reverse the
recovery decision.

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
- A dedicated visual editor for native mode and configuration selectors. The
  typed application and client APIs are available; the generic metadata debug
  view remains read-only until a cohesive provider-settings UI is added.

Focused tests include strict framing and bounds, schema parsing, profile
identity, native model/config mapping, all opaque permission option kinds,
policy intersection, supervised process negotiation, and an end-to-end fake
ACP agent covering session creation, streaming, permission response, plans, and
terminal completion, definitive and ambiguous failures, durable-response
failure, runtime loss, and interrupt timeout with a late provider response. A
high-volume regression verifies 512 ordered deltas remain 512 raw journal
messages while producing one normalized item write and bounded output events.
Real provider smoke tests still require each external CLI, provider
credentials/account state, and explicit integration in application
composition; tests never contact provider services.
