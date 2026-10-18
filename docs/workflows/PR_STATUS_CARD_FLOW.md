# PR Status Card Flow

Date: 2026-07-02

This document describes the current Task Monki PR Status implementation and
delivery workflow. While a pull request is open, its step is the Overview's Now
panel (`deliveryStep` in `src/renderer/ui/TaskDetail.tsx`), and the pull request
itself is the first group of the record column (`PullRequestRecord`, driven by
`buildPullRequestRecord` in `src/renderer/model/pullRequestRecord.ts`). Before a
pull request exists, `PrStatusCard` offers to open one. Both read
`buildPrStatusViewModel` and `buildPrStatusActionState` in
`src/renderer/model/prStatus.ts`.

## Product Contract

PR Status is the single GitHub delivery surface in the task detail Overview.
It answers:

- does this task have a linked PR?
- is the local worktree ahead of the PR, behind it, dirty, stale, or diverged?
- are GitHub checks passing, pending, canceled, blocked, or failing?
- is GitHub review waiting or requesting changes, from whom, and how many
  review threads are unresolved?
- is GitHub reporting the PR mergeable, merged, or closed without merge?
- which GitHub delivery action is currently valid?

While a linked pull request is not merged — open, or closed without merge,
where `Create draft PR` can start a new one — PR Status holds the Overview's
Now panel with one step: a title, the one fact the step turns on (`fact`: which
checks failed, who asked for changes, what is not pushed, or the base it is
behind), and the actions that take it, lead first. The panel's title is the
board card's word for the task, or the PR's headline when that word only
repeats the lane. For failed checks the panel lists them, each with the end of
its log on request. A merged pull request hands the panel to finishing, and so
does an agent review that asks for action, since the board card leads with it.
While another step holds the panel, the pull request's actions stay on the
page as a Delivery section (`deliverySection`): its headline and fact as facts,
the same actions, quiet. It is left out while every action is paused, as while
the agent works, since it would only repeat the record.

