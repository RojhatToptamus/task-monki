# Crash And Restart Recovery

Date: 2026-07-25

This document describes Task Monki's application-level recovery boundary. The
provider-, Preview-, review-, and delivery-specific documents remain
authoritative for their own protocols. Store opening, integrity checks,
quarantine, backup, and restore are defined in `PERSISTENCE_ARCHITECTURE.md`.

## Central Rule

A persisted event saying that an operation started proves only intent. After a
restart, Task Monki observes the system that owns the result before deciding
what happened:

- Git owns worktree registration, local branch, commit, and dirty-tree facts.
- A provider runtime owns its sessions, turns, interactions, and terminal
  results.
- Task Monki's child-process owner proves the lifetime of processes launched by
  the current app instance.
- Preview's authenticated launcher or container labels own live Preview
  resource identity.
- the Git remote owns the published branch ref.
- GitHub owns pull requests, checks, reviews, and merge state.

Recovery may adopt a proven active or completed result, mark an interrupted
operation honestly, or expose an explicit retry or cleanup action. It never
blindly repeats an operation that may already have mutated Git, a provider, a
remote, GitHub, or Preview resources.

## Startup Order

`TaskManagerService` opens and validates the durable store, then reconciles
external state in this order:

1. Preview stops resources that carry Task Monki's exact durable ownership
   identity and records the observed result.
2. Current worktrees are checked against the repository's real worktree
   registry. Present worktrees receive fresh local Git observation; unchanged
   observations reuse the latest record instead of appending duplicate evidence.
   An unavailable checkout updates repository and worktree evidence instead of
   leaving a stale `PRESENT` claim.
3. Interrupted branch publication is compared with the exact remote branch ref.
   Interrupted PR creation performs a read-only lookup for the task branch.
4. Enabled provider adapters reconcile persisted servers, sessions, runs, and
   interactions.
5. Normal post-run and workflow evidence repair continues through the existing
   service paths.

Failures are isolated to the affected task or runtime. One unavailable
repository, remote, provider, or GitHub account does not permit Task Monki to
mutate a different task's resources.

The deterministic development seed host deliberately skips external recovery.
Its worktrees, runs, and provider records are synthetic UI scenarios, and the
host disables provider startup for the same reason. Normal desktop and
non-seeded development startup always run reconciliation.

## Worktrees And Local Git

An interrupted `CREATING` record is not assumed to mean either success or
failure. Startup asks Git for registered worktrees and records `PRESENT`,
`MISSING`, or the verified error. For a present worktree, the normal Git
snapshot adopts a commit or dirty state that completed before the crash even if
Task Monki never saved the completion event.

A missing worktree is not recreated during startup. The next explicit Prepare
action revalidates the repository and creates the same Task Monki-owned
worktree record, branch, and iteration. It refuses conflicting paths or branch
ownership through the existing worktree checks.

## Provider Runs And Interactions

Persisted ownership remains recoverable for `QUEUED`, `STARTING`, `RUNNING`,
`AWAITING_APPROVAL`, `AWAITING_USER_INPUT`, `INTERRUPTING`, and
`RECOVERY_REQUIRED` runs, including when an earlier server record is already
terminal. Each adapter reconciles the provider it owns and applies its existing
no-resend rules. A prompt, approval, answer, interrupt, review request, or other
ambiguous mutation is never replayed automatically.

Long-lived provider processes, external-tool and provider probes, mutating or
remote-inspection Git commands, GitHub commands, and Docker/Compose CLI
children run through a small owner process. Local read-only Git inspection
remains a bounded direct command so routine evidence refresh does not create a
second process per query. If the app process disappears, IPC ownership closes
and the owner stops only its exact target process group. Normal cancellation
and shutdown still use the existing joined supervisor paths. Persisted PIDs
from an earlier app instance are evidence only; Task Monki does not kill an
unrelated process that later reused a PID.

## Preview

Preview keeps its existing stop-only startup reconciliation. Native launchers
must authenticate with the durable instance token, and managed containers must
match the complete Task Monki ownership labels. Startup never adopts an
unverified listener or container and never deletes a merely similar resource.
Docker and Compose CLI children share the application owner-death boundary;
daemon-side resources remain governed by exact labels and stop-only
reconciliation.

## Git And GitHub Delivery

Commit recovery reads local Git; it does not run another commit automatically.

Before pushing, Task Monki durably records `PUSHING` with the exact local HEAD,
remote, and branch. After a crash or an uncertain push result it reads the exact
remote ref:

- the attempted SHA is present: record `PUSHED`;
- the ref is absent: record `FAILED` and allow an explicit safe retry;
- the ref differs, the attempted SHA is unknown, or the remote cannot be read:
  record `AMBIGUOUS` and block mutation.

Startup and the next explicit delivery action re-read an ambiguous exact remote
ref before local auto-commit or GitHub preflight. This guard applies to both
Publish branch and Create draft PR. The explicit action pushes only after that
observation proves the ref is absent; it adopts the attempted SHA when already
present and otherwise remains blocked without mutating local Git or the remote.
An unchanged ambiguous observation reuses its existing record.

Before creating a pull request, Task Monki records the request. Startup only
searches for an existing open PR on the task branch. It adopts a match and
never invokes PR creation. The normal explicit creation path also searches
before creating. A failed recovery lookup records `GITHUB_SYNC_FAILED` so the
task exposes the failed observation and retains an explicit retry path.

GitHub refresh is read-only and has no durable in-progress state. If it is
interrupted, the last complete snapshot remains current until the user retries
Refresh; startup does not manufacture or repeat a refresh.

## Shutdown And Limits

Graceful shutdown stops admission first, then joins provider, Preview, local
host, and store owners. The owner process covers abrupt app death for newly
launched children. It cannot retroactively prove ownership of arbitrary legacy
processes, and Task Monki therefore does not kill them by PID.

POSIX process groups provide the tested descendant boundary. Windows uses
`taskkill` for the exact owned tree, but the platform limitation documented in
the runtime architecture still applies when a leader has already escaped
before Task Monki can observe it.
