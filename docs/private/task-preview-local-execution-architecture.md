# Task Preview: Local Execution Architecture

Status: technical decision recommendation; managed-data model revised before Phase 3 ships
Date: 2026-07-12
Scope: how Task Monki should prepare, run, expose, and recover a task's application locally after the user clicks **Preview**

## Decision in one page

Task Monki should build a **recipe-directed hybrid local executor**.

- Run application servers, frontends, and workers as supervised native processes when the repository provides explicit commands.
- Run stateful dependencies such as PostgreSQL and Redis as Task Monki-owned OCI containers through an already-installed Docker-compatible engine.
- Give each task preview one stable managed PostgreSQL/Redis resource per logical resource. Application generations attach as consumers; they never own or adopt managed data.
- Import an existing Compose application as an opaque, namespaced stack when a repository already has a suitable Compose file. Do not translate every repository into Compose.
- Allow explicitly attached services and databases as the lowest-common-denominator fallback.
- Put a Task Monki HTTP gateway in front of every browser-facing service so its URL stays stable while internal ports and generations change.
- Resolve a committed `.taskmonki/preview.yaml` into an immutable, approved generation plan. Store the resolved plan, source revisions, resource identities, and lifecycle state in Task Monki's durable store.
- Run managed-resource setup/migration/seed only on initial creation and explicit reset. Ordinary application replacement reuses the same containers, volumes, credentials, ports, and URLs without mutating shared data.
- During replacement, overlap routed stateless services only. Workers, schedulers, queue consumers, and other side-effecting nodes are exclusive by default unless `overlap: safe` is explicitly declared and approved.
- Prepare each generation in a private execution workspace assembled from the task worktree and any pinned companion repositories. Do not let installers and generated files mutate the user's original repository or Task Monki's source checkout.

The first useful implementation should support:

1. one or more native command services and workers;
2. ordered one-shot jobs for install, build, migrate, and seed;
3. stable preview-owned PostgreSQL and Redis resources through a Docker-compatible CLI;
4. attached resources for anything Task Monki cannot manage yet;
5. HTTP, TCP, and command readiness checks;
6. stable `.localhost` routes through one Task Monki gateway;
7. immutable application-generation records, generation-to-resource attachments, and a separate exact preview-owned managed-resource ledger;
8. explicit approval of the resolved plan before commands first run or the recipe changes.

Compose passthrough should be the first adapter added after that slice, or included in the slice if repository sampling shows that it unlocks more real projects than the built-in PostgreSQL/Redis resource driver.

This is deliberately not a universal development-environment system. It is a reliable way to turn a known task revision and an explicit repository recipe into a locally reachable application.

## Why this changes the earlier recommendation

The earlier research report made containment and sealed execution the dominant design pressure and therefore leaned toward Compose as the first universal runtime. That is too restrictive for the product's immediate job.

The common preview is a framework application that already runs with a package-manager command and needs, at most, a database. Requiring that repository to acquire a Dockerfile or Compose model makes Task Monki solve packaging before it can show the application. On macOS it also forces every simple frontend through a Linux VM, image build, and bind-mount boundary. Those costs are justified for an existing container topology, but not for every preview.

The useful parts of the earlier position remain:

- Task Monki must execute from an identified source generation, not an ambiguous moving worktree.
- Discovered commands are proposals, not authority.
- A plan must be approved before it executes.
- Resources must be namespaced, inventoried, and recovered by Task Monki.
- Secrets must be references resolved at runtime, not values committed to the repository.

The changed conclusion is that **isolation should be graduated by resource type**. Native processes are the compatibility and startup-speed path for application code. Containers are the reproducible lifecycle path for databases and queues. Existing Compose is preserved rather than reconstructed. Stronger container or VM isolation can be an optional execution profile later.

This matches the most useful patterns from hosted platforms without pretending a laptop is a cloud control plane:

