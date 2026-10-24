import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BugCaseEnvironment } from '../../shared/bugCase';
import type { BugRecordingLogV1 } from '../../shared/bugRecording';
import type { BugCaptureDraft } from '../../shared/bugReplay';
import { openPipePage, until } from '../../testSupport/bugReplay/pipePage';
import { resolveDesignBrowserRuntimePaths } from '../design/AgentBrowserRuntimePath';
import { compileBugCase } from './BugCaseCompiler';
import { BugReplayRunner } from './BugReplayRunner';
import { evaluateRun } from './BugReplayVerdict';
import { RecorderSession } from './recorder/RecorderSession';
import { chromeEnvironment, startChromeOverPipe } from './runner/chromePipe';

/**
 * Recording and replay end to end: Task Monki's recorder records a bug on a small checkout app in
 * one Chrome for Testing, its runner process replays it in another, and the verdict rules read the
 * frames. Needs the development browser runtime (`.local/design-browser-runtime`); skipped without it.
 */

const browser = resolveDesignBrowserRuntimePaths({ isPackaged: false, resourcesPath: '', appPath: process.cwd() }).browserExecutablePath;
const fixture = path.join(process.cwd(), 'src', 'testSupport', 'bugReplay', 'checkout', 'app');

/** Settings no browser starts with, so the recording and its replays agree only if both apply them. */
const ENVIRONMENT: BugCaseEnvironment = {
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
  locale: 'tr-TR',
  timezoneId: 'Asia/Tokyo',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
};

/**
 * The person records the bug as they would in the app: adds two widgets, applies SAVE5, then marks
 * the total, which reads $40.00 instead of $45.00, and the line where the page states its browser.
 */
