import { describe, expect, it } from 'vitest';
import { gitHubPullRequestLocation, parseGitHubPullRequestFeedback } from './GitHubPullRequestFeedback';

const capturedAt = '2026-10-11T00:00:00.000Z';
const comment = (id: string, login: string, body: string, extra: Record<string, unknown> = {}) => ({
  id, body, createdAt: '2026-10-10T10:00:00Z', url: `https://github.com/acme/widgets/pull/9#discussion_${id}`, isMinimized: false,
  author: { login }, ...extra
});

describe('parseGitHubPullRequestFeedback', () => {
  it('keeps where each thread was written, and a reviewer\'s verdict over their later comments', () => {
    const feedback = parseGitHubPullRequestFeedback({
      viewer: { login: 'me' },
      repository: { pullRequest: {
        headRefOid: 'a'.repeat(40),
        reviewThreads: { totalCount: 3, nodes: [
          { id: 'range', isResolved: false, isOutdated: false, path: 'src/a.ts', line: 14, startLine: 12, originalLine: 14, originalStartLine: 12,
            diffSide: 'RIGHT', startDiffSide: 'RIGHT', subjectType: 'LINE',
            first: { totalCount: 2, nodes: [comment('r1', 'alice', 'Split this.')] },
            recent: { nodes: [comment('r1', 'alice', 'Split this.'), comment('r2', 'me', 'Done.')] } },
          // An outdated thread has no line in today's diff; it keeps the one it was written on.
          { id: 'outdated', isResolved: false, isOutdated: true, path: 'src/a.ts', line: null, originalLine: 3, diffSide: 'LEFT', subjectType: 'LINE',
            first: { totalCount: 1, nodes: [comment('o1', 'bob', 'Keep this check.')] }, recent: { nodes: [comment('o1', 'bob', 'Keep this check.')] } },
          { id: 'file', isResolved: true, isOutdated: false, path: 'README.md', line: null, diffSide: 'RIGHT', subjectType: 'FILE',
            first: { totalCount: 1, nodes: [comment('f1', 'carol', 'Mention the flag.')] }, recent: { nodes: [] } }
        ] },
        latestReviews: { nodes: [
          { id: 'PRR_late', state: 'COMMENTED', body: 'One more nit.', submittedAt: '2026-10-10T12:00:00Z', url: 'https://github.com/acme/widgets/pull/9#r', author: { login: 'alice' } },
          { id: 'PRR_ok', state: 'APPROVED', body: '', author: { login: 'dave' } }
        ] },
        latestOpinionatedReviews: { nodes: [
          { id: 'PRR_changes', state: 'CHANGES_REQUESTED', body: 'Null layouts crash.', submittedAt: '2026-10-10T11:00:00Z', url: 'https://github.com/acme/widgets/pull/9#c', author: { login: 'alice' } },
          { id: 'PRR_ok', state: 'APPROVED', body: '', author: { login: 'dave' } }
        ] },
        reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'Team', name: 'core' } }, { requestedReviewer: { __typename: 'User', login: 'dave' } }] },
        comments: { totalCount: 40, nodes: [
          comment('IC_1', 'erin', 'Can we ship this today?'),
          comment('IC_2', 'vercel', 'Preview ready.', { author: { __typename: 'Bot', login: 'vercel' } }),
          comment('IC_3', 'spam', 'Buy now.', { isMinimized: true })
        ] }
      } }
    }, 9, capturedAt)!;

    expect(feedback.discussions.map((discussion) => [discussion.id, discussion.kind])).toEqual([
      ['range', 'THREAD'], ['outdated', 'THREAD'], ['file', 'THREAD'], ['PRR_late', 'REVIEW'], ['PRR_changes', 'REVIEW'], ['IC_1', 'COMMENT']
    ]);
    expect(feedback.discussions[0]).toMatchObject({ path: 'src/a.ts', side: 'NEW', line: 12, endLine: 14, commentCount: 2,
      comments: [{ author: 'alice', body: 'Split this.' }, { author: 'me', body: 'Done.' }] });
    expect(feedback.discussions[1]).toMatchObject({ side: 'OLD', line: 3, outdated: true });
    expect(feedback.discussions[2]).toMatchObject({ path: 'README.md', resolved: true });
    expect(feedback.discussions[2]).not.toHaveProperty('line');
    expect(feedback.discussions[4]).toMatchObject({ reviewState: 'CHANGES_REQUESTED', comments: [{ author: 'alice', body: 'Null layouts crash.' }] });
    // Alice's later comment does not undo her request for changes; a fresh request for review puts Dave back to waiting.
    expect(feedback.reviewers).toEqual([
      { name: 'alice', state: 'CHANGES_REQUESTED' }, { name: 'dave', state: 'REQUESTED' }, { name: 'core', state: 'REQUESTED' }
    ]);
    // Only the last 30 conversation comments are read.
    expect(feedback.truncated).toBe(true);
    expect(feedback.viewer).toBe('me');
  });

  it('reads nothing for a pull request GitHub did not return', () => {
    expect(parseGitHubPullRequestFeedback({ repository: { pullRequest: null } }, 9, capturedAt)).toBeUndefined();
    expect(gitHubPullRequestLocation('https://github.com/acme/widgets/pull/9')).toEqual({ host: 'github.com', owner: 'acme', name: 'widgets', number: 9 });
    expect(gitHubPullRequestLocation('https://github.com/acme/widgets/issues/9')).toBeUndefined();
  });
});
