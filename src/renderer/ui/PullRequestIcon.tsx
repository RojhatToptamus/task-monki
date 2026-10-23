import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from 'lucide-react';

const PULL_REQUEST_ICONS = {
  draft: GitPullRequestDraft,
  open: GitPullRequest,
  merged: GitMerge,
  closed: GitPullRequestClosed
} as const;

/** GitHub's convention: the icon carries a pull request's state, its number names it. */
export function PullRequestStateIcon({ state }: { state: keyof typeof PULL_REQUEST_ICONS }) {
  const Icon = PULL_REQUEST_ICONS[state];
  return <Icon aria-hidden="true" size={13} />;
}
