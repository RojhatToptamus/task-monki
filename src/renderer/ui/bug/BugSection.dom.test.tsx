import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BugCaseView, BugExpectationsDraft, BugReplayGateState, BugReplayRunView, BugReplaySnapshot } from '../../../shared/bugReplay';
import { taskManagerApi } from '../../api/taskManagerClient';
import { BugNowPanel, BugSection, useBugActions } from './BugSection';

vi.mock('../../api/taskManagerClient', () => ({
  taskManagerApi: { allowBugReplayRuns: vi.fn(async () => undefined), previewBugExpectations: vi.fn(), saveBugExpectations: vi.fn() }
}));

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
      expectations: [{
        kind: 'element',
        id: 'check-1',
        name: 'Cart total',
        recorded: 'Showed "$40.00"',
        template: 'equals',
        expected: '$45.00',
        alsoAfterReload: false,
        field: false
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

/** The Overview's Bug section with its dialogs, as the task page mounts them: inert while one is open. */
function Section({ value }: { value: BugReplaySnapshot }) {
  const actions = useBugActions('task-1', value, { onOpenRecording: vi.fn(), onError: vi.fn() }, vi.fn());
  return (
    <>
      <main inert={actions.modalOpen ? true : undefined}>
        <BugSection taskId="task-1" snapshot={value} actions={actions} onOpenRecording={vi.fn()} />
      </main>
      {actions.dialogs}
    </>
  );
}

function NowPanel({ value }: { value: BugReplaySnapshot }) {
  const actions = useBugActions('task-1', value, { onOpenRecording: vi.fn(), onError: vi.fn() }, vi.fn());
  return <BugNowPanel view={value.activeCase!} snapshot={value} actions={actions} />;
}

describe('A recorded bug on the Overview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
    // The page behind the drawer takes no keys or reading while it is open.
    expect(document.querySelector('main')!.hasAttribute('inert')).toBe(true);
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
    expect(document.querySelector('main')!.hasAttribute('inert')).toBe(false);
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

    // Approving for now keeps nothing; keeping names the same sheet the person read.
    fireEvent.click(approve);
    await waitFor(() => expect(taskManagerApi.allowBugReplayRuns).toHaveBeenCalledWith({ taskId: 'task-1', approvalDigest, keep: false }));
    fireEvent.click(keep);
    await waitFor(() => expect(taskManagerApi.allowBugReplayRuns).toHaveBeenLastCalledWith({ taskId: 'task-1', approvalDigest, keep: true }));
  });

  it('changes an expectation from the bug’s menu, refusing a value the recording already shows, and saves it as the next version', async () => {
    const previewBugExpectations = vi.mocked(taskManagerApi.previewBugExpectations).mockImplementation(async ({ draft }: { draft: BugExpectationsDraft }) => {
      const edit = draft.expectations[0];
      return edit?.kind === 'element' && edit.expected === '$40.00'
        ? { versionId: 'version-1', changed: true, reproducible: false, reason: 'Cart total matches the recording', checks: [] }
        : { versionId: 'version-1', changed: true, reproducible: true, checks: [] };
    });
    const saveBugExpectations = vi.mocked(taskManagerApi.saveBugExpectations).mockImplementation(async () => snapshot(bugCase('REPRODUCING')));
    render(<Section value={snapshot({ ...bugCase('FIX_VERIFIED'), actions: ['verify-again', 'edit-expectations', 'remove'] })} />);

    const trigger = screen.getByRole('button', { name: 'More bug actions' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Edit expectations' }));

    const drawer = await screen.findByRole('dialog', { name: 'Edit expectations' });
    const value = within(drawer).getByRole('textbox', { name: 'What Cart total should read' });
    // A form: focus starts on the value to change, beside what the recording showed.
    await waitFor(() => expect(document.activeElement).toBe(value));
    expect(within(drawer).getByText('Showed "$40.00"')).toBeDefined();
    // Nothing changed yet: Save waits, with nothing to explain.
    const save = within(drawer).getByRole('button', { name: 'Save and reproduce' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.getAttribute('aria-describedby')).toBeNull();

    // A value the recording already shows describes no bug: the reason stands beside Save.
    fireEvent.change(value, { target: { value: '$40.00' } });
    await waitFor(() => expect(document.getElementById(save.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Cart total matches the recording'));
    expect(save.disabled).toBe(true);

    fireEvent.change(value, { target: { value: '$46.00' } });
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(saveBugExpectations).toHaveBeenCalledWith({
      taskId: 'task-1',
      draft: { versionId: 'version-1', expectations: [{ kind: 'element', id: 'check-1', template: 'equals', expected: '$46.00', alsoAfterReload: false }] }
    });
  });

  it('keeps focus in the list when a row goes, and states a refused save where it was asked', async () => {
    const previewBugExpectations = vi.mocked(taskManagerApi.previewBugExpectations).mockImplementation(async () => ({ versionId: 'version-1', changed: true, reproducible: true, checks: [] }));
    const saveBugExpectations = vi.mocked(taskManagerApi.saveBugExpectations).mockImplementation(async () => {
      throw new Error('The expectations changed after they were shown. Review them again.');
    });
    const view = bugCase('REPRODUCED');
    view.actions = ['edit-expectations', 'remove'];
    view.version!.expectations.push({
      kind: 'request',
      name: 'POST /api/coupons/apply',
      recorded: '200',
      failed: false,
      write: true,
      status: { id: 'check-2', check: 'answered' },
      sentOnceId: 'check-3',
      valueIds: []
    });
    render(<Section value={snapshot(view)} />);
    const trigger = screen.getByRole('button', { name: 'More bug actions' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Edit expectations' }));
    const drawer = await screen.findByRole('dialog', { name: 'Edit expectations' });
    await waitFor(() => expect(document.activeElement).toBe(within(drawer).getByRole('textbox', { name: 'What Cart total should read' })));

    // Removing a row from the keyboard leaves focus on the row that takes its place.
    const remove = within(drawer).getByRole('button', { name: 'Remove the expectation on Cart total' });
    remove.focus();
    fireEvent.click(remove);
    await waitFor(() => expect(document.activeElement).toBe(within(drawer).getByRole('button', { name: 'Remove the expectations on POST /api/coupons/apply' })));

    const save = within(drawer).getByRole('button', { name: 'Save and reproduce' }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(document.getElementById(save.getAttribute('aria-describedby') ?? '')?.textContent).toBe('The expectations changed after they were shown. Review them again'));
    expect(screen.getByRole('dialog', { name: 'Edit expectations' })).toBe(drawer);
    expect(saveBugExpectations).toHaveBeenCalledWith({ taskId: 'task-1', draft: { versionId: 'version-1', expectations: [{ kind: 'status', id: 'check-2', check: 'answered' }, { kind: 'keep', id: 'check-3' }] } });
  });

  it('reads a replay of replaced expectations as earlier context, against the expectations it checked', async () => {
    const changed: BugCaseView = {
      ...bugCase('REPRODUCING'),
      version: { ...bugCase('REPRODUCING').version!, id: 'version-2', version: 2, revisionKind: 'EXPECTATION_CHANGED', checks: [{ id: 'check-1', statement: 'Cart total should read "$46.00"', inSignature: true, before: { held: false, value: '"$40.00"' } }] },
      earlierVersions: [{ id: 'version-1', version: 1, checks: [{ id: 'check-1', statement: 'Cart total should read "$45.00"' }] }]
    };
    const passed: BugReplayRunView = {
      id: 'run-1',
      kind: 'CANDIDATE',
      versionId: 'version-1',
      state: 'SETTLED',
      outcome: 'PASSED',
      counted: true,
      observations: [{ assertionId: 'check-1', passed: true, observed: 'Cart total showed "$45.00"', value: '"$45.00"' }],
      facts: [],
      screenshotFileIds: [],
      treeId: 'tree-1',
      queuedAt: AT,
      startedAt: AT,
      settledAt: '2026-10-18T10:00:14.000Z'
    };
    render(<Section value={snapshot(changed, [passed])} />);

    // Its result is no verdict: the current expectation has no After yet.
    expect(within(screen.getAllByRole('table')[0]).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Expected', 'Before']);
    fireEvent.click(screen.getByText('Replays'));
    const row = screen.getByRole('button', { name: 'After' }).closest('tr')!;
    expect(row.textContent).toContain('earlier expectations');

    fireEvent.click(screen.getByRole('button', { name: 'After' }));
    const drawer = await screen.findByRole('dialog', { name: 'Replay after the fix' });
    const results = within(drawer).getByRole('region', { name: 'Earlier expectations' });
    expect(results.textContent).toContain('Cart total should read "$45.00"');
    expect(results.textContent).not.toContain('$46.00');
  });
});
