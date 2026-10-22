import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_REVIEW_DRAFT, type ArtifactRecord, type TaskReviewDraft } from '../../shared/contracts';
import type { DiscussionView } from '../model/pullRequestFeedback';
import { planReviewRequest } from '../model/reviewFollowUp';
import type { ReviewFindingView } from '../model/reviewWorkspace';
import { ReviewWorkspace, type ReviewWorkspaceProps } from './ReviewWorkspace';

const api = vi.hoisted(() => ({ readArtifact: vi.fn(), readReviewChanges: vi.fn() }));
vi.mock('../api/taskManagerClient', () => ({ taskManagerApi: { readArtifact: api.readArtifact, readReviewChanges: api.readReviewChanges } }));

function artifact(id = 'diff-1'): ArtifactRecord {
  return { id, taskId: 'task-1', kind: 'diff', path: `/tmp/${id}.md`, byteCount: 256, createdAt: '2026-07-07T10:10:00.000Z', updatedAt: '2026-07-07T10:10:00.000Z' };
}

function section(label: string, body: string): string {
  return `## ${label}\n\n${body}\n`;
}

function fileDiff(path: string, hunk: string): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunk}`;
}

function diffFor(path: string, added = 'new'): string {
  return `# Git diff evidence\n\n${section('Committed diff', fileDiff(path, `@@ -1 +1 @@\n-old\n+${added}`))}\n${section('Staged diff', 'No staged diff.')}\n${section('Unstaged diff', 'No unstaged diff.')}`;
}

const finding: ReviewFindingView = {
  id: 'f1', severity: 'MAJOR', title: 'Limiter state is per process', explanation: 'Each replica keeps its own buckets.',
  recommendation: 'Keep buckets in Redis.', path: 'src/rateLimit.ts', line: 1, state: 'OPEN'
};
const suggestion: ReviewFindingView = {
  id: 'f2', severity: 'MINOR', title: 'Name the limit', explanation: 'A bare number.', path: 'src/rateLimit.ts', line: 1, state: 'OPEN'
};

function Harness(overrides: Partial<ReviewWorkspaceProps> & { onSubmit?(draft: TaskReviewDraft): void }) {
  const [draft, setDraft] = useState<TaskReviewDraft>(EMPTY_REVIEW_DRAFT);
  const review = 'review' in overrides ? overrides.review : { status: 'NEEDS_CHANGES' as const, reviewedAt: '2026-07-07T10:12:00.000Z', runId: 'review-1' };
  const findings = overrides.findings ?? [finding];
  const findingsSendable = review?.status !== 'STALE' && review?.status !== 'RUNNING';
  return (
    <ReviewWorkspace
      taskId={`task-${Math.random()}`}
      currentDiffArtifactId="diff-1"
      artifacts={[artifact()]}
      draft={draft}
      onDraftChange={setDraft}
      plan={planReviewRequest(findings, draft, { runId: review?.runId, findingsSendable, asksForChanges: false }, overrides.discussions ?? [])}
      findingsSendable={findingsSendable}
      requestChanges={{ busy: false, instruction: () => 'Address the review.', onSubmit: () => overrides.onSubmit?.(draft) }}
      {...overrides}
      review={review}
      findings={findings}
    />
  );
}

