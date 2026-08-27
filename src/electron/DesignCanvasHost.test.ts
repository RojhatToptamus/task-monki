import { describe, expect, it, vi } from 'vitest';
import {
  DesignCanvasHost,
  normalizeDesignCanvasBounds,
  type DesignCanvasHostEvent,
  type DesignCanvasResolvedRoute,
  type DesignCanvasRouteIdentity,
  type DesignCanvasRuntime
} from './DesignCanvasHost';

describe('DesignCanvasHost', () => {
  it('loads only a resolved route in a hardened in-memory view', async () => {
    const fixture = createFixture();
    fixture.host.attachWindow(fixture.window);

    await fixture.host.show({
      designId: 'design-1',
      taskId: 'design-1',
      generationId: 'generation-1',
      routeId: 'app',
      requestId: 1,
      bounds: { x: 10, y: 20, width: 200, height: 100 }
    });

    expect(fixture.partitions).toHaveLength(1);
    expect(fixture.partitions[0]).not.toContain('persist:');
    expect(fixture.viewOptions[0]).toEqual({
      session: fixture.session,
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
    });
    expect(fixture.views[0].webContents.loaded).toEqual([route('generation-1').url]);
    expect(fixture.views[0].bounds).toEqual({ x: 20, y: 40, width: 400, height: 200 });
    expect(fixture.window.added).toEqual([fixture.views[0]]);

    expect(fixture.session.request('https://example.com/app.js', 'script', 1)).toBe(false);
    expect(fixture.session.request(route('generation-1').url, 'mainFrame', 1)).toBe(true);
    expect(fixture.session.request('ws://app.design-1.preview.localhost:4000/socket', 'webSocket', 1)).toBe(true);
    expect(fixture.session.request('file:///tmp/private', 'script', 1)).toBe(false);
    expect(fixture.session.request('data:text/plain,ok', 'script', fixture.views[0].webContents.id)).toBe(true);
    expect(fixture.session.request('data:text/plain,no', 'mainFrame', fixture.views[0].webContents.id)).toBe(false);
    expect(fixture.session.checkPermission?.()).toBe(false);
    expect(fixture.session.devicePermission?.()).toBe(false);
    const permission = vi.fn();
    fixture.session.requestPermission?.({}, 'camera', permission);
    expect(permission).toHaveBeenCalledWith(false);
    const downloadEvent = { preventDefault: vi.fn() };
    fixture.session.download?.(downloadEvent);
    expect(downloadEvent.preventDefault).toHaveBeenCalledOnce();
  });

  it('denies the old route and does not load an unselected replacement', async () => {
    const fixture = createFixture();
    fixture.host.attachWindow(fixture.window);
    await showFirst(fixture);
    const oldView = fixture.views[0];

    const lease = await fixture.host.begin({
      designId: 'design-1',
      candidate: identity('generation-2'),
      replaced: identity('generation-1')
    });

    expect(oldView.webContents.closed).toBe(true);
    expect(fixture.session.request(route('generation-1').url, 'mainFrame', oldView.webContents.id)).toBe(false);
    expect(fixture.session.closedConnections).toBe(2);
    expect(fixture.session.clearedStorage).toEqual([
      {
        origin: route('generation-1').origin,
        storages: [
          'cookies',
          'filesystem',
          'indexdb',
          'localstorage',
          'serviceworkers',
          'cachestorage'
        ]
      }
    ]);
    expect(fixture.session.cacheClears).toBe(1);

    await lease.commit();
    expect(fixture.views).toHaveLength(1);
    expect(fixture.session.request(route('generation-2').url, 'mainFrame', oldView.webContents.id)).toBe(false);
  });

  it('does not create a first ready canvas for a background Design', async () => {
    const fixture = createFixture();
    fixture.host.attachWindow(fixture.window);
    const lease = await fixture.host.begin({
      designId: 'design-1',
      candidate: identity('generation-1')
    });

    await lease.commit();

    expect(fixture.views).toHaveLength(0);
    expect(fixture.window.added).toHaveLength(0);
    expect(fixture.session.request(route('generation-1').url, 'mainFrame', 1)).toBe(false);
  });

  it('attaches a first ready canvas when its bounds arrive during cutover', async () => {
    const fixture = createFixture();
    fixture.host.attachWindow(fixture.window);
    const lease = await fixture.host.begin({
      designId: 'design-1',
      candidate: identity('generation-1')
    });

    await fixture.host.show({
      designId: 'design-1', ...identity('generation-1'), requestId: 1,
      bounds: { x: 10, y: 20, width: 100, height: 80 }
    });
    expect(fixture.views).toHaveLength(0);
    await lease.commit();

    expect(fixture.views[0].webContents.loaded).toEqual([route('generation-1').url]);
    expect(fixture.views[0].bounds).toEqual({ x: 20, y: 40, width: 200, height: 160 });
    expect(fixture.window.added).toEqual([fixture.views[0]]);
  });

  it('restores the recorded old route after a failed durable settlement', async () => {
    const fixture = createFixture();
    fixture.host.attachWindow(fixture.window);
    await showFirst(fixture);

    const lease = await fixture.host.begin({
      designId: 'design-1',
      candidate: identity('generation-2'),
      replaced: identity('generation-1')
    });
    await lease.rollback();

    expect(fixture.views.at(-1)?.webContents.loaded).toEqual([route('generation-1').url]);
    expect(fixture.views.at(-1)?.bounds).toEqual({ x: 0, y: 0, width: 200, height: 200 });
    expect(fixture.window.added.at(-1)).toBe(fixture.views.at(-1));
    expect(fixture.session.request('https://example.com/candidate.js', 'script', 1)).toBe(false);
    expect(fixture.session.request(route('generation-1').url, 'mainFrame', fixture.views.at(-1)?.webContents.id)).toBe(true);
  });

  it('stays denied when service-worker cleanup cannot finish', async () => {
    const fixture = createFixture({ workerStopTimeoutMs: 2, workerPollIntervalMs: 1 });
    fixture.host.attachWindow(fixture.window);
    await showFirst(fixture);
    fixture.session.workers = {
      1: { scope: `${route('generation-1').origin}/worker/` }
    };

    await expect(
      fixture.host.begin({
        designId: 'design-1',
        candidate: identity('generation-2'),
        replaced: identity('generation-1')
      })
    ).rejects.toThrow('service-worker cleanup timed out');
    expect(fixture.session.request(route('generation-1').url, 'mainFrame', 1)).toBe(false);
    expect(fixture.views[0].webContents.closed).toBe(true);
    expect(fixture.events).toContainEqual(
      expect.objectContaining({
        type: 'load-failed',
        generationId: 'generation-2'
      })
    );

    fixture.session.workers = {};
    const retry = await fixture.host.begin({
      designId: 'design-1',
      candidate: identity('generation-2'),
      replaced: identity('generation-1')
    });
    await retry.rollback();
    expect(fixture.views.at(-1)?.webContents.loaded).toEqual([route('generation-1').url]);
  });

  it('applies the latest renderer bounds after a core cutover fence commits', async () => {
    const fixture = createFixture();
    fixture.host.attachWindow(fixture.window);
    await showFirst(fixture);
    const lease = await fixture.host.begin({
      designId: 'design-1',
      candidate: identity('generation-2'),
      replaced: identity('generation-1')
    });

    await fixture.host.show({
      designId: 'design-1', ...identity('generation-2'), requestId: 2,
      bounds: { x: 10, y: 20, width: 100, height: 80 }
    });

    expect(fixture.views).toHaveLength(1);
    expect(fixture.session.request(route('generation-1').url, 'mainFrame', 1)).toBe(false);
    await lease.commit();
    expect(fixture.views.at(-1)?.webContents.loaded).toEqual([route('generation-2').url]);
    expect(fixture.views.at(-1)?.bounds).toEqual({ x: 20, y: 40, width: 200, height: 160 });
    expect(fixture.window.added.at(-1)).toBe(fixture.views.at(-1));
  });

  it('re-resolves one candidate identity when it becomes the stable Ready route', async () => {
    let ready = false;
    const fixture = createFixture({}, async (input) => {
      const origin = ready
        ? 'http://ready-design.localhost:4000'
        : 'http://candidate-design.localhost:4000';
      return { ...input, url: `${origin}/`, origin };
    });
    fixture.host.attachWindow(fixture.window);
    await fixture.host.show({
      designId: 'design-1',
      ...identity('generation-2'),
      requestId: 1,
      bounds: { x: 0, y: 0, width: 100, height: 100 }
    });
    expect(fixture.views[0]?.webContents.loaded).toEqual([
      'http://candidate-design.localhost:4000/'
    ]);

    const lease = await fixture.host.begin({
      designId: 'design-1',
      candidate: identity('generation-2'),
      replaced: identity('generation-1')
    });
    ready = true;
    await lease.commit();

    expect(fixture.views.at(-1)?.webContents.loaded).toEqual([
      'http://ready-design.localhost:4000/'
    ]);
    expect(fixture.session.clearedStorage).toContainEqual(
      expect.objectContaining({ origin: 'http://candidate-design.localhost:4000' })
    );
  });

  it('does not attach a queued canvas after a newer renderer hide request', async () => {
    const fixture = createFixture();
    fixture.host.attachWindow(fixture.window);
    await showFirst(fixture);
    const lease = await fixture.host.begin({
      designId: 'design-1',
      candidate: identity('generation-2'),
      replaced: identity('generation-1')
    });

    await fixture.host.show({
      designId: 'design-1', ...identity('generation-2'), requestId: 2,
      bounds: { x: 10, y: 20, width: 100, height: 80 }
    });
    fixture.host.hide({ designId: 'design-1', requestId: 3 });
    await lease.commit();

    expect(fixture.views).toHaveLength(1);
    expect(fixture.views[0].webContents.closed).toBe(true);
    expect(fixture.session.request(route('generation-2').url, 'mainFrame', 1)).toBe(false);
    expect(fixture.window.added).toHaveLength(1);
  });

  it('destroys and denies the previous Design when another Design is shown', async () => {
    const fixture = createFixture();
    fixture.host.attachWindow(fixture.window);
    await showFirst(fixture);
    const firstView = fixture.views[0];
    const second = { taskId: 'design-2', generationId: 'generation-2', routeId: 'app' };

    await fixture.host.show({
      designId: 'design-2', ...second, requestId: 2,
      bounds: { x: 10, y: 20, width: 100, height: 80 }
    });

    expect(firstView.webContents.closed).toBe(true);
    expect(firstView.visible).toBe(false);
    expect(fixture.window.removed).toContain(firstView);
    expect(fixture.sessions[0].request(route('generation-1').url, 'mainFrame', firstView.webContents.id)).toBe(false);
    expect(fixture.views[1].webContents.loaded).toEqual([resolvedRoute(second).url]);
    expect(fixture.views[1].visible).toBe(true);
    expect(fixture.sessions[1].request(resolvedRoute(second).url, 'mainFrame', fixture.views[1].webContents.id)).toBe(true);
  });

  it('keeps the newest bounds when renderer show requests overlap activation', async () => {
    const fixture = createFixture();
    fixture.host.attachWindow(fixture.window);

    const firstShow = fixture.host.show({
      designId: 'design-1', ...identity('generation-1'), requestId: 1,
      bounds: { x: 5, y: 10, width: 80, height: 60 }
    });
    await fixture.host.show({
      designId: 'design-1', ...identity('generation-1'), requestId: 2,
      bounds: { x: 10, y: 20, width: 100, height: 80 }
    });
    await firstShow;

    expect(fixture.views).toHaveLength(1);
    expect(fixture.views[0].bounds).toEqual({ x: 20, y: 40, width: 200, height: 160 });
    expect(fixture.window.added).toEqual([fixture.views[0]]);
  });

  it('keeps new renderer bounds when a reset reuses the request sequence', async () => {
    const fixture = createFixture();
    fixture.host.attachWindow(fixture.window);

    const oldRendererShow = fixture.host.show({
      designId: 'design-1', ...identity('generation-1'), requestId: 1,
      bounds: { x: 5, y: 10, width: 80, height: 60 }
    });
    fixture.window.listeners.get('did-start-navigation')?.();
    await fixture.host.show({
      designId: 'design-1', ...identity('generation-1'), requestId: 1,
      bounds: { x: 10, y: 20, width: 100, height: 80 }
    });
    await oldRendererShow;

    expect(fixture.views).toHaveLength(1);
    expect(fixture.views[0].bounds).toEqual({ x: 20, y: 40, width: 200, height: 160 });
    expect(fixture.window.added).toEqual([fixture.views[0]]);
  });

  it('denies navigation and opens an approved HTTPS destination by pending ID', async () => {
    const fixture = createFixture();
    fixture.host.attachWindow(fixture.window);
    await showFirst(fixture);
    const contents = fixture.views[0].webContents;

    const navigation = {
      preventDefault: vi.fn(),
      url: 'file:///tmp/private',
      isMainFrame: true
    };
    contents.navigate?.(navigation);
    expect(navigation.preventDefault).toHaveBeenCalledOnce();

    expect(contents.openWindow?.({ url: 'https://old.example.com/docs' })).toEqual({ action: 'deny' });
    const firstRequest = fixture.events.find((event) => event.type === 'external-link-requested');
    expect(contents.openWindow?.({ url: 'https://example.com/docs' })).toEqual({ action: 'deny' });
    const requested = fixture.events.at(-1);
    expect(requested).toMatchObject({ destinationHost: 'example.com' });
    if (
      !firstRequest || firstRequest.type !== 'external-link-requested' ||
      !requested || requested.type !== 'external-link-requested'
    ) {
      throw new Error('missing event');
    }
    fixture.host.hide({ designId: 'design-1', requestId: 2 });
    expect(contents.closed).toBe(true);
    expect(fixture.session.request(route('generation-1').url, 'mainFrame', contents.id)).toBe(false);
    await expect(
      fixture.host.approveExternal({ designId: 'design-1', pendingId: firstRequest.pendingId })
    ).resolves.toBe(false);
    await expect(
      fixture.host.approveExternal({ designId: 'design-1', pendingId: requested.pendingId })
    ).resolves.toBe(true);
    expect(fixture.externalUrls).toEqual(['https://example.com/docs']);
  });

  it('uses the current Electron frame-navigation event and hides an exited generation', async () => {
    const fixture = createFixture();
    fixture.host.attachWindow(fixture.window);
    await showFirst(fixture);
    const view = fixture.views[0];
    const navigation = {
      preventDefault: vi.fn(),
      url: 'https://example.com/from-frame',
      isMainFrame: true
    };

    expect(() => view.webContents.frameNavigate?.(navigation)).not.toThrow();
    expect(navigation.preventDefault).toHaveBeenCalledOnce();
    expect(fixture.events).toContainEqual(
      expect.objectContaining({
        type: 'external-link-requested',
        destinationHost: 'example.com'
      })
    );

    fixture.host.handleGenerationUnavailable('generation-1');
    expect(view.visible).toBe(false);
    expect(view.webContents.closed).toBe(true);
    expect(
      fixture.session.request(route('generation-1').url, 'mainFrame', view.webContents.id)
    ).toBe(false);
  });

  it('destroys and denies a view with invalid bounds', async () => {
    const fixture = createFixture();
    fixture.host.attachWindow(fixture.window);
    await showFirst(fixture);
    const view = fixture.views[0];

    await fixture.host.show({
      designId: 'design-1', taskId: 'design-1', generationId: 'generation-1', routeId: 'app',
      requestId: 2, bounds: { x: Number.NaN, y: 0, width: 10, height: 10 }
    });
    expect(view.visible).toBe(false);
    expect(view.webContents.closed).toBe(true);
    expect(fixture.session.request(route('generation-1').url, 'mainFrame', view.webContents.id)).toBe(false);
    await fixture.host.show({
      designId: 'design-1', taskId: 'design-1', generationId: 'generation-1', routeId: 'app',
      requestId: 1, bounds: { x: 0, y: 0, width: 50, height: 50 }
    });
    expect(view.visible).toBe(false);

    fixture.window.close();
    expect(view.webContents.closed).toBe(true);
  });

  it('accepts a fresh request sequence after a window is reopened', async () => {
    const fixture = createFixture();
    fixture.host.attachWindow(fixture.window);
    await fixture.host.show({
      designId: 'design-1', ...identity('generation-1'), requestId: 20,
      bounds: { x: 0, y: 0, width: 100, height: 100 }
    });
    fixture.window.close();

    const reopened = new FakeWindow();
    fixture.host.attachWindow(reopened);
    await fixture.host.show({
      designId: 'design-1', ...identity('generation-1'), requestId: 0,
      bounds: { x: 0, y: 0, width: 100, height: 100 }
    });

    expect(fixture.views.at(-1)?.webContents.loaded).toEqual([route('generation-1').url]);
    expect(reopened.added).toEqual([fixture.views.at(-1)]);
  });

  it('releases a deleted Design session after secure cleanup', async () => {
    const fixture = createFixture();
    fixture.host.attachWindow(fixture.window);
    await showFirst(fixture);

    await fixture.host.close('design-1');

    expect(fixture.views[0].webContents.closed).toBe(true);
    expect(fixture.session.beforeRequest).toBeUndefined();
    expect(fixture.session.checkPermission).toBeUndefined();
    expect(fixture.session.requestPermission).toBeUndefined();
    expect(fixture.session.devicePermission).toBeUndefined();
    expect(fixture.session.download).toBeUndefined();
    expect(
      (fixture.host as unknown as { sessions: Map<string, unknown> }).sessions.size
    ).toBe(0);
  });

  it('keeps a failed session cleanup denied and retryable', async () => {
    const fixture = createFixture({
      workerStopTimeoutMs: 2,
      workerPollIntervalMs: 1
    });
    fixture.host.attachWindow(fixture.window);
    await showFirst(fixture);
    fixture.session.workers = {
      1: { scope: `${route('generation-1').origin}/worker/` }
    };

    await expect(fixture.host.close('design-1')).rejects.toThrow(
      'service-worker cleanup timed out'
    );
    expect(fixture.session.beforeRequest).toBeDefined();
    expect(
      fixture.session.request(route('generation-1').url, 'mainFrame', 1)
    ).toBe(false);
    expect(
      (fixture.host as unknown as { sessions: Map<string, unknown> }).sessions.size
    ).toBe(1);

    fixture.session.workers = {};
    await fixture.host.close('design-1');
    expect(
      (fixture.host as unknown as { sessions: Map<string, unknown> }).sessions.size
    ).toBe(0);
  });
});

