import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Browser, BrowserContext, Dialog, Locator, Page, Request, Response } from 'playwright-core';
import {
  BUG_CASE_LIMITS,
  canonicalJson,
  isDomAssertion,
  normalizeVisibleText,
  pathMatchesTemplate,
  readJsonPointer,
  type BugCaseAssertion,
  type BugCaseEnvironment,
  type BugCaseStep,
  type BugCaseTarget,
  type BugCaseTargetCandidate,
  type BugCaseV1
} from '../../../shared/bugCase';
import {
  isGatewaySignature,
  type BugReplayDomObservation,
  type BugReplayFrame,
  type BugReplayRequestFact,
  type BugReplayRunPlan,
  type BugReplayStepFailureCode
} from './protocol';

/**
 * Interprets one `bug-case/v1` document in a fresh browser context and reports what it observed.
 * It never retries a failed step or check and never decides a verdict: core does that from the
 * frames, so the runner's only freedom is to report facts.
 */

export type FrameEmitter = (frame: BugReplayFrame) => void;

type DomAssertion = Extract<BugCaseAssertion, { kind: 'dom.text' | 'dom.value' | 'dom.visible' | 'dom.count' }>;

interface TrackedRequest {
  request: Request;
  startedAtMs: number;
  headersAtMs?: number;
  fact: BugReplayRequestFact;
  done: boolean;
  streaming: boolean;
}

const SAMPLE_INTERVAL_MS = 150;
const STEP_SETTLE_QUIET_MS = 300;
const STEP_SETTLE_CAP_MS = 5_000;
const STREAMING_GRACE_MS = 1_000;
const MAX_CANDIDATE_MATCHES = 50;

