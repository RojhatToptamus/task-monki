# Provider Runtime Smoke Testing

Date: 2026-08-29

`npm run smoke:providers` verifies real provider/model connectivity, selection,
streaming, tool execution, repository mutation, Git evidence, and terminal
lifecycle through `TaskManagerService`. It is intentionally separate from both
the deterministic agent workflow and seeded UI inspection: provider smoke runs
use a caller-supplied disposable Git repository, real runtime discovery, real
Task Monki task/worktree/session/run records, and real provider quota or
credits.

## Prepare a throwaway repository

The harness refuses nested paths, repositories without a commit, dirty
repositories, and repositories with remotes. The no-remote rule deliberately
excludes Task Monki's seeded repository and reduces the chance of testing
against a real clone.

```sh
mkdir /tmp/task-monki-provider-smoke-repo
cd /tmp/task-monki-provider-smoke-repo
git init -b main
git config user.name "Task Monki Smoke"
git config user.email "task-monki-smoke@example.invalid"
printf '# Provider smoke fixture\n' > README.md
git add README.md
git commit -m "Initial throwaway fixture"
```

Run every visible model from every startable runtime:

```sh
npm run smoke:providers -- \
  --repository /tmp/task-monki-provider-smoke-repo \
  --confirm-throwaway \
  --confirm-provider-usage
```

Both confirmations are required. The first acknowledges that Task Monki creates
branches and worktrees in the disposable repository. The second acknowledges
that the command sends a prompt to each selected model and may consume paid
usage.

Use repeatable exact selectors for a focused rerun:

```sh
npm run smoke:providers -- \
  --repository /tmp/task-monki-provider-smoke-repo \
  --runtime grok-acp \
  --model grok-acp:xai/grok-4.6 \
  --timeout-seconds 300 \
  --confirm-throwaway \
  --confirm-provider-usage
```

Run `npm run smoke:providers -- --help` for all options.

## Qualify read-only profiles

Add `--qualify-read-only` to the normal smoke command:

```sh
npm run smoke:providers -- \
  --repository /tmp/task-monki-provider-smoke-repo \
  --qualify-read-only \
  --confirm-throwaway \
  --confirm-provider-usage
```

The command still runs the normal Task smoke for each selected model. Then it
runs one DIRECT Discourse turn for each selected provider profile.

The Discourse prompt requests one write to a unique probe file. It prohibits
approval requests, retries, alternate tools, and alternate paths.

Task Monki attempts the turn only for a profile that advertises a native
read-only policy. The probe qualifies that policy. The report gives the reason
for each unsupported profile.
Normal Tasks remain available for an unsupported read-only profile.
Grok Build 1.0.13 on macOS uses a separate ACP process for read-only work.
Normal Task and Design sessions keep the normal writable process. The
read-only process uses Grok's native sandbox and denies edit, write, and MCP
tools. It also refuses shared-leader routing.

Do not use a temporary-directory repository for the Grok probe. Grok permits
writes to temporary directories and `~/.grok` in this sandbox. Task Monki also
rejects linked worktrees when their Git control directory is in one of these
writable locations. A sandbox warning fails startup.

A qualification passes only when all these conditions are true:

- The DIRECT job and its shared runtime run complete.
- The runtime records `repositoryIntegrity: UNCHANGED`.
- The unique probe file does not exist.
- The source repository remains clean.
- The checked-out ref and `HEAD` remain unchanged.

Codex, OpenCode, Cursor, and Claude use provider controls. These controls are
not operating-system sandboxes. Grok uses a separate process with its native
operating-system sandbox. The independent file and Git checks still detect a
provider that changes the source repository.

If a write occurs, the harness does not erase it. It keeps the changed
repository, runtime records, Discourse records, and `report.json` as evidence.
Inspect that evidence before you remove the state root or the probe file.

## Qualify attachment content

Add `--qualify-attachments` to the normal smoke command:

```sh
npm run smoke:providers -- \
  --repository /tmp/task-monki-provider-smoke-repo \
  --qualify-attachments \
  --confirm-throwaway \
  --confirm-provider-usage
```

The command keeps the normal Task smoke flow. It adds one managed text file to
the same Task when the provider profile supports attachments. The file contains
a new random fact. The prompt does not contain that fact.

The provider must return the fact. The run must also contain the exact ordered
selection and one matching submission for each selected file. Each submission
must use the expected provider transport and correlation kind.

If the selected model supports image input, the command also attaches
`build/provider-smoke-image.png`. The provider must report an unrevealed visual
code, the ordered shapes, and the background color. The report includes the
payload size and the model's effective input modes. Effective support normally
follows ACP negotiation and exact model qualification. It can also include one
exact provider-local exception for a proven false capability flag.

The report stores only path-free selection and submission evidence. It does not
store attachment paths or bytes. A supported qualification fails if the
content result or evidence does not match. An unsupported profile keeps its
normal Task result and records the reason.

The content answer proves that the model used the file. The submission record
proves which Task Monki transport reached provider admission. Inspect the saved
provider journal as independent native request evidence. The journal must keep
the content shape and replace attachment bytes, data URLs, and managed paths.

The report keeps the advertised image flag separate from verified behavior.
It reports `ADVERTISED_FALSE_VERIFIED_TRUE` when an exact image test passes
despite an explicit false flag. It reports
`ADVERTISED_TRUE_VERIFICATION_FAILED` only when text and delivery evidence pass
but image understanding fails. Account, network, timeout, and cancellation
failures keep their exact failure reason. They are not capability evidence.

Task Monki never runs this paid test during normal app use. Both command
confirmations are required. A passing result can justify a reviewed profile
entry. It does not create a persistent qualification cache or update support
automatically.

