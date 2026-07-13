# Task Monki local preview implementation plan

Status: Phases 0-3 and the bounded Phase 4 private-input/attachment path are implemented; managed credentials retain the hardened volatile Phase 3 lifecycle
Date: 2026-07-13
Supporting rationale: [`../private/task-preview-local-execution-architecture.md`](../private/task-preview-local-execution-architecture.md)

## Authority of this plan

This document is the normative source for preview phase sequencing, implementation requirements, lifecycle decisions, and acceptance criteria. The supporting architecture document explains the technical rationale but must not define a conflicting lifecycle or duplicate this plan's acceptance contract.

Task Monki owns preview authority and evidence. Provider output, application logs, Docker output, and process telemetry are observations until Task Monki verifies them through its own records and probes.

## 1. Current branch baseline

- `TASK_STORE_SCHEMA_VERSION` is 14, with a selective additive 13 → 14 migration.
- Phase 1 implements restricted recipe parsing, task-scoped approval, coherent source capture outside the worktree, native launcher ownership, bounded logs, readiness, stable loopback gateway routes, stop, shutdown, and conservative reconciliation.
- Phase 2 implements multiple services/routes, workers, DAG scheduling, HTTP/TCP/argv probes, liveness, bounded restart, typed origins, candidate/active/retired generations, ready-before-cutover route replacement, and the exclusive-node overlap contract in section 4.
- Phase 3 implements stable preview-owned PostgreSQL and Redis resources, one environment-owned network, non-owning generation attachments, volatile credentials, authenticated readiness, setup/retry/reset, post-ready health handling, exact OCI cleanup, and restart cleanup without adoption.
- Phase 4 adds capability-only private input declarations, main-only macOS `safeStorage` revisions and exact generation retention, single-key `.env` import, task-local public attachment bindings, recipient-scoped delivery, and optional one-shot HTTP/TCP/PostgreSQL/Redis readiness checks. Attached targets remain strictly non-owned and have no post-ready supervisor.
- Managed PostgreSQL and Redis credentials remain in the volatile Phase 3 credential host. Protected runtime files bootstrap the pinned images, Redis reads a mounted configuration without secret argv, and PostgreSQL readiness authenticates through its published loopback TCP port. The failed stdin experiment is not a production transport.

The ownership model in sections 2-6 is the architecture to preserve. Phase 4 may replace volatile credential storage, but it must not make managed data generation-owned or give attached dependencies cleanup authority.

The current unit/integration suite covers the domain and fake-engine contracts. The real-engine acceptance matrix in sections 8 and 10 remains a release gate: it must still prove true main-process death/restart, manager-level A1 → A2 reuse, exact crash-boundary cleanup, and two named macOS engine contexts. Historical Phase 0/1 prototypes remain evidence only and are not production dependencies.

## 2. Product invariants that remain

Application generations remain first-class Task Monki records. A1 → A2 ready-before-cutover replacement is required.

Each generation still has:

- an exact captured source manifest and Git evidence;
- an approved execution plan;
- generation-owned native processes, attempts, logs, ports, and routes;
- candidate/active/retired routing state;
- freshness, readiness, failure, and cleanup evidence.

The rejected concept is generation-owned managed data, not application generations.

The target model is:

```text
Task preview A
  ├── preview-managed environment and network A
  ├── stable PostgreSQL A
  ├── stable Redis A
  ├── application generation A1 attaches as a consumer
  └── application generation A2 attaches as a consumer
```

During ordinary A1 → A2 application replacement:

- PostgreSQL and Redis container IDs remain unchanged;
- volume IDs remain unchanged;
- generated credentials remain unchanged;
- published ports and connection URLs remain unchanged;
- application services may overlap only under section 4;
- managed setup, migration, and seed jobs do not run;
- A2 reaches complete readiness, routes cut over, and A1 retires.

Application generations reference preview-owned managed resources. They never own, adopt, transfer, reparent, or determine the lifetime of those resources.

## 3. Normalized authority and record boundaries

### 3.1 Preview-managed environment

One preview-managed environment/runtime record owns shared OCI authority for one task preview:

- task and stable preview ID;
- selected Docker context, endpoint digest, and engine identity;
- exact preview-network ID;
- Task Monki reserved ownership labels for that network;
- lifecycle, reconciliation, and cleanup state.