export async function interpretBugCase(browser: Browser, plan: BugReplayRunPlan, emit: FrameEmitter): Promise<{ steps: number; assertions: number }> {
  const document = plan.document;
  const started = Date.now();
  const at = () => Date.now() - started;
  const declaredOrigins = new Map<string, string>();
  for (const [role, origin] of Object.entries(plan.origins)) declaredOrigins.set(new URL(origin).origin, role);
  let screenshots = 0;
  let stepFrames = 0;
  let assertionFrames = 0;

  const screenshot = async (page: Page, purpose: 'failure' | 'final') => {
    if (screenshots >= plan.maxScreenshots || page.isClosed()) return;
    try {
      const bytes = await page.screenshot({ type: 'png', timeout: 5_000 });
      screenshots += 1;
      const name = `${purpose}-${screenshots}.png`;
      await fs.writeFile(path.join(plan.outDir, name), bytes, { mode: 0o600, flag: 'wx' });
      emit({ type: 'screenshot', name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, purpose });
    } catch {
      // A page that cannot be captured still has its observations.
    }
  };

  const context = await newContext(browser, document.environment, undefined);
  await guardContext(context, declaredOrigins, emit, at);
  const page = await context.newPage();
  const tracker = new NetworkTracker(page, declaredOrigins, plan, at);
  let crashed = false;
  page.on('crash', () => {
    crashed = true;
    emit({ type: 'signal', signal: 'renderer-crash', detail: 'The page crashed.', atMs: at() });
  });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => {
    if (pageErrors.length < 50) pageErrors.push(String(error?.message ?? error).slice(0, 500));
  });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) tracker.noteDocumentLoad();
  });
  const dialogs = new DialogArbiter(page);

  const steps = document.steps;
  const markedIndex = lastActionIndex(steps);
  let failed = false;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (index === markedIndex) tracker.markWindowStart();
    const result = await runStep(page, step, index, steps, plan, dialogs, tracker, emit, at);
    stepFrames += 1;
    if (crashed && result.status === 'done') {
      emit({ type: 'step', stepId: step.id, index, status: 'failed', failure: 'page-crashed', detail: 'The page crashed.', atMs: at() });
      failed = true;
      break;
    }
    emit({ type: 'step', stepId: step.id, index, ...result, atMs: at() });
    if (result.status === 'failed') {
      failed = true;
      await screenshot(page, 'failure');
      break;
    }
  }

  if (!failed && dialogs.unexpected > 0) {
    emit({ type: 'signal', signal: 'unexpected-dialog', detail: 'The page opened a dialog the recording did not have; it was dismissed.', atMs: at() });
  }
  if (!failed) {
    const domAssertions = document.assertions.filter(isDomAssertion);
    const window = await observeWindow(page, tracker, domAssertions, plan, at, () => crashed);
    emit({ type: 'window', phase: 'main', startedAtMs: window.startedAtMs, endedAtMs: window.endedAtMs, quiet: window.quiet });
    if (!window.quiet) emit({ type: 'signal', signal: 'network-never-quiet', detail: 'The network never went quiet.', atMs: at() });
    for (const hang of tracker.hangs(plan.timeouts.hangMs).slice(0, 10)) {
      emit({ type: 'signal', signal: 'hang', detail: `${hang.method} ${hang.path} had no response after ${Math.round((hang.pendingMs ?? 0) / 1000)} s.`, atMs: at() });
    }
    await tracker.settleBodies();
    const windowRequests = tracker.windowFacts();
    emit({ type: 'requests', phase: 'main', requests: windowRequests.slice(0, 200).map((fact) => reported(fact)) });
    for (const assertion of document.assertions) {
      emit({ type: 'assertion', assertionId: assertion.id, phase: 'main', observation: observationFor(assertion, window.dom, windowRequests, page, pageErrors, document) });
      assertionFrames += 1;
    }
    await screenshot(page, 'final');

    const reloadAssertions = domAssertions.filter((assertion) => assertion.alsoAfterReload);
    if (reloadAssertions.length > 0 && !crashed) {
      const url = page.url();
      const state = await context.storageState();
      await context.close();
      const reloadContext = await newContext(
        browser,
        document.environment,
        document.keepBrowserStorageAfterReload ? state : { cookies: state.cookies, origins: [] }
      );
      await guardContext(reloadContext, declaredOrigins, emit, at);
      const reloadPage = await reloadContext.newPage();
      const cdp = await reloadContext.newCDPSession(reloadPage);
      await withTimeout(cdp.send('Network.setCacheDisabled', { cacheDisabled: true }), 5_000, 'Disabling the cache timed out.');
      const reloadTracker = new NetworkTracker(reloadPage, declaredOrigins, plan, at);
      reloadPage.on('framenavigated', (frame) => {
        if (frame === reloadPage.mainFrame()) reloadTracker.noteDocumentLoad();
      });
      let reloadCrashed = false;
      reloadPage.on('crash', () => {
        reloadCrashed = true;
        emit({ type: 'signal', signal: 'renderer-crash', detail: 'The page crashed after reload.', atMs: at() });
      });
      reloadTracker.markWindowStart();
      let loaded = true;
      try {
        await reloadPage.goto(url, { waitUntil: 'load', timeout: plan.timeouts.navigationMs });
      } catch (error) {
        loaded = false;
        emit({ type: 'signal', signal: 'page-navigation', detail: `The reload failed: ${errorText(error)}`, atMs: at() });
      }
      const reloadWindow = await observeWindow(reloadPage, reloadTracker, reloadAssertions, plan, at, () => reloadCrashed || !loaded);
      emit({ type: 'window', phase: 'afterReload', startedAtMs: reloadWindow.startedAtMs, endedAtMs: reloadWindow.endedAtMs, quiet: reloadWindow.quiet });
      for (const assertion of reloadAssertions) {
        emit({
          type: 'assertion',
          assertionId: assertion.id,
          phase: 'afterReload',
          observation: reloadWindow.dom.get(assertion.id) ?? missingDom()
        });
        assertionFrames += 1;
      }
      await reloadContext.close().catch(() => undefined);
    } else {
      await context.close().catch(() => undefined);
    }
  } else {
    await context.close().catch(() => undefined);
  }
  return { steps: stepFrames, assertions: assertionFrames };
}

function lastActionIndex(steps: BugCaseStep[]): number {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index].kind !== 'dialog') return index;
  }
  return 0;
}

async function newContext(
  browser: Browser,
  environment: BugCaseEnvironment,
  storageState: Awaited<ReturnType<BrowserContext['storageState']>> | undefined
): Promise<BrowserContext> {
  return browser.newContext({
    viewport: environment.viewport,
    deviceScaleFactor: environment.deviceScaleFactor,
    locale: environment.locale,
    timezoneId: environment.timezoneId,
    colorScheme: environment.colorScheme,
    serviceWorkers: 'block',
    acceptDownloads: false,
    ...(storageState ? { storageState } : {})
  });
}