describe('ReviewWorkspace captured diff states', () => {
  beforeEach(() => {
    api.readArtifact.mockReset();
    window.localStorage.clear();
  });

  it('never reports no changes when the captured diff cannot be read', async () => {
    api.readArtifact.mockRejectedValueOnce(new Error('artifact unavailable'));
    render(<Harness findings={[]} />);

    expect(await screen.findByText('The captured diff could not be read.')).toBeDefined();
    expect(screen.queryByText('No changes in this scope.')).toBeNull();
  });

  it('does not turn an incomplete capture without paths into an empty one', async () => {
    api.readArtifact.mockResolvedValueOnce('# Git diff evidence\n\n## Committed diff unavailable\n\ngit failed\n');
    render(<Harness findings={[]} />);

    expect(await screen.findByText('No paths could be confirmed from the incomplete capture.')).toBeDefined();
    expect(screen.getByRole('status').textContent).toContain('incomplete');
    expect(screen.queryByText('No changes in this scope.')).toBeNull();
  });

  it('does not show paths from a previous capture while the next one loads', async () => {
    let resolveSecond: (text: string) => void = () => undefined;
    api.readArtifact
      .mockResolvedValueOnce(diffFor('src/first.ts'))
      .mockReturnValueOnce(new Promise<string>((resolve) => { resolveSecond = resolve; }));
    const { rerender } = render(<Harness findings={[]} />);
    expect(await screen.findByRole('region', { name: 'src/first.ts' })).toBeDefined();

    rerender(<Harness findings={[]} currentDiffArtifactId="diff-2" artifacts={[artifact('diff-2')]} />);
    expect(screen.queryByRole('region', { name: 'src/first.ts' })).toBeNull();
    expect(screen.getByText('Loading changes…')).toBeDefined();

    await act(async () => { resolveSecond(diffFor('src/second.ts')); });
    expect(screen.getByRole('region', { name: 'src/second.ts' })).toBeDefined();
  });

  it('states whether each changed line was added or removed without relying on colour', async () => {
    api.readArtifact.mockResolvedValueOnce(diffFor('src/first.ts'));
    render(<Harness findings={[]} />);

    expect(await screen.findByText((_, element) => element?.tagName === 'CODE' && element.textContent === 'Removed: old')).toBeDefined();
    expect(screen.getByText((_, element) => element?.tagName === 'CODE' && element.textContent === 'Added: new')).toBeDefined();
  });

  it('labels an earlier capture and leaves findings, comments and requests out of it', async () => {
    api.readArtifact.mockResolvedValueOnce(diffFor('src/rateLimit.ts'));
    const onBack = vi.fn();
    render(<Harness historical={{ capturedAt: '2026-07-07T09:00:00.000Z', headSha: 'c'.repeat(40), onBack }} />);

    expect(await screen.findByRole('region', { name: 'src/rateLimit.ts' })).toBeDefined();
    expect(screen.getByText('Earlier capture')).toBeDefined();
    expect(screen.queryByText('Limiter state is per process')).toBeNull();
    expect(screen.queryByRole('button', { name: /Comment on/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Request changes' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to current changes' }));
    expect(onBack).toHaveBeenCalledOnce();
  });
});

