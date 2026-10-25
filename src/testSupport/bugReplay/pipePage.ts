import type { CdpConnection } from '../../core/bugReplay/recorder/RecorderSession';
import type { ChromeOverPipe } from '../../core/bugReplay/runner/chromePipe';

/** A page of a Chrome for Testing started over a pipe, presented the way Electron's debugger presents a view. */
export interface PipePage {
  /** The page as Electron's debugger presents a view: its own commands and events carry no session. */
  cdp: CdpConnection;
  /** Straight to the page: the person's input, or a look at the page's own state. */
  page(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Commands the recorder sent that Chrome accepted, in order. */
  accepted: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }>;
  /** Embedded frames that are targets of their own, by session. */
  frames: Set<string>;
}

export async function openPipePage(chrome: ChromeOverPipe): Promise<PipePage> {
  let nextId = 1;
  let pageSession = '';
  const waiting = new Map<number, { resolve(result: Record<string, unknown>): void; reject(error: Error): void }>();
  const listeners = new Set<(method: string, params: Record<string, unknown>, sessionId?: string) => void>();
  const accepted: PipePage['accepted'] = [];
  const frames = new Set<string>();
  chrome.transport.onmessage = (raw) => {
    const message = raw as { id?: number; result?: Record<string, unknown>; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
    if (message.id !== undefined) {
      const waiter = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) waiter?.reject(new Error(message.error.message));
      else waiter?.resolve(message.result ?? {});
      return;
    }
    // Browser-level events are not the view's.
    if (!message.method || !message.sessionId) return;
    const sessionId = message.sessionId === pageSession ? undefined : message.sessionId;
    const params = message.params ?? {};
    if (!sessionId && message.method === 'Target.attachedToTarget' && (params.targetInfo as { type?: string }).type === 'iframe') frames.add(String(params.sessionId));
    if (!sessionId && message.method === 'Target.detachedFromTarget') frames.delete(String(params.sessionId));
    for (const listener of listeners) listener(message.method, params, sessionId);
  };
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      chrome.transport.send({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  pageSession = String((await send('Target.attachToTarget', { targetId, flatten: true })).sessionId);
  return {
    cdp: {
      send: async (method, params = {}, sessionId) => {
        const result = await send(method, params, sessionId ?? pageSession);
        accepted.push({ method, params, sessionId });
        return result;
      },
      onEvent: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }
    },
    page: (method, params) => send(method, params, pageSession),
    accepted,
    frames
  };
}

export async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
