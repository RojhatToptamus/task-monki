import type { AgentGoalSnapshotRecord, Finding } from '../../shared/contracts';

export interface HealthFindingView {
  title: string;
  detail: string;
  meta: string;
}

export function describeHealthFinding(finding: Finding): HealthFindingView {
  return {
    title: healthFindingTitle(finding.code),
    detail: finding.message,
    meta: formatFindingTime(finding.createdAt)
  };
}

export function shouldShowProviderGoalDiagnostics(
  goal: AgentGoalSnapshotRecord | undefined,
  hasSession: boolean
): boolean {
  if (!hasSession || !goal) {
    return false;
  }
  return goal.syncState !== 'IN_SYNC' || Boolean(goal.detail);
}

function healthFindingTitle(code: string): string {
  switch (code) {
    case 'AGENT_MUTATION_AMBIGUOUS':
      return 'Delivery status uncertain';
    case 'AGENT_PROTOCOL_INCIDENT':
      return 'Provider protocol issue';
    case 'AGENT_REVIEW_CHANGED_GIT':
      return 'Review changed files';
    case 'PROCESS_NON_ZERO_EXIT':
      return 'Runtime exited unexpectedly';
    case 'PROCESS_EXITED_WITHOUT_AGENT_TERMINAL_EVENT':
      return 'Runtime stopped before the run finished';
    case 'WORKTREE_OPERATION_FAILED':
      return 'Worktree operation failed';
    case 'WORKFLOW_TRANSITION_BLOCKED':
      return 'Workflow transition blocked';
    case 'LOCAL_TESTS_NOT_PASSING':
      return 'Local tests need attention';
    case 'GITHUB_PREFLIGHT_NOT_READY':
      return 'GitHub setup needs attention';
    case 'BRANCH_PUBLISH_FAILED':
      return 'Branch publish failed';
    case 'PR_CLOSED_WITHOUT_MERGE':
      return 'Pull request closed without merge';
    default:
      return humanizeCode(code);
  }
}

function formatFindingTime(value: string): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    return 'unknown time';
  }
  return new Date(time).toLocaleString();
}

function humanizeCode(code: string): string {
  return code
    .toLowerCase()
    .split('_')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}
