# Provider Runtime Compatibility

Date: 2026-07-14

This document records the provider runtimes that Task Monki currently accepts,
the integration depth of each runtime, and the operational and security limits
that apply to it. It describes implemented behavior, not provider availability
in general.

## Support tiers

- **Native first-class integration**: Task Monki uses the agent product's
  native server protocol and has a dedicated adapter for its lifecycle,
  streaming, sessions, interactions, recovery, and native features.
- **Dedicated documented CLI integration**: Task Monki uses a product's public
  non-interactive command contract in a dedicated adapter. Capabilities are
  limited to what that command can prove; Task Monki does not infer a private
  session protocol from a terminal UI or another product's integration.
- **Registered ACP compatibility integration**: the agent has its own durable
  runtime identity and provider-specific launch/profile rules, but Task Monki
  communicates through stable ACP v1. Only negotiated ACP behavior and
  explicitly implemented native session controls are supported.
- **Unsupported executable**: Task Monki has no validated runtime contract for
  the executable and will not start tasks with it or substitute it for another
  runtime.

An ACP compatibility runtime is still a distinct runtime, not a model-provider
alias. Its models, modes, configuration, credentials, process, sessions, and
telemetry are never routed through another provider. The tier describes the
depth of the protocol integration, not the importance of the provider. In
particular, “first-class runtime identity” does not mean “full native
integration”: Codex and OpenCode use native server protocols, Antigravity uses
its documented turn-scoped print command, and the ACP runtimes use stable ACP
plus explicitly captured extensions.

## Current runtime matrix

