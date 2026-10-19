import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BUG_CASE_ENVIRONMENT } from '../../../shared/bugReplay';
import { RECORDER_BINDING, RECORDER_WORLD } from './recorderScript';
import { RecorderSession, type CdpConnection, type RecorderNotice } from './RecorderSession';

const ORIGIN = 'http://127.0.0.1:5100';

/** A DevTools connection the test drives: what the page and the recorder world would report. */
function harness(scroll: [number, number] = [0, 0]) {
  const listeners: Array<(method: string, params: Record<string, unknown>, sessionId?: string) => void> = [];
  const evaluated: string[] = [];
  // What the recorder world reads off the element Chrome's inspect mode reports.
  let picked: Record<string, unknown> | undefined;
  const cdp: CdpConnection = {
    send: async (method, params) => {
      if (method === 'Runtime.evaluate') {
        const expression = String(params?.expression ?? '');
        evaluated.push(expression);
        if (expression === 'globalThis.__tmNoteShot()') return { result: { value: scroll } };
      }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'picked-node' } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: picked } };
      return {};
    },
    onEvent: (listener) => {
      listeners.push(listener);
      return () => undefined;
    }
  };
  const notices: RecorderNotice[] = [];
  const session = new RecorderSession(cdp, { primary: ORIGIN }, DEFAULT_BUG_CASE_ENVIRONMENT, (notice) => notices.push(notice));
  const emit = (method: string, params: Record<string, unknown>) => {
    for (const listener of listeners) listener(method, params);
  };
  const recorder = (event: Record<string, unknown>) => emit('Runtime.bindingCalled', { name: RECORDER_BINDING, payload: JSON.stringify(event) });
  const request = (id: string, method: string, path: string, status?: number) => {
    emit('Network.requestWillBeSent', { requestId: id, type: 'Fetch', request: { url: `${ORIGIN}${path}`, method } });
    if (status === undefined) {
      emit('Network.loadingFailed', { requestId: id, errorText: 'net::ERR_CONNECTION_RESET' });
      return;
    }
    emit('Network.responseReceived', { requestId: id, response: { status, mimeType: 'text/html', headers: {} } });
    emit('Network.loadingFinished', { requestId: id });
  };
  /** The person clicks an element while pointing; Chrome reports it and the recorder world reads it. */
  const inspect = (facts: Record<string, unknown>) => {
    picked = facts;
    emit('Overlay.inspectNodeRequested', { backendNodeId: 42 });
  };
  return { session, emit, recorder, inspect, request, notices, evaluated };
}

const APPLY = { tag: 'button', testIds: [], role: 'button', name: 'Apply coupon', text: 'Apply coupon', css: '#apply' };