describe('normalizeDesignCanvasBounds', () => {
  it('scales, rounds, and clamps renderer CSS bounds', () => {
    expect(
      normalizeDesignCanvasBounds(
        { x: -4.4, y: 2.2, width: 100.3, height: 40.2 },
        1.5,
        { width: 120, height: 80 }
      )
    ).toEqual({ x: 0, y: 3, width: 120, height: 61 });
    expect(
      normalizeDesignCanvasBounds(
        { x: 500, y: 500, width: 20, height: 20 },
        1,
        { width: 100, height: 100 }
      )
    ).toBeUndefined();
  });
});

function identity(generationId: string) {
  return { taskId: 'design-1', generationId, routeId: 'app' };
}

function route(generationId: string): DesignCanvasResolvedRoute {
  return resolvedRoute(identity(generationId));
}

function resolvedRoute(identity: {
  taskId: string;
  generationId: string;
  routeId: string;
}): DesignCanvasResolvedRoute {
  const origin = `http://${identity.routeId}.${identity.taskId}.preview.localhost:4000`;
  return { ...identity, url: `${origin}/`, origin };
}

async function showFirst(fixture: ReturnType<typeof createFixture>): Promise<void> {
  await fixture.host.show({
    designId: 'design-1', ...identity('generation-1'), requestId: 1,
    bounds: { x: 0, y: 0, width: 100, height: 100 }
  });
}

