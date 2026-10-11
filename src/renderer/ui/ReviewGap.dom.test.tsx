import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_REVIEW_DRAFT, type ArtifactRecord, type TaskReviewDraft, type WorktreeFileRead, type WorktreeRecord } from '../../shared/contracts';
import { planReviewRequest } from '../model/reviewFollowUp';
import { ReviewWorkspace, type ReviewWorkspaceProps } from './ReviewWorkspace';

const api = vi.hoisted(() => ({ readArtifact: vi.fn(), readWorktreeFile: vi.fn(), inspectOpenTarget: vi.fn() }));
vi.mock('../api/taskManagerClient', () => ({ taskManagerApi: api }));

// The checkout's file: 61 lines, line 10 changed and line 41 added since the base.
const checkout = Array.from({ length: 61 }, (_, index) => {
  const line = index + 1;
  if (line === 10) return "const v10 = 'ten';";
  if (line === 41) return 'const extra = true;';
  const value = line > 41 ? line - 1 : line;
  return `const v${value} = ${value};`;
});
const BLOB = 'abcdef0123456789abcdef0123456789abcdef01';
const PATH = 'src/values.ts';

function capturedDiff(): string {
  const at = (line: number) => checkout[line - 1];
  const patch = [
    `diff --git a/${PATH} b/${PATH}`,
    `index 1111111..${BLOB.slice(0, 7)} 100644`,
    `--- a/${PATH}`,
    `+++ b/${PATH}`,
    '@@ -7,7 +7,7 @@',
    ` ${at(7)}`, ` ${at(8)}`, ` ${at(9)}`, '-const v10 = 10;', `+${at(10)}`, ` ${at(11)}`, ` ${at(12)}`, ` ${at(13)}`,
    '@@ -38,6 +38,7 @@',
    ` ${at(38)}`, ` ${at(39)}`, ` ${at(40)}`, `+${at(41)}`, ` ${at(42)}`, ` ${at(43)}`, ` ${at(44)}`
  ].join('\n');
  return `# Git diff evidence\n\n## Committed diff\n\nNo committed diff.\n\n## Staged diff\n\nNo staged diff.\n\n## Unstaged diff\n\n${patch}\n`;
}

const artifact: ArtifactRecord = { id: 'diff-1', taskId: 'task-1', kind: 'diff', path: '/tmp/diff-1.md', byteCount: 256, createdAt: '2026-07-07T10:10:00.000Z', updatedAt: '2026-07-07T10:10:00.000Z' };
const worktree: WorktreeRecord = {
  id: 'worktree-1', taskId: 'task-1', iterationId: 'iteration-1', repositoryId: 'repository-1', ownership: 'MANAGED',
  worktreePath: '/worktrees/task-1', branchName: 'codex/task', baseSha: 'abc123', status: 'PRESENT',
  createdAt: '2026-07-07T10:00:00.000Z', updatedAt: '2026-07-07T10:00:00.000Z'
};

function Harness(overrides: Partial<ReviewWorkspaceProps> & { onSubmit?(draft: TaskReviewDraft): void }) {
  const [draft, setDraft] = useState<TaskReviewDraft>(EMPTY_REVIEW_DRAFT);
  return (
    <ReviewWorkspace
      taskId={`task-${Math.random()}`}
      review={{ status: 'PASSED', reviewedAt: '2026-07-07T10:12:00.000Z', runId: 'review-1' }}
      findings={[]}
      currentDiffArtifactId="diff-1"
      artifacts={[artifact]}
      worktree={worktree}
      draft={draft}
      onDraftChange={setDraft}
      plan={planReviewRequest([], draft, 'review-1')}
      findingsSendable
      requestChanges={{ busy: false, reviewNotes: false, instruction: () => 'Address the review.', onSubmit: () => overrides.onSubmit?.(draft) }}
      {...overrides}
    />
  );
}

const numberOf = (element: Element | null | undefined) => element?.closest('.tm-review-line-group')?.querySelector('.tm-diffline__num')?.textContent;

