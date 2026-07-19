# PR Status Card Flow

Date: 2026-07-02

This document describes the current Task Monki PR Status implementation and
delivery workflow. The card is rendered by `PrStatusCard` in
`src/renderer/ui/TaskDetail.tsx`, driven by
`buildPrStatusViewModel` and `buildPrStatusActionState` in
`src/renderer/model/prStatus.ts`.

## Product Contract

PR Status is the single GitHub delivery surface in the task detail Overview.
It answers:

- does this task have a linked PR?
- is the local worktree ahead of the PR, behind it, dirty, stale, or diverged?
- are GitHub checks passing, pending, canceled, blocked, or failing?
- is GitHub review waiting or requesting changes?
- is GitHub reporting the PR mergeable, merged, or closed without merge?
- which GitHub delivery action is currently valid?

Finish remains local acceptance. It owns `Commit`, `Mark done`, and
`Mark done anyway`. It does not render `Create draft PR` or `Push update`.

Activity Timeline may render below PR Status as supporting task context. It may
summarize meaningful delivery changes such as first PR availability, branch
publication failure, check verdict changes, GitHub review decisions, and merge
outcomes. It must not log `Refresh GitHub` clicks or unchanged PR/check/review
captures. PR Status remains the place to inspect current delivery state and run
GitHub delivery actions.

## Source Of Truth

Task Monki owns workflow and evidence. GitHub and agent-runtime output are not
workflow truth until Task Monki records them.

Records used by the card:

- `Task.projection`
- `GitSnapshotRecord`
- `BranchPublicationRecord`
- `PullRequestSnapshotRecord`
- `CiRollupRecord`
- `ReviewRollupRecord`
- `MergeSnapshotRecord`

Shared status enums are in `src/shared/contracts.ts`:

- `GitStatus`
- `BranchPublicationStatus`
- `PullRequestStatus`
- `CiChecksStatus`
- `ReviewStatus`
- `MergeStatus`
- `CompletionPolicy`

The completion helpers are also shared:

- `completionPolicyRequiresMerge(policy)`
- `completionPolicyRequiresPassingChecks(policy)`

Renderer code must not infer delivery truth from raw provider messages or raw
GitHub responses. It reads the current Task Monki snapshot.

## Real Render Surface

The card uses the existing panel language:

```text
+--------------------------------------------------+
| PR Status                              Jul 2... |
| o <headline>                                    |
| #82 <PR title>                                  |
| <reason / guidance / evidence>                  |
| [primary action] [secondary action]             |
| Checks 3                                        |
|   > build        Failed       12s               |
+--------------------------------------------------+
```

Real classes:

- root: `tm-panel tm-prstatus tm-prstatus--<tone>`
- title: `tm-panel__title`
- refresh button: `tm-prstatus__refresh`
- headline row: `tm-prstatus__headline-row`
- status dot: `tm-prstatus__dot tm-prstatus__dot--<tone>`
- pending animation: `tm-prstatus__dot--pulse`
- PR identity: `tm-prstatus__identity`
- reason/guidance: `tm-prstatus__reason`
- evidence line: `tm-prstatus__evidence`
- actions: `tm-prstatus__actions`
- disabled action title wrapper: `tm-actiontitle`
- check list: `tm-prchecks`, `tm-prcheck`

Action blockers are not rendered as dangling inline text. Disabled PR Status,
review, and Finish buttons keep their normal button position and expose the
reason through the `tm-actiontitle` wrapper's HTML `title` attribute.

Tones map to semantic CSS variables:

```text
neutral -> var(--neutral)
info    -> var(--info)
action  -> var(--action)
success -> var(--success)
error   -> var(--error)
```

Only `CHECKS_PENDING` pulses in the PR status headline.

## App APIs Used

In the desktop app, `window.taskManager` provides the same API contract as the
browser dev server client. In browser/dev mode,
`src/renderer/api/taskManagerClient.ts` calls these HTTP endpoints:

```text
POST /api/github/pr/create   -> TaskManagerService.createPullRequest(...)
POST /api/github/refresh     -> TaskManagerService.refreshGitHub(...)
POST /api/git/delivery-commit -> TaskManagerService.createDeliveryCommit(...)
POST /api/tasks/transition   -> TaskManagerService.transitionTask(...)
POST /api/runs/continue      -> investigation follow-up run
```

