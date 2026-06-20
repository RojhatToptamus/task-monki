# Phase 2 Status: Isolated Mutating Local Delivery Loop

Date: 2026-06-20  
Status: Implemented and verified  
Commit status: Committed and pushed on `main`

## 1. Current implementation state

Phase 2 is implemented as a local isolated delivery loop.

The app can now:

- create a task iteration for implementation work;
- create an app-owned Git branch/worktree for the task;
- run Codex in `workspace-write` mode inside that task worktree;
- keep the main repository checkout unchanged during implementation runs;
- capture Codex/process evidence separately from workflow state;
- inspect worktree Git state after runs;
- persist diff evidence as an artifact;
- run a configured local test command in the task worktree;
- bind test results to the exact Git generation they verified;
- mark prior test results `STALE` when a later Git snapshot changes;
- guard workflow transitions into `REVIEW`;
- keep local tests as a technical evidence badge/action instead of a workflow phase;
- show worktree, Git, test, Codex, process, repository, and health badges in the UI.

GitHub delivery remains intentionally deferred to the next phase.

## 2. Implemented in this update

### Shared status model

Updated `src/shared/contracts.ts` with Phase 2 dimensions:

- workflow phases through `REVIEW`, with tests and PR creation handled as evidence/actions;
- task iterations;
- worktree records;
- Git snapshots;
- test run records;
- run modes: `READ_ONLY_ANALYSIS` and `IMPLEMENTATION`;
- projection fields for worktree, Git, and tests;
- API contracts for preparing worktrees, refreshing evidence, running tests, and guarded transitions.

### Worktree service

Added `src/core/worktree/WorktreeService.ts`.

Implemented:

- branch naming policy: `codex/task-<task-id>-<slug>`;
- app-owned worktree root;
- `git worktree add` wrapper;
- `git worktree list --porcelain -z` parser;
- canonical path comparison for `/tmp` versus `/private/tmp`;
- worktree verification statuses: present, locked, prunable, missing, error.

### Git snapshot and diff evidence

Added `src/core/git/GitSnapshotService.ts`.

Implemented:

- `git status --porcelain=v2 --branch -z` parser;
- head/branch/upstream/ahead/behind capture;
- staged, unstaged, untracked, and conflicted counts;
- commits-ahead-of-base and diff file counts;
- dirty worktree fingerprint;
- operation-in-progress detection;
- diff evidence artifact generation;
- Git rollup statuses including clean, dirty, committed-unpushed, pushed, conflicted, diverged, unavailable, and unknown.

### Local test runner

Added `src/core/test/LocalTestRunner.ts`.

Implemented:

- configurable per-task test command;
- shell-free command parsing;
- process-supervised test execution;
- stdout/stderr artifacts;
- test statuses: queued, running, passed, failed, error, canceled, stale;
- tested `HEAD` and dirty fingerprint binding;
- stale marking when a later Git snapshot changes the generation.

### Store and projections

Updated `src/core/storage/FileTaskStore.ts` and `src/core/projection/reducer.ts`.

Implemented:

- persisted arrays for iterations, worktrees, Git snapshots, and test runs;
- generic text artifacts for diff/test evidence;
- task-current iteration/worktree/test pointers;
- transition-blocked events;
- projection updates for worktree/Git/tests;
- generation-bound stale-test events.

### Service/API orchestration

Updated:

- `src/core/app/TaskManagerService.ts`
- `src/dev/server.ts`
- `src/electron/main.ts`
- `src/electron/preload.ts`
- `src/renderer/api/taskManagerClient.ts`

Implemented API actions:

- `prepareWorktree`
- `startRun` in implementation mode
- `refreshEvidence`
- `runTests`
- `transitionTask`

The service auto-refreshes Git evidence after implementation Codex runs finish.

### Renderer UI

Updated:

