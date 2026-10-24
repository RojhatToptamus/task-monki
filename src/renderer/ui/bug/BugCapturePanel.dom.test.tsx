import { createRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BugCapturePickView, BugCaptureView, BugRecordingSessionView } from '../../../shared/bugReplay';
import { taskManagerApi } from '../../api/taskManagerClient';
import { BugCapturePanel } from './BugCapturePanel';

vi.mock('../../api/taskManagerClient', () => ({
  taskManagerApi: {
    previewBugCapture: vi.fn(async () => ({ draftRevision: 1, reproducible: true, checks: [], valueRows: [] })),
    saveBugCapture: vi.fn(async () => undefined),
    pickBugCheck: vi.fn(async () => undefined),
    stopBugPick: vi.fn(async () => undefined)
  }
}));

function pick(index: number, label: string, text: string): BugCapturePickView {
  return {
    index,
    label,
    text,
    visible: true,
    count: 1,
    volatileTokens: [],
    target: { tag: 'span', testIds: [], text, css: `#pick-${index}` }
  };
}

function capture(picks: BugCapturePickView[], draftRevision: number): BugCaptureView {
  return {
    draftRevision,
    picks,
    requests: [],
    valueRows: [],
    otherRequests: [],
    pageErrors: [],
    uncaughtError: false,
    stepCount: 2,
    steps: [{ kind: 'navigate', text: 'Open /cart' }, { kind: 'click', text: 'Click "Apply coupon"' }],
    suggestedTitle: ''
  };
}

const recording: BugRecordingSessionView = { sessionId: 'session-1', runId: 'run-1', phase: 'MARKING', startedAt: '2026-10-18T10:00:00.000Z' };

function panel(view: BugCaptureView, picking = false, pointRef = createRef<HTMLButtonElement>()) {
  return <BugCapturePanel taskId="task-1" recording={recording} capture={view} picking={picking} pointRef={pointRef} onError={vi.fn()} onSaved={vi.fn()} />;
}

const nameField = () => screen.getByRole('textbox', { name: 'Bug' }) as HTMLInputElement;
const settle = () => act(async () => {
  vi.advanceTimersByTime(300);
});

