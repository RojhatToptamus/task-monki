# Phase 1 Status: Read-only Codex Run Monitor

Date: 2026-06-20  
Status: Implemented and verified  
Commit status: Not committed

## 1. Phase goal

Build the first working vertical slice:

```text
Task card
  → start real read-only codex exec --json run
  → capture process/stdout/stderr/JSONL events
  → persist run evidence
  → show live and final status in the UI
```

Phase 1 intentionally avoids worktrees, source mutation, tests as delivery gates, commits, pushes, GitHub PR creation, and Codex App Server integration.

## 2. What was implemented

### Application scaffold

- Added a TypeScript, React, Vite, and Electron application scaffold.
- Added separate TypeScript configs for renderer/typechecking and Electron/main-process code.
- Added `package.json` scripts for:
  - `npm run typecheck`
  - `npm test`
  - `npm run build`
  - `npm run dev:renderer`
  - `npm run dev:api`
- Added `.gitignore` entries for generated folders and local scratch artifacts.

### Shared contracts

- Added typed shared contracts for:
  - tasks
  - runs
  - artifacts
  - domain events
  - repository preflight
  - status projections
  - renderer/main API calls
- Kept workflow phase separate from technical truth.

### Runner and process supervision

- Implemented `CodexExecRunner`.
- Implemented read-only Codex command construction:

```bash
codex --ask-for-approval never exec \
  --json \
  --sandbox read-only \
  --cd "$REPO_PATH" \
  -
```

- Prompts are passed through stdin, not interpolated into shell strings.
- Implemented process supervision:
  - PID capture
  - stdout capture
  - stderr capture
  - exit code capture
  - signal capture
  - cancellation path

### Codex JSON/event ingestion

- Implemented Codex stdout ingestion.
- Implemented JSON event parsing for known and unknown event types.
- Preserved raw stdout separately from normalized events.
- Preserved stderr separately.
- Added tolerance for current Codex behavior where some `--json` output can contain malformed or multiline command-output payloads.
- Valid JSON events are normalized into domain events.
- Invalid/non-JSON stdout is retained as raw evidence instead of falsely failing the run.

### Persistence

- Added file-backed Phase 1 storage for:
  - tasks
  - runs
  - domain events
  - artifacts
  - current projections
- Stored artifacts as files instead of large inline database rows:
  - stdout
  - stderr
  - parsed JSONL stream
  - final message artifact
- The storage layer is intentionally isolated so SQLite can replace it later without rewriting UI/business logic.

### Repository preflight

- Added read-only repository validation using Git.
- Captures:
  - repo path
  - repo root
  - branch
  - HEAD SHA
  - remotes
  - validation status

### Projection reducer

- Added a reducer that derives UI-visible status from technical events.
- Current Phase 1 projections include:
  - requested action
  - Codex run status
  - OS process status
  - repository preflight status
  - artifact status
  - health
  - findings
  - summary text

### Electron IPC boundary

- Added Electron main/preload wiring.
- Renderer uses a typed API exposed through preload.
- Renderer does not launch processes directly.
- Business logic stays outside UI components.

### Browser dev bridge

- Added a small local development API bridge for rendered UI verification when Electron cannot run in the current sandbox/headless environment.
- The dev bridge uses the same service, runner, storage, and projection code as the Electron path.

### UI

- Added the Phase 1 UI:
  - task creation form
  - task card list
  - selected task detail view
  - Start run button
  - Cancel button
  - workflow and technical status badges
  - prompt display
  - activity timeline
  - evidence panel
  - final artifact display

## 3. Files added or changed

Main implementation areas:

- `src/shared/contracts.ts`
- `src/core/app/TaskManagerService.ts`
- `src/core/codex/commandBuilder.ts`
- `src/core/codex/jsonlParser.ts`
- `src/core/process/ProcessSupervisor.ts`
- `src/core/projection/reducer.ts`
- `src/core/repository/RepositoryPreflight.ts`
- `src/core/runner/CodexExecRunner.ts`
- `src/core/storage/FileTaskStore.ts`
- `src/electron/main.ts`
- `src/electron/preload.ts`
- `src/dev/server.ts`
- `src/renderer/**`

Project setup:

- `package.json`
- `package-lock.json`
- `index.html`
- `vite.config.ts`
- `tsconfig.base.json`
- `tsconfig.check.json`
- `tsconfig.main.json`
- `public/favicon.svg`
- `.gitignore`