The environment record is the only owner of network cleanup authority. Managed-resource records reference it; they do not duplicate or independently own the network.

### 3.2 Preview-managed resource

One managed-resource record exists per selected logical PostgreSQL or Redis resource. It owns:

- task/preview ID, environment ID, and logical resource ID;
- exact container, volume, and resolved image IDs;
- stable loopback port and non-secret binding metadata;
- non-secret binding identity and digest;
- safe username/database metadata where applicable;
- authenticated readiness, health, setup, failure, and cleanup state;
- Task Monki reserved ownership-label expectations;
- exact container/volume cleanup authority.

It does not own the shared preview network. It contains no plaintext credential.

Required managed-resource states may be represented with the smallest state model that preserves these distinctions:

```text
INTENDED → STARTING → SETTING_UP → READY
                          ├── SETUP_FAILED
                          └── RECOVERY_REQUIRED
READY → FAILED or RECOVERY_REQUIRED
any owned state → STOPPING → STOPPED or CLEANUP_INCOMPLETE
```

An implementation may use existing shared state names where their meaning is exact. It must not collapse setup failure, ambiguous setup completion, runtime health failure, and cleanup uncertainty into one generic failure.

### 3.3 Generation attachment

A generation attachment records that an application generation consumes a managed resource:

- generation ID and managed-resource ID;
- logical reference/binding identity used by that generation;
- attachment timestamps or status only when useful for evidence.

It contains no object ownership, credentials, adoption state, or cleanup authority. Generation-history pruning may remove attachments but cannot remove the preview environment or managed-resource authority.

### 3.4 Volatile credential host

Generated managed-resource credential authority and long-lived plaintext storage exist only in the Electron/main-process preview runtime:

- a small runtime-owned credential host/registry holds plaintext values keyed by managed-resource ID;
- the managed-resource record stores only non-secret binding identity/digest and safe username/database metadata;
- application generation orchestration requests a typed connection binding and injects it directly only into declared recipients, with a recipient-scoped launcher contract and redaction set;
- credentials remain stable across A1 → A2 while the main process remains alive;
- renderer reload does not affect the credential host;
- full main-process restart does not attempt resource adoption because plaintext credentials are no longer available;
- restart reconciliation verifies and cleans exact surviving OCI resources;
- durable managed-resource credential recovery is deferred until a product requirement justifies cross-main-process reuse or adoption.

Plaintext credentials must never enter `FileTaskStore`, `TaskSnapshot`, plans, approvals, events, artifacts, logs, errors, argv, renderer state, unrelated node contracts, or host helper-process environments. Approved native preview commands run under the user's OS identity; recipient scope governs what Task Monki delivers and is not an OS sandbox between mutually hostile same-UID processes. The implementation should use the smallest testable runtime component that satisfies this contract; no generic secret framework is required in Phase 3.

## 4. Phase 2 application-generation overlap contract

Replacement has four explicit boundaries:

1. candidate routed-service readiness;
2. exclusive-node handoff;
3. atomic route cutover;
4. old-generation retirement.

Rules:

- Routed stateless services may overlap while the candidate reaches readiness.
- Workers, schedulers, queue consumers, and other side-effecting long-running nodes are exclusive by default.
- `overlap: safe` is the only declaration that permits the old and candidate form of an exclusive node to run concurrently.
- `overlap: safe` is part of the canonical execution digest and requires approval.
- Finite jobs, migrations, and seeds never overlap automatically.
- Every exclusive node participating in replacement declares a bounded readiness policy.
- Exclusive handoff stops the old node before starting the candidate equivalent; a brief processing gap is acceptable.
- If candidate exclusive activation fails, restoration of the old node uses the old node's declared readiness deadline.
- The old generation remains eligible for routing only if its complete required graph is restored and reverified by that deadline.
- Failure to restore the complete old graph fails and detaches the old generation.
- Task Monki never leaves old and candidate exclusive nodes running simultaneously unless `overlap: safe` was approved.

Phase 2 correction acceptance:

- routed stateless services overlap only during candidate readiness/cutover;
- exclusive workers do not overlap by default;
- adding or removing `overlap: safe` invalidates approval;
- a candidate exclusive-node failure restores and reverifies the old complete graph within the declared deadline or fails/detaches it;
- no failure path leaves two unapproved exclusive owners running;
- existing ready-before-cutover generation, source, route, and native ownership evidence remains intact.