/** Undeclared origins are refused in the browser, as they were while recording. */
async function guardContext(
  context: BrowserContext,
  declaredOrigins: Map<string, string>,
  emit: FrameEmitter,
  at: () => number
): Promise<void> {
  await context.route(
    (url) => url.protocol !== 'http:' || !declaredOrigins.has(httpOrigin(url)),
    (route) => route.abort('blockedbyclient')
  );
  // Request routing never sees WebSocket handshakes; these are refused on their own route.
  await context.routeWebSocket(
    (url) => url.protocol !== 'ws:' || !declaredOrigins.has(httpOrigin(url)),
    (socket) => socket.close({ code: 1008, reason: 'Blocked by Task Monki' })
  );
  context.on('page', (opened) => {
    if (context.pages().length > 1) {
      emit({ type: 'signal', signal: 'page-navigation', detail: 'The page opened another window, which was closed.', atMs: at() });
      void opened.close().catch(() => undefined);
    }
  });
}

function httpOrigin(url: URL): string {
  return `http://${url.host}`;
}

class DialogArbiter {
  private armed?: { action: 'accept' | 'dismiss'; promptText?: string; stepIndex: number };
  private consumedStep?: number;
  unexpected = 0;

  constructor(page: Page) {
    page.on('dialog', (dialog: Dialog) => {
      const armed = this.armed;
      this.armed = undefined;
      if (armed) {
        this.consumedStep = armed.stepIndex;
        void (armed.action === 'accept' ? dialog.accept(armed.promptText) : dialog.dismiss()).catch(() => undefined);
        return;
      }
      this.unexpected += 1;
      void dialog.dismiss().catch(() => undefined);
    });
  }

  /** The next dialog answers the dialog step at `stepIndex`. */
  expect(step: Extract<BugCaseStep, { kind: 'dialog' }>, stepIndex: number): void {
    this.consumedStep = undefined;
    this.armed = { action: step.action, stepIndex, ...(step.promptText === undefined ? {} : { promptText: step.promptText }) };
  }

  disarm(): void {
    this.armed = undefined;
  }

  answered(stepIndex: number): boolean {
    return this.consumedStep === stepIndex;
  }
}

class NetworkTracker {
  private readonly requests = new Map<Request, TrackedRequest>();
  private windowStartMs?: number;
  private lastActivityMs = 0;
  private readonly bodyReads: Promise<void>[] = [];

  constructor(
    page: Page,
    private readonly declaredOrigins: Map<string, string>,
    private readonly plan: BugReplayRunPlan,
    private readonly at: () => number
  ) {
    page.on('request', (request) => this.onRequest(request));
    page.on('response', (response) => this.onResponse(response));
    page.on('requestfinished', (request) => this.onDone(request, 'finished'));
    page.on('requestfailed', (request) => this.onDone(request, 'failed'));
  }

  markWindowStart(): void {
    this.windowStartMs = this.at();
  }

  noteDocumentLoad(): void {
    this.lastActivityMs = this.at();
  }

  get lastActivity(): number {
    return this.lastActivityMs;
  }

  /** In flight: started, not finished, and not a long-lived stream whose headers already arrived. */
  inFlight(): number {
    const now = this.at();
    let count = 0;
    for (const tracked of this.requests.values()) {
      if (tracked.done || tracked.streaming) continue;
      if (tracked.headersAtMs !== undefined && now - tracked.headersAtMs > STREAMING_GRACE_MS) continue;
      count += 1;
    }
    return count;
  }

  hangs(hangMs: number): BugReplayRequestFact[] {
    const now = this.at();
    return [...this.requests.values()]
      .filter((tracked) => !tracked.done && !tracked.streaming && tracked.headersAtMs === undefined && now - tracked.startedAtMs >= hangMs)
      .filter((tracked) => this.windowStartMs === undefined || tracked.startedAtMs >= this.windowStartMs)
      .map((tracked) => ({ ...tracked.fact, outcome: 'pending' as const, pendingMs: now - tracked.startedAtMs }));
  }

  async settleBodies(): Promise<void> {
    await Promise.race([Promise.allSettled(this.bodyReads), sleep(2_000)]);
  }