`TaskManagerService` serializes these task actions through `withTaskAction` so
two delivery mutations do not race for the same task.

## GitHub And Git Commands Used

Task Monki uses the local `gh` CLI through `GitHubService`. It does not call
GitHub REST or GraphQL directly from app code.

Official GitHub CLI docs checked for the command surfaces:

- `gh pr create`: https://cli.github.com/manual/gh_pr_create
- `gh pr list`: https://cli.github.com/manual/gh_pr_list
- `gh pr view`: https://cli.github.com/manual/gh_pr_view
- `gh pr checks`: https://cli.github.com/manual/gh_pr_checks
- `gh auth status`: https://cli.github.com/manual/gh_auth_status

Local Git evidence is collected with the configured `git` executable through
`src/core/git/gitCli.ts`.

Git commands used for PR delivery and evidence include:

```text
git status --porcelain=v2 --branch -z
git rev-parse --show-toplevel
git rev-parse --git-common-dir
git rev-parse HEAD
git branch --show-current
git rev-parse --abbrev-ref --symbolic-full-name @{upstream}
git rev-parse <upstream>
git diff --name-only <base>..HEAD
git diff --name-only
git diff --stat <base>..HEAD
git diff --stat
git rev-list --count <base>..HEAD
git add -A
git diff --cached --quiet
git commit -m "Task: <title>"
git push --set-upstream <remote> HEAD
```

GitHub CLI commands used:

```text
gh --version
gh auth status --hostname <host>
gh pr list --state open --head <branch> --limit 10 --json <fields>
gh pr create --draft --title <title> --body-file <file> --base <base> --head <branch>
gh pr view <number|url|branch> --json <fields>
gh pr checks <number|url|branch> --json <fields>
```

`gh pr checks` exit code `8` means checks are pending; the service accepts that
exit code and still parses JSON.

## Delivery Creation Flow

`Create draft PR` opens a small confirmation dialog before calling
`TaskManagerService.createPullRequest(...)`. The dialog defaults the PR title
to the task title and lets the user edit it for the new PR. `Push update`
continues to call the same service path directly. The service path means "make
GitHub delivery current for this task branch."

```text
TaskDetail.onCreateDraftPr
  -> CreateDraftPrModal
  -> runDeliveryAction(...)
  -> taskManagerApi.createPullRequest({ taskId, title })
  -> TaskManagerService.createPullRequest(...)
  -> createPullRequestUnlocked(...)
```

Backend flow:

1. Load the task.
2. Block if a task-owned implementation or review run is active.
3. Require a worktree.
4. Refresh Git evidence.
5. If the worktree is dirty, create a delivery commit.
6. Check the latest branch publication.
7. If no pushed publication exists for current `HEAD`, publish the branch.
8. Assert publish readiness with `assertPublishReady`.
9. Normalize the requested PR title, falling back to the task title.
10. Write the PR body artifact.
11. Record `PR_CREATE_REQUESTED`.
12. `gh pr list` finds an existing open PR for the branch, or `gh pr create`
    opens a new draft PR with the normalized title.
13. `gh pr view` and `gh pr checks` normalize PR, CI, review, and merge
    evidence.
14. `FileTaskStore.recordPullRequestSync(...)` stores all evidence records.
15. If GitHub reports an open PR, Task Monki transitions the task to
    `IN_REVIEW`.

The edited title applies only when `gh pr create` creates a new PR. If `gh pr
list` finds an existing open PR for the task branch, Task Monki reuses the
observed PR and does not rename it.

`assertPublishReady` requires:

- a Git snapshot exists
- status is not `DIRTY`, `CONFLICTED`, `DIVERGED`, `UNAVAILABLE`, or `UNKNOWN`
- `commitsAheadOfBase > 0`
- `committedDiffFileCount > 0`

Dirty worktrees are allowed at the user action level because the backend first
creates a delivery commit. Conflicted, diverged, unavailable, unknown, or
no-diff states are blocked.

## Refresh Flow

`Refresh` calls:

```text
TaskDetail.onRefresh
  -> runDeliveryAction(...)
  -> taskManagerApi.refreshGitHub({ taskId })
  -> TaskManagerService.refreshGitHub(...)
  -> GitHubService.viewPullRequest(...)
```

