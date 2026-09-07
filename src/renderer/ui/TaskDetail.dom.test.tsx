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
  it('requires a first instruction, restores focus after cancellation, and offers explicit review readiness', async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    const props = detailProps();
    render(<TaskDetail {...props} />);
    const start = screen.getByRole('button', { name: 'Start implementation' });
    start.focus();
    fireEvent.click(start);
    const dialog = screen.getByRole('dialog', { name: 'Start implementation' });
    const instruction = within(dialog).getByRole('textbox', { name: 'What should the agent do?' });
    expect(instruction).toBe(document.activeElement);
    expect((within(dialog).getByRole('button', { name: 'Start implementation' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(start).toBe(document.activeElement));
    fireEvent.click(start);
    fireEvent.change(screen.getByRole('textbox', { name: 'What should the agent do?' }), { target: { value: 'Fix the imported validation bug.' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Start implementation' }));
    await waitFor(() => expect(props.onStart).toHaveBeenCalledWith('task-1', 'Fix the imported validation bug.'));
    fireEvent.click(screen.getByRole('button', { name: 'Ready for review' }));
    expect(props.onTransition).toHaveBeenCalledWith('task-1', 'REVIEW');
    expect(props.onPrepareWorktree).not.toHaveBeenCalled();
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
