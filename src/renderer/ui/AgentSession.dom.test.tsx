import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgentItemRecord, makeRawMessage, makeRunRecord, makeTaskRecord } from '../../testSupport/rendererRecords';
import { AgentSession, type AgentSessionProps } from './AgentSession';

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduced-motion'), addEventListener() {}, removeEventListener() {} }));
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
function props(overrides: Partial<AgentSessionProps> = {}): AgentSessionProps {
  const run = makeRunRecord();
  return {
    attachments: [], onReadAttachment: vi.fn(), attachmentOptions: { enabled: true, onStageBatch: vi.fn(), onDiscard: vi.fn() },
    task: makeTaskRecord({ workflowPhase: 'IN_PROGRESS', currentRunId: run.id }), run, runs: [run], sessions: [],
    items: [], plans: [], interactions: [], instructions: [], requiresRecovery: false, steeringSupported: true,
    draft: 'Check the parser next.', onDraftChange: vi.fn(), onFlushDraft: vi.fn().mockResolvedValue(undefined),
    onQueue: vi.fn().mockResolvedValue(undefined), onEditQueue: vi.fn(), onSendQueue: vi.fn(),
    onSteer: vi.fn().mockResolvedValue(undefined), onContinue: vi.fn().mockResolvedValue(undefined),
    onRetry: vi.fn().mockResolvedValue(undefined), onStop: vi.fn(), onRespond: vi.fn(),
    onShowDebug: vi.fn(), onShowReview: vi.fn(), capture: () => null, attentionRequested: 0, ...overrides
  };
}

