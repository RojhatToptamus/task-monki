# Agent Runtime Architecture

Date: 2026-08-31

Status: Current architecture.

This document defines the shared agent runtime in Task Monki.
It records current ownership and runtime rules.

For exact provider versions and qualified workflows, read
`docs/architecture/PROVIDER_RUNTIME_COMPATIBILITY.md`.

## Purpose

Task Monki has one product workflow for each user action.
It does not copy a workflow for each provider.

Provider adapters translate the shared request into each native protocol.
They also report the provider features that Task Monki can use safely.

The architecture has three main owners:

- `TaskManagerService` owns product entry points and application shutdown.
- `AgentOrchestrator` owns the shared runtime lifecycle.
- Each provider adapter owns its protocol and local provider resources.

`FileAgentRuntimeStore` is the durable runtime store.
Domain stores remain authoritative for product state.

## Core rules

1. Use `AgentRuntimeRegistry` as the only provider registry.
2. Use one adapter for each native protocol family.
3. Register one ACP adapter instance for each ACP agent product.
4. Use `AgentOrchestrator` for shared session and turn behavior.
5. Store all provider sessions and runs in `FileAgentRuntimeStore`.
6. Keep Task, Design, and Discourse state in their domain owners.
7. Keep attachment bytes in `AttachmentFileStore`.
8. Keep provider protocol mapping inside provider adapters.
9. Select workflows by effective capabilities, not provider names.
10. Never select another provider or model as a silent fallback.
11. Preserve uncertain delivery and never resend it automatically.
12. Treat provider output as telemetry, not verified local evidence.

## Ownership

| Value or lifecycle | Authoritative owner |
| --- | --- |
| Runtime registration | `AgentRuntimeRegistry` |
| Runtime and model selection | App settings or the owning Task or Design |
| Provider qualification | The selected adapter and its model projection |
| Shared session and turn lifecycle | `AgentOrchestrator` |
| Runtime sessions, runs, items, and interactions | `FileAgentRuntimeStore` |
| Provider process, stream, and protocol state | The selected adapter |
| Task workflow and Git evidence | `FileTaskStore` and Task services |
| Design conversation and Ready state | Design services and `FileTaskStore` |
| Discourse conversation and wave state | Discourse services and `FileDiscourseStore` |
| Attachment bytes and managed paths | `AttachmentFileStore` |
| Per-turn attachment selection | The runtime run record |
| Preview processes and routes | `PreviewManager` and Preview runtime owners |
| Design source and candidate identity | `DesignSourceService` and `DesignUpdateCoordinator` |
| Design browser process and screenshots | `AgentBrowserRuntime` |

Do not store the same mutable value in two owners.
Renderer state is a projection of these owners.

## Runtime identity

Keep these identities separate:

1. Runtime ID identifies the installed agent and protocol adapter.
2. Model-provider ID identifies the upstream model provider.
3. Model ID identifies one model in that provider catalog.

For example, an OpenCode runtime can expose models from several model providers.
The runtime ID is still `opencode`.

A Task keeps its runtime for the life of its provider session.
A continuation does not replace that runtime.
A detached review can use another explicit runtime and session.

## Application composition

`src/core/app/AgentRuntimeComposition.ts` creates the built-in adapters.
`TaskManagerService` registers them in `AgentRuntimeRegistry`.
It then creates one `AgentOrchestrator` and one `FileAgentRuntimeStore`.

The registry owns initialization, shutdown, lookup, catalogs, and readiness.
It does not own workflow prompts or domain state.

## Shared turn boundary

The shared turn path has these stages:

1. The workflow selects an exact runtime, model, and settings.
2. The workflow builds its prompt and selected inputs.
3. `AgentOrchestrator` asks the adapter for an execution context.
4. The orchestrator stores the session, run, and queue entry.
5. The adapter creates or resumes its provider session.
6. The adapter sends the prompt with native attachment content.
7. The adapter maps native events into typed runtime observations.
8. The orchestrator settles delivery and terminal state.
9. The workflow projects the result into its domain state.
10. The orchestrator releases transient provider resources.

The durable run exists before provider delivery starts.
This order is required for idempotency and recovery.

Each provider adapter can implement these shared operations:

- build an execution context.
- create or attach a session.
- start a prepared turn.
- interrupt a turn.
- emit normalized turn events.
- reconcile lost or uncertain work.
- release a session.
- stop its owned processes.

An adapter can also expose native optional operations.
Examples include steering, fork, session controls, goals, and subagents.
The shared boundary does not pretend that every provider supports them.

## Workflow paths

### Normal Tasks

`TaskManagerService` owns Task actions and Task policy.
`AgentOrchestrator` owns the runtime session and turn.
The Task store owns worktree, Git, test, review, and delivery evidence.

Provider telemetry cannot mark local work as correct.
Task Monki must inspect local evidence before workflow state changes.

### Read-only workflows

Review, prompt refinement, and Discourse use the same read-only turn path.
Each workflow still owns its prompt, parsing, budget, queue, and result state.

