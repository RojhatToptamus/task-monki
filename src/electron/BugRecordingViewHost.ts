import { randomUUID } from 'node:crypto';
import { RecorderSession, type CdpConnection } from '../core/bugReplay/recorder/RecorderSession';
import type { RecordingBrowserHost, RecordingViewHandle, RecordingViewInput } from '../core/bugReplay/BugRecordingService';
import type { BugRecordingViewBounds, ShowBugRecordingViewRequest } from '../shared/bugReplay';
import { normalizeDesignCanvasBounds } from './DesignCanvasHost';

/**
 * The in-app browser a bug is recorded in: one native view at a time, on a fresh in-memory
 * session that reaches only the clean copy's own origins, with Task Monki's recorder attached
 * through the DevTools protocol. The page's layout viewport is pinned to the case's size and
 * scaled to fit the space the renderer gives it, so resizing the window never changes what is
 * recorded. The renderer only ever sends bounds and identities, never a URL.
 */

interface RecordingRequestDetails {
  url: string;
  resourceType?: string;
  webContentsId?: number;
}

interface RecordingSession {
  webRequest: {
    onBeforeRequest(
      filter: { urls: string[] },
      listener: ((details: RecordingRequestDetails, callback: (result: { cancel: boolean }) => void) => void) | null
    ): void;
  };
  setPermissionCheckHandler(handler: (() => boolean) | null): void;
  setPermissionRequestHandler(handler: ((contents: unknown, permission: string, callback: (allowed: boolean) => void) => void) | null): void;
  setDevicePermissionHandler(handler: (() => boolean) | null): void;
  on(event: 'will-download', listener: (event: { preventDefault(): void }) => void): void;
  off(event: 'will-download', listener: (event: { preventDefault(): void }) => void): void;
  closeAllConnections(): Promise<void>;
  clearStorageData(): Promise<void>;
  clearCache(): Promise<void>;
  clearAuthCache(): Promise<void>;
}

interface RecordingDebugger {
  attach(protocolVersion: string): void;
  detach(): void;
  isAttached(): boolean;
  sendCommand(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  on(event: 'message', listener: (event: unknown, method: string, params: Record<string, unknown>, sessionId?: string) => void): void;
  on(event: 'detach', listener: (event: unknown, reason: string) => void): void;
  off(event: 'message', listener: (event: unknown, method: string, params: Record<string, unknown>, sessionId?: string) => void): void;
  off(event: 'detach', listener: (event: unknown, reason: string) => void): void;
}

interface RecordingNavigationEvent {
  preventDefault(): void;
  url: string;
  isMainFrame: boolean;
}

interface RecordingKeyInput {
  type: string;
  key: string;
}

interface RecordingWebContents {
  readonly id: number;
  readonly debugger: RecordingDebugger;
  isDestroyed(): boolean;
  close(): void;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  reload(): void;
  capturePage(): Promise<RecordingImage>;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
  setWebRTCIPHandlingPolicy(policy: 'disable_non_proxied_udp'): void;
  on(event: 'will-navigate' | 'will-frame-navigate' | 'will-redirect', listener: (event: RecordingNavigationEvent) => void): void;
  on(event: 'render-process-gone', listener: () => void): void;
  on(event: 'before-input-event', listener: (event: { preventDefault(): void }, input: RecordingKeyInput) => void): void;
}

interface RecordingImage {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: { width: number; quality: 'good' }): RecordingImage;
  toPNG(): Buffer;
}

interface RecordingView {
  readonly webContents: RecordingWebContents;
  setBounds(bounds: BugRecordingViewBounds): void;
  setVisible(visible: boolean): void;
  setBorderRadius?(radius: number): void;
}

interface RecordingWindow {
  isDestroyed(): boolean;
  getContentBounds(): { width: number; height: number };
  contentView: {
    addChildView(view: RecordingView): void;
    removeChildView(view: RecordingView): void;
  };
  webContents: {
    getZoomFactor(): number;
    on(event: 'did-start-navigation' | 'render-process-gone', listener: () => void): void;
    off(event: 'did-start-navigation' | 'render-process-gone', listener: () => void): void;
  };
}