Refresh requires a worktree and an already linked PR number or URL. It does not
create a PR. It records fresh PR, CI, review, and merge evidence. Successful
refresh does not show a transient success toast; the updated timestamp and
evidence are the confirmation. On failure it records `GITHUB_SYNC_FAILED` and
surfaces the error through the app shell.

## Failing Check Investigation Flow

`Investigate failure` appears only when the selected PR Status state is
`CHECKS_FAILED`. This is stricter than reading the latest CI rollup alone:
terminal and freshness states win first, so stale, diverged, or locally
unpublished work never inherits a failure investigation action from non-current
check evidence.

```text
selectedStatus === CHECKS_FAILED
ciRollup.status === FAILING or BLOCKED
```

Clicking it does not call GitHub. It starts implementation-side follow-up work:

```text
TaskDetail.investigateFailingChecks
  -> buildFailingChecksInvestigationPrompt(view)
  -> taskManagerApi.continueRun({ runId, instruction })
```

The prompt includes:

- PR number
- PR URL when available
- head SHA
- branch and base
- failing check names, workflow, state, event, timestamps, and link

If there is no completed source run to continue, the button is disabled with:

```text
No completed run is available.
```

## Stored Evidence Normalization

`GitHubService.parsePrView(...)` splits one GitHub observation into four
Task Monki records:

```text
PullRequestSnapshotRecord
CiRollupRecord
ReviewRollupRecord
MergeSnapshotRecord
```

PR status mapping:

```text
mergedAt exists or state == MERGED -> MERGED
state == CLOSED                   -> CLOSED_UNMERGED
state == OPEN and isDraft         -> OPEN_DRAFT
state == OPEN and not draft       -> OPEN_READY
otherwise                         -> UNKNOWN
```

CI detail mapping uses `gh pr checks --json` bucket first:

```text
pass     -> passed
fail     -> failed
pending  -> pending
skipping -> skipped
cancel   -> canceled
```

If only rollup state is available:

```text
PENDING / QUEUED / IN_PROGRESS / WAITING / REQUESTED -> pending
SUCCESS / PASSING / PASSED                           -> passed
SKIPPED / NEUTRAL                                    -> skipped
CANCELLED / CANCELED / CANCEL                       -> canceled
FAILURE / FAILED / ERROR / TIMED_OUT / ACTION_REQUIRED -> failed
unknown                                              -> pending
```

CI rollup status:

```text
0 checks or only skipped checks -> NO_CHECKS
any failed                      -> FAILING
any canceled                    -> CANCELED
any pending                     -> PENDING
otherwise                       -> PASSING
```

GitHub review status:

```text
reviewDecision APPROVED          -> APPROVED
reviewDecision CHANGES_REQUESTED -> CHANGES_REQUESTED
reviewDecision REVIEW_REQUIRED   -> REQUESTED
otherwise                        -> NOT_REQUESTED
```

Merge status:

```text
mergedAt exists                  -> MERGED
state == CLOSED                  -> CLOSED_UNMERGED
state == MERGED                  -> MERGED
mergeStateStatus CLEAN/HAS_HOOKS -> MERGEABLE
mergeable == MERGEABLE           -> MERGEABLE
mergeStateStatus BLOCKED/DIRTY/BEHIND/DRAFT -> BLOCKED
mergeStateStatus UNKNOWN or mergeable UNKNOWN -> UNKNOWN
otherwise                        -> NOT_MERGED
```

Only the first 80 check detail rows are stored.

## Completion Policy Coupling

This is separate from PR Status rendering but must stay consistent with it.

When any non-`UNLINKED` PR snapshot is recorded for a local-style task:

```text
LOCAL_ACCEPTANCE    -> MERGED
ARTIFACT_ACCEPTANCE -> MERGED
MERGED              -> MERGED
MERGED_AND_VERIFIED -> MERGED_AND_VERIFIED
MANUAL              -> MANUAL
```

PR sync must not downgrade stricter or explicit policies.

Auto-completion from PR sync only happens when the task policy is satisfied:

```text
MERGED:
  merge.status == MERGED

MERGED_AND_VERIFIED:
  merge.status == MERGED
  ci.status == PASSING
  ci.pullRequestNumber == merge.pullRequestNumber
  ci.headSha == merge.headSha
  pullRequest.number == merge.pullRequestNumber
  pullRequest.headRefOid == merge.headSha

MANUAL:
  never auto-completes from PR sync

LOCAL_ACCEPTANCE / ARTIFACT_ACCEPTANCE:
  normally promoted to MERGED when a linked PR is recorded
```

