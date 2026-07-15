# Provider Runtime Smoke Testing

Date: 2026-07-14

`npm run smoke:providers` verifies real provider/model execution through
`TaskManagerService`. It is intentionally separate from deterministic seeded UI
testing: provider smoke runs use a caller-supplied disposable Git repository,
real runtime discovery, real Task Monki task/worktree/session/run records, and
real provider quota or credits.

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
  --model grok-acp:xai/grok-build \
  --timeout-seconds 300 \
  --confirm-throwaway \
  --confirm-provider-usage
```

Run `npm run smoke:providers -- --help` for all options.

## What the harness verifies

- Runtime and model discovery use the same registry exposed to the app.
- `DISCOVERED`, `READY`, and `DEGRADED` runtimes are eligible because
  on-demand runtimes may not become `READY` until their first native session.
- Visible model catalogs are refreshed after each run so models learned during
  native session setup are added to the same smoke pass.
- The lowest recognized advertised reasoning effort is selected. For
  provider-native effort names with no portable ordering, the provider's
  advertised default is preserved when one exists; otherwise the harness omits
  the override instead of guessing an arbitrary, potentially expensive choice.
- Runs are sequential and use a minimal prompt that forbids tools and edits and
  requests the `TASK_MONKI_PROVIDER_SMOKE_OK` sentinel.
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
  the exact Git snapshot returned by the explicit post-run refresh is `CLEAN`,
  that task worktree's HEAD still equals its recorded base with no committed
  diff or commits ahead,
  and a provider observation or exact adapter resolution attests the requested
  provider, model, and advertised reasoning effort.
- The original throwaway repository's porcelain status, checked-out ref, and
  HEAD are checked after every run. A clean commit, reset, or checkout is still
  detected as a change and stops the pass before another model starts.
- `RECOVERY_REQUIRED` and `LOST` never count as safe containment. The matrix
  stops because those states do not prove that the previous provider process
  or turn can no longer execute.

Some ACP runtimes cannot attest a read-only OS sandbox. The harness therefore
uses each runtime's supported execution policy in an isolated throwaway
worktree; the no-edit requirement is also verified independently with Git.
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
status. It requires a complete matrix, at least one executed model, only
`PASSED` results, complete explicit-selector coverage, and an unchanged source
repository.

The harness does not remove Git worktrees, branches, or evidence automatically.
Cleanup is an explicit operator action after the report has been inspected.
