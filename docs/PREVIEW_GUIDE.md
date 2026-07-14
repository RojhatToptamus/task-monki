# Preview Guide

Date: 2026-07-14

Preview runs an approved repository-defined application locally and gives it a
stable browser address. This guide explains the current user-facing behavior
and the supported `.taskmonki/preview.yaml` format. For implementation and
security boundaries, read the
[Preview Architecture](architecture/PREVIEW_ARCHITECTURE.md).

## Before you start

You need:

- a task with an active Task Monki worktree;
- `.taskmonki/preview.yaml` in that repository, authored manually or accepted
  from an agent-generated draft;
- host executables named by the recipe available on `PATH`, with
  repository-local dependencies prepared by explicit recipe jobs;
- Docker Desktop or another verified Docker-compatible context only when the
  recipe uses managed PostgreSQL/Redis or the Compose adapter;
- macOS `safeStorage` availability when the native recipe uses private inputs.

Compose previews additionally require `docker compose config
--no-env-resolution`. Task Monki checks the feature and refuses the plan before
mutation when it is missing.

Preview is independent of the task's board phase and AI run. Starting,
replacing, opening, stopping, or failing a Preview does not move the task
between Backlog, In Progress, Review, or Done.

### Setting up a missing recipe

When **Check preview** confirms that `.taskmonki/preview.yaml` is missing, the
Preview workspace offers **Generate with agent** and **Write manually**.

Generation opens a review modal immediately and shows progress while an
ephemeral read-only agent inspects a bounded sanitized evidence bundle. Likely
secret-bearing, binary, generated, dependency/cache, and oversized content is excluded.
The agent cannot write the worktree and is instructed not to run the app,
tests, scripts, Docker, or network services.

For supported framework versions, Task Monki adds narrow compatibility facts
to the evidence bundle. For example, a Next.js script that pins a port or
enables HTTPS can receive a reviewable Preview-only HTTP command using the
dynamically allocated `PORT`; the YAML comment explains that deviation. Task
Monki does not guess a rewrite for unknown framework versions or arguments.
For a root npm project with a safely validated `package-lock.json`, the same
facts require an explicit lockfile installation job and success dependency so
the isolated captured source does not depend on the live worktree's ignored
`node_modules` directory.

The modal displays the complete YAML alongside evidence, assumptions,
omissions, and unresolved decisions. You may edit, regenerate, discard, or
close. Close and Discard do not change the repository. Only **Accept & save
recipe** exclusively creates `.taskmonki/preview.yaml`; it refuses to overwrite
a file created while the draft was open, then runs the normal Preview parser
and check. Acceptance never approves a plan or starts Preview.

See [Preview Recipe Generation](architecture/PREVIEW_RECIPE_GENERATION.md) for
the support contract, inspection boundary, transient lifecycle, and exact
write rules.

## The Preview surfaces

### Overview card

The task Overview contains a compact Preview card. It shows the current state,
the primary route when one is available, and the recommended action:

- **Check preview** loads and validates the recipe.
- **Approve plan** opens the full Preview workspace so you can review exact
  execution and cleanup authority.
- **Check inputs** or **Configure inputs** opens the workspace when private
  values need verification or entry.
- **Start preview** creates the first generation.
- **Open current** opens the current primary route.
- **Replace** starts a candidate for changed source while preserving the
  current native preview until cutover.
- **Details** always opens the full Preview workspace.

### Preview workspace

The workspace is the decision and operations view. Depending on state, it
shows:

- the selected scenario and execution status;
- the exact execution plan, approval authority, advisories, and cleanup
  contract;
- application and setup attempts with bounded stdout/stderr logs;
- current and candidate generations;
- stable routes;
- preview-owned managed data or Compose project data;
- attached public dependencies and startup-check evidence;
- private input status and declared recipients;
- guarded actions such as Retry setup, Reset data, Cancel replacement, and
  Stop Preview & Delete Data.

Approval reviews capabilities, not source content or secret values. Read every
command, working directory, dependency, image, public target, recipient,
readiness/liveness policy, and destructive cleanup statement before approving.

