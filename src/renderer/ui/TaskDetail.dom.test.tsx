import { useState, type ComponentProps } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeReadiness } from '../../core/agent/AgentRuntimeReadiness';
import { CODEX_RUNTIME_DESCRIPTOR, codexCapabilities } from '../../core/agent/codex/codexCapabilities';
import { EMPTY_REVIEW_DRAFT, REVIEW_REQUEST_ITEM_LIMIT, type AgentModel, type AgentRuntimeState } from '../../shared/contracts';
import { makeGitSnapshotRecord, makeRunRecord, makeTaskRecord, TEST_NOW } from '../../testSupport/rendererRecords';
import { TaskDetail } from './TaskDetail';

vi.mock('../api/taskManagerClient', () => ({
  taskManagerApi: { getApplicationPreview: vi.fn(async () => ({ name: 'fixture', hasConfigurationFile: true })), readArtifact: vi.fn(async () => 'diff --git a/output.txt b/output.txt\n--- a/output.txt\n+++ b/output.txt\n@@ -1 +1 @@\n-old\n+new\n'), readReviewChanges: vi.fn(async () => ({ status: 'UNAVAILABLE', reason: 'NOT_RECORDED' })) }
}));

function detailProps(): ComponentProps<typeof TaskDetail> {
  return {
    attachmentOptions: { enabled: true, onStageBatch: vi.fn(), onDiscard: vi.fn() },
    agentInstructions: [], agentDraft: '', onPrepareTaskAgent: vi.fn(), onSavePrompt: vi.fn(), onReadAttachment: vi.fn(), onAgentDraftChange: vi.fn(), onFlushAgentDraft: vi.fn(), reviewDraft: EMPTY_REVIEW_DRAFT, onReviewDraftChange: vi.fn(), onQueueInstruction: vi.fn(), onEditInstruction: vi.fn(), onSendInstruction: vi.fn(),
    task: makeTaskRecord({ workflowPhase: 'IN_PROGRESS', currentWorktreeId: 'worktree-1', currentIterationId: 'iteration-1', projection: { worktree: 'PRESENT', git: 'DIRTY' } }),
    repository: { id: 'repository-1', kind: 'USER_REGISTERED', name: 'Project', path: '/tmp/project', status: 'AVAILABLE', remotes: [], createdAt: TEST_NOW, updatedAt: TEST_NOW },
    worktree: { id: 'worktree-1', taskId: 'task-1', repositoryId: 'repository-1', iterationId: 'iteration-1', ownership: 'EXTERNAL', worktreePath: '/tmp/project', branchName: 'feature', baseRef: 'main', baseSha: 'abc123', status: 'PRESENT', createdAt: TEST_NOW, updatedAt: TEST_NOW },
    gitSnapshot: makeGitSnapshotRecord({ status: 'DIRTY', untrackedCount: 1 }),
    gitSnapshots: [], events: [], runs: [], sessions: [], items: [], goalSnapshots: [], planRevisions: [], usageSnapshots: [], settingsObservations: [], subagentObservations: [], artifacts: [], attachments: [], interactions: [],
    onPrepareWorktree: vi.fn(), onRestoreWorktree: vi.fn(), onStart: vi.fn(), onCancel: vi.fn(), onSteer: vi.fn(), onContinue: vi.fn(), onSendReviewRequest: vi.fn(), onRetry: vi.fn(), onReview: vi.fn(), onSyncAgentGoal: vi.fn(), onUpdateAgentNativeSession: vi.fn(), onRespondToInteraction: vi.fn(), onCreateDeliveryCommit: vi.fn(), onCreatePullRequest: vi.fn(), onRefreshGitHub: vi.fn(), onTransition: vi.fn(), onArchive: vi.fn(), onRequestDelete: vi.fn(), onModalOpenChange: vi.fn(),
    onListExistingWorktrees: vi.fn(async () => []), onReconnectWorktree: vi.fn(), onUpdateWorktreeComparison: vi.fn(), onRefreshEvidence: vi.fn()
  };
}

