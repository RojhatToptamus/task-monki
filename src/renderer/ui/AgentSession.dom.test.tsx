import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeRunRecord, makeTaskRecord } from '../../testSupport/rendererRecords';
import { AgentSession, type AgentSessionProps } from './AgentSession';

beforeEach(() => {
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
    expect(screen.queryByRole('option', { name: 'Send now' })).toBeNull();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Instruction' }), { key: 'Enter', ctrlKey: true });
    await screen.findByRole('alert');
    expect(input.onQueue).toHaveBeenCalledWith('run-1', 'Check the parser next.', expect.any(String));
    expect(input.onDraftChange).not.toHaveBeenCalled();
    view.rerender(<AgentSession {...input} steeringSupported />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Instruction delivery' }), { target: { value: 'STEER' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
    await waitFor(() => expect(input.onSteer).toHaveBeenCalledWith('run-1', 'Check the parser next.', expect.any(String)));
  });

  it('uses distinct continuation, retry and fork actions and keeps the selected action honest after a run transition', async () => {
    const failed = makeRunRecord({ status: 'FAILED' });
    const input = props({ run: failed, runs: [failed] });
    const view = render(<AgentSession {...input} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry implementation' }));
    await waitFor(() => expect(input.onRetry).toHaveBeenCalledWith('run-1', 'SAME_SESSION', 'Check the parser next.', expect.any(String)));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'CONTINUE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue work' }));
    await waitFor(() => expect(input.onContinue).toHaveBeenCalled());
    fireEvent.click(screen.getByText('More actions'));
    fireEvent.click(screen.getByRole('button', { name: 'Fork alternative' }));
    await waitFor(() => expect(input.onRetry).toHaveBeenCalledWith('run-1', 'FORK', 'Check the parser next.'));
    const running = makeRunRecord({ id: 'run-2', status: 'RUNNING' });
    view.rerender(<AgentSession {...input} run={running} runs={[failed, running]} />);
    expect(screen.getByRole('button', { name: 'Queue after run' })).toBeDefined();
  });

  it('retains one delivery ID for retries on the same turn and creates a new ID after that turn changes', async () => {
    const first = makeRunRecord({ status: 'FAILED' });
    const input = props({ run: first, runs: [first], onRetry: vi.fn().mockRejectedValue(new Error('Provider failed')) });
    const view = render(<AgentSession {...input} />);
    const send = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry implementation' }));
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
});
