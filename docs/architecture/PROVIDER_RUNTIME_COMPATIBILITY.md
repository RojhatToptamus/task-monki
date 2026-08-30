# Provider Runtime Compatibility

Date: 2026-08-30

This document records the provider runtimes that Task Monki currently accepts,
the integration depth of each runtime, and the operational and security limits
that apply to it. It describes implemented behavior, not provider availability
in general.

## Support tiers

- **Native first-class integration**: Task Monki uses the agent product's
  native server protocol and has a dedicated adapter for its lifecycle,
  streaming, sessions, interactions, recovery, and native features.
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
integration”: Codex and OpenCode use native server protocols, while the ACP
runtimes use stable ACP plus explicitly captured extensions.

## Current runtime matrix

| Agent product | Runtime ID and launch contract | Tier | Current runtime coverage | Important limits and readiness conditions |
| --- | --- | --- | --- | --- |
| Codex App Server | `codex`; a resolver-selected native App Server stdio form | Native first-class | Native account and model discovery, threads, resume and fork, streamed turns, steering, interruption, approvals and typed user input, goals, plans, usage, managed attachment delivery, shared read-only workflows, and native Design tool transport | The packaged `0.151.0-alpha.7.2` runtime with GPT-5.6-Luna passed native image and Design qualification. Other Codex pairs remain Design-unqualified. Review, prompt refinement, and Discourse use an attested read-only profile. Task Monki compares repository state after each read-only turn. Task Monki negotiates the experimental API family for generated `item/tool/requestUserInput` requests. It waits for `serverRequest/resolved` after each reply. True pause is unsupported. User input, terminal, and dynamic-tool protocol methods remain experimental. |
| OpenCode server | `opencode`; `opencode serve --hostname 127.0.0.1 --port <allocated-port>` | Native first-class | Connected provider and model registry, variants, sessions, native history fork, messages, parts, asynchronous prompts, abort, permissions, questions, plans, usage, recovery, bounded SSE, attachments, read-only workflows, and Design MCP transport | Task Monki supports OpenCode `>=1.4.0` and `<2.0.0`. Packaged tests cover `1.18.25`. MiMo V2.5 passed text and image delivery. Review, refinement, and Discourse use a dedicated `--pure` session with native deny rules. The process remains unconfined and uses provider network access. MiMo V2.5 failed two bounded Design runs because its skill and browser behavior was unreliable. The HTTP, MCP, Preview, candidate, and Ready paths worked. Active steering, true pause, provider goals, and Design remain unsupported. |
| Grok Build ACP | `grok-acp`; `grok --no-auto-update --permission-mode default agent stdio` | Registered ACP compatibility | ACP streaming, tool calls and diffs, plans, usage and cost context, permissions, cancellation, provider sessions, embedded text, qualified image input, Design MCP transport, and the captured `grok-build-acp/session-models@v1` contract | Grok Build `1.0.13` sends verified text as an embedded resource. Grok 4.6 also passed native PNG image qualification. Its handshake reports `image: false`, so Task Monki shows capability drift. Other versions, models, and image formats stay disabled. Grok plan mode still permits mutation through shell, MCP, or subagents. Therefore read-only workflows remain disabled. Two Design runs used the full tool path but did not settle within 900 seconds. Design remains disabled for this pair. Normal Tasks remain available. Active steering, fork, goals, general user input, and standardized subagents remain unsupported. |
| Cursor Agent ACP | `cursor-agent-acp`; automatic discovery uses `cursor-agent acp`, while `agent acp` needs explicit configuration and a Cursor contract probe | Registered ACP compatibility | ACP streaming, tool and diff updates, plans, exact permission choices, cancellation, Cursor rules, lazy model discovery, native session controls, text, qualified image input, read-only workflows, and Design MCP transport | Cursor `2026.08.25-3e8eec8` sends text as a bounded ACP text block. Composer 2.5 passed native PNG and Design qualification. It also passed the current nine-scenario regression. Other versions, models, and image formats remain text-only and Design-unqualified. Cursor Ask mode provides the read-only policy. Task Monki rejects each permission request and compares repository state after the turn. Cursor does not advertise additional directories, so Task Monki omits that field. The process remains unconfined and uses provider network access. Active steering, fork, goals, general user input, and standardized subagents remain unsupported. |
| Claude Agent ACP bridge | `claude-agent-acp`; the separate `claude-agent-acp` bridge executable | Registered ACP compatibility bridge | Claude Agent ACP `0.70.0` with Claude Code `2.1.239` is installed. The bridge provides ACP streaming, tools, diffs, plans, permissions, cancellation, modes, model selection, embedded text, qualified image input, read-only workflows, and Design MCP transport. | This is not a direct native integration with the `claude` CLI. Exact model `sonnet` passed normal Task, text, PNG, and Design qualification. The provider profile passed its read-only mutation test with Sonnet selected. Default and Haiku remain image- and Design-unqualified. Opus was not tested. Other versions and media types remain unqualified. Claude plan mode denies tool execution during read-only turns. Task Monki also rejects permission requests and compares repository state. Claude advertises additional directories, so Design sessions receive the app-owned skill root. |

