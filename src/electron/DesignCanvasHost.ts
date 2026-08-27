import { createHash, randomUUID } from 'node:crypto';
import type {
  BeginDesignCanvasCutoverInput,
  DesignCanvasCutoverFence,
  DesignCanvasCutoverLease,
  DesignCanvasRouteIdentity
} from '../core/preview/DesignCanvasCutoverFence';

export type {
  BeginDesignCanvasCutoverInput,
  DesignCanvasCutoverFence,
  DesignCanvasCutoverLease,
  DesignCanvasRouteIdentity
} from '../core/preview/DesignCanvasCutoverFence';

export interface DesignCanvasResolvedRoute extends DesignCanvasRouteIdentity {
  url: string;
  origin: string;
}

export interface DesignCanvasBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesignCanvasShowInput extends DesignCanvasRouteIdentity {
  designId: string;
  requestId: number;
  bounds: DesignCanvasBounds;
}

export interface DesignCanvasExternalApprovalInput {
  designId: string;
  pendingId: string;
}

export type DesignCanvasHostEvent =
  | {
      type: 'external-link-requested';
      designId: string;
      pendingId: string;
      destinationHost: string;
    }
  | {
      type: 'load-failed';
      designId: string;
      generationId: string;
      reason: string;
    };

interface CanvasRequestDetails {
  url: string;
  resourceType?: string;
  webContentsId?: number;
}

interface CanvasSession {
  webRequest: {
    onBeforeRequest(
      filter: { urls: string[] },
      listener:
        | ((
            details: CanvasRequestDetails,
            callback: (result: { cancel: boolean }) => void
          ) => void)
        | null
    ): void;
  };
  setPermissionCheckHandler(handler: (() => boolean) | null): void;
  setPermissionRequestHandler(
    handler:
      | ((
          webContents: unknown,
          permission: string,
          callback: (allowed: boolean) => void
        ) => void)
      | null
  ): void;
  setDevicePermissionHandler(handler: (() => boolean) | null): void;
  on(event: 'will-download', listener: (event: { preventDefault(): void }) => void): void;
  off(event: 'will-download', listener: (event: { preventDefault(): void }) => void): void;
  closeAllConnections(): Promise<void>;
  clearStorageData(options: { origin: string; storages: string[] }): Promise<void>;
  clearCache(): Promise<void>;
  serviceWorkers: {
    getAllRunning(): Record<number, { scope?: string; scriptURL?: string }>;
  };
}

interface CanvasNavigationEvent {
  preventDefault(): void;
  url: string;
  isMainFrame: boolean;
}

interface CanvasWebContents {
  readonly id: number;
  isDestroyed(): boolean;
  close(): void;
  loadURL(url: string): Promise<void>;
  reload(): void;
  getURL(): string;
  setWindowOpenHandler(
    handler: (details: { url: string }) => { action: 'deny' }
  ): void;
  on(event: 'will-navigate', listener: (event: CanvasNavigationEvent) => void): void;
  on(
    event: 'will-frame-navigate',
    listener: (event: CanvasNavigationEvent) => void
  ): void;
  on(
    event: 'will-redirect',
    listener: (event: CanvasNavigationEvent) => void
  ): void;
}

interface CanvasView {
  readonly webContents: CanvasWebContents;
  setBounds(bounds: DesignCanvasBounds): void;
  setVisible(visible: boolean): void;
}

interface CanvasWindow {
  isDestroyed(): boolean;
  getContentBounds(): { width: number; height: number };
  contentView: {
    addChildView(view: CanvasView): void;
    removeChildView(view: CanvasView): void;
  };
  webContents: {
    getZoomFactor(): number;
    on(event: 'did-start-navigation' | 'render-process-gone', listener: () => void): void;
    off(event: 'did-start-navigation' | 'render-process-gone', listener: () => void): void;
  };
  on(event: 'closed', listener: () => void): void;
  off(event: 'closed', listener: () => void): void;
}

export interface DesignCanvasRuntime {
  sessionForPartition(partition: string): CanvasSession;
  createView(options: {
    webPreferences: {
      session: CanvasSession;
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
    };
  }): CanvasView;
  openExternal(url: string): Promise<void>;
  wait(milliseconds: number): Promise<void>;
  now(): number;
}