export interface BugRecordingViewRuntime {
  sessionForPartition(partition: string): RecordingSession;
  createView(options: {
    webPreferences: {
      session: RecordingSession;
      nodeIntegration: false;
      nodeIntegrationInSubFrames: false;
      nodeIntegrationInWorker: false;
      contextIsolation: true;
      sandbox: true;
      webSecurity: true;
      allowRunningInsecureContent: false;
      navigateOnDragDrop: false;
      webviewTag: false;
      devTools: false;
      backgroundThrottling: false;
    };
  }): RecordingView;
  chromiumVersion: string;
}

interface ActiveRecording {
  sessionId: string;
  taskId: string;
  session: RecordingSession;
  view: RecordingView;
  recorder: RecorderSession;
  allowed: Set<string>;
  attached: boolean;
  requestId: number;
  rendererEpoch: number;
  closing: boolean;
  scale?: number;
  downloadListener(event: { preventDefault(): void }): void;
  detachListener(event: unknown, reason: string): void;
  notify: RecordingViewInput['notify'];
}

export class BugRecordingViewHost implements RecordingBrowserHost {
  private window?: RecordingWindow;
  private active?: ActiveRecording;
  private rendererEpoch = 0;
  private readonly onRendererReset = () => {
    this.rendererEpoch += 1;
    const active = this.active;
    if (!active) return;
    active.requestId = -1;
    this.detachView(active);
  };

  constructor(private readonly runtime: BugRecordingViewRuntime) {}

  attachWindow(window: RecordingWindow): void {
    if (this.window === window) return;
    this.detachWindow();
    this.window = window;
    this.rendererEpoch += 1;
    window.webContents.on('did-start-navigation', this.onRendererReset);
    window.webContents.on('render-process-gone', this.onRendererReset);
  }

  detachWindow(): void {
    const window = this.window;
    if (this.active) this.detachView(this.active, window);
    this.window = undefined;
    if (window && !window.isDestroyed()) {
      window.webContents.off('did-start-navigation', this.onRendererReset);
      window.webContents.off('render-process-gone', this.onRendererReset);
    }
  }