## 5. Phase 3 scope

### 5.1 Implemented slice

Phase 3 is native application generations plus preview-owned managed data:

1. PostgreSQL vertical slice;
2. authenticated PostgreSQL reuse across A1 → A2;
3. Redis through the proven managed-resource contract;
4. post-ready resource supervision;
5. overlap-safe application replacement against stable managed bindings;
6. reset and setup scenarios;
7. crash, pruning, labels, limits, and alternative-context hardening.

Generic OCI remains out of scope until the typed adapters prove a genuinely shared stable lifecycle.

The replacement recipe exposes no managed-data lifetime selector: typed managed resources are preview-owned by definition.

Not Phase 3:

- private inputs and attached dependencies: Phase 4;
- Compose passthrough: Phase 5;
- companion/multi-repository source composition: Phase 6;
- AI-assisted recipe discovery: Phase 7.

### 5.2 Explicitly rejected concepts

The implementation must not reintroduce:

- generation-owned OCI managed-resource records;
- `scope: generation` and equivalent generation-lifetime recipe behavior for managed data;
- starting a second database/cache container over an existing volume;
- volume adoption, transfer, reparenting, or generation handoff;
- `retainedForReset`;
- `adoptedGenerationVolumes`;
- credentials generated per application generation;
- reset handoff state;
- automatic migration/seed execution during normal application replacement;
- restart adoption of managed resources without credentials;
- cleanup branches and tests that exist only to preserve those concepts.

No compatibility reader, feature flag, or parallel old/new lifecycle is required for these unreleased rejected designs.

### 5.3 Managed-resource creation and setup

Initial Preview start:

1. Resolve the current recipe/scenario and engine capabilities without mutation.
2. Require a matching current execution digest and approval.
3. Persist preview-environment and resource intent before engine mutations.
4. Create one preview network and one resource container/volume per logical resource.
5. Generate credentials once in the runtime credential host.
6. Publish dynamic ports on `127.0.0.1` and persist non-secret binding metadata.
7. Require real authenticated PostgreSQL/Redis readiness.
8. Run the approved initial setup scenario in declared dependency order.
9. Mark a resource reusable/ready only after authenticated readiness and all required setup succeeds.
10. Start the complete application generation with typed bindings.
11. Attach routes only after the complete required graph is ready.

Setup rules:

- Migration is a finite job that waits for authenticated database readiness.
- Seed waits for migration success.
- Observed setup failure leaves the resource `SETUP_FAILED` and blocks application start.
- Ambiguous non-retry-safe migration/seed completion becomes `RECOVERY_REQUIRED`.
- Ordinary Preview start must not treat `SETUP_FAILED` or `RECOVERY_REQUIRED` resources as healthy/reusable.
- Recovery requires an explicit approved Reset or an explicit **Retry Setup** action.
- Retry Setup revalidates the current recipe, scenario, execution digest, approval, exact resource authority, and prior attempt evidence before execution.
- Retry Setup is available only when every job it may repeat is declared `retrySafe: true`; ambiguous non-retry-safe setup requires Reset to a new resource identity.
- No setup job is automatically retried merely because Task Monki or a launcher lost contact.

### 5.4 Ordinary A1 → A2 replacement

Normal application replacement:

- verifies the existing preview environment and required resources;
- reuses their exact containers, volumes, credentials, ports, and URLs;
- creates generation attachments without changing managed ownership;
- runs ordinary application preparation jobs only;
- runs no migration or seed;
- follows the overlap policy in section 4;
- cuts routes over only after the complete candidate graph is ready;
- retires A1 without stopping or recreating managed resources.

Any future “apply migration during replacement” operation is outside this phase. If later added, it must be explicit, separately approved, and warn that it can change data still used by A1.

### 5.5 Post-ready managed-resource failure

When a required PostgreSQL/Redis resource dies, becomes unhealthy, or loses verified ownership:

1. Invalidate readiness for every consuming generation.
2. Transition the complete active application generation to `FAILED`.
3. Detach all routes for that generation.
4. Stop its native application services and workers through existing verified cleanup.
5. Mark the managed resource `FAILED` or `RECOVERY_REQUIRED` with bounded evidence.
6. Do not automatically delete its persistent volume or unrelated managed resources.
7. Permit destructive managed-data cleanup only through explicit Reset or explicit Stop Preview.
8. Graceful Task Monki shutdown and restart reconciliation may clean exact resources because cross-restart persistence is not promised.

