import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '@remotion/renderer';
import { prepareShowcaseSeed } from './prepare-showcase-seed.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(rootDir, 'public', 'remotion-showcase', 'captures');
const lisbonImage = path.resolve(
  process.env.TASK_MONKI_SHOWCASE_LISBON_IMAGE ??
    path.join(rootDir, 'src', 'remotion', 'prototypes', 'lisbon.png')
);
const apiPort = Number(process.env.TASK_MONKI_SHOWCASE_API_PORT ?? 5310);
const rendererPort = Number(process.env.TASK_MONKI_SHOWCASE_RENDERER_PORT ?? 5311);
const prototypePort = Number(process.env.TASK_MONKI_SHOWCASE_PROTOTYPE_PORT ?? 5312);

const roughPrompt =
  'Make the checkout API return the right error when the JSON body is empty or the wrong shape.';
const refinedPrompt = `Update the checkout API request-body parser.

Return a clear 400 validation response when an application/json body is null, an array, or another non-object value. Preserve the existing malformed-JSON response and add focused tests for the new cases.`;
const designPrompt =
  'Design a polished consumer travel planner for a five-day trip to Lisbon. Show the daily itinerary, saved places, travel times, and an interactive map. Let people add places and move them between days. Make the route understandable at a glance, with an editorial travel feel rather than dashboard styling.';

await access(lisbonImage);
let manifest;
if (process.env.TASK_MONKI_SHOWCASE_SKIP_SEED === '1') {
  manifest = JSON.parse(
    await readFile(path.join(rootDir, '.local', 'task-monki-dev-seed', 'manifest.json'), 'utf8')
  );
} else {
  await runCommand('npm', ['run', 'dev:seed'], rootDir);
  manifest = await prepareShowcaseSeed(rootDir);
}
await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

const prototypeServer = await startPrototypeServer();
const api = startProcess('node', ['dist-tools/dev/server.js'], {
  ...process.env,
  ...manifest.env,
  TASK_MANAGER_API_PORT: String(apiPort),
  TASK_MANAGER_RENDERER_PORT: String(rendererPort)
});
const renderer = startProcess(
  path.join(rootDir, 'node_modules', '.bin', 'vite'),
  ['--host', '127.0.0.1', '--port', String(rendererPort), '--strictPort'],
  {
    ...process.env,
    TASK_MANAGER_API_PORT: String(apiPort),
    TASK_MANAGER_RENDERER_PORT: String(rendererPort)
  }
);

