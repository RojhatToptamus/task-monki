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
import type { BugRecordingTimeline, BugTimelineEntry } from '../../../shared/bugReplay';
import { compileSteps, describeStep } from '../BugCaseCompiler';
import { isGatewaySignature } from '../runner/protocol';
import { PICK_FACTS_CALL, RECORDER_BINDING, RECORDER_SCRIPT, RECORDER_WORLD } from './recorderScript';

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
  | { kind: 'ready'; title: string }
  /** A step, a failed request or a page error joined the live timeline. */
  | { kind: 'timeline' };

/** How pointing ended: the element the person picked, or none, with the reason when they need one. */
export type RecorderPickOutcome = { kind: 'picked'; pick: BugRecordingPick } | { kind: 'stopped'; reason?: string };

/** Expectations read the top page; an element inside an embedded frame is never picked. */
export const EMBEDDED_FRAME_PICK_REASON = "Elements in an embedded frame can't be picked";

interface PendingRequest {
  entry: BugRecordingRequest;
  startedAt: number;
  json: boolean;
}

interface Pointing {
  resolve(outcome: RecorderPickOutcome): void;
  /** Chrome reported the click; the element is being read. */
  picked: boolean;
}

const BODY_RING = 60;
/** Rows the live timeline sends; the steps count covers the rest. */
const TIMELINE_ROWS = 80;
/** UTF-8 bytes of recorded actions; below the stored action log's 2 MiB limit with room for the array. */
const MAX_LOG_BYTES = 1536 * 1024;
/**
 * What Chrome draws over the element under the pointer: the default theme's light `--accent-soft`
 * across its border box. The main process cannot read theme tokens, so the value is mirrored here.
 */