Tests:

- `src/core/codex/commandBuilder.test.ts`
- `src/core/codex/jsonlParser.test.ts`
- `src/core/process/ProcessSupervisor.test.ts`
- `src/core/projection/reducer.test.ts`
- `src/core/runner/CodexExecRunner.test.ts`
- `src/core/storage/FileTaskStore.test.ts`

## 4. Verification results

### Automated checks

These passed:

```bash
npm run typecheck
npm test
npm run build
```

Test result:

```text
6 test files passed
14 tests passed
```

Covered areas:

- command builder
- JSONL parser
- projection reducer
- file storage
- process supervisor
- fake Codex runner

### Real read-only Codex smoke test

A real read-only Codex run was executed through the compiled Phase 1 service.

Result:

```text
terminalObserved: true
workflowPhase: REVIEW
codexRun: COMPLETED
osProcess: EXITED
repositoryPreflight: VALID
artifact: FINAL_MESSAGE_PRESENT
health: HEALTHY
exitCode: 0
signal: null
eventCount: 20
lastEventType: turn.completed
```

The final artifact was persisted under:

```text
/private/tmp/task-manager-phase1-final-smoke-e2c6
```

### Rendered UI smoke test

The rendered UI was verified through the browser dev bridge.

Confirmed visible UI state:

```text
Task: Final Phase 1 smoke
Workflow: REVIEW
Process: EXITED
Codex: COMPLETED
Repository: VALID
Health: HEALTHY
Final artifact: visible
```

Browser console:

```text
0 errors
0 warnings
```

Screenshot evidence was saved outside the repository:

```text
/private/tmp/task-manager-phase1-final-ui.png
```

## 5. How to view or test Phase 1

### Install dependencies

If dependencies are not present:

```bash
npm install --ignore-scripts
node node_modules/electron/install.js
```

The Electron install step downloads the local Electron binary.

### Run automated checks

```bash
npm run typecheck
npm test
npm run build
```

### Run the browser-verifiable development UI

Terminal 1:

```bash
TASK_MANAGER_STORE_DIR=/private/tmp/task-manager-phase1-dev-store \
TASK_MANAGER_REPO_PATH=/Users/rojhat/Documents/task-manager \
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
2. Confirm the repository path is `/Users/rojhat/Documents/task-manager`.
3. Use a read-only prompt such as:

```text
Summarize this repository in one short paragraph. Do not modify files.
```

4. Click `Start run`.
5. Watch the activity timeline.
6. Confirm final status becomes:

```text
Workflow: REVIEW
Process: EXITED
Codex: COMPLETED
Repository: VALID
Health: HEALTHY
```

7. Confirm the final artifact is visible in the evidence panel.

### Run the Electron app

After building:

```bash
npm start
```

Known environment note: in the current sandbox/headless environment, the Electron binary aborts with `SIGABRT`, so rendered verification was done through the browser dev bridge. The Electron main/preload code builds successfully.

### Verify the repository remains unmodified by the read-only Codex run

Before and after the smoke test:

```bash
git -c core.optionalLocking=false status --porcelain=v2 --branch
```

The final smoke test did not add any extra files to the repository. The only uncommitted files are the expected Phase 1 implementation files.

## 6. Known limitations

- Phase 1 uses file-backed storage, not SQLite.
- Electron launch could not be verified in the current sandbox/headless environment because `npx electron --version` aborts with `SIGABRT`.
- The browser dev bridge exists for verification and development; it is not the production architecture.
- No worktrees are created.
- No source mutation is attempted.
- No test runner is integrated into the product UI yet.
- No GitHub PR creation or polling is implemented in the product UI yet.
- No Codex App Server integration is implemented.

## 7. Important implementation note

The real Codex smoke test showed that current `codex exec --json` output can include malformed or multiline command-output payloads. Phase 1 now treats those as raw stdout evidence instead of treating them as terminal run failures.

This behavior is covered by `CodexExecRunner.test.ts`.

## 8. Recommended next step

Commit Phase 1 once reviewed.

After that, plan Phase 2 based on what Phase 1 taught:

- keep the runner/service/storage/projection separation;
- preserve raw evidence;
- keep the dev bridge for fast UI verification;
- introduce isolated Git worktrees carefully;
- continue treating Codex completion as execution evidence, not delivery truth.