  windowFacts(): BugReplayRequestFact[] {
    if (this.windowStartMs === undefined) return [];
    const now = this.at();
    return [...this.requests.values()]
      .filter((tracked) => tracked.startedAtMs >= this.windowStartMs!)
      .sort((left, right) => left.startedAtMs - right.startedAtMs)
      .map((tracked) => {
        if (tracked.done || tracked.fact.outcome !== 'pending') return tracked.fact;
        return { ...tracked.fact, outcome: 'pending' as const, pendingMs: now - tracked.startedAtMs };
      });
  }

  private onRequest(request: Request): void {
    const url = safeUrl(request.url());
    if (!url) return;
    const startedAtMs = this.at();
    this.lastActivityMs = startedAtMs;
    const resourceType = request.resourceType();
    const role = this.declaredOrigins.get(httpOrigin(url));
    const fact: BugReplayRequestFact = {
      method: request.method(),
      ...(role ? { role } : { host: url.hostname }),
      // One past the case's limits, so a longer path or more keys still never matches a check.
      path: (url.pathname || '/').slice(0, BUG_CASE_LIMITS.pathChars + 1),
      queryKeys: [...new Set([...url.searchParams.keys()].map((key) => key.slice(0, 129)))].sort().slice(0, BUG_CASE_LIMITS.queryEntries + 1),
      resourceType,
      fromServiceWorker: false,
      outcome: 'pending',
      startedAtMs
    };
    const streaming = resourceType === 'websocket' || resourceType === 'eventsource';
    this.requests.set(request, { request, startedAtMs, fact, done: false, streaming });
    if (this.plan.pointers.request.length > 0 && role && this.inWindow(startedAtMs)) {
      const body = request.postData();
      if (body !== null && body.length <= 64 * 1024) {
        const parsed = parseJson(body);
        if (parsed !== undefined) fact.requestValues = pointerValues(parsed, this.plan.pointers.request);
      }
    }
  }

  private onResponse(response: Response): void {
    const tracked = this.requests.get(response.request());
    if (!tracked) return;
    tracked.headersAtMs = this.at();
    tracked.fact.status = response.status();
    tracked.fact.fromServiceWorker = response.fromServiceWorker();
    const headers = response.headers();
    const contentType = headers['content-type'];
    if ([400, 421, 502, 503, 508].includes(response.status()) && contentType === 'text/plain; charset=utf-8') {
      this.bodyReads.push(
        response
          .text()
          .then((body) => {
            if (isGatewaySignature(response.status(), contentType, headers['cache-control'], body)) tracked.fact.gateway = true;
          })
          .catch(() => undefined)
      );
    }
    if (contentType?.includes('event-stream')) tracked.streaming = true;
    const wantsBody =
      this.plan.pointers.response.length > 0 &&
      tracked.fact.role !== undefined &&
      this.inWindow(tracked.startedAtMs) &&
      (contentType?.includes('json') ?? false);
    if (wantsBody) {
      this.bodyReads.push(
        response
          .body()
          .then((buffer) => {
            if (buffer.length > 64 * 1024) return;
            const parsed = parseJson(buffer.toString('utf8'));
            if (parsed !== undefined) tracked.fact.responseValues = pointerValues(parsed, this.plan.pointers.response);
          })
          .catch(() => undefined)
      );
    }
  }

  private onDone(request: Request, how: 'finished' | 'failed'): void {
    const tracked = this.requests.get(request);
    if (!tracked) return;
    tracked.done = true;
    this.lastActivityMs = Math.max(this.lastActivityMs, this.at());
    if (how === 'failed') {
      const failure = request.failure()?.errorText ?? '';
      tracked.fact.outcome = failure.includes('BLOCKED_BY_CLIENT') ? 'blocked' : tracked.headersAtMs !== undefined ? 'response' : 'failed';
    } else {
      tracked.fact.outcome = 'response';
    }
  }

  private inWindow(startedAtMs: number): boolean {
    return this.windowStartMs !== undefined && startedAtMs >= this.windowStartMs;
  }
}

