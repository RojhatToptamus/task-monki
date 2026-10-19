import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BugCaseView, BugReplayGateState, BugReplayRunView, BugReplaySnapshot } from '../../../shared/bugReplay';
import { taskManagerApi } from '../../api/taskManagerClient';
import { BugNowPanel, BugSection, useBugActions } from './BugSection';

vi.mock('../../api/taskManagerClient', () => ({ taskManagerApi: { allowBugReplayRuns: vi.fn(async () => undefined) } }));

const AT = '2026-10-18T10:00:00.000Z';

function bugCase(state: BugReplayGateState): BugCaseView {
  return {
    id: 'case-1',
    captureId: 'capture-1',
    title: 'Cart total should read "$45.00"',
    status: 'ACTIVE',
    keepBrowserStorage: false,
    gate: {
      caseId: 'case-1',
      title: 'Cart total should read "$45.00"',
      state,
      versionId: 'version-1',
      version: 1,
      baseline: { matched: 2, total: 2 },
      candidate: { passed: 2, total: 2 },
      updatedAt: AT
    },
    version: {
      id: 'version-1',
      version: 1,
      revisionKind: 'INITIAL',
      checks: [{
        id: 'check-1',
        statement: 'Cart total should read "$45.00"',
        inSignature: true,
        before: { held: false, value: '"$40.00"' },
        after: { held: true, value: '"$45.00"' }
      }],
      envFiles: [],
      protectedPaths: [],
      baselineTreeId: 'tree-0',
      alsoAfterReload: false
    },
    steps: [
      { kind: 'navigate', text: 'Open /cart' },
      { kind: 'fill', text: 'Fill "Coupon" with "SAVE5"' },
      { kind: 'click', text: 'Click "Apply coupon"' }
    ],
    screenshotFileIds: [],
    shots: {},
    actions: [],
    createdAt: AT
  };
}

function snapshot(view: BugCaseView, runs: BugReplayRunView[] = []): BugReplaySnapshot {
  return { taskId: 'task-1', availability: { canRecord: true }, runs, runCount: runs.length, earlierCases: [], storage: { usedBytes: 0, limitBytes: 1 }, activeCase: view };
}

function Section({ value }: { value: BugReplaySnapshot }) {
  const actions = useBugActions('task-1', value, { onOpenRecording: vi.fn(), onError: vi.fn() }, vi.fn());
  return <BugSection taskId="task-1" snapshot={value} actions={actions} onOpenRecording={vi.fn()} />;
}

function NowPanel({ value }: { value: BugReplaySnapshot }) {
  const actions = useBugActions('task-1', value, { onOpenRecording: vi.fn(), onError: vi.fn() }, vi.fn());
  return <BugNowPanel view={value.activeCase!} snapshot={value} actions={actions} />;
}

describe('A recorded bug on the Overview', () => {
  it('shows what each expectation showed before the fix and after it, and marks an After about earlier code', () => {
    const view = render(<Section value={snapshot(bugCase('FIX_VERIFIED'))} />);

    const table = screen.getAllByRole('table')[0];
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Expected', 'Before', 'After']);
    expect(within(table).getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
      'Cart total should read "$45.00"',
      'Did not hold"$40.00"',
      'Held"$45.00"'
    ]);

    // Code that changed after the verification leaves its result as context, never as the current verdict.
    view.rerender(<Section value={snapshot(bugCase('STALE'))} />);
    expect(within(screen.getAllByRole('table')[0]).getAllByRole('columnheader')[2].textContent).toBe('Afterearlier code');
  });

  it('opens a replay from its row with focus on it, marks the step it failed on, and gives focus back to the row on one Escape', async () => {
    const failed: BugReplayRunView = {
      id: 'run-2',
      kind: 'CANDIDATE',
      state: 'SETTLED',
      outcome: 'FAILED',
      counted: true,
      failure: { reason: 'STEP_FAILED', detail: 'Could not complete step 2: "Coupon" was not found', stepIndex: 1 },
      observations: [],
      facts: [],
      screenshotFileIds: [],
      treeId: 'tree-1',
      queuedAt: AT,
      startedAt: AT,
      settledAt: '2026-10-18T10:00:14.000Z'
    };
    render(<Section value={snapshot(bugCase('STILL_FAILING'), [failed])} />);

    fireEvent.click(screen.getByText('Replays'));
    const row = screen.getByRole('button', { name: 'After' });
    fireEvent.click(row);

    const drawer = await screen.findByRole('dialog', { name: 'Replay after the fix' });
    // Focus starts in the replay, never on its close button, whose tooltip would take the first Escape.
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
    expect(document.activeElement).not.toBe(within(drawer).getByRole('button', { name: 'Close replay' }));
    expect(within(drawer).getByText('Could not complete step 2: "Coupon" was not found')).toBeDefined();
    const steps = within(within(drawer).getByRole('region', { name: 'Steps' })).getAllByRole('listitem');
    expect(steps.map((step) => step.textContent)).toEqual([
      'Open /cart, Completed',
      'Fill "Coupon" with "SAVE5"Failed',
      'Click "Apply coupon", Pending'
    ]);

    fireEvent.keyDown(drawer, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(row);
  });

  it('asks to approve replays declining first and approving for now last, and keeps the approval only when asked to', async () => {
    const view = bugCase('VERIFYING');
    const waiting: BugCaseView = {
      ...view,
      gate: { ...view.gate, activeRun: { runId: 'run-3', kind: 'CANDIDATE', waitingFor: 'APPROVAL' } },
      actions: ['allow-runs', 'always-allow-runs', 'cancel-run', 'remove']
    };
    const approvalDigest = 'a'.repeat(64);
    render(<NowPanel value={{
      ...snapshot(waiting),
      pendingLease: { approvalDigest, title: 'Replays need approval', facts: [{ label: 'Runs as', value: 'Your user, without a sandbox' }], commands: [], sameAsRunningPreview: false }
    }} />);

    const decline = screen.getByRole('button', { name: 'Cancel replays' });
    const keep = screen.getByRole('button', { name: 'Always approve in this repository' });
    const approve = screen.getByRole('button', { name: 'Approve replays' });
    expect(decline.compareDocumentPosition(keep) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(keep.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(approve.className).toContain('primary-button');

    // Approving for now keeps nothing; keeping names the same sheet the person read.
    fireEvent.click(approve);
    await waitFor(() => expect(taskManagerApi.allowBugReplayRuns).toHaveBeenCalledWith({ taskId: 'task-1', approvalDigest, keep: false }));
    fireEvent.click(keep);
    await waitFor(() => expect(taskManagerApi.allowBugReplayRuns).toHaveBeenLastCalledWith({ taskId: 'task-1', approvalDigest, keep: true }));
  });
});
