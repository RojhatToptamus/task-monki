export type DevSeedScenarioGroup =
  | 'board'
  | 'agent'
  | 'review'
  | 'delivery'
  | 'completion'
  | 'workflow'
  | 'preview'
  | 'discourse';

export interface DevSeedScenarioDefinition {
  slug: string;
  group: DevSeedScenarioGroup;
  title: string;
  description: string;
  tags: string[];
}

function scenario(
  slug: string,
  group: DevSeedScenarioGroup,
  title: string,
  description: string,
  tags: string[]
): DevSeedScenarioDefinition {
  return { slug, group, title, description, tags };
}
export const DEV_SEED_SCENARIOS: DevSeedScenarioDefinition[] = [
  scenario('board-backlog', 'board', 'Backlog task', 'Task waiting before work is accepted.', [
    'phase:BACKLOG'
  ]),
  scenario('board-ready', 'board', 'Ready task', 'Task ready for worktree preparation.', [
    'phase:READY'
  ]),
  scenario('worktree-clean', 'board', 'Clean worktree', 'Prepared worktree with clean Git evidence.', [
    'worktree:PRESENT',
    'git:CLEAN'
  ]),
  scenario('worktree-missing', 'board', 'Missing worktree', 'Known task worktree is missing locally.', [
    'worktree:MISSING'
  ]),
  scenario('worktree-error', 'board', 'Worktree error', 'Worktree setup failed with stored evidence.', [
    'worktree:ERROR'
  ]),
  scenario('agent-running', 'agent', 'Agent running', 'Implementation turn is actively running.', [
    'agent:RUNNING'
  ]),
  scenario(
    'agent-awaiting-approval',
    'agent',
    'Awaiting approval',
    'Agent turn is blocked on a command approval request.',
    ['agent:AWAITING_APPROVAL', 'interaction:COMMAND_APPROVAL']
  ),
  scenario(
    'agent-awaiting-user-input',
    'agent',
    'Awaiting user input',
    'Agent turn is blocked on a user input request.',
    ['agent:AWAITING_USER_INPUT', 'interaction:USER_INPUT']
  ),
  scenario('agent-interrupted', 'agent', 'Interrupted run', 'Agent turn was interrupted.', [
    'agent:INTERRUPTED'
  ]),
  scenario('agent-runtime-lost', 'agent', 'Runtime lost', 'Agent runtime was lost and needs recovery.', [
    'agent:RECOVERY_REQUIRED',
    'recovery:runtime-lost'
  ]),
  scenario(
    'agent-ambiguous-mutation',
    'agent',
    'Ambiguous mutation',
    'Provider mutation delivery is ambiguous and requires user action.',
    ['agent:RECOVERY_REQUIRED', 'recovery:ambiguous']
  ),
  scenario('interaction-stale', 'agent', 'Stale interaction', 'An approval request became stale.', [
    'interaction:STALE'
  ]),
  scenario('review-not-run', 'review', 'Review not run', 'Implementation completed without an agent review.', [
    'agent-review:NOT_RUN'
  ]),
  scenario('review-running', 'review', 'Review running', 'Agent review run is active.', [
    'agent-review:RUNNING'
  ]),
  scenario('review-passed', 'review', 'Review passed', 'Agent review passed with structured result.', [
    'agent-review:PASSED'
  ]),
  scenario(
    'review-needs-changes',
    'review',
    'Review needs changes',
    'Agent review found actionable issues.',
    ['agent-review:NEEDS_CHANGES']
  ),
  scenario(
    'review-inconclusive',
    'review',
    'Review inconclusive',
    'Agent review completed without a definitive verdict.',
    ['agent-review:INCONCLUSIVE']
  ),
  scenario('review-failed', 'review', 'Review failed', 'Agent review failed before completion.', [
    'agent-review:FAILED'
  ]),
  scenario('review-canceled', 'review', 'Review canceled', 'Agent review was canceled.', [
    'agent-review:CANCELED'
  ]),
  scenario(
    'review-stale-after-follow-up',
    'review',
    'Stale review after follow-up',
    'A completed follow-up made the previous review stale.',
    ['agent-review:STALE', 'mode:FOLLOW_UP']
  ),
  scenario(
    'review-follow-up-active',
    'review',
    'Follow-up active',
    'Follow-up implementation is running after review findings.',
    ['agent-review:STALE', 'agent:RUNNING']
  ),
  scenario(
    'no-pr-git-not-inspected',
    'delivery',
    'No PR, Git not inspected',
    'PR creation is blocked until Git evidence is refreshed.',
    ['pr:NO_PR', 'git:NOT_INSPECTED']
  ),
  scenario('no-pr-clean', 'delivery', 'No PR, clean branch', 'No task diff exists to publish.', [
    'pr:NO_PR',
    'git:CLEAN'
  ]),
  scenario('no-pr-dirty', 'delivery', 'No PR, dirty worktree', 'Uncommitted work can be published.', [
    'pr:NO_PR',
    'git:DIRTY'
  ]),
  scenario('no-pr-conflicted', 'delivery', 'No PR, conflicted branch', 'Git conflicts block PR creation.', [
    'pr:NO_PR',
    'git:CONFLICTED'
  ]),
  scenario(
    'no-pr-unavailable',
    'delivery',
    'No PR, Git unavailable',
    'Git status could not be collected.',
    ['pr:NO_PR', 'git:UNAVAILABLE']
  ),
  scenario('no-pr-unknown', 'delivery', 'No PR, Git unknown', 'Git status is unknown.', [
    'pr:NO_PR',
    'git:UNKNOWN'
  ]),
  scenario(
    'no-pr-publish-in-progress',
    'delivery',
    'No PR, publish in progress',
    'Branch publication is already running.',
    ['pr:NO_PR', 'branch:PUSHING']
  ),
  scenario(
    'no-pr-publish-failed-retryable',
    'delivery',
    'No PR, retryable publish failure',
    'Last branch publication failed but can be retried.',
    ['pr:NO_PR', 'branch:FAILED']
  ),
  scenario(
    'no-pr-publish-failed-remote-newer',
    'delivery',
    'No PR, remote newer',
    'Remote branch has newer commits and must be reconciled.',
    ['pr:NO_PR', 'branch:FAILED', 'freshness:DIVERGED']
  ),
  scenario(
    'delivery-branch-pushed-no-pr',
    'delivery',
    'Branch pushed, no PR',
    'Branch is published but no pull request is linked.',
    ['pr:NO_PR', 'branch:PUSHED']
  ),
  scenario('delivery-draft-pr', 'delivery', 'Draft PR', 'Draft pull request exists.', [
    'pr:DRAFT'
  ]),
  scenario('delivery-open-pr', 'delivery', 'Open PR', 'Ready pull request exists without blockers.', [
    'pr:OPEN'
  ]),
  scenario('delivery-checks-pending', 'delivery', 'Checks pending', 'GitHub checks are pending.', [
    'pr:CHECKS_PENDING'
  ]),
  scenario('delivery-checks-failed', 'delivery', 'Checks failed', 'GitHub checks failed with details.', [
    'pr:CHECKS_FAILED'
  ]),
  scenario(
    'delivery-checks-canceled',
    'delivery',
    'Checks canceled',
    'GitHub checks were canceled.',
    ['pr:CHECKS_CANCELED']
  ),
  scenario(
    'delivery-no-required-checks',
    'delivery',
    'No required checks',
    'Checks ran, but no required checks reported.',
    ['pr:NO_REQUIRED_CHECKS']
  ),
  scenario(
    'delivery-review-waiting',
    'delivery',
    'GitHub review waiting',
    'GitHub review is requested and pending.',
    ['pr:GITHUB_REVIEW_WAITING']
  ),
  scenario(
    'delivery-changes-requested',
    'delivery',
    'GitHub changes requested',
    'GitHub review requested changes.',
    ['pr:GITHUB_CHANGES_REQUESTED']
  ),
  scenario('delivery-ready-to-merge', 'delivery', 'Ready to merge', 'PR is mergeable and checks passed.', [
    'pr:READY_TO_MERGE'
  ]),
  scenario('delivery-merged', 'delivery', 'Merged PR', 'PR is merged and completion policy is satisfied.', [
    'pr:MERGED',
    'phase:DONE'
  ]),
  scenario(
    'delivery-closed-unmerged',
    'delivery',
    'Closed without merge',
    'PR was closed without being merged.',
    ['pr:CLOSED_UNMERGED']
  ),
  scenario(
    'delivery-stale-evidence',
    'delivery',
    'Stale PR evidence',
    'CI evidence is for an older PR head.',
    ['pr:STALE']
  ),
  scenario(
    'delivery-local-not-pushed',
    'delivery',
    'Local changes not pushed',
    'Local branch has changes newer than PR evidence.',
    ['pr:LOCAL_NOT_PUSHED']
  ),
  scenario(
    'delivery-pr-newer-commits',
    'delivery',
    'PR has newer commits',
    'Remote PR head is newer than this worktree.',
    ['pr:PR_NEWER_COMMITS']
  ),
  scenario(
    'delivery-branch-diverged',
    'delivery',
    'Branch diverged',
    'Local branch and PR branch both changed.',
    ['pr:BRANCH_DIVERGED']
  ),
  scenario(
    'completion-merged-and-verified-failing',
    'completion',
    'Merged and verified, failing checks',
    'Merged PR is not enough because checks failed.',
    ['completion:MERGED_AND_VERIFIED', 'ci:FAILING']
  ),
  scenario(
    'completion-merged-and-verified-stale',
    'completion',
    'Merged and verified, stale checks',
    'Merged PR has stale verification evidence.',
    ['completion:MERGED_AND_VERIFIED', 'ci:STALE']
  ),
  scenario(
    'completion-merged-and-verified-passing',
    'completion',
    'Merged and verified, passing checks',
    'Merged PR plus passing checks completes the task.',
    ['completion:MERGED_AND_VERIFIED', 'ci:PASSING', 'phase:DONE']
  ),
  scenario(
    'completion-manual-merged',
    'completion',
    'Manual completion with merged PR',
    'Manual policy is not auto-completed by a merged PR.',
    ['completion:MANUAL', 'pr:MERGED']
  ),
  scenario('workflow-fork-alternative', 'workflow', 'Fork alternative', 'Task has a forked alternative.', [
    'workflow:fork'
  ]),
  scenario('task-canceled', 'workflow', 'Canceled task', 'Task is canceled as a terminal workflow state.', [
    'phase:CANCELED'
  ]),
  scenario('task-archived', 'workflow', 'Archived task', 'Task is archived as a terminal workflow state.', [
    'phase:ARCHIVED'
  ]),
  scenario('preview-missing-recipe', 'preview', 'Preview recipe missing', 'The task has a worktree but no explicit preview recipe.', ['preview:UNAVAILABLE']),
  scenario('preview-approval-required', 'preview', 'Preview approval required', 'A resolved native plan awaits explicit approval.', ['preview:APPROVAL_REQUIRED']),
  scenario('preview-active-approval-required', 'preview', 'Active preview needs new approval', 'The current preview remains actionable while a changed plan awaits approval.', ['preview:READY', 'replacement:APPROVAL_REQUIRED']),
  scenario('preview-preparing', 'preview', 'Preview preparing', 'Captured source preparation is in progress.', ['preview:PREPARING_SOURCE']),
  scenario('preview-ready', 'preview', 'Preview ready', 'Readiness passed and the stable route is attached.', ['preview:READY']),
  scenario('preview-oci-ready', 'preview', 'OCI preview ready', 'PostgreSQL and Redis are ready after the selected migration and seed scenario.', ['preview:READY', 'resources:POSTGRES_REDIS']),
  scenario('preview-compose-approval-required', 'preview', 'Compose preview approval required', 'Normalized Compose authority is ready for explicit approval.', ['preview:APPROVAL_REQUIRED', 'adapter:COMPOSE']),
  scenario('preview-compose-updating', 'preview', 'Compose preview updating', 'The stable Compose project is inside serialized activation.', ['preview:RUNNING_GRAPH', 'adapter:COMPOSE']),
  scenario('preview-compose-reset-required', 'preview', 'Compose preview reset required', 'A data compatibility change requires explicit destructive reset.', ['preview:RECOVERY_REQUIRED', 'adapter:COMPOSE', 'change:DESTRUCTIVE_RESET_REQUIRED']),
  scenario('preview-compose-ready', 'preview', 'Compose preview ready', 'One task-scoped Compose project is ready with stable routes and owned data.', ['preview:READY', 'adapter:COMPOSE']),
  scenario('preview-compose-recovery', 'preview', 'Compose preview recovery', 'Serialized Compose activation failed while owned volumes remained preserved.', ['preview:RECOVERY_REQUIRED', 'adapter:COMPOSE']),
  scenario('preview-replacing', 'preview', 'Preview replacing', 'The active preview stays routed while a candidate waits for readiness.', ['preview:REPLACING']),
  scenario('preview-replacement-failed', 'preview', 'Preview replacement failed', 'A failed candidate leaves the active preview available.', ['preview:READY', 'replacement:FAILED']),
  scenario('preview-failed', 'preview', 'Preview failed', 'A preview job failed with retained bounded logs.', ['preview:FAILED']),
  scenario('preview-stale', 'preview', 'Preview stale', 'A ready preview serves captured source older than current Git evidence.', ['preview:READY', 'freshness:STALE']),
  scenario('preview-stopped', 'preview', 'Preview stopped', 'Owned runtime state was removed while compact evidence remains.', ['preview:STOPPED']),
  scenario('preview-recovery-required', 'preview', 'Preview recovery required', 'Restart recovery has not yet verified the recorded process.', ['preview:RECOVERY_REQUIRED']),
  scenario('preview-cleanup-incomplete', 'preview', 'Preview cleanup incomplete', 'Task Monki refused cleanup because ownership could not be verified.', ['preview:CLEANUP_INCOMPLETE']),
  scenario('discourse-empty', 'discourse', 'Empty discourse', 'A new human conversation with no messages.', ['discourse:empty']),
  scenario('discourse-context-picker', 'discourse', 'Context picker draft', 'A durable draft with task and repository context.', ['discourse:draft', 'context:structured']),
  scenario('discourse-human-only', 'discourse', 'Human-only conversation', 'Human notes, reply ancestry, and a correction.', ['discourse:human-only']),
  scenario('discourse-team-running', 'discourse', 'Team response running', 'A lead response is running while reviewers wait.', ['discourse:team', 'status:RUNNING']),
  scenario('discourse-panel-partial', 'discourse', 'Partial panel', 'One independent panel answer completed while another failed.', ['discourse:panel', 'status:PARTIAL']),
  scenario('discourse-review-silent', 'discourse', 'Review with no concerns', 'Both reviewers returned explicit no-concern receipts.', ['discourse:review', 'outcome:NO_CONCERN_FOUND']),
  scenario('discourse-author-correction', 'discourse', 'Author correction', 'A material review concern produced an attributable correction.', ['discourse:correction']),
  scenario('discourse-followup-queued', 'discourse', 'Follow-up queued', 'A follow-up waits behind the active response.', ['discourse:queue']),
  scenario('discourse-context-stale', 'discourse', 'Context changed', 'Dispatch awaits reconfirmation after context changed.', ['discourse:context', 'freshness:STALE']),
  scenario('discourse-context-unavailable', 'discourse', 'Context unavailable', 'Historical context remains visible when its source is unavailable.', ['discourse:context', 'availability:UNAVAILABLE']),
  scenario('discourse-recovery-required', 'discourse', 'Recovery required', 'Ambiguous delivery is fenced for explicit recovery.', ['discourse:recovery']),
  scenario('discourse-canceled', 'discourse', 'Response canceled', 'A stopped response remains attributable without implying failure or silence.', ['discourse:canceled']),
  scenario('discourse-long-history', 'discourse', 'Long conversation', 'A paginated transcript preserves stable reading position.', ['discourse:pagination']),
  scenario('discourse-archived', 'discourse', 'Archived conversation', 'A completed conversation in the archive.', ['discourse:archived'])
];
