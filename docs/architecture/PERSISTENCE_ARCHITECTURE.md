# Persistence Architecture

Date: 2026-08-30

This document describes Task Monki's current local persistence boundary. It is
the source of truth for storage ownership, transactions, schema upgrades,
backups, restore, and corruption handling. Product-specific recovery after the
store opens remains documented in `CRASH_RECOVERY.md`.

## Ownership

`ApplicationPersistence` opens one profile and composes every durable store
over one `AppDatabase` connection and one `ManagedFileStore`. A profile-level
lease prevents two application or recovery owners from mutating the same
profile.

| Data | Authoritative owner | Physical representation |
| --- | --- | --- |
| Tasks, boards, repositories, workflow, worktree records, local evidence, Preview control records, Design metadata and drafts | Task Monki domain stores | Normalized SQLite tables |
| Provider servers, sessions, runs, items, interactions, queues, usage, telemetry, operation receipts, and recovery records | The Task Monki runtime store owns its records. Providers remain authoritative for external runtime state. | Normalized SQLite tables |
| Discourse conversations, participants, messages, context, waves, jobs, concerns, summaries, drafts, and tombstones | Task Monki Discourse store | Normalized SQLite tables |
| Application settings | Task Monki settings store | One revisioned SQLite record |
| Attachment, artifact, and encrypted Preview-private bytes | SQLite owns identity, reachability, size, digest, and media metadata. `ManagedFileStore` owns byte publication and verification. | Immutable files below `storage/files` |
| Managed Design source | The managed Git repository owns commits, trees, and refs. SQLite owns Task Monki's repository and Design records. | Git repositories below `storage/design-repositories` |
| Redacted provider protocol diagnostics | The runtime server record owns retention. The journal owns bounded byte segments. | NDJSON below `storage/protocol-journals` |
| User repositories, ordinary task worktrees, Git remotes, GitHub, provider processes, and Preview runtime objects | Their external systems | Task Monki observes and reconciles them. It does not copy them into application persistence. |

Many SQLite records retain a complete JSON payload and typed columns for
relationships and indexes. For these tables, the payload is the logical record.
The columns are constrained projections. The Task and runtime mappers verify
their indexed columns and joins against each payload. A disagreement stops the
load. Discourse loaders verify their focused relationship and integrity rules.
Runtime records are not duplicated into Task-owned tables. `SqliteTaskStore`
joins the runtime projection for existing callers without persisting
that projection.

Runtime events are a bounded recent diagnostic stream, not the durable owner of
operation idempotency. The runtime store retains at most 200,000 events and
compacts the oldest row in the same transaction that appends a new one. Event
ordinals remain monotonic. `operation_receipts` owns replay and conflict
detection independently of that retention window. Task-, Discourse-, and
prompt-refinement-owned receipts remain until their owner is purged. The two
application-wide streams (shutdown state and ownerless telemetry) each use an
independent bounded receipt window.

The renderer is not an application-data store. Its only `localStorage` record
is `task-monki.workspace-layout.v1`, which contains collapsible-panel, panel
width, and Design layout preferences. Tasks, settings, workflow, runtime,
Discourse, Preview, artifacts, and attachments remain main-process data.

## Profile Layout

For a profile root, current application-owned paths are:

```text
<profile>/
  .task-monki-storage.owner.lock
  storage/
    task-monki.sqlite3
    files/
    protocol-journals/
    design-repositories/
    design-worktrees/
    task-artifact-captures/
  backups/
    backup-<timestamp>-<id>/
```

`design-worktrees` and `task-artifact-captures` are derived or staging data.
Managed Design repositories are durable. The desktop host keeps ordinary task
worktrees outside this persistence root. Preview runtime data and Discourse
execution workspaces are also outside this root. SQLite stores their durable
identities and outcomes where required.

During restore, the staging or live root can contain
`.task-monki-restore-intent.json`. This temporary marker remains until restore
activation or explicit recovery completes.

## Writes And Concurrency