## Workflow support

| Workflow | Codex | OpenCode | Grok ACP | Cursor ACP | Claude ACP |
| --- | --- | --- | --- | --- | --- |
| Normal Task | Yes | Yes | Yes | Yes | Yes |
| Review | Yes | Yes | No | Yes | Yes; profile qualified with Sonnet |
| Prompt refinement | Yes | Yes | No | Yes | Yes; profile qualified with Sonnet |
| Discourse | Yes | Yes | No | Yes | Yes; profile qualified with Sonnet |
| Managed attachments | Text and image | Text and model-gated image | Text and exact-qualified PNG image | Text and Composer 2.5 PNG image | Text and Sonnet PNG image |
| Design | Codex 0.151.0-alpha.7.2 with GPT-5.6-Luna | No current qualified pair | No current qualified pair | Cursor 2026.08.25-3e8eec8 with Composer 2.5 | Claude Agent ACP 0.70.0 with Sonnet |

Review, prompt refinement, and Discourse use one shared read-only turn path.
Codex, OpenCode, Cursor, and Claude provide a qualified native mutation-denial policy.
Task Monki compares repository state before and after each applicable turn.
It fails a changed or unreadable turn and leaves detected changes as evidence.

The provider policy is not an operating-system sandbox.
OpenCode and ACP processes still run with normal user permissions.
Their model transport also needs network access.

The complete current and target matrices are in
`docs/architecture/AGENT_RUNTIME_ARCHITECTURE.md`.
That document separates protocol limits from adapter gaps and old Codex coupling.

This file records implemented protocol behavior.
It does not make a runtime unavailable only because it lacks a Codex sandbox.
Each workflow asks the adapter to qualify one concrete execution request.
An unsupported read-only profile remains available for normal Tasks.
Provider-neutral managed attachments are implemented in provider milestone 3.
Provider-neutral Design transport is implemented in provider milestone 4.

The Design row records technical product qualification.
A transport probe alone does not change this row.
The exact pair must prove the complete Design infrastructure before Task Monki enables it.
The proof includes instruction and skill access, image-result use, candidates, Ready, Stop, and cleanup.
Representative generated designs remain regression and quality evidence.
One generated defect or visual miss does not disable working infrastructure.
A repeatable failure to finish within a product time bound can keep a pair disabled.

## ACP compatibility boundary

All registered ACP profiles share these implemented rules:

- Task Monki negotiates stable ACP wire protocol version 1 at process startup.
- `session/new`, `session/prompt`, `session/update`, and `session/cancel` form
  the baseline. Resume, load, and close are used only when advertised.
- Task Monki retains stable modes and non-sensitive configuration selectors with
  their exact IDs. The user can change them from the provider overview only
  while the session is idle. Provider-specific methods need an explicit,
  versioned profile contract. This applies to Grok session models and Cursor's
  lazy parameterized model picker.
- Actionable native selectors cross the service boundary only as typed,
  semantic-neutral boolean/select controls. Each set includes the exact local
  and provider session ownership plus an optimistic revision. Stale revisions,
  unknown controls, wrong value types, and unadvertised choices fail closed.
  The renderer does not parse opaque native state to invent controls.
- ACP model catalogs are provider-session scoped unless an explicit profile
  contract supplies a pre-session runtime catalog. Stable ACP profiles expose
  only a profile default. Exact live-session choices remain in that session's
  control set. Grok's versioned initialize metadata/dynamic replacement and
  Cursor's explicitly selected, process-cached parameterized picker are the
  current exceptions. Every explicit model, mode, config, and reasoning choice
  is revalidated against the target session immediately before a prompt, and
  only values that differ from observed native state are mutated.
- The provider agent owns tool execution. Task Monki advertises its ACP
  filesystem and terminal client capabilities as disabled, while advertising
  the official boolean config-option client capability.
- Cursor read-only turns select its native Ask mode.
  Task Monki rejects every permission request during these turns.