export interface DesignCanvasHostOptions {
  runtime: DesignCanvasRuntime;
  resolveRoute(identity: DesignCanvasRouteIdentity): Promise<DesignCanvasResolvedRoute>;
  emit(event: DesignCanvasHostEvent): void;
  workerStopTimeoutMs?: number;
  workerPollIntervalMs?: number;
  externalApprovalTimeoutMs?: number;
}

interface PendingExternalLink {
  id: string;
  url: string;
  expiresAt: number;
}

interface DesignCanvasSessionState {
  designId: string;
  session: CanvasSession;
  mode: 'DENY_ALL' | 'ALLOW_ROUTES';
  allowedOrigins: Set<string>;
  view?: CanvasView;
  attached: boolean;
  active?: DesignCanvasResolvedRoute;
  lastOrigin?: string;
  requestId: number;
  rendererEpoch: number;
  fenceToken?: string;
  requestedShow?: DesignCanvasShowInput;
  pendingLinks: Map<string, PendingExternalLink>;
  downloadListener(event: { preventDefault(): void }): void;
  closeWork?: Promise<void>;
}

const STORAGE_TYPES = [
  'cookies',
  'filesystem',
  'indexdb',
  'localstorage',
  'serviceworkers',
  'cachestorage'
];

export class DesignCanvasHost implements DesignCanvasCutoverFence {
  private readonly sessions = new Map<string, DesignCanvasSessionState>();
  private window?: CanvasWindow;
  private rendererEpoch = 0;
  private readonly onRendererReset = () => {
    this.rendererEpoch += 1;
    for (const state of this.sessions.values()) {
      state.rendererEpoch = this.rendererEpoch;
      state.requestId = -1;
      this.deactivateCanvas(state, false);
      void state.session.closeAllConnections();
    }
  };
  private readonly onWindowClosed = () => {
    void this.detachWindow();
  };

  constructor(private readonly options: DesignCanvasHostOptions) {}

  attachWindow(window: CanvasWindow): void {
    if (this.window === window) return;
    void this.detachWindow();
    this.window = window;
    this.rendererEpoch += 1;
    for (const state of this.sessions.values()) {
      state.rendererEpoch = this.rendererEpoch;
      state.requestId = -1;
    }
    window.webContents.on('did-start-navigation', this.onRendererReset);
    window.webContents.on('render-process-gone', this.onRendererReset);
    window.on('closed', this.onWindowClosed);
  }

  async detachWindow(): Promise<void> {
    const window = this.window;
    this.window = undefined;
    if (window && !window.isDestroyed()) {
      window.webContents.off('did-start-navigation', this.onRendererReset);
      window.webContents.off('render-process-gone', this.onRendererReset);
      window.off('closed', this.onWindowClosed);
    }
    await Promise.all(
      [...this.sessions.values()].map(async (state) => {
        state.fenceToken = undefined;
        this.deactivateCanvas(state, false, window);
        await state.session.closeAllConnections().catch(() => undefined);
      })
    );
  }

  async begin(input: BeginDesignCanvasCutoverInput): Promise<DesignCanvasCutoverLease> {
    validateIdentity(input.candidate);
    if (input.replaced) validateIdentity(input.replaced);
    if (input.replaced && input.candidate.taskId !== input.replaced.taskId) {
      throw new Error('Design canvas cutover routes must belong to the same task.');
    }
    const state = this.requireSession(input.designId);
    const token = randomUUID();
    state.fenceToken = token;
    try {
      this.denyNetwork(state);
      this.retainLatestExternalApproval(state);
      await state.session.closeAllConnections();
      this.destroyView(state);
      const origin = state.lastOrigin;
      if (origin) await this.clearOrigin(state, origin);
      if (state.fenceToken !== token) {
        throw new Error('Design canvas cutover was superseded.');
      }
    } catch (error) {
      if (state.fenceToken === token) {
        state.fenceToken = undefined;
      }
      this.options.emit({
        type: 'load-failed',
        designId: state.designId,
        generationId: input.candidate.generationId,
        reason: boundedError(error)
      });
      throw error;
    }

    const commit = async () => {
      try {
        await this.activateRequestedRoute(state, input.candidate, token);
      } finally {
        if (state.fenceToken === token) {
          state.fenceToken = undefined;
        }
      }
    };

    const rollback = async () => {
      try {
        this.assertFence(state, token);
        if (!input.replaced) {
          state.active = undefined;
          return;
        }
        await this.activateRequestedRoute(state, input.replaced, token);
      } finally {
        if (state.fenceToken === token) {
          state.fenceToken = undefined;
        }
      }
    };
    return { commit, rollback };
  }

