# Task Preview: local execution architecture rationale

Status: supporting technical rationale for the normative implementation plan
Date: 2026-07-12
Normative plan: [`../plans/task-preview-implementation-plan.md`](../plans/task-preview-implementation-plan.md)

## Purpose and authority

This document explains why Task Monki uses native application generations plus preview-owned managed dependencies. It does not define phase acceptance criteria or a parallel lifecycle. The implementation plan is authoritative whenever wording differs.

The immediate work is deliberately narrow:

1. correct Phase 2 application-generation overlap;
2. replace the unshipped Phase 3 managed-data prototype with preview-owned PostgreSQL;
3. add Redis through the proven contract;
4. add supervision, reset/setup, crash, pruning, and engine-context hardening.

Private inputs and attached dependencies remain Phase 4, Compose remains Phase 5, multi-repository source composition remains Phase 6, and AI-assisted discovery remains Phase 7. Generic OCI support follows typed PostgreSQL/Redis only when they prove a genuinely common lifecycle.

## 1. Architectural decision

Task Monki should remain a recipe-directed hybrid local executor:

- application services, frontends, jobs, and workers run as verified native processes from captured application generations;
- PostgreSQL and Redis run as stable preview-owned OCI resources through an explicitly selected Docker-compatible engine;
- one Task Monki loopback gateway gives browser routes stable `.localhost` identities while application target ports and generations change;
- Task Monki records source, plan, approval, process, route, engine, object, readiness, and cleanup evidence independently of subprocess claims.

This is not a universal development-environment platform. It is a bounded way to turn an approved repository recipe and identified task source into a local application that Task Monki can explain, observe, replace, and clean safely.

## 2. Why application generations remain

A generation is immutable application evidence:

- captured task source and Git identity;
- approved execution digest;
- prepared workspace;
- native node attempts and exact process ownership;
- generated application ports and route targets;
- readiness, failure, logs, freshness, and cleanup state.

A1 → A2 ready-before-cutover replacement is still the right application model. It prevents stable routes from pointing at a half-started candidate and preserves exact evidence for what ran.

The mistake in the Phase 3 prototype was making managed data follow the application-generation lifetime. Databases and caches should not be recreated, recredentialed, or mounted by two containers merely because application source changed.

The normalized relationship is:

```text
Preview A
  ├── managed environment/network A
  ├── PostgreSQL A
  ├── Redis A
  ├── generation A1 → attachment references
  └── generation A2 → attachment references
```

Application generations remain replaceable. Managed resources remain stable until explicit destructive cleanup.

## 3. Why ownership has three boundaries

### Preview-managed environment

The selected context/endpoint/engine and preview network are shared authority. Storing the network under every resource would duplicate cleanup ownership and make reconciliation ambiguous. One preview-environment record therefore owns the network, while resources reference it.

### Preview-managed resource

Each logical PostgreSQL/Redis resource owns its exact container and volume, stable non-secret binding metadata, health/setup state, and container/volume cleanup authority. Its lifetime is independent of terminal application generations, so history pruning cannot orphan a live object.

### Generation attachment

An attachment says only that A1 or A2 consumed a managed resource. It explains the generation environment but does not transfer ownership or determine resource lifetime. It is safe to prune with generation history.

This separation is sufficient. A generic repository/factory/plugin framework would add indirection without improving authority or cleanup safety.

## 4. Why credentials are volatile in Phase 3

Generated database/cache credentials must remain stable across A1 → A2, but Phase 3 does not yet have the encrypted private-binding system planned for Phase 4.

The smallest safe bridge is a main-process runtime credential host keyed by managed-resource ID:

- plaintext exists only in the Electron/main preview runtime;
- `FileTaskStore` retains non-secret binding identity/digest and safe metadata, never the value;
- orchestration resolves a typed connection binding only when starting a declared recipient;
- renderer reload does not affect the host;
- main-process restart loses the value and therefore cleans exact surviving resources instead of adopting them.

This converts a security limitation into an explicit lifecycle boundary. Phase 4 can replace the volatile host with encrypted durable bindings without changing environment/resource/attachment ownership.

## 5. Why the preview owns one stable network

One user-defined network per task preview gives managed containers a stable, isolated namespace and one exact cleanup owner. Native application generations normally reach resources through stable dynamic loopback publication; later container consumers may attach to the preview network without owning it.

All host publication is explicit `127.0.0.1`. Docker otherwise publishes omitted host IPs broadly, so loopback binding is a security requirement, not convenience. The selected Docker context must be honored rather than assuming `/var/run/docker.sock` or Docker Desktop.

Resource names are diagnostic only. Cleanup authority is selected engine identity plus exact IDs plus the complete Task Monki reserved-label subset. Image-defined and inherited labels are unrelated metadata and must not invalidate ownership.

Relevant engine behavior is documented by Docker's [container run reference](https://docs.docker.com/reference/cli/docker/container/run) and [object labels documentation](https://docs.docker.com/engine/manage-resources/labels/).

## 6. Replacement and overlap rationale

Ready-before-cutover creates a safe overlap window for routed stateless services, but the same default is unsafe for workers, schedulers, and queue consumers: duplicate instances can deliver email twice, race leases, or process one queue item twice.

The architecture therefore distinguishes:

- candidate stateless-service readiness;
- exclusive-node handoff;
- atomic route cutover;
- old-generation retirement.

Exclusive nodes stop before their candidate equivalents start. A bounded readiness deadline makes rollback evidence-based: restore and reverify the complete old graph by the old node's deadline, or fail and detach it. `overlap: safe` is an explicit exception and part of approval authority.

This correction belongs to Phase 2 because it is application lifecycle behavior independent of Docker.

