import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_REVIEW_DRAFT, type ArtifactRecord, type TaskReviewDraft } from '../../shared/contracts';
import { planReviewRequest } from '../model/reviewFollowUp';
import type { ReviewFindingView } from '../model/reviewWorkspace';
import { ReviewWorkspace, type ReviewWorkspaceProps } from './ReviewWorkspace';

const api = vi.hoisted(() => ({ readArtifact: vi.fn() }));
vi.mock('../api/taskManagerClient', () => ({ taskManagerApi: { readArtifact: api.readArtifact } }));

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
  recommendation: 'Keep buckets in Redis.', path: 'src/rateLimit.ts', line: 1, state: 'OPEN', addedByReviewer: false
};
const suggestion: ReviewFindingView = {
  id: 'f2', severity: 'MINOR', title: 'Name the limit', explanation: 'A bare number.', path: 'src/rateLimit.ts', line: 1, state: 'OPEN', addedByReviewer: false
};

function Harness(overrides: Partial<ReviewWorkspaceProps> & { onSubmit?(draft: TaskReviewDraft): void }) {
  const [draft, setDraft] = useState<TaskReviewDraft>(EMPTY_REVIEW_DRAFT);
  const review = 'review' in overrides ? overrides.review : { status: 'NEEDS_CHANGES' as const, reviewedAt: '2026-07-07T10:12:00.000Z', runId: 'review-1' };
  const findings = overrides.findings ?? [finding];
  return (
    <ReviewWorkspace
      taskId={`task-${Math.random()}`}
      currentDiffArtifactId="diff-1"
      artifacts={[artifact()]}
      draft={draft}
      onDraftChange={setDraft}
      plan={planReviewRequest(findings, draft, review?.runId)}
      findingsSendable={review?.status !== 'STALE'}
      requestChanges={{ busy: false, reviewNotes: false, instruction: () => 'Address the review.', onSubmit: () => overrides.onSubmit?.(draft) }}
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

  it('shows a finding under its line and dismisses it with a reason and a note', async () => {
    api.readArtifact.mockResolvedValueOnce(diffFor('src/rateLimit.ts'));
    const onDismiss = vi.fn(async () => undefined);
    render(<Harness onDismissFinding={onDismiss} />);

    const thread = await screen.findByRole('article', { name: 'Major finding: Limiter state is per process' });
    expect(thread.closest('.tm-review-line-group')?.querySelector('code')?.textContent).toBe('Added: new');
    expect(within(thread).getByText('In the request')).toBeDefined();

    fireEvent.click(within(thread).getByRole('button', { name: 'Dismiss this finding' }));
    fireEvent.click(within(thread).getByRole('button', { name: 'Acceptable as is' }));
    fireEvent.change(within(thread).getByLabelText('A note for the next review (optional)'), { target: { value: 'Single replica in production' } });
    await act(async () => { fireEvent.click(within(thread).getByRole('button', { name: 'Dismiss' })); });
    expect(onDismiss).toHaveBeenCalledWith('f1', 'ACCEPTED', 'Single replica in production');
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
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    expect(screen.getByText('Return seconds here.')).toBeDefined();
    expect(screen.getByRole('button', { name: /^1 fix, 1 comment/ })).toBeDefined();

    fireEvent.change(screen.getByLabelText('A note for the agent'), { target: { value: 'Keep the signature.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      note: 'Keep the signature.',
      comments: [expect.objectContaining({ path: 'src/rateLimit.ts', side: 'NEW', line: 1, text: 'Return seconds here.' })]
    }));
  });

  it('comments on a removed line and on a range picked by shift-clicking line numbers', async () => {
    api.readArtifact.mockResolvedValueOnce(`# Git diff evidence\n\n${section('Unstaged diff', fileDiff('src/a.ts', '@@ -1,2 +1,3 @@\n-gone\n+one\n+two\n+three'))}`);
    const onSubmit = vi.fn();
    render(<Harness findings={[]} onSubmit={onSubmit} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Comment on removed line 1' }));
    expect(screen.getByText('Removed line 1')).toBeDefined();
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Why was this removed?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));

    const numbers = [...document.querySelectorAll('.tm-diffline__num')];
    fireEvent.click(numbers.find((element) => element.textContent === '1' && element.closest('.tm-diffline--addition'))!);
    fireEvent.click(numbers.find((element) => element.textContent === '3')!, { shiftKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Comment on line 3' }));
    expect(screen.getByText('Lines 1–3')).toBeDefined();
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Collapse these.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));

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
    expect(within(file).getByText('Limiter state is per process')).toBeDefined();
    expect(screen.getByText('1 of 1 viewed')).toBeDefined();

    fireEvent.click(within(file).getByRole('button', { name: 'Show' }));
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
    expect(within(leftOut).getByText('Dismissed: not a problem')).toBeDefined();
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
    expect(screen.getByRole('button', { name: /^Nothing to send/ })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Request changes' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Comment on line 1' }));
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Still wrong.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    expect(screen.getByRole('button', { name: /^1 comment/ })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