- Claude read-only turns select its native plan mode.
  Task Monki rejects every permission request during these turns.
  Grok has no qualified read-only policy in this release.
- Permission choices return the exact opaque option ID advertised by the
  provider after Task Monki applies its command, path, and network policy.
- Only ACP `end_turn` is successful completion. `cancelled` is interrupted.
  `refusal`, `max_tokens`, and `max_turn_requests` are failed terminal turns.
- ACP text attachments use the profile-qualified mapping.
  Grok and Claude use embedded resources. Cursor uses bounded text blocks.
  ACP image delivery needs an exact runtime and model qualification.
  Negotiated support is the default transport fact. An exact profile row can
  override a false flag only after a real packaged test. The adapter reports
  that mismatch as capability drift. Grok Build 1.0.13 with Grok 4.6 is the
  only current exception. Active steering, true pause, native fork,
  provider goals, general user input, and standardized subagents remain unsupported.
- Stable ACP session setup accepts stdio MCP servers.
  A Design session receives one narrow app-owned `inspect_design` bridge.
  The adapter supplies the same descriptor on create, load, and resume.
  The adapter sends additional directories only when the agent advertises
  `sessionCapabilities.additionalDirectories`.
  Claude's qualified path requires the capability and receives the app-owned skill root.
  Task Monki disables Claude Design if a future handshake omits it.
  Cursor does not advertise this capability.
  Cursor still reads exact skill paths from the app-prepended catalog.
  Other session types receive no Design MCP server or Design directory.
  Cursor and Grok use their exact packaged MCP tool identities.
  Claude uses the exact public title, operation input, and Claude tool-name metadata.
  Task Monki accepts each representation only from its owning ACP profile.
  A sparse permission request must correlate with the exact prior tool item.
  Its display title is not authority by itself.
  A suffix match cannot receive automatic permission.
  Shutdown and quarantine revoke active Design grants before the ACP process stops.
- Task Monki's pinned v1.19.0 subset does not implement structured elicitation.
  Current ACP v1 documentation defines capability-gated `elicitation/create`,
  but Task Monki has not updated its schema, persistence, or renderer for it.
  Task Monki does not parse prose into requests. A prose question ends the
  current turn and can be answered by an explicit follow-up action.
