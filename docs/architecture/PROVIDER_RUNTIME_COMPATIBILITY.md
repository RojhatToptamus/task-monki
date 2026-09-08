# Provider Runtime Compatibility

Date: 2026-08-31

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
| Codex App Server | `codex`; a resolver-selected native App Server stdio form | Native first-class | Native account and model discovery, threads, resume and fork, streamed turns, steering, interruption, approvals and typed user input, goals, plans, usage, managed attachment delivery, shared read-only workflows, and native Design tool transport | Design uses the live Codex model catalog. Models that report image input are enabled. Text-only models stay disabled. Review, prompt refinement, and Discourse use an attested read-only profile. Task Monki compares repository state after each read-only turn. Task Monki negotiates the experimental API family for generated `item/tool/requestUserInput` requests. It waits for `serverRequest/resolved` after each reply. True pause is unsupported. User input, terminal, and dynamic-tool protocol methods remain experimental. |
| OpenCode server | `opencode`; `opencode serve --hostname 127.0.0.1 --port <allocated-port>` | Native first-class | Connected provider and model registry, variants, sessions, native history fork, messages, parts, asynchronous prompts, abort, permissions, questions, plans, usage, recovery, bounded SSE, attachments, read-only workflows, and Design MCP transport | Discovery checks the real `opencode serve` launch contract and HTTP API. It does not reject a runtime by version number. Design uses each connected model's reported image and tool-call capabilities. Models missing either capability stay disabled. Price and free status are not capability signals. Review, refinement, and Discourse use a dedicated `--pure` session with native deny rules. The process remains unconfined and uses provider network access. Active steering, true pause, and provider goals remain unsupported. |
| Grok Build ACP | `grok-acp`; `grok --no-auto-update --permission-mode default agent stdio` | Registered ACP compatibility | ACP streaming, tool calls and diffs, plans, usage and cost context, permissions, cancellation, provider sessions, embedded text, image input, shared read-only workflows, Design MCP transport, and the captured `grok-build-acp/session-models@v1` contract | Design uses negotiated ACP image support and low reasoning by default. Grok Build currently reports `image: false` for its whole catalog, although native image delivery works. The provider profile records this capability mismatch without listing versions or models. On macOS, read-only workflows use a separate process with Grok's native read-only launch contract. Task Monki denies edit, write, and MCP tools, checks repository state, and rejects roots in Grok's writable temp and state locations. Active steering, fork, goals, and standardized subagents remain unsupported. Structured user input is available only when Grok emits an ACP form elicitation. |
| Cursor Agent ACP | `cursor-agent-acp`; automatic discovery uses `cursor-agent acp`, while `agent acp` needs explicit configuration and a Cursor contract probe | Registered ACP compatibility | ACP streaming, tool and diff updates, plans, exact permission choices, cancellation, Cursor rules, lazy model discovery, native session controls, text, negotiated image input, read-only workflows, and Design MCP transport | Cursor loads its current model catalog through its provider extension. ACP image support applies to the models in that catalog when Cursor advertises it. Task Monki does not use an executable-version allowlist. Cursor Ask mode provides the read-only policy. Task Monki rejects each permission request and compares repository state after the turn. Cursor does not advertise additional directories, so Task Monki omits that field. The process remains unconfined and uses provider network access. Active steering, fork, goals, and standardized subagents remain unsupported. Structured user input is available only when Cursor emits an ACP form elicitation. |
| Claude Agent ACP bridge | `claude-agent-acp`; the separate `claude-agent-acp` bridge executable | Registered ACP compatibility bridge | The bridge provides ACP streaming, tools, diffs, plans, permissions, form questions, cancellation, modes, model selection, embedded text, negotiated image input, shared read-only workflows, and Design MCP transport. | This is not a direct native integration with the `claude` CLI. Task Monki creates and closes one temporary ACP session when the user requests the model list. It uses that session's standard model selector, so current choices such as Haiku and Sonnet are not hardcoded. Models are enabled for Design when Claude advertises image input. Read-only prompts use plan mode, but a packaged probe showed that plan mode can still complete a Write tool call. Task Monki rejects a result if its final repository comparison finds a change. Preview generation uses only an app-owned disposable evidence copy. Claude advertises additional directories, so Design sessions receive the app-owned skill root. Its AskUserQuestion bridge uses ACP form elicitation and resumes the same provider turn after Task Monki returns the answer. |

## Workflow support

