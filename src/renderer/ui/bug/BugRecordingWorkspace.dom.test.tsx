import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BugCaptureView, BugRecordingSessionView } from '../../../shared/bugReplay';
import { taskManagerApi } from '../../api/taskManagerClient';
import { BugRecordingWorkspace } from './BugRecordingWorkspace';

vi.mock('../../api/taskManagerClient', () => ({
  taskManagerApi: {
    markBug: vi.fn(async () => undefined),
    startBugRecording: vi.fn(async () => undefined),
    chooseBugEnvFiles: vi.fn(async () => undefined),
    stopBugPick: vi.fn(async () => undefined),
    returnToBugRecording: vi.fn(async () => undefined),
    cancelBugRecording: vi.fn(async () => undefined),
    previewBugCapture: vi.fn(async () => ({ draftRevision: 1, reproducible: false, reason: 'Mark the bug first.', checks: [], valueRows: [] }))
  }
}));

const capture: BugCaptureView = {
  draftRevision: 1,
  picks: [],
  requests: [],
  valueRows: [],
  otherRequests: [],
  pageErrors: [],
  uncaughtError: false,
  stepCount: 1,
  steps: [{ kind: 'navigate', text: 'Open /' }],
  suggestedTitle: ''
};

function recording(overrides: Partial<BugRecordingSessionView>): BugRecordingSessionView {
  return { sessionId: 'session-1', runId: 'run-1', phase: 'CHECKING', detail: 'Copying source', startedAt: new Date().toISOString(), ...overrides };
}

function workspace(view: BugRecordingSessionView) {
  return <BugRecordingWorkspace taskId="task-1" recording={view} covered={false} onSaved={vi.fn()} />;
}

describe('Recording a bug', () => {
  it('proposes the ignored env files Task Monki found once they arrive, and sends that choice', async () => {
    // The workspace opens while the copy is checked; the files are found afterwards.
    const view = render(workspace(recording({})));
    view.rerender(workspace(recording({
      phase: 'CHOOSING_ENV_FILES',
      detail: undefined,
      envFiles: [{ name: '.env', directory: '.', include: true }, { name: '.env.local', directory: '.', include: false }]
    })));

    expect((screen.getByRole('checkbox', { name: '.env' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('checkbox', { name: '.env.local' }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Start the app' }));

    await waitFor(() => expect(taskManagerApi.chooseBugEnvFiles).toHaveBeenCalledWith({ taskId: 'task-1', sessionId: 'session-1', include: ['.env'] }));
  });

  it('never leaves the person stuck while the page waits for a click', async () => {
    render(workspace(recording({ phase: 'MARKING', detail: 'Point at what is wrong', capture })));

    expect(screen.getByText("Point at what's wrong")).toBeDefined();
    expect((screen.getByRole('button', { name: 'Back to recording' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Discard' }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Stop pointing' }));
    await waitFor(() => expect(taskManagerApi.stopBugPick).toHaveBeenCalledWith({ taskId: 'task-1', sessionId: 'session-1' }));

    // Escape works too: the page itself rarely has the keyboard.
    vi.mocked(taskManagerApi.stopBugPick).mockClear();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(taskManagerApi.stopBugPick).toHaveBeenCalledTimes(1));
  });

  it('says a failed step under its head, where the page cannot cover it, and forgets it on the next step', async () => {
    vi.mocked(taskManagerApi.markBug).mockRejectedValueOnce(new Error('The page did not answer.'));
    const view = render(workspace(recording({ phase: 'RECORDING', detail: undefined, recordingStartedAt: new Date().toISOString() })));

    fireEvent.click(screen.getByRole('button', { name: 'Mark bug' }));

    expect((await screen.findByRole('alert')).textContent).toBe('The page did not answer.');
    view.rerender(workspace(recording({ phase: 'MARKING', detail: undefined, capture })));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps focus on a control that stays: Stop pointing while the page waits, the bug’s name after, Mark bug on return', () => {
    const started = new Date().toISOString();
    const view = render(workspace(recording({ phase: 'RECORDING', detail: undefined, recordingStartedAt: started })));

    // Marking starts with the page waiting for a pick; the fields are locked until it arrives.
    view.rerender(workspace(recording({ phase: 'MARKING', detail: 'Point at what is wrong', capture, recordingStartedAt: started })));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Stop pointing' }));

    view.rerender(workspace(recording({ phase: 'RECORDING', detail: undefined, recordingStartedAt: started })));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Mark bug' }));

    // Marked without pointing, the bug's name is the next thing to write.
    view.rerender(workspace(recording({ phase: 'MARKING', detail: undefined, capture, recordingStartedAt: started })));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Bug' }));
  });

  it('offers a stopped recording’s steps alone, or a new recording, from one place', () => {
    render(workspace(recording({
      phase: 'INTERRUPTED',
      detail: undefined,
      capture: { ...capture, partial: 'Recording stopped early: the app stopped' },
      failure: { title: 'The app stopped', detail: 'The steps up to that point are kept.', action: 'record-again' }
    })));

    expect(screen.getByRole('status').textContent).toBe('Recording stopped');
    const again = screen.getByRole('button', { name: 'Record again' });
    const keep = screen.getByRole('button', { name: 'Save steps only' });
    // Recording again comes first; keeping the steps is the primary choice, last.
    expect(again.compareDocumentPosition(keep) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(keep.className).toContain('primary-button');
    fireEvent.click(again);
    expect(taskManagerApi.startBugRecording).toHaveBeenCalledTimes(1);
  });

  it('asks before discarding what was recorded', async () => {
    render(workspace(recording({ phase: 'RECORDING', detail: undefined, recordingStartedAt: new Date().toISOString() })));

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Keep recording' }));
    expect(taskManagerApi.cancelBugRecording).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Discard recording' }));
    await waitFor(() => expect(taskManagerApi.cancelBugRecording).toHaveBeenCalledWith({ taskId: 'task-1', sessionId: 'session-1' }));
  });
});