let browser;
try {
  await waitForHttp(`http://127.0.0.1:${apiPort}/api/tasks`, 60_000, api);
  await waitForHttp(`http://127.0.0.1:${rendererPort}`, 60_000, renderer);
  browser = await openBrowser('chrome', {
    chromiumOptions: { darkMode: true, headless: true },
    forceDeviceScaleFactor: 1,
    logLevel: 'error'
  });

  const page = await createPage(browser, 1920, 1080, 0);
  await page.evaluateOnNewDocument(() => {
    window.localStorage.setItem('task-monki-theme', 'graphite');
    window.open = () => null;
  });
  await page.goto({ url: `http://127.0.0.1:${rendererPort}`, timeout: 60_000 });
  await waitForText(page, 'All tasks');

  await clickText(page, 'All tasks');
  await waitForText(page, 'Backlog / Ready');
  await save(page, '01-board.png');

  await clickText(page, 'Settings');
  await waitForText(page, 'Choose which coding agents Task Monki can use.');
  await save(page, '02-providers.png');

  await clickText(page, 'All tasks');
  await clickText(page, 'New task');
  await waitForSelector(page, 'form[aria-label="New task"]');
  await save(page, '03-new-task-empty.png');
  await setInputValue(page, 'input[placeholder="Short imperative summary"]', 'Handle null JSON request bodies');
  await setInputValue(page, '#task-description', roughPrompt);
  await save(page, '04-new-task-rough.png');
  await setInputValue(page, '#task-description', refinedPrompt);
  await save(page, '05-new-task-refined.png');
  await clickSelector(page, '.newtask-settings > summary');
  await save(page, '06-run-configuration.png');
  await clickAria(page, 'Close');

  await selectTask(page, 'Validate the checkout API change');
  await save(page, '07-task-ready.png');

  await selectTask(page, 'Handle null JSON request bodies');
  await save(page, '08-agent-running.png');
  await clickText(page, 'Debug', { exact: false });
  await waitForText(page, 'Provider activity');
  await save(page, '09-agent-debug.png');

  await selectTask(page, 'Validate the checkout API change');
  await clickText(page, 'Preview');
  await waitForText(page, 'Check preview');
  await save(page, '10-preview-missing.png');
  await clickText(page, 'Check preview');
  await waitForText(page, 'Preview setup');
  await save(page, '11-preview-setup.png');

  await selectTask(page, 'Prepare the checkout API preview');
  await clickText(page, 'Preview');
  await waitForText(page, 'Compose services');
  await save(page, '12-preview-plan.png');
  await clickSummary(page, 'Exact commands, recipients, readiness, and cleanup');
  await save(page, '13-preview-details.png');

  await selectTask(page, 'Test checkout validation in preview');
  await clickText(page, 'Preview');
  await waitForText(page, 'PostgreSQL');
  await save(page, '14-preview-ready.png');

  const checkoutPage = await createPage(browser, 1920, 1080, 1);
  await checkoutPage.goto({
    url: `http://127.0.0.1:${prototypePort}/checkout.html`,
    timeout: 30_000
  });
  await waitForText(checkoutPage, 'Null body returns validation error');
  await save(checkoutPage, '15-preview-app.png');

  await selectTask(page, 'Review null JSON request handling');
  await waitForText(page, 'Null JSON body returns the wrong error');
  await save(page, '16-review-needs-changes.png');
  await clickText(page, 'Address findings');
  await waitForText(page, 'Findings to attach');
  await save(page, '17-review-drawer.png');

  await clickAria(page, 'Close request changes');
  await selectTask(page, 'Fix null JSON validation');
  await save(page, '18-follow-up-running.png');

  await selectTask(page, 'Open null JSON validation PR');
  await waitForText(page, 'Draft PR');
  await save(page, '19-draft-pr.png');
  await selectTask(page, 'Ship null JSON validation');
  await waitForText(page, 'Ready to merge');
  await save(page, '20-ready-pr.png');

  await clickText(page, 'Designs');
  await clickText(page, 'New');
  await waitForText(page, 'New Design');
  await save(page, '21-design-new.png');
  await setInputValue(page, 'textarea', designPrompt);
  await save(page, '22-design-prompt.png');
  await clickAria(page, 'Close new Design');
  await clickText(page, 'Plan five days in Lisbon', { exact: false });
  await waitForText(page, 'Refine this Design');
  await save(page, '23-design-shell.png');

  const travelPage = await createPage(browser, 1280, 900, 2);
  await travelPage.goto({
    url: `http://127.0.0.1:${prototypePort}/travel.html`,
    timeout: 30_000
  });
  await waitForText(travelPage, 'Lisbon in 5 days');
  await waitForImages(travelPage);
  await save(travelPage, '23-travel-prototype.png', { width: 1280, height: 900 });

  await clickText(page, 'Discourse', { exact: false });
  await waitForText(page, 'Technical conversations');
  await save(page, '24-discourse-list.png');
  await clickText(page, 'Should preview environments share state?', { exact: false });
  await waitForText(page, 'Answer revised');
  await save(page, '25-discourse-answer.png');

  await selectTask(page, 'Review null JSON request handling');
  await clickText(page, 'Evidence');
  await waitForText(page, 'parseJsonBody.ts');
  await save(page, '26-evidence.png');
  await clickText(page, 'Debug', { exact: false });
  await waitForText(page, 'Provider activity');
  await save(page, '27-debug.png');

  await clickText(page, 'Active runs', { exact: false });
  await waitForText(page, 'Handle null JSON request bodies');
  await save(page, '28-closing-board.png');

  console.log(`Captured showcase frames in ${outputDir}`);
} finally {
  if (browser) await browser.close({ silent: true });
  await stopProcess(renderer.child);
  await stopProcess(api.child);
  await new Promise((resolve) => prototypeServer.close(resolve));
}

async function createPage(browser, width, height, pageIndex) {
  const page = await browser.newPage({
    context: () => null,
    logLevel: 'error',
    indent: false,
    pageIndex,
    onBrowserLog: null,
    onLog: () => {}
  });
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  return page;
}

async function selectTask(page, title) {
  await clickText(page, 'All tasks');
  await waitForText(page, title);
  await clickAria(page, `Open ${title}`);
  await waitForText(page, title);
}

async function save(page, name, expected = { width: 1920, height: 1080 }) {
  await settle(page);
  const result = await page._client().send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false
  });
  const buffer = Buffer.from(result.value.data, 'base64');
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width !== expected.width || height !== expected.height) {
    throw new Error(`${name} is ${width}x${height}; expected ${expected.width}x${expected.height}.`);
  }
  await writeFile(path.join(outputDir, name), buffer);
}