async function openFileMenu() {
  const trigger = screen.getByRole('button', { name: `Options for ${PATH}` });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  return screen.findByRole('menu');
}

describe('ReviewWorkspace unchanged lines', () => {
  beforeEach(() => {
    api.readArtifact.mockReset().mockResolvedValue(capturedDiff());
    api.readWorktreeFile.mockReset().mockResolvedValue({ status: 'TEXT', text: `${checkout.join('\n')}\n`, blobSha1: BLOB } satisfies WorktreeFileRead);
    api.inspectOpenTarget.mockReset().mockReturnValue(new Promise(() => undefined));
    window.localStorage.clear();
  });

  it('opens a gap 20 lines at a time from its gutter and whole from its label, and its lines take comments', async () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Expand down' }));
    expect(api.readWorktreeFile).toHaveBeenCalledWith({ taskId: 'task-1', worktreeId: 'worktree-1', relativePath: PATH });
    expect(screen.getByRole('button', { name: 'Comment on line 33' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Comment on line 34' })).toBeNull();
    // Four lines are left: the label alone opens them, and focus moved to it with the step gone.
    expect(screen.queryByRole('button', { name: 'Expand down' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Expand 4 unchanged lines' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand 4 unchanged lines' }));
    expect(screen.queryByText('4 unchanged lines')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Comment on line 20' }));
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Name this.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      comments: [expect.objectContaining({ path: PATH, side: 'NEW', line: 20, text: 'Name this.' })]
    }));
  });

  it('keeps an open comment under its line while a gap above it opens', async () => {
    render(<Harness />);
    const expandUp = await screen.findByRole('button', { name: 'Expand up' });

    fireEvent.click(screen.getByRole('button', { name: 'Comment on line 41' }));
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Draft' } });
    fireEvent.click(expandUp);
    expect(screen.getByRole('button', { name: 'Comment on line 37' })).toBeDefined();
    expect(numberOf(screen.getByLabelText('Comment'))).toContain('41');
    expect((screen.getByLabelText('Comment') as HTMLTextAreaElement).value).toBe('Draft');
  });

  it('shows the whole file from its menu, then only the changes again', async () => {
    render(<Harness />);
    await screen.findByRole('button', { name: 'Expand 6 unchanged lines' });

    fireEvent.click(within(await openFileMenu()).getByRole('menuitem', { name: 'Show whole file' }));
    expect(screen.queryByText(/unchanged line/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Comment on line 1' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Comment on line 61' })).toBeDefined();

    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    fireEvent.click(within(await openFileMenu()).getByRole('menuitem', { name: 'Show changes only' }));
    expect(screen.getByRole('button', { name: 'Expand 6 unchanged lines' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Expand 17 unchanged lines' })).toBeDefined();
  });

  it('opens nothing when the checkout no longer holds the captured file, and the menu says why', async () => {
    api.readWorktreeFile.mockResolvedValue({ status: 'TEXT', text: `${checkout.join('\n')}\n// edited\n`, blobSha1: 'fedcba9876543210fedcba9876543210fedcba98' });
    render(<Harness />);
    await waitFor(() => expect(api.readWorktreeFile).toHaveBeenCalled());
    await act(async () => undefined);

    expect(screen.getByText('24 unchanged lines')).toBeDefined();
    expect(screen.queryByRole('button', { name: /unchanged line/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Expand down' })).toBeNull();
    const item = within(await openFileMenu()).getByRole('menuitem', { name: /Show whole file/ });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.textContent).toContain('Differs from the checkout');
  });

  it('never reads the checkout for an earlier capture', async () => {
    render(<Harness historical={{ capturedAt: '2026-07-07T09:00:00.000Z', onBack: vi.fn() }} />);

    expect(await screen.findByText('24 unchanged lines')).toBeDefined();
    expect(api.readWorktreeFile).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /unchanged line/ })).toBeNull();
  });
});
