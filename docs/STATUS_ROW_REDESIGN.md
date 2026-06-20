# Status Row Redesign

**Scope:** The status section in the task detail view — currently `.status-strip` in [`TaskDetail.tsx:184-199`](../src/renderer/ui/TaskDetail.tsx#L184-L199). This is a focused spin-off of the broader [UI redesign plan](./UI_REDESIGN_PLAN.md); it covers only the 14-badge status row.

**Nature of change:** Presentation only. No change to `toneForValue` ([`StatusBadge.tsx`](../src/renderer/ui/StatusBadge.tsx)), the projection reducer ([`reducer.ts`](../src/core/projection/reducer.ts)), or the contract ([`contracts.ts`](../src/shared/contracts.ts)). Same data, better organized.

---

## 1. The problem

The current row renders **14 equal-weight items in one wrapping line**. Every dimension has identical size, dot treatment, and priority, so the eye has no entry point and the most important field is impossible to find at a glance.

```
● Workflow REVIEW   ● Worktree PRESENT   ● Git DIRTY   ● Tests NOT_RUN   ● GitHub READY
● Publish NOT_PUSHED   ● PR UNLINKED   ● Checks NOT_APPLICABLE   ● Reviews NOT_APPLICABLE
● Merge NOT_APPLICABLE   ● Process EXITED   ● Codex COMPLETED   ● Repository VALID   ● Health BLOCKED
```

Three distinct issues:

1. **No grouping** — unrelated dimensions sit side by side.
2. **Dead states are noise** — `NOT_APPLICABLE` / `NOT_PUSHED` / `UNLINKED` take full-size slots while carrying "nothing here yet."
3. **The verdict is buried** — `Health BLOCKED` (the reason the task is stuck) is last, same size as everything else.

---

## 2. Change 1 — Promote `Health` to a verdict line (highest priority)

`health` is **not a peer** of the other 13 fields. The reducer derives it as a roll-up across all of them ([`reducer.ts:344-411`](../src/core/projection/reducer.ts#L344-L411)): `maxHealth(...)` aggregates warnings/errors, transition-block sets `BLOCKED`, failures set `ERROR`. So `Health BLOCKED` is the single-glance summary of *why the task is where it is* — and it currently sits at position 14.

**Suggestion:** Remove `Health` from the strip and render it as one verdict chip directly under the H1, paired with the top finding message.

```
Summarize this repository
● Blocked · Run local tests before PR_READY.
```

- Chip color from health tone: `BLOCKED`/`ERROR` → danger, `WARNING` → warning, `INFO`/healthy → success/neutral.
- The Findings panel keeps the full list; this is just the one-line verdict.
- Smallest change, biggest clarity gain.

---

## 3. Change 2 — Group the remaining badges

The 13 remaining fields are already three logical clusters in the contract ([`contracts.ts:230-243`](../src/shared/contracts.ts#L230-L243)). Render them as three labeled groups instead of one flat strip.

| Group | Fields | Meaning |
| --- | --- | --- |
| **Local** | Worktree, Git, Tests, Process, Codex | State on this machine / the run |
| **Remote** | GitHub, Publish, PR, Checks, Reviews, Merge | The PR delivery pipeline |
| **Workflow** | Workflow phase, Repository | Where the task sits + repo preflight |

```
LOCAL     ● Worktree PRESENT   ● Git DIRTY   ○ Tests NOT_RUN   ● Process EXITED   ● Codex COMPLETED
REMOTE    ● GitHub READY   ○ Publish NOT_PUSHED   ○ PR UNLINKED   · Checks —   · Reviews —   · Merge —
WORKFLOW  ● Phase REVIEW   ● Repository VALID
```

- Group label: muted, ~11px, left-aligned, sentence or small-caps (kept quiet — it encodes real structure, not decoration).
- Each group is its own flex-wrap row, so the layout stays responsive.

---

## 4. Change 3 — De-emphasize inactive states

Checks / Reviews / Merge read `NOT_APPLICABLE` and Publish / PR read `NOT_PUSHED` / `UNLINKED` only because no PR exists yet. They're correctly toned `neutral` already, but they still compete with live data for attention.

Pick either (or both):

- **Hollow vs. filled dot:** active states use a filled dot (`●`); neutral / `NOT_*` / `UNLINKED` values use a hollow dot (`○`) and dimmer text. Pure CSS on the existing tone class — recedes without disappearing.
- **Collapse the Remote group until a PR exists:** when `branchPublication === NOT_PUSHED` and `githubPullRequest === UNLINKED`, show a single muted line instead of six badges:
  ```
  REMOTE    GitHub READY · delivery not started
  ```
  Expand to full badges once a branch is pushed / PR is linked.

With Health promoted and inactive items recessed, the strip drops from 14 noisy items to ~6–8 meaningful ones.

---

## 5. Before / after

```
BEFORE (one flat row, 14 items)
● Workflow REVIEW  ● Worktree PRESENT  ● Git DIRTY  ● Tests NOT_RUN  ● GitHub READY
● Publish NOT_PUSHED  ● PR UNLINKED  ● Checks NOT_APPLICABLE  ● Reviews NOT_APPLICABLE
● Merge NOT_APPLICABLE  ● Process EXITED  ● Codex COMPLETED  ● Repository VALID  ● Health BLOCKED

AFTER
Summarize this repository
● Blocked · Run local tests before PR_READY.

LOCAL     ● Worktree PRESENT   ● Git DIRTY   ○ Tests NOT_RUN   ● Process EXITED   ● Codex COMPLETED
REMOTE    ● GitHub READY · delivery not started
WORKFLOW  ● Phase REVIEW   ● Repository VALID
```

---

## 6. Implementation notes

- All changes live in [`TaskDetail.tsx`](../src/renderer/ui/TaskDetail.tsx) (the `.status-strip` JSX) plus CSS in [`styles.css`](../src/renderer/styles.css).
- `StatusBadge` stays as-is for the active badges; the hollow-dot variant is a CSS modifier driven by the existing resolved tone (`neutral`).
- The verdict chip can reuse `StatusBadge` tone logic or be a small purpose-built element — either way it reads `task.projection.health` and the first `task.projection.findings` entry.
- No new data is required: every value shown already exists on `task.projection`.

## 7. Suggested order

1. Promote `Health` to the verdict line.
2. Group into Local / Remote / Workflow rows.
3. De-emphasize inactive states (hollow dot + collapse Remote).
