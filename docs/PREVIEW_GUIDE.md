# Preview guide

Preview runs an application from a task's live worktree through Previewhost.
Starting or stopping an application does not change the task's workflow phase.

## All previews

Open **Previews** in the sidebar to see applications across tasks and Designs.
Filter by activity or attention, or search by project, task, or branch. A failed
update can still have a serving application; **Open app** opens that exact
worktree's serving attempt. Select a row to return to its task or Design.
Earlier worktrees are labeled and open their owning task without substituting
the task's current preview. Tasks without a runtime instance are not listed.

## Configure and start

Open the task's **Preview** tab. If no configuration exists, choose **Set up
Preview**. Review the suggested Vite, Next.js, or static-site configuration, or
enter your command and working folder. Manual setup does not require an agent.
**Save preview.yaml** creates the file without overwriting an existing file or
starting commands. Then choose **Review and start**.

For a multi-service app, use **Generate with agent** or edit root `preview.yaml`.
The agent proposes configuration for review; it cannot approve execution.
If evidence is insufficient, answer the focused questions with nonsecret details
and regenerate. Review the draft before saving it. Saving does not start the app.

A minimal file for a server that reads `PORT` and serves `/ready` is:

```yaml
name: application
type: command
cwd: .
command: [node, server.mjs]
readyPath: /ready
```

Task Monki assigns the runtime name from the worktree. Each worktree has its own
application and managed data. Previewhost supplies `PORT`, `HOST`, and
`PREVIEW_URL`; use `"{port}"` for a command-line port argument. Named ports also
support `"{port:NAME}"`. The command must honor the allocated port and bind to
loopback without automatic port fallback. Commands are
argument arrays, without an implicit shell. Install dependencies in the worktree
or declare an explicit setup job.

Root `preview.yml` is also supported, but having both default files is an error.
See Previewhost's configuration documentation for environment, database, worker,
and Compose specs. The manual command form uses your shell; YAML command arrays
do not use an implicit shell.

Review the services, commands, source access, and secret references before
**Approve and start**. Source changes remain live. Readiness must succeed before
the runtime exposes the new application.
HTTP readiness accepts status 200–399 response headers. It does not follow
redirects or inspect bodies. Use an endpoint that checks the application's
dependencies when those dependencies determine readiness.

## Activity, logs, and configuration

**Activity** shows services, setup jobs, and their actual state. A row's **Logs**
action selects that exact attempt and service. An update failure can coexist
with a serving application; **Open app** continues to open that application.
Expand **Source folders** to see compact rows with folder names and shortened
locations. Hover a name or location for the full path. **Open folder**
opens it in the file manager. The folder menu offers installed editors, including
VS Code, and **Copy path** for the full location.

**Logs** has attempt and source filters, search, pause-follow, refresh, and
clear-view controls. Pause-follow stops scrolling, not collection. Logs are
bounded; older output and logs from a previous app session may be unavailable.

**Configuration** shows the selected attempt's services, sources, and environment
bindings. Edit a binding as a literal value, secret reference, or service URL.
Concealed values are not displayed. **Review and apply** starts a replacement
with explicit authorization. Earlier attempts and saved Design captures are
read-only.

**Connect folder** shows the service, current folder, and selected replacement.
Choosing or canceling the folder picker grants no access. The explicit connection
permits Previewhost to use the folder until Task Monki closes. Commands run with
your account permissions and can read or change files. Review and approve the
resulting configuration before execution. External folders in an initial YAML
file also require explicit connection. Shared folders remain protected while
another preview uses them.

**Connections** edits an existing attached URL, another preview, or a local
database or TCP dependency. Database connection URLs use secret references.
**Review connection** submits the change through the same execution approval.

**Save as preview.yaml** creates a new file for future starts and does not
overwrite an existing default file. External source paths remain machine-local.
After editing an existing file, use **Update from preview.yaml** from the menu.

## Secrets

Preview review identifies each required reference and its service or job. Choose
**Add secret**, **Replace value**, or **Open secret storage** directly in Preview.
The private dialog returns to the same review. Saving or unlocking never approves
or starts a preview. Missing or locked references block execution approval.

Values stay concealed, including through accessibility tools. Pasting multiple
lines replaces the whole value and preserves every line. Clear it or paste again
to change it. Stored values cannot be read back. **Settings → Secrets** uses the
same private editor. Enter only local development credentials; a shared reference
has one value for every preview that uses it.

Configuration uses references, for example:

```yaml
env:
  API_TOKEN: {secret: "project/dev/api-token"}
```

Secret values stay out of agent messages and ordinary logs. Changes affect the
next start for every preview using that reference. Removing a binding keeps the
stored value. Deleting a value can prevent those previews from starting again.
Optional **Remember on this Mac** uses the macOS Keychain. Locking closes the
keystore session without changing the environment of processes already running.

## Jobs and retained data

Managed PostgreSQL and Redis require Docker and an unlocked keystore. Their data
belongs to the worktree's preview name and survives Stop. Declare migration and
seed jobs explicitly, with dependencies before application services.

Job failure and cancellation do not roll back database writes. Inspect the exact
job logs before retrying. Stop the preview before rerunning a job. **Delete data**
is separate from Stop and requires confirmation of the displayed retained data.
Do not use production databases for local preview verification.

## Failure and recovery

If the task folder is missing, Preview offers **Restore worktree**. Review the
recorded Git state before restoration. Restoration keeps the task, retained
preview configuration, and secrets. An external checkout uses **Reconnect
checkout** instead. A locked registration or changed branch requires review.

Use a failed service or job's **Logs** action to inspect that exact attempt.
Readiness errors include the probe path, deadline, and last observed response.
Command failures direct you to project commands and dependencies. Supervisor
failures identify Task Monki's runtime and retain bootstrap output in the attempt
logs; reinstall or rebuild the app instead of installing runtime modules in the
project. **Review and retry** requires a new execution approval.

A failed replacement usually keeps the previous application running. Its files
are still live, and migrations may already have changed the database. This is
not a rollback of source or data. Compose and exclusive workers may require a
period without a serving application during replacement.

**Cancel** stops only the candidate. **Stop** stops the owned application and
retains data and accepted configuration. **Retry cleanup** appears when the
runtime could not finish cleanup. Resolve that condition before deleting the
worktree. Task Monki does not kill unrelated processes to free a port.

Closing a tab does not stop previews. Closing Task Monki joins runtime cleanup.
After a crash or restart, inspect recovery state and start explicitly; application
commands are not rerun automatically. Retained configuration survives a failed
update followed by Stop.

Design previews use inspected commit captures. Stop them before editing live
workspace configuration. Use Design's revision controls to restart a saved
version; ordinary configuration controls cannot mutate that saved source.

For ownership and recovery details, see [Preview architecture](architecture/PREVIEW_ARCHITECTURE.md).