`TaskManagerService.transitionTask(... DONE ...)` enforces the user-initiated
backend guard:

```text
MERGED or MERGED_AND_VERIFIED:
  merge.status == MERGED

MERGED_AND_VERIFIED:
  ci.status == PASSING
  ci.pullRequestNumber == merge.pullRequestNumber
  ci.headSha == merge.headSha
```

Finish renders the matching requirements:

```text
LOCAL_ACCEPTANCE:
  Review <state> | Tree <state>

MERGED:
  Review <state> | Tree <state> | Merge <state>

MERGED_AND_VERIFIED:
  Review <state> | Tree <state> | Merge <state> | Checks <state>

MANUAL:
  Review <state> | Tree <state>
```

For merge-gated policies, `Mark done anyway` is not allowed to bypass a missing
merge. For verified policies, failing/non-passing GitHub checks block `Mark
done`.

## View Model Priority

`buildPrStatusViewModel` chooses one `PrStatusKind` in this order:

```text
1.  NO_PR
2.  MERGED
3.  CLOSED_UNMERGED
4.  BRANCH_DIVERGED
5.  STALE
6.  LOCAL_NOT_PUSHED
7.  PR_NEWER_COMMITS
8.  CHECKS_FAILED
9.  CHECKS_PENDING
10. CHECKS_CANCELED
11. NO_REQUIRED_CHECKS
12. GITHUB_CHANGES_REQUESTED
13. GITHUB_REVIEW_WAITING
14. READY_TO_MERGE
15. DRAFT
16. OPEN
17. UNKNOWN
```

Terminal PR states win over freshness, checks, review, and ready state.
Freshness wins over checks because stale or diverged evidence may not describe
the current local branch.

## Full Render Matrix

The examples below use the real labels and action names from the current UI.
`[refresh]` is the icon-only refresh button. Its tooltip is either
`Refresh PR status` or the disabled reason.

### NO_PR, no worktree

```text
PR Status
o No PR
A worktree is required before a draft PR can be opened.
```

No action is shown because `canCreateDraftPr` is false.

### NO_PR, Git not inspected

```text
PR Status
o No PR
Refresh Git evidence before opening a PR.
[Create draft PR disabled]
```

### NO_PR, clean/no task diff

```text
PR Status
o No PR
Run implementation or make a task change before opening a PR.
[Create draft PR disabled]
```

### NO_PR, dirty task changes

```text
PR Status
o No PR
[Create draft PR]

Create draft PR dialog
PR title: <task title>
[Cancel] [Create draft PR]
```

Backend creates a delivery commit, publishes the branch, and creates or finds
the draft PR. The dialog title is used only if a new PR is created.

### NO_PR, committed task diff

```text
PR Status
o No PR
[Create draft PR]

Create draft PR dialog
PR title: <task title>
[Cancel] [Create draft PR]
```

Backend publishes the branch and creates or finds the draft PR. The dialog
title is used only if a new PR is created.

### NO_PR, conflicted

```text
PR Status
o No PR
Resolve Git conflicts before opening a PR.
[Create draft PR disabled]
```

### NO_PR, diverged or behind remote

```text
PR Status
o No PR
Sync the branch before opening a PR.
[Create draft PR disabled]
```

### NO_PR, Git unavailable or unknown

```text
PR Status
o No PR
Git status must be available before opening a PR.
[Create draft PR disabled]
```

### NO_PR, publication already pushing

```text
PR Status
o No PR
Branch publication is already in progress.
[Create draft PR disabled]
```

### NO_PR, retryable publication failure

```text
PR Status
o No PR
Last push failed: <stored publication error>
[Create draft PR]
```

### NO_PR, remote has newer commits

```text
PR Status
o No PR
Remote branch has newer commits. Sync the branch before pushing again.
[Create draft PR disabled]
```

### DRAFT

```text
PR Status                         Jul 2, 10:56
o Draft PR
#82 Refresh auth token
[refresh]
```

Tone: `info`.

### OPEN

```text
PR Status                         Jul 2, 10:56
o Open PR
#82 Refresh auth token
[refresh]
```

Tone: `neutral`.

### LOCAL_NOT_PUSHED, dirty worktree

