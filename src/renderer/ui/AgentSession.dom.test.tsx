import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgentItemRecord, makeRawMessage, makeRunRecord, makeTaskRecord } from '../../testSupport/rendererRecords';
import { AgentSession, type AgentSessionProps } from './AgentSession';

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
function props(overrides: Partial<AgentSessionProps> = {}): AgentSessionProps {
  const run = makeRunRecord();
  return {
    task: makeTaskRecord({ workflowPhase: 'IN_PROGRESS', currentRunId: run.id }), run, runs: [run], sessions: [],
    items: [], plans: [], interactions: [], instructions: [], requiresRecovery: false, steeringSupported: true,
    draft: 'Check the parser next.', onDraftChange: vi.fn(), onFlushDraft: vi.fn().mockResolvedValue(undefined),
    onQueue: vi.fn().mockResolvedValue(undefined), onEditQueue: vi.fn(), onSendQueue: vi.fn(),
    onSteer: vi.fn().mockResolvedValue(undefined), onContinue: vi.fn().mockResolvedValue(undefined),
    onRetry: vi.fn().mockResolvedValue(undefined), onStop: vi.fn(), onRespond: vi.fn(),
    onShowDebug: vi.fn(), onShowReview: vi.fn(), request: <p>Request</p>, preRunAction: null,
    capture: () => null, attentionRequested: 0, ...overrides
  };
}