| Workflow | Codex | OpenCode | Grok ACP | Cursor ACP | Claude ACP |
| --- | --- | --- | --- | --- | --- |
| Normal Task | Yes | Yes | Yes | Yes | Yes |
| Review | Yes | Yes | Yes on macOS | Yes | Yes; plan mode plus repository comparison |
| Prompt refinement | Yes | Yes | Yes on macOS | Yes | Yes; plan mode plus repository comparison |
| Preview recipe generation | Yes | Yes | Yes on macOS | Yes | Yes; disposable-evidence path |
| Discourse | Yes | Yes | Yes on macOS | Yes | Yes; plan mode plus repository comparison |
| Managed attachments | Text and model-gated image | Text and model-gated image | Text and native image; capability drift reported | Text and negotiated image | Text and negotiated image |
| Design | Catalog models that report image input | Connected catalog models that report image input and tool calls | Models with effective image support; low reasoning by default | Catalog models when Cursor advertises image input | Session-catalog models when Claude advertises image input |

Review, prompt refinement, and Discourse use one shared read-only turn path.
Preview generation uses that path unless an adapter confines it to the
app-owned disposable evidence copy.
Every workflow prompt tells the agent not to modify files.
Each adapter applies its provider-native restriction when one is available.
Task Monki compares repository state before and after each applicable turn.
It fails a changed or unreadable turn and leaves detected changes as evidence.

Codex, OpenCode, and Cursor use provider policies, not operating-system
sandboxes. Grok uses a separate provider process with an operating-system
sandbox. Every model transport still needs provider network access.

The shared ownership and lifecycle rules are in
`docs/architecture/AGENT_RUNTIME_ARCHITECTURE.md`.

This file records implemented protocol behavior.
It does not make a runtime unavailable only because it lacks a Codex sandbox.
Each workflow asks the adapter to qualify one concrete execution request.
An unsupported read-only profile remains available for normal Tasks.
Managed attachments and Design transport use the shared provider runtime.

The Design row uses effective image capability from the live provider and model catalogs.
Packaged scenarios still verify instruction and skill access, image-result use,
candidates, Ready, Stop, and cleanup.
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
  contract supplies a pre-session runtime catalog. Grok uses its initialize
  metadata and dynamic replacement. Cursor uses its process-cached picker.
  Claude model discovery creates one temporary session, reads the standard ACP
  model selector, and closes that session before it publishes the choices.
  Every explicit model, mode, config, and reasoning choice
  is revalidated against the target session immediately before a prompt, and
  only values that differ from observed native state are mutated.
- The provider agent owns tool execution. Task Monki advertises its ACP
  filesystem and terminal client capabilities as disabled, while advertising
  the official boolean config-option client capability.
- Cursor read-only turns select its native Ask mode.
  Task Monki rejects every permission request during these turns.
- Claude plan mode allowed a native Write tool call during the packaged mutation
  probe. Read-only workflows still use plan mode, but Task Monki accepts their
  result only when the final repository comparison is unchanged. Preview
  generation uses only a disposable app-owned evidence copy.
- Grok read-only turns use a separate process because its sandbox is
  process-scoped. Normal Task and Design turns stay on the writable process.
- Permission choices return the exact opaque option ID advertised by the
  provider after Task Monki applies its command, path, and network policy.
- Only ACP `end_turn` is successful completion. `cancelled` is interrupted.
  `refusal`, `max_tokens`, and `max_turn_requests` are failed terminal turns.
- An ACP provider can reuse one message ID for thought and final-answer chunks.
  Task Monki includes the stream kind in its durable item identity so one
  channel cannot overwrite the other.
- ACP text attachments use the profile-qualified mapping.
  Grok and Claude use embedded resources. Cursor uses bounded text blocks.
  ACP image delivery follows the negotiated provider capability. Models from a
  live provider catalog inherit this agent-level ACP fact because ACP v1 has no
  per-model image field. A narrow provider profile can record a false flag
  only after native delivery is verified. The adapter reports that mismatch
  as capability drift. It does not list provider versions or model names.
  Active steering,
  true pause, native fork,
  provider goals, general user input, and standardized subagents remain unsupported.
