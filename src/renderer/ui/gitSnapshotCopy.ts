import type { AgentReviewGateProjection, GitSnapshotRecord } from '../../shared/contracts';

export function describeGitSnapshot(snapshot?: GitSnapshotRecord): string {
  if (!snapshot) {
    return 'not captured';
  }
  const files =
    snapshot.workingDiffFileCount ||
    snapshot.committedDiffFileCount ||
    snapshot.stagedCount + snapshot.unstagedCount + snapshot.untrackedCount;
  const fileLabel = `${files} file${files === 1 ? '' : 's'}`;
  const head = snapshot.headSha?.slice(0, 8) ?? 'unknown';
  return `${head} · ${fileLabel} · ${gitStatusLabel(snapshot.status)}`;
}

function gitStatusLabel(status: GitSnapshotRecord['status']): string {
  if (status === 'COMMITTED_UNPUSHED') {
    return 'committed, not pushed';
  }
  return status.toLowerCase().replaceAll('_', ' ');
}

export function describeReviewedDiff(
  reviewGate: AgentReviewGateProjection,
  currentSnapshot?: GitSnapshotRecord
): string {
  const head = reviewGate.reviewedHeadSha ?? currentSnapshot?.headSha;
  const fingerprint = reviewGate.reviewedDirtyFingerprint;
  if (!head && !fingerprint) {
    return 'not captured';
  }
  return `${head?.slice(0, 8) ?? 'unknown'}${fingerprint ? ` · fp ${fingerprint.slice(0, 8)}` : ''}`;
}