async function runStep(
  page: Page,
  step: BugCaseStep,
  index: number,
  steps: BugCaseStep[],
  plan: BugReplayRunPlan,
  dialogs: DialogArbiter,
  tracker: NetworkTracker,
  emit: FrameEmitter,
  at: () => number
): Promise<{ status: 'done' | 'failed'; candidateIndex?: number; failure?: BugReplayStepFailureCode; detail?: string }> {
  const fail = (failure: BugReplayStepFailureCode, detail: string) => ({ status: 'failed' as const, failure, detail });
  if (step.kind === 'dialog') {
    const deadline = Date.now() + plan.timeouts.stepMs;
    while (Date.now() < deadline) {
      if (dialogs.answered(index)) return { status: 'done' };
      await sleep(50);
    }
    dialogs.disarm();
    return fail('dialog-missing', `Step ${humanIndex(steps, index)} expected a dialog that did not appear.`);
  }
  if (index > 0) await settle(tracker);
  if (dialogs.unexpected > 0) {
    return fail('unexpected-dialog', `An unexpected dialog appeared before step ${humanIndex(steps, index)}.`);
  }
  const next = steps[index + 1];
  if (next?.kind === 'dialog') dialogs.expect(next, index + 1);
  else dialogs.disarm();
  try {
    switch (step.kind) {
      case 'navigate': {
        const origin = plan.origins[step.origin];
        if (!origin) return fail('navigation-failed', 'The start page has no origin in this run.');
        const url = new URL(step.path, origin);
        for (const [key, value] of step.query) url.searchParams.append(key, value);
        return await navigateWithColdStartRetry(page, url.toString(), plan, emit, at);
      }
      case 'reload':
        await page.reload({ waitUntil: 'load', timeout: plan.timeouts.navigationMs });
        return { status: 'done' };
      case 'press':
        await page.keyboard.press(step.key === 'Space' ? 'Space' : step.key);
        return { status: 'done' };
      default: {
        const deadline = Date.now() + plan.timeouts.stepMs;
        const resolved = await resolveTarget(page, step.target, deadline);
        if (!resolved.locator) {
          return fail(
            resolved.ambiguous ? 'ambiguous' : 'not-found',
            resolved.ambiguous
              ? `Could not complete step ${humanIndex(steps, index)}: ${targetName(step.target)} matched ${resolved.ambiguous} elements`
              : `Could not complete step ${humanIndex(steps, index)}: ${targetName(step.target)} was not found`
          );
        }
        const remaining = Math.max(1_000, deadline - Date.now());
        try {
          await act(page, step, resolved.locator, remaining, plan.document);
        } catch (error) {
          return {
            status: 'failed',
            candidateIndex: resolved.candidateIndex,
            failure: 'not-actionable',
            detail: `Could not complete step ${humanIndex(steps, index)}: ${targetName(step.target)} could not be used (${errorText(error)})`
          };
        }
        return { status: 'done', candidateIndex: resolved.candidateIndex };
      }
    }
  } catch (error) {
    return fail('not-actionable', `Could not complete step ${humanIndex(steps, index)} (${errorText(error)})`);
  }
}

async function navigateWithColdStartRetry(
  page: Page,
  url: string,
  plan: BugReplayRunPlan,
  emit: FrameEmitter,
  at: () => number
): Promise<{ status: 'done' | 'failed'; failure?: BugReplayStepFailureCode; detail?: string }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await page.goto(url, { waitUntil: 'load', timeout: plan.timeouts.navigationMs });
      if (response && attempt === 0 && [502, 503].includes(response.status())) {
        const body = await response.text().catch(() => '');
        const headers = response.headers();
        if (isGatewaySignature(response.status(), headers['content-type'], headers['cache-control'], body)) {
          emit({ type: 'signal', signal: 'retried-navigation', detail: 'The first page load got no answer and was retried once.', atMs: at() });
          continue;
        }
      }
      return { status: 'done' };
    } catch (error) {
      if (attempt === 0 && /timeout/i.test(errorText(error))) {
        emit({ type: 'signal', signal: 'retried-navigation', detail: 'The first page load timed out and was retried once.', atMs: at() });
        continue;
      }
      return { status: 'failed', failure: 'navigation-failed', detail: `The start page did not load (${errorText(error)})` };
    }
  }
  return { status: 'failed', failure: 'navigation-failed', detail: 'The start page did not load.' };
}

/** Waits briefly for the network to settle between steps, the way a person waits for a page. */
async function settle(tracker: NetworkTracker): Promise<void> {
  const deadline = Date.now() + STEP_SETTLE_CAP_MS;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    if (tracker.inFlight() > 0) quietSince = Date.now();
    else if (Date.now() - quietSince >= STEP_SETTLE_QUIET_MS) return;
    await sleep(50);
  }
}

