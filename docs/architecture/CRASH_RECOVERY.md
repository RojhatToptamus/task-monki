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
- GitHub and GitLab own issues, pull and merge requests, checks, reviews, and
  merge state.

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
6. Side question snapshots left by an earlier process are removed: write
   permission is restored, the worktree registration is removed, and Git prunes
   only when a registration survives. Shutdown runs the same sweep. A side
   question that read the live worktree and is left `RECOVERY_REQUIRED` keeps
   holding other agent work until the person stops it.

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

A missing worktree is not recreated during startup. Explicit restoration keeps
the same worktree record, branch, iteration, and recorded base. It recreates the
last verified commit, or the base when no later commit was recorded. An existing
branch at another commit blocks recreation. Restoration never transfers dirty
files or silently changes the base. Start requires an already prepared worktree.

Existing Design worktrees use ordinary verification before Git evidence refresh.
Repository Designs keep an accepted Git snapshot reference separately from the
latest observation. Refresh and restart do not advance that reference. Owned
setup, turn completion, recovery, and explicit acceptance can advance it.

Interrupted initial Design creation can complete during startup. A previously
available repository Design worktree requires explicit Recover workspace if
missing. Recovery uses the accepted commit and refuses a changed branch.
Standalone Design retains its managed-source reconstruction behavior.

Candidate publication uses a recorded commit or branch checkpoint. It does not
scan Git's object database for orphan commits. Index repair holds Git's index
lock and refuses unexpected staging. A dead verification generation prevents
Ready publication even when source publication can be repaired. Archived
Designs remain stopped; their managed data survives cleanup and reconciliation.

External checkout verification never creates directories, changes permissions,
switches branches, or removes checkout files. A moved external checkout requires
explicit reconnection to a registered path in the same repository and branch.
Historical run and evidence paths stay unchanged. A later coding turn starts a
fresh session when the recorded session still belongs to the old path.
Task deletion stops only Task Monki-owned resources and cannot remove an external checkout.

## Provider Runs And Interactions

Persisted ownership remains recoverable for `QUEUED`, `STARTING`, `RUNNING`,
`AWAITING_APPROVAL`, `AWAITING_USER_INPUT`, `INTERRUPTING`, and
`RECOVERY_REQUIRED` runs, including when an earlier server record is already
terminal. Each adapter reconciles the provider it owns and applies its existing
no-resend rules. A prompt, approval, answer, interrupt, review request, or other
ambiguous mutation is never replayed automatically.

Terminal reconciliation preserves the recorded run completion time. The time
of event receipt does not replace that historical value, and later updates to a
settled run, such as its post-run Git snapshot, keep it. Startup identifies a
review or side question outcome by its run: when the Task
store already records that outcome, under whichever operation recorded it,
startup only settles the runtime record and does not publish the result or
capture post-run evidence again. A review outcome projected again keeps the
walkthrough artifact its run already holds instead of writing a second.

Graceful runtime shutdown first removes adapter event producers. It then drains
events that Task Monki already accepted before it stops the adapters. Store
shutdown cannot race a previously accepted provider terminal event.

Discourse deletion releases each loaded provider session before it writes the
conversation tombstone or purges runtime evidence. If release is not confirmed,
deletion stops and keeps the records for an explicit retry.

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

A push to an opened pull request's own branch records the branch and the head
Task Monki last observed for it, and is leased on that head. Finding the branch
still at that head proves the push did not land: the record becomes FAILED and
a retry is safe. A lease the remote refuses is FAILED as well, with nothing
changed. A different unexpected head stays AMBIGUOUS. Sync branch refuses while
that push is unresolved, and never moves off a commit the task pushed.

Opening a pull request fetches objects only, then records the task, iteration
and worktree in one transaction before the checkout. An interrupted checkout
leaves a CREATING or failed worktree that Recover recreates at the recorded
head, fetching it again when the objects are gone; a head the platform no
longer has requires opening the pull request in a new task. Sync branch first
records a base both the old and the new head descend from when the pull
request was rewritten, so an interruption leaves a worktree that verifies.

Marking a pull request ready, merging it, replying on it, resolving or
reopening its threads, asking a reviewer again and running its failed checks
again are the person's explicit writes, and nothing repeats them. Before a merge Task Monki records
`PR_MERGE_REQUESTED` with the head and the method; the merge itself is pinned
to that head (`sha`), so a retry can never merge a different commit, and after
a crash the next refresh reads whether the platform merged. Marking ready is
idempotent on the platform. Replies post one at a time and are recorded as
`PR_REPLIES_POSTED` once they land, naming the discussions answered; a thread's
reply also shows in the thread itself, so after a crash Reply offers only the
discussions the person has not answered since the agent did. A review's answer
is a comment of its own, so a crash after it lands and before the record is
written leaves Reply offering it once more; the comment is on the platform to
see. Resolving or reopening a thread, and asking a reviewer again, are
idempotent on the platform; each is recorded once it lands, and after a crash
the next reading shows the thread's or the reviewer's state. Running failed
checks again is recorded as `PR_CHECKS_RERUN_REQUESTED` after the platform
accepts it, and nothing repeats it: a crash before the record leaves the runs
started, which the next reading shows as pending checks. Merging observes the
worktree before the write, so a crash cannot leave local work behind a merge
Task Monki made. Refresh of a task opened from a pull request reads the
worktree before it records the platform's reading, so a merge made on the
platform completes the task only when the worktree holds nothing the pull
request lacks.

A branch update (Pull changes or Update with <base>) fetches objects only, then
records `BRANCH_UPDATE_REQUESTED` before Task Monki's own `git merge` in the
worktree; Pull changes also records the base branch's tip it read. Git owns
the result, and nothing repeats the merge: a merge Git stopped on stays in
progress until Push update commits it. The merged base becomes the task's base
once the branch holds it, moving forward to where the branch meets the recorded
tip; after an interruption, the next Push update adopts it.

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
