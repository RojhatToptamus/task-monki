<p align="center">
  <img src="./public/assets/brand/monkey_icon_charcoal.svg" width="96" alt="Task Monki logo" />
</p>

<h1 align="center">Task Monki</h1>

<p align="center">
  An experimental local task board for running Codex work in isolated Git worktrees.
</p>

<p align="center">
  Built as part of the Codex Community Build.
</p>

![Task Monki dashboard](./.github/assets/task-monki-dashboard-dark.jpg)

> [!WARNING]
> Task Monki is experimental. It runs local commands and can create commits, push branches, and open draft pull requests. Only point it at repositories you can recover, and review every generated change before you ship it.

## What it does

Task Monki turns an implementation prompt into a workflow you can watch. You write a task, it spins up an isolated branch and worktree, lets Codex implement inside it, and tracks what actually happened — separating the work phase you care about from the technical evidence underneath: Git state, Codex activity, tests, and GitHub delivery.

What you can do today:

- Write and refine repository-aware task prompts.
- Give each task its own branch and Git worktree.
- Run Codex inside that worktree as a persistent App Server thread.
- Steer or interrupt an active turn, then continue in the same session.
- Retry in place, or fork an alternative session.
- Launch detached, read-only provider reviews.
- See Codex's plans (and their revisions), usage, reasoning summaries, commands, file changes, tool calls, web searches, and context compaction — each labeled with where it came from.
- Approve or decline command, file, permission, and MCP requests before Codex proceeds.
- Compare the execution settings you asked for against what Codex actually used.
- Keep an audit of resolved, stale, declined, and aborted requests.
- Inspect process output, changed files, Git state, and generated artifacts.
- Run a repository-defined test command and see whether the results are still current.
- Create a delivery commit.
- Detect a GitHub remote, publish the branch, and open a draft pull request.
- Refresh pull-request, check, review, and merge status.

## Local-first, by design

Task Monki runs entirely on your machine. The development API binds to `127.0.0.1`, task state lives in local storage, and every task gets its own Git branch and worktree.

The actual implementation is delegated to your installed, authenticated Codex CLI through a single application-scoped App Server process. Task Monki discovers the available models and reasoning efforts, opens persistent threads in task worktrees, captures the structured protocol activity, and records Git and process evidence on its own. Connectivity and data handling still follow your Codex CLI configuration and account.

A guiding principle runs through the whole task page: it keeps **Reported by Codex** separate from **Verified locally by Task Monki**. Provider plans, usage, reasoning, command results, and completion claims stay marked as provider observations. Only Task Monki's own Git inspection, test runs, and GitHub sync count as local or delivery evidence — the app never lets a provider claim quietly become a verified fact.

When Codex spawns subagents, they show up as an explicit parent/child tree: delegated prompts, requested model and effort, provider status, nested turns, and source-thread labels on approvals. Hierarchy edges are only drawn from provider-supplied thread IDs, and missing or contradictory relationships stay visible rather than being papered over.

GitHub is optional. When you enable it, Task Monki uses local Git and the authenticated `gh` CLI to publish a branch, open a draft pull request, and read delivery status.

## The workflow

1. Create a task with a repository path, prompt, and test command.
2. Prepare the worktree — this creates an isolated `codex/task-*` branch.
3. Start implementation. Codex runs with write access limited to that worktree.
4. Review the diff and execution evidence.
5. Run the local tests yourself.
6. Create a delivery commit, then rerun the tests against the new commit.
7. Open a draft pull request once the branch and evidence are ready.
8. Keep reviewing, locally and on GitHub. Task Monki never merges the pull request for you.

Task data and artifacts are stored locally. The browser dev server uses a temporary store by default; the Electron app uses its application data directory.

## Requirements

