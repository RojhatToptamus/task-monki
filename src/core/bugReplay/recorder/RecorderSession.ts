import {
  BUG_RECORDING_LIMITS,
  BUG_RECORDING_SCHEMA,
  parseBugRecordingTarget,
  type BugRecordingAction,
  type BugRecordingConsoleEntry,
  type BugRecordingLogV1,
  type BugRecordingPick,
  type BugRecordingRequest
} from '../../../shared/bugRecording';
import type { BugCaseEnvironment } from '../../../shared/bugCase';
import { isGatewaySignature } from '../runner/protocol';
import { RECORDER_BINDING, RECORDER_SCRIPT, RECORDER_WORLD } from './recorderScript';

/**
 * Turns one browser's DevTools protocol into a `bug-recording/v1` log: the isolated-world
 * recorder's actions, the page's requests with the bodies a value check may need, console
 * errors, navigations and dialogs. It speaks to any CDP connection, so Electron's in-app view and
 * a headless browser in tests share it.
 */

export interface CdpConnection {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  onEvent(listener: (method: string, params: Record<string, unknown>, sessionId?: string) => void): () => void;
}

export type RecorderNotice =
  | { kind: 'activity' }
  | { kind: 'route'; path: string }
  | { kind: 'coverage'; note: string }
  | { kind: 'password' }
  | { kind: 'ready'; title: string };

interface PendingRequest {
  entry: BugRecordingRequest;
  startedAt: number;
  json: boolean;
}

const BODY_RING = 60;
/** UTF-8 bytes of recorded actions; below the stored action log's 2 MiB limit with room for the array. */
const MAX_LOG_BYTES = 1536 * 1024;

export class RecorderSession {
  private readonly started = Date.now();
  private readonly actions: BugRecordingAction[] = [];
  private readonly requests = new Map<string, PendingRequest>();
  private readonly finished: BugRecordingRequest[] = [];
  private readonly consoleEntries: BugRecordingConsoleEntry[] = [];
  private readonly blockedHosts = new Map<string, number>();
  private readonly coverageReasons: string[] = [];
  private readonly bodyRequests: string[] = [];
  private readonly originRoles = new Map<string, string>();
  private readonly isolatedContexts = new Map<string, number>();
  /** The top frame; a same-origin iframe's recorder world must never stand in for it. */
  private mainFrameId?: string;
  private unsubscribe?: () => void;
  private pickResolve?: (pick: BugRecordingPick | undefined) => void;
  private sealedMark?: BugRecordingLogV1['mark'];
  private pageTitle = '';
  private location = { role: 'primary', path: '/', query: [] as Array<[string, string]> };
  private complete = true;
  private dialogType: 'alert' | 'confirm' | 'prompt' | 'beforeunload' = 'confirm';
  private bytes = 0;
  private closed = false;

  constructor(
    private readonly cdp: CdpConnection,
    private readonly origins: Record<string, string>,
    private readonly environment: BugCaseEnvironment,
    private readonly notify: (notice: RecorderNotice) => void
  ) {
    for (const [role, origin] of Object.entries(origins)) this.originRoles.set(new URL(origin).host, role);
  }