- `src/renderer/ui/App.tsx`
- `src/renderer/ui/TaskCreateForm.tsx`
- `src/renderer/ui/TaskDetail.tsx`
- `src/renderer/ui/TaskList.tsx`
- `src/renderer/ui/EvidencePanel.tsx`
- `src/renderer/ui/StatusBadge.tsx`
- `src/renderer/model/selectors.ts`
- `src/renderer/styles.css`

The UI now shows:

- Phase 2 labeling;
- task test command;
- Prepare worktree action;
- Start implementation action;
- Refresh evidence action;
- Run tests action;
- guarded workflow transition buttons;
- worktree/Git/test status badges;
- worktree path, branch, and Git generation;
- diff/test/Codex artifacts in the evidence panel.

## 3. How to view or test

### Run automated verification

```bash
npm run typecheck
npm test
npm run build
```

Expected result:

```text
typecheck: passed
tests: 10 files passed, 22 tests passed
build: passed
```

### Run the browser dev UI

Terminal 1:

```bash
TASK_MANAGER_STORE_DIR=/private/tmp/task-manager-phase2-dev-store \
TASK_MANAGER_REPO_PATH=/Users/rojhat/Documents/task-manager \
TASK_MANAGER_WORKTREE_ROOT=/private/tmp/task-manager-phase2-worktrees \
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

Then:

1. Create a task.
2. Confirm the repository path is correct.
3. Set a safe test command such as `npm test`.
4. Click `Prepare worktree`.
5. Confirm worktree status becomes `PRESENT`.
6. Click `Start implementation`.
7. Wait for Codex/process completion.
8. Click `Refresh evidence` if needed.
9. Confirm Git evidence is visible.
10. Click `Run tests`.
11. Confirm test status becomes `PASSED`, `FAILED`, or `ERROR`.
12. Use review-time actions such as `Run tests` or `Create draft PR`; there is no separate testing or PR-ready card phase.

### Run the isolated service smoke

The implementation was also verified with a temporary Git repository and a fake `codex` binary that writes `PHASE2_SMOKE.txt` into the task worktree.

Smoke result:

```json
{
  "workflowPhase": "REVIEW",
  "worktreeStatus": "PRESENT",
  "gitStatus": "DIRTY",
  "testStatus": "PASSED",
  "mainTouched": false,
  "worktreeTouched": true
}
```

This proves the main checkout remained unchanged while the task worktree received the implementation artifact.

## 4. Verification evidence

Commands run successfully:

```text
npm run typecheck
npm test
npm run build
```

Test coverage added:

- command-line parsing;
- Git worktree porcelain parsing;
- real temporary worktree creation/verification;
- Git porcelain parsing;
- dirty Git snapshot/diff evidence;
- stale-test marking after Git generation changes;
- stale iteration events cannot overwrite the current task projection.

Focused test count:

```text
10 test files
22 tests
```

## 5. Known limitations

- GitHub PR creation/status/check/review/merge integration is not implemented in Phase 2.
- Worktree cleanup is intentionally conservative; the app does not force-remove dirty worktrees.
- Test commands are parsed without a shell, so shell-specific syntax such as `&&` is not supported yet.
- Electron launch itself remains subject to the current sandbox/headless limitation observed in Phase 1; the rendered UI can be verified through the browser dev bridge.
- Storage is still file-backed JSON/artifacts, not SQLite.
- Codex App Server integration remains deferred.

## 6. Next phase

Phase 3 should implement GitHub delivery on top of Phase 2 evidence:

Planning document: `docs/phases/PHASE_3_PLAN.md`

- detect GitHub remote;
- push the task branch;
- create or locate a draft PR;
- fetch PR state;
- fetch check/status rollups for the exact PR head SHA;
- fetch review and mergeability fields;
- persist GitHub observations as separate technical truth dimensions;
- move to `DONE` only when the configured completion policy is satisfied.

Do not treat Codex completion, local tests, or an opened PR as delivery truth.
