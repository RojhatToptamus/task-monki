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

Open the task's **Preview** tab. Without a configuration file it lists what the
project files say (application, dependencies, environment keys, Compose services)
and offers **Draft with Preview agent** or **Write it myself**. The agent works in
a conversation opened any time from **Agent** in the status row: ask it to draft
the configuration, check the setup, inspect logs, or explain a failure. On wide
windows it docks beside the Preview, keeps its width and stays open across visits;
on narrower windows it opens as a drawer. While it is closed, a dot on **Agent**
shows that it is working or waiting for an answer. It reads the project and the runs, asks when the files do not
decide something, and returns proposals that open in **Configuration** as a diff.
Pick any enabled agent and model below the message field; a message sent while the
agent works waits in the queue, and **Stop** interrupts the current response.
**Save** writes the file without starting. **Save and review startup** also opens
the execution review. Requirements, the execution review and failures appear at
the top of **Activity**; when a start is blocked, **N to resolve** in the status
row leads there. Resolve them, then choose **Approve and start**. When a retained run exists but the file is gone, **Start from last run**
is the primary action.

**Check for a plain static site** in the menu offers a draft only for HTML folders
without a package manifest. Use the Preview agent for projects that need commands
or dependency installation.

After a failure, **Investigate with Preview agent** sends the diagnosis to the
conversation. The agent cannot save, approve, or start execution. If the file
changes during review, saving is refused and the existing file stays intact.

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
and Compose specs. YAML command arrays do not use an implicit shell.

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
Setup jobs still modify live folders. When a job overlaps a serving source, Preview reviews the restart before stopping.
Cancel keeps the serving preview. Approval stops it and starts the captured configuration once.
Jobs can write outside their working folders; this warning does not guarantee isolation.
Expand **Source folders** to see compact rows with folder names and shortened
locations. Hover a name or location for the full path. **Open folder**
opens it in the file manager. The folder menu offers installed editors, including
VS Code, and **Copy path** for the full location.

**Logs** selects one run and one or more sources. Search highlights text; it does not infer severity.
**Log sources** opens a checkbox menu with each source's state. With two to four sources chosen, **Side by side** shows them as separate panes in one log surface; four sources use a two-by-two layout. **Send last 40 lines to task agent** is in the toolbar's **⋯** menu when one failed source is shown.
External HTTP and TCP connections check services started outside Preview; they cannot capture those processes’ output. **Ask agent to enable logs** drafts a request for managed services. Review the commands, folder access and secrets before saving or starting.
Logs follow new output automatically. Each stream has a pause/play control. Scrolling up also pauses following without stopping collection; the **new lines** button returns to the latest output. Separate panes follow independently.
The shared buffer retains at most 64 KiB. Logs expire when the runtime restarts.

**Configuration** edits the portable file. It groups the file into services,
databases, setup steps (in the order they run), folders and secrets. Open a row
to change its command, folder, start order, repeat, readiness path or
environment; values are written into the draft as you edit, preserving unrelated
YAML and comments, and **Save** in the status row writes the file. A rejected
file shows Previewhost's own reason. All starts read that file. Runtime
descriptions are read-only records of earlier execution. **YAML** shows the
source, and **Changes** (shown when the draft differs) compares it with the
original file.
If both default files exist, explicitly choose one; the other is retained with a `.unused` suffix.

Folder requirements show the folder name, a shortened location (hover for the exact path) and the services that use it. Choosing a folder grants no access.
**Connect** grants access for the current app session. Other tasks can reuse that session grant.
Commands run with your account permissions and can change files outside their working folder.
External relative paths resolve from the registered repository, rather than the task's temporary worktree.
The selected location stays local to this session; the portable declaration stays in YAML.

Edit attached service addresses in **Configuration**, then save and review startup.
For a browser client, the backend must allow the displayed Preview origin in its
CORS configuration. A successful backend request does not prove the browser can
read its response. Check the browser errors too. Update the allowed origin when
the Preview address changes; Task Monki does not change an attached backend's permissions.
Values needed by several services remain in one configuration file.
Internal worktree identifiers are runtime names, never generated project names.

## Secrets

Preview review identifies each required reference and its service or job. Choose
**Add value**, **Set up storage**, or **Unlock storage** directly in Preview.
The concealed form stays in the requirements block. Saving or unlocking never approves
or starts a preview. Missing or locked references block execution approval.
To replace an existing value, choose **More → Manage required secrets**.
The form lists only references required by this preview and keeps their values concealed.

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

If the task folder is missing, the Preview tab shows a **Worktree missing** block
with the recorded commit and branch, and **Restore worktree** is its only action.
Restoration checks the branch out again at that commit; uncommitted files,
including a preview configuration file in that folder, cannot be recovered. The
task, retained run configuration, data, and secrets are kept. An external checkout
uses **Reconnect checkout** instead. The runs list stays readable; **Run configuration** opens
the configuration each run started with.

Use a failed service or job's **Logs** action to inspect that exact attempt.
Readiness errors include the probe path, deadline, and last observed response.
Command failures direct you to project commands and dependencies. Supervisor
failures identify Task Monki's runtime and retain bootstrap output in the attempt
logs; reinstall or rebuild the app instead of installing runtime modules in the
project. **Start preview** requires a new execution approval.

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
commands are not rerun automatically. The next start reads the current file, including after a failed update followed by Stop.
If the file is missing, the menu offers an explicit start from the last runtime configuration.

Design previews use inspected commit captures. Stop them before editing live
workspace configuration. Use Design's revision controls to restart a saved
version; ordinary configuration controls cannot mutate that saved source.

For ownership and recovery details, see [Preview architecture](architecture/PREVIEW_ARCHITECTURE.md).