A transient runtime failure must not silently destroy data. Dependency-specific partial route survival is out of scope.

### 5.6 Stop Preview is destructive

The initial lifecycle does not preserve managed data after the user stops the preview.

The user-visible action must say that data will be deleted, for example **Stop Preview & Delete Data**, and require concise destructive confirmation.

The operation:

1. detaches every active route;
2. stops the complete application generation;
3. removes exact preview-owned resource containers and volumes;
4. removes the exact preview-owned network through the environment authority;
5. deletes preview data;
6. marks records `STOPPED` only after verified absence;
7. leaves uncertainty as `CLEANUP_INCOMPLETE`.

Task deletion and graceful Task Monki shutdown use the same exact ownership cleanup. Names and prefixes are never deletion authority.

### 5.7 Reset is destructive and stops the complete application

Reset is one serialized transaction:

1. Resolve the current recipe and selected scenario.
2. Validate the current execution digest and approval.
3. Verify the active application and exact preview-environment/resource authority.
4. Detach all active routes.
5. Stop the complete active application generation, including routed services and exclusive workers.
6. Refuse to continue if any application cleanup is incomplete.
7. Preserve unrelated managed resources.
8. Delete only the exact selected resource container and volume; abort on cleanup uncertainty.
9. Create a new resource identity, credentials, port, and binding.
10. Require authenticated readiness and run approved initial/reset setup jobs.
11. Start a new complete application generation.
12. Attach routes only after the complete graph is ready.

The approval surface must state that reset deletes the selected data and cannot restore it if recreation or setup fails. Reset does not perform partial application shutdown or partial route survival.

Repeated and alternating resets use ordinary preview-owned resource replacement. They use no adoption, handoff, retained flag, or generation reassignment.

### 5.8 Ownership, labels, limits, and pruning

Ownership and cleanup require:

- the selected context, endpoint digest, and engine identity;
- exact object IDs;
- the complete expected Task Monki reserved-label subset.

Extra image-defined or inherited labels are allowed. Verification hashes or compares only Task Monki's reserved subset for ownership purposes. Names remain diagnostic only.

Resource limits are resolved before approval:

- if a recipe requests CPU, memory, or PID enforcement that the selected engine cannot enforce, reject the plan before approval;
- never silently omit or downgrade a requested limit;
- if no limit was requested, missing capability is informational and does not block the plan;
- disk size is explicitly advisory wherever the selected engine cannot enforce a quota.

Generation-history pruning may remove terminal generations, attempts, logs under retention policy, and generation attachments. It can never remove a live preview-environment or managed-resource authority record.

### 5.9 Application lifecycle and restart boundary

- Renderer reload does not affect application generations, managed resources, or credentials.
- Ordinary application replacement preserves managed resources.
- Destructive Stop Preview, task deletion, and graceful Task Monki shutdown clean the complete preview environment.
- Full main-process restart does not reuse managed resources because credential plaintext is unavailable.
- Restart reconciliation verifies the recorded engine plus exact IDs/labels and cleans exact survivors.
- Reconciliation never adopts a managed container, volume, or network in this phase.
- Identity or cleanup uncertainty becomes `CLEANUP_INCOMPLETE` and never authorizes broad deletion.

## 6. Approval authority

The canonical execution digest includes every capability-bearing decision:

- command argv, cwd, node role, dependency order, readiness, liveness, restart, and overlap policy;
- selected scenario and setup/reset jobs;
- images and pull/platform policy;
- requested resource limits and whether disk is advisory;
- selected OCI context/engine authority;
- environment key/value-source identities and typed binding recipients;
- routes, loopback publication, cleanup authority, and destructive reset/stop behavior.

Source-only changes create a new generation without requiring command reapproval. Dynamically allocated ports and generated secret values are excluded from the digest, while their binding identities and recipients are included.

Resolution must present inactive scenario resources/jobs as inactive; they must not silently broaden engine requirements, reset controls, or approval claims.

## 7. Current implementation shape