| Agent product | Runtime ID and launch contract | Tier | Current runtime coverage | Important limits and readiness conditions |
| --- | --- | --- | --- | --- |
| Codex App Server | `codex`; a resolver-selected native App Server stdio form | Native first-class | Native account and model discovery, threads, resume and fork, streamed turns, steering, interruption, approvals and user input, goals, plans, review, subagent lineage, usage, and managed attachment delivery | Requires a compatible App Server method contract, successful initialization, usable account/model state, and an attested permission profile. True pause is unsupported; some user-input, terminal, and dynamic-tool APIs remain experimental. |
| OpenCode server | `opencode`; `opencode serve --hostname 127.0.0.1 --port <allocated-port>` | Native first-class | Connected provider/model registry, model variants, sessions and native history fork, messages and parts, asynchronous prompts and abort, permissions, questions, todo plans, usage, tools/plugins/MCP telemetry, reconciliation, and bounded SSE streaming | Supports the validated OpenCode 1.x HTTP/SSE contract (`>=1.4.0` and `<2.0.0`; contract tests cover 1.17.20). Readiness verifies health, an authoritative `connected` provider list, catalog and queue endpoints, and a first SSE event; a catalog that omits connection state fails closed. Both execution presets report `DANGER_FULL_ACCESS`: `on-request` gates native mutation/external-directory tools and denies native task delegation because child permissions cannot be attested, while `never` permits them. Task Monki re-reads and attests the effective native rule suffix before each prompt and after a fork, but neither preset attests process confinement. Active-turn steering, true pause, provider goals, native review, managed attachments, and prompt refinement are unsupported. |
| Google Antigravity CLI | `antigravity`; `agy --print <prompt> --model <exact-label> --new-project --sandbox --print-timeout 30m --mode <plan\|accept-edits>` | Dedicated documented CLI | Exact model discovery through `agy models`, canonical worktree binding, one process per turn, bounded assistant output and diagnostics, process interruption, and exit-code terminal truth | Every turn is a new Antigravity project; there is no provider session ID, resume, fork, steering, structured tools/plans/approvals/questions, attachments, native review, or automatic recovery. Task Monki never uses private APIs, TUI/log scraping, ACP impersonation, or `--dangerously-skip-permissions`. `--sandbox` is mandatory, but terminal permission handling remains Antigravity-owned. The public CLI puts the full prompt in live process argv; durable argv is redacted, and task prompts must not contain secrets. Every model remains non-default; New Task may preselect the first ordered label, while execution requires its exact value and has no hidden adapter fallback. |
| Grok Build ACP | `grok-acp`; `grok --no-auto-update agent stdio` | Registered ACP compatibility | ACP streaming, tool calls and diffs, plans, usage/cost context, permissions, cancellation, provider session state, plus Grok's captured `grok-build-acp/session-models@v1` initialize/session catalog, `_x.ai/models/update` replacement catalog, and exact `session/set_model` selection | Grok's initialize `_meta.modelState`, dynamic model-update notification, session `models`, and model mutation are an experimental provider extension, not stable ACP v1. Task Monki exposes only the provider's latest valid catalog; it does not retain or invent historical Grok Build, Composer, or frontier-model entries. Advertised reasoning efforts are catalog metadata. An explicit effort is applied only through a session-advertised ACP `thought_level` selector and otherwise fails closed. `session/new` remains the initial provider observation, while acknowledged mutations are adapter-resolved unless a later provider settings observation confirms them. Installed/version state is only discovery, and operational readiness still requires successful session creation. Session resume/close and other optional behavior are enabled only when advertised by the installed agent. No managed attachments, active steering, fork, goals, general user-input request, standardized subagents, or attested detached review. |
| Cursor Agent ACP | `cursor-agent-acp`; automatic discovery uses `cursor-agent acp`, while `agent acp` is explicit-configuration only and still requires a Cursor-specific contract probe | Registered ACP compatibility | ACP streaming, tool and diff updates, plans, permissions, cancellation, Cursor-owned rules, and advertised native model/configuration selectors | Task Monki never executes a generic PATH `agent` during discovery. An explicit alias is compatibility-checked but its provenance remains the user's responsibility. ACP initialization and provider session creation are required before operational readiness. Optional resume/close and native controls depend on negotiated or session-advertised capabilities. The common ACP feature limits and full-access process boundary apply. |
| Claude Agent ACP bridge | `claude-agent-acp`; the separate `claude-agent-acp` bridge executable | Registered ACP compatibility bridge | The bridge retains Claude Agent SDK tool behavior, ACP streaming, tool/diff updates, plans, permissions, cancellation, and advertised Claude modes/configuration/model selectors | This is not a direct native integration with the `claude` CLI. The bridge executable, ACP initialization, authentication, and provider session creation must all succeed. Optional behavior is negotiated; the common ACP feature limits and full-access process boundary apply. |

## ACP compatibility boundary

All registered ACP profiles share these implemented rules:

- stable ACP wire protocol version 1 is negotiated at process startup;
- `session/new`, `session/prompt`, `session/update`, and `session/cancel` form
  the baseline; resume, load, and close are used only when advertised;
- stable modes and non-sensitive configuration selectors are retained with
  their exact IDs and can be changed from the provider overview only while the
  session is idle. Provider-specific methods are enabled only by an explicit,
  versioned profile contract; currently this applies only to Grok session
  models;
- actionable native selectors cross the service boundary only as typed,
  semantic-neutral boolean/select controls. Each set includes the exact local
  and provider session ownership plus an optimistic revision; stale revisions,
  unknown controls, wrong value types, and unadvertised choices fail closed.
  The renderer does not parse opaque native state to invent controls;
- ACP model catalogs are provider-session scoped unless an explicit profile
  contract supplies a pre-session runtime catalog. Stable ACP profiles expose
  only a profile default; exact live-session choices remain in that session's
  control set. Grok's versioned initialize metadata and dynamic replacement
  notification are the current exception. Every explicit model, mode, config,
  and reasoning choice is revalidated against the target session immediately
  before a prompt, and only values that differ from observed native state are
  mutated;
- the provider agent owns tool execution; Task Monki advertises its ACP
  filesystem and terminal client capabilities as disabled, while advertising
  the official boolean config-option client capability;