function createFixture(
  timing: { workerStopTimeoutMs?: number; workerPollIntervalMs?: number } = {},
  resolveRoute: (
    identity: DesignCanvasRouteIdentity
  ) => Promise<DesignCanvasResolvedRoute> = async (input) => resolvedRoute(input)
) {
  const partitions: string[] = [];
  const viewOptions: Array<Record<string, unknown>> = [];
  const views: FakeView[] = [];
  const events: DesignCanvasHostEvent[] = [];
  const externalUrls: string[] = [];
  const session = new FakeSession();
  const sessions = [session];
  const window = new FakeWindow();
  let now = 1_000;
  const runtime: DesignCanvasRuntime = {
    sessionForPartition(partition) {
      partitions.push(partition);
      if (partitions.length === 1) return session as never;
      const next = new FakeSession();
      sessions.push(next);
      return next as never;
    },
    createView(options) {
      viewOptions.push(options.webPreferences as unknown as Record<string, unknown>);
      const view = new FakeView(views.length + 1);
      views.push(view);
      return view as never;
    },
    async openExternal(url) { externalUrls.push(url); },
    async wait(milliseconds) { now += milliseconds; },
    now() { return now; }
  };
  const host = new DesignCanvasHost({
    runtime,
    resolveRoute,
    emit(event) { events.push(event); },
    ...timing
  });
  return {
    host, runtime, session, sessions, window, partitions, viewOptions, views, events, externalUrls
  };
}