- `PreviewManager` owns product orchestration: resolve, approve, capture, start, replace, reset, stop, and shutdown.
- `PreviewGraph` owns one live application generation's native DAG, probes, supervision, and exclusive-node handoff.
- `OciResourceRuntime` owns the preview environment and typed managed-resource lifecycle, including exact inspection and cleanup.
- `PreviewReconciler` performs stop-only restart recovery and never adopts native or OCI resources.
- `FileTaskStore` is durable authority; live maps and subprocess output are handles or observations only.

Phase 4 must extend these boundaries rather than add a second lifecycle. In particular, encrypted binding storage may replace the volatile credential host, while attached resources remain non-owned and are categorically excluded from stop, reset, and reconciliation cleanup.

### Implementation-quality constraints

- One authoritative lifecycle path owns managed-resource start, inspect, stop, reset, and reconciliation.
- Do not duplicate cleanup policy across manager, graph, reset, and reconciler call sites.
- Keep Docker command construction and identity inspection inside the engine/resource adapter.
- Keep product lifecycle decisions in Task Monki domain/orchestration code.
- Prefer typed PostgreSQL behavior over a speculative generic container framework.
- Add a shared abstraction only after PostgreSQL and Redis demonstrate the same stable contract.
- Do not introduce plugin frameworks, generic repositories, factories, service locators, event-sourcing layers, or compatibility adapters for hypothetical resource types.
- Do not preserve prototype complexity merely to minimize the textual diff.
- A larger deletion followed by a smaller implementation is preferred over incremental patches around the rejected lifecycle.

## 8. Normative acceptance criteria

### Stable identity and isolation

- Exactly one PostgreSQL/Redis container exists per logical preview resource.
- A1 → A2 retains container, volume, credential, published-port, and connection-URL identity.
- The preview network remains the same across A1 → A2 and is owned only by the preview environment record.
- Authenticated PostgreSQL queries and Redis commands succeed before and after replacement.
- Two task previews have distinct environments, networks, containers, volumes, credentials, ports, URLs, and data.

### Application replacement

- Routed stateless services may overlap only during candidate readiness/cutover.
- Exclusive workers do not overlap by default.
- `overlap: safe` is explicit and approval-bound.
- Failed candidate exclusive activation restores/reverifies the complete old graph within its declared deadline or fails/detaches it.
- Normal replacement runs no migration or seed.
- Failed candidate startup cannot leave both generations' unapproved exclusive nodes running.

### Setup and failure

- Managed resources are not reusable until authenticated readiness and required setup complete.
- Observed setup failure blocks application start as `SETUP_FAILED`.
- Ambiguous non-retry-safe setup becomes `RECOVERY_REQUIRED` and never reruns automatically.
- Killing PostgreSQL/Redis after `READY` fails and detaches the complete active application while preserving volumes and unrelated resources.
- No health/liveness failure automatically performs destructive managed-data cleanup.

### Reset

- Recipe, scenario, digest, and approval are revalidated before mutation.
- Reset detaches routes and stops the complete active application.
- Any application or selected-resource cleanup uncertainty blocks reset.
- Database reset preserves Redis; Redis reset preserves PostgreSQL.
- Repeated database resets preserve Redis.
- Alternating database and Redis resets preserve each non-target resource.
- Recreation/setup failure is shown as destructive failure and never claims deleted data was restored.

### Ownership, pruning, and limits

- More than twenty application replacements cannot prune live environment/resource authority.
- Images with inherited labels pass reserved-subset ownership verification and exact cleanup.
- Unsupported requested CPU/memory/PID limits reject the plan before approval.
- Missing unrequested limit capability is informational; unenforced disk size is visibly advisory.
- No cleanup path targets an object by name/prefix alone.

### Lifecycle and recovery

- Destructive Stop Preview removes exact application processes, containers, volumes, network, and data with no OCI residue.
- Task deletion and graceful Task Monki shutdown leave no Task Monki OCI residue.
- Real main-process death followed by restart reconciliation cleans exact resources without adopting them or touching unrelated objects.
- Create/record crash-boundary tests prove discoverability through durable intent plus exact IDs/reserved labels.
- Engine missing, unavailable, wrong architecture, pull failure, unhealthy resource, setup failure, recovery-required ambiguity, and cleanup failure remain distinct outcomes.
- Docker Desktop and one alternative macOS context pass the capability suite before broader engine support is claimed.