The pull request's record sits first in the record column whenever one exists:
its state icon, number and title (a link to the platform), the branch and the
base it merges into, then a row per gate — Checks (a summary that opens into a
row per check, failures first), Reviews (each reviewer's own state), Threads
(unresolved, opening the Review tab), and Merge (no conflicts, behind or
conflicting with the base, held by branch rules, or merged and when). Merged or
closed, it keeps only what ended it. The refresh control and the time of the
last reading sit in its head. It asks for nothing; the Now panel does. Before
any pull request exists, `Create draft PR` sits with the finishing actions when
finishing holds the Now panel, together with any publish failure line, and in
the PR Status section otherwise, under the same publish guard, so it appears
exactly once.

The step's actions, in the order they lead:

```text
Sync branch          a task opened from a PR, behind it or rewritten under it
Push update          the worktree holds commits or changes the PR does not
Pull changes         the PR's branch moved beside the worktree's own commits
Update with <base>   the platform holds the merge on a base that moved
Fix checks           a check failed for the current head
Re-run failed        beside Fix checks, when a failed check ran in the PR's own repository
Address comments     an unresolved thread or a review asking for changes was not sent
Reply on GitHub      the agent answered sent discussions and nobody replied since
Ready for review     a current draft whose checks did not fail
Merge                the evidence for the current head says the platform would merge it
Create draft PR      the PR closed without merge and the branch can be published
```

Pull changes and Update with <base> fetch the commits the worktree lacks
(`fetchPullRequestUpdate`: objects only, no ref moves) and send the agent a
follow-up that merges them, since the agent runs without network; the person
reviews and pushes. Fix checks reads the end of each failing log first
(`readPullRequestCheckLogs`, at most three checks, 150 lines each, colour
codes and timestamps removed) and quotes it in the follow-up as data. Only the
last megabyte of a log is read for that, and a log that marks its error ends at
its last error; "Earlier lines left out" says only that lines before the shown
end were dropped. Re-run failed asks the platform to run the failed checks
again without sending the agent anything, for a flaky check: on GitHub it posts
`repos/<owner>/<repo>/actions/runs/<run>/rerun-failed-jobs` for each failed
Actions run of the pull request's own repository, and on GitLab
`projects/:id/jobs/:job/retry` for each failed job of the merge request's own
project. A check from a fork's run or another system is left to its platform.
`PR_CHECKS_RERUN_REQUESTED` records what was asked, and PR Status reads the
pull request again.

A head just pushed reports no checks until its CI registers them. When an
earlier head of the same pull request had checks, no checks for this head reads
"Checks pending" ("No checks reported yet"), never Ready to merge, until a
reading taken a minute after the head first appeared still finds none
(`checksMayNotHaveStarted`). PR Status refreshes only on request and after
Task Monki's own steps, so that later reading is the person's Refresh.

Ready for review, Merge and the replies are the person's writes to the
platform, each an explicit click:

- Ready for review runs `gh pr ready`, or on GitLab removes the title's draft
  marker.
- Merge opens a dialog with the methods the repository allows (GitHub's
  `squashMergeAllowed` and its neighbours, GitLab's `squash_option`), the
  platform's default first, and Delete branch for a branch of the same
  repository that the platform does not delete itself (checked for the task's
  own branch, unchecked for a pull request someone else opened). It merges
  through `PUT .../pulls/N/merge` with `sha` set to the head the person saw, so
  the platform refuses a pull request that moved; `gh pr merge` is not used,
  since it also deletes and switches local branches. Task Monki observes the
  worktree first and refuses while it holds changes the pull request does not
  (uncommitted, unpushed, diverged or conflicted). On GitLab the dialog follows
  the merge request's own Delete source branch choice, and the merge sends
  `should_remove_source_branch` only to delete, since an explicit false would
  override that choice. A merge that landed is not reported as failed when the
  reading after it fails; the next refresh records it.
- Reply on GitHub lists each discussion the agent answered Fixed or Not
  changed, with a reply written from the answer ("Fixed in <head>. <note>")
  that the person edits or leaves out, Resolve thread for a resolvable thread
  (checked for Fixed: the agent's answer is its report, so resolving stays the
  person's call), and, on GitHub, Ask <reviewer> to review again for each
  reviewer who requested changes. A thread takes its reply in place; a review
  or a comment, which has no thread, takes one comment that quotes what each
  reply answers. A refused reply does not stop the rest, and the dialog keeps
  each refusal with its reason; a reply that landed while resolving its thread
  failed stays in view, marked replied, and is not posted again.
  `PR_REPLIES_POSTED` records which discussions were answered: a review's answer
  is a comment of its own, so this record is what keeps Reply from offering it
  again until a later request sends that discussion to the agent anew.
- In the Review tab, each open thread ends in a reply row, so a reply is
  written where the thread is read and can be checked against its code first.
  An agent's answer to the thread is where the reply starts and Resolve thread
  starts checked for Fixed, as in the dialog; the reply goes through the same
  path and the same record. The check on a thread's head resolves it, or reopens
  a resolved one, with no reply (GitHub's `resolveReviewThread` and
  `unresolveReviewThread`, GitLab's `resolved` on the discussion), and
  `PR_REPLIES_POSTED` records it as resolved or reopened. Each write reads the
  pull request again afterwards, and the worktree's evidence is recorded only
  when it changed, so the diff being read keeps its place.

Finish remains local acceptance. It owns `Commit`, `Mark done`, and
`Mark done anyway`, the owner override that is never the recommended step and
so never the filled primary. Before any pull request exists it also carries
`Create draft PR`, as described above; it never renders `Push update`.

History (the Overview's view of the Activity Timeline) renders beside PR Status
as supporting task context. It may
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

In the Now panel the headline is the title; as a section, a quiet "Pull
request" label leads and the headline follows the PR identity:

```text
<headline>                           Updated Jul 2, 10:05  ↻
#82 <PR title>
<freshness / lead / guidance / evidence>
[primary action] [secondary action]
> Checks                                                 3
    > build        Failed       12s
```

Real classes:

- root: `tm-prstatus` (`tm-prstatus--now` inside the Now panel)
- refresh line and button: `tm-prstatus__refreshline`, `tm-prstatus__refresh`
- PR identity and section headline: `tm-prstatus__identity`, `tm-prstatus__state`
- freshness problem: `tm-prstatus__freshness`
- lead, guidance and evidence lines: `tm-prstatus__fact`
- actions: `tm-prstatus__actions`
- disabled action title wrapper: `tm-actiontitle`
- check list: `tm-prchecks`, `tm-prcheck`

Disabled buttons keep their normal button position. PR Status buttons expose
the reason through the `tm-actiontitle` wrapper's HTML `title` attribute.
Finish actions in the Overview's Now panel state the reason once beside the
actions, tied with `aria-describedby`.

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
POST /api/remote/list        -> TaskManagerService.listRemoteWork(...)
POST /api/remote/pull-request/open -> TaskManagerService.openPullRequest(...)
POST /api/remote/pull-request/sync -> TaskManagerService.syncPullRequest(...)
POST /api/git/delivery-commit -> TaskManagerService.createDeliveryCommit(...)
POST /api/tasks/transition   -> TaskManagerService.transitionTask(...)
POST /api/runs/continue      -> investigation follow-up run
```

`TaskManagerService` serializes these task actions through `withTaskAction` so
two delivery mutations do not race for the same task.

## GitHub And Git Commands Used

Task Monki uses the local `gh` CLI through `GitHubService`. It does not call
GitHub REST or GraphQL directly from app code. On gitlab.com, `GitLabService`
does the same through `glab api` and GitLab's REST API; the card, records and
rules below are shared, and its words become MR, `!N` and GitLab. A task opened
from GitLab, or whose checkout has GitLab remotes and no GitHub remote, is
delivered on GitLab.

Official GitHub CLI docs checked for the command surfaces:

- `gh pr create`: https://cli.github.com/manual/gh_pr_create
- `gh pr list`: https://cli.github.com/manual/gh_pr_list
- `gh pr view`: https://cli.github.com/manual/gh_pr_view
- `gh pr checks`: https://cli.github.com/manual/gh_pr_checks
- `gh auth status`: https://cli.github.com/manual/gh_auth_status
- `gh api graphql`, for review feedback: `PullRequest.reviewThreads`,
  `latestReviews`, `latestOpinionatedReviews`, `reviewRequests` and `comments`
  (https://docs.github.com/en/graphql/reference/objects#pullrequest)

GitLab review feedback comes from `GET .../merge_requests/:iid/discussions`
(pages of 100, up to five), `.../reviewers` and `.../approvals`
(https://docs.gitlab.com/api/discussions/, https://docs.gitlab.com/api/merge_requests/).

## Review Feedback

Each PR observation also reads what people said: review threads on lines and
files, review summaries, and conversation comments, with each reviewer's
state (requested changes, approved, commented, or asked and waiting). It is a
read; nothing is written back. `PullRequestFeedback` is stored as the task's
immutable `pull-request-feedback` artifact, and `ReviewRollupRecord.feedback`
keeps a summary the card reads without the artifact: the artifact id, a
digest, the unresolved thread count, the discussion count, the reviewers, and
the platform's time of the person's latest comment and of anyone else's
(`lastViewerCommentAt`, `lastOtherCommentAt`), which decide whose turn it is.
An unchanged reading keeps its artifact; a read that fails keeps the last
reading of the same PR, and the PR status still records.

Review threads (GitHub) and discussions (GitLab) are read a page of 100 at a
time, up to five pages, so the newest are read too; a GitHub conversation is
its last 30 comments.

What is kept is what a reader sees on the platform: HTML comments outside code
and invisible characters (zero-width, bidirectional controls and tag
characters), which both platforms hide, and comments a maintainer minimized are
left out, and a bot's conversation comment (a deployment or coverage report) is
not feedback; a bot's review threads are. An agent is sent the text the Review
tab shows, never markup or attributes it hides. A reviewer that is a bot is
marked as one, and is never asked to review again: the platform ignores such a
request. A thread keeps its first
comment and its nine most recent replies. Every body is bounded, and past a
shared budget, open discussions keep their bodies at the bound while resolved
ones keep only their start. Past 100 discussions, open ones are kept first,
then the most recent; a reading that left anything out says so, and the Review
tab links to the rest on the platform. A GitLab diff note written on an earlier
head than the MR's is outdated.

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
git ls-remote --heads <remote> refs/heads/<branch>
```

An interrupted push is reconciled against that exact remote ref and attempted
local HEAD. A differing or unreadable ref remains `AMBIGUOUS`. The next explicit
delivery action performs the same read-only check before local auto-commit,
GitHub preflight, or push; it never retries from persisted intent alone.
Unchanged ambiguous observations reuse the existing publication record.

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
to the task title and lets the user edit it for the new PR. Imported work also
requires a target branch, separate from its review comparison. A failed request
keeps the dialog inputs for retry. `Push update`
continues to call the same service path directly. The service path means "make
GitHub delivery current for this task branch."

```text
TaskDetail.onCreateDraftPr
  -> CreateDraftPrModal
  -> runDeliveryAction(...)
  -> taskManagerApi.createPullRequest({ taskId, title, baseBranch })
  -> TaskManagerService.createPullRequest(...)
  -> createPullRequestUnlocked(...)
```

Backend flow:

1. Load the task.
2. Block if a task-owned implementation or review run is active.
3. Require a worktree.
4. If an earlier publication is still `PUSHING` or `AMBIGUOUS`, compare the
   exact remote ref
   with its recorded local HEAD. Adopt the matching ref, allow an explicit
   retry only when the ref is absent, and block an ambiguous mismatch.
5. Refresh Git evidence.
6. If a managed worktree is dirty, create a delivery commit. Reject a dirty
   external checkout; its owner must commit outside Task Monki.
7. Check the latest branch publication.
8. If no pushed publication exists for current `HEAD`, record `PUSHING` with
   the exact remote, branch, and HEAD before publishing the branch.
9. Assert publish readiness with `assertPublishReady`.
10. Normalize the requested PR title, falling back to the task title.
11. Write the PR body artifact.
12. Record `PR_CREATE_REQUESTED`.
13. `gh pr list` finds an existing open PR for the branch, or `gh pr create`
    opens a new draft PR with the normalized title.
14. `gh pr view` and `gh pr checks` normalize PR, CI, review, and merge
    evidence.
15. `SqliteTaskStore.recordPullRequestSync(...)` stores all evidence records.
16. If GitHub reports an open PR, Task Monki transitions the task to
    `IN_REVIEW`.

The edited title applies only when `gh pr create` creates a new PR. If `gh pr
list` finds an existing open PR for the task branch, Task Monki reuses the
observed PR and does not rename it.

`assertPublishReady` requires:

- a Git snapshot exists
- status is not `DIRTY`, `CONFLICTED`, `DIVERGED`, `UNAVAILABLE`, or `UNKNOWN`
- for managed worktrees, `commitsAheadOfBase > 0`
- for managed worktrees, `committedDiffFileCount > 0`

Dirty managed worktrees are allowed at the user action level because the backend first
creates a delivery commit. Conflicted, diverged, unavailable, and unknown states
are blocked. Managed tasks also require a committed diff.

## Linked tasks

A task opened from an issue passes the issue's repository explicitly (`gh ...
--repo host/owner/repo`) and, when it pushes through a fork, names the head as
`owner:branch`. The PR body's Summary starts with `Closes #N`, or
`Related to #N` when the person turned off "Add “Closes #N” to the description".

A task opened from a pull request never creates one. Its PR Status reads the
linked pull request by number. Push update publishes local commits to the pull
request's own branch with `git push --force-with-lease=refs/heads/<branch>:<last
seen head> -- <remote> <sha>:refs/heads/<branch>`: same repository only, the
remote's single push URL naming it, fast forward from the last seen head only,
no upstream change, hooks off. A fork pull request offers no Push update; while
the worktree holds work the pull request does not, the card states "Task Monki
does not push to forks." After a push, PR Status waits up to about six seconds
for the platform to report the pushed head before it records the pull request.
A push the lease refuses records "The pull request branch moved since Task
Monki last read it. Refresh to see its new commits."

`PR_NEWER_COMMITS` and a rewritten pull request the worktree has no commits of
its own against (headline "PR rewritten") offer Sync branch, the lead action;
it is disabled while the worktree has changes. Git evidence for these tasks measures
the branch against the observed pull request head, so ahead, behind and
diverged are exact. Without a recorded snapshot, the card offers Refresh only.

## Refresh Flow

For an unlinked external checkout, Refresh performs read-only PR discovery.
The match must identify the exact repository and branch. Forks, ambiguous
results, incomplete identity, and lookup failures cannot prove that no PR exists.
Creating a PR checks for an existing match before publication. A match retains
its target branch. If the local HEAD is newer, the same action publishes the
update; discovery alone does not complete that action.

External publication requires clean, current Git evidence and one verified push
destination in the selected GitHub repository. It pushes the verified commit to
the exact branch ref without changing upstream configuration or publishing tags.
The publication record retains the destination URL for uncertain-push reconciliation.
A new imported-work PR requires an explicit target branch. Task Monki verifies
that branch in the selected GitHub repository before publication. The request
does not change the checkout's stored comparison or existing review evidence.
`HEAD` and commit comparisons remain valid, including comparisons with no diff.
GitHub checks the new PR's diff against its target. Managed tasks retain their
existing committed-diff requirement.

If creation fails after a successful push, the publication remains recorded.
An explicit retry can create the PR without repeating that push.

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

An interrupted refresh leaves the last complete snapshot intact. Startup does
not repeat the read-only request automatically; the user can run Refresh again.
By contrast, startup does reconcile unfinished publication and PR creation:
the remote branch ref is inspected for a recorded `PUSHING` attempt, and
`gh pr list` may adopt an open PR after `PR_CREATE_REQUESTED`. Startup never
pushes a branch or invokes `gh pr create`.

## Failing Check Investigation Flow

`Fix checks` appears only when the selected PR Status state is
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

Merge status. `mergeable` reports only Git conflicts, so GitHub's merge state
decides; a draft, or a PR held by branch protection (required reviews, checks
or resolved conversations), is not mergeable yet for reasons its own evidence
states, and only conflicts or a branch that must be updated block it:

```text
mergedAt exists                          -> MERGED
state == CLOSED                          -> CLOSED_UNMERGED
state == MERGED                          -> MERGED
mergeStateStatus CLEAN/HAS_HOOKS/UNSTABLE -> MERGEABLE
mergeStateStatus DIRTY/BEHIND            -> BLOCKED
mergeStateStatus DRAFT/BLOCKED           -> NOT_MERGED, or BLOCKED when mergeable == CONFLICTING
mergeStateStatus UNKNOWN                 -> UNKNOWN
no mergeStateStatus                      -> from mergeable: MERGEABLE, BLOCKED (CONFLICTING), UNKNOWN, else NOT_MERGED
```

GitLab reports the first reason an MR cannot merge in `detailed_merge_status`.
`mergeable` is MERGEABLE; `checking`, `unchecked`, `preparing` and
`approvals_syncing` are COMPUTING; reasons the draft, review or check evidence
states, or that a person settles on GitLab (`draft_status`, `not_approved`,
`requested_changes`, `ci_must_pass`, `ci_still_running`,
`discussions_not_resolved`, and the policy checks) are NOT_MERGED; a conflict,
a needed rebase or a lock is BLOCKED; a reason GitLab adds later is UNKNOWN.
Because GitLab names the draft first, a reviewer's own `requested_changes`
state also makes the review CHANGES_REQUESTED.

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
No checks reported
[refresh]
```

Tone: `info`. When no check verdict leads, the evidence line says what is
missing: `Checks not observed` (no rollup), `No checks reported` (zero rows, as
in a repository without CI), `Checks not applicable`, or `Checks unknown`. None
of these outranks GitHub review or draft state.

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
o Changes not pushed
#82 Refresh auth token
Local worktree has uncommitted changes.
[Push update]
```

### LOCAL_NOT_PUSHED, local head newer

```text
PR Status                         Jul 2, 10:56
o Changes not pushed
#82 Refresh auth token
Local branch has newer commits.
[Push update]
```

### LOCAL_NOT_PUSHED, retryable publication failure

```text
PR Status                         Jul 2, 10:56
o Changes not pushed
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
o Checks stale
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
[refresh] [Fix checks]
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
o Checks skipped
#82 Refresh auth token
[refresh]
Checks 2
  > docs-only  Skipped
```

This renders only when `ciRollup.status == NO_CHECKS` and the total check count
is greater than zero. Aggregate check summaries render only when GitHub did not
return individual check rows; otherwise the expandable rows are the evidence.

### GITHUB_CHANGES_REQUESTED (Changes requested)

```text
PR Status                         Jul 2, 10:56
o Changes requested
#82 Refresh auth token
alice requested changes, 3 unresolved threads
[Address comments] [refresh]
```

Tone: `error`. This is GitHub review evidence, not Task Monki agent-review evidence.

The feedback line, on any open PR whose feedback was read with it, says who
requested changes, who it waits on and how many threads are unresolved;
approvals are left to the review state. `Address comments` appears while an
unresolved thread, or a review requesting changes, was not sent to the agent
since anyone else last wrote on it: it adds those to the review request and
opens the Review tab's request sheet. Nothing is sent until the person sends
it there. It leads the panel after Fix checks, Sync branch and Push
update, and the panel lists what it would send, one row per comment that opens
its thread in Review.

The state follows whose turn it is (`reviewTurn`). It is the author's while a
reviewer's request or an unresolved thread stands unanswered. It is the
reviewers' once the person wrote after everyone else on the platform's clock,
or asked again every reviewer who requested changes (GitHub shows that reviewer
as requested while the verdict stands): the card reads Waiting for review with
"Waiting on alice", offers nothing, and the Inbox and board raise nothing. A
reviewer's next comment or review hands the turn back.

### GITHUB_REVIEW_WAITING (Waiting for review)

```text
PR Status                         Jul 2, 10:56
o Waiting for review
#82 Refresh auth token
Waiting on alice
[refresh]
```

Tone: `action`. Also the state of a pull request whose requested changes the
person answered: the fact names who it waits on.

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
  disables Fix checks
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

## Board Card Pull Request

The board card uses `cardPullRequestForTask(task)`, not the full PR Status view
model. A task without a linked pull request has no footer entry. Otherwise the
card shows GitHub's icon for the pull request's state (draft, open, merged or
closed) and its number, and, for an open pull request, one delivery note:

```text
checks failing
checks pending
checks canceled
changes requested
review waiting
checks passing, mergeable
checks passing
```

Projection scalars alone never claim "ready to merge"; that needs delivery
evidence for the current head. "mergeable" needs a ready PR GitHub or GitLab
calls mergeable; a draft with passing checks reads "checks passing". A note the
card's status word already states is dropped on either platform, so "Checks
failed" never sits beside "checks failing" and "Changes requested" never beside
"changes requested". The note takes no tone: the status word carries it.

A delivery state the person owes a step on carries its facts on the board
summary (`BoardTaskSummary.delivery`, read at request time, never stored): the
failed checks' names, who asked for changes and how many threads are
unresolved, the base a blocked merge waits on, and why the last push failed.
The Inbox states that fact beneath the word ("unit and lint failed", "unit,
lint and 3 more failed", "alice requested changes, 2 unresolved threads",
"Conflicts with main"). Delivery raises nothing while an agent turn runs, since
the turn may be the fix, nor while the pull request waits on its reviewers; and
fixes the agent made that are not pushed read "Changes not pushed" ahead of the
reviewer's request they answer. A push the remote refused reads "Push failed", and one
that may have landed reads "Push unconfirmed", not "Delivery needs attention";
and Push update keeps an open pull request open in the projection while it
runs, so the task never reads as having none.

A pull request opened as a task that merges on the platform completes the task
under the merge policy between turns, In progress included; a run in flight
holds completion until it ends. In any phase, a worktree that held work the
pull request does not when Task Monki last observed it (uncommitted, unpushed,
diverged or conflicted) keeps the task open: a merge someone else made does not
ship fixes that were never pushed.

Between turns, an open PR's own progress (Branch diverged, Changes not pushed,
Checks stale) is the task's status word in any phase, so a PR opened as a task,
which starts In progress, reads as the PR card does. A PR rewritten under a
worktree that holds nothing of its own reads "PR rewritten", as PR Status says
it: the board summary carries `pullRequestRewritten`, decided by the same
`pullRequestRewrittenUnder` rule PR Status uses. A merged PR asks nothing more:
its last review decision or check result raises no attention, and the word is
Merged (or Ready to mark done under a manual policy).

Platform times are recorded in the store's canonical form: GitHub reports
`mergedAt` without milliseconds, and an observation is refused at write time
when a value could not be loaded again.

## Evidence Updates And Projection

`SqliteTaskStore.recordPullRequestSync(...)` writes four records and four events:

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
- `src/renderer/model/taskView.test.ts`
- `src/core/storage/SqliteTaskStore.integration.test.ts`
- `src/core/projection/reducer.test.ts`
- `src/core/app/TaskManagerService.workflowPolicies.test.ts`
- `src/core/app/TaskManagerService.reviewPrActions.integration.test.ts`
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
