# Preview agent

The Preview agent is a conversation in a task's Preview tab. It reads the task
worktree, the configuration file, the runs and their logs, answers questions
about the preview, explains failures, and proposes `preview.yaml` changes. Its app-owned tools
only inspect and propose: the person reviews, saves, and separately approves
execution. Provider restrictions and their limits are described below. Previewhost remains
the parser and runtime owner.

## Conversation ownership

A Preview conversation is an agent session with role `PREVIEW` on the task's
current worktree. Each turn is a run with mode `PREVIEW`, purpose
`TASK_PREVIEW`, and instruction profile `PREVIEW`. The session, runs, items,
questions and messages belong to the task, but they are detached from its
workflow: a Preview run never becomes the task's current run, never moves the
workflow phase, and never binds the task's current session. The renderer splits
them out of the Agent tab (`partitionPreviewAgentRecords`) and renders them in
the Preview panel with the same turn, step, question and queue components.

The conversation is keyed by runtime and model. The panel offers the full model
catalog of the enabled runtimes; the Settings default (**Models → Preview
agent**) is the starting selection. Choosing another runtime or model starts
another session; earlier sessions stay in history. The selection is fixed while
a turn runs. After relaunch, the last requested model remains selected even
before the provider catalog loads; missing catalog entries never select a different model.

`PreviewAgentCoordinator` owns the conversation. Messages are durable
`TaskInstruction` records with `role: 'PREVIEW'`. A message sent while the agent
is idle starts a turn at once (`FOLLOW_UP`, `SENDING` → `SUBMITTED` with its run
id). A message sent during a turn waits in the queue (`QUEUE`, `QUEUED`) behind
the active run and is sent when that run completes in the same session. Stop
interrupts the run and holds the queue; a held or failed message is sent again
by its id. Task Monki restarts hold queued messages like the task queue does.
Removing or editing a queued message uses the shared instruction editing.

Each turn's prompt is the person's message followed by one line of preview
state (`buildPreviewAgentTurnPrompt`); the agent's permanent instructions are
`PREVIEW_AGENT_DEVELOPER_INSTRUCTIONS`. Codex receives them as plan-mode
developer instructions, ACP agents as a prompt prefix, OpenCode as the system
prompt. Turns use the existing provider-specific read-only analysis policy,
with command approvals disabled. Codex enforces a read-only, offline sandbox;
Claude ACP uses its provider plan mode, which allows file reads and read-only
shell commands and does not provide an OS sandbox or offline guarantee. The
exact model selected must resolve or the message is refused before a record
is written.

Questions use each runtime's native structured question tool (Codex
`request_user_input`, ACP form elicitation, OpenCode questions). They arrive as
`USER_INPUT` interaction requests and are answered through the shared
`InteractionPanel` inside the Preview panel; a pending question opens the panel.

## App-owned tools

The Preview agent calls two Task Monki tools through the generic client-tool
bridge (`src/core/agent/clientTools`), the same bridge that serves
`inspect_design` to the Design agent. Codex receives them as dynamic tools; ACP
and OpenCode agents register a stdio MCP server (`task-monki-preview-tools`,
`task_monki_preview`) whose grant is bound to the active run.

- `inspect_preview` with `what: "status"` returns the configuration file name,
  each run with its services and outcome, the requirements that block a start,
  the failure diagnosis and the proposal under review. `what: "logs"` returns
  the last lines of a run's output, optionally for one service. Logs are
  Previewhost's redacted output; file contents are not repeated because the
  agent reads the worktree directly.
- `propose_preview_configuration` submits a complete `preview.yaml` with a
  summary and notes. `PreviewRecipeGenerationService.propose` validates it and
  returns the exact problems when it is rejected, so the agent repairs and
  resubmits in the same turn. A valid proposal becomes the task's draft and the
  renderer opens it in Configuration with a diff.

The agent reads the task worktree with its normal file tools, under the same
read-only boundary as the task agent's analysis runs. The instructions forbid
reading `.env` files and credential files; configuration values that are secret
are always written as secret references. These file-reading instructions are
not a filesystem access control: the provider can read files in its analysis
scope. Task Monki does not supply stored secret values to its Preview tools.

## Validation and acceptance

Validation uses Previewhost's `parsePreviewSpec` after strict YAML 1.2 parsing.
Drafts are limited to 64 KiB. Aliases, merge keys, tags, duplicate keys,
`fromEnv` inputs, runtime identities as names, secret-like literal environment
values, implicit package acquisition (`npx`, `npm exec`, `dlx`), and commands
that conflict with trusted framework facts are rejected with the reason.
`PreviewFrameworkCapabilities` derives the trusted Next.js command and lockfile
installation job from the root manifest and lockfile; proposals that run Next.js
must use that command, keep its review comment, and depend on exactly one
installation job.

A proposal lives in main-process memory until it is saved or discarded. The
service keeps the original file bytes and the framework facts it validated
against; the editor revalidates edits against the same facts, and **Save**
compares the reviewed bytes before replacing the file atomically. A file that
appeared or changed since the proposal refuses the save. Acceptance never
approves or starts the application. Discarding, task deletion and shutdown drop
the draft.

Preview turns use the existing repository-integrity comparison before proposals are accepted and after the turn ends. A changed or unverifiable worktree fails the analysis, discards its proposal, and holds queued messages. Changes remain in place for inspection. This detects persistent repository changes; it does not provide filesystem confinement or undo external effects. Saving a proposal waits for the active turn to finish and rechecks the repository baseline.

## Hosts

The client-tool bridge is configured in every host
(`clientToolMcpExecutablePath`, `clientToolMcpServerPath`,
`clientToolCredentialRoot`); the packaged app ships
`client-tool-mcp-server.mjs` beside its resources. Messages reach the main
process through `preview:agent:send` and `preview:agent:stop`
(`/api/preview/agent/send`, `/api/preview/agent/stop` in the development host).
