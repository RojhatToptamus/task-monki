# Phase 5 Status: Native macOS UI Redesign

Date: 2026-06-20  
Status: Implemented and verified  
Commit status: Not committed

## 1. Current implementation state

Phase 5 applies the UI redesign from `docs/UI_REDESIGN_PLAN.md`.

The app keeps the existing architecture and status model. This update is a presentation and interaction-hierarchy pass:

- no workflow contract changes;
- no persistence changes;
- no runner changes;
- no GitHub integration changes.

## 2. Implemented in this update

### Native macOS token system

Updated `src/renderer/styles.css`.

Changes:

- replaced the old gradient/glow palette with flat macOS-style surfaces;
- switched to the system SF font stack first;
- reduced radii to native-feeling control and panel sizes;
- removed panel shadows and decorative glow treatments;
- added a light-mode token track through `prefers-color-scheme`;
- kept one flat blue accent for primary action and selection.

### Cleaner app shell and sidebar

Updated:

- `src/renderer/styles.css`
- `src/renderer/ui/App.tsx`
- `src/renderer/ui/TaskCreateForm.tsx`
- `src/renderer/ui/TaskList.tsx`

Changes:

- narrowed the sidebar to a Codex-like proportion;
- removed the stale `Phase 2` UI label;
- changed `Task cards` to `Tasks`;
- removed default placeholder task content from the create form;
- reduced task-card badges to the most useful queue signals;
- removed noisy visual treatments from cards and empty states.

### Side-by-side task workspace

The left workspace now places New task and Tasks beside each other instead of stacking the task list below the form.

The task form was tightened for production use:

- moved Refine beside the Prompt label;
- reduced prompt height while preserving vertical resizing;
- improved field spacing and visual hierarchy;
- added a compact footer with the primary Create task action;
- gave the task list its own bounded scrolling column;
- retained a stacked responsive layout for narrow windows.

### Action hierarchy

Updated `src/renderer/ui/TaskDetail.tsx`.

Changes:

- replaced the wall of equal-weight buttons with one contextual primary action;
- made `Create draft PR` the primary action while a task is in `REVIEW`;
- grouped secondary actions into a quieter row;
- removed the separate workflow instruction panel and explanatory note copy;
- kept actions wired to the existing handlers and guards.

### Quieter status system

Updated:

- `src/renderer/ui/StatusBadge.tsx`
- `src/renderer/styles.css`

Changes:

- changed status badges from pill blocks to dot + label/value rows;
- kept existing status-to-tone mapping;
- reduced color saturation and visual weight.

### Task detail status and prompt density

Updated:

- `src/renderer/ui/TaskDetail.tsx`
- `src/renderer/ui/StatusBadge.tsx`
- `src/renderer/styles.css`

Changes:

- promoted current health and its matching summary/finding below the task title;
- grouped technical state into Workflow, Local, and Delivery rows;
- collapsed inactive delivery fields until branch or PR delivery begins;
- used hollow indicators for inactive evidence without removing the underlying status;
- kept the full prompt collapsed by default with an explicit Show/Hide control;
- left task metadata visible while the prompt is collapsed.

This remains presentation-only and preserves the existing workflow and technical evidence model.

### Production copy cleanup

Removed or tightened stale, unnecessary, or confusing UI copy:

- no phase/version label in the sidebar;
- no testing/PR-ready instructional note panel;
- no marketing-style hero typography;
- no decorative warnings or explanatory product copy where direct labels are enough.

## 3. How to view or test

### Browser dev UI

Terminal 1:

```bash
TASK_MANAGER_STORE_DIR=/private/tmp/task-manager-phase5-dev-store \
TASK_MANAGER_REPO_PATH=/Users/rojhat/Documents/task-manager \
TASK_MANAGER_WORKTREE_ROOT=/private/tmp/task-manager-phase5-worktrees \
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

1. Sidebar title reads `Task Manager`; no phase label is shown.
2. New-task form starts empty and uses direct production copy.
3. New task and Tasks render as adjacent columns on a wide window.
4. The form uses a compact prompt field with Refine beside its label.
5. Task cards show a compact status set.
6. Selected-task header shows one primary contextual action.
7. In `REVIEW`, `Create draft PR` is the primary action.
8. Secondary actions are visually quieter and grouped.
9. Current health and its summary appear directly below the task title.
10. Statuses are grouped into Workflow, Local, and Delivery.
11. Inactive delivery state is condensed to `Delivery not started`.
12. The Prompt panel starts collapsed and can be expanded without hiding task metadata.
13. Status badges render as dot + label/value, not heavy pills.
14. Panels use flat surfaces and hairline borders without decorative gradients or glows.

### Verification commands

Run:

```text
npm run typecheck
npm test
npm run build
```

Expected result:

```text
typecheck: passed
tests: passed
build: passed
```

## 4. Verification evidence

Commands run successfully:

```text
npm run typecheck
npm test
npm run build
```

Result:

```text
typecheck passed
14 test files passed
35 tests passed
build passed
```

The initial rendered browser smoke could not use the in-app browser because its sandbox metadata was unavailable.

The side-by-side task workspace update was subsequently verified with the local browser fallback at `http://127.0.0.1:5174/`:

- New task and Tasks rendered as adjacent columns;
- the form remained compact with the task list visible;
- the detail pane switched to its narrow-container layout without title or evidence-column crowding;
- the page reported no browser console errors or warnings.

## 5. Known limitations

- Browser smoke validation remains pending because the in-app browser runtime failed before page navigation in this environment.
- The action group is implemented as visible grouped secondary buttons, not a dropdown overflow menu. This keeps behavior simple and avoids new interaction state.