## Recipe location and parsing rules

Create exactly:

```text
.taskmonki/preview.yaml
```

The file must be a regular, non-symlink file inside the task worktree and start
with `version: 1`. Identifiers use lowercase letters, digits, and hyphens, start
with a letter, and are at most 48 characters. Environment keys use uppercase
letters, digits, and underscores.

The parser is intentionally strict. Unknown fields, duplicate keys, aliases,
anchors, merge keys, custom tags, graph cycles, escaping paths, shell-style
command strings, and invalid references fail instead of being guessed.
Commands are argv lists such as `[node, server.mjs]`; Task Monki does not invoke
a shell to interpret a command string.

## Minimal native recipe

This complete recipe runs one local service, allocates its port, waits for an
HTTP endpoint, and exposes one stable primary route:

```yaml
version: 1

services:
  web:
    command: [node, server.mjs]
    env:
      NODE_ENV: development
    ports:
      http: { env: PORT }
    ready:
      type: http
      port: http
      path: /ready
      timeoutSeconds: 30

routes:
  app:
    service: web
    port: http
    primary: true
```

Task Monki captures repository source, injects a dynamic loopback port into
`PORT`, and routes each public route through a stable single-label hostname such
as `tm-<route-identity>.localhost`. The identity is derived from the task and
route, so replacement generations retain one truthful browser, HTTP, and
WebSocket origin without putting generation or process identity in the URL.
The process runs as your local user from the captured workspace, not from the
live worktree.

## Native recipe building blocks

### Jobs

Jobs are finite commands. A generic job participates in every scenario and may
be required with `needs: { job-id: succeeded }`.

Dependency preparation belongs in a generic job because every captured source
generation starts without ignored dependency directories. For a validated npm
lockfile, an agent-generated Next.js recipe uses this shape:

```yaml
jobs:
  install:
    # Installs exactly from package-lock.json inside this captured Preview generation.
    # npm may run repository and dependency lifecycle scripts.
    command: [npm, ci, --no-audit, --no-fund]

services:
  web:
    command: [./node_modules/.bin/next, dev, --turbopack, --hostname, 127.0.0.1]
    needs: { install: succeeded }
    ports: { http: { env: PORT } }
    ready: { type: tcp, port: http }
```

`npm ci` installs exactly from the lockfile and may run standard lifecycle
scripts from the repository and its dependencies. Review that command as local
code execution. Task Monki does not separately duplicate those lifecycle
scripts, silently run `npm install`, or let `npm exec`/`npx` fetch a missing
runtime package. A custom package script becomes another job only when the
repository provides evidence that it is required.

Migration and seed jobs are selected through scenarios and must declare
`retrySafe`. A seed must depend on a migration succeeding. These setup jobs may
use preview-owned managed resources, but cannot use attached external
dependencies.

Task Monki runs migration/seed setup when a managed resource is first created
or explicitly reset. Ordinary source replacement does not rerun setup.

### Services

Services are long-running, require at least one generated port and one
readiness probe, and default to `critical: true`. They may depend on jobs,
resources, services, workers allowed by the graph rules, or checked
attachments.

### Workers

Workers are long-running but need not have ports. They default to exclusive
replacement: the old worker is verified stopped before its candidate starts.
Use `overlap: safe` only when concurrent old/new instances are genuinely safe;
that choice is approval authority.

### Dependencies

Use:

- `succeeded` for a finite job;
- `ready` for a service, worker, managed resource, or attachment with a
  declared check.

An environment reference does not create an implicit dependency. A managed
resource URL requires an explicit `ready` dependency. An attached endpoint
reference deliberately does not: add `needs: ready` only when startup must
observe the external target.

### Readiness, liveness, and restart

Readiness may be:

- HTTP against a named generated port and absolute path;
- TCP against a named generated port;
- argv with its own cwd, command, timeout, and optional explicit environment.

