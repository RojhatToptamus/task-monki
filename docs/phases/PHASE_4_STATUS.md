# Phase 4 Status: Review-to-PR Workflow Simplification

Date: 2026-06-20  
Status: Implemented and verified  
Commit status: Not committed

## 1. Current implementation state

Phase 4 removes `TESTING` and `PR_READY` as workflow phases.

Tests and PR readiness are now technical evidence/actions, not cards. The human-facing workflow is:

```text
READY → IN_PROGRESS → REVIEW → IN_REVIEW → DONE
```

`REVIEW` is the decision point:

- create a draft PR when the implementation is acceptable;
- run tests if useful before PR creation;
- give feedback and start another implementation pass when changes are needed.

## 2. Implemented in this update

### Removed TESTING and PR_READY card phases

Updated:

- `src/shared/contracts.ts`
- `src/core/storage/FileTaskStore.ts`
- `src/core/projection/reducer.ts`
- `src/renderer/ui/TaskDetail.tsx`
- `src/renderer/ui/StatusBadge.tsx`

Changes:

- removed `TESTING` from `WorkflowPhase`;
- removed `PR_READY` from `WorkflowPhase`;
- removed `Move to TESTING` and `Move to PR_READY` from the UI;
- stopped test-run events from changing workflow phase;
- stopped test-run creation from mutating `workflowPhase` or `phaseVersion`;
- removed compatibility normalization for old `TESTING`/`PR_READY` phases.

### Made draft PR creation the review-time delivery action

Updated:

- `src/core/app/TaskManagerService.ts`
- `src/renderer/model/selectors.ts`
- `src/renderer/ui/TaskDetail.tsx`
- `src/renderer/ui/App.tsx`

Changes:

- `Create draft PR` is available from review once a worktree exists;
- the normal UI no longer requires a separate `Publish branch` click;
- `createPullRequest` now publishes the task branch automatically when needed;
- if the task worktree is dirty, publishing creates a delivery commit automatically before pushing;
- local tests are no longer a hard blocker for creating a draft PR;
- GitHub PR creation still moves the task to `IN_REVIEW` after a matching open PR is created or observed.

### Kept tests as explicit evidence

The `Run tests` action remains available when a worktree is present and no test run is active.

Tests are shown through the Tests badge and evidence panel. They can inform review, but missing/stale/failed local tests do not block creating a draft PR.

### Fixed user-facing delivery messaging

The previous blocker:

```text
Run local tests before PR_READY. Use the Run tests action to create current-generation local test evidence.
```

is removed because `PR_READY` no longer exists.

The expected delivery path is now:

```text
Review implementation → Create draft PR → app publishes branch/opens PR → IN_REVIEW
```

## 3. How to view or test

### Browser dev UI

Terminal 1:

```bash
TASK_MANAGER_STORE_DIR=/private/tmp/task-manager-phase4-dev-store \
TASK_MANAGER_REPO_PATH=/Users/rojhat/Documents/task-manager \
TASK_MANAGER_WORKTREE_ROOT=/private/tmp/task-manager-phase4-worktrees \
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

Expected UI behavior:

1. Select or create a task.
2. Confirm the workflow type has no `TESTING` or `PR_READY` card phase.
3. Confirm the guarded workflow panel only offers `Move to REVIEW`.
4. Prepare a worktree and complete implementation.
5. In `REVIEW`, click `Create draft PR`.
6. Confirm the app creates a delivery commit if needed, publishes the branch if needed, creates or finds a draft PR, records the PR link, and moves the task to `IN_REVIEW`.
7. Use `Refresh GitHub` to update PR/check/review/merge facts.

### Regression tests

Focused tests cover:

- draft PR publication readiness no longer requires local test evidence;
- draft PR publication readiness still blocks when there are no committed task changes;
- test-run creation does not mutate workflow phase;
- projection reducer keeps test execution as evidence without moving workflow phase;
- activity log summarizes PR evidence as the delivery event;
- `IN_REVIEW` still requires a matching open PR.

Commands run:

```text
npm test -- --run src/core/app/TaskManagerService.phase3.test.ts src/core/storage/FileTaskStore.phase2.test.ts src/core/projection/reducer.test.ts src/renderer/model/eventSummary.test.ts
npm run typecheck
npm test
npm run build
```

Expected result:

```text
focused tests: passed
typecheck: passed
full tests: passed
build: passed
```

## 4. Verification evidence

Focused verification passed:

```text
5 focused test files passed
16 focused tests passed
typecheck passed
```

Full-suite and build verification passed:

```text
14 test files passed
33 tests passed
build passed
```

## 5. Known limitations

- Rendered browser smoke remains pending because the in-app browser runtime failed before page navigation in this environment.
- Feedback-specific UI is still basic: a human can start another implementation pass, but there is not yet a dedicated structured “request changes” form.
- Live GitHub draft PR creation has not been rerun in this final simplified flow.

## 6. Next step

Run a live GitHub temporary-PR smoke test for:

```text
REVIEW → Create draft PR → IN_REVIEW
```

Use a clearly labeled temporary branch/PR and do not merge, close, delete branches, or change repository settings unless explicitly approved.
