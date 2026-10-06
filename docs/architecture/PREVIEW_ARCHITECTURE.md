# Application previews

Task Monki embeds the Previewhost Node.js library in its main process. One
Previewhost runtime owns application processes, jobs, databases, ports, routing,
logs, retained configuration, secrets, replacement, and recovery for one profile.
Task Monki owns tasks, agents, worktrees, user authorization, and Design publication.

## Control and storage boundaries

`ApplicationPreviewService` selects a worktree and gives it the stable runtime
name `tm-<worktree-id>`. `TaskManagerService` checks task ownership and serializes
mutations against task deletion and Design operations. The renderer receives
Previewhost's structured status through the application-preview IPC contract.
It does not maintain another persisted runtime state machine.

The Previews sidebar page joins the runtime inventory with Task Monki's tasks,
repositories, and worktrees. It keeps only navigation state in the renderer.
Opening an application rechecks task/worktree ownership and the serving attempt;
Design openings also preserve the selected Design route.
Source-folder actions resolve the task, attempt, and source index through Previewhost
before using the existing desktop opener. They accept no renderer-supplied path
and grant no runtime source access. Removed captures remain unavailable.

Previewhost stores its runtime records, data records, and encrypted keystore
under the profile's `preview-runtime` directory. Normal previews use live source
folders, including uncommitted files and locally installed dependencies. Different
worktrees receive different names and managed data. An additional source can be
shared; before removing any worktree, Task Monki asks the runtime to release that
source. Release fails while any preview uses the folder or an overlapping path.

The renderer polls status while visible. Logs use bounded cursor reads from the
runtime and a bounded renderer buffer. Hidden log panels stop reading. Refresh
reconnects after a read error. Attempt selection and source selection remain
explicit; failure logs never silently become the serving attempt's logs.

## Configuration and authorization

Previewhost resolves root `preview.yaml` or `preview.yml`; ambiguous defaults
fail. Task Monki does not parse or translate the former `.taskmonki` recipe.
The Configuration tab edits bindings through Previewhost's inspection and apply
APIs. Source connection selects a service, requests access, and changes that
service's source through the same owner. Saving a portable configuration is an
explicit action; it does not silently rewrite an existing file.

The verified owning worktree is authorized again when configuration is inspected
after restart. Additional folders require a new explicit source grant in that
application session.

Every application start or replacement has an exact attempt-scoped approval.
The review shows services, commands, source folders, dependencies, and secret
references. Task Monki resolves approval only for the displayed attempt. A
canceled or superseded attempt cannot use that response. Previewhost checks the
expected active/candidate/latest identities for conflicting mutations.

Settings → Secrets is trusted desktop input. It lists names and usage, accepts
new values, and exposes no value-read operation. Values do not enter task events,
agent prompts, ordinary status, or ordinary logs. Previewhost owns encryption,
redaction, reference grants, lock/unlock, and optional macOS Keychain remembrance.
Binding removal does not delete a shared secret. Secret updates affect later
starts; a live process keeps its existing environment.

## Replacement, stop, and recovery

A replacement uses the existing stable application URL. Previewhost switches
routing after candidate readiness. A failed or canceled candidate normally leaves
the serving attempt available. Source edits and database writes are not rolled
back. Exclusive workers and Compose have stricter replacement boundaries; their
actual attempt state determines availability.

Stop joins application cleanup and retains managed database data. Data deletion
is a separate explicit operation against the displayed retained resources.
Rerunning a job requires a stopped preview. Jobs can change retained data, so
neither cancellation nor failed startup promises transaction rollback.

Closing a renderer or navigating away does not stop the main-process runtime.
Application shutdown closes Previewhost and joins cleanup. After a process crash,
Previewhost reconciles recorded owned resources without automatically rerunning
application commands. Native process identity must match before signaling a
process group. Cleanup debt remains visible and prevents unsafe reuse. Task Monki
retains worktrees and Design captures until the runtime releases them.

Logs are bounded and are not durable across runtime restarts. Configuration and
managed data remain available for an explicit restart. The latest accepted
configuration is retained even when a replacement fails and the user stops the
previously serving attempt.

## Design

Design still exports the inspected Git commit through `PreviewSourcePreparer`.
It retains captures at `<previewRoot>/<taskId>/<generationId>`, with the existing
store-owned markers. Previewhost uses the separate `<previewRoot>/previewhost`
directory; capture cleanup ignores directories without a matching marker.
Design owns browser access restrictions, revision history, and atomic publication
in SQLite. `DesignPreviewService` starts that source as a held
Previewhost candidate. The agent and canvas use a proxy limited to the candidate's
declared HTTP origins; external Open uses the selected runtime URL directly.

Previewhost's promotion callback runs the existing Design settlement transaction.
If settlement fails, the old route remains. After durable publication succeeds,
canvas or old-source cleanup failures are reported without undoing the revision.
Cleaned captures release their source approval, so repeated updates do not consume
an ever-growing source grant list.

Saved Design captures are read-only in ordinary configuration controls. Stop the
Design preview before editing workspace configuration. Restarting a Design
revision exports its exact commit again; starting ordinary setup reads the live
workspace configuration. Neither operation edits a historical capture.

## Packaging and upgrade

Previewhost is installed from npm through the application dependency and lockfile.
The desktop package unpacks it from ASAR so its supervisor and native Keychain
helper can execute. The main process supplies Electron's executable in Node mode
and the unpacked `supervisor.js` path. No global CLI or MCP daemon is required.

Database migration 10 removes superseded Task Monki runtime tables and contracts.
The automatic pre-upgrade backup retains old metadata. The migration refuses to
forget records for unresolved old runtime resources: stop them with the previous
application before upgrading. It preserves task records, Design revisions,
source identity, and unrelated data. It does not delete external databases,
volumes, source files, or old secret files.

## Verification

Owner-boundary tests live beside `ApplicationPreviewService`,
`DesignPreviewService`, the Design coordinator, and the SQLite migration.
Previewhost tests cover its lifecycle, secret, database, and process boundaries.
`npm run verify:packaged-preview` exercises the packaged library and supervisor
with temporary sources and synthetic secrets. Renderer DOM tests cover controls
and authorization interactions; the actual Electron workflow remains necessary
for visual, focus, layout, and packaged verification.