describe('imported task actions', () => {
  it('keeps the detached Preview conversation out of implementation activity', () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    const props = detailProps();
    const previewRun = makeRunRecord({ id: 'preview-run', mode: 'PREVIEW', status: 'COMPLETED' });
    props.events = [{ id: 'preview-complete', type: 'AGENT_RUN_COMPLETED', taskId: props.task!.id,
      runId: previewRun.id, source: 'provider', sourceEventId: 'preview-complete',
      occurredAt: TEST_NOW, receivedAt: TEST_NOW, payload: {} }];
    props.previewAgent = {
      runs: [previewRun], items: [], instructions: [], interactions: [], sessions: [], plans: [],
      models: [], runtimes: [], defaults: { runtimeId: 'codex' },
      send: vi.fn(), stop: vi.fn(), editQueued: vi.fn(), respond: vi.fn()
    };
    render(<TaskDetail {...props} />);
    expect(screen.queryByText(/latest Implementation completed/i)).toBeNull();
  });

  it('does not replace a missing historical capture with current Git evidence', async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    const props = detailProps();
    const captured = makeGitSnapshotRecord({ id: 'captured', diffArtifactId: 'diff-captured' });
    props.task = makeTaskRecord({ ...props.task, workflowPhase: 'REVIEW', currentRunId: 'run-1' });
    props.run = makeRunRecord({ id: 'run-1', status: 'COMPLETED', afterGitSnapshotId: captured.id });
    props.runs = [props.run];
    props.gitSnapshots = [captured];
    props.artifacts = [{ id: 'diff-captured', taskId: 'task-1', kind: 'diff', path: '/tmp/captured.diff', byteCount: 120, createdAt: TEST_NOW, updatedAt: TEST_NOW }];
    const view = render(<TaskDetail {...props} />);
    fireEvent.click(await screen.findByText('1 file changed'));
    fireEvent.click(screen.getByRole('button', { name: 'View diff' }));
    expect(screen.getByText('Earlier capture')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Changes to show' })).toBeNull();

    view.rerender(<TaskDetail {...props} gitSnapshots={[]} gitSnapshot={makeGitSnapshotRecord({ headSha: 'newer-head', diffArtifactId: 'newer-diff' })} />);
    expect(screen.getByText('Earlier capture unavailable')).toBeDefined();
    expect(screen.queryByText(/newer-head/)).toBeNull();
    expect(screen.queryByText('output.txt')).toBeNull();
  });

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
    await waitFor(() => expect(props.onStart).toHaveBeenCalledWith(
      'task-1',
      'Fix the imported validation bug.',
      props.task!.agentSettings
    ));
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
    fireEvent.click(screen.getByRole('tab', { name: 'Review' }));
    const scope = screen.getByRole('button', { name: 'Changes to show' });
    const openComparison = async () => {
      scope.focus();
      fireEvent.keyDown(scope, { key: 'ArrowDown' });
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Change comparison…' }));
    };
    await openComparison();
    expect(await screen.findByRole('dialog')).toBeDefined();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await openComparison();
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

  function reviewNeedsChanges(props: ReturnType<typeof detailProps>) {
    props.task = makeTaskRecord({ ...props.task, workflowPhase: 'REVIEW', projection: {
      ...props.task!.projection,
      agentReview: {
        status: 'NEEDS_CHANGES', runId: 'review-1',
        result: { schemaVersion: 'agent-review/v1', verdict: 'NEEDS_CHANGES', summary: 'Fix validation.', findings: [
          { id: 'finding-1', severity: 'MAJOR', title: 'Invalid input accepted', explanation: 'Reject an invalid value.' }
        ] }
      }
    } });
    props.runs = [makeRunRecord({ id: 'review-1', mode: 'REVIEW', status: 'COMPLETED' })];
    return props;
  }

  it('withdraws Request changes once the review it would send goes stale', async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    const props = reviewNeedsChanges(detailProps());
    const mounted = render(<TaskDetail {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
    expect(await screen.findByRole('tab', { name: 'Review', selected: true })).toBeDefined();
    // It opens on the request sheet, so the person sees what will be sent.
    const sheet = screen.getByRole('dialog', { name: 'Request changes' });
    expect(within(sheet).getByRole('button', { name: 'Request changes' })).toHaveProperty('disabled', false);

    mounted.rerender(<TaskDetail {...props} task={{ ...props.task!, projection: { ...props.task!.projection,
      agentReview: { ...props.task!.projection.agentReview!, status: 'STALE' } } }} />);

    // An out-of-date review's findings are context only: nothing is left to send.
    expect(screen.queryByRole('button', { name: /^\d+ fix/ })).toBeNull();
    expect(screen.queryAllByRole('button', { name: 'Request changes' }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getByText('From the earlier review')).toBeDefined();
    expect(props.onStart).not.toHaveBeenCalled();
    expect(props.onContinue).not.toHaveBeenCalled();
  });

  it('starts a detached review without a source run and routes findings to the first coding instruction', async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    const props = detailProps();
    props.task!.workflowPhase = 'REVIEW';
    const mounted = render(<TaskDetail {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run agent review' }));
    await waitFor(() => expect(props.onReview).toHaveBeenCalledWith(undefined));
    mounted.unmount();
    props.task = makeTaskRecord({ ...props.task, projection: { ...props.task!.projection, agentReview: {
      status: 'NEEDS_CHANGES', runId: 'review-1', result: { schemaVersion: 'agent-review/v1', verdict: 'NEEDS_CHANGES', summary: 'Fix validation.', findings: [{ id: 'finding-1', severity: 'MAJOR', title: 'Invalid input accepted', explanation: 'Reject an invalid value.', path: 'src/input.ts', line: 1 }] }
    } } });
    props.runs = [makeRunRecord({ id: 'review-1', mode: 'REVIEW', status: 'COMPLETED' })];
    render(<TaskDetail {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
    expect(await screen.findByRole('tab', { name: 'Review', selected: true })).toBeDefined();
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Request changes' })).getByRole('button', { name: 'Request changes' }));
    // The first turn carries the request item by item, so its answers read as a round.
    await waitFor(() => expect(props.onStart).toHaveBeenCalledWith(
      'task-1',
      expect.stringContaining('Invalid input accepted'),
      props.task!.agentSettings,
      expect.objectContaining({ reviewRunId: 'review-1', items: [expect.objectContaining({ number: 1, kind: 'FINDING', findingId: 'finding-1' })] })
    ));
    expect(props.onContinue).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Commit' })).toBeNull();
  });
});

describe('Overview decision slot', () => {
  function managed(status: 'MISSING' | 'PRUNABLE', workflowPhase: 'REVIEW' | 'IN_REVIEW') {
    const props = detailProps();
    props.worktree = { ...props.worktree!, ownership: 'MANAGED', status };
    props.task = makeTaskRecord({ ...props.task, workflowPhase, projection: { worktree: status, git: 'UNAVAILABLE' } });
    return props;
  }

  it.each([
    ['PRUNABLE', 'REVIEW'],
    ['MISSING', 'IN_REVIEW']
  ] as const)('offers restore for a %s task worktree in %s', (status, phase) => {
    HTMLElement.prototype.scrollTo = vi.fn();
    const props = managed(status, phase);
    render(<TaskDetail {...props} />);
    const slot = screen.getByRole('region', { name: 'Current step' });
    expect(within(slot).getByRole('heading', { name: 'Checkout missing' })).toBeTruthy();
    fireEvent.click(within(slot).getByRole('button', { name: 'Restore worktree' }));
    expect(props.onPrepareWorktree).toHaveBeenCalledWith('task-1');
  });

  it('restores a missing checkout before offering to retry a failed run in it', () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    const props = managed('MISSING', 'REVIEW');
    props.task = makeTaskRecord({ ...props.task, workflowPhase: 'IN_PROGRESS', currentRunId: 'run-1',
      projection: { worktree: 'MISSING', agentRun: 'FAILED' } });
    props.run = makeRunRecord({ id: 'run-1', status: 'FAILED' });
    props.runs = [props.run];
    render(<TaskDetail {...props} />);
    const slot = screen.getByRole('region', { name: 'Current step' });
    expect(within(slot).getByRole('button', { name: 'Restore worktree' })).toBeTruthy();
    expect(within(slot).queryByRole('button', { name: 'Retry implementation' })).toBeNull();
  });

  it('offers Create draft PR exactly once, with the finishing actions, before a pull request exists', () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    const props = managed('MISSING', 'REVIEW');
    props.worktree = { ...props.worktree!, status: 'PRESENT' };
    props.gitSnapshot = makeGitSnapshotRecord({ status: 'COMMITTED_UNPUSHED', commitsAheadOfBase: 1, committedDiffFileCount: 1 });
    props.task = makeTaskRecord({ ...props.task, workflowPhase: 'REVIEW', currentRunId: 'run-1',
      projection: { worktree: 'PRESENT', git: 'COMMITTED_UNPUSHED', agentRun: 'COMPLETED' } });
    props.run = makeRunRecord({ id: 'run-1', status: 'COMPLETED' });
    props.runs = [props.run];
    render(<TaskDetail {...props} />);
    const slot = screen.getByRole('region', { name: 'Current step' });
    expect(screen.getAllByRole('button', { name: 'Create draft PR' })).toHaveLength(1);
    const labels = within(slot).getAllByRole('button').map((button) => button.textContent);
    // A way forward comes before marking done despite open evidence, the override.
    expect(labels.indexOf('Create draft PR')).toBeGreaterThan(-1);
    expect(labels.indexOf('Create draft PR')).toBeLessThan(labels.indexOf('Mark done anyway'));
  });

  it('keeps Create draft PR in PR Status while another step holds the Now panel', () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    const props = managed('MISSING', 'REVIEW');
    props.worktree = { ...props.worktree!, status: 'PRESENT' };
    props.gitSnapshot = makeGitSnapshotRecord({ status: 'COMMITTED_UNPUSHED', commitsAheadOfBase: 1, committedDiffFileCount: 1 });
    props.task = makeTaskRecord({ ...props.task, workflowPhase: 'IN_PROGRESS', currentRunId: undefined,
      projection: { worktree: 'PRESENT', git: 'COMMITTED_UNPUSHED' } });
    render(<TaskDetail {...props} />);
    const slot = screen.getByRole('region', { name: 'Current step' });
    const create = screen.getAllByRole('button', { name: 'Create draft PR' });
    expect(create).toHaveLength(1);
    expect(slot.contains(create[0])).toBe(false);
    expect(screen.getByRole('region', { name: 'Pull request' }).contains(create[0])).toBe(true);
  });

  it('leads with finishing once the pull request is merged, not with a review', () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    const props = managed('MISSING', 'REVIEW');
    props.worktree = { ...props.worktree!, status: 'PRESENT' };
    props.task = makeTaskRecord({ ...props.task, workflowPhase: 'REVIEW', completionPolicy: 'MANUAL', currentRunId: 'run-1',
      projection: { worktree: 'PRESENT', git: 'PUSHED', agentRun: 'COMPLETED', githubPullRequest: 'MERGED', merge: 'MERGED' } });
    props.run = makeRunRecord({ id: 'run-1', status: 'COMPLETED' });
    props.runs = [props.run];
    render(<TaskDetail {...props} />);
    const slot = screen.getByRole('region', { name: 'Current step' });
    // Done is the remaining step, but marking it despite open evidence is the
    // owner's override: offered, never promoted to the recommended action.
    expect(within(slot).getByRole('button', { name: 'Mark done anyway' }).className).not.toContain('primary-button');
    expect(within(slot).queryByRole('button', { name: 'Run agent review' })).toBeNull();
  });
});

