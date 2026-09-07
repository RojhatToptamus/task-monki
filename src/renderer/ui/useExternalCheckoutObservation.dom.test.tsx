import { act, fireEvent, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useExternalCheckoutObservation } from './useExternalCheckoutObservation';

describe('external checkout observation', () => {
  it('observes only on open and focus, coalesces pending focus, and pauses for actions or dialogs', async () => {
    let finish!: () => void;
    let actionPending = false;
    const observe = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const refresh = vi.fn(async () => undefined);
    const input = { taskId: 'external', paused: true, observe, refresh, onError: vi.fn(), isActionPending: () => actionPending };
    const mounted = renderHook(useExternalCheckoutObservation, { initialProps: input });
    expect(observe).not.toHaveBeenCalled();
    mounted.rerender({ ...input, paused: false });
    expect(observe).toHaveBeenCalledOnce();
    fireEvent.focus(window);
    fireEvent.focus(window);
    expect(observe).toHaveBeenCalledOnce();
    await act(async () => finish());
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    mounted.rerender({ ...input, paused: false });
    expect(observe).toHaveBeenCalledOnce();
    actionPending = true;
    fireEvent.focus(window);
    expect(observe).toHaveBeenCalledOnce();
    actionPending = false;
    fireEvent.focus(window);
    expect(observe).toHaveBeenCalledTimes(2);
    mounted.unmount();
    await act(async () => finish());
    expect(refresh).toHaveBeenCalledOnce();
    fireEvent.focus(window);
    expect(observe).toHaveBeenCalledTimes(2);
  });

  it('does not apply an old task failure after selection changes', async () => {
    let fail!: (error: Error) => void;
    const observe = vi.fn((taskId: string) => taskId === 'old'
      ? new Promise<void>((_resolve, reject) => { fail = reject; }) : Promise.resolve());
    const refresh = vi.fn(async () => undefined);
    const onError = vi.fn();
    const input = { taskId: 'old', paused: false, observe, refresh, onError, isActionPending: () => false };
    const mounted = renderHook(useExternalCheckoutObservation, { initialProps: input });
    mounted.rerender({ ...input, taskId: 'new' });
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await act(async () => fail(new Error('Old checkout is missing.')));
    expect(onError).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
  });
});
