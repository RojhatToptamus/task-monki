# Development Seed Data

Task Monki ships a deterministic local seed workflow for UI and workflow
testing. Use it whenever a change needs a specific task, review, Git, GitHub,
interaction, or completion-policy state.

## Contract

The deterministic identifiers are scenario slugs and the generated manifest,
not store IDs. `FileTaskStore` owns UUIDs and timestamps, so agents must read
`.local/task-monki-dev-seed/manifest.json` to map a stable slug to the task ID
created for that run.

The seed generator writes current-schema Task Monki records through store APIs:
tasks, iterations, worktrees, runs, interaction requests, Git snapshots, GitHub
rollups, artifacts, and domain events. It does not patch task projections by
hand.

## Usage

```sh
npm run dev:seed
source .local/task-monki-dev-seed/dev-api.env
npm run dev:api
npm run dev:renderer
```

The browser renderer uses the Vite same-origin `/api` proxy. `dev:api` writes a
short-lived private proxy token outside the repository, and Vite reads it on
each request, so restart the API without copying credentials into the browser
or an environment file. Use the printed `127.0.0.1` renderer URL; other origins
are rejected. If the default ports must change, export the same
`TASK_MANAGER_API_PORT` and `TASK_MANAGER_RENDERER_PORT` values in both
terminals.

`npm run dev:seed` resets only the seed-owned root and then prints the same
environment variables written to `dev-api.env`:

- `TASK_MANAGER_STORE_DIR`
- `TASK_MANAGER_APP_SETTINGS_PATH`
- `TASK_MANAGER_REPO_PATH`
- `TASK_MANAGER_WORKTREE_ROOT`
- `TASK_MANAGER_PREVIEW_ROOT`
- `TASK_MANAGER_PREVIEW_RECONCILE=0` (keeps synthetic preview UI states intact;
  normal product/dev runs reconcile by default)
- `TASK_MANAGER_DETERMINISTIC_SEED=1` (keeps the live Codex provider inert so
  synthetic provider records cannot start or recover real agent work)

The seed manifest and environment file are forced to mode `0600`.

The browser development host always forces agent network access and external
Codex tools off. When the deterministic seed flag is present, it also skips
provider startup and reports that explicit disabled reason through provider
preflight and any attempted run action. Unset the seed environment before using
the development host for live, local-only Codex work.

The default seed root is `.local/task-monki-dev-seed`, which is ignored by git.
Reset safety is marker-based: non-empty directories without the Task Monki seed
marker or manifest are refused.

## Scenario Coverage

The catalog in `src/dev/seedData.ts` covers the important UI and workflow
states:

- board setup: backlog, ready, clean/missing/error worktrees
- agent lifecycle: running, approval, user input, interrupted, runtime lost,
  ambiguous mutation, stale interaction
- Codex review: not run, running, passed, needs changes, inconclusive, failed,
  canceled, stale after follow-up, active follow-up
- delivery without PR: Git not inspected, clean, dirty, conflicted,
  unavailable, unknown, branch publish in progress, retryable failure,
  remote-newer failure, branch pushed without PR
- PR Status: draft, open, pending/failed/canceled checks, no required checks,
  GitHub review waiting, changes requested, ready to merge, merged, closed
  without merge, stale evidence, local changes not pushed, PR newer commits,
  branch diverged
- completion policy: `MERGED_AND_VERIFIED` with failing, stale, and passing
  checks, plus `MANUAL` with a merged PR
- terminal workflow: fork alternative, canceled, archived
- preview: missing recipe, approval required, preparing, ready, failed, stale,
  stopped, recovery required, and cleanup incomplete

Each task title starts with `[seed:<slug>]`, so the UI can be searched by slug.

## Extending

When a UI change needs a state that is not represented, extend the seed catalog
instead of manually constructing state in the app:

1. Add a scenario definition in `DEV_SEED_SCENARIOS`.
2. Add a builder path that uses `FileTaskStore` APIs and domain events.
3. Add or update `src/dev/seedData.test.ts` to assert the resulting selector or
   view-model output.
4. Regenerate with `npm run dev:seed` and test the UI against the new slug.

`scripts/serve-readme-screenshot-data.mjs` is screenshot-only legacy fixture
data. It is not the authoritative workflow seed path.