  async show(input: DesignCanvasShowInput): Promise<void> {
    validateIdentity(input);
    const state = this.requireSession(input.designId);
    if (!this.acceptRequest(state, input.requestId)) return;
    this.deactivateOtherDesigns(input.designId);
    state.requestedShow = input;
    if (state.fenceToken) {
      return;
    }
    if (!this.hasActiveView(state, input)) {
      const lease = await this.begin({
        designId: input.designId,
        candidate: input,
        replaced: state.active
      });
      await lease.commit();
      const latest = state.requestedShow;
      if (latest && !this.hasActiveView(state, latest)) {
        await this.show(latest);
      }
      return;
    }
    if (!this.applyBounds(state, input.bounds)) return;
    this.attachView(state);
  }

  hide(input: { designId: string; requestId: number }): void {
    const state = this.sessions.get(input.designId);
    if (!state || !this.acceptRequest(state, input.requestId)) return;
    this.deactivateCanvas(state, true);
    void state.session.closeAllConnections();
  }

  refresh(input: {
    designId: string;
    generationId: string;
    requestId: number;
  }): void {
    const state = this.sessions.get(input.designId);
    if (
      !state ||
      !this.acceptRequest(state, input.requestId) ||
      state.active?.generationId !== input.generationId ||
      !state.view ||
      state.view.webContents.isDestroyed()
    ) {
      return;
    }
    state.view.webContents.reload();
  }

  close(designId: string): Promise<void> {
    const state = this.sessions.get(designId);
    if (!state) return Promise.resolve();
    if (state.closeWork) return state.closeWork;
    const work = (async () => {
      this.deactivateCanvas(state, false);
      await state.session.closeAllConnections();
      if (state.lastOrigin) await this.clearOrigin(state, state.lastOrigin);
      state.active = undefined;
      state.fenceToken = undefined;
      state.pendingLinks.clear();
      this.releaseSessionHandlers(state);
      if (this.sessions.get(designId) === state) {
        this.sessions.delete(designId);
      }
    })();
    state.closeWork = work;
    void work.catch(() => {
      if (state.closeWork === work) state.closeWork = undefined;
    });
    return work;
  }

  async approveExternal(input: DesignCanvasExternalApprovalInput): Promise<boolean> {
    const state = this.sessions.get(input.designId);
    const pending = state?.pendingLinks.get(input.pendingId);
    if (!state || !pending) return false;
    state.pendingLinks.delete(input.pendingId);
    if (pending.expiresAt < this.options.runtime.now() || !safeExternalUrl(pending.url)) {
      return false;
    }
    await this.options.runtime.openExternal(pending.url);
    return true;
  }

  handleGenerationUnavailable(generationId: string): void {
    for (const state of this.sessions.values()) {
      if (state.active?.generationId !== generationId) continue;
      this.deactivateCanvas(state, true);
      void state.session.closeAllConnections();
    }
  }

  async shutdown(): Promise<void> {
    await this.detachWindow();
    await Promise.all([...this.sessions.keys()].map((designId) => this.close(designId)));
    this.sessions.clear();
  }