describe('Pull request feedback', () => {
  function feedbackDetail(threads: number, configure?: (props: ReturnType<typeof detailProps>) => void) {
    HTMLElement.prototype.scrollTo = vi.fn();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const props = detailProps();
    const artifactId = '00000000-0000-4000-8000-0000000000fb';
    props.worktree = { ...props.worktree!, ownership: 'MANAGED' };
    props.task = makeTaskRecord({ ...props.task, workflowPhase: 'IN_REVIEW', currentRunId: 'run-1', projection: {
      worktree: 'PRESENT', git: 'PUSHED', agentRun: 'COMPLETED', githubPullRequest: 'OPEN_READY', githubPullRequestNumber: 82,
      githubPullRequestUrl: 'https://github.com/acme/widgets/pull/82', reviews: 'CHANGES_REQUESTED'
    } });
    props.run = makeRunRecord({ id: 'run-1', status: 'COMPLETED' });
    props.runs = [props.run];
    props.gitSnapshot = makeGitSnapshotRecord({ status: 'PUSHED', headSha: 'f'.repeat(40), upstreamSha: 'f'.repeat(40) });
    const owner = { taskId: 'task-1', iterationId: 'iteration-1', worktreeId: 'worktree-1' };
    props.pullRequest = { ...owner, id: 'pr-1', number: 82, url: 'https://github.com/acme/widgets/pull/82', status: 'OPEN_READY',
      state: 'OPEN', isDraft: false, headRefOid: 'f'.repeat(40), title: 'Save layouts', observedAt: TEST_NOW };
    props.reviewRollup = { ...owner, id: 'review-rollup-1', pullRequestNumber: 82, headSha: 'f'.repeat(40), status: 'CHANGES_REQUESTED',
      observedAt: TEST_NOW, feedback: { artifactId, digest: 'a'.repeat(64), capturedAt: TEST_NOW, unresolvedCount: threads, discussionCount: threads,
        reviewers: [{ name: 'alice', state: 'CHANGES_REQUESTED' }] } };
    props.onReadArtifact = vi.fn(async () => JSON.stringify({
      schema: 'task-monki/pull-request-feedback/v1', provider: 'GITHUB', number: 82, headSha: 'f'.repeat(40), capturedAt: TEST_NOW,
      reviewers: [{ name: 'alice', state: 'CHANGES_REQUESTED' }], truncated: false,
      discussions: Array.from({ length: threads }, (_, index) => ({
        id: `PRRT_${index + 1}`, kind: 'THREAD', path: 'output.txt', side: 'NEW', line: 1, resolvable: true, resolved: false, outdated: false,
        comments: [{ author: 'alice', body: index ? `Thread ${index + 1}.` : 'Handle a null layout.', truncated: false }], commentCount: 1
      }))
    }));
    function Stateful() {
      const [draft, setDraft] = useState(EMPTY_REVIEW_DRAFT);
      return <TaskDetail {...props} reviewDraft={draft} onReviewDraftChange={setDraft} />;
    }
    configure?.(props);
    render(<Stateful />);
    return props;
  }

  it('offers to address what reviewers left unresolved, and shows the request before anything is sent', async () => {
    const props = feedbackDetail(1);
    const slot = screen.getByRole('region', { name: 'Current step' });
    expect(within(slot).getByText('alice requested changes, 1 unresolved thread')).toBeDefined();
    // What was asked is read before it is sent: each comment by who wrote it and where.
    const asked = await within(slot).findByRole('list', { name: 'Comments' });
    expect(within(asked).getByRole('button', { name: /alice Handle a null layout\. output\.txt:1/u })).toBeDefined();
    const address = await within(slot).findByRole('button', { name: 'Address comments' });
    fireEvent.click(address);

    expect(await screen.findByRole('tab', { name: 'Review', selected: true })).toBeDefined();
    const sheet = await screen.findByRole('dialog', { name: 'Address comments' });
    expect(within(within(sheet).getByRole('region', { name: 'From GitHub' })).getByText('Handle a null layout.')).toBeDefined();
    // Nothing went to the agent: sending is the sheet's own step.
    expect(props.onSendReviewRequest).not.toHaveBeenCalled();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Address comments' }));
    await waitFor(() => expect(props.onSendReviewRequest).toHaveBeenCalledWith(
      'run-1',
      expect.stringContaining('----- BEGIN GITHUB REVIEW 00000000 -----'),
      expect.objectContaining({ items: [expect.objectContaining({ kind: 'DISCUSSION', discussionId: 'PRRT_1', author: 'alice' })] })
    ));
  });

  it('waits on the reviewers once the person answered after them, and asks nothing of the person', async () => {
    feedbackDetail(1, (configured) => {
      configured.reviewRollup = { ...configured.reviewRollup!, feedback: { ...configured.reviewRollup!.feedback!,
        lastOtherCommentAt: '2026-07-07T10:00:00.000Z', lastViewerCommentAt: '2026-07-07T11:00:00.000Z' } };
    });
    const slot = screen.getByRole('region', { name: 'Current step' });
    expect(within(slot).getByText('Waiting for review')).toBeDefined();
    expect(within(slot).getByText('Waiting on alice')).toBeDefined();
    // The thread was never sent, but the person answered after alice: it is hers to read now.
    await screen.findByRole('tab', { name: 'Overview', selected: true });
    expect(within(slot).queryByRole('button', { name: 'Address comments' })).toBeNull();
    expect(within(slot).queryByRole('list', { name: 'Comments' })).toBeNull();
  });

  it('asks a person to review again from beside their name, and never an app', async () => {
    const props = feedbackDetail(1, (configured) => {
      configured.reviewRollup = { ...configured.reviewRollup!, feedback: { ...configured.reviewRollup!.feedback!,
        reviewers: [{ name: 'alice', state: 'CHANGES_REQUESTED' }, { name: 'ci-review', state: 'CHANGES_REQUESTED', bot: true }] } };
      configured.onReplyToPullRequest = vi.fn(async () => ({ posted: 0, resolved: 0, requested: ['alice'], failed: [] }));
    });
    const record = screen.getByText('Pull request', { selector: 'h3' }).closest('section')!;
    expect(within(record).queryByRole('button', { name: 'Ask ci-review to review again' })).toBeNull();
    fireEvent.click(within(record).getByRole('button', { name: 'Ask alice to review again' }));
    await waitFor(() => expect(props.onReplyToPullRequest).toHaveBeenCalledWith('task-1', [], ['alice']));
  });

  it('holds a request with more items than one can carry, and says why before anything is sent', async () => {
    const props = feedbackDetail(REVIEW_REQUEST_ITEM_LIMIT + 1);
    fireEvent.click(await within(screen.getByRole('region', { name: 'Current step' })).findByRole('button', { name: 'Address comments' }));
    const send = within(await screen.findByRole('dialog', { name: 'Address comments' })).getByRole('button', { name: 'Address comments' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById(send.getAttribute('aria-describedby')!)?.textContent).toBe(`${REVIEW_REQUEST_ITEM_LIMIT + 1} items, ${REVIEW_REQUEST_ITEM_LIMIT} at most`);
    fireEvent.click(send);
    expect(props.onSendReviewRequest).not.toHaveBeenCalled();
  });
});

describe('Pull request steps', () => {
  it('merges only the head the person saw, with the method and branch they chose', async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const head = 'f'.repeat(40);
    const owner = { taskId: 'task-1', iterationId: 'iteration-1', worktreeId: 'worktree-1' };
    const props = detailProps();
    props.worktree = { ...props.worktree!, ownership: 'MANAGED', branchName: 'task/save' };
    props.task = makeTaskRecord({ ...props.task, workflowPhase: 'IN_REVIEW', currentRunId: 'run-1', projection: {
      worktree: 'PRESENT', git: 'PUSHED', agentRun: 'COMPLETED', githubPullRequest: 'OPEN_READY', githubPullRequestNumber: 82,
      ciChecks: 'PASSING', reviews: 'APPROVED', merge: 'MERGEABLE'
    } });
    props.run = makeRunRecord({ id: 'run-1', status: 'COMPLETED' });
    props.runs = [props.run];
    props.gitSnapshot = makeGitSnapshotRecord({ status: 'PUSHED', headSha: head, upstreamSha: head });
    props.pullRequest = { ...owner, id: 'pr-1', number: 82, url: 'https://github.com/acme/widgets/pull/82', status: 'OPEN_READY', state: 'OPEN',
      isDraft: false, headRefOid: head, headRefName: 'task/save', baseRefName: 'main', title: 'Save layouts', observedAt: TEST_NOW };
    props.ciRollup = { ...owner, id: 'ci-1', pullRequestNumber: 82, headSha: head, status: 'PASSING', requiredStatus: 'UNKNOWN', totalCount: 1,
      pendingCount: 0, passingCount: 1, failingCount: 0, skippedCount: 0, canceledCount: 0, checkDetails: [{ name: 'unit', status: 'passed' }], observedAt: TEST_NOW };
    props.reviewRollup = { ...owner, id: 'review-rollup-1', pullRequestNumber: 82, headSha: head, status: 'APPROVED', observedAt: TEST_NOW };
    props.mergeSnapshot = { ...owner, id: 'merge-1', pullRequestNumber: 82, headSha: head, status: 'MERGEABLE', mergedAt: null, observedAt: TEST_NOW };
    props.onReadPullRequestMergeOptions = vi.fn(async () => ({
      methods: ['MERGE', 'SQUASH'] as Array<'MERGE' | 'SQUASH'>, defaultMethod: 'MERGE' as const,
      deletesBranchOnMerge: false, canDeleteBranch: true, head: 'task/save', base: 'main'
    }));
    props.onMergePullRequest = vi.fn(async () => undefined);
    render(<TaskDetail {...props} />);

    const slot = screen.getByRole('region', { name: 'Current step' });
    expect(within(slot).getByRole('heading', { name: 'Ready to merge' })).toBeDefined();
    // A pull request already ready for review is not offered as a draft step.
    expect(within(slot).queryByRole('button', { name: 'Ready for review' })).toBeNull();
    fireEvent.click(within(slot).getByRole('button', { name: 'Merge' }));
    const dialog = await screen.findByRole('dialog', { name: 'Merge pull request' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Squash' }));
    // The task's own branch is deleted with the merge unless the person keeps it.
    expect((within(dialog).getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    expect(props.onMergePullRequest).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Squash and merge' }));
    await waitFor(() => expect(props.onMergePullRequest).toHaveBeenCalledWith('task-1', 'SQUASH', head, true));
  });

  it('keeps the pull request steps on the page while the agent review holds the Now panel', async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    const head = 'f'.repeat(40);
    const owner = { taskId: 'task-1', iterationId: 'iteration-1', worktreeId: 'worktree-1' };
    const props = detailProps();
    props.worktree = { ...props.worktree!, ownership: 'MANAGED', branchName: 'task/save' };
    props.task = makeTaskRecord({ ...props.task, workflowPhase: 'REVIEW', currentRunId: 'run-1', projection: {
      worktree: 'PRESENT', git: 'PUSHED', agentRun: 'COMPLETED', githubPullRequest: 'OPEN_READY', githubPullRequestNumber: 82,
      ciChecks: 'PASSING', reviews: 'APPROVED', merge: 'MERGEABLE',
      agentReview: { status: 'NEEDS_CHANGES', runId: 'review-1', result: { schemaVersion: 'agent-review/v1', verdict: 'NEEDS_CHANGES', summary: 'Fix validation.',
        findings: [{ id: 'finding-1', severity: 'MAJOR', title: 'Invalid input accepted', explanation: 'Reject an invalid value.' }] } }
    } });
    props.run = makeRunRecord({ id: 'run-1', status: 'COMPLETED' });
    props.runs = [props.run, makeRunRecord({ id: 'review-1', mode: 'REVIEW', status: 'COMPLETED' })];
    props.gitSnapshot = makeGitSnapshotRecord({ status: 'PUSHED', headSha: head, upstreamSha: head });
    props.pullRequest = { ...owner, id: 'pr-1', number: 82, url: 'https://github.com/acme/widgets/pull/82', status: 'OPEN_READY', state: 'OPEN',
      isDraft: false, headRefOid: head, headRefName: 'task/save', baseRefName: 'main', title: 'Save layouts', observedAt: TEST_NOW };
    props.ciRollup = { ...owner, id: 'ci-1', pullRequestNumber: 82, headSha: head, status: 'PASSING', requiredStatus: 'UNKNOWN', totalCount: 1,
      pendingCount: 0, passingCount: 1, failingCount: 0, skippedCount: 0, canceledCount: 0, checkDetails: [{ name: 'unit', status: 'passed' }], observedAt: TEST_NOW };
    props.reviewRollup = { ...owner, id: 'review-rollup-1', pullRequestNumber: 82, headSha: head, status: 'APPROVED', observedAt: TEST_NOW };
    props.mergeSnapshot = { ...owner, id: 'merge-1', pullRequestNumber: 82, headSha: head, status: 'MERGEABLE', mergedAt: null, observedAt: TEST_NOW };
    props.onReadPullRequestMergeOptions = vi.fn(async () => ({
      methods: ['MERGE'] as Array<'MERGE'>, defaultMethod: 'MERGE' as const, deletesBranchOnMerge: false, canDeleteBranch: true, head: 'task/save', base: 'main'
    }));
    props.onMergePullRequest = vi.fn(async () => undefined);
    render(<TaskDetail {...props} />);

    // The review's step leads; merging is still a step the page offers, beside it.
    const slot = screen.getByRole('region', { name: 'Current step' });
    expect(within(slot).getByRole('button', { name: 'Request changes' })).toBeDefined();
    expect(within(slot).queryByRole('button', { name: 'Merge' })).toBeNull();
    const delivery = screen.getByRole('heading', { name: 'Delivery' }).closest('section')!;
    expect(within(delivery).getByText('Ready to merge')).toBeDefined();
    fireEvent.click(within(delivery).getByRole('button', { name: 'Merge' }));
    expect(await screen.findByRole('dialog', { name: 'Merge pull request' })).toBeDefined();
    expect(props.onMergePullRequest).not.toHaveBeenCalled();
  });

});

describe('Agent pre-run setup', () => {
  it('reviews a Preview handoff in the initial prompt and stays in Preview if the draft cannot be saved', async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const props = detailProps();
    Object.assign(props, readyRuntime());
    let failSave = true;
    const prepare = vi.fn(async (text: string) => {
      if (failSave) throw new Error('Draft storage unavailable');
      return `${props.task!.prompt}\n\n${text}`;
    });
    function Harness() {
      const [task, setTask] = useState(props.task!);
      return <TaskDetail {...props} task={task} {...{ onPrepareTaskAgent: async (text: string) => {
        const promptDraft = await prepare(text);
        setTask({ ...task, promptDraft });
      } }} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('tab', { name: 'Preview' }));
    fireEvent.keyDown(await screen.findByRole('button', { name: 'More preview actions' }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Send to task agent' }));
    await screen.findByText('Draft storage unavailable');
    expect(screen.getByRole('tab', { name: 'Preview' }).getAttribute('aria-selected')).toBe('true');
    failSave = false;
    fireEvent.keyDown(screen.getByRole('button', { name: 'More preview actions' }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Send to task agent' }));
    const editor = await screen.findByRole('textbox', { name: 'Task prompt' });
    expect((editor as HTMLTextAreaElement).value).toContain('Inspect preview.yaml');
    expect((editor as HTMLTextAreaElement).value).toContain(props.task!.prompt);
    // The handoff only drafts the prompt; starting stays the person's step.
    expect(screen.getByRole('button', { name: 'Start implementation' })).toBeTruthy();
    expect(props.onStart).not.toHaveBeenCalled();
    expect(props.onAgentDraftChange).not.toHaveBeenCalled();
  });

  it('saves an edited prompt before preparing, and keeps it when the save fails', async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const props = detailProps();
    props.worktree = undefined;
    props.task = makeTaskRecord({ prompt: 'Original request', workflowPhase: 'READY', projection: { worktree: 'NOT_CREATED' } });
    let rejectSave = true;
    props.onSavePrompt = vi.fn(async (_prompt, draftOnly) => {
      if (!draftOnly && rejectSave) throw new Error('Storage unavailable');
    });
    Object.assign(props, readyRuntime());
    render(<TaskDetail {...props} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Agent' }));
    const editor = screen.getByRole('textbox', { name: 'Task prompt' });
    fireEvent.change(editor, { target: { value: 'Use the revised request.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare worktree' }));
    await screen.findByText('Storage unavailable');
    expect(editor).toHaveProperty('value', 'Use the revised request.');
    expect(props.onPrepareWorktree).not.toHaveBeenCalled();
    rejectSave = false;
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(props.onPrepareWorktree).toHaveBeenCalled());
    expect(props.onSavePrompt).toHaveBeenLastCalledWith('Use the revised request.', false, undefined);
  });

  it('validates prompt image drafts against the model selected before the first run', async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const props = detailProps();
    const runtime = readyRuntime();
    const textModel = runtime.models[0]!;
    const imageModel: AgentModel = { ...textModel, id: 'codex:image-model', model: 'image-model',
      displayName: 'Image model', inputModalities: ['text', 'image'] };
    runtime.models.push(imageModel);
    props.task = makeTaskRecord({ prompt: 'Describe the reference.', agentSettings: { model: textModel.model }, workflowPhase: 'READY' });
    props.worktree = undefined;
    Object.assign(props, runtime);
    props.attachmentOptions = {
      ...props.attachmentOptions, model: textModel,
      initialDraft: { id: 'image-draft', createdAt: TEST_NOW, updatedAt: TEST_NOW,
        attachments: [{ id: 'image-file', draftId: 'image-draft', ordinal: 0, displayName: 'reference.png',
          kind: 'image', mediaType: 'image/png', byteCount: 3, sha256: 'a'.repeat(64), createdAt: TEST_NOW }] },
      onReadDraftAttachment: vi.fn().mockResolvedValue({ attachmentId: 'image-file', displayName: 'reference.png',
        kind: 'image', mediaType: 'image/png', byteCount: 3, bytes: new Uint8Array([1, 2, 3]).buffer })
    };
    render(<TaskDetail {...props} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Agent' }));
    await screen.findByRole('button', { name: 'reference.png' });
    expect(screen.getByRole('button', { name: 'Prepare worktree' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Model: Test model via Codex' }));
    fireEvent.click(screen.getByRole('option', { name: 'Image model via Codex' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare worktree' })).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByRole('button', { name: 'Prepare worktree' }));
    await waitFor(() => expect(props.onSavePrompt).toHaveBeenCalledWith('Describe the reference.', false, { attachmentDraftId: 'image-draft' }));
    expect(props.attachmentOptions.onStageBatch).not.toHaveBeenCalled();
  });

  function readyRuntime(): { models: AgentModel[]; runtimes: AgentRuntimeState[] } {
    const model: AgentModel = {
      id: 'codex:test-model',
      runtimeId: 'codex',
      model: 'test-model',
      displayName: 'Test model',
      hidden: false,
      isDefault: true,
      supportedReasoningEfforts: ['low', 'medium'],
      defaultReasoningEffort: 'medium',
      serviceTiers: [],
      inputModalities: ['text']
    };
    return {
      models: [model],
      runtimes: [{
        preflight: {
          runtime: CODEX_RUNTIME_DESCRIPTOR,
          readiness: createRuntimeReadiness('READY', 'Codex is ready.'),
          capabilities: codexCapabilities()
        },
        models: [model],
        refreshedAt: TEST_NOW
      }]
    };
  }

  it('shows the request and one prepare action before the first run', () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const props = detailProps();
    props.worktree = undefined;
    props.task = makeTaskRecord({
      workflowPhase: 'IN_PROGRESS',
      prompt: 'Add a multiply helper and cover it with tests.',
      projection: { worktree: 'NOT_CREATED' }
    });
    Object.assign(props, readyRuntime());
    // The window's top bar, where the Agent tab's title row sits.
    const titlebar = document.body.appendChild(document.createElement('div'));
    render(<TaskDetail {...props} titlebarSlot={titlebar} />);
    // The Overview's decision slot holds the one setup step, above the request.
    expect(screen.getAllByRole('button', { name: 'Prepare worktree' })).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Request' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare worktree' }));
    expect(props.onPrepareWorktree).toHaveBeenCalledWith('task-1');
    // The Agent tab's pre-run setup offers the same single step with its settings.
    fireEvent.click(screen.getByRole('tab', { name: 'Agent' }));
    expect(screen.getAllByRole('button', { name: 'Prepare worktree' })).toHaveLength(1);
    expect(within(titlebar).getByRole('heading', { name: 'Test task' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Start this task' })).toBeTruthy();
    expect(screen.getByText('Add a multiply helper and cover it with tests.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Request' })).toBeNull();
    expect(screen.getByRole('button', { name: /^Access: / })).toBeTruthy();
    titlebar.remove();
  });

  it('does not present a different permission preset as the saved execution settings', async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const props = detailProps();
    props.worktree = { ...props.worktree!, ownership: 'MANAGED' };
    props.task = makeTaskRecord({ ...props.task, agentSettings: {
      sandbox: 'DANGER_FULL_ACCESS', approvalPolicy: 'on-request', approvalsReviewer: 'user'
    } });
    Object.assign(props, readyRuntime());
    render(<TaskDetail {...props} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Agent' }));
    expect(screen.getByRole('button', { name: 'Access: Custom' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start implementation' }));
    await waitFor(() => expect(props.onStart).toHaveBeenCalledWith('task-1', undefined, props.task!.agentSettings));
  });

  it('starts a task opened from an issue from the Agent tab with no request of the person\'s own', async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const props = detailProps();
    props.worktree = { ...props.worktree!, ownership: 'MANAGED' };
    props.task = makeTaskRecord({ ...props.task, prompt: '', remoteSource: {
      provider: 'GITHUB', host: 'github.com', repositoryPath: 'acme/widgets', kind: 'ISSUE', number: 12,
      url: 'https://github.com/acme/widgets/issues/12', title: 'Crash on save',
      snapshotArtifactId: '00000000-0000-4000-8000-000000000012', capturedAt: '2026-10-17T00:00:00.000Z'
    } });
    Object.assign(props, readyRuntime());
    render(<TaskDetail {...props} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Agent' }));
    const start = screen.getByRole('button', { name: 'Start implementation' }) as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    await waitFor(() => expect(props.onStart).toHaveBeenCalled());
  });

  it('starts implementation with the execution settings reviewed on the Agent tab', async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const props = detailProps();
    props.worktree = { ...props.worktree!, ownership: 'MANAGED' };
    Object.assign(props, readyRuntime());
    render(<TaskDetail {...props} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Agent' }));
    fireEvent.keyDown(screen.getByRole('button', { name: /^Access: / }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Network access' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start implementation' }));
    await waitFor(() => expect(props.onStart).toHaveBeenCalledWith('task-1', undefined, {
      networkAccess: true
    }));
    expect(screen.queryByRole('button', { name: 'Prepare worktree' })).toBeNull();
  });
});

describe('Task title placement', () => {
  function titlebar(): HTMLElement {
    const slot = document.createElement('div');
    document.body.prepend(slot);
    return slot;
  }
  function selectTab(name: string) {
    fireEvent.click(screen.getByRole('tab', { name }));
  }
  function pageHeading(): HTMLElement {
    return screen.getByRole('heading', { level: 1, name: 'Test task' });
  }

  it('keeps the head on the Overview and gives the working tabs the title row in the top bar', () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const slot = titlebar();
    render(<TaskDetail {...detailProps()} titlebarSlot={slot} />);

    // The Overview's head states the title and the lifecycle; the top bar stays empty.
    expect(slot.contains(pageHeading())).toBe(false);
    expect(screen.getByRole('list', { name: 'Lifecycle' })).toBeDefined();
    expect(within(slot).queryByRole('button', { name: /Task options/ })).toBeNull();

    for (const name of ['Agent', 'Review', 'Preview']) {
      selectTab(name);
      // One heading, in the top bar with the task's menu; no head above the tabs.
      expect(slot.contains(pageHeading())).toBe(true);
      expect(within(slot).getByRole('button', { name: 'Task options for Test task' })).toBeDefined();
      expect(screen.queryByRole('list', { name: 'Lifecycle' })).toBeNull();
      // Opening a tab never animates the title.
      expect(slot.firstElementChild!.hasAttribute('data-instant')).toBe(true);
    }

    selectTab('Overview');
    expect(slot.contains(pageHeading())).toBe(false);
    slot.remove();
  });

  it('moves the steps the head offered with the title row, except where the tab offers them itself', async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const slot = titlebar();
    const props = detailProps();
    props.initialTab = 'agent';
    render(<TaskDetail {...props} titlebarSlot={slot} />);

    // Imported work before any run: reviewing it is reachable from the Agent tab's title row.
    fireEvent.click(within(slot).getByRole('button', { name: 'Run agent review' }));
    await waitFor(() => expect(props.onReview).toHaveBeenCalledWith(undefined));

    // The Review bar offers its own review step, so the title row does not repeat it.
    selectTab('Review');
    expect(within(slot).queryByRole('button', { name: 'Run agent review' })).toBeNull();
    slot.remove();
  });

  it('leaves the title in the top bar when a side panel docks beside a working tab', () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const slot = titlebar();
    const props = detailProps();
    props.initialTab = 'agent';
    props.run = makeRunRecord({ status: 'COMPLETED', endedAt: TEST_NOW });
    props.runs = [props.run];
    props.ask = {
      records: { runs: [], items: [], instructions: [], interactions: [], sessions: [], plans: [] },
      ask: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), end: vi.fn(async () => undefined)
    };
    render(<TaskDetail {...props} titlebarSlot={slot} />);

    const tabBar = screen.getByRole('tablist', { name: 'Task sections' }).parentElement!;
    const toggle = within(tabBar).getByRole('button', { name: 'Ask', pressed: false });
    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(slot.contains(pageHeading())).toBe(true);
    expect(screen.getByRole('tab', { name: 'Agent', selected: true })).toBeDefined();
    expect(screen.queryByRole('list', { name: 'Lifecycle' })).toBeNull();
    slot.remove();
  });

  it('raises the title row into the top bar once the Overview head scrolls away, and only then animates it', () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    let report: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) { report = callback; }
      observe() {} disconnect() {}
    });
    const slot = titlebar();
    render(<TaskDetail {...detailProps()} titlebarSlot={slot} />);
    const row = () => slot.firstElementChild as HTMLElement;

    // Where the page already is on opening: shown as it is, never animated.
    act(() => report!([{ isIntersecting: true }]));
    expect(row().hasAttribute('data-visible')).toBe(false);
    expect(row().getAttribute('aria-hidden')).toBe('true');

    act(() => report!([{ isIntersecting: false }]));
    expect(row().hasAttribute('data-visible')).toBe(true);
    expect(row().hasAttribute('data-instant')).toBe(false);
    // The head keeps the page's heading; the top bar's copy is not a second one.
    expect(slot.contains(pageHeading())).toBe(false);
    expect(within(slot).getByRole('button', { name: 'Task options for Test task' })).toBeDefined();

    act(() => report!([{ isIntersecting: true }]));
    expect(row().hasAttribute('data-visible')).toBe(false);
    slot.remove();
    vi.unstubAllGlobals();
  });
});

describe('Task sections keyboard navigation', () => {
  it('keeps focus on the selected tab when arrowing into and out of the Agent tab', async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    render(<TaskDetail {...detailProps()} />);

    const overview = screen.getByRole('tab', { name: 'Overview' });
    overview.focus();
    // The Agent tab renders the task header inside its conversation, which
    // remounts the tablist; focus must not fall to the page.
    fireEvent.keyDown(overview, { key: 'ArrowRight' });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Agent', selected: true })));

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Review', selected: true })));
  });
});