- Task Monki does not expose ACP session list or delete as product operations.
  The [ACP delete contract](https://agentclientprotocol.com/protocol/v1/session-delete)
  can remove a session from view without deleting its files. Task Monki cannot
  use it as provider-history removal without a verified profile contract.
- Discovery proves only an executable identity and launch contract. `READY`
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
- OpenCode permission rules do not provide an OS sandbox. All its presets
  therefore report `DANGER_FULL_ACCESS`. Its provider,
  plugins, MCP servers, and tools run in a credential-bearing process with the
  permissions of the Task Monki user. The authenticated loopback transport
  protects server access; it does not confine that process. The approval-gated
  preset denies native task delegation because OpenCode child sessions do not
  inherit a separately attested mutation policy.
- OpenCode read-only work uses a dedicated `--pure` session.
  Its final native rule suffix denies mutation, delegation, external paths, and web tools.
  Task Monki re-reads that suffix before delivery.
  OpenCode 1.18.25 `--pure` disables external plugins only.
  It does not disable MCP, instructions, skills, or configuration.
  Task Monki registers the Design bridge through OpenCode's native MCP endpoint.
  It does not merge the bridge into user or managed configuration.
  Task Monki revokes the active Design grant before it waits for an uncertain shutdown.
- ACP agent processes own filesystem and network access, and permission events
  do not prove OS-level confinement. Claude exposes **Ask for approval** and
  **Full access**. Cursor and Grok additionally expose **Auto-accept edits**
  and **Full access**
  by selecting exact one-time provider options. Remembered options always
  require an explicit user choice. Cursor and Grok now document native sandbox
  options. Current Task Monki ACP profiles do not configure or attest those
  sandboxes. They also do not silently change provider or repository
  configuration.
- Cursor read-only work uses native Ask mode and rejects every permission request.
  Grok plan mode still permits other mutation paths.
  Claude read-only work uses native plan mode and rejects every permission request.
- Runtime children inherit only a minimal portable base environment. OpenCode
  and ACP children additionally receive a versioned, exact provider environment
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
- Normal provider use is a different trust boundary. The user selected an
  installed coding agent and its model. Task Monki does not require that agent
  to reproduce Codex's OS sandbox before it can receive an authorized prompt
  or selected attachment.
- Provider-native permission rules can qualify read-only workflows.
  These rules are native tool policies, not OS confinement.
  Task Monki records repository state before each applicable turn.
  It compares that state after the provider reaches terminal output.
  A changed or unreadable repository fails the turn.
  Task Monki preserves detected changes as evidence.
- A task and provider session remain owned by their original runtime. Task
  Monki does not migrate a session, silently fall back to another runtime, or
  automatically resend a prompt or interaction after ambiguous delivery.
- Runtime callbacks are generation-fenced. Late Codex App Server callbacks,
  OpenCode SSE events, or ACP notifications/requests from a replaced process
  cannot update a replacement run. OpenCode quarantines only the affected
  session process, and its existing per-session operation lane must settle
  before a replacement generation can mutate durable state. ACP quarantines
  the application-scoped profile process.

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
| Grok ACP | `task-monki/grok-acp-environment@v1` | xAI/Grok credentials and base URL; user config roots; proxy and CA configuration |
| Cursor Agent ACP | `task-monki/cursor-agent-acp-environment@v1` | Cursor API credential; user config roots; proxy and CA configuration |
| Claude Agent ACP | `task-monki/claude-agent-acp-environment@v1` | Anthropic/Claude, AWS Bedrock, and Google Vertex credentials and configuration; Claude config root; user config roots; proxy and CA configuration |

The authoritative key lists are
`src/core/agent/codex/CodexEnvironmentPolicy.ts`,
`src/core/agent/opencode/OpenCodeEnvironmentPolicy.ts`,
`src/core/agent/ProviderEnvironmentPolicy.ts`, and the provider profiles in
`src/core/agent/acp/AcpRuntimeProfiles.ts`. Runtime executable override keys are
resolver inputs and are not inherited by provider children.

Runtime identity, capability, recovery, and evidence invariants are defined in
`docs/architecture/AGENT_RUNTIME_ARCHITECTURE.md`. Codex-specific protocol and
permission behavior is defined in `docs/APP_SERVER_ARCHITECTURE.md`.

## Design qualification evidence

A working tool transport does not enable Design by itself.
Technical qualification controls product support for each exact runtime and model pair.
The pair must use the instructions, skills, native tools, image results, candidates, Ready, Stop, and cleanup correctly.
Representative design tasks also protect product quality as regression tests.
One generated defect or one visual miss is not an infrastructure failure.

| Exact provider pair | Verified evidence | Product status |
| --- | --- | --- |
| Codex 0.151.0-alpha.7.2 with GPT-5.6-Luna | Passed skills, browser actions, image-result use, motion, fresh correction, Ready, cancellation, and cleanup. One run misread `TM-7Q4` as `K7M4`; a repeat read it correctly. | Enabled. The first visual miss was model-output variation, not a bridge failure. |
| Cursor 2026.08.25-3e8eec8 with Composer 2.5 | Passed all nine regression scenarios. A later menu regression also passed when Task Monki omitted the unadvertised additional-directories field. It read eight app-owned skills and used MCP and browser tools. | Enabled. |
| Claude Agent ACP 0.70.0 with Sonnet | Passed form, menu and keyboard, responsive, motion, fresh correction, `TM-7Q4`, copy-only, no-change, cancellation, Ready preservation, and cleanup. | Enabled for exact model `sonnet`. Default and Haiku remain Design-unqualified. Opus was not tested. |
| OpenCode 1.18.25 with `opencode/mimo-v2.5-free` | HTTP, MCP, Preview, candidate, screenshot, and Ready transport worked. Two runs failed reliable skill and browser use. | Disabled for Design. Normal Task, attachments, and read-only workflows stay enabled. |
| Grok Build 1.0.13 with Grok 4.6 | Two runs read nine skills, consumed screenshots, opened fresh candidates, and corrected defects. Both stayed active for 900 seconds without a durable Ready result. Cleanup passed. | Disabled for Design because it did not finish within the product time bound. Other qualified workflows stay enabled. |
| Codex 0.150.0-alpha.12.2 with GPT-5.6-Luna | Native tools worked. A generated menu kept a pointer-blocking backdrop. | Unsupported for Design. This was generated source behavior, not a transport failure. |

Cursor has no supported session-close operation in this profile.
Its MCP child can remain until the shared Cursor process exits.
Task Monki revokes the active turn grant when the turn ends.

Grok closes the MCP child when its session closes.
Claude advertises session close and resume support.
Task Monki applies the same turn-grant rule to all profiles.