  private requireSession(designId: string): DesignCanvasSessionState {
    const existing = this.sessions.get(designId);
    if (existing?.closeWork) {
      throw new Error('The Design canvas session is closing.');
    }
    if (existing) return existing;
    const session = this.options.runtime.sessionForPartition(partitionFor(designId));
    const downloadListener = (event: { preventDefault(): void }) =>
      event.preventDefault();
    const state: DesignCanvasSessionState = {
      designId,
      session,
      mode: 'DENY_ALL',
      allowedOrigins: new Set(),
      attached: false,
      requestId: -1,
      rendererEpoch: this.rendererEpoch,
      pendingLinks: new Map(),
      downloadListener
    };
    session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      callback({ cancel: !this.allowRequest(state, details) });
    });
    session.setPermissionCheckHandler(() => false);
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setDevicePermissionHandler(() => false);
    session.on('will-download', downloadListener);
    this.sessions.set(designId, state);
    return state;
  }

  private releaseSessionHandlers(state: DesignCanvasSessionState): void {
    state.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, null);
    state.session.setPermissionCheckHandler(null);
    state.session.setPermissionRequestHandler(null);
    state.session.setDevicePermissionHandler(null);
    state.session.off('will-download', state.downloadListener);
  }

  private async activateRoute(
    state: DesignCanvasSessionState,
    route: DesignCanvasResolvedRoute
  ): Promise<void> {
    validateResolvedRoute(route);
    this.destroyView(state);
    state.allowedOrigins = routeNetworkOrigins(route.origin);
    state.mode = 'ALLOW_ROUTES';
    state.active = route;
    state.lastOrigin = route.origin;
    const view = this.options.runtime.createView({
      webPreferences: {
        session: state.session,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        navigateOnDragDrop: false,
        webviewTag: false,
        devTools: false
      }
    });
    state.view = view;
    this.hardenView(state, view);
    const expectedGeneration = route.generationId;
    await view.webContents.loadURL(route.url).catch((error: unknown) => {
      if (state.view !== view || state.active?.generationId !== expectedGeneration) {
        return;
      }
      this.denyNetwork(state);
      this.destroyView(state);
      this.options.emit({
        type: 'load-failed',
        designId: state.designId,
        generationId: expectedGeneration,
        reason: boundedError(error)
      });
      throw error;
    });
  }

  private hardenView(state: DesignCanvasSessionState, view: CanvasView): void {
    const handleNavigation = (
      event: CanvasNavigationEvent,
      candidate: string,
      isMainFrame = true
    ) => {
      if (this.isAllowedFrameNavigation(state, view, candidate, isMainFrame)) return;
      event.preventDefault();
      if (isMainFrame) this.createExternalRequest(state, candidate);
    };
    view.webContents.on('will-navigate', (event) =>
      handleNavigation(event, event.url, event.isMainFrame)
    );
    view.webContents.on('will-frame-navigate', (event) =>
      handleNavigation(event, event.url, event.isMainFrame)
    );
    view.webContents.on('will-redirect', (event) =>
      handleNavigation(event, event.url, event.isMainFrame)
    );
    view.webContents.setWindowOpenHandler(({ url }) => {
      this.createExternalRequest(state, url);
      return { action: 'deny' };
    });
  }

  private createExternalRequest(state: DesignCanvasSessionState, candidate: string): void {
    if (!safeExternalUrl(candidate)) return;
    const parsed = new URL(candidate);
    const id = randomUUID();
    state.pendingLinks.set(id, {
      id,
      url: candidate,
      expiresAt:
        this.options.runtime.now() + (this.options.externalApprovalTimeoutMs ?? 60_000)
    });
    this.prunePendingLinks(state);
    this.options.emit({
      type: 'external-link-requested',
      designId: state.designId,
      pendingId: id,
      destinationHost: parsed.host
    });
  }

  private isAllowedFrameNavigation(
    state: DesignCanvasSessionState,
    view: CanvasView,
    candidate: string,
    isMainFrame: boolean
  ): boolean {
    if (!isMainFrame || state.view !== view || state.mode !== 'ALLOW_ROUTES') return false;
    const parsed = parseUrl(candidate);
    return Boolean(parsed && parsed.protocol === 'http:' && state.allowedOrigins.has(parsed.origin));
  }

  private allowRequest(state: DesignCanvasSessionState, details: CanvasRequestDetails): boolean {
    if (state.mode !== 'ALLOW_ROUTES') return false;
    const frameRequest = details.resourceType === 'mainFrame' || details.resourceType === 'subFrame';
    const parsed = parseUrl(details.url);
    if (!parsed) return false;
    if (parsed.protocol === 'http:' || parsed.protocol === 'ws:') {
      return state.allowedOrigins.has(parsed.origin);
    }
    if ((parsed.protocol === 'data:' || parsed.protocol === 'blob:') && !frameRequest) {
      return details.webContentsId === state.view?.webContents.id;
    }
    return false;
  }

  private async clearOrigin(state: DesignCanvasSessionState, origin: string): Promise<void> {
    await state.session.clearStorageData({ origin, storages: STORAGE_TYPES });
    await state.session.clearCache();
    const timeout = this.options.workerStopTimeoutMs ?? 2_000;
    const interval = this.options.workerPollIntervalMs ?? 25;
    const deadline = this.options.runtime.now() + timeout;
    while (runningWorkerForOrigin(state.session, origin)) {
      if (this.options.runtime.now() >= deadline) {
        throw new Error('Design canvas service-worker cleanup timed out.');
      }
      await this.options.runtime.wait(interval);
    }
  }

  private async activateRequestedRoute(
    state: DesignCanvasSessionState,
    identity: DesignCanvasRouteIdentity,
    token: string
  ): Promise<void> {
    this.assertFence(state, token);
    if (!this.requestedShowFor(state, identity)) return;
    const route = await this.options.resolveRoute(identity);
    this.assertFence(state, token);
    if (!this.requestedShowFor(state, identity)) return;
    await this.activateRoute(state, route);
    this.assertFence(state, token);
    const requested = this.requestedShowFor(state, identity);
    if (!requested || !state.view || state.view.webContents.isDestroyed()) {
      this.denyNetwork(state);
      this.destroyView(state);
      return;
    }
    if (!this.applyBounds(state, requested.bounds)) return;
    this.attachView(state);
  }

  private requestedShowFor(
    state: DesignCanvasSessionState,
    identity: DesignCanvasRouteIdentity
  ): DesignCanvasShowInput | undefined {
    const requested = state.requestedShow;
    return requested &&
      requested.taskId === identity.taskId &&
      requested.generationId === identity.generationId &&
      requested.routeId === identity.routeId
      ? requested
      : undefined;
  }

  private hasActiveView(
    state: DesignCanvasSessionState,
    requested: DesignCanvasShowInput
  ): boolean {
    return Boolean(
      state.view &&
      !state.view.webContents.isDestroyed() &&
      state.active?.taskId === requested.taskId &&
      state.active.generationId === requested.generationId &&
      state.active.routeId === requested.routeId
    );
  }

  private deactivateOtherDesigns(selectedDesignId: string): void {
    for (const state of this.sessions.values()) {
      if (
        state.designId === selectedDesignId ||
        (!state.requestedShow && !state.view && state.mode === 'DENY_ALL')
      ) {
        continue;
      }
      this.deactivateCanvas(state, true);
      void state.session.closeAllConnections();
    }
  }

  private deactivateCanvas(
    state: DesignCanvasSessionState,
    preserveExternalApproval: boolean,
    ownerWindow = this.window
  ): void {
    state.requestedShow = undefined;
    this.denyNetwork(state);
    if (preserveExternalApproval) this.retainLatestExternalApproval(state);
    else state.pendingLinks.clear();
    this.destroyView(state, ownerWindow);
  }

  private denyNetwork(state: DesignCanvasSessionState): void {
    state.mode = 'DENY_ALL';
    state.allowedOrigins.clear();
  }

  private retainLatestExternalApproval(state: DesignCanvasSessionState): void {
    this.prunePendingLinks(state);
    const latest = [...state.pendingLinks.entries()].at(-1);
    state.pendingLinks.clear();
    if (latest) state.pendingLinks.set(latest[0], latest[1]);
  }

  private assertFence(state: DesignCanvasSessionState, token: string): void {
    if (state.fenceToken !== token) throw new Error('Design canvas cutover was superseded.');
  }

  private acceptRequest(state: DesignCanvasSessionState, requestId: number): boolean {
    if (!Number.isSafeInteger(requestId) || requestId < 0) return false;
    if (state.rendererEpoch !== this.rendererEpoch) return false;
    if (requestId < state.requestId) return false;
    state.requestId = requestId;
    return true;
  }

  private applyBounds(state: DesignCanvasSessionState, bounds: DesignCanvasBounds): boolean {
    const window = this.window;
    if (!window || window.isDestroyed() || !state.view) {
      this.deactivateCanvas(state, true);
      void state.session.closeAllConnections();
      return false;
    }
    const normalized = normalizeBounds(
      bounds,
      window.webContents.getZoomFactor(),
      window.getContentBounds()
    );
    if (!normalized) {
      this.deactivateCanvas(state, true);
      void state.session.closeAllConnections();
      return false;
    }
    state.view.setBounds(normalized);
    return true;
  }

  private attachView(state: DesignCanvasSessionState): void {
    const window = this.window;
    if (!window || window.isDestroyed() || !state.view) return;
    if (!state.attached) {
      window.contentView.addChildView(state.view);
      state.attached = true;
    }
    state.view.setVisible(true);
  }

  private destroyView(state: DesignCanvasSessionState, ownerWindow = this.window): void {
    const view = state.view;
    if (!view) return;
    view.setVisible(false);
    if (state.attached && ownerWindow && !ownerWindow.isDestroyed()) {
      ownerWindow.contentView.removeChildView(view);
    }
    state.attached = false;
    state.view = undefined;
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }

  private prunePendingLinks(state: DesignCanvasSessionState): void {
    const now = this.options.runtime.now();
    for (const [id, pending] of state.pendingLinks) {
      if (pending.expiresAt < now) state.pendingLinks.delete(id);
    }
    while (state.pendingLinks.size > 16) {
      const first = state.pendingLinks.keys().next().value as string | undefined;
      if (!first) break;
      state.pendingLinks.delete(first);
    }
  }
}