- Vercel detects framework defaults but lets repository settings override install, build, output, and root-directory choices; its monorepo model treats each deployable directory as an explicit project ([build configuration](https://vercel.com/docs/builds/configure-a-build), [monorepos](https://vercel.com/docs/monorepos)).
- Netlify Dev detects a framework command and places a local proxy in front of the target port; file configuration remains the explicit override ([local development](https://docs.netlify.com/api-and-cli-guides/cli-guides/local-development/), [file-based configuration](https://docs.netlify.com/build/configure-builds/file-based-configuration/)).
- Render's Blueprint model distinguishes web services, private services, workers, jobs, key-value services, and databases, then wires service/database outputs into environment variables ([Blueprint specification](https://render.com/docs/blueprint-spec), [service types](https://render.com/docs/service-types)).
- Railway separates build, pre-deploy, start, health, restart, and variable configuration; Railpack first produces an inspectable build plan and only then turns it into an image ([Railway configuration](https://docs.railway.com/config-as-code/reference), [Railpack architecture](https://railpack.com/architecture/overview/)).

Task Monki should borrow the explicit plan, typed resources, output-to-environment wiring, and stable proxy. It should not borrow the assumption that every source tree is deployed as an immutable cloud image.

## 1. Practical local-preview architecture

### 1.1 Ownership boundary

Task Monki remains authoritative for:

- the task and its selected source revision;
- the preview recipe and its approved digest;
- companion-repository revisions;
- application-generation state and desired lifecycle;
- preview-owned managed-resource authority and health independent of generation history;
- processes, containers, volumes, networks, ports, routes, and runtime files it creates;
- locally observed readiness and exit results;
- the current stable preview URL.

The executed application is authoritative only for its own runtime behavior. Output such as “server ready” is telemetry until a declared readiness check succeeds. Docker or Process Compose state is likewise observed runtime state, not Task Monki workflow truth.

This preserves the repository's existing architecture rule: provider or subprocess output does not become verified workflow evidence merely because it was emitted.

### 1.2 Control-plane components

The preview subsystem should have ten narrow responsibilities.

| Component | Responsibility |
|---|---|
| Preview coordinator | Serializes start, stop, restart, and replace operations for one preview; persists desired state before effects. |
| Recipe loader | Parses and schema-validates `.taskmonki/preview.yaml`; rejects unknown required features rather than guessing. |
| Plan resolver | Resolves repositories, commands, images, references, scenario, toolchains, and dependencies into a concrete DAG. |
| Approval gate | Compares the resolved capability-bearing plan with the last approved digest and blocks changed execution authority. |
| Source preparer | Creates an immutable generation workspace from the task source plus pinned companion repositories. |
| Secret resolver | Resolves declared inputs from approved local bindings and injects them only into named recipients. |
| Resource adapters | Create, inspect, stop, and remove native, OCI, Compose, or attached resources through a common lifecycle contract. |
| Preview supervisor | Owns native jobs/services, readiness, restart policy, log capture, and ordered shutdown outside the renderer process. |
| Route gateway | Routes stable `.localhost` hostnames to current loopback targets and handles HTTP upgrades such as WebSockets. |
| Reconciler | Rebuilds actual state from the durable ledger, the supervisor control socket, process identity, and container labels after restart. |

The renderer should only request lifecycle transitions and render projections. It should not spawn commands, allocate ports, or infer readiness.

### 1.3 Three durable records

The store should distinguish configuration, immutable evidence, and mutable runtime ownership.

**Preview definition**

- task identifier;
- recipe path and current recipe digest;
- approved execution digest and approval metadata;
- selected scenario;
- user-local repository and secret bindings;
- stable route identities;
- desired state: stopped or running.

**Preview-owned managed-resource authority**

- task/preview ID plus logical resource ID;
- selected Docker context, endpoint digest, and engine identity;
- exact container, network, and volume IDs;
- a runtime-private credential value plus persisted non-secret binding metadata/digest; the value remains stable across application generations but volatile until private storage exists;
- health/lifecycle/setup state and exact cleanup authority;
- Task Monki reserved ownership-label subset.

This authority survives application-generation replacement and is never stored only beneath terminal generation history. In the initial design it does not survive a full Task Monki quit: graceful shutdown and restart reconciliation clean it rather than adopt it.

**Preview generation** — immutable after resolution

- generation identifier and creation time;
- source manifest for every repository: origin identity, commit, dirty-overlay digest, and prepared path;
- full resolved DAG and execution digest;
- resolved image references and, after pull, image digests;
- tool/runtime versions and capability probe results;
- environment key names and reference identities, never plaintext secret values;
- allocated route names, application target ports, and managed-resource attachment identities;
- completion evidence for one-shot jobs.

**Generation attachment**

- generation ID plus preview-owned managed-resource ID;
- logical dependency/binding identity used by that generation;
- no container/volume ownership transfer or cleanup authority;
- safe to prune with generation history.

**Generation runtime ledger** — append/update through lifecycle

- native supervisor and service process identities;
- Compose project name and config digest;
- runtime files, sockets, log files, and their owners;
- readiness observations, exits, restart counts, and cleanup state;
- last reconciliation result and any suspected orphan.

A generation never changes source underneath itself. Clicking Preview after the task changes creates a new application generation that attaches to the existing preview-owned managed resources, starts under the explicit overlap policy, switches stable routes only after readiness, then retires the old application generation. Managed containers are not duplicated or restarted during this handoff.

### 1.4 Execution workspace

Each generation gets a private directory outside all repositories, conceptually:

```text
<task-monki-data>/previews/<preview-id>/generations/<generation-id>/
  sources/<repo-id>/
  runtime/
  logs/
  resolved-plan.json
  source-manifest.json
```

The source preparer should:

1. identify the task worktree's base commit;
2. copy tracked files plus non-ignored untracked files selected by the source policy into the private workspace, blocking suspected secrets for explicit disposition;
3. record a digest for the dirty overlay;
4. exclude `.git`, dependency directories, build output, Task Monki runtime data, and ignored files by default, with explicit include rules for intentionally ignored source artifacts;
5. add each companion repository at an exact resolved commit or an explicitly selected Task Monki task snapshot;
6. record the input manifest before any job runs; the private workspace may then be writable for compatibility, while toolchains that support separate output/cache directories should receive read-only source and explicit writable paths.

On APFS, clone-on-write copying should be evaluated because it can make a private snapshot cheap. Correctness must not depend on that optimization. A later watch mode can incrementally produce new generations; the first implementation should favor a coherent click-time snapshot over live mutation.

Running directly in the task worktree is an opt-in compatibility mode, not the default. Package installation, code generation, and framework caches otherwise create a second actor mutating the same files the AI or user may still edit.

### 1.5 Lifecycle

The state machine should be explicit:

1. **Resolving** — parse config, resolve repositories and references, detect local capabilities.
2. **Awaiting approval** — only when the execution digest is new or a required binding is missing.
3. **Preparing source** — assemble and hash generation inputs.
4. **Preparing resources** — create missing preview-owned network/volumes/containers once, or verify stable existing authority; run attached-resource checks.
5. **Running setup or application jobs** — run migration/seed only for first resource creation or explicit reset; run ordinary generation jobs without mutating shared managed data.
6. **Starting services** — start routed stateless services for readiness; hand off exclusive workers/schedulers without overlap unless `overlap: safe` is approved.
7. **Checking readiness** — use declared probes, not log text, unless log matching is explicitly configured.
8. **Ready** — atomically point stable routes at the generation.
9. **Degraded** — a noncritical service failed or a liveness probe is failing.
10. **Failed** — a required job, service, or readiness deadline failed.
11. **Stopping** — remove routes, stop services in reverse dependency order, stop resources.
12. **Stopped** or **Cleanup incomplete**.

The coordinator should journal intended effects before running them and record concrete identities immediately after creation. Cleanup must target only ledger identities and ownership labels; it must never use broad process-name or image-name matching.

#### Application replacement overlap

Replacement has four distinct boundaries: candidate stateless-service readiness, exclusive-node handoff, atomic route cutover, and old-generation retirement.

- Routed stateless services may overlap while the candidate becomes ready.
- Workers, schedulers, queue consumers, and other side-effecting long-running nodes are exclusive by default.
- `overlap: safe` is an explicit, approval-bound declaration for a worker proven safe to run in both generations.
- Finite jobs and migrations never overlap automatically.
- Exclusive handoff stops the old node before starting the candidate equivalent, so a brief processing gap is acceptable.
- If candidate exclusive activation fails, Task Monki may restore the old node only as part of a complete reverified old graph. If that cannot be proven, the candidate fails and the affected active generation is failed/detached. It must never silently leave both exclusive owners running.

### 1.6 Native supervision and crash recovery

The current `src/core/process/ProcessSupervisor.ts` is a useful primitive: it already launches with explicit executable, arguments, working directory, and environment; on Unix it uses process groups and escalates SIGINT to SIGTERM to SIGKILL. Preview execution needs a durable layer above that primitive.

Run a preview supervisor process per active generation. It should expose a private Unix-domain control socket on macOS/Linux, own all native child groups, capture bounded logs, perform health checks, and publish state events. Keeping it outside the renderer means a renderer reload does not destroy the preview. Keeping it per generation limits fault scope.

Persist, at minimum, the supervisor PID, process start identity, socket path, random generation token, service process-group IDs, and command digests. On Task Monki restart:

1. connect to the recorded socket and authenticate the generation token;
2. if that succeeds, reconcile the supervisor's inventory with the ledger;
3. otherwise verify PID/start identity before signaling any recorded group;
4. inspect OCI resources by exact ID and Task Monki ownership labels;
5. mark ambiguous native processes as suspected orphans instead of killing a possibly reused PID;
6. clean exact surviving managed OCI resources rather than adopting them; generated credentials are not durably reusable in this initial phase.

Node's detached child option creates a new process group/session on non-Windows platforms, which supports group shutdown, but detached children can outlive their parent; persistence and identity verification are therefore required, not optional ([Node child-process documentation](https://nodejs.org/api/child_process.html#optionsdetached)).

Default restart behavior should be bounded exponential backoff with a finite attempt count and a stable-period reset. One-shot migration and seed jobs must not be retried automatically after an ambiguous crash unless the recipe marks them retry-safe, and they are not ordinary application-generation startup hooks.

## 2. Strongest execution approaches and how Task Monki could use them

### 2.1 Direct native commands

**Use:** the default application-service and job driver.

Task Monki executes an argument vector in a prepared repository directory, injects declared environment, and supervises the resulting process group. This is the fastest path for Vite, Next.js, Rails, Django, Go, Rust, and similar applications that already have local start commands.

Strengths:

- no image build for ordinary source changes;
- native filesystem performance on macOS;
- preserves framework hot-start behavior and existing package caches;
- can run multiple frontends, APIs, and workers through one DAG;
- integrates directly with Task Monki's existing process supervisor.

Limits:

- depends on a compatible host toolchain;
- weaker isolation from the host than a container or VM;
- native package or architecture differences can reduce reproducibility;
- fixed-port applications must be configured before parallel previews can work.

Task Monki should prefer argument arrays. A shell string is an explicit elevated capability because it introduces expansion, pipelines, and redirects. It can be supported, but it must be visible in the approval plan.

### 2.2 Task Monki-native service graph

**Use:** the source of truth for mixed native services, jobs, workers, and resources.

The graph is not another process-manager configuration. It is the resolved form of `preview.yaml`, stored as Task Monki evidence. Nodes have typed lifecycle semantics:

- **job:** finite command, success required unless optional;
- **service:** long-running command with readiness and restart policy;
- **worker:** long-running command without a browser route;
- **resource:** managed OCI or attached external dependency;
- **compose stack:** externally supervised group with declared exported endpoints.

Edges mean more than start ordering. A dependency can require “created,” “ready,” or “job succeeded.” This avoids the common mistake of treating a running database container as a ready database.

### 2.3 Process Compose

**Use:** prototype as an implementation dependency for native supervision, but do not make its YAML the repository contract.

Process Compose already provides dependency ordering, readiness/liveness checks, restart policies, ordered shutdown, a process graph, and a local control API/Unix socket ([health checks](https://f1bonacc1.github.io/process-compose/health/), [process dependencies](https://f1bonacc1.github.io/process-compose/launcher/), [client/API](https://f1bonacc1.github.io/process-compose/client/)). It is available as a macOS binary and package-manager install ([installation](https://f1bonacc1.github.io/process-compose/installation/)).

Task Monki could compile its resolved native subgraph to a private Process Compose configuration and consume the API. This may save substantial supervisor work. However:

- Task Monki still needs its own durable generation, resource, approval, secret, and route models;
- mixed OCI/attached/Compose dependencies still require a Task Monki coordinator;
- bundling, updates, crash behavior, log bounding, and API stability become product dependencies;
- asking repositories to commit Process Compose config would leak an implementation choice into the user contract.

The prototype should decide whether to embed it. The architectural contract must work with either Process Compose or an extended internal supervisor.

### 2.4 OCI resources through a Docker-compatible engine

**Use:** the default managed path for databases, queues, object-store emulators, and other versioned infrastructure.

Task Monki should call an engine adapter with explicit image, network, volume, loopback port publication, health check, labels, and resource limits. The first adapter can use the Docker CLI and active Docker context. It must not assume Docker Desktop specifically.

Every managed resource gets labels such as Task Monki store, task/preview ID, logical resource ID, recipe authority, and resource-record ID. Application generation ID is attachment evidence, not managed-resource ownership. The engine returns exact container/network/volume IDs, which are written to the preview-owned authority ledger. Docker supports explicit labels, CID files, health checks, resource limits, and loopback-only publication; importantly, omitting the IP publishes on all interfaces, so Task Monki must always bind managed ports to `127.0.0.1` ([`docker container run`](https://docs.docker.com/reference/cli/docker/container/run)). Recovery compares Task Monki's reserved label subset so inherited image labels do not cause false refusal ([Docker object labels](https://docs.docker.com/engine/manage-resources/labels/)).

Use one user-defined managed-resource network per task preview. Native application generations reach resources through stable dynamically assigned loopback ports. Later fully containerized consumers must attach without taking ownership of that network or persistent data.

Do not automatically install or start Docker Desktop, Colima, or Podman Machine. Capability detection should report the active engine/context and let the user select or attach an alternative.

### 2.5 Docker Compose passthrough

**Use:** an adapter for repositories that already own a working Compose topology.

Task Monki invokes the repository's Compose file with an explicit, generation-unique project name, a generated override file, an explicit environment file outside the source tree, and declared profiles. It reads the normalized Compose plan before approval and records the exact project/config digest.

Compose project names are specifically intended to isolate parallel copies such as feature branches and CI builds ([project names](https://docs.docker.com/compose/how-tos/project-name/)). Compose also provides stable service-name DNS inside the project network while host ports remain separate ([networking](https://docs.docker.com/compose/how-tos/networking/)). Those are strong reasons to preserve an existing stack.

Compose is not the universal Task Monki graph because:

- a simple native app should not require container packaging;
- Compose lifecycle and readiness semantics do not replace cross-driver orchestration;
- arbitrary repository Compose files may mount host paths, publish fixed ports, use external networks, or run privileged containers;
- Task Monki cannot safely infer which services are migrations, seeds, workers, or browser routes from Compose alone.

The recipe must therefore declare which Compose services/profiles to run, which endpoints to export, and which nondefault capabilities are expected. Task Monki treats the project as one adapter-owned resource group and cleans it up only by its exact project identity.

### 2.6 Railpack and Cloud Native Buildpacks

**Use:** later, as a build-plan detector and containerized runtime fallback when no explicit native command/toolchain exists.

Railpack analyzes common languages and frameworks, emits a human-readable/JSON build plan, and can build an OCI image with BuildKit ([architecture](https://railpack.com/architecture/overview/), [configuration](https://railpack.com/config/file/)). This is more suitable than the superseded Nixpacks when current Railway-style detection is desired. Cloud Native Buildpacks similarly separate detect, analyze, restore, build, and export phases ([lifecycle](https://buildpacks.io/docs/for-platform-operators/concepts/lifecycle/)).

Useful integration:

1. run detection without executing the result;
2. convert the detected install/build/start data into a candidate Task Monki plan;
3. show the proposal for approval;
4. optionally build/run the resulting image when the host lacks a compatible runtime.

Neither should silently become source of truth. Both add BuildKit/container latency, image storage, and another detection/version surface. They solve “turn source into an image,” not database provisioning, multi-repository composition, migration safety, stable URLs, or Task Monki recovery.

### 2.7 Dev Containers

**Use:** later, as a toolchain execution adapter for repositories that already commit `devcontainer.json`.

The Dev Container specification covers image/container creation, mounts, forwarded ports, host requirements, environment, and ordered lifecycle commands such as `onCreate`, `postCreate`, and `postStart` ([specification](https://containers.dev/implementors/spec/), [JSON reference](https://containers.dev/implementors/json_reference/)). This can provide a highly compatible toolchain for a repository.

It is not the preview graph. A development container is usually a mutable workspace with editor-oriented lifecycle hooks, while Task Monki needs an identified application generation and typed external resources. The adapter should execute native graph jobs/services inside the prepared dev container and import declared forwarded ports; Task Monki should still own routes, approval, and evidence.

### 2.8 Devbox/Nix and mise-like toolchain managers

**Use:** optional native toolchain adapters, not required runtime infrastructure.

Devbox can install pinned packages and run services through Process Compose, including database plugins ([services](https://www.jetify.com/docs/devbox/guides/services/), [configuration](https://www.jetify.com/docs/devbox/configuration)). It is attractive for repositories that already use it. Requiring it globally would require Nix installation, add a large package/store model, and duplicate Task Monki's service ownership.

The same principle applies to mise/asdf-style version managers: use an existing lock/config to prepare the command environment, but keep the preview graph and resources in Task Monki.

### 2.9 Podman, Colima, and alternative engines

**Use:** backend adapters after capability tests pass.

Podman on macOS runs through a Podman Machine VM. Its `podman compose` command delegates to an external Compose provider rather than implementing one uniform Compose engine ([installation](https://podman.io/docs/installation), [`podman machine`](https://docs.podman.io/en/latest/markdown/podman-machine.1.html), [`podman compose`](https://docs.podman.io/en/stable/markdown/podman-compose.1.html)). Therefore “Docker-compatible API” does not imply identical Compose behavior.

Colima provides a macOS/Linux VM with Docker or containerd runtime, multiple profiles, Docker contexts, and port forwarding ([Colima README](https://github.com/abiosoft/colima/blob/main/README.md)). It can satisfy the Docker CLI adapter when the selected context passes Task Monki's probes.

Task Monki should define a capability suite—pull, labels, health, dynamic loopback publication, networks, volumes, inspect, events, and cleanup—and select adapters based on observed behavior rather than brand strings.

### 2.10 MicroVMs and stronger sandboxes

**Use:** later for an untrusted-execution profile, not the first preview runtime.

A microVM can improve kernel and filesystem isolation, but it makes source synchronization, multi-architecture images, port forwarding, credential delivery, disk lifecycle, and macOS virtualization entitlements central product work. It does not remove the need for the recipe, DAG, gateway, ledger, or approval model. The hybrid architecture deliberately leaves room for a future `sandboxed` execution profile without making that work a prerequisite for useful previews.

## 3. Comparison

Scores are relative to Task Monki's immediate goal. “High” compatibility means broad repository compatibility without asking the repository to adopt a new packaging model.

| Approach | Host prerequisite | First-ready speed | macOS fit | Simple app compatibility | Multi-service/data fit | Reproducibility | Isolation | Recovery ownership | Product complexity | Recommended role |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Direct native commands | Repository toolchain | High | High | High | Medium | Medium-low | Low | Medium-high with supervisor | Medium | Default apps/jobs/workers |
| Process Compose under native graph | Bundled/installed binary plus toolchain | High | High | High | High for processes | Medium-low | Low | Medium; must integrate its state | Medium | Prototype as supervisor implementation |
| Task Monki graph + native supervisor | Repository toolchain | High | High | High | High | Medium | Low | High | Medium-high | Source of truth and likely long-term core |
| OCI resources | Running compatible engine/VM | Medium after images cached | Medium; VM required | Not applicable alone | High for databases/queues | High with image digests | Medium | High through IDs/labels | Medium | Default managed dependencies |
| Existing Docker Compose | Compose plus running engine | Medium | Medium | Low unless already packaged | High | Medium-high | Medium | High by project/labels | Medium | Passthrough adapter |
| Generate Compose for every app | Compose plus buildable packaging | Low-medium | Medium | Low | High | Medium-high | Medium | High | High and invasive | Reject as universal model |
| Railpack/Buildpacks | BuildKit/container backend | Low on first build | Medium | Medium-high for detected stacks | Low alone | High | Medium | High after image creation | High | Later container-build fallback |
| Dev Container adapter | Dev Container CLI plus engine | Medium-low | Medium | High where already configured | Medium-high | High-ish | Medium | Medium | High | Later toolchain adapter |
| Devbox/Nix | Devbox/Nix installed | Medium after cache | High | Medium where configured | Medium-high | High | Low | Medium | High if mandatory | Optional existing-config adapter |
| Podman backend | Podman Machine on macOS | Medium | Medium; VM required | Same as OCI layer | High | High | Medium/rootless | High if capability suite passes | Medium | Later OCI backend |
| MicroVM | VM runtime and images | Low | Medium | Medium | Medium | High | High | High if fully owned | Very high | Later strong-isolation profile |
| Attached environment | User-managed running environment | High if already running | High | Medium | Medium | Low | External | Low; Task Monki does not own it | Low | Explicit fallback |

The hybrid recommendation occupies the useful frontier: native speed and compatibility for source code, container lifecycle and versions for stateful dependencies, and a Task Monki-owned graph/recovery plane across both.

## 4. Recommended first implementation and fallback

### 4.1 Shipping slice

Build the following vertical slice before broad detection or sandbox work.

**Recipe and plan**

- schema version 1;
- one primary task repository, with schema support for companion repositories;
- typed jobs, services, workers, resources, routes, inputs, and one default scenario;
- argument-vector commands; explicit shell commands supported but separately approved;
- reference resolution and immutable generation plan.

**Execution**

- native jobs/services/workers in a private generation workspace;
- a per-generation preview supervisor;
- a Docker CLI resource adapter for PostgreSQL and Redis, plus a constrained generic OCI resource;
- attached HTTP/TCP/database resources;
- dependency edges requiring created, ready, or succeeded;
- HTTP, TCP, and command readiness checks;
- bounded restart and log storage.

**Access and recovery**

- one Task Monki HTTP gateway;
- stable `.localhost` route per named endpoint;
- exact resource ledger, ownership labels, and app-restart reconciliation;
- reverse-order cleanup and a visible cleanup-incomplete state.

**Approval**

- approve a canonical execution digest;
- reapprove when commands, images, repository origins, writable paths, exported ports, secret recipients, or network capabilities change;
- do not reapprove for an ordinary source-only generation.

### 4.2 Immediate next adapter

Add Compose passthrough without translating it into individual Task Monki nodes. The adapter should:

- render/normalize the selected Compose configuration before approval;
- use a generation-unique project name;
- reject or separately approve privileged mode, host networking, device mounts, external networks/volumes, host-path writes outside the prepared workspace, and non-loopback published ports;
- inject a private override for names, labels, loopback ports, and Task Monki environment;
- expose only recipe-declared endpoints;
- inspect by exact project and object identities;
- invoke project-scoped down/cleanup without touching unrelated resources.

### 4.3 Fallback ladder

When the preferred path cannot run, Task Monki should fail over by explicit selection, not silent semantic substitution:

1. **Existing repository adapter:** Compose, Dev Container, Devbox, or another supported committed configuration.
2. **Container build fallback:** Railpack/Buildpacks proposal, after inspection and approval.
3. **Attached dependencies:** Task Monki runs the app but connects to a user-managed database/API/worker environment.
4. **Attached application:** Task Monki only verifies and exposes a declared local URL. It does not claim to own start, stop, migration, or recovery.

If no path is complete, Preview should report the missing capability—runtime, secret binding, fixed port, unsupported architecture, or absent command—rather than guessing a destructive command.

### 4.4 Explicit non-goals for version 1

- Automatically installing language runtimes, Docker Desktop, Nix, or VM software.
- Running arbitrary generated Dockerfiles without approval.
- Live-reloading every task filesystem mutation into a running generation.
- Reproducing production orchestration, TLS, DNS, or autoscaling.
- Sharing previews over the LAN or public internet.
- Running mutually untrusted code with a hard security boundary.
- Inferring whether a migration or seed is safe to retry.

## 5. Role and structure of `.taskmonki/preview.yaml`

### 5.1 Role

The file is a repository-owned declaration of **what constitutes a runnable preview**. It should be reviewable in a pull request, portable across developers, and free of local paths and secret values.

It is not:

- a lock file;
- a record of a running preview;
- a place for encrypted secrets;
- a complete container-orchestration standard;
- an AI-generated script that executes immediately.

Task Monki may propose the file from framework detection, package scripts, Compose, Dev Containers, or Railpack. The proposal becomes executable only after the user approves its resolved plan. Explicit configuration always outranks detection.

The approval surface should render the resolved plan in operational language, for example:

```text
Source: task snapshot 8cc92ab + dirty overlay 7d21…
Install: corepack pnpm install --frozen-lockfile
Create or verify: preview PostgreSQL 17.5 (stable preview-owned data)
Initial setup/reset only: corepack pnpm db:migrate
Initial setup/reset only: corepack pnpm db:seed -- preview
Start application: api, web; hand off exclusive billingWorker
Expose: web.…preview.localhost and api.…preview.localhost
Secrets: stripeTestKey → api, billingWorker
Cleanup on Stop Preview: stop application process groups; delete exact preview-owned containers, network, and volumes
```

The user edits the repository recipe, not an opaque generated command list. Task Monki re-resolves it and approves the new canonical execution digest.

### 5.2 Conceptual top-level schema

| Key | Purpose |
|---|---|
| `version` | Contract version. Unknown major versions fail closed. |
| `repositories` | Logical sources and exact/policy-based revision selection. No absolute local paths. |
| `inputs` | Required variables and secrets, their sensitivity, and allowed recipients. |
| `resources` | Managed OCI or attached databases, queues, and other dependencies. |
| `jobs` | Finite install, build, migration, seed, or preparation commands. |
| `services` | Long-running browser/API services with readiness and optional routes. |
| `workers` | Long-running non-routed processes. |
| `routes` | Stable public-local endpoints mapped to service ports. |
| `scenarios` | Named selections/overrides for data, jobs, services, and input requirements. |
| `limits` | Optional preview-level CPU, memory, disk, log, and startup ceilings. |

### 5.3 Command and reference rules

- `command` is an array of executable plus arguments.
- `shell` is a separate field and a distinct approval capability.
- `cwd` is repository ID plus relative path; `..`, symlink escape, and absolute paths are rejected.
- environment values are literals or typed references.
- dependency edges name nodes and a condition: `created`, `ready`, or `succeeded`.
- image references should be pinned to a version; the generation records the resolved digest. Mutable tags produce a warning and a new execution resolution when their digest changes.
- every browser-facing service declares the environment variable or argument that receives its dynamic listen port.
- readiness is mandatory for a required routed service.

Illustrative reference forms:

```yaml
DATABASE_URL: ${resources.db.url}
REDIS_URL: ${resources.cache.url}
API_INTERNAL_ORIGIN: ${services.api.origin}
PUBLIC_API_ORIGIN: ${routes.api.url}
STRIPE_SECRET_KEY: ${secrets.stripeTestKey}
PORT: ${ports.web}
```

`resources.*.url` and `services.*.origin` are execution-context aware. A native process receives a loopback endpoint. A process in the same managed OCI network receives a network alias. `routes.*.url` is always the stable browser/local gateway URL.

### 5.4 Repository-local config versus private bindings

The committed recipe can say:

```yaml
inputs:
  stripeTestKey:
    kind: secret
    required: false
    recipients: [api]
```

The user's private Task Monki state says where that value comes from, for example:

- an encrypted Task Monki secret;
- an existing environment variable;
- one named key from a selected `.env` file outside the generation source;
- a future credential-provider integration.

Bindings are keyed by repository identity and input name, not by a repository-committed local path. This keeps the file portable and makes recipient changes approval-relevant.

### 5.5 Resolved plan and generation lock

Task Monki should write private JSON artifacts for machines, not add generated files to the repository:

- canonical recipe digest;
- source commit and dirty-overlay digest for each repository;
- exact commands/cwd/environment key map;
- exact image digests;
- selected toolchain versions;
- graph ordering and readiness deadlines;
- preview-owned managed-resource attachment/binding identities and dynamic application ports;
- scenario;
- secret reference identities/versions, never values.

This private generation lock is reproducibility evidence. Re-running the same source and resolution should be possible when the referenced package registries/images remain available. It does not claim bit-for-bit determinism for arbitrary package scripts.

## 6. Examples

These examples illustrate the proposed contract; exact field names should be finalized through a schema prototype before implementation.

### 6.1 Single-repository web application with PostgreSQL and a worker

This is also the common monorepo case: one root install feeds independently rooted frontend, API, and worker nodes.

```yaml
version: 1

repositories:
  app:
    source: task

inputs:
  stripeTestKey:
    kind: secret
    required: false
    recipients: [api, billingWorker]

resources:
  db:
    type: postgres
    image: postgres:17.5
    ready:
      type: command
      command: [pg_isready, -U, preview]
      timeout: 60s
  cache:
    type: redis
    image: redis:8.0.2-alpine

jobs:
  install:
    repository: app
    cwd: .
    command: [corepack, pnpm, install, --frozen-lockfile]
  migrate:
    repository: app
    cwd: .
    command: [corepack, pnpm, "db:migrate"]
    needs:
      install: succeeded
      db: ready
    env:
      DATABASE_URL: ${resources.db.url}
    retrySafe: false
  seed:
    repository: app
    cwd: .
    command: [corepack, pnpm, "db:seed", --, preview]
    needs:
      migrate: succeeded
    env:
      DATABASE_URL: ${resources.db.url}
    retrySafe: false

services:
  api:
    repository: app
    cwd: apps/api
    command: [corepack, pnpm, "start:preview"]
    needs:
      install: succeeded
      db: ready
      cache: ready
    listen:
      env: PORT
    env:
      DATABASE_URL: ${resources.db.url}
      REDIS_URL: ${resources.cache.url}
      STRIPE_SECRET_KEY: ${secrets.stripeTestKey}
    ready:
      type: http
      path: /health/ready
      timeout: 90s
  web:
    repository: app
    cwd: apps/web
    command: [corepack, pnpm, dev, --, --host, 127.0.0.1]
    needs:
      install: succeeded
      api: ready
    listen:
      env: PORT
    env:
      PUBLIC_API_ORIGIN: ${routes.api.url}
    ready:
      type: http
      path: /
      timeout: 90s

workers:
  billingWorker:
    repository: app
    cwd: apps/api
    command: [corepack, pnpm, "worker:billing"]
    needs:
      install: succeeded
      db: ready
      cache: ready
    env:
      DATABASE_URL: ${resources.db.url}
      REDIS_URL: ${resources.cache.url}
      STRIPE_SECRET_KEY: ${secrets.stripeTestKey}
    restart:
      policy: on-failure
      maxAttempts: 3
    # Exclusive across application generations by default.

routes:
  web:
    service: web
  api:
    service: api

scenarios:
  default:
    setupJobs: [migrate, seed]
    routes: [web, api]
```

The important semantics are:

- the database and cache are stable and unique to the task preview, not the application generation;
- initial/reset migrations wait for authenticated database readiness;
- the initial application waits for approved setup, while normal replacements run only ordinary generation jobs;
- the worker shares preview-owned data, has no public route, and is exclusive during replacement by default;
- browser code receives a stable API URL;
- ordinary application replacement does not run migration or seed;
- an ambiguous migration or seed crash blocks setup for user action rather than blindly retrying.

### 6.2 Multi-repository frontend task with pinned backend

```yaml
version: 1

repositories:
  frontend:
    source: task
  backend:
    git: ssh://git.example.test/acme/backend.git
    revision: 8cc92ab4e86c23a8e9a2ab83c91927dbcfbb8bf1

resources:
  db:
    type: postgres
    image: postgres:17.5

jobs:
  installFrontend:
    repository: frontend
    command: [corepack, pnpm, install, --frozen-lockfile]
  installBackend:
    repository: backend
    command: [bundle, install, --deployment]
  migrate:
    repository: backend
    command: [bundle, exec, rails, "db:migrate"]
    needs:
      installBackend: succeeded
      db: ready
    env:
      DATABASE_URL: ${resources.db.url}
    retrySafe: false
  seed:
    repository: backend
    command: [bundle, exec, rails, runner, script/preview_seed.rb]
    needs:
      migrate: succeeded
    env:
      DATABASE_URL: ${resources.db.url}
    retrySafe: false

services:
  api:
    repository: backend
    command: [bundle, exec, rails, server, -b, 127.0.0.1]
    needs:
      installBackend: succeeded
      db: ready
    listen:
      env: PORT
    env:
      DATABASE_URL: ${resources.db.url}
    ready:
      type: http
      path: /up
  web:
    repository: frontend
    command: [corepack, pnpm, dev, --, --host, 127.0.0.1]
    needs:
      installFrontend: succeeded
      api: ready
    listen:
      env: PORT
    env:
      VITE_API_ORIGIN: ${routes.api.url}
    ready:
      type: http
      path: /

routes:
  web: { service: web }
  api: { service: api }
```

The frontend task's dirty overlay is captured as the `frontend` source. The backend is checked out at the exact commit in a private repository cache/workspace. A user-local override may select another Task Monki backend task snapshot, but that override must be explicit and the generation must record its commit/overlay digest. “Use latest backend main” is resolved to a commit once per generation; it must not move while the preview is running.

### 6.3 Backend task that needs a frontend and an attached identity service

```yaml
version: 1

repositories:
  backend:
    source: task
  frontend:
    git: https://github.com/acme/frontend.git
    revision: 3f871a126c2f04f8b61c1a9e3c921557cb39e1e6

inputs:
  identityUrl:
    kind: variable
    required: true

resources:
  identity:
    type: attached-http
    url: ${inputs.identityUrl}
    ready:
      type: http
      path: /.well-known/openid-configuration

services:
  api:
    repository: backend
    command: [go, run, ./cmd/api]
    needs:
      identity: ready
    listen:
      env: PORT
    env:
      IDENTITY_ISSUER: ${resources.identity.url}
    ready:
      type: http
      path: /ready
  web:
    repository: frontend
    command: [corepack, pnpm, dev, --, --host, 127.0.0.1]
    needs:
      api: ready
    listen:
      env: PORT
    env:
      VITE_API_ORIGIN: ${routes.api.url}
    ready:
      type: http
      path: /

routes:
  web: { service: web }
  api: { service: api }
```

Task Monki verifies the attached identity endpoint but does not claim to own, migrate, restart, or clean it up.

### 6.4 Existing Compose stack

```yaml
version: 1

repositories:
  app:
    source: task

resources:
  stack:
    type: compose
    repository: app
    file: compose.preview.yaml
    profiles: [preview]
    services: [db, redis, api, web, worker]
    exports:
      web:
        service: web
        containerPort: 3000
      api:
        service: api
        containerPort: 8080
    ready:
      api:
        type: http
        path: /health/ready
      web:
        type: http
        path: /

routes:
  web: { resource: stack, export: web }
  api: { resource: stack, export: api }
```

Task Monki assigns the project name and runtime override. The repository continues to own the service topology. Task Monki owns approval, project identity, exported routes, observed readiness, and cleanup.

## 7. Data, migrations, seeds, environment, and secrets

### 7.1 Data lifetime

Managed data has one Task Monki-owned lifetime: the task preview. `scope: generation`, `data: generation`, and equivalent behavior are prohibited. One logical managed resource maps to one stable container/volume/credential/binding authority while Task Monki is running. Application generations attach to it and can be pruned independently.

Attached resources remain user/environment owned; Task Monki stores only a binding and readiness result. Generation-local scratch files are application runtime output, not managed data and not a substitute for a managed-resource record.

The initial persistence boundary is intentionally narrower than the preview record model:

- application replacement preserves preview-owned resources;
- explicit Stop Preview, task deletion, and graceful Task Monki shutdown clean them;
- restart reconciliation verifies and cleans exact survivors without adopting them;
- cleanup uncertainty is `CLEANUP_INCOMPLETE`;
- durable reuse after Task Monki restart waits for the private credential design.

Reset is a serialized replacement of one preview-owned logical resource. Before mutation Task Monki resolves the current recipe/scenario, validates the current execution digest and approval, and verifies the active application and exact managed-resource authority. It then stops every consumer of the target and refuses to proceed on any `CLEANUP_INCOMPLETE` result. Only the exact selected resource is deleted; unrelated resources remain unchanged. Task Monki creates a new container, volume, credential, port, URL, and authority record, runs approved setup, restarts the complete application, and attaches routes only after the complete graph is ready. Repeated or alternating resets use no adoption/handoff state.

Death, failed health, or loss of ownership of any required managed resource invalidates every consuming generation's readiness. The initial policy fails the complete active generation, detaches all its routes, and begins verified cleanup. Selective route degradation is deferred until explicitly independent preview subgraphs exist.

Resource type should determine the implementation, while preserving the same lifecycle contract:

- A future managed SQLite adapter must use a preview-owned recorded file/directory. A generation-private SQLite file is merely generation output and cannot claim the managed-data lifecycle.
- PostgreSQL and Redis are the first fully tested managed container types because they cover relational data and cache/queue-like dependencies.
- MySQL, MongoDB, RabbitMQ, NATS, Kafka-compatible services, object-store emulators, and search engines can initially use the constrained generic OCI resource. Task Monki must not claim type-specific reset/snapshot semantics until it has a tested adapter.
- A custom supporting daemon is a normal native service, constrained OCI resource, Compose member, or attached resource depending on repository configuration.
- An externally hosted development database is always attached. Task Monki checks it and can run explicitly approved jobs against it, but it cannot promise isolation, reset, rollback, or cleanup.

### 7.2 Migration rules

- Migration is a finite job, not a service startup side effect.
- It depends on database readiness and source/toolchain preparation.
- It runs once when the preview-owned resource is first created and again only after explicit reset.
- Completion is recorded with exit code, timestamps, command digest, source digest, and target resource identity.
- A failed migration blocks dependent services.
- An ambiguous migration—Task Monki lost contact before observing exit—does not automatically rerun unless `retrySafe: true` is explicit.
- Ordinary application replacement never runs a migration automatically. A future explicit replacement migration requires separate approval and must warn that it can affect the still-active old generation.
- Task Monki never runs a down migration automatically during cleanup or rollback.

### 7.3 Seed and scenario rules

Seeds should be named scenario jobs, not an inferred `db:seed` convention. A recipe can offer `empty`, `default`, `large`, or domain-specific scenarios. Each scenario selects seed jobs and required inputs.

Like migrations, seeds are not assumed idempotent. They run after migration during initial managed-resource setup and explicit reset only. There is no `everyGeneration` automatic seed mode. Ambiguous non-retry-safe setup remains blocked from automatic rerun.

Do not seed production-derived data by default. Dataset import should later be a typed input with provenance, checksum, size, and retention policy.

### 7.4 Environment assembly

Build each node's environment from a small, deterministic allowlist:

1. Task Monki runtime essentials such as `PATH`, home/temp location, locale, and certificate variables;
2. toolchain adapter output;
3. recipe literal values;
4. typed resource/service/route references;
5. approved private variable and secret bindings;
6. Task Monki metadata such as preview/generation IDs where documented.

Do not inherit the entire Electron process environment. That leaks unrelated credentials and makes runs machine-history dependent. Record environment key names and value-source identities in the generation; hash nonsecret resolved values when useful. Never persist secret plaintext in the generation or logs.

`.env` handling must be explicit. Task Monki may import named keys from a user-selected file into private bindings, but it should not copy ignored `.env` files into the execution workspace or automatically expose every key to every process.

### 7.5 Secret storage and injection

On macOS, Electron `safeStorage` uses Keychain-backed encryption and protects stored content from other users/apps without user override; the newer asynchronous API is recommended because it is nonblocking and supports rotation and temporary unavailability ([Electron `safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage)). Task Monki can use this for local encrypted values while keeping only ciphertext and binding metadata in its store.

Injection rules:

- resolve only immediately before starting the named recipient;
- pass directly in the child environment where possible;
- for a CLI that requires an env file, create a mode-0600 file in the private runtime directory and delete it after the CLI has consumed it or the resource stops;
- never place secret values in command arguments, recipe files, generated source, stable URLs, or approval text;
- redact exact known values and common encoded forms from bounded logs, while acknowledging that redaction is not a hard security boundary;
- avoid giving build jobs runtime secrets unless declared; prefer BuildKit secret mounts for later image builds;
- changing recipients or the source of a binding invalidates approval; rotating a value under the same approved binding creates a new generation resolution but need not reapprove the command graph.

### 7.6 Local network boundary

All Task Monki-owned host ports bind to loopback. Container publication must include `127.0.0.1`; Docker otherwise publishes to all interfaces by default. Attached LAN/cloud endpoints are separately visible in the plan. Version 1 should not expose previews to the LAN.

## 8. Deterministic execution and approval

### 8.1 Discovery versus authority

Detection may inspect:

- package-manager lockfiles and scripts;
- common framework files;
- Dockerfile/Compose/Dev Container/Devbox configuration;
- conventional health endpoints;
- Railpack's generated build plan.

Detection produces a candidate recipe or a diff to an existing recipe. It never starts a command. This is the most important hosted-platform pattern to adapt: helpful defaults with an explicit repository/configuration override.

### 8.2 Canonical execution digest

Approval should cover a canonical, path-normalized plan containing:

- repository origins and revision policies;
- executable, arguments or shell strings, cwd, and node type;
- dependency graph and restart/retry behavior;
- image references and requested pull policy;
- mounts and writable paths;
- managed-resource authority, attached-resource bindings, and generation attachments;
- host/network access, exported ports, routes, and Compose capabilities;
- environment key/value-source map;
- secret input names and recipients;
- resource and startup limits;
- long-running-node overlap policy, including any explicit `overlap: safe` declaration;
- setup/reset scenario and destructive mutation authority.

The digest excludes source-file content and dynamically allocated port numbers. Otherwise every ordinary code change would require approval. It includes changes that alter execution authority.

### 8.3 Reapproval matrix

| Change | New generation | Reapproval |
|---|---:|---:|
| Application source changes only | Yes | No |
| Companion repo resolves to a new commit under an already approved revision policy | Yes | No, but show revision change |
| Command, shell, cwd, lifecycle hook, or job order changes | Yes | Yes |
| New image or changed mutable-tag digest | Yes | Yes for first use of new digest/policy |
| New secret value under same binding | Yes/restart | No |
| Secret recipient or binding source type changes | Yes | Yes |
| New host path, device, privileged mode, host network, or non-loopback port | Yes | Yes |
| Setup/reset scenario changes | Yes | Yes before any mutation |
| `overlap: safe` added or removed | Yes | Yes |
| Attached endpoint host changes | Yes | Yes |
| Dynamic loopback port changes | No by itself | No |

### 8.4 Determinism controls

- Require exact source snapshots per generation.
- Prefer frozen package-manager installs when a lockfile exists.
- Record runtime/package-manager versions; use existing repository version files through toolchain adapters.
- Resolve image tags to digests and retain the digest in evidence.
- Give all graph nodes deterministic IDs and topological ordering.
- Use one preview-owned managed resource per logical resource and record generation attachments separately.
- Separate cache directories from source and key caches by toolchain, lockfiles, recipe digest, platform, and architecture.
- Never treat a cache as evidence that a job succeeded; record the actual job result.
- Record detection tool/version when a plan was generated by Railpack or another detector.

Reproducibility is graded, not binary. A native host run with a frozen lockfile and pinned runtime is reasonably reproducible but not equivalent to a content-addressed image. The generation report should state which inputs were pinned, mutable, attached, or host-provided.

## 9. Stable URLs, ports, and concurrent previews

### 9.1 Gateway design

Run one Task Monki-owned HTTP reverse proxy on a persisted, configurable high port. Give each route a hostname such as:

```text
http://web.<preview-key>.preview.localhost:4123/
http://api.<preview-key>.preview.localhost:4123/
```

RFC 6761 requires name resolvers to treat `localhost` names as loopback and says applications should recognize names ending in `.localhost.` as such ([RFC 6761, section 6.3](https://www.rfc-editor.org/rfc/rfc6761.html#section-6.3)). Subdomains therefore avoid editing `/etc/hosts` and let the gateway route by `Host` header.

The gateway must support:

- HTTP/1.1 keep-alive;
- WebSocket upgrade;
- streaming/SSE without response buffering;
- request and upstream timeouts appropriate for development;
- target replacement without changing the public route;
- a route-unavailable response while a new generation is starting;
- correct forwarding headers and original host;
- bounded access/error logs.

HTTP is the right version-1 default. Local HTTPS requires a local CA and trust-store installation; tools such as Caddy can automate local certificates but may prompt for trust/admin changes ([Caddy local HTTPS](https://caddyserver.com/docs/automatic-https#local-https)). That is unnecessary authority for a loopback-only preview. Add opt-in HTTPS later when secure-cookie or browser API behavior requires it.

### 9.2 Stable route identity

Route hostnames derive from a persisted preview ID and route name, not generation ID or internal port. When generation B is ready, the gateway atomically changes the target from generation A to B. If B fails, A can remain routed until the user stops it or explicitly selects the failure.

The gateway port is a per-install setting. On startup Task Monki attempts to reclaim it. If another process owns it, Task Monki selects a new port and persists it; route hostnames remain stable but full origins change because the port changed. Truly portless `http://...localhost` requires owning port 80, and portless HTTPS requires 443 plus certificate trust; both are deferred.

### 9.3 Internal ports

Every concurrently running native service must accept an injected port through a declared environment variable or argument. Task Monki asks the OS for an unused loopback port and passes it to the service. Node documents that listening on port `0` asks the OS to assign an unused port, retrievable after binding ([Node `net.Server.listen`](https://nodejs.org/api/net.html#serverlistenport-host-backlog-callback)). Because most arbitrary child applications cannot inherit Task Monki's pre-bound socket, there is a small release-to-bind race; the supervisor should retry allocation/start on an observed address-in-use failure within a strict limit.

For OCI resources, publish the known container port to a dynamic loopback host port and inspect the actual mapping. Never rely on fixed common host ports such as 5432 or 6379.

Applications that require a hard-coded port are marked non-concurrent. Task Monki can run one after a conflict preflight, but it must not silently kill the existing owner.

### 9.4 Namespacing

Every application generation gets unique:

- runtime directory and control socket;
- process groups and log streams;
- Compose project name;
- loopback target ports;
- application ownership labels.

Every task preview gets unique stable managed-resource network, containers, volumes, credentials, loopback bindings, and reserved ownership labels. Those identities remain unchanged across ordinary application-generation replacement. Stable routes and managed-resource authority are cross-generation identities; attachments never transfer ownership.

### 9.5 Cross-context networking

Use context-aware references:

- native app → OCI database: dynamic `127.0.0.1:<host-port>`;
- managed container consumer → preview-owned resource: preview network alias and container port, without ownership transfer;
- browser → app: stable gateway route;
- native service → native service: direct loopback origin or stable gateway route, as requested;
- container → native service: route through an engine-supported host gateway only after a capability probe; otherwise reject that graph or containerize the caller.

Avoid making `host.docker.internal` a universal assumption because alternative engines differ. The plan resolver must know the execution context of both producer and consumer.

### 9.6 macOS constraints

- Native processes have the best filesystem/startup behavior and should be preferred for application code.
- Docker Desktop, Colima, and Podman all place Linux containers behind a VM on macOS; first pulls and VM cold starts are material.
- Apple Silicon requires multi-architecture images or explicit emulation. The resolved plan records host architecture, requested platform, and actual image platform.
- Bind mounts into a Linux VM can be slower and behave differently from native filesystem access. Prefer image copies or named volumes for containerized build/data; the default native app path avoids this issue.
- The OCI adapter must honor the selected Docker context/socket rather than assuming `/var/run/docker.sock`.
- Do not start or mutate a user's container VM automatically. Report “engine installed but unavailable” distinctly from “no engine installed.”
- Keychain access can prompt or be temporarily unavailable; secret resolution belongs in the main-process control plane before starting recipients.

## 10. Validation prototypes

The architecture has several assumptions that should be tested with thin vertical prototypes before schema and storage contracts harden.

### Prototype A — native graph and stable gateway

Build a disposable fixture with Vite web, Node API, and worker.

Validate:

- install job runs once;
- dynamic ports permit ten concurrent previews;
- HTTP, WebSocket, and SSE work through `.localhost` host routes;
- generation B can become ready and replace A without URL change;
- failed B leaves A routed;
- routed stateless services may overlap during readiness, while workers remain exclusive by default;
- explicit `overlap: safe` permits a deliberate dual-worker fixture and changes approval authority;
- exclusive-worker activation failure restores and reverifies the old complete graph or fails/detaches it without leaving two consumers running;
- stopping uses reverse dependency order;
- logs remain bounded under noisy output.

Success criterion: ten parallel generations start without port collision or cross-routing, and app/renderer restart does not lose ownership.

### Prototype B — managed PostgreSQL/Redis through Docker CLI

Validate on Docker Desktop and Colima on Apple Silicon and Intel if available:

- capability probe and context selection;
- loopback-only dynamic publication;
- image pull progress and cancellation;
- health/readiness distinct from container-running state;
- stable preview-owned credentials/network/container/volume IDs across A1 → A2;
- authenticated PostgreSQL/Redis behavior before and after replacement;
- initial/reset migration and seed ordering, with no setup jobs on normal replacement;
- post-ready container death invalidating the complete active generation;
- exact cleanup after forced Task Monki termination;
- recovery from a stale ledger, deleted container, and container created but not yet recorded, always by cleanup rather than adoption.

Success criterion: exactly one container exists per logical preview resource, no unrelated object is touched, and reconciliation reaches stopped or cleanup-incomplete without adopting a survivor.

### Prototype C — ambiguous job completion

Kill Task Monki or the preview supervisor during migration and seed commands.

Validate:

- observed successful setup completion can be recorded only while the owning live operation remains unambiguous; restart reconciliation does not adopt a managed resource;
- unknown completion is not reported as success;
- non-retry-safe jobs stop for intervention;
- retry-safe jobs can resume once with recorded attempt identity;
- service nodes never start on an ambiguous prerequisite.

Success criterion: no test can produce “Ready” without locally observed prerequisite success.

### Prototype D — Process Compose versus internal supervisor

Implement the same native fixture through:

1. an extension of current `ProcessSupervisor` plus a small generation supervisor;
2. generated private Process Compose config and its API.

Measure:

- bundled size and installation/update burden;
- cold start and ten-preview memory/CPU;
- process-tree cleanup after normal stop, supervisor crash, and Task Monki crash;
- readiness/restart expressiveness;
- log streaming and bounding;
- UDS/API reconnection reliability;
- ability to represent Task Monki node/attempt identities without lossy mapping.

Decision criterion: use Process Compose only if it materially reduces lifecycle code while preserving durable ownership and acceptable packaging. The public recipe must remain unchanged either way.

### Prototype E — source preparation

Test repositories with:

- dirty tracked files;
- untracked non-ignored source files;
- ignored `.env` and build output;
- large monorepos;
- symlinks inside and outside the repository;
- submodules;
- Git LFS pointers;
- concurrent AI edits during preparation.

Compare APFS clone/copy, manifest-driven copy, and direct-worktree compatibility mode.

Success criterion: the generation manifest exactly explains what ran, external symlink/secret content does not enter by accident, and preparation remains fast enough for the preview interaction.

### Prototype F — multi-repository resolution

Use a frontend task, pinned backend repository, PostgreSQL, migration, and seed.

Validate:

- private clone cache and exact checkout;
- authentication failure without credential leakage;
- branch/ref resolution to immutable SHA;
- local Task Monki task override with dirty-overlay digest;
- one companion revision changing while the current generation remains stable;
- cleanup without modifying any registered source repository.

Success criterion: every running source tree maps to an immutable manifest entry and no “latest” ref moves underneath a generation.

### Prototype G — Compose passthrough corpus

Run a repository sample containing:

- profiles;
- fixed published ports;
- health checks;
- bind mounts;
- external networks/volumes;
- privileged/device/host-network requests;
- variable interpolation and multiple Compose files;
- build contexts outside the selected repository.

Validate normalized-plan approval, generated override behavior, project isolation, dynamic route export, cancellation, and exact cleanup. Docker Compose's project name can isolate repeated deployments, but capability-bearing configuration still needs inspection ([Compose application model](https://docs.docker.com/compose/intro/compose-application-model/)).

Success criterion: safe cases run concurrently; dangerous or nonportable cases are blocked or separately approved; no repository Compose file is rewritten.

### Prototype H — detection quality

Create a corpus of representative Node, Python, Ruby, Go, and Rust repositories, including monorepos. Compare Task Monki heuristics with Railpack's inspectable plan.

Measure:

- correct root/install/build/start suggestion;
- false-positive destructive commands;
- port/readiness inference quality;
- time to candidate plan;
- number of manual corrections;
- behavior with missing lockfiles or multiple package managers.

Success criterion: detection only accelerates recipe creation. Unsupported or ambiguous cases remain clearly incomplete rather than auto-executing a guess.

### Prototype I — secrets and environment

Validate:

- asynchronous `safeStorage` round-trip and rotation behavior;
- recipient-scoped injection;
- child, container, and Compose env delivery;
- absence from command lines, generated source, plan artifacts, crash reports, and ordinary logs;
- redaction under split/chunked log output;
- behavior when Keychain is locked or unavailable;
- secret rotation without graph reapproval.

Success criterion: no plaintext secret is persisted by Task Monki and a missing/locked binding fails before its recipient starts.

### Prototype J — resource and performance budget

Measure on a representative Apple Silicon Mac:

- gateway plus idle supervisor overhead;
- one, five, and ten native previews;
- one, five, and ten PostgreSQL resources;
- warm/cold install and image-pull times;
- log and protocol-store growth over eight hours;
- CPU when all previews are idle;
- disk reclaimed after cleanup.

Use the results to choose default concurrent-preview limits, idle suspension behavior, per-generation log limits, and resource warnings. Unsupported CPU/memory/PID enforcement must be rejected before approval or shown explicitly as unenforced; disk quota remains advisory where unsupported. Do not invent these limits before measuring.

## 11. Phase 3 prototype transition

The existing Phase 3 generation-scoped stored shape and recipe behavior are unshipped prototype code. Replace them without a storage migration, recipe compatibility layer, or dual managed-data lifecycle. This is a one-time pre-release decision, not a precedent for discarding released schemas.

Retain the explicit Docker context/endpoint/engine identity, exact IDs, loopback publication, and Task Monki reserved labels. Remove generation-owned managed data, volume adoption/handoff, per-generation credential generation, and automatic replacement setup. Do not patch `retainedForReset` or `adoptedGenerationVolumes`; reimplement from preview-owned authority and generation attachments.

Sequence the replacement as PostgreSQL authority/authenticated reuse, Redis plus post-ready supervision, overlap-safe application replacement, reset/setup scenarios, then real crash/pruning/inherited-label/limit/alternative-context hardening.

## Final recommendation

The implementation should begin with the Task Monki-owned recipe, resolved generation, service DAG, stable gateway, and durable resource ledger. Those are invariant across every runtime choice.

For the actual runtime, use:

1. **native supervised commands** for application services, jobs, and workers;
2. **OCI containers** for versioned stateful dependencies;
3. **Compose passthrough** for repositories that already define a full stack;
4. **attached resources/application** when Task Monki cannot safely own the dependency;
5. **Railpack/Buildpacks, Dev Containers, Devbox, alternative OCI engines, and microVMs** as later adapters, not prerequisites.

This architecture answers the practical question directly: when the user clicks Preview, Task Monki resolves an approved repository recipe, creates or verifies stable preview-owned managed resources, runs initial setup only when required, prepares an identified application generation, enforces stateless-versus-exclusive overlap, verifies the complete graph, and points a stable local URL at it. Ordinary application replacement does not restart the database/cache or rerun migration/seed, and Task Monki can still explain and clean exactly what it owns.