const POINTING_TINT = { r: 59, g: 91, b: 219, a: 0.12 };
const POINTING_HIGHLIGHT = {
  showInfo: false,
  showAccessibilityInfo: false,
  contentColor: POINTING_TINT,
  paddingColor: POINTING_TINT,
  borderColor: POINTING_TINT
};
const PICK_OBJECT_GROUP = 'tm-bug-pick';
/** The top target's key among the targets in inspect mode; a frame is keyed by its session. */
const TOP_TARGET = '';

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
  /** Embedded frames from other sites: each is its own target, and pointing covers them too. */
  private readonly frameSessions = new Set<string>();
  /**
   * Targets whose DOM and Overlay domains are on. They stay on: turning Overlay off would hand
   * the page the mouseup of the click that picked.
   */
  private readonly overlayTargets = new Set<string>();
  private unsubscribe?: () => void;
  private pointing?: Pointing;
  /** The picked node Chrome keeps highlighted until its numbered outline takes its place. */
  private heldNode?: number;
  /** Inspect mode changes run one at a time, each to the state pointing has when it runs. */
  private inspectSync: Promise<void> = Promise.resolve();
  private sealedMark?: BugRecordingLogV1['mark'];
  private pageTitle = '';
  private location = { role: 'primary', path: '/', query: [] as Array<[string, string]> };
  private complete = true;
  private dialogType: 'alert' | 'confirm' | 'prompt' | 'beforeunload' = 'confirm';
  private bytes = 0;
  private closed = false;
  /** The page's scroll when the capture's screenshot was taken; picks are placed against it. */
  /** The window's scroll when the capture's screenshot was taken; unknown, picks are not placed. */
  private shotScroll?: { x: number; y: number };

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
  /**
   * The start page, timed from when its load began (`t`, by default now), so what the page did
   * while it loaded belongs to the start step, as it does when a replay opens it.
   */
  noteStart(path: string, query: Array<[string, string]>, role = 'primary', t = this.elapsed()): void {
    this.location = { role, path, query };
    this.pushAction({ kind: 'navigate', location: { role, path, query } }, t);
  }

  /** The recording's clock, for timing a step from before the page work it causes. */
  now(): number {
    return this.elapsed();
  }

  noteReload(): void {
    this.pushAction({ kind: 'reload' });
  }

  /** Nothing was recorded after the start page yet. */
  onlyStart(): boolean {
    return this.actions.length === 1 && this.actions[0].kind === 'navigate';
  }

  /**
   * Moves the start to another page while nothing else was recorded; false once a step exists.
   * `t` is when that page's load began.
   */
  restartAt(path: string, query: Array<[string, string]>, role = 'primary', t = this.elapsed()): boolean {
    if (!this.onlyStart()) return false;
    const start = this.actions[0];
    const location = { role, path, query };
    this.actions[0] = { ...start, t: Math.max(0, Math.min(t, this.elapsed())), location };
    this.location = { role, path, query: [...query] };
    this.notify({ kind: 'timeline' });
    return true;
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
    // A new mark takes a new screenshot: the last one's scroll says nothing about it.
    this.shotScroll = undefined;
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

  /** Chrome's inspect mode takes the person's next click on the page. */
  get isPointing(): boolean {
    return Boolean(this.pointing);
  }

  /**
   * Lets the person point at an element with Chrome's own inspect mode. The browser draws the
   * highlight and takes the pointer before the page's input handling, so the page never sees,
   * blocks or forges a pick. A newer pick or `cancelPick` ends this one without an element.
   */
  async pick(): Promise<RecorderPickOutcome> {
    if (this.closed) return { kind: 'stopped' };
    if (this.pointing) this.endPointing(this.pointing, { kind: 'stopped' });
    this.heldNode = undefined;
    const outcome = new Promise<RecorderPickOutcome>((resolve) => {
      this.pointing = { resolve, picked: false };
    });
    void this.syncInspectMode();
    const result = await outcome;
    if (result.kind === 'picked' && this.sealedMark && this.sealedMark.picks.length < BUG_RECORDING_LIMITS.picks) this.sealedMark.picks.push(result.pick);
    return result;
  }

  /** Stop pointing without an element; returns once the page takes clicks again. */
  async cancelPick(): Promise<void> {
    if (this.pointing) this.endPointing(this.pointing, { kind: 'stopped' });
    if (this.heldNode !== undefined) {
      this.heldNode = undefined;
      void this.syncInspectMode();
    }
    await this.inspectSync;
  }

  /** Notes the page's scroll right before the capture's screenshot, so picks can be placed on it. */
  async noteShot(): Promise<void> {
    const contextId = this.isolatedContexts.get('top');
    if (contextId === undefined) return;
    const result = (await this.cdp.send('Runtime.evaluate', { expression: 'globalThis.__tmNoteShot()', contextId, returnByValue: true }).catch(() => undefined)) as
      | { result?: { value?: unknown } }
      | undefined;
    const value = result?.result?.value;
    if (Array.isArray(value) && value.every((item) => typeof item === 'number' && Number.isFinite(item))) {
      this.shotScroll = { x: value[0] as number, y: value[1] as number };
    }
  }

  /** Numbered outlines on the elements the expectations read; an empty list clears them. */
  async showMarks(marks: Array<{ css: string; label: string }>): Promise<void> {
    const contextId = this.isolatedContexts.get('top');
    if (contextId !== undefined) {
      const expression = marks.length
        ? `globalThis.__tmShowMarks && globalThis.__tmShowMarks(${JSON.stringify(JSON.stringify(marks.slice(0, 5)))})`
        : 'globalThis.__tmClearMarks && globalThis.__tmClearMarks()';
      await this.cdp.send('Runtime.evaluate', { expression, contextId }).catch(() => undefined);
    }
    // The pick's highlight gives way once its outline is drawn, or when there is none to draw.
    if (this.heldNode !== undefined) {
      this.heldNode = undefined;
      await this.syncInspectMode();
    }
  }

  /**
   * What was recorded so far, newest last: the steps a replay takes, inputs it can't replay, and
   * what the page did that a person looks for when a bug shows (failed or refused requests,
   * uncaught errors and console errors).
   */
  timeline(): BugRecordingTimeline {
    const compiled = compileSteps(this.actions);
    const rows: Array<BugTimelineEntry & { t: number; order: number }> = compiled.steps.map((step, index) => ({
      id: `s${index}`,
      kind: step.kind,
      text: describeStep(step),
      step: index + 1,
      t: compiled.times[index] ?? 0,
      order: 0
    }));
    for (const action of this.actions) {
      if (action.kind !== 'unsupported') continue;
      const what = action.unsupported ?? 'This input';
      rows.push({ id: `u${action.index}`, kind: 'unsupported', text: `${what.charAt(0).toUpperCase()}${what.slice(1)} can't be replayed`, tone: 'warning', t: action.t, order: 1 });
    }
    const blockedHosts = new Set<string>();
    for (const request of this.finished) {
      if (!request.role) {
        if (request.outcome !== 'blocked' || !request.host || blockedHosts.has(request.host)) continue;
        blockedHosts.add(request.host);
        rows.push({ id: `b${request.id}`, kind: 'request', text: `Blocked requests to ${request.host}`, tone: 'warning', t: request.t, order: 2 });
        continue;
      }
      const failed = request.outcome !== 'response' || request.gateway === true || (request.status !== undefined && request.status >= 400);
      if (!failed) continue;
      const answered = request.outcome === 'response' && !request.gateway && request.status !== undefined;
      const result = answered ? `returned ${request.status}` : 'got no response';
      // A 4xx is often what the app means to say; a server error or no answer is what a bug looks like.
      const serverFailed = !answered || (request.status ?? 0) >= 500;
      const path = request.path.length > 120 ? `${request.path.slice(0, 119)}…` : request.path;
      rows.push({ id: `r${request.id}`, kind: 'request', text: `${request.method} ${path} ${result}`, ...(serverFailed ? { tone: 'error' as const } : {}), t: request.t, order: 2 });
    }
    this.consoleEntries.forEach((entry, index) => {
      if (entry.level === 'warning') return;
      const line = entry.text.split('\n')[0].trim() || 'Uncaught error';
      rows.push({ id: `e${entry.t}-${index}`, kind: 'error', text: line.length > 160 ? `${line.slice(0, 159)}…` : line, tone: 'error', t: entry.t, order: 3 });
    });
    rows.sort((left, right) => left.t - right.t || left.order - right.order);
    // The recording begins at its start step: what a page it no longer starts on did is not shown.
    const startT = this.actions[0]?.t ?? 0;
    const recorded = rows.filter((row) => row.step !== undefined || row.t >= startT);
    const shown = recorded.slice(-TIMELINE_ROWS);
    return {
      entries: shown.map(({ t: _t, order: _order, ...entry }) => entry),
      steps: compiled.steps.length,
      omitted: recorded.length - shown.length
    };
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
    const pointing = this.pointing;
    this.pointing = undefined;
    pointing?.resolve({ kind: 'stopped' });
  }

  private elapsed(): number {
    return Date.now() - this.started;
  }

  private endPointing(pointing: Pointing, outcome: RecorderPickOutcome): void {
    if (this.pointing !== pointing) return;
    this.pointing = undefined;
    pointing.resolve(outcome);
    void this.syncInspectMode();
  }

  private syncInspectMode(): Promise<void> {
    this.inspectSync = this.inspectSync.then(() => this.applyInspectMode());
    return this.inspectSync;
  }

  private async applyInspectMode(): Promise<void> {
    if (this.closed) return;
    const pointing = this.pointing;
    const on = Boolean(pointing && !pointing.picked);
    const held = on ? undefined : this.heldNode;
    const [top] = await Promise.allSettled(
      [undefined, ...this.frameSessions].map((sessionId) => this.setInspectMode(sessionId, on, sessionId ? undefined : held))
    );
    // Without the top page in inspect mode no pick can arrive: pointing ends instead of waiting.
    if (on && pointing && top.status === 'rejected') this.endPointing(pointing, { kind: 'stopped' });
  }

  private async setInspectMode(sessionId: string | undefined, on: boolean, held?: number): Promise<void> {
    const key = sessionId ?? TOP_TARGET;
    if (!on && held === undefined && !this.overlayTargets.has(key)) return;
    const send = (method: string, params?: Record<string, unknown>) => this.cdp.send(method, params, sessionId);
    if (!this.overlayTargets.has(key)) {
      await send('DOM.enable');
      await send('Overlay.enable');
      this.overlayTargets.add(key);
    }
    await send('Overlay.setInspectMode', { mode: on ? 'searchForNode' : 'none', highlightConfig: on ? POINTING_HIGHLIGHT : {} });
    // After inspect mode, which would clear it: the pick stays highlighted until its outline shows.
    if (held !== undefined) await send('Overlay.highlightNode', { backendNodeId: held, highlightConfig: POINTING_HIGHLIGHT });
  }

  /** Reads the picked node's facts in the top frame's recorder world, which the page cannot reach. */
  private async readPick(backendNodeId: number, sessionId: string | undefined): Promise<RecorderPickOutcome> {
    // An embedded frame from another site is its own target.
    if (sessionId) return { kind: 'stopped', reason: EMBEDDED_FRAME_PICK_REASON };
    const contextId = this.isolatedContexts.get('top');
    if (contextId === undefined || !Number.isSafeInteger(backendNodeId)) return { kind: 'stopped' };
    try {
      const resolved = (await this.cdp.send('DOM.resolveNode', { backendNodeId, executionContextId: contextId, objectGroup: PICK_OBJECT_GROUP })) as {
        object?: { objectId?: string };
      };
      // A frame of another origin in the page's own process: the top page's world gets no handle.
      if (!resolved.object?.objectId) return { kind: 'stopped', reason: EMBEDDED_FRAME_PICK_REASON };
      const read = (await this.cdp.send('Runtime.callFunctionOn', {
        objectId: resolved.object.objectId,
        functionDeclaration: PICK_FACTS_CALL,
        returnByValue: true
      })) as { result?: { value?: unknown } };
      return this.pickFrom(read.result?.value);
    } catch {
      return { kind: 'stopped' };
    } finally {
      void this.cdp.send('Runtime.releaseObjectGroup', { objectGroup: PICK_OBJECT_GROUP }).catch(() => undefined);
    }
  }

  /** The facts the recorder world read off the picked element, checked like any recorder event. */
  private pickFrom(value: unknown): RecorderPickOutcome {
    if (!value || typeof value !== 'object') return { kind: 'stopped' };
    const facts = value as Record<string, unknown>;
    if (facts.frame === 'child') return { kind: 'stopped', reason: EMBEDDED_FRAME_PICK_REASON };
    try {
      const box = this.boxInShot(facts.box, facts.scroll, facts.placement);
      return {
        kind: 'picked',
        pick: {
          target: parseBugRecordingTarget(facts.target),
          text: String(facts.text ?? '').slice(0, 4000),
          ...(typeof facts.value === 'string' ? { value: facts.value.slice(0, 4096) } : {}),
          visible: facts.visible === true,
          count: typeof facts.count === 'number' && Number.isInteger(facts.count) ? Math.max(0, Math.min(10_000, facts.count)) : 1,
          ...(box ? { box } : {})
        }
      };
    } catch {
      return { kind: 'stopped' };
    }
  }

  private pushAction(action: Omit<BugRecordingAction, 'index' | 't'>, t = this.elapsed()): void {
    const entry = { index: this.actions.length, t, ...action } as BugRecordingAction;
    const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (this.actions.length >= BUG_RECORDING_LIMITS.actions || this.bytes + bytes > MAX_LOG_BYTES) {
      if (this.complete) this.markIncomplete('The recording grew too long to replay');
      return;
    }
    this.bytes += bytes;
    this.actions.push(entry);
    this.notify({ kind: 'timeline' });
  }

  private onEvent(method: string, params: Record<string, unknown>, sessionId?: string): void {
    if (this.closed) return;
    if (sessionId && method.startsWith('Network.')) return;
    switch (method) {
      case 'Target.attachedToTarget': {
        const info = params.targetInfo as { type?: string } | undefined;
        const child = typeof params.sessionId === 'string' ? params.sessionId : undefined;
        if (!child || info?.type !== 'iframe') return;
        this.frameSessions.add(child);
        void this.setupTarget(child).catch(() => undefined);
        // A frame that appears while the person points takes no click either.
        if (this.pointing) void this.syncInspectMode();
        return;
      }
      case 'Target.detachedFromTarget': {
        const child = typeof params.sessionId === 'string' ? params.sessionId : undefined;
        if (!child) return;
        this.frameSessions.delete(child);
        this.overlayTargets.delete(child);
        return;
      }
      case 'Overlay.inspectNodeRequested': {
        const pointing = this.pointing;
        if (!pointing || pointing.picked) return;
        // The first click is the pick; leaving inspect mode at once gives the page its clicks back,
        // while the element under it stays highlighted.
        const backendNodeId = Number(params.backendNodeId);
        pointing.picked = true;
        if (!sessionId && Number.isSafeInteger(backendNodeId)) this.heldNode = backendNodeId;
        void this.syncInspectMode();
        void this.readPick(backendNodeId, sessionId).then((outcome) => {
          if (outcome.kind === 'stopped' && this.heldNode === backendNodeId) this.heldNode = undefined;
          this.endPointing(pointing, outcome);
        });
        return;
      }
      case 'Overlay.inspectModeCanceled':
        // Escape inside the page.
        if (this.pointing) this.endPointing(this.pointing, { kind: 'stopped' });
        return;
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
        // Where the page is, as its bar shows it: the path with its query.
        this.notify({ kind: 'route', path: `${url.pathname || '/'}${url.search}`.slice(0, 512) });
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
        // A fill reaches the recorder once typing pauses; it is timed from the first keystroke, so
        // what the page did while the person typed belongs to it, as it does when a replay fills.
        const typedFor = kind === 'fill' && typeof event.typedForMs === 'number' && Number.isFinite(event.typedForMs)
          ? Math.min(Math.max(0, event.typedForMs), 60_000)
          : 0;
        const previous = this.actions[this.actions.length - 1]?.t ?? 0;
        this.pushAction({
          kind: kind as BugRecordingAction['kind'],
          target,
          ...(kind === 'fill' ? { value: String(event.value ?? '').slice(0, 4096), ...(event.sensitive === true ? { sensitive: true } : {}) } : {}),
          ...(kind === 'select' && Array.isArray(event.values) ? { values: (event.values as unknown[]).map((value) => String(value).slice(0, 4096)).slice(0, 32) } : {})
        }, Math.max(previous, this.elapsed() - typedFor));
        return;
      }
      default:
        return;
    }
  }

  /**
   * The picked element's box in the capture's screenshot: read at the pick, moved back by how far
   * the window and the scroll boxes around the element scrolled since the screenshot. A fixed
   * element ignores the window's scroll; a sticky one that anything scrolled under is not placed.
   * Absent when it lies outside the screenshot or the screenshot's scroll is unknown.
   */
  private boxInShot(value: unknown, scroll: unknown, around: unknown): BugRecordingPick['box'] {
    const shot = this.shotScroll;
    if (!shot) return undefined;
    const box = value as Record<string, unknown> | undefined;
    const at = scroll as Record<string, unknown> | undefined;
    const placement = around as { shift?: Record<string, unknown>; fixed?: unknown; sticky?: unknown } | undefined;
    const number = (item: unknown) => (typeof item === 'number' && Number.isFinite(item) ? item : undefined);
    const x = number(box?.x);
    const y = number(box?.y);
    const width = number(box?.width);
    const height = number(box?.height);
    if (x === undefined || y === undefined || width === undefined || height === undefined || width <= 0 || height <= 0) return undefined;
    const fixed = placement?.fixed === true;
    const dx = fixed ? 0 : (number(at?.x) ?? shot.x) - shot.x;
    const dy = fixed ? 0 : (number(at?.y) ?? shot.y) - shot.y;
    const shiftX = number(placement?.shift?.x) ?? 0;
    const shiftY = number(placement?.shift?.y) ?? 0;
    if (placement?.sticky === true && (dx !== 0 || dy !== 0 || shiftX !== 0 || shiftY !== 0)) return undefined;
    const placed = { x: x + dx + shiftX, y: y + dy + shiftY, width, height };
    const viewport = this.environment.viewport;
    const visible = placed.x < viewport.width && placed.y < viewport.height && placed.x + width > 0 && placed.y + height > 0;
    if (!visible) return undefined;
    const round = (item: number) => Math.round(item * 10) / 10;
    return { x: round(placed.x), y: round(placed.y), width: round(width), height: round(height) };
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
    if ((pending.entry.status ?? 0) >= 400) this.notify({ kind: 'timeline' });
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
    this.notify({ kind: 'timeline' });
  }

  private trim(): void {
    if (this.finished.length > BUG_RECORDING_LIMITS.requests) this.finished.splice(0, this.finished.length - BUG_RECORDING_LIMITS.requests);
  }

  private pushConsole(level: BugRecordingConsoleEntry['level'], text: string): void {
    if (this.consoleEntries.length >= BUG_RECORDING_LIMITS.console) this.consoleEntries.shift();
    this.consoleEntries.push({ t: this.elapsed(), level, text: text.slice(0, BUG_RECORDING_LIMITS.consoleChars) });
    if (level !== 'warning') this.notify({ kind: 'timeline' });
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