describe('Marking a bug', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(taskManagerApi.previewBugCapture).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps an expectation the person removed removed when they point at another element, and readies the new value to be typed over', async () => {
    const total = pick(0, 'Cart total', '$40.00');
    const view = render(panel(capture([total], 1)));
    await settle();

    // Until the person names the bug, its name follows the first expectation.
    expect(nameField().value).toBe('Cart total shows "$40.00"');
    fireEvent.change(screen.getByRole('textbox', { name: 'What Cart total should read' }), { target: { value: '$45.00' } });
    expect(nameField().value).toBe('Cart total should read "$45.00"');

    fireEvent.click(screen.getByRole('button', { name: 'Remove the expectation on Cart total' }));
    view.rerender(panel(capture([total, pick(1, 'Discount', '-$5.00')], 2)));
    await settle();

    expect(screen.queryByRole('textbox', { name: 'What Cart total should read' })).toBeNull();
    const discount = screen.getByRole('textbox', { name: 'What Discount should read' }) as HTMLInputElement;
    expect(document.activeElement).toBe(discount);
    expect([discount.selectionStart, discount.selectionEnd]).toEqual([0, '-$5.00'.length]);
    expect(nameField().value).toBe('Discount shows "-$5.00"');

    // A name the person wrote is theirs: later expectations leave it alone.
    fireEvent.change(nameField(), { target: { value: 'Coupon is applied twice' } });
    fireEvent.change(discount, { target: { value: '-$10.00' } });
    expect(nameField().value).toBe('Coupon is applied twice');
  });

  it('keeps the name following the expectations when the panel mounts again, until the person writes one', async () => {
    const total = pick(0, 'Cart total', '$40.00');
    // Pointing stored a draft before anything was picked; switching tabs mounts the panel again.
    const pointed = { title: '', checks: [], requestRules: [], valueChecks: [], picksSeen: 0 };
    const view = render(panel({ ...capture([], 1), draft: pointed }));
    view.rerender(panel({ ...capture([total], 2), draft: pointed }));
    await settle();
    expect(nameField().value).toBe('Cart total shows "$40.00"');
    view.unmount();

    // A name the person wrote survives the remount and later expectations.
    const named = { ...pointed, title: 'Coupon is applied twice', checks: [{ pickIndex: 0, template: 'equals' as const, expected: '$45.00', alsoAfterReload: false }], picksSeen: 1 };
    const again = render(panel({ ...capture([total], 2), draft: named }));
    again.rerender(panel({ ...capture([total, pick(1, 'Discount', '-$5.00')], 3), draft: named }));
    await settle();
    expect(nameField().value).toBe('Coupon is applied twice');
  });

  it('keeps the save steady while the bug is named, and sends the name and notes so a remount keeps them', async () => {
    render(panel(capture([pick(0, 'Cart total', '$40.00')], 1)));
    await settle();
    const reproduce = screen.getByRole('button', { name: 'Save and reproduce' }) as HTMLButtonElement;
    expect(reproduce.disabled).toBe(false);

    fireEvent.change(nameField(), { target: { value: 'Coupon total is wrong' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Notes' }), { target: { value: 'SAVE5 takes $5 off a $50 cart.' } });
    // The last verdict stands while the next one is on its way.
    expect(reproduce.disabled).toBe(false);
    await settle();
    expect(reproduce.disabled).toBe(false);
    expect(vi.mocked(taskManagerApi.previewBugCapture).mock.lastCall?.[0].draft).toMatchObject({
      title: 'Coupon total is wrong',
      statement: 'SAVE5 takes $5 off a $50 cart.',
      checks: [{ pickIndex: 0, template: 'equals', expected: '$40.00' }]
    });
  });

  it('says why a stopped recording cannot be saved yet, and not again what stopped it', async () => {
    const stopped = { ...capture([], 1), partial: 'Recording stopped early: the app service stopped' };
    render(<BugCapturePanel taskId="task-1" recording={{ ...recording, phase: 'INTERRUPTED' }} capture={stopped} picking={false} onError={vi.fn()} onSaved={vi.fn()} />);
    await settle();
    const save = screen.getByRole('button', { name: 'Save steps only' }) as HTMLButtonElement;
    const description = () => document.getElementById(save.getAttribute('aria-describedby') ?? '')?.textContent;

    expect(save.disabled).toBe(true);
    expect(description()).toBe('Name the bug first');

    fireEvent.change(nameField(), { target: { value: 'Checkout stops' } });
    expect(save.disabled).toBe(false);
    // What stopped the recording is said where the page was.
    expect(save.getAttribute('aria-describedby')).toBeNull();
  });

  it('never lets a request row empty itself: Sent once stays while the status is Any', async () => {
    const write = {
      key: 'POST primary /api/cart', method: 'POST', role: 'primary', pathTemplate: '/api/cart', path: '/api/cart', queryKeys: [],
      observed: '200', count: 2, succeeded: true, write: true, defaultCheck: 'none' as const, defaultSentOnce: true
    };
    render(panel({ ...capture([pick(0, 'Cart total', '$40.00')], 1), requests: [write] }));
    await settle();

    expect((screen.getByRole('combobox', { name: 'Expectation on POST /api/cart' }) as HTMLSelectElement).value).toBe('none');
    // Unticking it would leave the row with no expectation; the row goes with its × instead.
    expect((screen.getByRole('checkbox', { name: 'Sent once' }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Remove the expectations on POST /api/cart' })).toBeTruthy();
  });

  it('moves focus to Stop pointing when pointing starts, and back to Add expectation when it stops', async () => {
    const view = capture([pick(0, 'Cart total', '$40.00')], 1);
    const pointRef = createRef<HTMLButtonElement>();
    const shown = render(panel(view, false, pointRef));
    await settle();
    screen.getByRole('button', { name: 'Add expectation' }).focus();

    // Pointing replaces the menu's trigger: focus goes with it, never to the page.
    shown.rerender(panel(view, true, pointRef));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Stop pointing' }));

    // Stopped without a pick: back on Add expectation.
    shown.rerender(panel(view, false, pointRef));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add expectation' }));
  });
});