Liveness reuses one of those probes and adds `intervalSeconds` and
`failureThreshold`. It is continuous after readiness. Restart policy is
bounded: `never`, `on-failure`, or `always`, with `maxRestarts` no greater than
8 and bounded `backoffMs`.

Argv probes receive only their own `env` map plus the safe built-in environment
and generated ports. They do not inherit the service or worker's entire
environment.

### Routes and origins

Every recipe needs at least one route and exactly one `primary: true` route.
Routes target critical services and declared ports. Services and workers can
receive:

- a `service-origin` after declaring that service `ready`;
- a stable `route-origin` for one of the recipe's routes.

### Managed PostgreSQL and Redis

Native recipes may declare typed `postgres` and `redis` resources. Defaults
are `postgres:17-alpine` and `redis:7-alpine`; explicit images and supported
CPU/memory/PID limits become approval authority. `diskMb` is displayed as
advisory because portable Docker local-volume quotas are not guaranteed.

Use typed `postgres-url` and `redis-url` environment values. Task Monki creates
generated credentials, publishes only to loopback, delivers each URL to its
declared recipient, and keeps the resource stable across application
generations.

### Scenarios

Scenarios choose migration/seed jobs and managed resources. Generic jobs and
all services/workers remain active. When more than one scenario exists,
`defaultScenario` is required. Selecting another scenario changes approval
authority because it changes setup and data capability.

## Complete native example

This complete example demonstrates private inputs, managed data, setup jobs,
services, a worker, all four attachment types, a local public binding, explicit
one-shot attachment checks, liveness/restart, routes, and scenarios:

```yaml
version: 1

inputs:
  api-token:
    type: private
    label: Accounts API token
  reporting-password:
    type: private
    label: Reporting database password
  cache-password:
    type: private
    label: Shared cache password

attachments:
  accounts:
    type: http
    target:
      type: endpoint
      scheme: https
      host: accounts.internal
      port: 443
      basePath: /v1
    check:
      path: /healthz
      timeoutSeconds: 10
  smtp:
    type: tcp
    target:
      type: endpoint
      host: 127.0.0.1
      port: 2525
  reporting:
    type: postgres
    target:
      type: endpoint
      host: reporting.internal
      port: 5432
      database: analytics
      username: task_monki_reader
      tls: system-verified
    credentials:
      passwordInput: reporting-password
    check:
      timeoutSeconds: 15
  shared-cache:
    type: redis
    target: { type: local }
    credentials:
      passwordInput: cache-password

resources:
  cache:
    type: redis
    image: redis:7-alpine
  database:
    type: postgres
    image: postgres:17-alpine
    database: preview_app
    limits:
      cpus: 1
      memoryMb: 512
      diskMb: 2048
      pids: 256

jobs:
  migrate:
    role: migration
    retrySafe: false
    command: [node, scripts/migrate.mjs]
    needs: { database: ready }
    env:
      DATABASE_URL: { type: postgres-url, resource: database }
  seed:
    role: seed
    retrySafe: true
    command: [node, scripts/seed.mjs]
    needs: { migrate: succeeded }
    env:
      SEED_MODE: demo

services:
  api:
    command: [node, apps/api/server.mjs]
    needs:
      migrate: succeeded
      database: ready
      cache: ready
      accounts: ready
      reporting: ready
    env:
      API_TOKEN: { type: private-input, input: api-token }
      ACCOUNTS_ORIGIN: { type: attached-http-origin, attachment: accounts }
      SMTP_HOST: { type: attached-tcp-host, attachment: smtp }
      SMTP_PORT: { type: attached-tcp-port, attachment: smtp }
      REPORTING_URL: { type: attached-postgres-url, attachment: reporting }
      SHARED_CACHE_URL: { type: attached-redis-url, attachment: shared-cache }
      DATABASE_URL: { type: postgres-url, resource: database }
      REDIS_URL: { type: redis-url, resource: cache }
    ports:
      http: { env: API_PORT }
    ready:
      type: http
      port: http
      path: /ready
      timeoutSeconds: 30
    liveness:
      type: http
      port: http
      path: /live
      timeoutSeconds: 5
      intervalSeconds: 10
      failureThreshold: 3
    restart:
      mode: on-failure
      maxRestarts: 2
      backoffMs: 500
  web:
    command: [node, apps/web/server.mjs]
    needs: { api: ready }
    env:
      API_ORIGIN: { type: service-origin, service: api, port: http }
      PUBLIC_ORIGIN: { type: route-origin, route: app }
    ports:
      http: { env: PORT }
    ready:
      type: tcp
      port: http

workers:
  mailer:
    command: [node, workers/mailer.mjs]
    needs: { api: ready }
    env:
      API_ORIGIN: { type: service-origin, service: api, port: http }
      SMTP_HOST: { type: attached-tcp-host, attachment: smtp }
      SMTP_PORT: { type: attached-tcp-port, attachment: smtp }
    ready:
      type: argv
      command: [node, scripts/mailer-ready.mjs]
      timeoutSeconds: 10
      env:
        REDIS_URL: { type: attached-redis-url, attachment: shared-cache }

routes:
  api:
    service: api
    port: http
    primary: false
  app:
    service: web
    port: http
    primary: true

scenarios:
  empty:
    jobs: [migrate]
    resources: [cache, database]
  demo:
    jobs: [migrate, seed]
    resources: [cache, database]

defaultScenario: demo
```