async function act(page: Page, step: BugCaseStep, locator: Locator, timeout: number, document: BugCaseV1): Promise<void> {
  switch (step.kind) {
    case 'click': {
      if (!step.count) {
        await locator.click({ timeout });
        return;
      }
      await locator.scrollIntoViewIfNeeded({ timeout });
      const box = await locator.boundingBox({ timeout });
      if (!box) throw new Error('the element has no box');
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      for (let click = 0; click < step.count; click += 1) {
        if (click > 0) await sleep(step.intervalMs ?? 0);
        await page.mouse.click(x, y);
      }
      return;
    }
    case 'check':
      await locator.check({ timeout });
      return;
    case 'uncheck':
      await locator.uncheck({ timeout });
      return;
    case 'fill': {
      const value = step.sensitiveRef
        ? document.sensitiveInputs.find((input) => input.id === step.sensitiveRef)?.value ?? ''
        : step.value ?? '';
      await locator.fill(value, { timeout });
      return;
    }
    case 'select':
      await locator.selectOption(step.values, { timeout });
      return;
    default:
      return;
  }
}

interface ResolvedTarget {
  locator?: Locator;
  candidateIndex?: number;
  ambiguous?: number;
}

/** The first candidate, in recorded order, that matches exactly one visible element before the deadline. */
async function resolveTarget(page: Page, target: BugCaseTarget, deadline: number): Promise<ResolvedTarget> {
  let ambiguous = 0;
  do {
    ambiguous = 0;
    for (const [candidateIndex, candidate] of target.candidates.entries()) {
      const locator = locatorFor(page, candidate);
      const visible = await visibleMatches(locator);
      if (visible.count === 1) return { locator: visible.only!, candidateIndex };
      if (visible.count > 1) ambiguous = Math.max(ambiguous, visible.count);
    }
    await sleep(SAMPLE_INTERVAL_MS);
  } while (Date.now() < deadline);
  return ambiguous > 0 ? { ambiguous } : {};
}

async function visibleMatches(locator: Locator): Promise<{ count: number; only?: Locator }> {
  let total: number;
  try {
    total = await locator.count();
  } catch {
    return { count: 0 };
  }
  if (total === 0) return { count: 0 };
  if (total > MAX_CANDIDATE_MATCHES) return { count: total };
  let count = 0;
  let only: Locator | undefined;
  for (let index = 0; index < total; index += 1) {
    const nth = locator.nth(index);
    if (await nth.isVisible().catch(() => false)) {
      count += 1;
      only = nth;
    }
  }
  return { count, only: count === 1 ? only : undefined };
}

export function locatorFor(page: Page, candidate: BugCaseTargetCandidate): Locator {
  switch (candidate.kind) {
    case 'testId':
      return page.locator(`[${candidate.attribute}="${cssString(candidate.value)}"]`);
    case 'role':
      return page.getByRole(candidate.role as Parameters<Page['getByRole']>[0], candidate.name ? { name: candidate.name, exact: true } : {});
    case 'label':
      return page.getByLabel(candidate.value, { exact: true });
    case 'placeholder':
      return page.getByPlaceholder(candidate.value, { exact: true });
    case 'text':
      return page.getByText(candidate.value, { exact: true });
    case 'css':
      return page.locator(candidate.value);
  }
}

function cssString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ');
}

interface WindowResult {
  startedAtMs: number;
  endedAtMs: number;
  quiet: boolean;
  dom: Map<string, BugReplayDomObservation>;
}

interface Sampled {
  firstMatchAtMs?: number;
  firstMatchText?: string;
  brokeAfterMatch: boolean;
  last?: BugReplayDomObservation;
}

/**
 * Waits for network quiet, then watches the checks for the window. A request or a document load
 * during the window restarts the quiet wait and the window, never past the cap.
 */
