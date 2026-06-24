import { useEffect, useState } from 'react';
import type {
  ArtifactRecord,
  BranchPublicationRecord,
  CiRollupRecord,
  GitSnapshotRecord,
  GitHubRepositoryRecord,
  MergeSnapshotRecord,
  PullRequestSnapshotRecord,
  ReviewRollupRecord,
  RunRecord,
  TestRunRecord,
  WorktreeRecord
} from '../../shared/contracts';
import { taskManagerApi } from '../api/taskManagerClient';
import { StatusChip } from './StatusBadge';
import { humanizeEnum } from './display';

interface EvidencePanelProps {
  run?: RunRecord;
  worktree?: WorktreeRecord;
  gitSnapshot?: GitSnapshotRecord;
  testRun?: TestRunRecord;
  githubRepository?: GitHubRepositoryRecord;
  branchPublication?: BranchPublicationRecord;
  pullRequest?: PullRequestSnapshotRecord;
  ciRollup?: CiRollupRecord;
  reviewRollup?: ReviewRollupRecord;
  mergeSnapshot?: MergeSnapshotRecord;
  artifacts: ArtifactRecord[];
}

export function EvidencePanel({
  run,
  worktree,
  gitSnapshot,
  testRun,
  githubRepository,
  branchPublication,
  pullRequest,
  ciRollup,
  reviewRollup,
  mergeSnapshot,
  artifacts
}: EvidencePanelProps) {
  const [artifactText, setArtifactText] = useState('');
  const [artifactError, setArtifactError] = useState<string | undefined>();

  const diffArtifact = gitSnapshot?.diffArtifactId
    ? artifacts.find((artifact) => artifact.id === gitSnapshot.diffArtifactId)
    : undefined;
  const testStdoutArtifact = testRun
    ? artifacts.find((artifact) => artifact.id === testRun.stdoutArtifactId)
    : undefined;

  useEffect(() => {
    let canceled = false;

    async function loadArtifact() {
      setArtifactError(undefined);
      setArtifactText('');

      const artifactId = diffArtifact?.id ?? testStdoutArtifact?.id;
      if (!artifactId) {
        return;
      }

      try {
        const text = await taskManagerApi.readArtifact({ artifactId });
        if (!canceled) {
          setArtifactText(text);
        }
      } catch (error) {
        if (!canceled) {
          setArtifactError(error instanceof Error ? error.message : 'Could not read artifact.');
        }
      }
    }

    void loadArtifact();
    return () => {
      canceled = true;
    };
  }, [diffArtifact?.id, testStdoutArtifact?.id]);

  return (
    <>
    <section className="card card--evidence">
      <div className="card__header">
        <div>
          <h3>Verified locally by Task Monki</h3>
          <p className="provider-subtitle">
            Git, tests, and delivery state observed independently of Codex.
          </p>
        </div>
        {run ? <span className="card__header-mono">Run {run.id.slice(0, 8)}</span> : <span>No run</span>}
      </div>

      {run || worktree || gitSnapshot || testRun || pullRequest ? (
        <div className="evidence-stack">
          <div className="evidence-grid">
            {worktree ? <StatusChip label="Worktree" value={worktree.status} /> : null}
            {gitSnapshot ? <StatusChip label="Git" value={gitSnapshot.status} /> : null}
            {testRun ? <StatusChip label="Tests" value={testRun.status} /> : null}
            {githubRepository ? <StatusChip label="GitHub" value={githubRepository.status} /> : null}
            {branchPublication ? <StatusChip label="Publish" value={branchPublication.status} /> : null}
            {pullRequest ? <StatusChip label="PR" value={pullRequest.status} /> : null}
            {ciRollup ? <StatusChip label="Checks" value={ciRollup.status} /> : null}
            {reviewRollup ? <StatusChip label="Reviews" value={reviewRollup.status} /> : null}
            {mergeSnapshot ? <StatusChip label="Merge" value={mergeSnapshot.status} /> : null}
          </div>
          {gitSnapshot ? (
            <div className="kv-grid kv-grid--compact">
              <span>Head</span>
              <strong>{gitSnapshot.headSha?.slice(0, 12) ?? 'unknown'}</strong>
              <span>Dirty fingerprint</span>
              <strong>{gitSnapshot.dirtyFingerprint.slice(0, 12)}</strong>
              <span>Changed files</span>
              <strong>
                committed {gitSnapshot.committedDiffFileCount}, working {gitSnapshot.workingDiffFileCount}
              </strong>
              <span>Counts</span>
              <strong>
                staged {gitSnapshot.stagedCount}, unstaged {gitSnapshot.unstagedCount}, untracked{' '}
                {gitSnapshot.untrackedCount}
              </strong>
            </div>
          ) : null}
          {testRun ? (
            <div className="kv-grid kv-grid--compact">
              <span>Test command</span>
              <strong>{testRun.command}</strong>
              <span>Tested head</span>
              <strong>{testRun.testedHeadSha?.slice(0, 12) ?? 'unknown'}</strong>
              <span>Tested fingerprint</span>
              <strong>{testRun.testedDirtyFingerprint?.slice(0, 12) ?? 'unknown'}</strong>
              <span>Exit</span>
              <strong>{testRun.exitCode === undefined ? '—' : String(testRun.exitCode)}</strong>
            </div>
          ) : null}
          {githubRepository || pullRequest ? (
            <div className="kv-grid kv-grid--compact">
              <span>Remote</span>
              <strong>
                {githubRepository?.owner && githubRepository.repo
                  ? `${githubRepository.owner}/${githubRepository.repo}`
                  : githubRepository?.status
                    ? humanizeEnum(githubRepository.status)
                    : 'unknown'}
              </strong>
              <span>Published branch</span>
              <strong>{branchPublication?.remoteRef ?? 'not pushed'}</strong>
              <span>Pull request</span>
              <strong>{pullRequest?.url ?? 'not created'}</strong>
              <span>PR head</span>
              <strong>{pullRequest?.headRefOid?.slice(0, 12) ?? 'unknown'}</strong>
              <span>Checks</span>
              <strong>
                {ciRollup
                  ? `${humanizeEnum(ciRollup.status)}: ${ciRollup.passingCount} passing, ${ciRollup.failingCount} failing, ${ciRollup.pendingCount} pending`
                  : 'not synced'}
              </strong>
              <span>Reviews / merge</span>
              <strong>
                {reviewRollup?.status ? humanizeEnum(reviewRollup.status) : 'not synced'} /{' '}
                {mergeSnapshot?.status ? humanizeEnum(mergeSnapshot.status) : 'not synced'}
              </strong>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="muted">Prepare a worktree to capture Git, agent, diff, and test evidence.</p>
      )}
    </section>

    {diffArtifact || testStdoutArtifact ? (
      <section className="card card--artifact">
        <div className="card__header card__header--invert">
          <h3>{artifactLabel({ diffArtifact, testStdoutArtifact })}</h3>
          <span className="card__header-mono">
            {diffArtifact?.byteCount ?? testStdoutArtifact?.byteCount ?? 0}{' '}
            bytes
          </span>
        </div>
        {artifactError ? <p className="form-error">{artifactError}</p> : null}
        <pre className="artifact-pre">{artifactText || 'No artifact content yet.'}</pre>
      </section>
    ) : null}
    </>
  );
}

function artifactLabel(input: {
  diffArtifact?: ArtifactRecord;
  testStdoutArtifact?: ArtifactRecord;
}): string {
  if (input.diffArtifact) {
    return 'Git diff artifact';
  }
  if (input.testStdoutArtifact) {
    return 'Test stdout artifact';
  }
  return 'Local evidence artifact';
}
