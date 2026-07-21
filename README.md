<p align="center">
  <img src="./public/assets/brand/monkey_icon_charcoal.svg" width="96" alt="Task Monki logo" />
</p>

<h1 align="center">Task Monki</h1>

![Task Monki dashboard](./.github/assets/task-monki-dashboard-dark.jpg)

<p align="center">
  <a href="https://youtu.be/guk2EJC5Jzw">
    <img
      src="./.github/assets/watch-demo.svg"
      alt="Watch the Task Monki demo"
      width="230"
    />
  </a>
</p>


## Why Task Monki

Task Monki started during the Codex Community Build and continued to grow during Codex Build Week Vienna.

The idea came from a problem I kept running into while working with coding agents. The agents could implement tasks quickly, but managing several of them at the same time was still very manual. I had to open each worktree separately, run the right commands, start local services and containers, check the result, review the changes, and follow the pull request status across different tools.

I wanted one place where agents could work on multiple tasks in parallel while I could see what each one was doing, preview every result separately, request a review, send issues back for correction, and follow the task all the way to the pull request.

## What it is

You create a task with a plain-language prompt, refine it based on the request and repository, and choose the runtime, model, and permission mode you want to use.

Each task gets its own Git branch and worktree, so several agents can work on the same repository in parallel without affecting one another or the main checkout. Task Monki keeps these tasks together in one Kanban-style workspace, where you can follow plans, progress, tool activity, logs, and file changes.

When the implementation is ready, you can run the worktree as its own local preview, request an independent agent review, send findings back for correction, inspect the Git diff and collected evidence, and open a draft pull request without leaving the app.

Task records, worktrees, and evidence stay on your machine. Agent work is delegated to an installed and authenticated runtime. Codex App Server and OpenCode use their native protocols, while supported ACP agents connect through the Agent Client Protocol.

Task Monki keeps what an agent reports separate from what it verifies locally. Agent plans and completion messages are shown as runtime output, while Git inspection and GitHub synchronization provide the delivery evidence.

## Workflow

1. **Create a task** — select a repository, write the request, and choose the runtime, model, and permissions.
2. **Prepare the worktree** — Task Monki creates an isolated branch and Git worktree for the task.
3. **Run the agent** — follow the plan, tool activity, approvals, logs, and file changes while the agent works.
4. **Inspect and test** — review the Git diff, test results, and collected logs.
5. **Request a review** — ask another agent to inspect the implementation and report any problems.
6. **Send back fixes** — return review findings, failed tests, or failed checks to the original agent without creating a new task.
7. **Preview the result** — launch the worktree in its own local environment and test the actual application.
8. **Deliver the change** — commit the result, publish the branch, open a draft pull request, and monitor the workflow checks.

## Local previews

Each worktree can run as its own local preview. Task Monki can generate a reviewable `.taskmonki/preview.yaml`, prepare dependencies and services, and launch each implementation in a separate environment.

This lets you test several tasks at the same time without manually opening terminals, assigning ports, or setting up containers for every worktree.

See the [Preview Guide](docs/PREVIEW_GUIDE.md) for setup, examples, and troubleshooting.

## Discourse

Discourse lets you ask questions with repository context in three different ways.

- **Direct** works like a standard agent chat.
- **Panel** asks several agents to answer independently, so you can compare different approaches.
- **Team** starts with an answer from a Lead, while Skeptic and Verifier agents challenge its assumptions and evidence. The Lead can then revise or defend the answer.

The original answer, criticism, and correction remain visible in the same conversation.

See the [Discourse workflow](docs/workflows/GENERAL_AGENT_DISCOURSE_LIFECYCLE.md) for more details.

## Supported providers

Task Monki currently supports Codex(Recommended provider), OpenCode, Cursor, Grok, and the Claude ACP bridge(Experimental).

## Built with Codex

Task Monki started during the Codex Community Build with GPT-5.5 and continued during Codex Build Week with GPT-5.6. I used the Codex app and separate Git worktrees to build and test larger features in parallel.

With GPT-5.6, I added multi-provider support, Git and GitHub integration, local previews, agent reviews, follow-up fixes, Discourse, and a major UI refactor. I used GPT-5.6 Ultra for the multi-provider implementation because it affected a large part of the codebase. Browser Use, Computer Use, and Playwright were used to test complete workflows in the real application, including the demo recording.

## Install

Download the latest desktop build from [GitHub Releases](https://github.com/RojhatToptamus/task-monki/releases).

Task Monki is primarily developed and tested on macOS. Experimental builds are also available for Windows and Linux, but they have not yet been tested as extensively.

Task Monki runs locally and requires Git and at least one installed and authenticated agent runtime, such as Codex CLI. GitHub CLI is only needed for branch publishing, pull requests, and GitHub checks. Docker is only needed for previews that use managed services or Docker Compose.

### macOS Guide

Task Monki is currently an unsigned alpha release. It is ad-hoc signed for bundle integrity, but it is not yet signed with an Apple Developer ID or notarized. macOS may block it on the first launch.

If this happens:

1. Try opening Task Monki once.
2. Open **System Settings → Privacy & Security**.
3. Scroll down to the **Security** section.
4. Click **Open Anyway** next to Task Monki.
5. Confirm with your password or Touch ID.

If **Open Anyway** does not appear, or the app starts without showing a window, quit Task Monki and run:

```sh
xattr -dr com.apple.quarantine "/Applications/Task Monki.app"
open "/Applications/Task Monki.app"
```

If Task Monki is installed somewhere else, update the path accordingly.

## Run from source

Source builds require Node.js 20 or newer, npm, Git, and at least one installed and authenticated agent runtime for live tasks.

Clone the repository, install the dependencies, and start the desktop app:

```bash
git clone https://github.com/RojhatToptamus/task-monki.git
cd task-monki
npm install
npm start
```

This builds and opens the Electron desktop application.

GitHub CLI is optional. To use branch publishing, pull requests, and GitHub checks, install it and authenticate with:

```bash
gh auth login
```

## Inspect the seeded UI

For a quick look at the interface without running live agents, Task Monki includes deterministic seed data with disposable repositories and synthetic tasks covering different workflow states.

Generate the seed:

```sh
npm run dev:seed
```

Start the API in the first terminal:

```sh
source .local/task-monki-dev-seed/dev-api.env
npm run dev:api
```

Start the renderer in a second terminal:

```sh
npm run dev:renderer
```

Then open:

```text
http://127.0.0.1:5173
```

The seed resets only `.local/task-monki-dev-seed` and disables live agent execution.

See the [Development Seed Data guide](docs/DEV_SEEDING.md) for more details.

## Checks

```bash
npm run typecheck && npm test && npm run build && npm run check:codex-protocol
```

## Status

Task Monki is experimental and focused on one thing: a reliable local review loop with isolated implementation, inspectable evidence, and human-controlled GitHub delivery. It runs real local processes and Git operations, so use it only with repositories you can recover — never with untrusted prompts or repositories. Interfaces and stored data formats may still change.
