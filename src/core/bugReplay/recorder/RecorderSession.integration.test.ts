import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_BUG_CASE_ENVIRONMENT } from '../../../shared/bugReplay';
import { resolveDesignBrowserRuntimePaths } from '../../design/AgentBrowserRuntimePath';
import { chromeEnvironment, startChromeOverPipe, type ChromeOverPipe } from '../runner/chromePipe';
import { EMBEDDED_FRAME_PICK_REASON, RecorderSession, type CdpConnection, type RecorderPickOutcome } from './RecorderSession';

/**
 * Pointing end to end against a page that tries to see, block, steer and forge the person's pick.
 * The recorder drives Chrome for Testing's inspect mode the way it drives the in-app view. Needs
 * the development browser runtime (`.local/design-browser-runtime`); skipped without it.
 */

const browser = resolveDesignBrowserRuntimePaths({ isPackaged: false, resourcesPath: '', appPath: process.cwd() }).browserExecutablePath;

/** A checkout page that does everything a page can to watch, block, steer or forge a pick. */
function hostilePage(frames: { sameSite: string; crossSite: string }): string {
  return `<!doctype html>
<html><head><title>Checkout</title><script>
  window.__trusted = [];
  window.__frameInput = [];
  window.__mutations = 0;
  window.__forged = 0;
  // Ahead of every other listener: note the person's input, swallow it, and steer what comes next
  // by covering the page with a decoy.
  for (const type of ['pointermove', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    window.addEventListener(type, (event) => {
      if (event.isTrusted) {
        window.__trusted.push(type);
        document.getElementById('decoy').hidden = false;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }
  // Watch for anything drawn into the page.
  new MutationObserver((records) => { window.__mutations += records.length; })
    .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  addEventListener('message', (event) => { if (event.data && event.data.input) window.__frameInput.push(event.data.input); });
  window.__reset = async () => {
    document.getElementById('decoy').hidden = true;
    await new Promise((resolve) => setTimeout(resolve, 0));
    window.__trusted = [];
    window.__frameInput = [];
    window.__mutations = 0;
  };
</script></head>
<body style="margin:0;font:16px/20px sans-serif">
  <button id="buy" data-testid="buy" style="position:absolute;left:20px;top:20px;width:200px;height:40px">Buy now</button>
  <p style="position:absolute;left:20px;top:80px;margin:0">Cart total: <span id="total">$40.00</span></p>
  <div id="badge" style="position:absolute;left:20px;top:130px;width:200px;height:40px"></div>
  <div id="swatch" style="position:absolute;left:20px;top:190px;width:200px;height:40px;background:#fff"></div>
  <iframe id="same-origin" src="/frame" style="position:absolute;left:300px;top:20px;width:300px;height:100px;border:0"></iframe>
  <iframe id="same-site" src="${frames.sameSite}/frame" style="position:absolute;left:300px;top:140px;width:300px;height:100px;border:0"></iframe>
  <iframe id="cross-site" src="${frames.crossSite}/frame" style="position:absolute;left:300px;top:260px;width:300px;height:100px;border:0"></iframe>
  <div id="decoy" hidden style="position:fixed;inset:0">Decoy</div>
  <script>
    document.getElementById('badge').attachShadow({ mode: 'closed' }).innerHTML = '<span style="display:block;height:40px">Shadow badge</span>';
    // Forge: the page clicks and points at its own elements all the time.
    setInterval(() => {
      window.__forged += 1;
      const total = document.getElementById('total');
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        total.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: 40, clientY: 90 }));
      }
      total.click();
      document.getElementById('buy').click();
    }, 15);
  </script>
</body></html>`;
}

const FRAME_PAGE = `<!doctype html><html><body style="margin:0"><script>
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
    addEventListener(type, (event) => { if (event.isTrusted) parent.postMessage({ input: location.host + ' ' + type }, '*'); }, true);
  }
</script><button style="width:300px;height:100px">Inside a frame</button></body></html>`;

interface PipePage {
  /** The page as Electron's debugger presents a view: its own commands and events carry no session. */
  cdp: CdpConnection;
  /** Straight to the page: the person's input, or a look at the page's own state. */
  page(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Commands the recorder sent that Chrome accepted, in order. */
  accepted: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }>;
  /** Embedded frames that are targets of their own, by session. */
  frames: Set<string>;
}

async function openPipePage(chrome: ChromeOverPipe): Promise<PipePage> {
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

async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function settled(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 0))]);
}