- permission choices return the exact opaque option ID advertised by the
  provider after Task Monki applies its command, path, and network policy;
- only ACP `end_turn` is successful completion. `cancelled` is interrupted;
  `refusal`, `max_tokens`, and `max_turn_requests` are failed terminal turns;
- managed Task Monki attachments, active-turn steering, true pause, native
  session fork, provider goals, general user-input requests, and standardized
  subagent lifecycle are unsupported by the current ACP integration;
- discovery proves only an executable identity and launch contract. `READY`
  requires a connected ACP v1 process and a successful provider session create
  or resume, which is where authentication, account, and model access are
  actually established.

Current ACP profiles are application-scoped per runtime identity. Grok,
Cursor, and Claude never share a process, but one profile process may carry
multiple loaded sessions for that profile. Because stable ACP session
updates do not identify the originating Task Monki run, an ambiguous prompt,
cancellation, permission response, or native-control mutation quarantines the
whole profile process. Every attached session becomes unloaded; active work on
that server requires explicit recovery, and no uncertain mutation is replayed.
This blast radius is a known boundary of the ACP compatibility tier. It is not
presented as native per-session lifecycle parity.

Task Monki's automated ACP tests use bounded fake agents and captured protocol
fixtures. A particular installed CLI and provider account remain operational
only when their live initialization and session checks succeed.

## Security and operational boundaries

- Task Monki remains authoritative for task workflow, worktrees, Git, tests,
  GitHub delivery, and acceptance. Provider output is telemetry, not verified
  evidence.
- Codex can enforce and attest its managed workspace/process/network permission
  profiles. Selecting Codex full access intentionally removes that confinement.
- OpenCode permission rules do not provide an OS sandbox. Both its approval-
  gated and no-approval presets therefore report `DANGER_FULL_ACCESS`. Its provider,
  plugins, MCP servers, and tools run in a credential-bearing process with the
  permissions of the Task Monki user. The authenticated loopback transport
  protects server access; it does not confine that process. The approval-gated
  preset denies native task delegation because OpenCode child sessions do not
  inherit a separately attested mutation policy.
- Current ACP profiles expose only `provider-controlled-full-access`. The ACP
  agent process owns filesystem and network access, and ACP permission events
  do not prove OS-level confinement.
- Antigravity receives the documented `--sandbox` boundary on every turn and
  implementation mode accepts file edits, but terminal permission decisions
  remain provider-owned. Task Monki never disables that boundary or claims a
  structured approval flow that print mode cannot expose. Its public print
  form carries the full prompt in live child argv, which same-user process
  inspection or endpoint telemetry may observe. Durable command records use a
  `<prompt>` placeholder, but users must not place secrets in Antigravity task
  prompts.
- Runtime children inherit only a minimal portable base environment. OpenCode,
  Antigravity, and ACP children additionally receive a versioned, exact provider
  environment
  contract for credentials, cloud configuration, and documented runtime config
  locations. Prefix and wildcard inheritance are not used. Codex explicitly
  adds only its own `CODEX_HOME`; that state is not part of the portable base
  and cannot reach another runtime. OpenCode's generated
  server password is passed through
  the environment, never argv. Credentials and authorization-shaped values are
  structurally redacted before bounded protocol or diagnostic data becomes
  durable. Live protocol objects remain exact for routing; separate durable and
  renderer projections are sanitized. A credential-colliding actionable
  identifier is omitted or rejected, never rewritten into a placeholder that
  could be sent back to the provider.
- Browser-development agent execution requires an attested filesystem,
  process, and network boundary. OpenCode and the current ACP profiles do not
  satisfy that boundary.
- A task and provider session remain owned by their original runtime. Task
  Monki does not migrate a session, silently fall back to another runtime, or
  automatically resend a prompt or interaction after ambiguous delivery.
