import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionRecord, WorktreeRecord } from '../../shared/contracts';
import { codexCapabilities } from '../../core/agent/codex/codexCapabilities';
import { makeGitSnapshotRecord, makeRunRecord, makeTaskRecord, TEST_NOW } from '../../testSupport/rendererRecords';
import { TaskDetail } from './TaskDetail';

type Props = ComponentProps<typeof TaskDetail>;
const worktree: WorktreeRecord = {
  id: 'worktree-1', taskId: 'task-1', iterationId: 'iteration-1', repositoryId: 'repository-1',
  ownership: 'EXTERNAL', worktreePath: '/tmp/task-monki-test', branchName: 'task/test-task',
  baseRef: 'main', baseSha: 'base', headSha: 'head', status: 'PRESENT', createdAt: TEST_NOW, updatedAt: TEST_NOW
};
const gitSnapshot = makeGitSnapshotRecord({ baseRef: 'main', baseSha: 'base', headSha: 'head' });

beforeEach(() => {
  HTMLElement.prototype.scrollTo = vi.fn();
});

describe('attached work in TaskDetail', () => {
  it('preserves a failed instruction for retry and pauses automatic Git refresh while the drawer is open', async () => {
    const onObserveWorktree = vi.fn().mockResolvedValue(undefined);
    const onStart = vi.fn().mockRejectedValueOnce(new Error('Provider is unavailable.')).mockResolvedValue(undefined);
    render(<TaskDetail {...fixture({ onObserveWorktree, onStart })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start implementation' }));
    const drawer = screen.getByRole('dialog', { name: 'Start implementation' });
    const instruction = within(drawer).getByRole('textbox', { name: 'Instruction to agent' }) as HTMLTextAreaElement;
    fireEvent.change(instruction, { target: { value: 'Preserve the existing changes.' } });
    fireEvent(window, new Event('focus'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
    expect(onObserveWorktree).not.toHaveBeenCalled();
    expect(instruction.disabled).toBe(false);
    const send = within(drawer).getByRole('button', { name: 'Send to agent' });
    fireEvent.click(send);
    expect((await within(drawer).findByRole('alert')).textContent).toContain('instruction is preserved');
    expect(instruction.value).toBe('Preserve the existing changes.');
    expect(instruction.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Start implementation' })).toBeNull());
    expect(onStart).toHaveBeenNthCalledWith(2, 'task-1', 'Preserve the existing changes.', undefined);
    await waitFor(() => expect(onObserveWorktree).toHaveBeenCalledOnce());
  });

  it('coordinates background observation with reconnect and defers focus refresh until the picker action finishes', async () => {
    let finishObservation!: () => void;
    let finishReconnect!: () => void;
    const onObserveWorktree = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishObservation = resolve; }))
      .mockResolvedValue(undefined);
    const onReconnectWorktree = vi.fn(() => new Promise<void>((resolve) => { finishReconnect = resolve; }));
    const props = fixture({ worktree: { ...worktree, status: 'MISSING' }, onObserveWorktree, onReconnectWorktree });
    const { unmount } = render(<TaskDetail {...props} />);
    await waitFor(() => expect(onObserveWorktree).toHaveBeenCalledWith('task-1'));
    const reconnect = screen.getByRole('button', { name: 'Reconnect worktree' }) as HTMLButtonElement;
    expect(reconnect.disabled).toBe(true);
    fireEvent.click(reconnect);
    expect(onReconnectWorktree).not.toHaveBeenCalled();

    await act(async () => finishObservation());
    fireEvent.click(reconnect);
    expect(onReconnectWorktree).toHaveBeenCalledOnce();
    fireEvent(window, new Event('focus'));
    fireEvent(window, new Event('focus'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
    expect(onObserveWorktree).toHaveBeenCalledOnce();
    expect((screen.getByRole('button', { name: 'Refresh Git' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finishReconnect());
    await waitFor(() => expect(onObserveWorktree).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(reconnect.disabled).toBe(false));

    unmount();
    fireEvent(window, new Event('focus'));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(onObserveWorktree).toHaveBeenCalledTimes(2);
  });

  it('offers a detached review without inventing a primary run', async () => {
    const props = fixture();
    render(<TaskDetail {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run review' }));
    await waitFor(() => expect(props.onReview).toHaveBeenCalledWith(undefined));
    expect(props.onStart).not.toHaveBeenCalled();
  });

  it('starts first implementation only after the user submits the shared-checkout instruction', async () => {
    const props = fixture();
    render(<TaskDetail {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start implementation' }));
    const drawer = screen.getByRole('dialog', { name: 'Start implementation' });
    const instruction = within(drawer).getByRole('textbox', { name: 'Instruction to agent' });
    expect(document.activeElement).toBe(instruction);
    expect(within(drawer).getByText(/Avoid concurrent edits/)).toBeTruthy();
    expect((within(drawer).getByRole('button', { name: 'Send to agent' }) as HTMLButtonElement).disabled).toBe(true);
    expect(props.onStart).not.toHaveBeenCalled();
    fireEvent.change(instruction, { target: { value: '  Finish the remaining validation.  ' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Send to agent' }));
    await waitFor(() => expect(props.onStart).toHaveBeenCalledWith('task-1', 'Finish the remaining validation.', undefined));
    expect(props.onContinue).not.toHaveBeenCalled();
  });

  it('starts a fresh session after reconnecting to a different path, preserving historical runs', async () => {
    const run = makeRunRecord({ status: 'COMPLETED' });
    const session: AgentSessionRecord = {
      id: run.sessionId, taskId: 'task-1', iterationId: 'iteration-1', worktreeId: worktree.id,
      runtimeId: 'codex', role: 'PRIMARY', relationshipState: 'ROOT', worktreePath: '/tmp/previous-checkout',
      status: 'IDLE', materialized: true, requestedSettings: {}, ownership: 'TASK_MONKI',
      createdAt: TEST_NOW, updatedAt: TEST_NOW
    };
    const props = fixture({ run, runs: [run], sessions: [session] });
    props.task = { ...props.task!, currentRunId: run.id };
    render(<TaskDetail {...props} />);
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start implementation' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Instruction to agent' }), { target: { value: 'Continue in this checkout.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }));
    await waitFor(() => expect(props.onStart).toHaveBeenCalledWith('task-1', 'Continue in this checkout.', undefined));
    expect(props.onContinue).not.toHaveBeenCalled();
  });

  it('routes run-free review changes to start, but disables an open drawer when its evidence becomes stale', async () => {
    const props = reviewFixture();
    const { rerender } = render(<TaskDetail {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Address findings' }));
    const drawer = await screen.findByRole('dialog', { name: 'Request changes' });
    const send = within(drawer).getByRole('button', { name: 'Send to agent' }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    const stale = { ...props.task!, projection: { ...props.task!.projection, agentReview: { ...props.task!.projection.agentReview!, status: 'STALE' as const } } };
    rerender(<TaskDetail {...props} task={stale} />);
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    expect(props.onStart).not.toHaveBeenCalled();
    expect(within(drawer).getByRole('status').textContent).toContain('no longer current');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Cancel' }));
    rerender(<TaskDetail {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Address findings' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Request changes' })).getByRole('button', { name: 'Send to agent' }));
    await waitFor(() => expect(props.onStart).toHaveBeenCalledWith('task-1', expect.stringContaining('Missing cleanup'), 'review-1'));
    expect(props.onContinue).not.toHaveBeenCalled();
  });

  it('keeps recovery read-only, shows reconnect only when unhealthy, and saves an explicit comparison', async () => {
    const props = fixture();
    const { rerender } = render(<TaskDetail {...props} />);
    expect(screen.queryByRole('button', { name: 'Reconnect worktree' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Git' }));
    await waitFor(() => expect(props.onRefreshEvidence).toHaveBeenCalledWith('task-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit comparison' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Comparison' }), { target: { value: 'COMMIT' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Reference' }), { target: { value: 'release~1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save comparison' }));
    await waitFor(() => expect(props.onUpdateWorktreeComparison).toHaveBeenCalledWith('task-1', { type: 'COMMIT', ref: 'release~1' }));

    rerender(<TaskDetail {...props} worktree={{ ...worktree, baseRef: worktree.baseSha }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit comparison' }));
    expect((screen.getByRole('combobox', { name: 'Comparison' }) as HTMLSelectElement).value).toBe('COMMIT');
    fireEvent.click(screen.getByRole('button', { name: 'Save comparison' }));
    await waitFor(() => expect(props.onUpdateWorktreeComparison).toHaveBeenLastCalledWith('task-1', { type: 'COMMIT', ref: worktree.baseSha }));

    rerender(<TaskDetail {...props} worktree={{ ...worktree, status: 'MISSING' }} />);
    expect((screen.getByRole('button', { name: 'Start implementation' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect worktree' }));
    await waitFor(() => expect(props.onReconnectWorktree).toHaveBeenCalledWith('task-1'));
    expect(props.onStart).not.toHaveBeenCalled();
    expect(props.onCreateDeliveryCommit).not.toHaveBeenCalled();
  });

  it('uses the first-instruction drawer for failing checks and invalidates it when the PR head changes', async () => {
    const props = failingChecksFixture();
    const { rerender } = render(<TaskDetail {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Investigate failure' }));
    const drawer = await screen.findByRole('dialog', { name: 'Start implementation' });
    expect((within(drawer).getByRole('textbox', { name: 'Instruction to agent' }) as HTMLTextAreaElement).value).toContain('42');
    expect(props.onStart).not.toHaveBeenCalled();
    rerender(<TaskDetail {...props} pullRequest={{ ...props.pullRequest, headRefOid: 'changed' }} />);
    expect((within(drawer).getByRole('button', { name: 'Send to agent' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(drawer).getByRole('button', { name: 'Cancel' }));
    rerender(<TaskDetail {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Investigate failure' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Start implementation' })).getByRole('button', { name: 'Send to agent' }));
    await waitFor(() => expect(props.onStart).toHaveBeenCalledWith('task-1', expect.stringContaining('42'), undefined));
    expect(props.onContinue).not.toHaveBeenCalled();
  });

  it.each(['FOLLOW_UP', 'RETRY'] as const)('investigates failed checks after %s without continuing a session from a different checkout', async (mode) => {
    const props = failingChecksFixture();
    const run = makeRunRecord({ mode, status: 'COMPLETED' });
    const session: AgentSessionRecord = {
      id: run.sessionId, taskId: 'task-1', iterationId: 'iteration-1', worktreeId: worktree.id,
      runtimeId: 'codex', role: 'PRIMARY', relationshipState: 'ROOT', worktreePath: worktree.worktreePath,
      status: 'IDLE', materialized: true, requestedSettings: {}, ownership: 'TASK_MONKI',
      createdAt: TEST_NOW, updatedAt: TEST_NOW
    };
    props.task = { ...props.task!, currentRunId: run.id };
    props.run = run;
    props.runs = [run];
    props.sessions = [session];
    const { rerender } = render(<TaskDetail {...props} />);
    const investigate = screen.getByRole('button', { name: 'Investigate failure' }) as HTMLButtonElement;
    expect(investigate.disabled).toBe(false);
    fireEvent.click(investigate);
    await waitFor(() => expect(props.onContinue).toHaveBeenCalledWith(run.id, expect.stringContaining('42')));
    await waitFor(() => expect(investigate.disabled).toBe(false));
    expect(props.onStart).not.toHaveBeenCalled();

    rerender(<TaskDetail {...props} sessions={[{ ...session, worktreePath: '/tmp/previous-checkout' }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Investigate failure' }));
    expect(await screen.findByRole('dialog', { name: 'Start implementation' })).toBeTruthy();
    expect(props.onContinue).toHaveBeenCalledTimes(1);
    expect(props.onStart).not.toHaveBeenCalled();
  });

  it('disables run-free readiness for an unavailable checkout and during an evidence refresh, then permits the healthy transition', async () => {
    const props = fixture();
    props.task = { ...props.task!, workflowPhase: 'IN_PROGRESS' };
    const { rerender } = render(<TaskDetail {...props} worktree={{ ...worktree, status: 'MISSING' }} />);
    const moves = screen.getAllByRole('button', { name: 'Move to review' }) as HTMLButtonElement[];
    expect(moves.every((button) => button.disabled)).toBe(true);
    expect(moves.some((button) => button.title.includes('Reconnect or refresh'))).toBe(true);
    moves.forEach((button) => fireEvent.click(button));
    expect(props.onTransition).not.toHaveBeenCalled();

    rerender(<TaskDetail {...props} />);
    expect(moves.every((button) => !button.disabled)).toBe(true);
    let finishRefresh!: () => void;
    vi.mocked(props.onRefreshEvidence).mockReturnValue(new Promise<void>((resolve) => { finishRefresh = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Git' }));
    expect(moves.every((button) => button.disabled)).toBe(true);
    expect(moves.some((button) => button.title.includes('in progress'))).toBe(true);
    moves.forEach((button) => fireEvent.click(button));
    expect(props.onTransition).not.toHaveBeenCalled();

    await act(async () => finishRefresh());
    expect(moves.every((button) => !button.disabled)).toBe(true);
    fireEvent.click(moves[0]!);
    expect(props.onTransition).toHaveBeenCalledWith('task-1', 'REVIEW');
  });

  it('revalidates merged-head completion when a previously clean confirmation becomes dirty', () => {
    const props = reviewFixture();
    props.task!.completionPolicy = 'MERGED';
    props.task!.projection.agentReview!.status = 'PASSED';
    props.mergeSnapshot = {
      id: 'merge-1', taskId: 'task-1', iterationId: 'iteration-1', worktreeId: worktree.id,
      pullRequestNumber: 42, headSha: 'head', status: 'MERGED', observedAt: TEST_NOW
    };
    const { rerender } = render(<TaskDetail {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    const modal = screen.getByRole('dialog', { name: 'Mark done' });
    rerender(<TaskDetail {...props} gitSnapshot={{ ...gitSnapshot, status: 'DIRTY', unstagedCount: 1 }} />);
    const confirm = within(modal).getByRole('button', { name: 'Mark done' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(props.onTransition).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Commit' })).toBeNull();
  });

  it('blocks first-start submission when the runtime becomes unavailable without blocking local review readiness', () => {
    const props = fixture();
    props.task = { ...props.task!, workflowPhase: 'IN_PROGRESS' };
    const { rerender } = render(<TaskDetail {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start implementation' }));
    const drawer = screen.getByRole('dialog', { name: 'Start implementation' });
    fireEvent.change(within(drawer).getByRole('textbox', { name: 'Instruction to agent' }), { target: { value: 'Finish the work.' } });
    const runtimeState: NonNullable<Props['runtimeState']> = {
      preflight: {
        runtime: { id: 'codex', displayName: 'Codex', kind: 'APP_SERVER', transport: 'STDIO', lifecycleScope: 'APPLICATION' },
        readiness: {
          status: 'NOT_INSTALLED', canStart: false, summary: 'Codex is not installed.', detail: 'Install Codex before starting work.',
          checks: { discovery: 'NOT_FOUND', compatibility: 'UNKNOWN', initialization: 'NOT_STARTED', authentication: 'UNKNOWN', modelCatalog: 'UNKNOWN' },
          diagnostics: []
        },
        capabilities: codexCapabilities()
      },
      models: [], refreshedAt: TEST_NOW
    };
    rerender(<TaskDetail {...props} runtimeState={runtimeState} />);
    const send = within(drawer).getByRole('button', { name: 'Send to agent' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(within(drawer).getByRole('status').textContent).toBe('Codex is not installed.');
    fireEvent.click(send);
    expect(props.onStart).not.toHaveBeenCalled();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Cancel' }));
    const start = screen.getByRole('button', { name: 'Start implementation' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(start.title).toBe('Codex is not installed.');
    const moves = screen.getAllByRole('button', { name: 'Move to review' }) as HTMLButtonElement[];
    expect(moves.every((button) => !button.disabled)).toBe(true);
    fireEvent.click(moves[0]!);
    expect(props.onTransition).toHaveBeenCalledWith('task-1', 'REVIEW');
  });
});

function failingChecksFixture(): Props & { pullRequest: NonNullable<Props['pullRequest']> } {
  return {
    ...fixture(),
    pullRequest: {
      id: 'pr-1', taskId: 'task-1', iterationId: 'iteration-1', worktreeId: worktree.id,
      number: 42, url: 'https://github.com/example/project/pull/42', status: 'OPEN_READY', state: 'OPEN',
      isDraft: false, headRefName: worktree.branchName, headRefOid: 'head', baseRefName: 'main', observedAt: TEST_NOW
    },
    ciRollup: {
      id: 'ci-1', taskId: 'task-1', iterationId: 'iteration-1', worktreeId: worktree.id,
      pullRequestNumber: 42, headSha: 'head', status: 'FAILING', requiredStatus: 'FAILING',
      totalCount: 1, pendingCount: 0, passingCount: 0, failingCount: 1, skippedCount: 0, canceledCount: 0,
      checkDetails: [{ name: 'test', status: 'failed' }], observedAt: TEST_NOW
    }
  };
}

function reviewFixture(): Props {
  const review = makeRunRecord({ id: 'review-1', mode: 'REVIEW', status: 'COMPLETED', beforeGitSnapshotId: gitSnapshot.id, afterGitSnapshotId: 'git-after' });
  const props = fixture({ runs: [review], gitSnapshots: [gitSnapshot, { ...gitSnapshot, id: 'git-after' }] });
  props.task!.projection.agentReview = {
    status: 'NEEDS_CHANGES', runId: review.id,
    result: { schemaVersion: 'agent-review/v1', verdict: 'NEEDS_CHANGES', summary: 'Missing cleanup', findings: [
      { id: 'finding-1', severity: 'MAJOR', title: 'Missing cleanup', explanation: 'Release the listener on unmount.' }
    ] }
  };
  return props;
}

function fixture(overrides: Partial<Props> = {}): Props {
  return {
    task: makeTaskRecord({ workflowPhase: 'REVIEW', currentWorktreeId: worktree.id, currentIterationId: worktree.iterationId, projection: { worktree: 'PRESENT', git: 'CLEAN' } }),
    repository: { id: 'repository-1', kind: 'USER_REGISTERED', name: 'Project', path: '/tmp/project', status: 'AVAILABLE', remotes: [], createdAt: TEST_NOW, updatedAt: TEST_NOW },
    worktree, gitSnapshot, gitSnapshots: [gitSnapshot], events: [], runs: [], sessions: [], items: [],
    goalSnapshots: [], planRevisions: [], usageSnapshots: [], settingsObservations: [], subagentObservations: [],
    artifacts: [], attachments: [], interactions: [], previewPlans: [], previewApprovals: [], previewGenerations: [],
    previewGenerationAttachments: [], previewManagedResources: [], previewNodeAttempts: [], previewComposeProjects: [],
    previewLocalBindings: [], previewTaskRoutes: [], previewRuntimeResources: [], showMascot: false,
    onPrepareWorktree: vi.fn(), onStart: vi.fn().mockResolvedValue(undefined), onCancel: vi.fn(), onSteer: vi.fn(),
    onContinue: vi.fn().mockResolvedValue(undefined), onRetry: vi.fn(), onReview: vi.fn().mockResolvedValue(undefined),
    onRefreshEvidence: vi.fn().mockResolvedValue(undefined), onReconnectWorktree: vi.fn().mockResolvedValue(undefined),
    onUpdateWorktreeComparison: vi.fn().mockResolvedValue(undefined), onSyncAgentGoal: vi.fn(), onUpdateAgentNativeSession: vi.fn(),
    onRespondToInteraction: vi.fn(), onCreateDeliveryCommit: vi.fn(), onCreatePullRequest: vi.fn(), onRefreshGitHub: vi.fn(),
    onResolvePreview: vi.fn(), onSetPreviewLocalBinding: vi.fn(), onGetPreviewRecipeGeneration: vi.fn(), onGeneratePreviewRecipe: vi.fn(),
    onValidatePreviewRecipeDraft: vi.fn(), onAcceptPreviewRecipeDraft: vi.fn(), onDiscardPreviewRecipeDraft: vi.fn(), onWritePreviewRecipeManually: vi.fn(),
    onApprovePreview: vi.fn(), onStartPreview: vi.fn(), onOpenPreview: vi.fn(), onStopPreview: vi.fn(), onResetPreviewData: vi.fn(),
    onRetryPreviewSetup: vi.fn(), onReadPreviewLog: vi.fn(), onTransition: vi.fn(), onArchive: vi.fn(), onRequestDelete: vi.fn(), onModalOpenChange: vi.fn(),
    ...overrides
  };
}