async function clickText(page, text, options = {}) {
  const exact = options.exact ?? true;
  const result = await page.evaluate(
    ({ expected, exactMatch }) => {
      const normalize = (value) => value.replace(/\s+/g, ' ').trim();
      const candidates = Array.from(document.querySelectorAll('button, [role="tab"]'));
      const matches = candidates.filter((candidate) => {
        const visible = normalize(candidate.textContent ?? '');
        return exactMatch ? visible === expected : visible.includes(expected);
      });
      if (matches.length === 0) return { ok: false, count: 0 };
      const target = matches[0];
      target.scrollIntoView({ block: 'center', inline: 'center' });
      target.click();
      return { ok: true, count: matches.length };
    },
    { expected: text, exactMatch: exact }
  );
  if (!result.ok) throw new Error(`Could not click text: ${text}`);
  await settle(page);
}

async function clickAria(page, ariaLabel) {
  const clicked = await page.evaluate((label) => {
    const candidates = Array.from(document.querySelectorAll(`[aria-label]`));
    const target = candidates.find((candidate) => candidate.getAttribute('aria-label') === label);
    if (!(target instanceof HTMLElement)) return false;
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.click();
    return true;
  }, ariaLabel);
  if (!clicked) throw new Error(`Could not click aria-label: ${ariaLabel}`);
  await settle(page);
}

async function clickSelector(page, selector) {
  const clicked = await page.evaluate((value) => {
    const target = document.querySelector(value);
    if (!(target instanceof HTMLElement)) return false;
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.click();
    return true;
  }, selector);
  if (!clicked) throw new Error(`Could not click selector: ${selector}`);
  await settle(page);
}

async function clickSummary(page, text) {
  const clicked = await page.evaluate((expected) => {
    const target = Array.from(document.querySelectorAll('summary')).find((summary) =>
      summary.textContent?.includes(expected)
    );
    if (!(target instanceof HTMLElement)) return false;
    target.scrollIntoView({ block: 'center', inline: 'center' });
    target.click();
    return true;
  }, text);
  if (!clicked) throw new Error(`Could not expand summary: ${text}`);
  await settle(page);
}

async function setInputValue(page, selector, value) {
  const updated = await page.evaluate(
    ({ selectorText, nextValue }) => {
      const input = document.querySelector(selectorText);
      if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) {
        return false;
      }
      const prototype = input instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      setter?.call(input, nextValue);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    },
    { selectorText: selector, nextValue: value }
  );
  if (!updated) throw new Error(`Could not set value for ${selector}.`);
  await settle(page);
}

async function waitForText(page, text, timeoutMs = 20_000) {
  await waitForPredicate(
    page,
    (expected) => document.body.textContent?.includes(expected) ?? false,
    text,
    timeoutMs
  );
}

async function waitForSelector(page, selector, timeoutMs = 20_000) {
  await waitForPredicate(
    page,
    (value) => Boolean(document.querySelector(value)),
    selector,
    timeoutMs
  );
}

async function waitForImages(page) {
  await waitForPredicate(
    page,
    () => Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0),
    undefined,
    30_000
  );
}

async function waitForPredicate(page, predicate, arg, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await page.evaluate(predicate, arg)) return;
    await delay(120);
  }
  throw new Error('Timed out waiting for the expected page state.');
}

async function settle(page) {
  await page.evaluate(
    () => new Promise((resolve) => {
      const ready = document.fonts?.ready ?? Promise.resolve();
      ready.then(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })
  );
  await delay(120);
}

function startProcess(command, args, env) {
  const child = spawn(command, args, { cwd: rootDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  return { child, output: () => output };
}

async function waitForHttp(url, timeoutMs, processState) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    if (processState.child.exitCode !== null) {
      throw new Error(`Process exited before ${url} was ready.\n${processState.output()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 401) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

async function startPrototypeServer() {
  const prototypeDir = path.join(rootDir, 'src', 'remotion', 'prototypes');
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const routes = {
      '/checkout.html': { path: path.join(prototypeDir, 'checkout.html'), type: 'text/html; charset=utf-8' },
      '/travel.html': { path: path.join(prototypeDir, 'travel.html'), type: 'text/html; charset=utf-8' },
      '/lisbon.png': { path: lisbonImage, type: 'image/png' }
    };
    const route = routes[pathname];
    if (!route) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, { 'content-type': route.type, 'cache-control': 'no-store' });
    createReadStream(route.path).pipe(response);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(prototypePort, '127.0.0.1', resolve);
  });
  return server;
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(4_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([exited, delay(1_000)]);
  }
}

async function runCommand(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}.`));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