async function observeWindow(
  page: Page,
  tracker: NetworkTracker,
  assertions: DomAssertion[],
  plan: BugReplayRunPlan,
  at: () => number,
  aborted: () => boolean
): Promise<WindowResult> {
  const startedAtMs = at();
  const capAt = startedAtMs + plan.timeouts.quietCapMs + plan.timeouts.windowMs;
  let quiet = await waitQuiet(tracker, plan.timeouts.quietMs, startedAtMs + plan.timeouts.quietCapMs, at);
  let windowStart = at();
  let samples = new Map<string, Sampled>();
  let lastActivity = tracker.lastActivity;
  while (!aborted() && !page.isClosed()) {
    for (const assertion of assertions) {
      const observation = await sampleDom(page, assertion);
      const sampled = samples.get(assertion.id) ?? { brokeAfterMatch: false };
      if (observation.matched && sampled.firstMatchAtMs === undefined) {
        sampled.firstMatchAtMs = at();
        sampled.firstMatchText = observation.text ?? observation.value;
      }
      if (!observation.matched && sampled.firstMatchAtMs !== undefined) sampled.brokeAfterMatch = true;
      sampled.last = observation;
      samples.set(assertion.id, sampled);
    }
    const now = at();
    if (tracker.lastActivity > lastActivity && now < capAt) {
      lastActivity = tracker.lastActivity;
      quiet = await waitQuiet(tracker, plan.timeouts.quietMs, Math.min(capAt, now + plan.timeouts.quietCapMs), at);
      windowStart = at();
      samples = new Map();
      continue;
    }
    if (now - windowStart >= plan.timeouts.windowMs) {
      quiet = quiet && tracker.inFlight() === 0;
      break;
    }
    if (now >= capAt) {
      quiet = false;
      break;
    }
    await sleep(SAMPLE_INTERVAL_MS);
  }
  const dom = new Map<string, BugReplayDomObservation>();
  for (const assertion of assertions) {
    const sampled = samples.get(assertion.id);
    const last = sampled?.last ?? missingDom();
    const observation: BugReplayDomObservation = {
      ...last,
      held: Boolean(last.matched && sampled?.firstMatchAtMs !== undefined && !sampled.brokeAfterMatch)
    };
    if (sampled?.firstMatchAtMs !== undefined) {
      observation.firstMatchAtMs = sampled.firstMatchAtMs;
      if (sampled.brokeAfterMatch && sampled.firstMatchText !== undefined) observation.firstMatchText = sampled.firstMatchText;
    }
    dom.set(assertion.id, observation);
  }
  return { startedAtMs, endedAtMs: at(), quiet, dom };
}

async function waitQuiet(tracker: NetworkTracker, quietMs: number, deadlineMs: number, at: () => number): Promise<boolean> {
  let quietSince = at();
  while (at() < deadlineMs) {
    if (tracker.inFlight() > 0) quietSince = at();
    else if (at() - quietSince >= quietMs) return true;
    await sleep(50);
  }
  return tracker.inFlight() === 0;
}

function missingDom(): BugReplayDomObservation {
  return { kind: 'dom', found: false, count: 0, visible: false, matched: false, held: false };
}

/** One sample of one page check, read through Playwright's isolated injected script. */
async function sampleDom(page: Page, assertion: DomAssertion): Promise<BugReplayDomObservation> {
  const absence = (assertion.kind === 'dom.visible' && !assertion.expected) || (assertion.kind === 'dom.count' && assertion.value === 0);
  if (absence) {
    let most = 0;
    for (const candidate of assertion.target.candidates) {
      const visible = await visibleMatches(locatorFor(page, candidate));
      most = Math.max(most, visible.count);
    }
    return { kind: 'dom', found: most > 0, count: most, visible: most > 0, matched: most === 0, held: false };
  }
  if (assertion.kind === 'dom.count') {
    for (const [candidateIndex, candidate] of assertion.target.candidates.entries()) {
      const visible = await visibleMatches(locatorFor(page, candidate));
      if (visible.count >= 1) {
        return { kind: 'dom', found: true, candidateIndex, count: visible.count, visible: true, matched: visible.count === assertion.value, held: false };
      }
    }
    return { ...missingDom() };
  }
  for (const [candidateIndex, candidate] of assertion.target.candidates.entries()) {
    const visible = await visibleMatches(locatorFor(page, candidate));
    if (visible.count !== 1 || !visible.only) continue;
    const element = visible.only;
    if (assertion.kind === 'dom.visible') {
      return { kind: 'dom', found: true, candidateIndex, count: 1, visible: true, matched: true, held: false };
    }
    if (assertion.kind === 'dom.value') {
      const value = await element.inputValue({ timeout: 2_000 }).catch(() => undefined);
      return { kind: 'dom', found: true, candidateIndex, count: 1, visible: true, ...(value === undefined ? {} : { value }), matched: value === assertion.value, held: false };
    }
    const text = normalizeVisibleText((await element.innerText({ timeout: 2_000 }).catch(() => '')) ?? '');
    const matched = assertion.op === 'equals' ? text === assertion.value : text.includes(assertion.value);
    return { kind: 'dom', found: true, candidateIndex, count: 1, visible: true, text: text.slice(0, 2000), matched, held: false };
  }
  return missingDom();
}

