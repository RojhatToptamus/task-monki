import type { ComponentProps } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { makeGitSnapshotRecord, makeRunRecord, makeTaskRecord, TEST_NOW } from '../../testSupport/rendererRecords';
import { TaskDetail } from './TaskDetail';

function detailProps(): ComponentProps<typeof TaskDetail> {
  return {
    task: makeTaskRecord({ workflowPhase: 'IN_PROGRESS', currentWorktreeId: 'worktree-1', currentIterationId: 'iteration-1', projection: { worktree: 'PRESENT', git: 'DIRTY' } }),
    repository: { id: 'repository-1', kind: 'USER_REGISTERED', name: 'Project', path: '/tmp/project', status: 'AVAILABLE', remotes: [], createdAt: TEST_NOW, updatedAt: TEST_NOW },
    worktree: { id: 'worktree-1', taskId: 'task-1', repositoryId: 'repository-1', iterationId: 'iteration-1', ownership: 'EXTERNAL', worktreePath: '/tmp/project', branchName: 'feature', baseRef: 'main', baseSha: 'abc123', status: 'PRESENT', createdAt: TEST_NOW, updatedAt: TEST_NOW },
    gitSnapshot: makeGitSnapshotRecord({ status: 'DIRTY', untrackedCount: 1 }),
    gitSnapshots: [], events: [], runs: [], sessions: [], items: [], goalSnapshots: [], planRevisions: [], usageSnapshots: [], settingsObservations: [], subagentObservations: [], artifacts: [], attachments: [], interactions: [],
    previewPlans: [], previewApprovals: [], previewGenerations: [], previewGenerationAttachments: [], previewManagedResources: [], previewNodeAttempts: [], previewComposeProjects: [], previewLocalBindings: [], previewTaskRoutes: [], previewRuntimeResources: [],
    showMascot: false,
    onPrepareWorktree: vi.fn(), onStart: vi.fn(), onCancel: vi.fn(), onSteer: vi.fn(), onContinue: vi.fn(), onRetry: vi.fn(), onReview: vi.fn(), onSyncAgentGoal: vi.fn(), onUpdateAgentNativeSession: vi.fn(), onRespondToInteraction: vi.fn(), onCreateDeliveryCommit: vi.fn(), onCreatePullRequest: vi.fn(), onRefreshGitHub: vi.fn(), onResolvePreview: vi.fn(), onSetPreviewLocalBinding: vi.fn(), onGetPreviewRecipeGeneration: vi.fn(), onGeneratePreviewRecipe: vi.fn(), onValidatePreviewRecipeDraft: vi.fn(), onAcceptPreviewRecipeDraft: vi.fn(), onDiscardPreviewRecipeDraft: vi.fn(), onWritePreviewRecipeManually: vi.fn(), onApprovePreview: vi.fn(), onStartPreview: vi.fn(), onOpenPreview: vi.fn(), onStopPreview: vi.fn(), onResetPreviewData: vi.fn(), onRetryPreviewSetup: vi.fn(), onReadPreviewLog: vi.fn(), onTransition: vi.fn(), onArchive: vi.fn(), onRequestDelete: vi.fn(), onModalOpenChange: vi.fn(),
    onListExistingWorktrees: vi.fn(async () => []), onReconnectWorktree: vi.fn(), onUpdateWorktreeComparison: vi.fn(), onRefreshEvidence: vi.fn()
  };
}