`AppDatabase` owns one SQLite connection. It serializes reads, writes, backup
snapshots, and shutdown through one admission queue. A top-level mutation uses
`BEGIN IMMEDIATE`. Nested store calls on the same database join that transaction.
Synchronous commit and rollback callbacks only publish in-memory state after
SQLite decides the transaction. Deferred callbacks perform ordered file cleanup
after the database queue is released. The originating mutation still waits for
that cleanup. A write cannot span two application databases.

The connection enforces foreign keys, disables extension loading and trusted
schema use, and uses `journal_mode=DELETE` with `synchronous=EXTRA`. This is a
single-process desktop design, not a multi-process database service. External
I/O must finish before a database transaction begins. A store must not keep a
transaction open while it waits for a provider, Git, GitHub, Docker, or another
external system.

Managed bytes are published before the referencing transaction. Publication
uses a private, exclusive temporary file. The store flushes the file and
atomically renames it. It synchronizes the directory where the platform
supports this operation. It then verifies the byte count and SHA-256.

An existing immutable path is accepted only when its bytes match. A transaction
rollback removes newly published, unreferenced bytes. The store removes old
bytes only after the reference deletion commits. A failed deletion remains in
`managed_file_gc` for the next startup. Managed-file reads and retirement
deletions share an admission queue, so a read that selected the old revision
finishes before post-commit cleanup can unlink it. A deletion barrier keeps
referenced bytes stable during a backup.

Shutdown first drains backup work and accepted store operations. It then drains
the database admission queue and `ManagedFileStore` cleanup before closing
SQLite and releasing the profile lease.

## Startup And Recovery

Opening a profile performs these persistence checks before normal product
reconciliation:

1. `ApplicationPersistence` verifies private profile ownership. Then it
   acquires the profile lease.
2. It rejects an interrupted restore before it initializes any managed-file
   path. It also rejects an empty database or a missing database with durable
   storage residue.
3. `ManagedFileStore` initializes its root. It removes stale publication
   temporary files.
4. `AppDatabase` opens SQLite. It verifies the application id and schema
   version. Then it applies migrations and runs SQLite integrity checks.
5. The runtime store loads and verifies its records and artifacts. It retries
   garbage collection and reconciles retained protocol journals. The settings
   store initializes. The Discourse store verifies database access.
6. The service loads and verifies Design drafts. It registers retained
   attachment drafts. Then the Task store loads and verifies its records and
   managed files. It retries garbage collection and reconciles owned files.
7. The service uses the recovery order in `CRASH_RECOVERY.md`. It verifies
   lazily loaded Discourse and Preview-private records before use.

A missing database is valid only for a new profile or an empty first-start
directory skeleton. Startup preserves all suspicious residue and fails closed.
It never turns interrupted restore state into a new empty profile.

An integrity, identity, schema, relationship, or startup-loaded managed-file
failure aborts startup. Other managed bytes, such as Preview-private
ciphertext, are verified before use and fail closed. Task Monki does not
silently repair payloads, adopt unreferenced files, or reinterpret an
unidentified database. External mutations can have succeeded before a stop.
Task Monki observes them through their owning systems. It never replays an
interrupted local record.

`ApplicationPersistenceRecovery` is the offline recovery owner. Restore and
quarantine acquire the same profile lease used by the live application, so all
live database handles must be closed. Quarantine atomically renames the complete
live `storage` directory and performs no automatic salvage or replacement.
These core recovery operations have no end-user interface. Startup does not
restore or quarantine data automatically.

## Schema Upgrades

SQLite `PRAGMA application_id` identifies a Task Monki database and
`PRAGMA user_version` identifies its schema. `DatabaseMigrations.ts` contains a
contiguous, forward-only migration sequence starting at version 1. Each pending
migration uses one immediate transaction. It runs an integrity check before it
advances `user_version`. Task Monki rejects a newer version, a conflicting
application id, or unidentified application tables.