function observationFor(
  assertion: BugCaseAssertion,
  dom: Map<string, BugReplayDomObservation>,
  requests: BugReplayRequestFact[],
  page: Page,
  pageErrors: string[],
  document: BugCaseV1
) {
  switch (assertion.kind) {
    case 'dom.text':
    case 'dom.value':
    case 'dom.visible':
    case 'dom.count':
      return dom.get(assertion.id) ?? missingDom();
    case 'page.path':
      return { kind: 'path' as const, path: safeUrl(page.url())?.pathname ?? '/' };
    case 'console.noUncaughtError':
      return { kind: 'console' as const, errors: pageErrors.slice(0, 20) };
    case 'request':
      // One past the largest count a check can name, so "exactly n" still decides.
      return { kind: 'request' as const, matches: matchingRequests(assertion, requests).slice(0, 101).map((fact) => reported(fact)) };
    case 'request.json': {
      const anchor = document.assertions.find((candidate) => candidate.id === assertion.requestId);
      const side = assertion.side === 'request' ? 'requestValues' : 'responseValues';
      return {
        kind: 'request' as const,
        matches: anchor && anchor.kind === 'request'
          ? matchingRequests(anchor, requests).slice(0, 20).map((fact) => ({ ...reported(fact), [side]: { [assertion.pointer]: fact[side]?.[assertion.pointer] ?? null } }))
          : []
      };
    }
  }
}

/**
 * A request as the report carries it: what a verdict reads, with the page-chosen path and keys
 * shortened and no JSON values, so a page cannot grow a report past its limit.
 */
function reported(fact: BugReplayRequestFact): BugReplayRequestFact {
  const { requestValues: _request, responseValues: _response, ...rest } = fact;
  void _request;
  void _response;
  return { ...rest, path: rest.path.slice(0, 128), queryKeys: rest.queryKeys.slice(0, 8).map((key) => key.slice(0, 32)) };
}

export function matchingRequests(
  assertion: Extract<BugCaseAssertion, { kind: 'request' }>,
  requests: BugReplayRequestFact[]
): BugReplayRequestFact[] {
  return requests.filter(
    (request) =>
      request.role === assertion.origin &&
      request.method === assertion.method &&
      !request.fromServiceWorker &&
      pathMatchesTemplate(request.path, assertion.pathTemplate) &&
      sameKeys(request.queryKeys, assertion.queryKeys)
  );
}

function sameKeys(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

function pointerValues(document: unknown, pointers: string[]): Record<string, string | null> {
  const values: Record<string, string | null> = {};
  for (const pointer of pointers) {
    const value = readJsonPointer(document, pointer);
    // One past the longest expected value, so a longer value never equals one.
    values[pointer] = value === undefined ? null : canonicalJson(value).slice(0, BUG_CASE_LIMITS.valueChars + 1);
  }
  return values;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function humanIndex(steps: BugCaseStep[], index: number): number {
  return steps.slice(0, index + 1).filter((step) => step.kind !== 'dialog').length;
}

function targetName(target: BugCaseTarget): string {
  for (const candidate of target.candidates) {
    if (candidate.kind === 'role' && candidate.name) return `"${candidate.name.slice(0, 60)}"`;
    if (candidate.kind === 'label' || candidate.kind === 'placeholder' || candidate.kind === 'text') return `"${candidate.value.slice(0, 60)}"`;
  }
  for (const candidate of target.candidates) {
    if (candidate.kind === 'testId') return candidate.value.slice(0, 60);
  }
  return 'the element';
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0].replace(/^[a-zA-Z.]+: /, '').slice(0, 200);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