## 7. Setup and replacement rationale

Migrations and seeds mutate shared data. Once managed resources survive application replacement, automatically rerunning setup on every generation would make A2 preparation change the database still used by A1.

Setup is therefore tied to resource creation:

- initial resource creation runs approved migration/seed setup;
- explicit Reset creates a new resource and runs approved setup;
- ordinary A1 → A2 replacement runs no migration or seed;
- ambiguous non-retry-safe completion requires explicit recovery.

A managed resource is not reusable merely because its container is running. It becomes ready only after authenticated readiness and required setup complete. This avoids false readiness from TCP-only or unauthenticated probes.

## 8. Failure without automatic data destruction

Post-ready database/cache death invalidates the application that depends on it. Task Monki should detach the complete active generation and stop verified native consumers, because partial route survival would imply independent subgraphs the product does not yet model.

The persistent volume is different: a transient health failure is not authority to destroy data. The resource becomes failed or recovery-required with bounded evidence, while destructive cleanup remains explicit through Reset or Stop Preview. Graceful app shutdown and restart reconciliation are exceptions only because Phase 3 does not promise cross-main-process persistence.

This separation keeps readiness truthful without turning liveness failure into data loss.

## 9. Why Stop Preview and Reset are destructive

The initial product does not preserve managed data after the preview is stopped. The user-facing action must therefore say that it deletes preview data and require concise confirmation.

Reset is also destructive. It preflights the current recipe, scenario, digest, approval, active application, and exact resource authority before mutation. It then stops the complete application, replaces only the selected managed resource, runs setup, and starts a new complete generation. Partial application shutdown and partial route survival would add complex intermediate authority with no demonstrated product need.

If resource recreation or setup fails, deleted data cannot be restored. The approval/confirmation surface must state that plainly.

## 10. Why restart cleans instead of adopts

Durable adoption would require both exact object authority and durable credential recovery. Phase 3 has only the first. Adopting a surviving container while its password is unavailable would create a false-ready environment that application generations cannot use.

On restart, Task Monki therefore:

1. removes routes;
2. verifies the recorded context/engine;
3. inspects exact environment/resource IDs and reserved labels;
4. cleans verified survivors;
5. records `CLEANUP_INCOMPLETE` for uncertainty;
6. never searches by a guessed name or adopts the managed environment.

This is intentionally different from renderer reload, which leaves the main-process credential host and live preview intact.

## 11. Source, approval, and stable access

The existing foundations remain valid:

- capture tracked plus non-ignored untracked task source into a private generation workspace;
- bind each generation to Git evidence plus a complete source manifest;
- keep ordinary source changes separate from capability approval;
- approve commands, cwd, dependencies, overlap, images, limits, recipients, routes, setup/reset, and cleanup authority;
- inject dynamic application ports on loopback;
- route stable preview hostnames through the Task Monki gateway;
- keep raw logs and manifests bounded outside the main task snapshot;
- keep preview state independent of task workflow phase and provider telemetry.

The execution digest excludes generated credential values and dynamic ports, but includes their binding identities, recipients, and authority-bearing policies.

## 12. Engine limits and portability

Requested limits are part of the user's approved safety expectation. If the selected engine cannot enforce a requested CPU, memory, or PID limit, rejecting before approval is more truthful than silently weakening it. Missing capability does not matter when no limit was requested. Portable volume disk quotas are not consistently available, so disk size remains clearly advisory where unenforced.

Support is capability-based, not brand-based. Docker Desktop and one alternative macOS context must pass the same pull, identity, labels, network, volume, loopback publication, health, and cleanup contract before broader compatibility is claimed. Podman/Colima compatibility is an observed result, not inferred from a Docker-compatible CLI name.

## 13. Implementation-shape guidance

The clean replacement should have one authoritative managed-resource lifecycle path. Product orchestration decides when start, failure, reset, stop, and reconciliation are allowed; the Docker adapter constructs commands and inspects identity.

Avoid:

- separate cleanup managers for normal stop, reset, failure, and reconciliation;
- speculative resource plugin frameworks;
- repositories/factories/service locators added only for hypothetical types;
- compatibility readers or dual old/new lifecycles for the unshipped prototype;
- preserving rejected branches merely to keep old tests green;
- starting with generic OCI when typed PostgreSQL behavior is the actual proof point.

PostgreSQL should establish the smallest concrete contract. Redis may then reveal the truly shared seam. Deleting rejected code before implementation is preferable to wrapping it in more abstractions.

## 14. Later architecture, not immediate scope

| Phase | Later capability | Relationship to the current model |
|---|---|---|
| 4 | Private inputs and attached dependencies | Durable encrypted credentials can replace the volatile host; attached resources remain non-owned. |
| 5 | Existing Compose adapter | Compose remains an adapter with exact project authority; persistent data must not become generation-owned. |
| 6 | Multi-repository source composition | Extends generation source identity without changing preview-managed resource ownership. |
| 7 | AI-assisted discovery | May propose recipes but cannot decide overlap safety, retry safety, or destructive data behavior. |

Container-build fallbacks, Dev Containers, Devbox/Nix, Process Compose, alternative OCI engines, and stronger sandboxes remain possible later adapters. None replaces Task Monki's recipe, approval, generation, route, evidence, and exact ownership model.

## Final rationale

The architecture separates two different rates of change:

- application source changes produce new evidence-bearing generations;
- preview-owned managed data remains stable until the user explicitly resets or destructively stops the preview.

That separation preserves A1 → A2 cutover, avoids concurrent database containers and credential drift, keeps pruning safe, and makes destructive actions explicit. It also leaves a clean path to Phase 4 durable credentials without forcing Phase 3 to store plaintext or pretend restart adoption is possible.