The selected adapter must provide a qualified native mutation-denial policy.
Task Monki also compares repository state before and after each applicable turn.

If the repository changes, the turn fails.
Task Monki preserves the change as evidence.
It does not erase the provider change.

A provider policy is not an operating-system sandbox.
The UI must describe its real boundary.

### Preview recipe generation

Preview recipe generation uses the runtime and model selected in Settings.
It does not use an app-owned fallback model.

The normal path uses the shared transient read-only turn.
An adapter can qualify an exact runtime and model for a disposable evidence copy.
That copy must not expose the source repository path.

The Preview generation service owns the prompt, parsing, schema validation,
cancellation, and user-visible error.
The adapter owns protocol delivery.

### Design

`DesignUpdateCoordinator` owns the Design run and Ready lifecycle.
It uses `AgentOrchestrator` for provider sessions and turns.

The Design workflow supplies permanent instructions, app-owned skills,
selected references, the managed worktree, and one `inspect_design` grant.

Task Monki owns source capture, candidate identity, Preview, and Ready cutover.
The visible last Ready result stays safe during later work.
A final source change cannot become Ready without browser verification.

## Capability projection

`AgentRuntimeCapabilities` reports common runtime facts.
`AgentModel` reports model-specific input and workflow support.
`projectAgentExecutionSupport` produces the user-facing workflow result.

The projection uses these facts:

- runtime readiness.
- selected model availability.
- model input types.
- native execution policy.
- attachment transport.
- interruption support.
- required app-owned tool transport.
- exact qualification rules in the adapter.

The projection returns either support or a clear reason.
Normal Tasks remain available when only a read-only workflow is unsupported.

Do not add a capability field without a production consumer.
Do not duplicate optional adapter methods as descriptive flags.

## Runtime persistence

`FileAgentRuntimeStore` stores the provider-neutral runtime record.
It stores:

- provider server instances.
- sessions and access epochs.
- runs and delivery state.
- scheduler entries.
- items and interactions.
- goals, plans, usage, settings, and subagent observations.
- bounded artifacts and telemetry references.
- owner-scoped events.

The runtime record does not own Task or Design domain state.
Task projections can derive their provider view from the runtime store.

### Session record

A session record includes its exact owner, immutable runtime ID,
provider identity, execution context, settings, generation, and access epoch.
It also includes lifecycle and recovery state.

Task-only projection details stay in the optional Task context.

### Run record

A run record includes its exact scope, purpose, generation key,
delivery phase, provider turn identity, and terminal state.
It also contains the ordered attachment selection and path-free delivery evidence.

Read-only runs keep repository integrity evidence.
Design runs keep exact app-owned tool grants.
Task runs can keep bounded Task projection details.

The run record does not store attachment paths or bytes.

### Bounds

The runtime store applies fixed limits to sessions, runs, queue entries,
typed records, artifacts, telemetry, server instances, and events.
Protocol journals have their own byte and record limits.

Adapters also bound in-memory streaming buffers and provider payloads.
They release buffers after completion, loss, cancellation, or shutdown.

## Delivery and recovery

Delivery has explicit states:

- `NOT_SENT`.
- `SENDING`.
- `ACKNOWLEDGED`.
- `AMBIGUOUS`.
- `NOT_DELIVERED`.
- `TERMINAL`.

An acknowledged prompt can continue through normal reconciliation.
An ambiguous prompt must not be sent again automatically.
The user must choose how to recover uncertain work.

Every provider event must match the current server generation and run identity.
Late events from a replaced process cannot update current state.

Process loss stops new delivery through the lost generation.
It marks active work for recovery and stales pending interactions.
It also discards volatile buffers owned by that generation.
Durable protocol references and local evidence remain.

Cancellation stops admission first.
It then asks the adapter to interrupt native work.
An uncertain cancellation uses reconciliation, not resend.

## Attachment contract

`AttachmentFileStore` is the only owner of attachment bytes.
It owns staging, adoption, immutable storage, integrity checks, and cleanup.

Each runtime run stores the exact ordered attachment selection before delivery.
The selection includes IDs, media types, sizes, and hashes.
It contains no local path.

The adapter receives verified `AgentTurnAttachment` values.
It maps them to its native protocol.
Supported transports include native image, native file, embedded resource,
bounded text block, and qualified managed-path delivery.

There is no generic path fallback.
A provider receives only the files selected for that turn.
Old Design references do not enter a later turn automatically.

Submission evidence records the native transport and provider correlation.
It does not copy the attachment bytes.

Draft and staged files have bounded cleanup.
Adopted bytes remain while a domain record references them.
Deletion removes unreferenced bytes through the attachment store owner.

Task Monki cannot revoke bytes after a provider receives them.
The product must not claim remote deletion or provider forgetting.

## App-owned Design tool

Task Monki has one app-owned Design tool: `inspect_design`.
`DesignClientToolContract` owns its name, input schema, and bounded result.
`DesignClientToolBridge` owns run grants and dispatch.