- Node.js 20 or newer
- npm
- Git
- [Codex CLI](https://github.com/openai/codex) 0.141.0 or newer, installed and authenticated
- Optional: [GitHub CLI](https://cli.github.com/), installed and authenticated, for branch and pull-request features

The repository you manage must already be a valid local Git repo. GitHub delivery additionally needs a supported remote and an authenticated `gh`:

```bash
gh auth login
```

## Run it locally

Install dependencies:

```bash
npm install
```

### In the browser

Start the local API in one terminal:

```bash
npm run dev:api
```

Start the renderer in another:

```bash
npm run dev:renderer
```

Then open [http://127.0.0.1:5173](http://127.0.0.1:5173).

| Service | Address |
| --- | --- |
| Renderer | `http://127.0.0.1:5173` |
| Local API and event stream | `http://127.0.0.1:3099` |

Handy overrides:

```bash
TASK_MANAGER_API_PORT=3100 \
TASK_MANAGER_REPO_PATH=/path/to/repository \
TASK_MANAGER_STORE_DIR=/tmp/task-monki-store \
npm run dev:api
```

```bash
VITE_TASK_MANAGER_API_URL=http://127.0.0.1:3100 \
npm run dev:renderer -- --port 5174
```

### As a desktop app

Build and launch the Electron app:

```bash
npm start
```

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run check:codex-protocol
```

## Development docs

- [Agent guide](./AGENTS.md) is the first stop for AI agents working in this repo.
- [Docs index](./docs/README.md) explains the curated public docs and what stays private.
- [Product workflow](./docs/PRODUCT_WORKFLOW.md) captures board phases and action rules.
- [App Server architecture](./docs/APP_SERVER_ARCHITECTURE.md) captures the Codex integration boundary.
- [Review lifecycle](./docs/research/CODEX_REVIEW_WORKFLOW_LIFECYCLE.md) is authoritative for Codex review, request-changes, stale-review, and follow-up behavior.

## Generated Codex protocol bindings

The TypeScript bindings in
[`src/core/agent/codex/protocol/generated/`](./src/core/agent/codex/protocol/generated/)
are produced by the official `codex app-server generate-ts` command and checked in so builds stay reproducible — don't edit them by hand.

Check the committed set without rewriting it:

```bash
npm run check:codex-protocol
```

Regenerate only when you're deliberately updating the pinned protocol:

```bash
npm run generate:codex-protocol
npm run check:codex-protocol
```

Then review the diff and update
[`metadata.ts`](./src/core/agent/codex/protocol/metadata.ts) if the pinned runtime or generated hash changed.

## Experimental software and safety

Task Monki is experimental. It launches local processes and performs real Git operations on the repositories you point it at. A few design choices exist specifically to keep that safe:

- Codex implementation turns run with `workspace-write`, network disabled, and `on-request` approvals, scoped to the task worktree.
- Approval responses are matched to the exact App Server instance, thread, turn, item, and request ID. Stale or duplicate responses are rejected.
- Mutating App Server requests are never retried automatically when the outcome is ambiguous.
- After a process is lost, recovery refreshes Git evidence independently and never turns an unknown provider state into success.
- Provider-derived fields show their source, and provider records keep references to the permission-restricted raw protocol journal.
- Provider-reported command output or test claims never overwrite Task Monki's verified local test status.
- Task Monki never silently approves anything, and keeps commits, publication, merges, remotes, and worktree administration behind explicit actions.
- Raw App Server protocol traffic is kept in local, permission-restricted journals for auditability.

Worth keeping in mind:

- The worktree isolates Git changes; it is not a full security boundary.
- Test commands come from task configuration and run locally.
- Commit, push, and draft-PR actions change Git or GitHub state when you trigger them.
- Review generated changes, commands, commits, and PR content before you rely on them.
- Use repositories with clean working state, backups, and recoverable remotes.
- Don't use the app with untrusted prompts, repositories, dependencies, or test commands.

It is not meant for unattended production automation yet.

## Project status

The current focus is a reliable local review loop: isolated implementation, inspectable evidence, explicit tests, and human-controlled GitHub delivery. Interfaces and stored data formats may still change while the project is experimental.