- Stable ACP session setup accepts stdio MCP servers.
  A Design session receives one narrow app-owned `inspect_design` bridge.
  The adapter supplies the same descriptor on create, load, and resume.
  The adapter sends additional directories only when the agent advertises
  `sessionCapabilities.additionalDirectories`.
  Claude's supported path requires the capability and receives the app-owned skill root.
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
- Task Monki advertises the form mode of the
  [ACP elicitation contract](https://agentclientprotocol.com/protocol/v1/elicitation).
  It does not advertise URL elicitation.
  The shared AskUserQuestion form maps to the existing `USER_INPUT` lifecycle.
  Other form schemas use the existing `MCP_ELICITATION` lifecycle.
  The answer returns to the same blocking ACP request and provider turn.
  Process loss makes the request stale because Task Monki cannot replay an
  uncertain answer to a new provider process.
  Task Monki does not parse prose into requests.
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
  require an explicit user choice. The normal Cursor and Grok processes do not
  use a Task Monki sandbox. Grok's separate read-only process uses its native
  sandbox. Task Monki does not rewrite provider or repository
  configuration.
- Cursor read-only work uses native Ask mode and rejects every permission request.
  Grok read-only work uses a separate process with its process-start sandbox.
  It denies edit, write, MCP, and Task Monki permission requests. Task Monki
  still compares repository state after the turn.
- Claude Agent ACP plan mode allowed a native Write tool call. Its read-only
  workflows use a clear no-modification instruction and reject the result when
  the final repository comparison changes. Preview generation uses only a
  disposable app-owned evidence copy.
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

Before a task owns a worktree, packaged provider processes use the private
`provider-runtime` directory in the Task Monki profile. They do not use the
user home as a working directory. Task and Design sessions still use their
assigned worktrees.

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

A working tool transport does not prove Design quality by itself.
Current availability uses the connected provider and model image capabilities.
These packaged scenarios protect instructions, skills, native tools, image
results, candidates, Ready, Stop, and cleanup.
Representative design tasks also protect product quality as regression tests.
One generated defect or one visual miss is not an infrastructure failure.

| Tested provider pair | Verified evidence | Current use of the evidence |
| --- | --- | --- |
| Codex 0.151.0-alpha.7.2 with GPT-5.6-Sol | Passed the packaged interactive-form scenario at low reasoning. It read nine app-owned skills, used image-result and browser operations, produced the exact Ready candidate, and removed its temporary root. | Regression evidence for the shared Codex Design path. Live catalog image support decides current model availability. |
| OpenCode 1.18.25 with `openai/gpt-5.6-luna` | Passed an earlier focused menu run and all nine packaged scenarios at medium reasoning: skills, form behavior, menu and keyboard behavior, responsive layouts, motion and reduced motion, fresh correction, `TM-7Q4`, copy-only, no-change, cancellation, Ready preservation, and cleanup. | Regression evidence for the shared OpenCode Design path. Connected catalog models are enabled when they report image input and tool calls. |
| Cursor 2026.08.25-3e8eec8 with Composer 2.5 | Passed all nine regression scenarios. The current packaged interactive-form run also passed model discovery, skills, image-result and browser use, exact Ready candidate handling, and cleanup. | Regression evidence for the shared Cursor ACP Design path. |
| Claude Agent ACP 0.70.0 with Sonnet | Passed form, menu and keyboard, responsive, motion, fresh correction, `TM-7Q4`, copy-only, no-change, cancellation, Ready preservation, and cleanup. The current interactive-form rerun passed with low effort. | Regression evidence for the shared Claude ACP Design path. The live session catalog and negotiated image capability decide availability. Haiku removes the effort selector, so Task Monki does not claim a low setting for Haiku. |
| OpenCode 1.18.25 with `opencode/mimo-v2.5-free` | HTTP, MCP, Preview, candidate, screenshot, and Ready transport worked. Two runs did not use the required skills and browser flow reliably. | This remains model-quality evidence. The current live catalog capability decides availability. |
| Grok Build 1.0.13 with Grok 4.6 | At low reasoning, form states, the focused menu, wide and narrow layouts, and the 511-second motion chain passed. The current interactive-form run also passed skills, image-result and browser use, exact Ready candidate handling, and cleanup. A later normal Task qualification passed native text and image delivery while the provider still advertised `image: false`. Earlier high-reasoning runs did not settle within 900 seconds. | Regression evidence for the Grok ACP Design path and its low Design default. The provider-local image rule records Grok Build's false ACP flag without pinning this version or model. |

Grok Build 1.0.13 exposes no per-model image field. Two Grok 4.5 low-reasoning
qualification runs received the correct native PNG bytes but reported the
image incorrectly. xAI documents Grok 4.5 as an image-input model, so this is
recorded as current provider/model quality evidence. Task Monki does not add a
hardcoded model exception that would become stale when the catalog changes.

Cursor has no supported session-close operation in this profile.
Its MCP child can remain until the shared Cursor process exits.
Task Monki revokes the active turn grant when the turn ends.

Grok closes the MCP child when its session closes.
Claude advertises session close and resume support.
Task Monki applies the same turn-grant rule to all profiles.