## 9. Later phases

### Phase 4 — private inputs and attached dependencies

- Implemented: recipient-scoped private input declarations, encrypted immutable local revisions, dedicated manual/single-key import IPC, and execution-readiness blockers that do not block planning or approval.
- Implemented: literal and task-local HTTP/TCP/PostgreSQL/Redis attachments, stable cross-task route identity, environment-only delivery with zero checks, and optional memoized one-shot startup readiness.
- Implemented: attachment non-ownership, no continuous watches, no post-ready consumer transition, exact generation lease retention, and best-effort encrypted cleanup debt after task deletion.
- Implemented: the volatile managed credential host uses protected runtime files, Redis configuration delivery without plaintext argv, and authenticated PostgreSQL readiness over the published loopback TCP port. Durable managed credentials, stdin transport, and managed-resource adoption remain out of scope.
- Release evidence must still prove plaintext absence across store, snapshot, argv, plans, logs, artifacts, events, errors, renderer state, Docker inspect/log/layer/volume surfaces, and nonrecipients.

### Phase 5 — existing Compose application adapter

- Inspect and approve normalized repository-owned Compose configuration.
- Use exact project/config/object authority and loopback exports.
- Keep Compose persistent data under preview/Compose-project authority; never reintroduce generation-owned managed data.
- Do not rewrite repository Compose files or infer migration/worker semantics.

### Phase 6 — multi-repository source composition

- Add exact companion revision resolution and per-repository source manifests.
- Keep generation source composition separate from preview-owned managed-resource authority.
- Source changes create application generations and attachments; they do not transfer database/cache ownership.

### Phase 7 — AI-assisted recipe discovery

- Generate candidate recipe diffs without execution.
- Never infer `overlap: safe`, setup retry safety, migration timing, attached-host authority, or destructive reset behavior.
- Leave ambiguous proposals incomplete for explicit owner review.

## 10. Required implementation evidence

The default suite does not substitute for the opt-in real-engine gates below. Phase 3 must not be treated as fully accepted until those gates have run against the supported context matrix and the visible destructive/recovery states have been rendered in both themes.

| Work | Required evidence |
|---|---|
| Phase 2 overlap correction | Real multi-node replacement fixture; exclusive-worker non-overlap; approved safe-overlap fixture; candidate activation failure and bounded old-graph restoration. |
| PostgreSQL slice | Real authenticated query; stable IDs/credentials/port/URL across A1 → A2; two-preview isolation; exact destructive stop. |
| Redis slice | Real authenticated command before/after replacement; stable identity; two-preview isolation. |
| Setup/reset | Initial-only setup, no replacement setup, setup-failed/recovery-required states, target-only repeated and alternating reset, preflight-before-mutation. |
| Supervision | Post-ready database/cache death fails/detaches the complete app without deleting volumes. |
| Ownership/recovery | Real process termination at create/record boundaries, exact cleanup without adoption, inherited-label image, unrelated-object noninterference, >20-generation pruning. |
| Engine capability | Requested unsupported-limit rejection; advisory disk display; Docker Desktop plus one alternative macOS context. |

Mocks are useful for domain transitions but cannot satisfy real process, authenticated database/cache, engine identity, crash recovery, or cleanup gates.

At every implementation milestone run:

```sh
npm run typecheck
npm test
npm run build
npm run check:codex-protocol
git diff --check
```

Visible destructive stop/reset and failure/recovery states also require seeded and rendered UI verification in light and dark themes.

## 11. Remaining phase-gated decisions

The Phase 2 overlap deadline, volatile Phase 3 credential host, resource-limit behavior, reset lifecycle, failure cleanup behavior, and network ownership are resolved above.

Remaining decisions are outside the immediate lifecycle:

- whether to add a future explicit migration-during-replacement action at all;
- which alternative macOS Docker context becomes the required support fixture;
- when generic OCI resource support has enough shared behavior to follow PostgreSQL/Redis;
- Phase 4 encrypted-binding backend behavior on non-macOS platforms;
- support gates for Windows/Linux native process ownership and OCI engines;
- source watcher versus evidence-triggered freshness and later retention/idle-suspension policy.

None of these may weaken or postpone the Phase 2 overlap correction or revised Phase 3 invariants.