describe('ReviewWorkspace findings, comments and the request', () => {
  beforeEach(() => {
    api.readArtifact.mockReset();
    window.localStorage.clear();
  });

  it('shows the agent\'s answers to the last request and a re-review\'s resolved, still-open and new findings', async () => {
    api.readArtifact.mockResolvedValueOnce(diffFor('src/rateLimit.ts'));
    const onReply = vi.fn();
    render(<Harness
      findings={[{ ...finding, previousFindingId: 'old-leak' }, suggestion]}
      resolvedFindings={[{ previousFindingId: 'naming', title: 'Unclear name', note: 'Renamed.' }]}
      brief={{
        asked: 'Rate-limit the API.',
        round: {
          key: 'request-1',
          request: { reviewRunId: 'review-1', items: [
            { number: 1, kind: 'FINDING', findingId: 'f1', severity: 'MAJOR', title: 'Limiter state is per process', path: 'src/rateLimit.ts', line: 1 },
            { number: 2, kind: 'COMMENT', path: 'src/rateLimit.ts', side: 'NEW', line: 1, text: 'Which window?' }
          ] },
          answers: [{ item: 1, outcome: 'FIXED', note: 'Moved to Redis.' }, { item: 2, outcome: 'NEEDS_DECISION', note: 'One minute or five?' }],
          onReply
        }
      }}
    />);

    const answers = await screen.findByRole('list', { name: 'Answers to the review request' });
    expect(within(answers).getByText('Fixed')).toBeDefined();
    expect(within(answers).getByText('Moved to Redis.')).toBeDefined();
    expect(within(answers).getByText('Needs your decision')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    expect(onReply).toHaveBeenCalled();

    const thread = await screen.findByRole('article', { name: 'Major finding: Limiter state is per process' });
    expect(within(thread).getByText('Still open')).toBeDefined();
    expect(within(screen.getByRole('article', { name: 'Minor finding: Name the limit' })).getByText('New')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /^Feedback/ }));
    expect(within(screen.getByRole('navigation', { name: 'Feedback' })).getByText('Unclear name')).toBeDefined();
  });

  it('shows a finding under its line and dismisses it with a reason, or a reason and a note', async () => {
    api.readArtifact.mockResolvedValueOnce(diffFor('src/rateLimit.ts'));
    const onDismiss = vi.fn(async () => undefined);
    render(<Harness findings={[finding, suggestion]} onDismissFinding={onDismiss} />);

    const thread = await screen.findByRole('article', { name: 'Major finding: Limiter state is per process' });
    expect(thread.closest('.tm-review-line-group')?.querySelector('code')?.textContent).toBe('Added: new');
    const openDismiss = async (article: HTMLElement) => {
      const trigger = within(article).getByRole('button', { name: 'Dismiss this finding' });
      trigger.focus();
      fireEvent.keyDown(trigger, { key: 'ArrowDown' });
      return screen.findByRole('menu', { name: 'Dismiss this finding' });
    };

    const menu = await openDismiss(thread);
    await act(async () => { fireEvent.click(within(menu).getByRole('menuitem', { name: 'Incorrect' })); });
    expect(onDismiss).toHaveBeenLastCalledWith('f1', 'NOT_A_PROBLEM');

    // D on the focused finding opens the reason and note.
    const minor = screen.getByRole('article', { name: 'Minor finding: Name the limit' });
    act(() => minor.focus());
    fireEvent.keyDown(minor, { key: 'd' });
    fireEvent.click(within(minor).getByRole('button', { name: 'Intentional' }));
    fireEvent.change(within(minor).getByLabelText('A note for the next review (optional)'), { target: { value: 'Matches the codebase' } });
    await act(async () => { fireEvent.click(within(minor).getByRole('button', { name: 'Dismiss' })); });
    expect(onDismiss).toHaveBeenLastCalledWith('f2', 'ACCEPTED', 'Matches the codebase');
  });

  it('sends Minor and Nit findings only once the person adds them', async () => {
    api.readArtifact.mockResolvedValueOnce(diffFor('src/rateLimit.ts'));
    const onSubmit = vi.fn();
    render(<Harness findings={[finding, suggestion]} onSubmit={onSubmit} />);

    const minor = await screen.findByRole('article', { name: 'Minor finding: Name the limit' });
    expect(screen.getByRole('button', { name: /^1 fix/ })).toBeDefined();
    fireEvent.click(within(minor).getByRole('button', { name: 'Add to request' }));
    expect(screen.getByRole('button', { name: /^2 fixes/ })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ includedFindingIds: ['f2'], reviewRunId: 'review-1' }));
  });

  it('saves a comment to the draft and sends it with the note', async () => {
    api.readArtifact.mockResolvedValueOnce(diffFor('src/rateLimit.ts'));
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Comment on line 1' }));
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Return seconds here.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect(screen.getByText('Return seconds here.')).toBeDefined();
    expect(screen.getByRole('button', { name: /^1 fix, 1 comment/ })).toBeDefined();

    fireEvent.change(screen.getByLabelText('A note for the agent'), { target: { value: 'Keep the signature.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      note: 'Keep the signature.',
      comments: [expect.objectContaining({ path: 'src/rateLimit.ts', side: 'NEW', line: 1, text: 'Return seconds here.' })]
    }));
  });

  it('comments on a removed line and on a range dragged across line numbers', async () => {
    api.readArtifact.mockResolvedValueOnce(`# Git diff evidence\n\n${section('Unstaged diff', fileDiff('src/a.ts', '@@ -1,2 +1,3 @@\n-gone\n+one\n+two\n+three'))}`);
    const onSubmit = vi.fn();
    render(<Harness findings={[]} onSubmit={onSubmit} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Comment on removed line 1' }));
    expect(screen.getByText('Removed line 1')).toBeDefined();
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Why was this removed?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

    // Press the first added line's number and drag to the third: one comment covers the range.
    const numbers = [...document.querySelectorAll<HTMLElement>('.tm-diffline__num')];
    const first = numbers.find((element) => element.textContent === '1' && element.closest('.tm-diffline--addition'))!;
    const third = numbers.find((element) => element.textContent === '3')!;
    fireEvent.pointerDown(first, { button: 0 });
    fireEvent.pointerOut(first, { relatedTarget: third });
    fireEvent.pointerOver(third, { relatedTarget: first });
    fireEvent.pointerUp(window);
    expect(screen.getByText('Lines 1–3')).toBeDefined();
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Collapse these.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ comments: [
      expect.objectContaining({ side: 'OLD', line: 1, text: 'Why was this removed?' }),
      expect.objectContaining({ side: 'NEW', line: 1, endLine: 3, text: 'Collapse these.' })
    ] }));
  });

  it('opens one composer when a file shows the same line number in two Git layers', async () => {
    api.readArtifact.mockResolvedValueOnce(`# Git diff evidence\n\n${section('Committed diff', fileDiff('src/a.ts', '@@ -1 +1 @@\n-old\n+committed'))}\n${section('Unstaged diff', fileDiff('src/a.ts', '@@ -1 +1 @@\n-committed\n+unstaged'))}`);
    render(<Harness findings={[]} />);

    fireEvent.click((await screen.findAllByRole('button', { name: 'Comment on line 1' }))[0]!);
    expect(screen.getAllByLabelText('Comment')).toHaveLength(1);
  });

  it('collapses a viewed file but keeps its open findings in view', async () => {
    api.readArtifact.mockResolvedValueOnce(diffFor('src/rateLimit.ts'));
    render(<Harness />);

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Viewed' }));
    expect(screen.queryByText((_, element) => element?.tagName === 'CODE' && element.textContent === 'Added: new')).toBeNull();
    const file = screen.getByRole('region', { name: 'src/rateLimit.ts' });
    expect(screen.getByLabelText('1 of 1 viewed')).toBeDefined();

    fireEvent.click(within(file).getByRole('button', { name: /Limiter state is per process/ }));
    expect(await screen.findByRole('article', { name: 'Major finding: Limiter state is per process' })).toBeDefined();
  });

  it('shows exactly what will be sent before sending it', async () => {
    api.readArtifact.mockResolvedValueOnce(diffFor('src/rateLimit.ts'));
    render(<Harness findings={[finding, suggestion, { ...suggestion, id: 'f3', title: 'Old idea', state: 'DISMISSED', dismissal: { reason: 'NOT_A_PROBLEM', decidedAt: '2026-07-07T10:13:00.000Z' } }]} />);

    fireEvent.click(await screen.findByRole('button', { name: /^1 fix/ }));
    const sheet = screen.getByRole('dialog', { name: 'Request changes' });
    expect(within(within(sheet).getByRole('region', { name: 'To fix' })).getByText('Limiter state is per process')).toBeDefined();
    const leftOut = within(sheet).getByRole('region', { name: 'Left out' });
    expect(within(leftOut).getByText('Suggestion')).toBeDefined();
    expect(within(leftOut).getByText('Marked incorrect')).toBeDefined();
    expect(within(sheet).getByText('Address the review.')).toBeDefined();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Request changes' })).toBeNull();
  });

  it('keeps an out-of-date review’s findings as context and still sends the person’s comments', async () => {
    api.readArtifact.mockResolvedValueOnce(diffFor('src/rateLimit.ts'));
    const onSubmit = vi.fn();
    render(<Harness review={{ status: 'STALE', runId: 'review-1' }} onDismissFinding={vi.fn()} onAskAboutFinding={vi.fn()} onSubmit={onSubmit} />);

    const thread = await screen.findByRole('article', { name: /Limiter state is per process/ });
    expect(within(thread).queryByRole('button', { name: 'Dismiss this finding' })).toBeNull();
    expect(within(thread).getByText('From the earlier review')).toBeDefined();
    expect(screen.queryByRole('button', { name: /^1 fix/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Request changes' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Comment on line 1' }));
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Still wrong.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect(screen.getByRole('button', { name: /^1 comment/ })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('shows every change for an out-of-date review when nothing changed since it, never an empty scope', async () => {
    api.readArtifact.mockImplementation(async () => diffFor('src/rateLimit.ts'));
    render(<Harness
      review={{ status: 'STALE', runId: 'review-1' }}
      artifacts={[artifact('diff-1'), artifact('diff-0')]}
      reviewedDiffArtifactId="diff-0"
    />);

    expect(await screen.findByRole('region', { name: 'src/rateLimit.ts' })).toBeDefined();
    expect(screen.queryByText('Nothing changed since the review.')).toBeNull();
    expect(screen.getByRole('button', { name: /Changes to show/ }).textContent).toContain('All changes');
  });

  it('leads with the changes since an out-of-date review when there are some', async () => {
    api.readArtifact.mockImplementation(async ({ artifactId }: { artifactId: string }) => artifactId === 'diff-0'
      ? `# Git diff evidence\n\n${section('Committed diff', `${fileDiff('src/rateLimit.ts', '@@ -1 +1 @@\n-old\n+new')}\n${fileDiff('src/other.ts', '@@ -1 +1 @@\n-a\n+b')}`)}\n${section('Staged diff', 'No staged diff.')}\n${section('Unstaged diff', 'No unstaged diff.')}`
      : `# Git diff evidence\n\n${section('Committed diff', `${fileDiff('src/rateLimit.ts', '@@ -1 +1 @@\n-old\n+newer')}\n${fileDiff('src/other.ts', '@@ -1 +1 @@\n-a\n+b')}`)}\n${section('Staged diff', 'No staged diff.')}\n${section('Unstaged diff', 'No unstaged diff.')}`);
    render(<Harness
      review={{ status: 'STALE', runId: 'review-1' }}
      artifacts={[artifact('diff-1'), artifact('diff-0')]}
      reviewedDiffArtifactId="diff-0"
    />);

    expect(await screen.findByRole('region', { name: 'src/rateLimit.ts' })).toBeDefined();
    expect(screen.queryByRole('region', { name: 'src/other.ts' })).toBeNull();
    expect(screen.getByRole('button', { name: /Changes to show/ }).textContent).toContain('Since the review');
  });

  it('shows exactly what changed since the review from the code it read, and the previous round once a re-review is current', async () => {
    api.readArtifact.mockImplementation(async () => `# Git diff evidence\n\n${section('Committed diff', `${fileDiff('src/rateLimit.ts', '@@ -1,2 +1,2 @@\n-old\n+newer\n keep')}\n${fileDiff('src/other.ts', '@@ -1 +1 @@\n-a\n+b')}`)}\n${section('Staged diff', 'No staged diff.')}\n${section('Unstaged diff', 'No unstaged diff.')}`);
    // Only the line changed since the review: "new", which the review read, became "newer".
    api.readReviewChanges.mockResolvedValue({ status: 'READY', reviewRunId: 'review-1', tree: 'tree-1', diff: fileDiff('src/rateLimit.ts', '@@ -1 +1 @@\n-new\n+newer') });
    const { rerender } = render(<Harness
      review={{ status: 'STALE', runId: 'review-1' }}
      changesSince={{ reviewRunId: 'review-1', label: 'Since the review', refreshKey: 'git-2' }}
    />);

    const file = await screen.findByRole('region', { name: 'src/rateLimit.ts' });
    expect(screen.queryByRole('region', { name: 'src/other.ts' })).toBeNull();
    expect(screen.getByRole('button', { name: /Changes to show/ }).textContent).toContain('Since the review');
    expect([...file.querySelectorAll('code')].map((code) => code.textContent)).toEqual(expect.arrayContaining(['Removed: new', 'Added: newer']));
    expect([...file.querySelectorAll('code')].map((code) => code.textContent)).not.toContain('Removed: old');
    // A removed line here is the reviewed code's, so it takes no comment; the new line does.
    expect(within(file).queryByRole('button', { name: 'Comment on removed line 1' })).toBeNull();
    expect(within(file).getByRole('button', { name: 'Comment on line 1' })).toBeDefined();
    expect(api.readReviewChanges).toHaveBeenCalledWith({ taskId: expect.any(String), reviewRunId: 'review-1' });

    // Once a re-review is current, the previous round is offered, not led with.
    rerender(<Harness
      review={{ status: 'PASSED', runId: 'review-2' }}
      changesSince={{ reviewRunId: 'review-1', label: 'Since the last review', refreshKey: 'git-2' }}
    />);
    expect(await screen.findByRole('region', { name: 'src/other.ts' })).toBeDefined();
    expect(screen.getByRole('button', { name: /Changes to show/ }).textContent).toContain('All changes');
  });

  it('says when the agent is waiting on the person instead of the review’s verdict', async () => {
    api.readArtifact.mockResolvedValueOnce(diffFor('src/rateLimit.ts'));
    const onOpen = vi.fn();
    const { rerender } = render(<Harness review={{ status: 'NEEDS_CHANGES', runId: 'review-1', working: true }} />);
    expect(await screen.findByText('Fixing review feedback')).toBeDefined();

    rerender(<Harness review={{ status: 'NEEDS_CHANGES', runId: 'review-1', working: true }} agentRequest={{ label: 'Codex asked a question', action: 'Go to request', onOpen }} />);
    expect(screen.getByText('Codex asked a question')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Go to request' }));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

describe('ReviewWorkspace pull request discussions', () => {
  beforeEach(() => {
    api.readArtifact.mockReset();
  });
  const discussion = (id: string, extra: Partial<DiscussionView> = {}): DiscussionView => ({
    id, kind: 'THREAD', provider: 'GITHUB', path: 'src/rateLimit.ts', side: 'NEW', line: 1, resolvable: true, resolved: false,
    outdated: false, open: true, url: `https://github.com/acme/widgets/pull/9#${id}`, commentCount: 2,
    comments: [
      { author: 'alice', createdAt: '2026-07-07T09:00:00.000Z', body: 'Return **seconds** here.', truncated: false },
      { author: 'bob', createdAt: '2026-07-07T09:30:00.000Z', body: 'Agreed.', truncated: false }
    ],
    ...extra
  });
  const resolved = discussion('done', {
    resolved: true, open: false, commentCount: 1, comments: [{ author: 'carol', body: 'Rename the limiter.', truncated: false }]
  });

  it('shows a reviewer\'s thread with its replies, sends it only once added, and folds a resolved one to a line', async () => {
    api.readArtifact.mockResolvedValueOnce(diffFor('src/rateLimit.ts'));
    const onSubmit = vi.fn();
    render(<Harness findings={[]} review={undefined} discussions={[discussion('open'), resolved]} discussionsOnLines onSubmit={onSubmit} />);

    const thread = await screen.findByRole('article', { name: 'GitHub comment by alice' });
    expect(within(thread).getByText('seconds').tagName).toBe('STRONG');
    expect(within(thread).getByText('Agreed.')).toBeDefined();
    expect(within(thread).getByRole('link', { name: 'Open on GitHub' }).getAttribute('href')).toBe('https://github.com/acme/widgets/pull/9#open');
    // On its own line, the thread does not repeat where it is.
    expect(within(thread).queryByText('Line 1')).toBeNull();
    // Other people's words go to the agent only when the person adds them.
    expect(screen.queryByRole('button', { name: 'Address comments' })).toBeNull();
    fireEvent.click(within(thread).getByRole('button', { name: 'Add to request' }));
    fireEvent.click(screen.getByRole('button', { name: /^1 GitHub comment/ }));
    const sheet = screen.getByRole('dialog', { name: 'Address comments' });
    expect(within(within(sheet).getByRole('region', { name: 'From GitHub' })).getByText('Return seconds here.')).toBeDefined();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Address comments' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ includedDiscussionIds: ['open'] }));
    // Sending answers the sheet.
    expect(screen.queryByRole('dialog', { name: 'Address comments' })).toBeNull();
    // Taking out the last item empties the request, and the sheet goes with it.
    fireEvent.click(screen.getByRole('button', { name: /^1 GitHub comment/ }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Address comments' }))
      .getByRole('button', { name: 'Take the comment by alice out of the request' }));
    expect(screen.queryByRole('dialog', { name: 'Address comments' })).toBeNull();

    // A resolved thread is one line that opens; it cannot be added.
    const folded = screen.getByRole('button', { name: /carol/ });
    expect(folded.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(folded);
    const opened = screen.getByRole('article', { name: 'GitHub comment by carol' });
    expect(within(opened).queryByRole('button', { name: 'Add to request' })).toBeNull();
  });

  it('answers a thread where it is read: a reply starts from the agent\'s answer and posts with the resolving chosen', async () => {
    api.readArtifact.mockResolvedValueOnce(diffFor('src/rateLimit.ts', 'const window = 60;'));
    const onReplyToDiscussion = vi.fn(async () => undefined);
    const onResolveDiscussion = vi.fn(async () => undefined);
    const suggestion = discussion('suggest', { commentCount: 1, comments: [
      { author: 'alice', createdAt: '2026-07-07T09:00:00.000Z', body: 'Name it:\n\n```suggestion\nconst windowSeconds = 60;\n```', truncated: false }
    ] });
    const drafts = new Map([['open', { discussionId: 'open', kind: 'THREAD' as const, author: 'alice', summary: 'Return seconds here.',
      outcome: 'FIXED' as const, body: 'Fixed in 1a2b3c4. Returns seconds now.', resolvable: true }]]);
    render(<Harness findings={[]} review={undefined} discussions={[discussion('open'), suggestion]} discussionsOnLines
      replyDrafts={drafts} onReplyToDiscussion={onReplyToDiscussion} onResolveDiscussion={onResolveDiscussion} />);
    await screen.findAllByRole('article', { name: 'GitHub comment by alice' });
    const thread = (id: string) => document.querySelector<HTMLElement>(`article[data-discussion-id="${id}"]`)!;

    // A suggested change reads as a diff: the line it replaces, then the line it suggests.
    const figure = within(thread('suggest')).getByText('Suggested change').closest('figure')!;
    expect(within(figure).getByText('const window = 60;')).toBeDefined();
    expect(within(figure).getByText('const windowSeconds = 60;')).toBeDefined();

    // Every open thread ends in its reply row; R puts the caret there, and the reply starts from the agent's answer.
    const input = within(thread('open')).getByRole('textbox', { name: 'Reply to alice' }) as HTMLTextAreaElement;
    expect(input.value).toBe('');
    expect(within(thread('open')).queryByRole('checkbox', { name: 'Resolve thread' })).toBeNull();
    fireEvent.focusIn(thread('open'));
    fireEvent.keyDown(thread('open'), { key: 'r' });
    expect(document.activeElement).toBe(input);
    fireEvent.focusIn(input);
    expect(input.value).toBe('Fixed in 1a2b3c4. Returns seconds now.');
    // Resolving stays the person's call.
    const resolve = within(thread('open')).getByRole('checkbox', { name: 'Resolve thread' });
    expect((resolve as HTMLInputElement).checked).toBe(true);
    fireEvent.click(resolve);
    fireEvent.change(input, { target: { value: 'Returns seconds now.' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(onReplyToDiscussion).toHaveBeenCalledWith('open', 'Returns seconds now.', false));
    // Posted, the row is empty again and folds back to its field.
    await waitFor(() => expect(input.value).toBe(''));
    expect(within(thread('open')).queryByRole('checkbox', { name: 'Resolve thread' })).toBeNull();

    // Resolving needs no reply: the check on the thread's head.
    const check = within(thread('suggest')).getByRole('button', { name: 'Resolve thread' });
    expect(check.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(check);
    await waitFor(() => expect(onResolveDiscussion).toHaveBeenCalledWith('suggest', true));
  });

  it('keeps only what the person typed in a reply, so an answer posted elsewhere does not come back as theirs', async () => {
    api.readArtifact.mockResolvedValue(diffFor('src/rateLimit.ts'));
    // What the task keeps while it is open, as the task page holds it across visits to Review.
    const typed = new Map<string, string>();
    const onReplyTextChange = (discussionId: string, text: string | undefined) => {
      if (text === undefined) typed.delete(discussionId);
      else typed.set(discussionId, text);
    };
    const drafts = new Map([['open', { discussionId: 'open', kind: 'THREAD' as const, author: 'alice', summary: 'Return seconds here.',
      outcome: 'FIXED' as const, body: 'Fixed in 1a2b3c4. Returns seconds now.', resolvable: true }]]);
    const shared = { findings: [], review: undefined, discussionsOnLines: true, replyTexts: typed, onReplyTextChange,
      onReplyToDiscussion: vi.fn(async () => undefined) };
    const first = render(<Harness {...shared} discussions={[discussion('open')]} replyDrafts={drafts} />);
    const input = await screen.findByRole('textbox', { name: 'Reply to alice' }) as HTMLTextAreaElement;
    fireEvent.focusIn(input);
    expect(input.value).toBe('Fixed in 1a2b3c4. Returns seconds now.');
    first.unmount();

    // Posted from the Overview's dialog, the answer leaves the drafts and the thread waits on alice.
    render(<Harness {...shared} discussions={[discussion('open', { replied: true })]} />);
    const again = await screen.findByRole('textbox', { name: 'Reply to alice' }) as HTMLTextAreaElement;
    expect(again.value).toBe('');
    expect(screen.queryByRole('button', { name: 'Reply' })).toBeNull();
  });

  it('keeps the keys on a thread when it opens, folds or shows every reply', async () => {
    api.readArtifact.mockResolvedValueOnce(diffFor('src/rateLimit.ts'));
    const long = discussion('long', { commentCount: 5, comments: ['alice', 'bob', 'carol', 'dave', 'erin'].map((author, index) => ({
      author, createdAt: `2026-07-07T09:0${index}:00.000Z`, body: `Point ${index + 1}.`, truncated: false
    })) });
    render(<Harness findings={[]} review={undefined} discussions={[resolved, long, discussion('open')]} discussionsOnLines />);
    await screen.findByRole('article', { name: 'GitHub comment by carol' });
    const thread = (id: string) => document.querySelector<HTMLElement>(`article[data-discussion-id="${id}"]`)!;
    // A control that goes away when pressed leaves the focus on its thread, where N still moves on.
    const press = (button: HTMLElement) => { button.focus(); fireEvent.click(button); };

    press(within(thread('done')).getByRole('button', { name: /Rename the limiter/ }));
    expect(document.activeElement).toBe(thread('done'));
    fireEvent.keyDown(document.activeElement!, { key: 'n' });
    expect(document.activeElement).toBe(thread('long'));

    press(within(thread('done')).getByRole('button', { name: 'Fold' }));
    expect(document.activeElement).toBe(thread('done'));
    fireEvent.keyDown(document.activeElement!, { key: 'n' });
    expect(document.activeElement).toBe(thread('long'));

    press(within(thread('long')).getByRole('button', { name: '3 more replies' }));
    expect(document.activeElement).toBe(thread('long'));
    expect(within(thread('long')).getByText('Point 3.')).toBeDefined();
    fireEvent.keyDown(document.activeElement!, { key: 'n' });
    expect(document.activeElement).toBe(thread('open'));
  });

  it('shows a discussion another surface asked to see when the diff has no files', async () => {
    const onDiscussionRevealed = vi.fn();
    render(<Harness findings={[]} review={undefined} currentDiffArtifactId={undefined} discussions={[discussion('open')]}
      revealDiscussionId="open" onDiscussionRevealed={onDiscussionRevealed} />);
    const thread = await screen.findByRole('article', { name: 'GitHub comment by alice' });
    expect(within(screen.getByRole('region', { name: 'Feedback without a location' })).getByRole('article')).toBe(thread);
    await waitFor(() => expect(document.activeElement).toBe(thread));
    expect(onDiscussionRevealed).toHaveBeenCalledOnce();
  });

  it('acts with F on the thread in focus, never on a discussion focused before it', async () => {
    api.readArtifact.mockResolvedValueOnce(diffFor('src/rateLimit.ts'));
    render(<Harness findings={[suggestion]} discussions={[discussion('open')]} discussionsOnLines />);
    const thread = await screen.findByRole('article', { name: 'GitHub comment by alice' });
    const minor = screen.getByRole('article', { name: 'Minor finding: Name the limit' });
    fireEvent.focusIn(thread);
    fireEvent.focusIn(minor);
    fireEvent.keyDown(minor, { key: 'f' });
    expect(within(minor).getByRole('button', { name: /In request/ }).getAttribute('aria-pressed')).toBe('true');
    expect(within(thread).getByRole('button', { name: 'Add to request' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('says which line a thread is about once the code it was written on may have moved, and lists threads by what happens to them', async () => {
    api.readArtifact.mockResolvedValueOnce(diffFor('src/rateLimit.ts'));
    const sent = discussion('sent', { comments: [{ author: 'dave', body: 'Cap the burst.', truncated: false }], commentCount: 1,
      sent: { at: '2026-07-07T10:00:00.000Z', outcome: 'FIXED' } });
    render(<Harness findings={[]} review={undefined} discussions={[discussion('open'), sent, resolved]} discussionsOnLines={false} />);

    const thread = await screen.findByRole('article', { name: 'GitHub comment by alice' });
    expect(within(thread).getByText('Line 1')).toBeDefined();
    expect(within(screen.getByRole('article', { name: 'GitHub comment by dave' })).getByText('Fixed')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /^Feedback/ }));
    const rail = screen.getByRole('navigation', { name: 'Feedback' });
    const onGitHub = within(rail).getByText('On GitHub').parentElement!;
    // What still needs a decision comes before what was sent.
    expect(within(onGitHub).getAllByRole('button').map((row) => row.textContent)).toEqual([
      expect.stringContaining('alice'), expect.stringContaining('dave')
    ]);
    expect(within(within(rail).getByText('Resolved on GitHub').parentElement!).getByText('Rename the limiter.')).toBeDefined();
  });
});

describe('ReviewWorkspace showing one file', () => {
  beforeEach(() => {
    api.readArtifact.mockReset();
    window.localStorage.clear();
  });

  it('shows one file full screen, takes the focus to the next file with J and to a finding with N, and shows every file on Escape', async () => {
    api.readArtifact.mockResolvedValueOnce(`# Git diff evidence\n\n${section('Committed diff', `${fileDiff('src/rateLimit.ts', '@@ -1 +1 @@\n-old\n+new')}\n${fileDiff('src/other.ts', '@@ -1 +1 @@\n-a\n+b')}`)}\n${section('Staged diff', 'No staged diff.')}\n${section('Unstaged diff', 'No unstaged diff.')}`);
    const onFullScreenChange = vi.fn();
    render(<Harness findings={[finding]} onFullScreenChange={onFullScreenChange} />);
    await screen.findByRole('region', { name: 'src/other.ts' });

    const show = screen.getByRole('button', { name: 'Show src/rateLimit.ts full screen' });
    show.focus();
    fireEvent.click(show);
    expect(screen.getByRole('region', { name: 'src/rateLimit.ts' })).toBeDefined();
    expect(screen.queryByRole('region', { name: 'src/other.ts' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Exit full screen' }));
    // The review takes the page: its toolbar, navigator and foot step aside, and the page hides its tab bar.
    expect(screen.getByRole('region', { name: 'Review' }).hasAttribute('data-file-full-screen')).toBe(true);
    expect(onFullScreenChange).toHaveBeenLastCalledWith(true);

    fireEvent.keyDown(document.activeElement!, { key: 'j' });
    expect(screen.getByRole('region', { name: 'src/other.ts' })).toBeDefined();
    expect(screen.queryByRole('region', { name: 'src/rateLimit.ts' })).toBeNull();
    // Focus in the file that stepped aside stays in the review, so the keys keep working.
    expect(document.activeElement?.closest('[hidden]')).toBeNull();
    expect(document.activeElement?.closest('[aria-label="Review"]')).toBeTruthy();

    fireEvent.keyDown(document.activeElement!, { key: 'n' });
    expect(screen.getByRole('region', { name: 'src/rateLimit.ts' })).toBeDefined();
    expect(screen.queryByRole('region', { name: 'src/other.ts' })).toBeNull();

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.getByRole('region', { name: 'src/rateLimit.ts' })).toBeDefined();
    expect(screen.getByRole('region', { name: 'src/other.ts' })).toBeDefined();
    expect(onFullScreenChange).toHaveBeenLastCalledWith(false);

    // The chord shows the file being read alone, and every file again.
    fireEvent.keyDown(document.activeElement!, { key: 'F', metaKey: true, shiftKey: true });
    expect(screen.queryByRole('region', { name: 'src/other.ts' })).toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: 'F', metaKey: true, shiftKey: true });
    expect(screen.getByRole('region', { name: 'src/other.ts' })).toBeDefined();
  });
});