```text
PR Status                         Jul 2, 10:56
o Local changes not pushed
#82 Refresh auth token
Local worktree has uncommitted changes.
[Push update]
```

### LOCAL_NOT_PUSHED, local head newer

```text
PR Status                         Jul 2, 10:56
o Local changes not pushed
#82 Refresh auth token
Local branch has newer commits.
[Push update]
```

### LOCAL_NOT_PUSHED, retryable publication failure

```text
PR Status                         Jul 2, 10:56
o Local changes not pushed
#82 Refresh auth token
Last push failed: <stored publication error>
[Push update]
```

### BRANCH_DIVERGED, local and PR both changed

```text
PR Status                         Jul 2, 10:56
o Branch diverged
#82 Refresh auth token
Local branch and PR branch both changed.
[refresh]
```

No push action is shown.

### BRANCH_DIVERGED, remote has newer commits

```text
PR Status                         Jul 2, 10:56
o Branch diverged
#82 Refresh auth token
Remote branch has newer commits. Sync the branch before pushing again.
[refresh]
```

No push action is shown.

### PR_NEWER_COMMITS

```text
PR Status                         Jul 2, 10:56
o PR has newer commits
#82 Refresh auth token
This worktree is behind the PR.
[refresh]
```

### STALE

```text
PR Status                         Jul 2, 10:56
o Stale
#82 Refresh auth token
Refresh PR status for the current head.
[refresh]
```

Stale means at least one recorded CI, review, or merge head SHA does not match
the current PR head SHA. The card does not render check details or failure
investigation actions from stale check evidence.

### CHECKS_FAILED

```text
PR Status                         Jul 2, 10:56
o Checks failed
#82 Refresh auth token
[refresh] [Investigate failure]
Checks 6
  > lint-and-test  Failed   3m
  > build          Failed   2m
  > docs           Skipped
  > typecheck      Passed
```

Tone: `error`. `BLOCKED` CI also renders as `Checks failed` and keeps the same
investigation action when it is the selected PR Status state.

### CHECKS_PENDING

```text
PR Status                         Jul 2, 10:56
o Checks pending
#82 Refresh auth token
[refresh]
Checks 3
  > build  Pending
  > test   Pending
  > lint   Passed
```

Tone: `action`. The headline dot pulses.

### CHECKS_CANCELED

```text
PR Status                         Jul 2, 10:56
o Checks canceled
#82 Refresh auth token
[refresh]
Checks 1
  > deploy-preview  Canceled
```

Tone: `action`. Canceled checks are distinct from failures but still block
ready-to-merge status.

### NO_REQUIRED_CHECKS

```text
PR Status                         Jul 2, 10:56
o No required checks ran
#82 Refresh auth token
[refresh]
Checks 2
  > docs-only  Skipped
```

This renders only when `ciRollup.status == NO_CHECKS` and the total check count
is greater than zero. Aggregate check summaries render only when GitHub did not
return individual check rows; otherwise the expandable rows are the evidence.

### GITHUB_CHANGES_REQUESTED

```text
PR Status                         Jul 2, 10:56
o GitHub changes requested
#82 Refresh auth token
[refresh]
```

Tone: `error`. This is GitHub review evidence, not Task Monki agent-review evidence.

### GITHUB_REVIEW_WAITING

```text
PR Status                         Jul 2, 10:56
o GitHub review waiting
#82 Refresh auth token
[refresh]
```

Tone: `action`.

### READY_TO_MERGE

```text
PR Status                         Jul 2, 10:56
o Ready to merge
#82 Refresh auth token
Approved · Mergeable
[refresh]
```

Conditions:

```text
PR is open and not draft
CI evidence exists, is PASSING, and matches the PR head
GitHub review evidence exists, is approved/satisfied/not requested/not applicable, and matches the PR head
Merge snapshot is MERGEABLE
Merge evidence matches the PR head
```

Tone: `success`.

### MERGED

```text
PR Status                         Jul 2, 10:56
o Merged
#82 Refresh auth token
[refresh]
```

Tone: `success`. No create or push action is shown.

### CLOSED_UNMERGED

```text
PR Status                         Jul 2, 10:56
o Closed without merge
#82 Refresh auth token
[refresh] [Create draft PR]
```

Tone: `error`. The old PR snapshot is terminal, but Task Monki may still offer
`Create draft PR` if the current task branch is publishable.