/** The red, green and blue at one point of an 8-bit RGB or RGBA PNG, its rows unfiltered as PNG defines. */
function pixelAt(png: Buffer, x: number, y: number): [number, number, number] {
  const width = png.readUInt32BE(16);
  const channels = png[25] === 6 ? 4 : 3;
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const data = zlib.inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  let previous = Buffer.alloc(stride);
  for (let row = 0; row <= y; row += 1) {
    const filter = data[row * (stride + 1)];
    const line = Buffer.from(data.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)));
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? line[i - channels] : 0;
      const up = previous[i];
      const upLeft = i >= channels ? previous[i - channels] : 0;
      const guess = left + up - upLeft;
      const paeth = Math.abs(guess - left) <= Math.abs(guess - up) && Math.abs(guess - left) <= Math.abs(guess - upLeft)
        ? left
        : Math.abs(guess - up) <= Math.abs(guess - upLeft) ? up : upLeft;
      const predictor = [0, left, up, (left + up) >> 1, paeth][filter] ?? 0;
      line[i] = (line[i] + predictor) & 0xff;
    }
    previous = line;
  }
  return [previous[x * channels], previous[x * channels + 1], previous[x * channels + 2]];
}

describe.skipIf(!existsSync(browser))('Pointing with Chrome’s inspect mode on a hostile page', () => {
  let root: string;
  let chrome: ChromeOverPipe;
  let conn: PipePage;
  let recorder: RecorderSession;
  const servers: http.Server[] = [];

  const evaluate = async <T>(expression: string): Promise<T> => {
    const result = await conn.page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return (result.result as { value: T }).value;
  };
  const center = (selector: string) =>
    evaluate<{ x: number; y: number }>(`(() => { const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`);
  const click = async ({ x, y }: { x: number; y: number }) => {
    await conn.page('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await conn.page('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await conn.page('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  };
  /** Whether Chrome draws its pointing tint over a point of a white element; only the view's capture holds the overlay. */
  const tinted = async ({ x, y }: { x: number; y: number }) => {
    const shot = await conn.page('Page.captureScreenshot', { format: 'png', fromSurface: false });
    const png = Buffer.from(String(shot.data), 'base64');
    const scale = png.readUInt32BE(16) / DEFAULT_BUG_CASE_ENVIRONMENT.viewport.width;
    const [red, , blue] = pixelAt(png, Math.round(x * scale), Math.round(y * scale));
    return blue - red > 8;
  };
  /** Starts pointing and returns once inspect mode covers the page and each frame target. */
  const point = async (): Promise<{ outcome: Promise<RecorderPickOutcome> }> => {
    const from = conn.accepted.length;
    const outcome = recorder.pick();
    const targets = [undefined, ...conn.frames];
    await until(
      () => targets.every((sessionId) => conn.accepted.slice(from).some((command) => command.method === 'Overlay.setInspectMode' && command.params.mode === 'searchForNode' && command.sessionId === sessionId)),
      'inspect mode'
    );
    return { outcome };
  };

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bug-recorder-pick-'));
    const listen = (handler: http.RequestListener) =>
      new Promise<number>((resolve) => {
        const server = http.createServer(handler);
        servers.push(server);
        server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
      });
    const other = await listen((_request, response) => response.writeHead(200, { 'content-type': 'text/html' }).end(FRAME_PAGE));
    let port = 0;
    port = await listen((request, response) =>
      response.writeHead(200, { 'content-type': 'text/html' }).end(request.url === '/frame' ? FRAME_PAGE : hostilePage({ sameSite: `http://127.0.0.1:${other}`, crossSite: `http://localhost:${port}` })));
    const origin = `http://127.0.0.1:${port}`;

    chrome = startChromeOverPipe({ executablePath: browser, userDataDir: path.join(root, 'profile'), env: chromeEnvironment(process.env, root) });
    conn = await openPipePage(chrome);
    let ready = false;
    recorder = new RecorderSession(conn.cdp, { primary: origin }, DEFAULT_BUG_CASE_ENVIRONMENT, (notice) => {
      if (notice.kind === 'ready') ready = true;
    });
    let loaded = false;
    conn.cdp.onEvent((method, _params, sessionId) => {
      if (method === 'Page.loadEventFired' && !sessionId) loaded = true;
    });
    await recorder.attach();
    await recorder.pinViewport();
    await conn.page('Page.navigate', { url: `${origin}/` });
    await until(() => ready && loaded && conn.frames.size === 1, 'the page and its cross-site frame', 15_000);
  }, 60_000);

  afterAll(async () => {
    recorder?.dispose();
    chrome?.transport.close();
    chrome?.process.kill('SIGKILL');
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await evaluate('window.__reset()');
  });

  it('takes the person’s click as the pick while the page swallows, forges and watches input', async () => {
    const total = await center('#total');
    const box = await evaluate<{ x: number; y: number; width: number; height: number }>(
      `(() => { const r = document.querySelector('#total').getBoundingClientRect(); const round = (n) => Math.round(n * 10) / 10; return { x: round(r.left), y: round(r.top), width: round(r.width), height: round(r.height) }; })()`
    );
    const elements = await evaluate<number>('document.getElementsByTagName("*").length');
    recorder.seal();
    await recorder.noteShot();
    const { outcome } = await point();
    await conn.page('Input.dispatchMouseEvent', { type: 'mouseMoved', x: total.x, y: total.y });
    // The page has been forging clicks on the total all along; none of them is a pick.
    const forged = await evaluate<number>('window.__forged');
    await until(async () => (await evaluate<number>('window.__forged')) >= forged + 10, 'the page to forge clicks while pointing');
    expect(await settled(outcome)).toBe(false);
    // Nothing was drawn into the page: the element under the pointer is still the page's own.
    expect(await evaluate(`document.elementFromPoint(${total.x}, ${total.y}).id`)).toBe('total');

    await click(total);

    const picked = await outcome;
    expect(picked).toMatchObject({ kind: 'picked', pick: { target: { tag: 'span', css: '#total', context: 'Cart total' }, text: '$40.00', visible: true, count: 1, box } });
    expect(recorder.log().mark?.picks).toEqual([picked.kind === 'picked' ? picked.pick : undefined]);
    // The page saw none of the person's input, so its decoy never covered the page.
    expect(await evaluate('({ trusted: window.__trusted, mutations: window.__mutations, elements: document.getElementsByTagName("*").length })'))
      .toEqual({ trusted: [], mutations: 0, elements });
  }, 30_000);

  it('keeps Chrome’s highlight on the pick until its numbered outline is drawn, or pointing is stopped', async () => {
    const swatch = await center('#swatch');
    const first = await point();
    await click(swatch);
    expect(await first.outcome).toMatchObject({ kind: 'picked', pick: { target: { css: '#swatch' } } });
    await until(() => tinted(swatch), 'the pick to stay highlighted');

    await recorder.showMarks([{ css: '#swatch', label: '1' }]);
    await until(async () => !(await tinted(swatch)), 'the highlight to give way to the outline');
    await recorder.showMarks([]);

    // Back to recording before the outline arrives drops the highlight as well.
    const second = await point();
    await click(swatch);
    expect(await second.outcome).toMatchObject({ kind: 'picked' });
    await until(() => tinted(swatch), 'the second pick to stay highlighted');
    await recorder.cancelPick();
    await until(async () => !(await tinted(swatch)), 'the highlight to go with Back to recording');
  }, 30_000);

  it('picks the shadow host when the person points inside a closed shadow root', async () => {
    const { outcome } = await point();
    await click(await center('#badge'));
    expect(await outcome).toMatchObject({ kind: 'picked', pick: { target: { tag: 'div', css: '#badge' } } });
  }, 30_000);

  it('ends pointing with the reason when the person points into an embedded frame, and the frame gets no input', async () => {
    const frames = ['#same-origin', '#same-site', '#cross-site'];
    for (const frame of frames) {
      const { outcome } = await point();
      await click(await center(frame));
      expect(await outcome, frame).toEqual({ kind: 'stopped', reason: EMBEDDED_FRAME_PICK_REASON });
    }
    // Returns once inspect mode is off on the page and every frame.
    await recorder.cancelPick();

    // A click once pointing stopped reaches each frame. Input a pointing click handed a frame
    // would have reached it first, so the frames heard only these.
    const heard: string[] = [];
    for (const frame of frames) {
      const host = await evaluate<string>(`new URL(document.querySelector(${JSON.stringify(frame)}).src).host`);
      await click(await center(frame));
      heard.push(...['pointerdown', 'mousedown', 'mouseup', 'click'].map((type) => `${host} ${type}`));
      await until(async () => (await evaluate<string[]>('window.__frameInput')).includes(`${host} click`), `${frame} to take the click`);
    }
    expect(await evaluate('window.__frameInput')).toEqual(heard);
  }, 30_000);

  it('stops on Stop pointing and on Escape, and the page takes clicks again', async () => {
    const stopped = await point();
    await recorder.cancelPick();
    expect(await stopped.outcome).toEqual({ kind: 'stopped' });
    expect(recorder.isPointing).toBe(false);

    await click(await center('#buy'));
    await until(async () => (await evaluate<string[]>('window.__trusted')).includes('click'), 'the page to take the click');

    // The click gave the page focus, so Escape reaches it as the person's key.
    const escaped = await point();
    await conn.page('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await conn.page('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    expect(await escaped.outcome).toEqual({ kind: 'stopped' });
  }, 30_000);
});