class FakeSession {
  beforeRequest?: (
    details: { url: string; resourceType?: string; webContentsId?: number },
    callback: (result: { cancel: boolean }) => void
  ) => void;
  checkPermission?: () => boolean;
  requestPermission?: (contents: unknown, permission: string, callback: (allowed: boolean) => void) => void;
  devicePermission?: () => boolean;
  download?: (event: { preventDefault(): void }) => void;
  closedConnections = 0;
  clearedStorage: Array<{ origin: string; storages: string[] }> = [];
  cacheClears = 0;
  workers: Record<number, { scope?: string; scriptURL?: string }> = {};
  webRequest = {
    onBeforeRequest: (
      _filter: { urls: string[] },
      listener: FakeSession['beforeRequest'] | null
    ) => { this.beforeRequest = listener ?? undefined; }
  };
  serviceWorkers = { getAllRunning: () => this.workers };
  setPermissionCheckHandler(handler: (() => boolean) | null) {
    this.checkPermission = handler ?? undefined;
  }
  setPermissionRequestHandler(handler: FakeSession['requestPermission'] | null) {
    this.requestPermission = handler ?? undefined;
  }
  setDevicePermissionHandler(handler: (() => boolean) | null) {
    this.devicePermission = handler ?? undefined;
  }
  on(_event: 'will-download', listener: FakeSession['download']) { this.download = listener; }
  off(_event: 'will-download', listener: FakeSession['download']) {
    if (this.download === listener) this.download = undefined;
  }
  async closeAllConnections() { this.closedConnections += 1; }
  async clearStorageData(options: { origin: string; storages: string[] }) {
    this.clearedStorage.push(options);
  }
  async clearCache() { this.cacheClears += 1; }
  request(url: string, resourceType: string, webContentsId?: number): boolean {
    let allowed = false;
    this.beforeRequest?.({ url, resourceType, webContentsId }, (result) => {
      allowed = !result.cancel;
    });
    return allowed;
  }
}