describe('Recorder session', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists what was recorded in the order it happened: steps, a server error, an uncaught error, and an app’s own 4xx left untoned', async () => {
    const { session, recorder, request, emit, notices } = harness();
    await session.attach();
    session.noteStart('/', []);
    vi.advanceTimersByTime(100);
    request('r1', 'GET', '/api/orders/last', 404);
    vi.advanceTimersByTime(100);
    recorder({ type: 'action', kind: 'click', target: APPLY });
    vi.advanceTimersByTime(50);
    request('r2', 'POST', '/api/coupons/apply', 500);
    vi.advanceTimersByTime(50);
    emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: total is not a function\n    at render' } } });

    const timeline = session.timeline();

    expect(timeline.steps).toBe(2);
    expect(timeline.entries.map((entry) => [entry.kind, entry.text, entry.tone ?? null, entry.step ?? null])).toEqual([
      ['navigate', 'Open /', null, 1],
      ['request', 'GET /api/orders/last returned 404', null, null],
      ['click', 'Click "Apply coupon"', null, 2],
      ['request', 'POST /api/coupons/apply returned 500', 'error', null],
      ['error', 'TypeError: total is not a function', 'error', null]
    ]);
    // Each change tells the service the timeline moved; it decides how often to show it.
    expect(notices.filter((notice) => notice.kind === 'timeline').length).toBeGreaterThanOrEqual(4);
  });

  it('moves the start to another page only while nothing else was recorded', async () => {
    const { session, recorder, request } = harness();
    await session.attach();
    session.noteStart('/', [], 'primary', 0);
    vi.advanceTimersByTime(100);
    request('r1', 'GET', '/api/orders/last', 404);
    vi.advanceTimersByTime(100);

    expect(session.onlyStart()).toBe(true);
    expect(session.restartAt('/checkout', [['step', '2']], 'primary', 150)).toBe(true);
    // The page it no longer starts on is not part of what was recorded.
    expect(session.timeline()).toMatchObject({ entries: [{ kind: 'navigate', text: 'Open /checkout' }], omitted: 0 });

    recorder({ type: 'action', kind: 'click', target: APPLY });
    // After a step the page is the steps' to change: the start stays where they began.
    expect(session.restartAt('/cart', [])).toBe(false);
    expect(session.log().actions[0].location).toMatchObject({ path: '/checkout', query: [['step', '2']] });
  });

  it('places a pick on the marked screenshot by the scroll the screenshot was taken at', async () => {
    const { session, recorder, inspect, emit } = harness([0, 300]);
    await session.attach();
    emit('Runtime.executionContextCreated', { context: { id: 7, name: RECORDER_WORLD, auxData: { frameId: 'main', isDefault: false } } });
    session.noteStart('/', []);
    recorder({ type: 'action', kind: 'click', target: APPLY });
    session.seal();
    await session.noteShot();

    // The person scrolled 200px further down before pointing.
    const picked = session.pick();
    await Promise.resolve();
    inspect({
      target: { tag: 'span', testIds: [{ attribute: 'data-testid', value: 'cart-total' }], text: '$40.00', css: '#cart-total' },
      text: '$40.00',
      visible: true,
      count: 1,
      box: { x: 100, y: 120, width: 60, height: 18 },
      scroll: { x: 0, y: 500 }
    });
    const pick = await picked;

    expect(pick.kind === 'picked' && pick.pick.box).toEqual({ x: 100, y: 320, width: 60, height: 18 });

    const placeAt = async (box: { x: number; y: number }, scrollY: number, placement?: Record<string, unknown>) => {
      const picked = session.pick();
      await Promise.resolve();
      inspect({
        target: { tag: 'span', testIds: [], text: 'Total', css: '#total' },
        text: 'Total',
        visible: true,
        count: 1,
        box: { ...box, width: 60, height: 18 },
        scroll: { x: 0, y: scrollY },
        ...(placement ? { placement } : {})
      });
      const outcome = await picked;
      // The pick lands either way; only its place on the screenshot is in question.
      expect(outcome.kind).toBe('picked');
      return outcome.kind === 'picked' ? outcome.pick.box : undefined;
    };
    // An element outside what the screenshot shows has no place on it.
    expect(await placeAt({ x: 100, y: 700 }, 900)).toBeUndefined();
    // A fixed bar stays where it was however far the window scrolled.
    expect(await placeAt({ x: 100, y: 20 }, 900, { fixed: true, shift: { x: 0, y: 0 } })).toEqual({ x: 100, y: 20, width: 60, height: 18 });
    // In an app that scrolls inside a box, that box's scroll moves the element back too.
    expect(await placeAt({ x: 100, y: 120 }, 300, { shift: { x: 0, y: 150 } })).toEqual({ x: 100, y: 270, width: 60, height: 18 });
    // A sticky element that anything scrolled under cannot be placed.
    expect(await placeAt({ x: 100, y: 120 }, 500, { sticky: true, shift: { x: 0, y: 0 } })).toBeUndefined();

    // A new mark forgets the last screenshot's scroll: until its own is read, nothing is placed.
    session.seal();
    expect(await placeAt({ x: 100, y: 120 }, 300)).toBeUndefined();
  });

  it('times a fill from its first keystroke and the start page from its load, so the marked step holds what the page did meanwhile', async () => {
    const { session, recorder } = harness();
    await session.attach();
    vi.advanceTimersByTime(1_000);
    // The start page began loading when the recorder attached.
    session.noteStart('/', [], 'primary', 0);
    vi.advanceTimersByTime(2_000);
    // Typing began 1.5 s before the fill reached the recorder.
    recorder({ type: 'action', kind: 'fill', target: { tag: 'input', testIds: [], label: 'Coupon code', css: '#coupon' }, value: 'SAVE5', typedForMs: 1_500 });

    expect(session.log().actions.map((action) => [action.kind, action.t])).toEqual([['navigate', 0], ['fill', 1_500]]);
  });
});