The `accounts` and `reporting` checks run once because `api` explicitly needs
them ready. `smtp` and `shared-cache` are environment-only attachments and
perform no network check. Native restart reuses the generation's bindings and
does not rerun attachment checks.

## Private inputs

Private values are configured after planning and may be missing when you
approve the plan. Missing values block Start, not approval.

In the Preview workspace:

1. Review the input ID and the exact services, workers, jobs, or argv probes
   that receive it.
2. Choose **Set value...** or **Replace...**.
3. Enter the value and choose **Save encrypted value**.
4. To rotate, replace it. New generations use the new revision; a live old
   generation retains its old encrypted revision until verified cleanup.
5. To remove the current value, open its menu and choose **Delete value...**.
   Existing live generations keep their retained revision; future Start is
   blocked.

Values cannot be revealed or exported after submission. They are encrypted by
macOS `safeStorage`, omitted from plan/approval, and delivered only to declared
native recipients. Changing a value does not require reapproval; changing an
input ID, environment key, or recipient does.

### Import one `.env` key

Open **Import one .env key**, enter one exact key, then choose **Choose file and
import**. The key must match `[A-Za-z_][A-Za-z0-9_]*`.

The native picker and parser stay in the main process. Only the explicitly
selected value is encrypted. The renderer never receives the selected path,
file contents, candidate keys, or plaintext. Missing/duplicate keys, unsafe
permissions, symlinks, file races, invalid UTF-8, NUL, multiline values,
interpolation, command substitution, escape evaluation, and oversized input
fail without changing the current revision.

The original `.env` file remains user-owned plaintext. Task Monki does not
modify or delete it.

## Attached dependencies

Attachments are external and strictly non-owned. They can supply public
connection details and, for PostgreSQL/Redis, a private password reference.

| Type | Endpoint fields | Environment references | Optional check |
| --- | --- | --- | --- |
| HTTP | scheme, host, port, basePath | `attached-http-origin` | one GET, no redirects |
| TCP | host, port | `attached-tcp-host`, `attached-tcp-port` | one TCP connect |
| PostgreSQL | host, port, database, username, tls | `attached-postgres-url` | authenticated `SELECT 1` |
| Redis | host, port, database, optional username, tls | `attached-redis-url` | authenticated `PING` |

Declare `check` only when some active node uses `needs: { attachment-id:
ready }`. A dead check is rejected. Environment-only delivery does not claim
availability and performs no network operation.

Checks are one bounded startup observation. There is no post-ready polling.
Later endpoint loss does not stop or mark the Preview degraded; application
behavior and declared native liveness remain responsible.

### Literal and local targets

`target: endpoint` puts a public literal target in repository authority.
Changing it changes the execution digest and requires approval.

