import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { RecordingViewInput } from '../core/bugReplay/BugRecordingService';
import { DEFAULT_BUG_CASE_ENVIRONMENT } from '../shared/bugReplay';
import { BugRecordingViewHost, type BugRecordingViewRuntime } from './BugRecordingViewHost';

/**
 * The in-app view a bug is recorded in reaches only the clean copy's own origins and never grants
 * the page anything: these drive the host's own guards through a stand-in for Electron.
 */

type RecordingSession = ReturnType<BugRecordingViewRuntime['sessionForPartition']>;
type RecordingView = ReturnType<BugRecordingViewRuntime['createView']>;
type Listener = (...args: never[]) => unknown;

const APP = 'http://127.0.0.1:4100';

class FakeSession {
  beforeRequest?: (details: { url: string; resourceType?: string; webContentsId?: number }, callback: (result: { cancel: boolean }) => void) => void;
  checkPermission?: () => boolean;
  requestPermission?: (contents: unknown, permission: string, callback: (allowed: boolean) => void) => void;
  devicePermission?: () => boolean;
  download?: (event: { preventDefault(): void }) => void;
  webRequest = {
    onBeforeRequest: (_filter: { urls: string[] }, listener: FakeSession['beforeRequest'] | null) => {
      this.beforeRequest = listener ?? undefined;
    }
  };
  setPermissionCheckHandler(handler: (() => boolean) | null) {
    this.checkPermission = handler ?? undefined;
  }
  setPermissionRequestHandler(handler: FakeSession['requestPermission'] | null) {
    this.requestPermission = handler ?? undefined;
  }
  setDevicePermissionHandler(handler: (() => boolean) | null) {
    this.devicePermission = handler ?? undefined;
  }
  on(_event: 'will-download', listener: FakeSession['download']) {
    this.download = listener;
  }
  off(_event: 'will-download', listener: FakeSession['download']) {
    if (this.download === listener) this.download = undefined;
  }
  async closeAllConnections() {}
  async clearStorageData() {}
  async clearCache() {}
  async clearAuthCache() {}
  /** Whether the session lets a request of the page through. */
  allows(url: string, resourceType = 'xhr'): boolean {
    let allowed = false;
    this.beforeRequest?.({ url, resourceType, webContentsId: 7 }, (result) => {
      allowed = !result.cancel;
    });
    return allowed;
  }
}

/** Electron's debugger for the view: every command answers, as an empty page would. */
class FakeDebugger {
  private attached = false;
  private readonly listeners = new Map<string, Set<Listener>>();
  attach() {
    this.attached = true;
  }
  detach() {
    this.attached = false;
  }
  isAttached() {
    return this.attached;
  }
  async sendCommand(method: string) {
    return method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main-frame' } } } : {};
  }
  on(event: string, listener: Listener) {
    this.listeners.set(event, (this.listeners.get(event) ?? new Set()).add(listener));
  }
  off(event: string, listener: Listener) {
    this.listeners.get(event)?.delete(listener);
  }
}

class FakeWebContents {
  readonly debugger = new FakeDebugger();
  readonly loaded: string[] = [];
  openWindow?: (details: { url: string }) => { action: 'deny' };
  private readonly handlers = new Map<string, Listener[]>();
  private closed = false;
  constructor(readonly id: number) {}
  isDestroyed() {
    return this.closed;
  }
  close() {
    this.closed = true;
  }
  async loadURL(url: string) {
    this.loaded.push(url);
  }
  getURL() {
    return this.loaded.at(-1) ?? '';
  }
  reload() {}
  async capturePage() {
    return { isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), resize: () => undefined, toPNG: () => Buffer.alloc(0) };
  }
  setWindowOpenHandler(handler: FakeWebContents['openWindow']) {
    this.openWindow = handler;
  }
  setWebRTCIPHandlingPolicy() {}
  on(event: string, listener: Listener) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
  }
  /** Electron raising `event` on the view's page. */
  emit(event: string, ...args: unknown[]) {
    for (const listener of this.handlers.get(event) ?? []) (listener as (...values: unknown[]) => unknown)(...args);
  }
}

class FakeView {
  readonly webContents = new FakeWebContents(7);
  setBounds() {}
  setVisible() {}
  setBorderRadius() {}
}

const ELECTRON_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Task Monki/0.5.0 Chrome/152.0.0.0 Electron/43.8.0 Safari/537.36';

function fakeRuntime(view: FakeView, session: FakeSession, display: { dark: boolean; scaleFactor: number } = { dark: false, scaleFactor: 1 }): BugRecordingViewRuntime {
  return {
    chromiumVersion: '152.0.0.0',
    userAgent: ELECTRON_USER_AGENT,
    prefersDark: () => display.dark,
    scaleFactor: () => display.scaleFactor,
    sessionForPartition: () => session as unknown as RecordingSession,
    createView: () => view as unknown as RecordingView
  };
}

