import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactRecord } from '../../shared/contracts';
import type { ReviewFindingView, ReviewLineComment } from '../model/reviewWorkspace';
import { ReviewWorkspace, type ReviewWorkspaceProps } from './ReviewWorkspace';

const api = vi.hoisted(() => ({ readArtifact: vi.fn() }));
vi.mock('../api/taskManagerClient', () => ({ taskManagerApi: { readArtifact: api.readArtifact } }));

function artifact(id = 'diff-1'): ArtifactRecord {
  return { id, taskId: 'task-1', kind: 'diff', path: `/tmp/${id}.md`, byteCount: 256, createdAt: '2026-07-07T10:10:00.000Z', updatedAt: '2026-07-07T10:10:00.000Z' };
}

function diffFor(path: string, added = 'new'): string {
  return `# Git diff evidence

## Committed diff

diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
@@ -1 +1 @@
-old
+${added}

## Staged diff

No staged diff.

## Unstaged diff

No unstaged diff.
`;
}

const finding: ReviewFindingView = {
  id: 'f1', severity: 'MAJOR', title: 'Limiter state is per process', explanation: 'Each replica keeps its own buckets.',
  recommendation: 'Keep buckets in Redis.', path: 'src/rateLimit.ts', line: 1, state: 'OPEN', addedByReviewer: false
};

function Harness(overrides: Partial<ReviewWorkspaceProps> & { onSubmit?(note: string, comments: ReviewLineComment[]): void }) {
  const [comments, setComments] = useState<ReviewLineComment[]>([]);
  const [note, setNote] = useState('');
  return (
    <ReviewWorkspace
      taskId={`task-${Math.random()}`}
      agentName="Codex"
      review={{ status: 'NEEDS_CHANGES', reviewedAt: '2026-07-07T10:12:00.000Z' }}
      findings={[finding]}
      currentDiffArtifactId="diff-1"
      artifacts={[artifact()]}
      comments={comments}
      onCommentsChange={setComments}
      note={note}
      onNoteChange={setNote}
      requestChanges={{ busy: false, onSubmit: () => overrides.onSubmit?.(note, comments) }}
      {...overrides}
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

  it('labels an earlier capture and leaves findings and requests out of it', async () => {
    api.readArtifact.mockResolvedValueOnce(diffFor('src/rateLimit.ts'));
    const onBack = vi.fn();
    render(<Harness historical={{ capturedAt: '2026-07-07T09:00:00.000Z', headSha: 'c'.repeat(40), onBack }} />);

    expect(await screen.findByRole('region', { name: 'src/rateLimit.ts' })).toBeDefined();
    expect(screen.getByText('Earlier capture')).toBeDefined();
    expect(screen.queryByText('Limiter state is per process')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to current changes' }));
    expect(onBack).toHaveBeenCalledOnce();
  });
});

describe('ReviewWorkspace findings and requests', () => {
  beforeEach(() => {
    api.readArtifact.mockReset();
    window.localStorage.clear();
  });

  it('shows a finding under the line it is about and dismisses it with an optional note', async () => {
    api.readArtifact.mockResolvedValueOnce(diffFor('src/rateLimit.ts'));
    const onDismiss = vi.fn(async () => undefined);
    render(<Harness onDismissFinding={onDismiss} />);

    const thread = await screen.findByRole('article', { name: 'Major finding: Limiter state is per process' });
    const lineGroup = thread.closest('.tm-review-line-group');
    expect(lineGroup?.querySelector('code')?.textContent).toBe('Added: new');

    fireEvent.click(within(thread).getByRole('button', { name: 'Dismiss this finding' }));
    fireEvent.change(within(thread).getByLabelText('Why dismiss it (optional)'), { target: { value: 'Single replica in production' } });
    await act(async () => { fireEvent.click(within(thread).getByRole('button', { name: 'Dismiss' })); });
    expect(onDismiss).toHaveBeenCalledWith('f1', 'Single replica in production');
  });

  it('keeps stale findings as earlier context without Ask or Dismiss', async () => {
    api.readArtifact.mockResolvedValueOnce(diffFor('src/rateLimit.ts'));
    render(<Harness review={{ status: 'STALE' }} requestChanges={undefined} onDismissFinding={vi.fn()} onAskAboutFinding={vi.fn()} />);

    const thread = await screen.findByRole('article', { name: /Limiter state is per process/ });
    expect(within(thread).queryByRole('button', { name: 'Dismiss this finding' })).toBeNull();
    expect(within(thread).getByText('From the earlier review')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Request changes' })).toBeNull();
  });

  it('sends open findings with the user’s line comments and note', async () => {
    api.readArtifact.mockResolvedValueOnce(diffFor('src/rateLimit.ts'));
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Comment on line 1' }));
    fireEvent.change(screen.getByLabelText(/^Comment for/), { target: { value: 'Return seconds here.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect(screen.getByText('Return seconds here.')).toBeDefined();
    expect(screen.getByText('1 finding and 1 comment')).toBeDefined();

    fireEvent.change(screen.getByLabelText('Note for Codex'), { target: { value: 'Keep the signature.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
    expect(onSubmit).toHaveBeenCalledWith('Keep the signature.', [expect.objectContaining({ path: 'src/rateLimit.ts', line: 1, text: 'Return seconds here.' })]);
  });

  it('folds a file marked viewed and counts it in the index', async () => {
    api.readArtifact.mockResolvedValueOnce(diffFor('src/rateLimit.ts'));
    render(<Harness findings={[]} />);

    const viewed = await screen.findByRole('checkbox', { name: 'Viewed' });
    fireEvent.click(viewed);
    expect(screen.queryByText((_, element) => element?.tagName === 'CODE' && element.textContent === 'Added: new')).toBeNull();
    expect(screen.getByText('1 viewed')).toBeDefined();
  });
});