`target: { type: local }` declares a task-owned public configuration slot. It
can be bound to the matching endpoint type. An HTTP slot can also bind to
another task's preview route with stable identity:

```json
{
  "type": "task-preview-route",
  "targetTaskId": "task-accounts",
  "routeId": "api",
  "basePath": "/"
}
```

The producer generation and current port are not part of the identity, so
producer replacement preserves consumer approval. Task Monki does not start
the producer. Environment-only delivery may resolve to a stable URL that
returns 503 while the producer is absent; explicit readiness requires its
current route to be active and ready.

The desktop workspace currently displays resolved local bindings and missing
public-target requirements but does not yet include a general target editor.
Repository authors can use literal endpoints today. Task-local binding
operations are available to trusted integrated clients through the
TaskManager service/API; until a desktop editor ships, this is an advanced
integration surface rather than a normal UI flow.

## Compose preview

Use Compose mode when the repository already owns a supported Compose
application and Task Monki should operate it as one project. This complete
recipe exposes two Compose services and one primary route:

```yaml
version: 1

compose:
  files: [compose.yaml]
  projectDirectory: .
  profiles: [preview]
  rootServices: [web, api]
  services:
    api:
      ports:
        http: { target: 3001 }
      ready:
        type: tcp
        port: http
        timeoutSeconds: 30
    web:
      ports:
        http: { target: 3000 }
      ready:
        type: http
        port: http
        path: /ready
        timeoutSeconds: 30

routes:
  api:
    service: api
    port: http
    primary: false
  app:
    service: web
    port: http
    primary: true
```

`rootServices` must name services declared under `compose.services`. Each
declared service exposes one or more container target ports; Task Monki chooses
loopback host ports. Routed services require HTTP or TCP readiness.

Task Monki inspects the normalized Compose configuration before approval. It
uses one stable task project and classifies changes as compatible in-place,
restart while preserving verified volumes, or destructive reset required.

### Compose secrets and unsupported authority

Compose cannot receive Task Monki private inputs. Do not add `inputs`,
`attachments`, native `jobs/services/workers`, or managed `resources` to a
Compose recipe; mixed mode is rejected.

Repository `env_file` and file-backed Compose secrets may be used only when
they are static, bounded, non-symlink files captured from the repository.
Their values remain repository-owned and may be durable plaintext. Task Monki
does not copy vault secrets into Compose environment, argv, build inputs, or
temporary host files.

The current Compose adapter rejects source host ports, bind mounts,
environment/external secrets, build secrets or SSH, include/extends/provider,
host namespaces, privileged/device access, scaling, watch, and Compose restart
policy. It also rejects interpolation outside the supported service
environment-value surface. Simplify the Compose configuration or use a
supported native recipe; there is no permissive fallback.

## What each action changes

| Action | Application/runtime effect | Data effect | Approval effect |
| --- | --- | --- | --- |
| Check preview | parse and resolve only | none | finds current matching approval |
| Approve plan | records exact capability digest | none | approves current digest |
| Start preview | creates a candidate, then active generation/project | creates selected managed/project data if absent | requires matching approval |
| Replace | native candidate cutover or serialized Compose activation | native managed data reused; Compose verified volumes retained when compatible | source-only change preserves approval |
| Cancel replacement | aborts and cleans candidate only | preserves active data and current Preview | none |
| Retry setup | reruns explicitly retry-safe failed setup on exact resource | mutates the same managed data | current plan/approval must match |
| Reset data | stops complete consumer and recreates selected managed resource | permanently deletes that resource's data | revalidates current plan/approval |
| Stop Preview & Delete Data | stops/cancels exact Task Monki-owned runtime and detaches routes | permanently deletes managed or owned Compose volumes/networks | approval record may remain but no runtime remains |
| Retry cleanup | re-verifies and cleans recorded residue | deletes only exact verified owners | none |

Stop and Reset never mutate attachments, producer tasks, external Compose
networks/read-only external volumes, images, build cache, repository files, or
user-owned secret files.

