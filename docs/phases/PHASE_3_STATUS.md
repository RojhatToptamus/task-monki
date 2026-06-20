# Phase 3 Status: GitHub Delivery and Feedback Carry-in

Date: 2026-06-20  
Status: Implemented and verified  
Commit status: Not committed

## 1. Current implementation state

Phase 3 is implemented as a guarded GitHub delivery layer on top of the Phase 2 local evidence model.

The app can now:

- refine a short prompt into a structured implementation prompt using repository context;
- show human-readable activity summaries instead of raw event names as the main timeline surface;
- use global CSS custom properties for the primary visual system;
- create a delivery commit from dirty task-worktree changes;
- require tests to be rerun after delivery commits before publishing;
- detect GitHub remotes from common HTTPS/SSH URL formats;
- check `gh` availability and `gh auth status --hostname github.com` without extracting tokens;
- push a committed task branch after local evidence guards pass;
- generate a PR body artifact from task, test, diff, and Codex evidence;
- create or locate a draft pull request through `gh`;
- fetch and persist PR, check/status, review, and merge evidence separately;
- move to `IN_REVIEW` when a matching open GitHub PR is created or observed;
- guard `IN_REVIEW → DONE` on merge evidence under the default `MERGED` policy.

## 2. Implemented in this update

### Feedback carry-in

Implemented the tasks from `docs/feedback.md`.

#### Human-readable activity

Added:

- `src/renderer/model/eventSummary.ts`
- `src/renderer/model/eventSummary.test.ts`

The activity timeline now displays labels such as `Codex completed`, `GitHub checked`, `Branch pushed`, and `Pull request synced` instead of only raw event constants.

Raw event type remains available as the row title/debug evidence.

#### Refine Prompt

Added:

- `src/core/prompt/PromptRefinementService.ts`
- `src/core/prompt/PromptRefinementService.test.ts`
- API wiring through service, dev server, Electron preload, and renderer client.

The Create Task form now includes a `Refine Prompt` button above the form. The implementation is intentionally lightweight and deterministic:

- reads package metadata and README summary when available;
- turns a short request into sections for goal, repository context, constraints, acceptance criteria, and verification;
- does not introduce a separate prompt workflow product.

#### CSS custom properties and visual cleanup

Updated `src/renderer/styles.css`.

Added global tokens for:

- fonts;
- colors;
- surfaces;
- borders;
- radii;
- spacing;
- shadows.

The UI keeps the existing structure but moves toward a cleaner macOS-style panel/surface system.

### GitHub contracts and persistence

Updated `src/shared/contracts.ts`, `src/core/storage/FileTaskStore.ts`, and `src/core/projection/reducer.ts`.

Added independent technical dimensions for:

- GitHub repository capability;
- branch publication;
- pull request state;
- CI/check rollup;
- review rollup;
- merge state.

Added persisted records for:

- `GitHubRepositoryRecord`;
- `BranchPublicationRecord`;
- `PullRequestSnapshotRecord`;
- `CiRollupRecord`;
- `ReviewRollupRecord`;
- `MergeSnapshotRecord`.

These remain separate from Codex, process, local Git, tests, and workflow phase.

### GitHub service

Added:

- `src/core/github/GitHubService.ts`
- `src/core/github/GitHubService.test.ts`

Implemented:

- GitHub remote URL parsing for HTTPS, SSH scp-style, and SSH URL forms;
- GitHub remote detection from `git remote -v`;
- `gh --version` and `gh auth status --hostname <host>` preflight;
- branch publication through local Git push;
- PR create-or-find flow using `gh pr list`, `gh pr create`, and `gh pr view`;
- PR/check/review/merge rollup parsing.

Rules preserved:

- no `gh auth token`;
- no token extraction or storage;
- no merge/close/delete/repo-setting operations;
- GitHub facts are separate technical truth dimensions.

### Delivery commit and publish guards

Updated `src/core/app/TaskManagerService.ts`.

Added:

- `createDeliveryCommit`;
- `preflightGitHub`;
- `publishBranch`;
- `createPullRequest`;
- `refreshGitHub`.

Important guard:

```text
dirty worktree
  → create delivery commit
  → tests become stale
  → rerun tests against committed HEAD
  → publish branch
  → create/locate PR
```

This avoids pretending dirty worktree changes can be delivered by a PR and preserves the Phase 2 rule that test evidence is bound to the exact Git generation.