describe('imported task actions', () => {
  it('requires a first coding instruction but starts review directly without a separate phase action', async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    const props = detailProps();
    render(<TaskDetail {...props} />);
    const start = screen.getByRole('button', { name: 'Start implementation' });
    start.focus();
    fireEvent.click(start);
    const dialog = screen.getByRole('dialog', { name: 'Start implementation' });
    const instruction = within(dialog).getByRole('textbox', { name: 'What should the agent do?' });
    expect(within(dialog).getByText('The agent will edit your original imported checkout.')).toBeDefined();
    expect(instruction).toBe(document.activeElement);
    expect((within(dialog).getByRole('button', { name: 'Start implementation' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(start).toBe(document.activeElement));
    fireEvent.click(start);
    fireEvent.change(screen.getByRole('textbox', { name: 'What should the agent do?' }), { target: { value: 'Fix the imported validation bug.' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Start implementation' }));
    await waitFor(() => expect(props.onStart).toHaveBeenCalledWith('task-1', 'Fix the imported validation bug.'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Run agent review' }));
    await waitFor(() => expect(props.onReview).toHaveBeenCalledWith(undefined));
    expect(props.onTransition).not.toHaveBeenCalled();
    expect(props.onPrepareWorktree).not.toHaveBeenCalled();
  });

  it('changes the comparison beside the diff, retains failed input, and restores focus on cancellation', async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    const props = detailProps();
    props.onUpdateWorktreeComparison = vi.fn().mockRejectedValueOnce(new Error('Comparison was not found.')).mockResolvedValue(undefined);
    render(<TaskDetail {...props} />);
    expect(screen.queryByRole('button', { name: 'Change comparison' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Evidence' }));
    const change = screen.getByRole('button', { name: 'Change comparison' });
    change.focus();
    fireEvent.click(change);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(change).toBe(document.activeElement));
    fireEvent.click(change);
    const input = screen.getByRole('textbox', { name: 'Compare against' });
    fireEvent.change(input, { target: { value: 'missing' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Change comparison' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Comparison was not found.');
    expect(input).toHaveProperty('value', 'missing');
    fireEvent.change(input, { target: { value: 'HEAD' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Change comparison' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(props.onUpdateWorktreeComparison).toHaveBeenLastCalledWith('task-1', 'HEAD');
  });

  it('requires a new PR target independently of a clean HEAD comparison and keeps failed input for retry', async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    const props = detailProps();
    props.worktree = { ...props.worktree!, baseRef: 'HEAD' };
    props.task = makeTaskRecord({ ...props.task, projection: { worktree: 'PRESENT', git: 'CLEAN' } });
    props.gitSnapshot = makeGitSnapshotRecord({ status: 'CLEAN', baseRef: 'HEAD', commitsAheadOfBase: 0, committedDiffFileCount: 0 });
    props.onCreatePullRequest = vi.fn().mockRejectedValueOnce(new Error('Target branch was not found.')).mockResolvedValue(undefined);
    render(<TaskDetail {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create draft PR' }));
    const dialog = screen.getByRole('dialog', { name: 'Create draft PR' });
    const target = within(dialog).getByRole('textbox', { name: 'Target branch' });
    const submit = within(dialog).getByRole('button', { name: 'Create draft PR' });
    expect(target).toHaveProperty('value', '');
    expect(submit).toHaveProperty('disabled', true);
    fireEvent.change(target, { target: { value: 'missing' } });
    fireEvent.click(submit);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Target branch was not found.');
    expect(target).toHaveProperty('value', 'missing');
    fireEvent.change(target, { target: { value: 'release/next' } });
    fireEvent.click(submit);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(props.onCreatePullRequest).toHaveBeenLastCalledWith('task-1', props.task!.title, 'release/next');
    expect(props.onUpdateWorktreeComparison).not.toHaveBeenCalled();
  });

  it('starts a detached review without a source run and routes findings to the first coding instruction', async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    const props = detailProps();
    props.task!.workflowPhase = 'REVIEW';
    const mounted = render(<TaskDetail {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run review' }));
    await waitFor(() => expect(props.onReview).toHaveBeenCalledWith(undefined));
    mounted.unmount();
    props.task = makeTaskRecord({ ...props.task, projection: { ...props.task!.projection, agentReview: {
      status: 'NEEDS_CHANGES', runId: 'review-1', result: { schemaVersion: 'agent-review/v1', verdict: 'NEEDS_CHANGES', summary: 'Fix validation.', findings: [{ id: 'finding-1', severity: 'MAJOR', title: 'Invalid input accepted', explanation: 'Reject an invalid value.', path: 'src/input.ts', line: 1 }] }
    } } });
    props.runs = [makeRunRecord({ id: 'review-1', mode: 'REVIEW', status: 'COMPLETED' })];
    render(<TaskDetail {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Address findings' }));
    const drawer = await screen.findByRole('dialog');
    fireEvent.click(within(drawer).getByRole('button', { name: /Start|Send|Address/ }));
    await waitFor(() => expect(props.onStart).toHaveBeenCalledWith('task-1', expect.stringContaining('Invalid input accepted')));
    expect(props.onContinue).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Commit' })).toBeNull();
  });
});