describe('Agent session interactions', () => {
  it('queues by default, gates steering by capability, and preserves a draft after rejected delivery', async () => {
    const input = props({ steeringSupported: false, onQueue: vi.fn().mockRejectedValue(new Error('Run changed')) });
    const view = render(<AgentSession {...input} />);
    expect(screen.queryByRole('button', { name: 'Instruction delivery' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Instruction' }), { key: 'Enter', ctrlKey: true });
    await screen.findByRole('alert');
    expect(input.onQueue).toHaveBeenCalledWith('run-1', 'Check the parser next.', expect.any(String));
    expect(input.onDraftChange).not.toHaveBeenCalled();
    view.rerender(<AgentSession {...input} steeringSupported />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Instruction delivery' }), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Send now' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
    await waitFor(() => expect(input.onSteer).toHaveBeenCalledWith('run-1', 'Check the parser next.', expect.any(String)));
  });

  it('uses distinct continuation, retry and fork actions and keeps the selected action honest after a run transition', async () => {
    const failed = makeRunRecord({ status: 'FAILED' });
    const input = props({ run: failed, runs: [failed] });
    const view = render(<AgentSession {...input} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(input.onRetry).toHaveBeenCalledWith('run-1', 'SAME_SESSION', 'Check the parser next.', expect.any(String)));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Instruction delivery' }), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(input.onContinue).toHaveBeenCalled());
    fireEvent.keyDown(screen.getByRole('button', { name: 'More session actions' }), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fork alternative' }));
    await waitFor(() => expect(input.onRetry).toHaveBeenCalledWith('run-1', 'FORK', 'Check the parser next.'));
    const running = makeRunRecord({ id: 'run-2', status: 'RUNNING' });
    view.rerender(<AgentSession {...input} run={running} runs={[failed, running]} />);
    expect(screen.getByRole('button', { name: 'Queue' })).toBeDefined();
  });

  it('retains one delivery ID for retries on the same turn and creates a new ID after that turn changes', async () => {
    const first = makeRunRecord({ status: 'FAILED' });
    const input = props({ run: first, runs: [first], onRetry: vi.fn().mockRejectedValue(new Error('Provider failed')) });
    const view = render(<AgentSession {...input} />);
    const send = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await screen.findByRole('alert');
    };
    await send();
    const id = vi.mocked(input.onRetry).mock.calls[0]![3];
    await send();
    expect(vi.mocked(input.onRetry).mock.calls[1]![3]).toBe(id);
    const second = makeRunRecord({ id: 'failed-second', status: 'FAILED' });
    view.rerender(<AgentSession {...input} run={second} runs={[first, second]} />);
    expect(screen.queryByRole('alert')).toBeNull();
    await send();
    expect(vi.mocked(input.onRetry).mock.calls[2]![3]).not.toBe(id);
  });

  it('does not double-submit a pending instruction and ignores the submit shortcut during IME composition', async () => {
    let release!: () => void;
    const queued = new Promise<void>((resolve) => { release = resolve; });
    const input = props({ onQueue: vi.fn(() => queued) });
    function Editor() {
      const [draft, setDraft] = useState(input.draft);
      return <AgentSession {...input} draft={draft} onDraftChange={setDraft} />;
    }
    render(<Editor />);
    const field = screen.getByRole('textbox', { name: 'Instruction' });
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true, isComposing: true });
    expect(input.onQueue).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(input.onQueue).toHaveBeenCalledTimes(1));
    release();
    await waitFor(() => expect((field as HTMLTextAreaElement).value).toBe(''));
    expect(document.activeElement).toBe(field);
  });

  it('edits the queue with keyboard save and cancel, retains a rejected edit, and returns focus without changing the composer draft', async () => {
    const input = props({ instructions: [{ id: 'instruction-1', taskId: 'task-1', iterationId: 'iteration-1',
      worktreeId: 'worktree-1', sessionId: 'session-1', sourceRunId: 'run-1', order: 1, text: 'Check the README.',
      mode: 'QUEUE', status: 'QUEUED', createdAt: '2026-10-03T12:00:00Z', updatedAt: '2026-10-03T12:00:00Z' }],
      onEditQueue: vi.fn().mockRejectedValueOnce(new Error('Could not save')).mockResolvedValue(undefined) });
    render(<AgentSession {...input} />);
    fireEvent.click(screen.getByRole('button', { name: /^Edit/ }));
    const editor = screen.getByRole('textbox', { name: 'Edit queued instruction' });
    expect(document.activeElement).toBe(editor);
    fireEvent.change(editor, { target: { value: 'Check the README and script.' } });
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true, isComposing: true });
    expect(input.onEditQueue).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });
    await screen.findByRole('alert');
    expect((editor as HTMLTextAreaElement).value).toBe('Check the README and script.');
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Edit queued instruction' })).toBeNull());
    const composer = screen.getByRole('textbox', { name: 'Instruction' });
    expect(document.activeElement).toBe(composer);
    expect(input.onEditQueue).toHaveBeenLastCalledWith('instruction-1', 'Check the README and script.');
    expect(input.onDraftChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^Edit/ }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Edit queued instruction' }), { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Edit queued instruction' })).toBeNull();
    expect(document.activeElement).toBe(composer);
    expect(input.onEditQueue).toHaveBeenCalledTimes(2);
  });


  it('keeps the reading position while output grows until the reader chooses Jump to latest', () => {
    let resize!: () => void;
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback; }
      observe() {} disconnect() {}
    });
    const earlier = makeRunRecord({ id: 'earlier', status: 'COMPLETED', startedAt: '2026-07-18T12:00:00Z' });
    const input = props();
    render(<AgentSession {...input} runs={[earlier, input.run!]} />);
    const history = screen.getByLabelText('Session history');
    Object.defineProperties(history, { scrollHeight: { value: 1000 }, clientHeight: { value: 400 } });
    history.scrollTop = 300;
    fireEvent.scroll(history);
    resize();
    expect(history.scrollTop).toBe(300);
    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }));
    expect(history.scrollTop).toBe(1000);
  });

  it('marks a stale active plan step unfinished after the run completes without changing provider steps', () => {
    const run = makeRunRecord();
    const plan = { id: 'plan', taskId: 'task-1', iterationId: 'iteration-1', runId: run.id, sessionId: 'session-1', runtimeId: 'codex', revision: 1,
      steps: [{ step: 'Inspect the files', status: 'IN_PROGRESS' as const }], rawMessage: makeRawMessage(), observedAt: run.startedAt };
    const input = props({ plans: [plan] });
    const view = render(<AgentSession {...input} />);
    fireEvent.click(screen.getByText('Plan'));
    expect(screen.getByRole('listitem', { name: 'In progress: Inspect the files' })).toBeTruthy();
    const completed = { ...run, status: 'COMPLETED' as const };
    view.rerender(<AgentSession {...input} run={completed} runs={[completed]} />);
    expect(screen.getByRole('listitem', { name: 'Unfinished: Inspect the files' })).toBeTruthy();
    expect(plan.steps[0].status).toBe('IN_PROGRESS');
  });

  it('reveals the stored command and permission error instead of an empty failed-tool disclosure', () => {
    const completed = makeRunRecord({ status: 'COMPLETED' });
    const item = makeAgentItemRecord({ type: 'COMMAND_EXECUTION', status: 'FAILED', payload: {
      tool: 'bash', state: { status: 'error', input: { command: 'sleep 90' }, error: 'Permission was declined.' }
    } });
    render(<AgentSession {...props({ run: completed, runs: [completed], items: [item] })} />);
    const summary = screen.getByText('Failed').closest('summary')!;
    fireEvent.click(summary);
    expect(summary.parentElement?.hasAttribute('open')).toBe(true);
    expect(screen.getByText('Permission was declined.')).toBeTruthy();
    expect(screen.queryByText('Working…')).toBeNull();
    expect(item.status).toBe('FAILED');
  });

  it('shows exchanges without opening runs and prepends bounded history without moving the reader', () => {
    const first = makeRunRecord({ id: 'first', status: 'COMPLETED', startedAt: '2026-07-18T12:00:00Z', finalMessage: 'First response.' });
    const input = props();
    const items = Array.from({ length: 100 }, (_, index) => makeAgentItemRecord({
      id: `message-${index}`, type: 'AGENT_MESSAGE', payload: { text: `Response number ${index}` },
      createdAt: new Date(Date.UTC(2026, 6, 19, 12, index)).toISOString()
    }));
    render(<AgentSession {...input} runs={[first, input.run!]} items={items} />);
    expect(screen.getByText(input.task.prompt)).toBeTruthy();
    expect(screen.queryByText('First response.')).toBeNull();
    expect(screen.getByText('Response number 99')).toBeTruthy();
    expect(screen.queryByText('Response number 0')).toBeNull();
    const viewport = screen.getByLabelText('Session history');
    Object.defineProperties(viewport, { scrollHeight: { get: () => screen.queryByText('First response.') ? 1600 : 1000 }, clientHeight: { value: 400 } });
    viewport.scrollTop = 150;
    fireEvent.scroll(viewport);
    // The earlier messages add 600px above the same text the reader was viewing.
    const load = screen.getByRole('button', { name: 'Load earlier messages' });
    fireEvent.click(load);
    expect(screen.getByText('First response.')).toBeTruthy();
    expect(screen.getByText('Response number 0')).toBeTruthy();
    expect(viewport.scrollTop).toBe(750);
    expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull();
  });

});
