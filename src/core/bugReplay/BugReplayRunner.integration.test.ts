import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUG_RECORDING_SCHEMA, type BugRecordingLogV1 } from '../../shared/bugRecording';
import type { BugCaptureDraft } from '../../shared/bugReplay';
import { resolveDesignBrowserRuntimePaths } from '../design/AgentBrowserRuntimePath';
import { compileBugCase } from './BugCaseCompiler';
import { BugReplayRunner } from './BugReplayRunner';
import { evaluateRun } from './BugReplayVerdict';

/**
 * The replay engine end to end: Task Monki's runner process drives Chrome for Testing through the
 * steps of a recorded bug on a small checkout app, and the verdict rules read its frames. Needs
 * the development browser runtime (`.local/design-browser-runtime`); skipped without it.
 */

const browser = resolveDesignBrowserRuntimePaths({ isPackaged: false, resourcesPath: '', appPath: process.cwd() }).browserExecutablePath;
const fixture = path.join(process.cwd(), 'src', 'testSupport', 'bugReplay', 'checkout', 'app');

/** Added two widgets, applied SAVE5, and marked the total, which read $40.00 instead of $45.00. */
function couponRecording(): BugRecordingLogV1 {
  const addWidget = { tag: 'button', testIds: [{ attribute: 'data-testid' as const, value: 'add-widget' }], role: 'button', name: 'Add Widget', text: 'Add Widget', css: '#products > button:nth-of-type(1)' };
  return {
    schema: BUG_RECORDING_SCHEMA,
    environment: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'light', locale: 'en-US', timezoneId: 'UTC' },
    roles: ['primary'],
    actions: [
      { index: 0, t: 100, kind: 'navigate', location: { role: 'primary', path: '/', query: [] } },
      { index: 1, t: 1_000, kind: 'click', target: addWidget },
      { index: 2, t: 2_000, kind: 'click', target: addWidget },
      { index: 3, t: 3_000, kind: 'fill', value: 'SAVE5', target: { tag: 'input', inputType: 'text', testIds: [], label: 'Coupon code', css: '#coupon' } },
      { index: 4, t: 4_000, kind: 'click', target: { tag: 'button', testIds: [], role: 'button', name: 'Apply coupon', text: 'Apply coupon', css: '#apply' } }
    ],
    requests: [
      { id: 'r1', t: 4_020, method: 'POST', role: 'primary', path: '/api/coupons/apply', queryKeys: [], resourceType: 'fetch', outcome: 'response', status: 200, fromServiceWorker: false, actionIndex: 4 }
    ],
    console: [],
    coverage: { complete: true, reasons: [] },
    mark: {
      t: 5_000,
      actionIndex: 4,
      window: { startT: 4_000, endT: 5_000 },
      location: { role: 'primary', path: '/', query: [] },
      picks: [{
        target: { tag: 'span', testIds: [{ attribute: 'data-testid', value: 'cart-total' }], text: '$40.00', context: 'Cart total', css: '#cart-total' },
        text: '$40.00',
        visible: true,
        count: 1
      }]
    }
  };
}

function exited(child: ChildProcess, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${what} exited with ${code}`))));
  });
}

describe.skipIf(!existsSync(browser))('Replay runner with a real browser', () => {
  let root: string;
  let app: string;
  let server: ChildProcess | undefined;
  let origin: string;
  let runner: BugReplayRunner;

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
  }, 60_000);

  afterAll(async () => {
    server?.kill('SIGTERM');
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  async function replay(kind: 'BASELINE' | 'CANDIDATE', extra: Partial<BugCaptureDraft> = {}) {
    const compiled = compileBugCase(couponRecording(), {
      title: 'Coupon total is wrong',
      checks: [{ pickIndex: 0, template: 'equals', expected: '$45.00', alsoAfterReload: false }],
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

  it('reproduces the recorded bug on the buggy code and passes once the code is fixed', async () => {
    const before = await replay('BASELINE');
    expect(before.verdict).toMatchObject({ outcome: 'REPRODUCED', signatureObserved: { a1: 'Cart total showed "$40.00"' } });
    expect(before.result.frames.filter((frame) => frame.type === 'step').every((frame) => frame.type === 'step' && frame.status === 'done')).toBe(true);
    expect(before.result.screenshots.length).toBeGreaterThan(0);

    // The fix the agent would make: the discount is applied once.
    const source = path.join(app, 'public', 'app.js');
    const original = await fs.readFile(source, 'utf8');
    try {
      await fs.writeFile(source, original.replace('state.discount * 2', 'state.discount'));

      const after = await replay('CANDIDATE');
      expect(after.verdict).toMatchObject({ outcome: 'PASSED', observations: [{ passed: true, observed: 'Cart total showed "$45.00"' }] });
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