class FakeWebContents {
  readonly loaded: string[] = [];
  readonly handlers = new Map<string, (event: FakeNavigationEvent) => void>();
  openWindow?: (details: { url: string }) => { action: 'deny' };
  closed = false;
  constructor(readonly id: number) {}
  isDestroyed() { return this.closed; }
  close() { this.closed = true; }
  async loadURL(url: string) { this.loaded.push(url); }
  reload() { this.loaded.push(this.loaded.at(-1) ?? ''); }
  getURL() { return this.loaded.at(-1) ?? ''; }
  setWindowOpenHandler(handler: FakeWebContents['openWindow']) { this.openWindow = handler; }
  on(event: string, listener: (event: FakeNavigationEvent) => void) {
    this.handlers.set(event, listener);
  }
  navigate(event: FakeNavigationEvent) {
    this.handlers.get('will-navigate')?.(event);
  }
  frameNavigate(event: FakeNavigationEvent) {
    this.handlers.get('will-frame-navigate')?.(event);
  }
}

interface FakeNavigationEvent {
  preventDefault(): void;
  url: string;
  isMainFrame: boolean;
}

class FakeView {
  readonly webContents: FakeWebContents;
  bounds?: { x: number; y: number; width: number; height: number };
  visible = false;
  constructor(id: number) { this.webContents = new FakeWebContents(id); }
  setBounds(bounds: { x: number; y: number; width: number; height: number }) { this.bounds = bounds; }
  setVisible(visible: boolean) { this.visible = visible; }
}

class FakeWindow {
  readonly added: FakeView[] = [];
  readonly removed: FakeView[] = [];
  readonly listeners = new Map<string, () => void>();
  destroyed = false;
  contentView = {
    addChildView: (view: FakeView) => { this.added.push(view); },
    removeChildView: (view: FakeView) => { this.removed.push(view); }
  };
  webContents = {
    getZoomFactor: () => 2,
    on: (event: string, listener: () => void) => { this.listeners.set(event, listener); },
    off: (event: string, listener: () => void) => {
      if (this.listeners.get(event) === listener) this.listeners.delete(event);
    }
  };
  isDestroyed() { return this.destroyed; }
  getContentBounds() { return { width: 500, height: 400 }; }
  on(event: string, listener: () => void) { this.listeners.set(event, listener); }
  off(event: string, listener: () => void) {
    if (this.listeners.get(event) === listener) this.listeners.delete(event);
  }
  close() {
    this.destroyed = true;
    this.listeners.get('closed')?.();
  }
}