Provider transport stays local to the adapter:

- Codex uses its native dynamic-tool protocol.
- OpenCode uses one packaged local stdio MCP bridge.
- ACP Design sessions use that bridge through ACP setup.

The bridge contains no browser or Preview implementation.
It forwards an authorized request to the existing Design browser owner.

Each tool call must match the active run, provider session,
provider tool identity, and short-lived grant.

Tool text and image results are bounded.
Screenshot files are temporary.
They never become attachments, assets, revisions, or Preview records.
Cleanup removes scratch files, sockets, profiles, and browser processes.

## Provider-local behavior

Provider adapters keep these differences local:

- launch contract and environment.
- authentication and model discovery.
- native session create, resume, load, fork, and close.
- prompt and attachment encoding.
- permission and read-only policy mapping.
- stream framing, ordering, redaction, and buffering.
- cancellation and provider-loss recovery.
- native interaction replies.
- native session controls and telemetry.
- `inspect_design` transport.

Do not share stream buffering only because two adapters use similar limits.
Share it only when ordering, redaction, failure, and cleanup are identical.

Exact provider behavior belongs in
`docs/architecture/PROVIDER_RUNTIME_COMPATIBILITY.md`.

## Security boundary

Keep these controls:

- Electron context isolation, renderer sandboxing, and typed IPC.
- path rejection for renderer and provider input.
- attachment admission, hashes, ownership, and no-follow checks.
- credential redaction before durable protocol storage.
- minimal provider child environments.
- server-generation fences and late-event rejection.
- no-resend recovery for uncertain delivery.
- worktree ownership and local Git verification.
- isolated Preview origins and navigation restrictions.
- exact Design candidate identity.
- short-lived app-owned tool grants.
- bounded processes, listeners, files, journals, and buffers.

Do not require each provider to copy the Codex sandbox.
Do not confuse provider-native permission rules with OS confinement.
Do not add a generic attachment directory grant.
Do not use provider history deletion as a workflow requirement.

The user selects a local coding agent and a model.
That agent can receive the prompt and selected files.
Task Monki protects local ownership and delivery boundaries.
It does not control provider retention after delivery.

## Shutdown and cleanup

Application shutdown follows this order:

1. Stop new runtime and workflow admission.
2. Drain admitted Task, control, and runtime operations.
3. Stop Discourse and Design coordinators.
4. Stop the shared agent orchestrator.
5. Revoke Design tool grants and stop the bridge.
6. Drain post-run evidence work.
7. Stop Preview processes.
8. Remove the provider event listener.
9. Close Discourse, runtime, and Task stores.

Cleanup is best effort.
One failure must not prevent later owners from closing.
Shutdown reports the first cleanup failure after all owners run.

Adapters stop their supervisors, streams, MCP children, timers,
subscriptions, and session resources.
Design cleanup also stops browser and Preview resources.

## Adding a provider

A new provider needs:

1. One adapter or one explicit ACP profile.
2. A stable runtime ID and launch contract.
3. Readiness and model discovery.
4. Native session and turn mapping.
5. Permission and cancellation mapping.
6. Recovery and generation fencing.
7. Bounded protocol and stream handling.
8. Capability projection with clear unsupported reasons.
9. Packaging and owned-process verification.

Add only the workflows that pass real qualification.
Do not add a workflow-specific adapter.
Do not add a compatibility registry for untested providers.

## Required verification

Changes to the shared runtime need focused tests for the changed owner.
They also need the relevant broader workflow tests.

Keep strong coverage for exact selection, no silent fallback,
native attachments, cancellation, uncertain delivery, and late events.
Also cover process loss, restart, read-only comparison, cleanup, and bounds.

Design tests must protect tool grants, screenshot cleanup,
candidate identity, browser verification, and Ready safety.
Preview tests must protect YAML parsing and schema validation.
Process tests must protect known Windows path and shutdown behavior.

Use real packaged-provider checks for enabled combinations.
Mock tests alone cannot qualify a provider or model.

The standard repository checks are:

```sh
npm run typecheck
npm run check:architecture
npm run test:agent-workflow
npm test
npm run test:renderer:dom
npm run build
npm run check:codex-protocol
npm run dist:dir
npm run verify:packaged-runtime
npm run verify:packaged-owned-process
npm run smoke:providers
git diff --check
```

Run provider scenarios with the exact packaged runtime and model.
Record unsupported combinations and the exact reason.

## Related documents

- `docs/architecture/PROVIDER_RUNTIME_COMPATIBILITY.md`
- `docs/architecture/CRASH_RECOVERY.md`
- `docs/APP_SERVER_ARCHITECTURE.md`
- `docs/architecture/CODEX_PROTOCOL_AND_COUPLING_NOTES.md`
- `docs/workflows/AGENT_REVIEW_WORKFLOW_LIFECYCLE.md`
- `docs/PROVIDER_SMOKE_TESTING.md`