### UI/API wiring

Updated:

- `src/dev/server.ts`
- `src/electron/main.ts`
- `src/electron/preload.ts`
- `src/renderer/api/taskManagerClient.ts`
- `src/renderer/ui/App.tsx`
- `src/renderer/ui/TaskCreateForm.tsx`
- `src/renderer/ui/TaskDetail.tsx`
- `src/renderer/ui/TaskList.tsx`
- `src/renderer/ui/EvidencePanel.tsx`
- `src/renderer/ui/StatusBadge.tsx`
- `src/renderer/model/selectors.ts`

The UI now exposes:

- Refine Prompt;
- Create delivery commit;
- Check GitHub;
- branch publication as part of GitHub delivery;
- Create draft PR;
- Refresh GitHub;
- GitHub, Publish, PR, Checks, Reviews, and Merge badges;
- PR URL/head/check/review/merge details in evidence.

## 3. How to view or test

### Automated verification

Run:

```bash
npm run typecheck
npm test
npm run build
```

Expected result:

```text
typecheck: passed
tests: 14 files passed, 30 tests passed
build: passed
```

### Browser dev UI

Terminal 1:

```bash
TASK_MANAGER_STORE_DIR=/private/tmp/task-manager-phase3-dev-store \
TASK_MANAGER_REPO_PATH=/Users/rojhat/Documents/task-manager \
TASK_MANAGER_WORKTREE_ROOT=/private/tmp/task-manager-phase3-worktrees \
TASK_MANAGER_API_PORT=3099 \
node dist-electron/dev/server.js
```

Terminal 2:

```bash
VITE_TASK_MANAGER_API_URL=http://127.0.0.1:3099 \
npm run dev:renderer
```

Open:

```text
http://127.0.0.1:5173/
```

Recommended manual flow:

1. Type a short task request.
2. Click `Refine Prompt`.
3. Create the task.
4. Prepare worktree.
5. Start implementation.
6. Refresh evidence.
7. Run tests from the explicit test evidence action.
8. If Git is `DIRTY`, click `Create delivery commit`.
9. Run tests again because the commit creates a new Git generation.
10. Click `Check GitHub` if you want an explicit preflight.
11. Click `Create draft PR`.
12. Confirm the task moves to `IN_REVIEW` after a matching open PR is created or observed.
13. Use `Refresh GitHub` to update PR/check/review/merge facts.

### Live GitHub safety

This implementation supports live GitHub operations through `gh`, but live GitHub mutation was not run during this implementation pass.

When live testing is authorized, use a clearly labeled temporary task branch/PR and do not merge, close, delete branches, or change repository settings unless explicitly approved.

## 4. Verification evidence

Commands run successfully:

```text
npm run typecheck
npm test
npm run build
```

Test result:

```text
14 test files passed
30 tests passed
```

Focused coverage added:

- prompt refinement returns structured repository-aware prompt sections;
- event summary formatting converts raw events into readable timeline text;
- GitHub remote URL parsing;
- PR/check/review/merge rollup parsing;
- local bare-remote branch publication smoke;
- publish guard blocks stale tests;
- transition guard requires matching PR for `IN_REVIEW` and merge for `DONE`.

## 5. Known limitations

- Live GitHub PR creation/reconciliation was not executed in this pass.
- Required-check rollup is `UNKNOWN` unless branch/rules visibility is available through future integration work.
- `gh pr view --json statusCheckRollup` is used for MVP check data; production should add fuller Checks/status API coverage when moving beyond `gh`.
- Prompt refinement is deterministic and lightweight; it does not call a model yet.
- Test commands remain shell-free; shell syntax such as `&&` is not supported.
- Storage remains file-backed JSON/artifacts.
- GitHub App/webhook relay remains deferred.

## 6. Feedback task status

| Feedback item | Status |
|---|---|
| Human-readable Codex/events logs | Implemented |
| Refine Prompt button above Create Task | Implemented |
| CSS custom properties / modern macOS styling direction | Implemented as first refactor pass |

## 7. Next phase

Recommended next phase:

```text
Phase 4: production hardening and richer GitHub reconciliation
```

Candidate work:

- live GitHub temporary-PR smoke test;
- fuller Checks/status API support;
- required-check/ruleset visibility;
- branch cleanup policy with explicit user approval;
- GitHub App/webhook relay design;
- SQLite migration;
- Codex App Server integration;
- notification and smart stale/conflict views.
