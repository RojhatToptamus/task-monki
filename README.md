<p align="center">
  <img src="./public/assets/brand/monkey_icon_charcoal.svg" width="96" alt="Task Monki logo" />
</p>

<h1 align="center">Task Monki</h1>

<p align="center">
  A local task board for running Codex in isolated Git worktrees.
</p>

![Task Monki dashboard](./.github/assets/task-monki-dashboard-dark.jpg)

> [!WARNING]
> Task Monki is experimental. It runs local commands and can create commits, push branches, and open draft pull requests. Point it only at repositories you can recover, and review every change before you ship it.

## What it is

You write a task prompt, Task Monki gives it an isolated branch and Git worktree, and Codex implements inside it. You watch the work happen, inspect the diff, review local Git evidence, and open a draft pull request when it's ready — all from one board on your machine.

It runs entirely locally. Codex work is delegated to your own installed, authenticated [Codex CLI](https://github.com/openai/codex); Task Monki tracks the Git and GitHub delivery evidence itself. It never merges a pull request for you.

A key principle: Task Monki keeps what **Codex reports** separate from what it has **verified locally**. Provider plans, usage, and completion claims are always marked as such — only Task Monki's own Git inspection and GitHub sync count as verified delivery evidence.

## How it works

1. **Create a task** — pick a repository, write a prompt, and choose Codex settings.
2. **Prepare the worktree** — creates an isolated `codex/task-*` branch.
3. **Start implementation** — Codex runs with write access scoped to that worktree.
4. **Inspect** — review the diff, commands, file changes, and approvals.
5. **Review** — run Codex review or request follow-up changes when needed.
6. **Commit** — create a delivery commit when the local diff is ready.
7. **Ship** — open a draft pull request once the branch and GitHub evidence are ready.

You can steer or interrupt a run mid-turn, follow up in the same session, retry, or fork an alternative attempt.

## Install

Download the latest desktop build from [GitHub Releases](https://github.com/RojhatToptamus/task-monki/releases/latest) and pick the asset for your platform (macOS, Windows, or Linux).

Builds are currently unsigned, so macOS and Windows may show a security warning on first launch. There's no auto-updater yet — to update, download and install the newer release.

**Prerequisites** (Task Monki does not bundle these):

- Git
- [Codex CLI](https://github.com/openai/codex) 0.141.0+, installed and authenticated
- Optional — [GitHub CLI](https://cli.github.com/), authenticated, for branch and pull-request features (`gh auth login`)

Packaged apps look for these on your PATH. If one is installed somewhere unusual, set a custom path in Settings.

## Run from source

Install a release unless you're developing Task Monki itself. Source builds need Node.js 20+ and npm.

```bash
npm install
```

**Desktop app:**

```bash
npm start
```

**Browser** (two terminals):

```bash
npm run dev:api        # local API on http://127.0.0.1:3099
npm run dev:renderer   # renderer on http://127.0.0.1:5173
```

Then open [http://127.0.0.1:5173](http://127.0.0.1:5173).

**Checks:**

```bash
npm run typecheck && npm test && npm run build && npm run check:codex-protocol
```

## Status

Task Monki is experimental and focused on one thing: a reliable local review loop with isolated implementation, inspectable evidence, and human-controlled GitHub delivery. It runs real local processes and Git operations, so use it only with repositories you can recover — never with untrusted prompts or repositories. Interfaces and stored data formats may still change.