### UNKNOWN

```text
PR Status                         Jul 2, 10:56
o Unknown
#82 Refresh auth token
[refresh]
```

Unknown is the fallback when a PR exists but no higher priority status applies.

## Check Details Rendering

Check rows are grouped by severity order:

```text
failed
canceled
pending
skipped
passed
```

Each check is a collapsed `details` row:

```text
> <dot> <name>          <Status label> <short meta>
```

Opening the row shows stored evidence only:

```text
Workflow: CI
Status: FAILURE
Event: pull_request
Started: 2026-07-02T08:56:45Z
Completed: 2026-07-02T08:56:48Z
URL: https://github.com/...
Description: ...
```

The card does not render GitHub Actions log output because Task Monki does not
store logs for this feature.

## Action Pauses

`buildPrStatusActionState` layers runtime pauses over evidence gates.
The PR Status card renders these reasons as disabled action titles, not inline
helper text.

```text
delivery action in flight:
  disables refresh, create/push, investigate
  disabled title: GitHub action is in progress.

agent review starting:
  disables create/push/investigate
  refresh remains available
  disabled title: Delivery actions pause while review starts.

agent review running:
  disables create/push/investigate
  refresh remains available
  disabled title: Delivery actions pause while review runs.

implementation running:
  disables create/push/investigate
  refresh remains available
  disabled title: Delivery actions pause while the agent runs.

failing checks with no source run:
  disables Investigate failure
  disabled title: No completed run is available.
```

Review and Finish use the reverse pause relationship:

```text
GitHub delivery running -> Run review stays visible but disabled.
GitHub delivery running -> Finish actions pause during GitHub actions.
review running          -> Finish actions pause while review runs.
implementation running  -> Finish actions pause while the agent runs.
```

When review is `NOT_RUN` and another task action pauses review actions, the
`Run review` remains in place, disabled, with the pause reason on
the `tm-actiontitle` wrapper. Do not replace it with dangling explanatory text.

The delivery `Commit` action now uses `runDeliveryAction`, so PR Status and
Finish pause consistently during local delivery commits.

## Board Delivery Line

The board card uses `buildBoardDeliveryLine(task)`, not the full PR Status
view model. It renders a compact line:

```text
No PR
PR #82 | merged
PR #82 | closed
PR #82 | checks failing
PR #82 | checks pending
PR #82 | checks canceled
PR #82 | changes requested
PR #82 | review waiting
PR #82 | ready to merge
PR #82 | draft
PR #82 | open
```

Tone is derived from delivery evidence:

```text
error:
  closed unmerged, checks failing/blocked, changes requested

action:
  pending/canceled/stale checks, review requested/pending

success:
  merged, or passing checks plus mergeable

neutral:
  everything else
```

## Evidence Updates And Projection

`FileTaskStore.recordPullRequestSync(...)` writes four records and four events:

```text
PR_SNAPSHOT_CAPTURED
CI_ROLLUP_CAPTURED
REVIEW_ROLLUP_CAPTURED
MERGE_SNAPSHOT_CAPTURED
```

`src/core/projection/reducer.ts` updates the task projection from those events.
Merged evidence only changes workflow to `DONE` when the completion policy is
satisfied. A merged PR snapshot by itself may update delivery projection, but
it should not say "Completion policy is satisfied" unless the policy actually
is satisfied.

## Regression Coverage

Core and renderer coverage lives in:

- `src/renderer/model/prStatus.test.ts`
- `src/renderer/ui/taskView.test.ts`
- `src/core/storage/FileTaskStore.test.ts`
- `src/core/projection/reducer.test.ts`
- `src/core/app/TaskManagerService.phase3.test.ts`
- `src/core/app/TaskManagerService.reviewPrActions.test.ts`
- `src/core/github/GitHubService.test.ts`

Important test expectations:

- full PR status card state matrix
- failing checks beat GitHub review waiting
- terminal and freshness states do not duplicate ready evidence text
- closed-unmerged PR can offer a replacement draft PR when publishable
- remote-newer push failure blocks delivery mutation
- retryable publication failures remain retryable
- `MERGED_AND_VERIFIED` requires merge plus passing checks for the merged PR head
- `MANUAL` and `MERGED_AND_VERIFIED` policies are not downgraded by PR sync
- merged PR sync auto-completes only when policy gates are satisfied