export function normalizeDesignCanvasBounds(
  bounds: DesignCanvasBounds,
  zoomFactor: number,
  contentBounds: { width: number; height: number }
): DesignCanvasBounds | undefined {
  return normalizeBounds(bounds, zoomFactor, contentBounds);
}

function normalizeBounds(
  bounds: DesignCanvasBounds,
  zoomFactor: number,
  contentBounds: { width: number; height: number }
): DesignCanvasBounds | undefined {
  const values = [bounds.x, bounds.y, bounds.width, bounds.height];
  if (
    values.some((value) => !Number.isFinite(value)) ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    !Number.isFinite(zoomFactor) ||
    zoomFactor <= 0 ||
    contentBounds.width <= 0 ||
    contentBounds.height <= 0
  ) {
    return;
  }
  const left = bounds.x * zoomFactor;
  const top = bounds.y * zoomFactor;
  const right = (bounds.x + bounds.width) * zoomFactor;
  const bottom = (bounds.y + bounds.height) * zoomFactor;
  if (right <= 0 || bottom <= 0 || left >= contentBounds.width || top >= contentBounds.height) {
    return;
  }
  const x = Math.max(0, Math.round(left));
  const y = Math.max(0, Math.round(top));
  const boundedRight = Math.min(contentBounds.width, Math.round(right));
  const boundedBottom = Math.min(contentBounds.height, Math.round(bottom));
  if (boundedRight <= x || boundedBottom <= y) return;
  return { x, y, width: boundedRight - x, height: boundedBottom - y };
}