async function recordCoupon(origin: string, root: string): Promise<{ log: BugRecordingLogV1; browserLine: string }> {
  const profile = path.join(root, 'recording-profile');
  const chrome = startChromeOverPipe({ executablePath: browser, userDataDir: profile, env: chromeEnvironment(process.env, profile) });
  try {
    const conn = await openPipePage(chrome);
    let ready = false;
    let loaded = false;
    const recorder = new RecorderSession(conn.cdp, { primary: origin }, ENVIRONMENT, (notice) => {
      if (notice.kind === 'ready') ready = true;
    });
    conn.cdp.onEvent((method, _params, sessionId) => {
      if (method === 'Page.loadEventFired' && !sessionId) loaded = true;
    });
    const evaluate = async <T>(expression: string): Promise<T> =>
      ((await conn.page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result as { value: T }).value;
    const click = async (selector: string) => {
      const { x, y } = await evaluate<{ x: number; y: number }>(
        // The first line's box: a long line wraps, and its overall box has gaps between lines.
        `(() => { const box = document.querySelector(${JSON.stringify(selector)}).getClientRects()[0]; return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`
      );
      await conn.page('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await conn.page('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await conn.page('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    };
    const point = async (selector: string) => {
      const from = conn.accepted.length;
      const outcome = recorder.pick();
      await until(() => conn.accepted.slice(from).some((command) => command.method === 'Overlay.setInspectMode' && command.params.mode === 'searchForNode'), 'inspect mode');
      await click(selector);
      const result = await outcome;
      if (result.kind !== 'picked') throw new Error(`Pointing at ${selector} stopped.`);
      return result.pick;
    };

    // As the in-app view opens the page: the recorder and the settings first, then the start page.
    await recorder.attach();
    await recorder.pinViewport();
    await conn.page('Page.navigate', { url: `${origin}/` });
    await until(async () => ready && loaded && (await evaluate<number>("document.querySelectorAll('#products button').length")) > 0, 'the checkout page', 15_000);
    recorder.noteStart('/', [], 'primary', 0);

    await click('[data-testid="add-widget"]');
    await click('[data-testid="add-widget"]');
    await click('#coupon');
    await conn.page('Input.insertText', { text: 'SAVE5' });
    await click('#apply');
    await until(async () => (await evaluate<string>("document.getElementById('cart-total').textContent")) === '$40.00', 'the coupon to apply');
    await until(() => recorder.log().actions.length === 5, 'the recorder to note every step');

    recorder.seal();
    await point('#cart-total');
    const seen = await point('#browser');
    const log = recorder.log();
    recorder.dispose();
    return { log, browserLine: seen.text };
  } finally {
    chrome.transport.close();
    chrome.process.kill('SIGKILL');
  }
}

function exited(child: ChildProcess, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${what} exited with ${code}`))));
  });
}

describe.skipIf(!existsSync(browser))('Recording and replaying a bug in real browsers', () => {
  let root: string;
  let app: string;
  let server: ChildProcess | undefined;
  let origin: string;
  let runner: BugReplayRunner;
  let recorded: Awaited<ReturnType<typeof recordCoupon>>;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bug-replay-runner-'));
    app = path.join(root, 'app');
    await fs.cp(fixture, app, { recursive: true });
    // The runner as the build bundles it, from the current source.
    const runnerScript = path.join(root, 'bug-replay-runner.cjs');
    await exited(spawn(process.execPath, ['scripts/build-bug-replay-runner.mjs', runnerScript], { cwd: process.cwd(), stdio: 'ignore' }), 'The runner build');
    runner = new BugReplayRunner(() => ({
      nodeExecutable: process.execPath,
      runnerScript,
      playwrightPackage: path.join(process.cwd(), 'node_modules', 'playwright-core'),
      browserExecutable: browser
    }));
    await exited(spawn(process.execPath, ['seed/seed.js'], { cwd: app, stdio: 'ignore' }), 'The fixture seed');
    server = spawn(process.execPath, ['server.js'], { cwd: app, env: { ...process.env, PORT: '0', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
    origin = await new Promise<string>((resolve, reject) => {
      server!.stdout!.on('data', (chunk: Buffer) => {
        const port = /listening on (\d+)/.exec(String(chunk))?.[1];
        if (port) resolve(`http://127.0.0.1:${port}`);
      });
      server!.once('exit', (code) => reject(new Error(`The fixture server exited with ${code}`)));
    });
    recorded = await recordCoupon(origin, root);
  }, 90_000);

  afterAll(async () => {
    server?.kill('SIGTERM');
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  async function replay(kind: 'BASELINE' | 'CANDIDATE', extra: Partial<BugCaptureDraft> = {}) {
    const compiled = compileBugCase(recorded.log, {
      title: 'Coupon total is wrong',
      checks: [
        { pickIndex: 0, template: 'equals', expected: '$45.00', alsoAfterReload: false },
        // What the page knew of its browser while it was recorded; every replay must show the same.
        { pickIndex: 1, template: 'equals', expected: recorded.browserLine, alsoAfterReload: false }
      ],
      requestRules: [],
      valueChecks: [],
      ...extra
    });
    const document = compiled.document!;
    const scratchDir = path.join(root, `run-${randomUUID()}`);
    await fs.mkdir(scratchDir, { recursive: true, mode: 0o700 });
    const result = await runner.run({ runId: randomUUID(), document, origins: { primary: origin }, scratchDir, signal: new AbortController().signal });
    if (result.kind !== 'completed') throw new Error(`The runner did not complete: ${JSON.stringify(result)}`);
    return { result, verdict: evaluateRun(kind, document, result.frames) };
  }

  it('replays the recorded bug in a browser the page sees as it saw the recording’s, and passes once the code is fixed', async () => {
    // The recording browser applied the case's settings, not its own.
    expect(recorded.browserLine.split(' | ')).toEqual([
      'dark',
      '2x',
      'tr-TR',
      expect.stringMatching(/^0?2\.01\.2026 12:04/),
      ENVIRONMENT.userAgent,
      'no service workers'
    ]);

    const before = await replay('BASELINE');
    expect(before.verdict).toMatchObject({
      outcome: 'REPRODUCED',
      signatureObserved: { a1: 'Cart total showed "$40.00"' },
      observations: [{ assertionId: 'a1', passed: false }, { assertionId: 'a2', passed: true, locator: 0 }]
    });
    // Each step finds its element by its first locator, the one the recording named, even where
    // CSS shows the words in capitals: the start, two clicks on Add Widget, SAVE5, Apply coupon.
    const steps = before.result.frames.flatMap((frame) => (frame.type === 'step' ? [frame] : []));
    expect(steps.map((step) => [step.status, step.candidateIndex])).toEqual([['done', undefined], ['done', 0], ['done', 0], ['done', 0]]);
    // Pictures keep the case's CSS size at twice the density.
    const [shot] = before.result.screenshots;
    expect((await fs.readFile(shot.path)).readUInt32BE(16)).toBe(ENVIRONMENT.viewport.width);

    // The fix the agent would make: the discount is applied once.
    const source = path.join(app, 'public', 'app.js');
    const original = await fs.readFile(source, 'utf8');
    try {
      await fs.writeFile(source, original.replace('state.discount * 2', 'state.discount'));

      const after = await replay('CANDIDATE');
      expect(after.verdict).toMatchObject({
        outcome: 'PASSED',
        observations: [{ passed: true, observed: 'Cart total showed "$45.00"' }, { assertionId: 'a2', passed: true }]
      });
    } finally {
      // The app copy is shared by every test here: the next one starts from the buggy code.
      await fs.writeFile(source, original);
    }
  }, 120_000);

  it('counts page errors from the marked step on, so an error the page raised while it loaded is never the bug', async () => {
    const source = path.join(app, 'public', 'app.js');
    const original = await fs.readFile(source, 'utf8');
    // The fixed code, so the total holds and only the page errors decide.
    const fixed = original.replace('state.discount * 2', 'state.discount');
    const pageErrors = (run: Awaited<ReturnType<typeof replay>>) =>
      run.result.frames.flatMap((frame) => (frame.type === 'assertion' && frame.observation.kind === 'console' ? frame.observation.errors : []));
    try {
      // An outside script that failed while the page loaded, long before Apply coupon.
      await fs.writeFile(source, `${fixed}\nsetTimeout(() => { throw new Error('outside script failed'); });\n`);
      const quiet = await replay('CANDIDATE', { noPageError: true });
      expect(pageErrors(quiet)).toEqual([]);
      expect(quiet.verdict.outcome).toBe('PASSED');

      // The marked click raising one is the page error the check is about.
      await fs.writeFile(source, `${fixed}\ndocument.querySelector('#apply').addEventListener('click', () => setTimeout(() => { throw new Error('apply failed'); }));\n`);
      const raised = await replay('CANDIDATE', { noPageError: true });
      expect(pageErrors(raised)).toEqual([expect.stringContaining('apply failed')]);
      expect(raised.verdict.outcome).toBe('FAILED');
    } finally {
      await fs.writeFile(source, original);
    }
  }, 120_000);

  it('never lets the page open a WebSocket to a host the run did not declare', async () => {
    // Something listening where a page could phone home, on a port that is not the app's.
    let connected = false;
    const outside = net.createServer((socket) => {
      connected = true;
      socket.destroy();
    });
    await new Promise<void>((resolve) => outside.listen(0, '127.0.0.1', resolve));
    const port = (outside.address() as net.AddressInfo).port;
    const source = path.join(app, 'public', 'app.js');
    const original = await fs.readFile(source, 'utf8');
    await fs.writeFile(source, `${original}\nnew WebSocket('ws://127.0.0.1:${port}/');\n`);
    try {
      const run = await replay('CANDIDATE');
      expect(run.result.kind).toBe('completed');
      expect(connected).toBe(false);
    } finally {
      await fs.writeFile(source, original);
      await new Promise<void>((resolve) => outside.close(() => resolve()));
    }
  }, 120_000);
});