A file-backed upgrade from an existing SQLite schema must first create and
verify a `PRE_UPGRADE` backup. A migration error rolls back the transaction.
The backup remains available for explicit recovery. New profiles start at
SQLite schema version 1. Future changes add new SQLite migrations.

## Backup And Restore

A complete backup is created in a private staging directory and published only
after verification. It contains:

- a SQLite online-backup snapshot with application id, schema version, size,
  digest, full integrity check, and foreign-key check.
- every live immutable file referenced by that snapshot.
- retained protocol-journal segments for runtime server records in the
  snapshot.
- a verified Git bundle and ownership marker for every managed Design
  repository. The manifest binds the bundle's exact HEAD to the repository
  `head_sha` in the SQLite snapshot. Its saved HEAD reference must resolve to
  that commit. The bundle also includes every Git object required by structured
  Design state.

Before capture, runtime journal writers flush queued entries. The service hashes
each segment before and after the copy. A concurrent append stops the staged
backup. A retry starts from a new snapshot. Managed-file deletion is blocked
during the backup. A Design repository must be clean, stable during capture,
and still at the exact HEAD owned by the database snapshot. The exact manifest
rejects extra, missing, changed, unrelated, or unsafe files. The service does
not schedule, upload, compress, merge, or expire backups.

Restore first verifies the complete backup. It constructs a new private
`storage` staging root. Then it verifies the SQLite snapshot and restores the
managed Design repositories. It runs `fsck` on each repository. It creates an
empty Design worktree directory.

Verification rejects a backup with a newer database schema before restore
staging or any live-storage change.

Restore publishes and synchronizes its intent in the staged root before it
moves the live root aside. The marker moves with the staged root during atomic
activation. A known pre-activation failure restores the previous root. An
ambiguous outcome preserves every recovery path and blocks normal startup.

Offline recovery accepts only the backup named by the retained intent. It
re-verifies that backup and the prepared root, then resumes activation under the
profile lease. Startup never resumes restore automatically.

Backups exclude ordinary user repositories, task worktrees, and Design
worktrees. They also exclude mutable artifact captures, Preview runtime objects,
and Discourse execution workspaces. Provider history and external Git or GitHub
state are external authority. These items are not application persistence.

These backups are exact local, same-profile recovery sets, not portable exports.
Preview-private ciphertext is retained so a local upgrade or restore does not
break durable reachability, but its operating-system key may not exist for a
different machine or user. A future portable export must omit private values and
require secret re-entry. Task Monki does not currently provide that export.

## Verified Scale Boundary

The runtime scale gate cold-loads 100,000 telemetry rows and 100,000 matching
events. It then appends 1,000 telemetry records and changes the application
shutdown latch. The test requires less than 512 MiB of heap growth and a
60-second completion time.

A normal telemetry append writes only the affected rows. One transaction writes
one telemetry row, one event row, and runtime metadata. It does not diff or
rewrite unrelated runtime records. A top-level shutdown-latch change also
updates only its event and runtime metadata. When either operation joins an
existing application transaction, it updates the transaction-local state so
the complete operation commits or rolls back together.

Cold startup still materializes runtime telemetry and events in memory. This
gate is a verified workload, not a storage limit or a pagination claim.

## Change Rules

- Give every mutable value one owner. Do not add a JSON mirror, renderer cache,
  or provider-derived copy of an authoritative SQLite record.
- Store bounded, queryable identity and lifecycle records in SQLite. Store large
  immutable bytes as managed files and keep Git source in Git.
- Add a SQLite migration for every future stored-shape change.
- Never rewrite a migration that has shipped.
- Keep file publication outside and reference changes inside the smallest
  transaction that prevents partial user-visible state.
- Test transaction rollback, process interruption, and corrupt or missing
  managed bytes.
- Test payload and index disagreement, upgrade backups, and concurrent backup
  activity.
- Test restore verification, activation errors, and external-operation
  reconciliation.

The focused persistence gates are `npm run test:persistence` and
`npm run test:storage`. Storage, startup, or recovery changes also require all
repository gates in `AGENTS.md`.