function validateIdentity(identity: DesignCanvasRouteIdentity): void {
  for (const value of [identity.taskId, identity.generationId, identity.routeId]) {
    if (!value || value.length > 256 || value.includes('\0')) {
      throw new Error('Design canvas route identity is invalid.');
    }
  }
}

function validateResolvedRoute(route: DesignCanvasResolvedRoute): void {
  validateIdentity(route);
  const parsed = parseUrl(route.url);
  if (
    !parsed ||
    parsed.protocol !== 'http:' ||
    parsed.origin !== route.origin ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    !parsed.hostname.endsWith('.localhost')
  ) {
    throw new Error('Resolved Design canvas route is unsafe.');
  }
}

function routeNetworkOrigins(origin: string): Set<string> {
  const parsed = new URL(origin);
  const websocket = new URL(origin);
  websocket.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  return new Set([parsed.origin, websocket.origin]);
}

function runningWorkerForOrigin(session: CanvasSession, origin: string): boolean {
  return Object.values(session.serviceWorkers.getAllRunning()).some((worker) => {
    for (const candidate of [worker.scope, worker.scriptURL]) {
      const parsed = candidate ? parseUrl(candidate) : undefined;
      if (parsed?.origin === origin) return true;
    }
    return false;
  });
}

function partitionFor(designId: string): string {
  const digest = createHash('sha256').update(designId).digest('hex').slice(0, 32);
  return `task-monki-design-${digest}`;
}

function safeExternalUrl(candidate: string): boolean {
  const parsed = parseUrl(candidate);
  return Boolean(parsed && parsed.protocol === 'https:' && !parsed.username && !parsed.password);
}

function parseUrl(candidate: string): URL | undefined {
  try {
    return new URL(candidate);
  } catch {
    return;
  }
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 500 ? message : `${message.slice(0, 497)}...`;
}