  async open(input: RecordingViewInput): Promise<RecordingViewHandle> {
    if (this.active) await this.close(this.active);
    const allowed = new Set<string>();
    for (const origin of Object.values(input.origins)) {
      const parsed = new URL(origin);
      if (parsed.protocol !== 'http:' || parsed.username || parsed.password) throw new Error('A clean copy must be served over local HTTP.');
      allowed.add(parsed.origin);
      allowed.add(`ws://${parsed.host}`);
    }
    const session = this.runtime.sessionForPartition(`task-monki-bug-recording-${randomUUID()}`);
    const view = this.runtime.createView({
      webPreferences: {
        session,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        navigateOnDragDrop: false,
        webviewTag: false,
        devTools: false,
        backgroundThrottling: false
      }
    });
    // The placeholder's --r-sm corners.
    view.setBorderRadius?.(8);
    const contents = view.webContents;
    // WebRTC could reach hosts the request filter never sees.
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    const debuggerApi = contents.debugger;
    const cdp: CdpConnection = {
      send: (method, params, sessionId) => debuggerApi.sendCommand(method, params ?? {}, sessionId),
      onEvent: (listener) => {
        const handler = (_event: unknown, method: string, params: Record<string, unknown>, sessionId?: string) => listener(method, params, sessionId);
        debuggerApi.on('message', handler);
        return () => debuggerApi.off('message', handler);
      }
    };
    const recorder = new RecorderSession(cdp, input.origins, input.environment, input.notify);
    const active: ActiveRecording = {
      sessionId: input.sessionId,
      taskId: input.taskId,
      session,
      view,
      recorder,
      allowed,
      attached: false,
      requestId: -1,
      rendererEpoch: this.rendererEpoch,
      closing: false,
      notify: input.notify,
      downloadListener: (event) => event.preventDefault(),
      detachListener: (_event, reason) => {
        if (!active.closing) input.notify({ kind: 'interrupted', reason: `The recording view closed (${reason})` });
      }
    };
    this.active = active;
    session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      const allowedRequest = this.allowRequest(active, details);
      if (!allowedRequest) {
        const host = hostOf(details.url);
        if (host) recorder.noteBlocked(host);
      }
      callback({ cancel: !allowedRequest });
    });
    session.setPermissionCheckHandler(() => false);
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setDevicePermissionHandler(() => false);
    session.on('will-download', active.downloadListener);
    const guard = (event: RecordingNavigationEvent) => {
      if (!event.isMainFrame && !event.url.startsWith('http')) return;
      const origin = originOf(event.url);
      if (origin && active.allowed.has(origin)) return;
      event.preventDefault();
      if (event.isMainFrame) recorder.noteCoverage('A link to another site was not followed');
    };
    contents.on('will-navigate', guard);
    contents.on('will-frame-navigate', guard);
    contents.on('will-redirect', guard);
    contents.setWindowOpenHandler(() => {
      recorder.noteCoverage('A new window was not opened');
      return { action: 'deny' };
    });
    contents.on('render-process-gone', () => {
      if (!active.closing) input.notify({ kind: 'interrupted', reason: 'The page stopped responding' });
    });
    // Escape while pointing stops pointing, and the page receives neither its keydown nor its keyup.
    let heldEscape = false;
    contents.on('before-input-event', (event, key) => {
      if (key.key !== 'Escape') return;
      if (key.type === 'keyDown' && (recorder.isPointing || heldEscape)) {
        event.preventDefault();
        heldEscape = true;
        void recorder.cancelPick();
      } else if (key.type === 'keyUp' && heldEscape) {
        event.preventDefault();
        heldEscape = false;
      }
    });
    const abort = () => void this.close(active);
    input.signal.addEventListener('abort', abort, { once: true });
    try {
      if (input.signal.aborted) throw new Error('The recording ended.');
      // A view has no renderer until it loads something, and DevTools domains wait for one.
      await withDeadline(contents.loadURL('about:blank'), VIEW_OPEN_TIMEOUT_MS);
      debuggerApi.attach('1.3');
      debuggerApi.on('detach', active.detachListener);
      await withDeadline(recorder.attach(), VIEW_OPEN_TIMEOUT_MS);
      await withDeadline(recorder.pinViewport({ nativeDensity: true }), VIEW_OPEN_TIMEOUT_MS);
      await withDeadline(contents.loadURL(input.startUrl), PAGE_LOAD_TIMEOUT_MS);
      if (input.signal.aborted || active.closing) throw new Error('The recording ended.');
    } catch (error) {
      input.signal.removeEventListener('abort', abort);
      await this.close(active);
      throw error;
    }
    return {
      recorder,
      chromium: this.runtime.chromiumVersion,
      reload: async () => {
        if (!contents.isDestroyed()) contents.reload();
      },
      open: async (path: string) => {
        const appOrigin = new URL(input.startUrl).origin;
        const target = new URL(path, input.startUrl);
        // Only the app's own pages; the navigation guard refuses the rest as well.
        if (target.origin !== appOrigin) throw new Error('Open a page of this app.');
        if (contents.isDestroyed()) throw new Error('The recording ended.');
        const before = contents.getURL();
        try {
          await withDeadline(contents.loadURL(target.toString()), PAGE_LOAD_TIMEOUT_MS);
        } catch {
          // The app may send the page on to another of its own pages while it loads; a page that
          // stayed where it was, or went to another site, did not open.
          const now = contents.isDestroyed() ? '' : contents.getURL();
          if (originOf(now) !== appOrigin || now === before) throw new Error("That page didn't open.");
        }
      },
      close: () => this.close(active),
      screenshot: async () => {
        if (contents.isDestroyed() || !active.attached) return Buffer.alloc(0);
        const image = await contents.capturePage();
        if (image.isEmpty()) return Buffer.alloc(0);
        const fitted = image.getSize().width > 1280 ? image.resize({ width: 1280, quality: 'good' }) : image;
        return fitted.toPNG();
      }
    };
  }

  /** The renderer's placeholder moved or appeared: place the view there and fit the page into it. */
  show(input: ShowBugRecordingViewRequest): void {
    const active = this.active;
    if (!active || active.sessionId !== input.sessionId || active.taskId !== input.taskId || active.closing) return;
    if (!this.acceptRequest(active, input.requestId)) return;
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    const bounds = normalizeDesignCanvasBounds(input.bounds, window.webContents.getZoomFactor(), window.getContentBounds());
    if (!bounds) {
      this.detachView(active);
      return;
    }
    active.view.setBounds(bounds);
    if (!active.attached) {
      window.contentView.addChildView(active.view);
      active.attached = true;
    }
    active.view.setVisible(true);
    void this.fit(active, bounds);
  }

  hide(input: { taskId: string; sessionId: string; requestId: number }): void {
    const active = this.active;
    if (!active || active.sessionId !== input.sessionId || active.taskId !== input.taskId) return;
    if (!this.acceptRequest(active, input.requestId)) return;
    this.detachView(active);
  }

  async shutdown(): Promise<void> {
    if (this.active) await this.close(this.active);
    this.detachWindow();
  }

  private async fit(active: ActiveRecording, bounds: BugRecordingViewBounds): Promise<void> {
    const viewport = { width: 1280, height: 800 };
    const scale = Math.min(1, bounds.width / viewport.width, bounds.height / viewport.height);
    const rounded = Math.max(0.25, Math.round(scale * 1000) / 1000);
    if (active.scale === rounded || active.closing) return;
    active.scale = rounded;
    await active.recorder.pinViewport({ scale: rounded, nativeDensity: true }).catch(() => undefined);
  }

  private allowRequest(active: ActiveRecording, details: RecordingRequestDetails): boolean {
    if (active.closing) return false;
    let parsed: URL;
    try {
      parsed = new URL(details.url);
    } catch {
      return false;
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'ws:') return active.allowed.has(parsed.origin);
    if (parsed.href === 'about:blank') return true;
    const frame = details.resourceType === 'mainFrame' || details.resourceType === 'subFrame';
    if ((parsed.protocol === 'data:' || parsed.protocol === 'blob:') && !frame) return details.webContentsId === active.view.webContents.id;
    return false;
  }

  private acceptRequest(active: ActiveRecording, requestId: number): boolean {
    if (!Number.isSafeInteger(requestId) || requestId < 0) return false;
    if (active.rendererEpoch !== this.rendererEpoch) {
      active.rendererEpoch = this.rendererEpoch;
      active.requestId = -1;
    }
    if (requestId < active.requestId) return false;
    active.requestId = requestId;
    return true;
  }

  private detachView(active: ActiveRecording, window = this.window): void {
    active.view.setVisible(false);
    if (active.attached && window && !window.isDestroyed()) window.contentView.removeChildView(active.view);
    active.attached = false;
  }

  private async close(active: ActiveRecording): Promise<void> {
    if (active.closing) return;
    active.closing = true;
    if (this.active === active) this.active = undefined;
    this.detachView(active);
    const contents = active.view.webContents;
    try {
      contents.debugger.off('detach', active.detachListener);
      if (!contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
    } catch {
      // The view may already be gone.
    }
    if (!contents.isDestroyed()) contents.close();
    active.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, null);
    active.session.setPermissionCheckHandler(null);
    active.session.setPermissionRequestHandler(null);
    active.session.setDevicePermissionHandler(null);
    active.session.off('will-download', active.downloadListener);
    await active.session.closeAllConnections().catch(() => undefined);
    await active.session.clearStorageData().catch(() => undefined);
    await active.session.clearCache().catch(() => undefined);
    await active.session.clearAuthCache().catch(() => undefined);
  }
}

const VIEW_OPEN_TIMEOUT_MS = 15_000;
const PAGE_LOAD_TIMEOUT_MS = 60_000;

/** A step of opening the view that does not answer in time fails the recording instead of hanging it. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('The recording view did not open')), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

function originOf(candidate: string): string | undefined {
  try {
    return new URL(candidate).origin;
  } catch {
    return undefined;
  }
}

function hostOf(candidate: string): string | undefined {
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'ws:' || parsed.protocol === 'wss:' ? parsed.host : undefined;
  } catch {
    return undefined;
  }
}