## Replacement behavior

### Native

The current active Preview remains open while Task Monki captures and checks a
candidate. Stable routes switch only after readiness. Exclusive workers are
handed off at their guarded boundary. A candidate failure remains visible with
logs and normally leaves the old active route available. **Cancel
replacement** targets only the candidate.

### Compose

Inspection and build happen while current routes remain available. Routes
detach when mutation of the stable project begins. They return only after
Compose and Task Monki readiness pass. A failure after activation begins may
leave the Preview offline with verified volumes preserved; the UI does not
claim that the previous application was restored.

## Failures, recovery, and troubleshooting

### No Preview available

Use **Generate with agent** to prepare a reviewable evidence-backed draft, or
**Write manually** to open the task worktree. Confirm the accepted/manual file
is a regular `.taskmonki/preview.yaml`, then use **Check preview** after changing
it.

### Approval required again

An authority-bearing value changed: command/cwd, dependency, route, scenario,
recipient, public attachment target/check, image/limit/engine, restart/overlap,
Compose inspection, or cleanup scope. Review the new plan rather than trying to
reuse the old digest.

Source edits alone and private-value rotation do not require reapproval.

### Configuration required

- A private input is missing, protection is unavailable, or encrypted storage
  needs recovery. Configure or replace the named value and retry the check.
- An active `target: local` attachment has no public binding. Use a literal
  endpoint or configure the trusted integration binding.

Private blockers cause zero source, generation, native, or OCI side effects
when Start is attempted.

### Readiness failed

Open the relevant attempt's stdout/stderr. Check the exact generated port,
probe path/command, timeout, dependency ordering, installation-job output, and
whether the application listens on loopback. An attachment failure is a
startup observation; verify the target, TLS, and credentials without expecting
Task Monki to repair or restart the external service.

### Setup failed

Use **Retry setup** only when offered and the operation is truly safe to replay.
If completion was ambiguous or a job is non-retry-safe, inspect data manually
or use explicit destructive Reset after accepting data loss.

### Cleanup incomplete or recovery required

Task Monki could not prove exact ownership or termination. Use **Retry cleanup**
after correcting the underlying engine, permission, or process condition. Do
not manually rename recorded containers/directories and expect Task Monki to
adopt them. The safe outcome is retained evidence, not broad deletion.

### Docker/Compose unavailable

Check Docker is running, the selected context is reachable, and requested CPU,
memory, or PID limits are supported. Compose additionally needs
`--no-env-resolution`. Task Monki does not silently switch contexts or weaken
requested limits.

### Private input unavailable

Private inputs require macOS and available Keychain-backed Electron
`safeStorage`. Unlock/repair Keychain and retry. There is no insecure fallback
on unsupported platforms. Public-only native and Compose previews remain
usable.

### Relaunch behavior

Task Monki uses stop-only recovery after a main-process restart. It removes
routes and cleans exact verified surviving native, managed, and Compose runtime
instead of adopting or restarting it. Any uncertainty is shown as cleanup or
recovery state. Renderer reload alone does not restart the main process.

## Current unsupported cases

- mixing Compose with native nodes, managed resources, attachments, or private
  inputs;
- automatic startup or lifecycle coupling for another task's Preview;
- continuous health monitoring of attached endpoints;
- attached dependencies in migration or seed jobs;
- generic OCI resources beyond typed PostgreSQL and Redis;
- agent-generated dependency preparation for package managers other than a
  root npm project with a safely validated `package-lock.json`;
- durable adoption of managed resources after a Task Monki main-process crash;
- multi-repository source composition and Git submodules in native source
  capture;
- shell command strings, unsafe YAML features, broad host filesystem mounts,
  or automatic recipe discovery;
- a claim that recipient-scoped native secrets are isolated from other
  mutually hostile code running as the same OS user.

When a repository needs one of these capabilities, keep it outside Preview or
redesign the recipe within the supported authority. Do not work around a
rejection by moving secret values into `preview.yaml`, argv, or public
environment literals.