describe('Agent session interactions', () => {
  it('persists pasted files, prevents unsupported live steering, and retains files after a rejected queue send', async () => {
    const file = new File(['parser notes'], 'notes.txt', { type: 'text/plain' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('parser notes').buffer });
    const input = props({
      onQueue: vi.fn().mockRejectedValueOnce(new Error('Queue unavailable')).mockResolvedValue(undefined),
      attachmentOptions: {
        enabled: true, onDiscard: vi.fn(), onPersistDraft: vi.fn().mockResolvedValue(undefined),
        onStageBatch: vi.fn().mockResolvedValue({ id: 'draft-files', attachments: [], createdAt: '', updatedAt: '' })
      }
    });
    render(<AgentSession {...input} />);
    fireEvent.paste(screen.getByRole('textbox', { name: 'Instruction' }), {
      clipboardData: { getData: () => '', items: [{ kind: 'file', getAsFile: () => file }] }
    });
    await waitFor(() => expect(input.attachmentOptions.onPersistDraft).toHaveBeenCalledWith('draft-files'));
    expect(screen.getByText('notes.txt')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Instruction delivery' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Queue' }));
    await screen.findByText('Queue unavailable');
    expect(screen.getByRole('button', { name: 'Remove notes.txt' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Queue' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove notes.txt' })).toBeNull());
    expect(input.onQueue).toHaveBeenLastCalledWith('run-1', input.draft, expect.any(String), { attachmentDraftId: 'draft-files' });
    expect(input.attachmentOptions.onStageBatch).toHaveBeenCalledTimes(1);
  });

  it('queues by default, gates steering by capability, and preserves a draft after rejected delivery', async () => {
    const input = props({ steeringSupported: false, onQueue: vi.fn().mockRejectedValue(new Error('Run changed')) });
    const view = render(<AgentSession {...input} />);
    expect(screen.queryByRole('button', { name: 'Instruction delivery' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Instruction' }), { key: 'Enter', ctrlKey: true });
    await screen.findByRole('alert');
    expect(input.onQueue).toHaveBeenCalledWith('run-1', 'Check the parser next.', expect.any(String), undefined);
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
    await waitFor(() => expect(input.onRetry).toHaveBeenCalledWith('run-1', 'SAME_SESSION', 'Check the parser next.', expect.any(String), undefined));
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

  it('keeps a working indicator between provider events until the run ends', () => {
    const input = props({ items: [makeAgentItemRecord({ payload: { text: 'Checking the parser.' }, status: 'COMPLETED' })] });
    const view = render(<AgentSession {...input} />);
    expect(screen.getByRole('status').textContent).toBe('Working…');
    const tool = makeAgentItemRecord({ id: 'tool', type: 'COMMAND_EXECUTION', status: 'COMPLETED',
      createdAt: '2026-07-19T12:01:00Z', payload: { command: 'npm test' } });
    view.rerender(<AgentSession {...input} items={[...input.items, tool]} />);
    expect(screen.getByRole('status').textContent).toBe('Working…');
    const completed = { ...input.run!, status: 'COMPLETED' as const };
    view.rerender(<AgentSession {...input} run={completed} runs={[completed]} />);
    expect(screen.queryByText('Working…')).toBeNull();
  });

  it('keeps Queue visible while a run waits for approval and explains that the request must be answered first', () => {
    const run = makeRunRecord({ status: 'AWAITING_APPROVAL', providerTurnId: 'turn-1' });
    render(<AgentSession {...props({
      run, runs: [run], runtimeUnavailable: 'Live Codex is disabled for deterministic seed data.',
      interactions: [{
        id: 'interaction-1', runtimeId: 'codex', serverInstanceId: 'server-1', providerRequestId: 1,
        taskId: 'task-1', iterationId: 'iteration-1', runId: run.id, sessionId: 'session-1',
        type: 'COMMAND_APPROVAL', status: 'PENDING', request: { startedAtMs: Date.parse(run.startedAt), command: 'npm test' },
        allowedActions: ['ACCEPT', 'DECLINE'], policyWarnings: [],
        requestRawMessage: makeRawMessage(), requestedAt: run.startedAt
      }]
    })} />);
    const queue = screen.getByRole('button', { name: 'Queue' });
    expect(queue).toHaveProperty('disabled', true);
    expect(screen.getByText('Answer the agent request before sending an instruction.')).toBeTruthy();
    expect(screen.queryByText('Live Codex is disabled for deterministic seed data.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Stop' })).toHaveProperty('disabled', false);
  });

  it('edits the queue with keyboard save and cancel, retains a rejected edit, and returns focus without changing the composer draft', async () => {
    const input = props({ instructions: [{ id: 'instruction-1', taskId: 'task-1', iterationId: 'iteration-1',
      worktreeId: 'worktree-1', sessionId: 'session-1', sourceRunId: 'run-1', order: 1, text: 'Check the README.',
      mode: 'QUEUE', status: 'QUEUED', createdAt: '2026-10-03T12:00:00Z', updatedAt: '2026-10-03T12:00:00Z' }],
      onEditQueue: vi.fn().mockRejectedValueOnce(new Error('Could not save')).mockResolvedValue(undefined) });
    input.instructions.push({ ...input.instructions[0]!, id: 'instruction-2', order: 2, text: 'Run the tests.' });
    const view = render(<AgentSession {...input} />);
    fireEvent.click(screen.getAllByRole('button', { name: /^Edit/ })[0]!);
    expect(screen.getAllByRole('button', { name: /^Edit/ })[1]).toHaveProperty('disabled', true);
    const editor = screen.getByRole('textbox', { name: 'Edit queued instruction' });
    expect(document.activeElement).toBe(editor);
    fireEvent.change(editor, { target: { value: 'Check the README and script.' } });
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true, isComposing: true });
    expect(input.onEditQueue).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });
    await screen.findByRole('alert');
    expect((editor as HTMLTextAreaElement).value).toBe('Check the README and script.');
    const nextRun = makeRunRecord({ id: 'run-2' });
    view.rerender(<AgentSession {...input} run={nextRun} runs={[input.run!, nextRun]} />);
    expect(screen.getByRole('alert').textContent).toContain('Could not save');
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Edit queued instruction' })).toBeNull());
    const composer = screen.getByRole('textbox', { name: 'Instruction' });
    expect(document.activeElement).toBe(composer);
    expect(input.onEditQueue).toHaveBeenLastCalledWith('instruction-1', 'Check the README and script.', { attachmentIds: [], attachmentDraftId: undefined });
    expect(input.onDraftChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: /^Edit/ })[0]!);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Edit queued instruction' }), { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Edit queued instruction' })).toBeNull();
    expect(document.activeElement).toBe(composer);
    expect(input.onEditQueue).toHaveBeenCalledTimes(2);
  });


  it('follows output and viewport resizing only at the bottom and resumes with Jump to latest', async () => {
    const observed = new Map<Element, (entries: Array<{ contentRect: { height: number } }>) => void>();
    vi.stubGlobal('ResizeObserver', class {
      constructor(private readonly callback: (entries: Array<{ contentRect: { height: number } }>) => void) {}
      observe(target: Element) { observed.set(target, this.callback); }
      disconnect() {}
    });
    const input = props();
    render(<AgentSession {...input} />);
    const viewport = screen.getByLabelText('Session history');
    let height = 1000;
    let viewportHeight = 400;
    Object.defineProperties(viewport, { scrollHeight: { get: () => height }, clientHeight: { get: () => viewportHeight } });
    const resize = (next: number) => act(() => {
      viewportHeight = next;
      observed.get(viewport)?.([{ contentRect: { height: next } }]);
    });
    const grow = (next: number) => act(() => {
      height = next;
      const content = viewport.firstElementChild!;
      observed.get(content)?.([{ contentRect: { height: next } }]);
    });
    await grow(1000);
    await waitFor(() => expect(viewport.scrollTop).toBe(599));
    fireEvent.scroll(viewport);
    viewport.scrollTop = 300;
    fireEvent.scroll(viewport);
    const jump = await screen.findByRole('button', { name: 'Jump to latest' });
    await grow(1400);
    await resize(500);
    expect(viewport.scrollTop).toBe(300);
    await resize(400);
    expect(viewport.scrollTop).toBe(300);
    fireEvent.click(jump);
    await waitFor(() => expect(viewport.scrollTop).toBe(999));
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();
    await grow(1600);
    await waitFor(() => expect(viewport.scrollTop).toBe(1199));
    await resize(300);
    await waitFor(() => expect(viewport.scrollTop).toBe(1299));
  });

  it('marks a stale active plan step unfinished after the run completes without changing provider steps', () => {
    const run = makeRunRecord();
    const plan = { id: 'plan', taskId: 'task-1', iterationId: 'iteration-1', runId: run.id, sessionId: 'session-1', runtimeId: 'codex', revision: 1,
      steps: [{ step: 'Inspect the files', status: 'IN_PROGRESS' as const }], rawMessage: makeRawMessage(), observedAt: run.startedAt };
    const input = props({ plans: [plan] });
    const view = render(<AgentSession {...input} />);
    expect(screen.getByRole('listitem', { name: 'In progress: Inspect the files' })).toBeTruthy();
    const completed = { ...run, status: 'COMPLETED' as const };
    view.rerender(<AgentSession {...input} run={completed} runs={[completed]} />);
    expect(screen.getByRole('listitem', { name: 'Unfinished: Inspect the files' })).toBeTruthy();
    expect(plan.steps[0].status).toBe('IN_PROGRESS');
  });

  it('opens live reasoning while it streams and collapses it when the run finishes', () => {
    const run = makeRunRecord();
    const item = makeAgentItemRecord({
      type: 'REASONING_SUMMARY',
      status: 'IN_PROGRESS',
      payload: { text: 'Checking the parser first.' }
    });
    const input = props({ items: [item] });
    const view = render(<AgentSession {...input} />);
    expect(screen.getByText('Checking the parser first.')).toBeTruthy();
    const completed = { ...run, status: 'COMPLETED' as const };
    view.rerender(<AgentSession {...input} run={completed} runs={[completed]} />);
    expect(screen.queryByText('Checking the parser first.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Reasoning|Thought/ }));
    expect(screen.getByText('Checking the parser first.')).toBeTruthy();
  });

  it('reveals the stored command and permission error instead of an empty failed-tool disclosure', () => {
    const completed = makeRunRecord({ status: 'COMPLETED' });
    const item = makeAgentItemRecord({ type: 'COMMAND_EXECUTION', status: 'FAILED', payload: {
      tool: 'bash', state: { status: 'error', input: { command: 'sleep 90' }, error: 'Permission was declined.' }
    } });
    render(<AgentSession {...props({ run: completed, runs: [completed], items: [item] })} />);
    const step = screen.getByRole('button', { name: /Command failed.*sleep 90/ });
    expect(screen.queryByText('Permission was declined.')).toBeNull();
    fireEvent.click(step);
    expect(step.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Permission was declined.')).toBeTruthy();
    expect(screen.queryByText('Working…')).toBeNull();
    expect(item.status).toBe('FAILED');
  });

  it('opens history with the original request and prepends bounded history without moving the reader', () => {
    const first = makeRunRecord({ id: 'first', status: 'COMPLETED', startedAt: '2026-07-18T12:00:00Z', finalMessage: 'First response.' });
    const input = props();
    const items = Array.from({ length: 100 }, (_, index) => makeAgentItemRecord({
      id: `message-${index}`, type: 'AGENT_MESSAGE', payload: { text: `Response number ${index}` },
      createdAt: new Date(Date.UTC(2026, 6, 19, 12, index)).toISOString()
    }));
    render(<AgentSession {...input} runs={[first, input.run!]} items={items} />);
    expect(screen.queryByText(input.task.prompt)).toBeNull();
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
    expect(screen.getByText(input.task.prompt)).toBeTruthy();
    expect(screen.getByText('Response number 0')).toBeTruthy();
    expect(viewport.scrollTop).toBe(750);
    expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull();
  });

});