- Runtime callbacks are generation-fenced. Late Codex App Server callbacks,
  OpenCode SSE events, or ACP notifications/requests from a replaced process
  cannot update a replacement run. OpenCode quarantines only the affected
  session process; ACP quarantines the application-scoped profile process.

### Child environment contracts

The code-owned contract ID is part of runtime compatibility. Each contract is
an exact allowlist plus an exact sensitive-key list used for diagnostic
redaction; changing either requires a versioned review and contract tests.
All children also receive only Task Monki's small portable base environment
(`PATH`, home/user/shell, temp, and locale). Provider-owned state is never added
to that shared base.

| Runtime | Contract | Provider/config families admitted in addition to the base environment |
| --- | --- | --- |
| Codex App Server | `task-monki/codex-environment@v1` | `CODEX_HOME` only; Codex configuration, authentication, and runtime state stay Codex-owned |
| OpenCode | `task-monki/opencode-environment@v1` | OpenCode config roots/content; OpenAI/Azure, Anthropic/Claude, xAI/Grok, AWS Bedrock, Google/Vertex/Gemini credentials and configuration; user config roots; proxy and CA configuration |
| Antigravity | `task-monki/antigravity-environment@v3` | User config/data/state/cache roots and proxy/CA configuration; on macOS Task Monki supplies the fixed non-secret `XPC_SERVICE_NAME=application.com.google.antigravity` required by the authenticated CLI instead of inheriting a caller value |
| Grok ACP | `task-monki/grok-acp-environment@v1` | xAI/Grok credentials and base URL; user config roots; proxy and CA configuration |
| Cursor Agent ACP | `task-monki/cursor-agent-acp-environment@v1` | Cursor API credential; user config roots; proxy and CA configuration |
| Claude Agent ACP | `task-monki/claude-agent-acp-environment@v1` | Anthropic/Claude, AWS Bedrock, and Google Vertex credentials and configuration; Claude config root; user config roots; proxy and CA configuration |

The authoritative key lists are
`src/core/agent/codex/CodexEnvironmentPolicy.ts`,
`src/core/agent/opencode/OpenCodeEnvironmentPolicy.ts`,
`src/core/agent/antigravity/AntigravityEnvironmentPolicy.ts`,
`src/core/agent/ProviderEnvironmentPolicy.ts`, and the provider profiles in
`src/core/agent/acp/AcpRuntimeProfiles.ts`. Runtime executable override keys are
resolver inputs and are not inherited by provider children.

### Gemini ACP replacement and stored history

Following Google's
[Gemini CLI transition announcement](https://github.com/google-gemini/gemini-cli/discussions/27274),
`gemini-acp` is no longer a registered product runtime. App-settings schema 6
migrates a default `gemini-acp` selection to `antigravity` without carrying a
model, provider, reasoning setting, or executable path across the incompatible
protocol boundary. Prompt-refinement and review selections fall back to Codex,
because Antigravity does not advertise either capability.
The normalized migration is written atomically during the first successful
load. Settings written by a newer schema are rejected without rewriting or
moving the file, so an older Task Monki build cannot discard future provider
configuration.

Historical task, session, run, event, and artifact records keep their original
`gemini-acp` runtime identity. They are immutable evidence, not live
Antigravity sessions. New Antigravity work therefore starts in a new or forked
task and never attempts to resume, rewrite, or automatically replay the former
Gemini ACP conversation.

The dedicated contract is limited to the public
[CLI reference](https://antigravity.google/docs/cli-reference),
[execution modes](https://antigravity.google/docs/cli/modes), and
[conversation lifecycle](https://antigravity.google/docs/cli-conversations).
Task Monki intentionally does not use Antigravity's interactive resume and fork
paths because the documented print invocation provides no structured lifecycle
or recovery protocol for them.

Runtime identity, capability, recovery, and evidence invariants are defined in
`docs/architecture/AGENT_RUNTIME_ARCHITECTURE.md`. Codex-specific protocol and
permission behavior is defined in `docs/APP_SERVER_ARCHITECTURE.md`.