  /** Installs the recorder and the protocol domains before the first page loads. */
  async attach(): Promise<void> {
    this.unsubscribe = this.cdp.onEvent((method, params, sessionId) => this.onEvent(method, params, sessionId));
    await this.setupTarget(undefined);
    // Embedded frames from other origins get the recorder too, so input there is reported as
    // something a clean run cannot replay instead of going unnoticed.
    await this.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => undefined);
  }

  private async setupTarget(sessionId: string | undefined): Promise<void> {
    const send = (method: string, params?: Record<string, unknown>) => this.cdp.send(method, params, sessionId);
    await send('Runtime.addBinding', { name: RECORDER_BINDING, executionContextName: RECORDER_WORLD });
    await send('Page.enable');
    if (!sessionId) {
      const tree = (await send('Page.getFrameTree').catch(() => undefined)) as { frameTree?: { frame?: { id?: string } } } | undefined;
      this.mainFrameId = tree?.frameTree?.frame?.id;
    }
    await send('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER_SCRIPT, worldName: RECORDER_WORLD, runImmediately: true });
    await send('Runtime.enable');
    await send('Network.enable', { maxTotalBufferSize: 10_000_000, maxResourceBufferSize: 1_000_000 });
    await send('Log.enable').catch(() => undefined);
  }

  /**
   * Sets the page's CSS viewport so resizing the window never changes the layout being recorded.
   * `scale` fits the pinned viewport into a smaller view; `nativeDensity` keeps the screen's own
   * pixel density so text stays sharp while the layout stays the case's.
   */
  async pinViewport(options: { scale?: number; nativeDensity?: boolean } = {}): Promise<void> {
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: this.environment.viewport.width,
      height: this.environment.viewport.height,
      deviceScaleFactor: options.nativeDensity ? 0 : this.environment.deviceScaleFactor,
      mobile: false,
      ...(options.scale !== undefined && options.scale !== 1 ? { scale: options.scale } : {})
    });
  }

  /** The action that opens the start page: the clean start every case begins with. */
  noteStart(path: string, query: Array<[string, string]>, role = 'primary'): void {
    this.location = { role, path, query };
    this.pushAction({ kind: 'navigate', location: { role, path, query } });
  }

  noteReload(): void {
    this.pushAction({ kind: 'reload' });
  }

  noteCoverage(reason: string): void {
    if (!this.coverageReasons.includes(reason)) this.coverageReasons.push(reason.slice(0, 240));
    this.notify({ kind: 'coverage', note: reason });
  }

  markIncomplete(reason: string): void {
    this.complete = false;
    this.noteCoverage(reason);
  }

  noteBlocked(host: string): void {
    this.blockedHosts.set(host, (this.blockedHosts.get(host) ?? 0) + 1);
  }

  get title(): string {
    return this.pageTitle;
  }

  /** Seals the marked window now: requests after this instant are not suggested. */
  seal(): BugRecordingLogV1['mark'] {
    const t = this.elapsed();
    const marked = [...this.actions].reverse().find((action) => action.kind !== 'dialog' && action.kind !== 'unsupported') ?? this.actions[0];
    this.sealedMark = {
      t,
      actionIndex: Math.max(0, this.actions.length - 1),
      window: { startT: marked?.t ?? 0, endT: t },
      location: { ...this.location, query: [...this.location.query] },
      picks: []
    };
    return this.sealedMark;
  }

  unseal(): void {
    this.sealedMark = undefined;
  }

  /** Lets the person point at an element; the click never reaches the page. */
  async pick(): Promise<BugRecordingPick | undefined> {
    const contextId = this.isolatedContexts.get('top');
    if (contextId === undefined) return undefined;
    this.pickResolve?.(undefined);
    const picked = new Promise<BugRecordingPick | undefined>((resolve) => {
      this.pickResolve = resolve;
    });
    await this.cdp.send('Runtime.evaluate', { expression: 'globalThis.__tmStartPick()', contextId });
    const pick = await picked;
    if (pick && this.sealedMark && this.sealedMark.picks.length < BUG_RECORDING_LIMITS.picks) this.sealedMark.picks.push(pick);
    return pick;
  }

  async cancelPick(): Promise<void> {
    const contextId = this.isolatedContexts.get('top');
    if (contextId !== undefined) await this.cdp.send('Runtime.evaluate', { expression: 'globalThis.__tmStopPick()', contextId }).catch(() => undefined);
    this.pickResolve?.(undefined);
    this.pickResolve = undefined;
  }

  async screenshot(): Promise<Buffer> {
    const result = (await this.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })) as { data: string };
    return Buffer.from(result.data, 'base64');
  }

  /** The log as recorded so far; with a sealed mark, JSON bodies of the marked window are kept. */
  log(): BugRecordingLogV1 {
    const mark = this.sealedMark;
    const windowStart = mark?.window.startT ?? Number.POSITIVE_INFINITY;
    const windowEnd = mark?.window.endT ?? Number.POSITIVE_INFINITY;
    const requests = [...this.finished, ...[...this.requests.values()].map((pending) => ({ ...pending.entry, outcome: 'pending' as const }))]
      .sort((left, right) => left.t - right.t)
      .map((request) => {
        const inWindow = request.t >= windowStart && request.t <= windowEnd;
        const copy: BugRecordingRequest = { ...request };
        if (!inWindow) {
          delete copy.requestJson;
          delete copy.responseJson;
        }
        return copy;
      });
    const actions = this.actions.map((action) => ({ ...action }));
    const log: BugRecordingLogV1 = {
      schema: BUG_RECORDING_SCHEMA,
      environment: this.environment,
      roles: ['primary', ...Object.keys(this.origins).filter((role) => role !== 'primary').sort()],
      actions,
      requests: requests.slice(-BUG_RECORDING_LIMITS.requests),
      console: this.consoleEntries.slice(-BUG_RECORDING_LIMITS.console),
      coverage: {
        complete: this.complete,
        reasons: [...this.coverageReasons],
        blockedHosts: [...this.blockedHosts.entries()].map(([host, count]) => ({ host, count })).slice(0, 64)
      }
    };
    if (mark) log.mark = { ...mark, picks: mark.picks.map((pick) => ({ ...pick })) };
    return log;
  }

  dispose(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.pickResolve?.(undefined);
  }

  private elapsed(): number {
    return Date.now() - this.started;
  }

  private pushAction(action: Omit<BugRecordingAction, 'index' | 't'>): void {
    const entry = { index: this.actions.length, t: this.elapsed(), ...action } as BugRecordingAction;
    const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (this.actions.length >= BUG_RECORDING_LIMITS.actions || this.bytes + bytes > MAX_LOG_BYTES) {
      if (this.complete) this.markIncomplete('The recording grew too long to replay');
      return;
    }
    this.bytes += bytes;
    this.actions.push(entry);
  }

  private onEvent(method: string, params: Record<string, unknown>, sessionId?: string): void {
    if (this.closed) return;
    if (sessionId && method.startsWith('Network.')) return;
    switch (method) {
      case 'Target.attachedToTarget': {
        const info = params.targetInfo as { type?: string } | undefined;
        const child = typeof params.sessionId === 'string' ? params.sessionId : undefined;
        if (child && info?.type === 'iframe') void this.setupTarget(child).catch(() => undefined);
        return;
      }
      case 'Page.javascriptDialogOpening':
        if (!sessionId) this.dialogType = (['alert', 'confirm', 'prompt', 'beforeunload'] as const).find((type) => type === params.type) ?? 'confirm';
        return;
      case 'Runtime.executionContextCreated': {
        const context = params.context as { id: number; name?: string; auxData?: { frameId?: string; isDefault?: boolean } };
        const topFrame = !this.mainFrameId || context.auxData?.frameId === this.mainFrameId;
        if (context.name === RECORDER_WORLD && !sessionId && topFrame) this.isolatedContexts.set('top', context.id);
        return;
      }
      case 'Runtime.executionContextsCleared':
        if (!sessionId) this.isolatedContexts.delete('top');
        return;
      case 'Runtime.bindingCalled':
        if (params.name === RECORDER_BINDING && typeof params.payload === 'string') this.onRecorderEvent(params.payload, sessionId);
        return;
      case 'Page.frameNavigated': {
        const frame = params.frame as { id?: string; parentId?: string; url?: string };
        if (frame.parentId || sessionId) return;
        if (frame.id) this.mainFrameId = frame.id;
        const url = safeUrl(frame.url);
        if (!url) return;
        const role = this.originRoles.get(url.host);
        if (!role) return;
        this.location = { role, path: url.pathname || '/', query: [...url.searchParams.entries()].slice(0, 32) };
        this.notify({ kind: 'route', path: url.pathname || '/' });
        return;
      }
      case 'Page.javascriptDialogClosed': {
        const result = params.result === true;
        const input = typeof params.userInput === 'string' ? params.userInput : undefined;
        if (sessionId) return;
        this.pushAction({ kind: 'dialog', dialog: { type: this.dialogType, action: result ? 'accept' : 'dismiss', ...(input ? { promptText: input.slice(0, 4096) } : {}) } });
        return;
      }
      case 'Network.requestWillBeSent':
        this.onRequest(params);
        return;
      case 'Network.responseReceived':
        this.onResponse(params);
        return;
      case 'Network.loadingFinished':
        this.onFinished(String(params.requestId));
        return;
      case 'Network.loadingFailed':
        this.onFailed(params);
        return;
      case 'Runtime.exceptionThrown': {
        const details = params.exceptionDetails as { text?: string; exception?: { description?: string } };
        this.pushConsole('exception', details.exception?.description ?? details.text ?? 'Uncaught exception');
        return;
      }
      case 'Runtime.consoleAPICalled': {
        const type = String(params.type);
        if (type !== 'error' && type !== 'warning') return;
        const args = (params.args as Array<{ value?: unknown; description?: string }>) ?? [];
        this.pushConsole(type === 'error' ? 'error' : 'warning', args.map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description ?? '')).join(' '));
        return;
      }
      case 'Log.entryAdded': {
        // Failed loads are in the request log, and console calls arrive through Runtime.
        const entry = params.entry as { level?: string; text?: string; source?: string };
        if (entry.level === 'error' && entry.source !== 'network' && entry.source !== 'console-api') this.pushConsole('error', entry.text ?? '');
        return;
      }
      default:
        return;
    }
  }

  private onRecorderEvent(payload: string, sessionId?: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }
    const childFrame = Boolean(sessionId) || event.frame === 'child';
    switch (event.type) {
      case 'ready':
        if (!childFrame) {
          this.pageTitle = String(event.title ?? '').slice(0, 200);
          this.notify({ kind: 'ready', title: this.pageTitle });
        }
        return;
      case 'activity':
        this.notify({ kind: 'activity' });
        return;
      case 'unsupported': {
        const what = String(event.what ?? 'unsupported input').slice(0, 60);
        this.pushAction({ kind: 'unsupported', unsupported: what });
        this.noteCoverage(`Step ${this.stepCount()} can't be replayed (${what})`);
        return;
      }
      case 'pick': {
        const resolve = this.pickResolve;
        this.pickResolve = undefined;
        if (!resolve) return;
        if (event.cancelled) {
          resolve(undefined);
          return;
        }
        try {
          resolve({
            target: parseBugRecordingTarget(event.target),
            text: String(event.text ?? '').slice(0, 4000),
            ...(typeof event.value === 'string' ? { value: event.value.slice(0, 4096) } : {}),
            visible: event.visible === true,
            count: typeof event.count === 'number' && Number.isInteger(event.count) ? Math.max(0, Math.min(10_000, event.count)) : 1
          });
        } catch {
          resolve(undefined);
        }
        return;
      }
      case 'action': {
        if (childFrame && event.kind !== 'click') {
          this.pushAction({ kind: 'unsupported', unsupported: 'input inside an embedded frame' });
          this.noteCoverage(`Step ${this.stepCount()} can't be replayed (input inside an embedded frame)`);
          return;
        }
        if (childFrame) {
          this.pushAction({ kind: 'unsupported', unsupported: 'a click inside an embedded frame' });
          this.noteCoverage(`Step ${this.stepCount()} can't be replayed (a click inside an embedded frame)`);
          return;
        }
        let target;
        try {
          target = event.target === undefined ? undefined : parseBugRecordingTarget(event.target);
        } catch {
          return;
        }
        const kind = String(event.kind);
        if (kind === 'fill' && event.sensitive === true) this.notify({ kind: 'password' });
        if (kind === 'press') {
          this.pushAction({ kind: 'press', key: String(event.key) });
          return;
        }
        if (!['click', 'fill', 'select', 'check', 'uncheck'].includes(kind) || !target) return;
        this.pushAction({
          kind: kind as BugRecordingAction['kind'],
          target,
          ...(kind === 'fill' ? { value: String(event.value ?? '').slice(0, 4096), ...(event.sensitive === true ? { sensitive: true } : {}) } : {}),
          ...(kind === 'select' && Array.isArray(event.values) ? { values: (event.values as unknown[]).map((value) => String(value).slice(0, 4096)).slice(0, 32) } : {})
        });
        return;
      }
      default:
        return;
    }
  }

  private stepCount(): number {
    return this.actions.filter((action) => action.kind !== 'dialog').length;
  }

  private onRequest(params: Record<string, unknown>): void {
    const request = params.request as { url?: string; method?: string; postData?: string; hasPostData?: boolean };
    const url = safeUrl(request.url);
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return;
    const requestId = String(params.requestId);
    const role = this.originRoles.get(url.host);
    const resourceType = String(params.type ?? 'other').toLowerCase();
    const lastAction = this.actions.length - 1;
    const entry: BugRecordingRequest = {
      id: requestId,
      t: this.elapsed(),
      method: String(request.method ?? 'GET').toUpperCase(),
      path: url.pathname || '/',
      queryKeys: [...new Set(url.searchParams.keys())].sort().slice(0, 64),
      resourceType: ['fetch', 'xhr', 'document', 'eventsource', 'websocket', 'script', 'stylesheet', 'image', 'font'].includes(resourceType) ? resourceType : 'other',
      outcome: 'pending',
      fromServiceWorker: false,
      ...(role ? { role } : { host: url.hostname.slice(0, 255) }),
      ...(lastAction >= 0 ? { actionIndex: lastAction } : {})
    };
    const json = Boolean(role) && (resourceType === 'fetch' || resourceType === 'xhr');
    if (json && typeof request.postData === 'string' && request.postData.length <= BUG_RECORDING_LIMITS.bodyBytes) {
      const parsed = parseJson(request.postData);
      if (parsed !== undefined) entry.requestJson = parsed;
    }
    this.requests.set(requestId, { entry, startedAt: Date.now(), json });
  }

  private onResponse(params: Record<string, unknown>): void {
    const pending = this.requests.get(String(params.requestId));
    if (!pending) return;
    const response = params.response as { status?: number; mimeType?: string; fromServiceWorker?: boolean; headers?: Record<string, string> };
    pending.entry.status = typeof response.status === 'number' ? response.status : undefined;
    pending.entry.mimeType = (response.mimeType ?? '').slice(0, 128);
    pending.entry.fromServiceWorker = response.fromServiceWorker === true;
    pending.json = pending.json && (response.mimeType ?? '').includes('json');
    const headers = lowerCaseHeaders(response.headers ?? {});
    if ([400, 421, 502, 503, 508].includes(pending.entry.status ?? 0) && headers['content-type'] === 'text/plain; charset=utf-8') {
      void this.cdp.send('Network.getResponseBody', { requestId: String(params.requestId) }).then((body) => {
        const text = (body as { body?: string; base64Encoded?: boolean }).body ?? '';
        if (isGatewaySignature(pending.entry.status ?? 0, headers['content-type'], headers['cache-control'], text)) pending.entry.gateway = true;
      }, () => undefined);
    }
  }

  private onFinished(requestId: string): void {
    const pending = this.requests.get(requestId);
    if (!pending) return;
    this.requests.delete(requestId);
    pending.entry.outcome = 'response';
    pending.entry.durationMs = Date.now() - pending.startedAt;
    this.finished.push(pending.entry);
    if (pending.json) {
      this.bodyRequests.push(requestId);
      if (this.bodyRequests.length > BODY_RING) {
        const dropped = this.bodyRequests.shift();
        const old = this.finished.find((request) => request.id === dropped);
        if (old) delete old.responseJson;
      }
      void this.cdp.send('Network.getResponseBody', { requestId }).then((body) => {
        const result = body as { body?: string; base64Encoded?: boolean };
        if (!result.body || result.base64Encoded || result.body.length > BUG_RECORDING_LIMITS.bodyBytes) return;
        const parsed = parseJson(result.body);
        if (parsed !== undefined) pending.entry.responseJson = parsed;
      }, () => undefined);
    }
    this.trim();
  }

  private onFailed(params: Record<string, unknown>): void {
    const requestId = String(params.requestId);
    const pending = this.requests.get(requestId);
    if (!pending) return;
    this.requests.delete(requestId);
    const blocked = typeof params.blockedReason === 'string' || String(params.errorText ?? '').includes('BLOCKED_BY_CLIENT');
    pending.entry.outcome = blocked ? 'blocked' : pending.entry.status !== undefined ? 'response' : 'failed';
    pending.entry.durationMs = Date.now() - pending.startedAt;
    if (blocked && pending.entry.host) this.noteBlocked(pending.entry.host);
    this.finished.push(pending.entry);
    this.trim();
  }

  private trim(): void {
    if (this.finished.length > BUG_RECORDING_LIMITS.requests) this.finished.splice(0, this.finished.length - BUG_RECORDING_LIMITS.requests);
  }

  private pushConsole(level: BugRecordingConsoleEntry['level'], text: string): void {
    if (this.consoleEntries.length >= BUG_RECORDING_LIMITS.console) this.consoleEntries.shift();
    this.consoleEntries.push({ t: this.elapsed(), level, text: text.slice(0, BUG_RECORDING_LIMITS.consoleChars) });
  }
}

function safeUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function lowerCaseHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) result[key.toLowerCase()] = value;
  return result;
}

/**
 * The log as it is kept on disk: no request or response bodies, and no value typed into a password
 * field. The case keeps those values for replay; evidence never does.
 */
export function persistableLog(log: BugRecordingLogV1): BugRecordingLogV1 {
  return {
    ...log,
    actions: log.actions.map((action) => {
      if (!action.sensitive) return { ...action };
      const { value: _value, ...rest } = action;
      void _value;
      return rest;
    }),
    requests: log.requests.map((request) => {
      const copy: BugRecordingRequest = { ...request };
      delete copy.requestJson;
      delete copy.responseJson;
      return copy;
    })
  };
}