## What the harness verifies

- Runtime and model discovery use the same registry exposed to the app.
- A selected runtime whose catalog requires explicit activation is discovered
  once before its models are queued. The runtime adapter remains responsible
  for reusing or invalidating its process-local catalog cache.
- `DISCOVERED`, `READY`, and `DEGRADED` runtimes are eligible because
  on-demand runtimes may not become `READY` until their first native session.
- Visible model catalogs are refreshed after each run so models learned during
  native session setup are added to the same smoke pass.
- The lowest recognized advertised reasoning effort is selected. For
  provider-native effort names with no portable ordering, the provider's
  advertised default is preserved when one exists; otherwise the harness omits
  the override instead of guessing an arbitrary, potentially expensive choice.
- Runs are sequential and use a minimal implementation prompt that creates only
  `task-monki-provider-smoke.txt`, containing the
  `TASK_MONKI_PROVIDER_SMOKE_OK` sentinel. When a runtime advertises a
  non-interactive write-capable execution preset, the harness selects the
  least-privileged such preset; otherwise its normal policy remains in force.
- Attachment qualification reuses the normal Task attachment draft and
  adoption flow. It does not create a separate smoke-only file path.
- The attachment report records the runtime version, advertised image flag,
  effective model input modes, qualification result, capability drift, payload
  size, exact path-free selection, and submissions.
- The execution timeout covers task creation, provider session/turn startup,
  execution, and normal post-run evidence. When it expires, or when an
  interaction appears, a separate bounded cancellation window starts. The
  harness sends cancellation once and polls until both the cancellation call
  settles and the run reaches a terminal state; otherwise it stops the matrix
  before another model starts.
- The harness never approves a provider interaction. Any interaction record,
  including one already resolved or declined when the run terminalizes, fails
  that model run.
- A model passes only when its Task Monki run completes, returns the sentinel,
  the exact Git snapshot returned by the explicit post-run refresh is `DIRTY`,
  the sentinel file is a regular file with exact contents and is the only Git
  change, that task worktree's HEAD still equals its recorded base with no
  committed diff or commits ahead,
  and a provider observation or exact adapter resolution attests the requested
  provider, model, and advertised reasoning effort.
- The original throwaway repository's porcelain status, checked-out ref, and
  HEAD are checked after every run. A clean commit, reset, or checkout is still
  detected as a change and stops the pass before another model starts.
- `RECOVERY_REQUIRED` and `LOST` never count as safe containment. The matrix
  stops because those states do not prove that the previous provider process
  or turn can no longer execute.

Some runtimes cannot attest an OS sandbox. The harness therefore uses each
runtime's supported execution policy in an isolated throwaway worktree and
verifies the sole allowed edit independently with Git.
Never point this command at a repository that matters.

## Evidence and cleanup

By default, the harness creates a private temporary state root and prints its
path. `report.json`, the Task Monki store, provider protocol journals, and task
worktrees remain there for diagnosis. Pass `--state-root <empty-path>` when a
stable evidence location is useful.

The report distinguishes `PROVIDER_CONFIRMED` from `ADAPTER_RESOLVED`.
`ADAPTER_RESOLVED` means Task Monki proved the exact provider command or request
it constructed, not that the provider echoed the selection. A successful run
without either form of evidence is `UNATTESTED`, never `PASSED`, and makes the
matrix non-authoritative.

Only provider response, notification, reroute, or recovery-snapshot
observations can produce `PROVIDER_CONFIRMED`. Outbound settings selected by an
adapter are recorded as `TASK_MONKI_RESOLUTION` and remain
`ADAPTER_RESOLVED`, even when they exactly match the request. When both exist,
the provider observation is authoritative over an unacknowledged outbound
resolution. ACP session setup is the narrow sequencing exception: when
`session/new` reports a different initial model and a later
`TASK_MONKI_RESOLUTION` cites the inbound response that acknowledged the exact
configuration mutation on the same server generation, the later selection is
`ADAPTER_RESOLVED`, never `PROVIDER_CONFIRMED`. A subsequent provider settings
observation remains authoritative.

OpenCode uses the same evidence rule for `prompt_async`. Its exact resolution
can fill fields omitted by a provider snapshot only when it cites the inbound
prompt acknowledgement. Later conflicting provider settings remain
authoritative.

Every registered runtime remains in the report, including runtimes that cannot
start. Runtime readiness detail is retained as its skip reason. Every model
observed in a live catalog is likewise marked `PASSED`, `FAILED`, `INTERRUPTED`,
`SKIPPED`, or `NOT_REACHED`, so filters, hidden models, authentication failures,
and an early stop cannot be mistaken for complete coverage. Explicit runtime
and model selectors are audited separately: unknown, unavailable, and
not-executed selections make the command exit nonzero. Catalog failures, zero
eligible models, cancellation failures, and the model-count safety limit also
write a `STOPPED_EARLY` report instead of exiting before evidence is preserved.

`authoritative: true` is the single success condition used by the command exit
status. It requires a complete selected matrix and at least one executed model.
Profiles excluded by runtime or model selectors receive no qualification. It
also requires only `PASSED` results, complete selector coverage, and an
unchanged source repository. With `--qualify-read-only`, each supported
qualification must also pass. With `--qualify-attachments`, every requested
qualified content path must pass. An `UNSUPPORTED` result records an
intentional profile or model limit. Capability drift stays visible even when
the normal Task passes.

The harness does not remove Git worktrees, branches, or evidence automatically.
Cleanup is an explicit operator action after the report has been inspected.