/** Opens a recording of the app at APP in a view of its own, as the recording service would. */
async function openRecording() {
  const session = new FakeSession();
  const view = new FakeView();
  const runtime = fakeRuntime(view, session);
  const notices: Array<Parameters<RecordingViewInput['notify']>[0]> = [];
  const host = new BugRecordingViewHost(runtime);
  const handle = await host.open({
    sessionId: 'session-1',
    taskId: 'task-1',
    origins: { primary: APP },
    startUrl: `${APP}/`,
    environment: DEFAULT_BUG_CASE_ENVIRONMENT,
    notify: (notice) => notices.push(notice),
    signal: new AbortController().signal
  });
  onTestFinished(() => handle.close());
  return { handle, session, contents: view.webContents, notices };
}

function navigation(url: string, isMainFrame = true) {
  return { url, isMainFrame, preventDefault: vi.fn() };
}

describe('The view a bug is recorded in', () => {
  it('records with the system’s appearance, the display’s density and the user agent of a browser, not of Task Monki', () => {
    const host = new BugRecordingViewHost(fakeRuntime(new FakeView(), new FakeSession(), { dark: true, scaleFactor: 2 }));

    expect(host.environment()).toEqual({
      colorScheme: 'dark',
      deviceScaleFactor: 2,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
    });
  });

  it('reaches only the clean copy’s own origin', async () => {
    const { session, contents } = await openRecording();

    expect(contents.loaded).toEqual(['about:blank', `${APP}/`]);
    expect(session.allows(`${APP}/api/cart`)).toBe(true);
    expect(session.allows('ws://127.0.0.1:4100/live')).toBe(true);
    // Another service on the same host, the same host over HTTPS, and anything else.
    expect(session.allows('http://127.0.0.1:4200/api/cart')).toBe(false);
    expect(session.allows('https://127.0.0.1:4100/api/cart')).toBe(false);
    expect(session.allows('https://cdn.example.com/app.js', 'script')).toBe(false);
    expect(session.allows('file:///etc/hosts', 'mainFrame')).toBe(false);
  });

  it('grants the page no permission, download or new window', async () => {
    const { session, contents, notices } = await openRecording();

    expect(session.checkPermission?.()).toBe(false);
    let granted: boolean | undefined;
    session.requestPermission?.(contents, 'media', (allowed) => {
      granted = allowed;
    });
    expect(granted).toBe(false);
    expect(session.devicePermission?.()).toBe(false);
    const download = { preventDefault: vi.fn() };
    session.download?.(download);
    expect(download.preventDefault).toHaveBeenCalled();
    expect(contents.openWindow?.({ url: `${APP}/receipt` })).toEqual({ action: 'deny' });
    // What the recording could not follow is part of its evidence.
    expect(notices).toContainEqual(expect.objectContaining({ kind: 'coverage' }));
  });

  it('keeps the page on the app: a link to another site is not followed', async () => {
    const { contents, notices } = await openRecording();

    const inside = navigation(`${APP}/checkout`);
    contents.emit('will-navigate', inside);
    expect(inside.preventDefault).not.toHaveBeenCalled();
    expect(notices).toEqual([]);

    const away = navigation('https://accounts.example.com/sign-in');
    contents.emit('will-navigate', away);
    expect(away.preventDefault).toHaveBeenCalled();
    const redirected = navigation('http://127.0.0.1:4200/');
    contents.emit('will-redirect', redirected);
    expect(redirected.preventDefault).toHaveBeenCalled();
    expect(notices).toContainEqual(expect.objectContaining({ kind: 'coverage' }));
  });

  it('takes Escape from the page only while the person points, and stops pointing with it', async () => {
    const { handle, contents } = await openRecording();
    const cancelPick = vi.spyOn(handle.recorder, 'cancelPick');
    const key = (type: 'keyDown' | 'keyUp', name = 'Escape') => {
      const event = { preventDefault: vi.fn() };
      contents.emit('before-input-event', event, { type, key: name });
      return event.preventDefault;
    };

    // Not pointing: Escape is the page's.
    expect(key('keyDown')).not.toHaveBeenCalled();
    expect(key('keyUp')).not.toHaveBeenCalled();
    expect(cancelPick).not.toHaveBeenCalled();

    const pick = handle.recorder.pick();
    expect(handle.recorder.isPointing).toBe(true);
    // Other keys still reach the page while pointing.
    expect(key('keyDown', 'Enter')).not.toHaveBeenCalled();
    expect(key('keyDown')).toHaveBeenCalled();
    expect(cancelPick).toHaveBeenCalledTimes(1);
    expect(await pick).toEqual({ kind: 'stopped' });
    // The page never sees the release of the Escape that stopped pointing, and gets the next one.
    expect(key('keyUp')).toHaveBeenCalled();
    expect(key('keyDown')).not.toHaveBeenCalled();
    expect(key('keyUp')).not.toHaveBeenCalled();
    expect(cancelPick).toHaveBeenCalledTimes(1);
  });
});
