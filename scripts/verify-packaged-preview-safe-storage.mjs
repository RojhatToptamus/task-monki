import { once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

if (process.platform !== 'darwin') {
  throw new Error('The packaged safeStorage relaunch verifier supports macOS only.');
}

const execFileAsync = promisify(execFile);

async function main() {
  const repositoryRoot = path.resolve(import.meta.dirname, '..');
  const executablePath = await findPackagedExecutable(path.join(repositoryRoot, 'release'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-packaged-safe-storage-'));
  const repositoryPath = path.join(root, 'repository');
  const userDataPath = path.join(root, 'user-data');
  const canary = `tm-safe-storage-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const inputId = 'relaunch-token';
  const capturedOutput = [];
  let running;

  try {
    await createFixtureRepository(repositoryPath, inputId);

  running = await launchPackagedApp({ executablePath, repositoryPath, userDataPath });
  capturedOutput.push(running.output);
  const first = await running.cdp.evaluate(`(async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && (!window.taskManager || !window.previewPrivateInputs)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!window.taskManager || !window.previewPrivateInputs) {
      throw new Error('Trusted packaged renderer APIs did not become available.');
    }
    const task = await window.taskManager.createTask({
      title: 'Packaged safeStorage relaunch verification',
      prompt: 'Verify encrypted private input persistence across a packaged relaunch.',
      repositoryPath: ${JSON.stringify(repositoryPath)}
    });
    await window.taskManager.prepareWorktree({ taskId: task.id });
    const before = await window.taskManager.resolvePreview({ taskId: task.id });
    if (before.status !== 'PLAN' || before.executionReadiness.status !== 'BLOCKED') {
      throw new Error('Expected the unresolved private input to block execution only.');
    }
    const stored = await window.previewPrivateInputs.set({
      taskId: task.id,
      inputId: ${JSON.stringify(inputId)},
      value: ${JSON.stringify(canary)}
    });
    if (stored.status !== 'STORED') throw new Error('safeStorage did not store the private input.');
    const after = await window.taskManager.resolvePreview({ taskId: task.id });
    if (after.status !== 'PLAN' || after.executionReadiness.status !== 'READY') {
      throw new Error('Stored private input did not become execution-ready.');
    }
    await window.taskManager.approvePreviewPlan({
      taskId: task.id,
      planId: after.plan.id,
      executionDigest: after.plan.executionDigest
    });
    return { taskId: task.id, planId: after.plan.id };
  })()`);
  await stopPackagedApp(running);
  running = undefined;

  await assertCanaryAbsent(userDataPath, canary);

  running = await launchPackagedApp({ executablePath, repositoryPath, userDataPath });
  capturedOutput.push(running.output);
  const second = await running.cdp.evaluate(`(async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && (!window.taskManager || !window.previewPrivateInputs)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!window.taskManager || !window.previewPrivateInputs) {
      throw new Error('Trusted packaged renderer APIs did not become available.');
    }
    const resolved = await window.taskManager.resolvePreview({ taskId: ${JSON.stringify(first.taskId)} });
    if (resolved.status !== 'PLAN' || resolved.executionReadiness.status !== 'READY') {
      throw new Error('The private input was not ready after relaunch.');
    }
    const generation = await window.taskManager.startPreview({ taskId: ${JSON.stringify(first.taskId)} });
    if (generation.state !== 'READY') throw new Error('The recipient did not start after relaunch decryption.');
    await window.taskManager.stopPreview({ taskId: ${JSON.stringify(first.taskId)}, generationId: generation.id });
    return { generationId: generation.id, state: generation.state };
  })()`);
  await stopPackagedApp(running);
  running = undefined;

  await assertCanaryAbsent(userDataPath, canary);
  assertTextDoesNotContainCanary(capturedOutput.map((capture) => capture()).join('\n'), canary, 'packaged process output');

  const vaultFiles = (await listFiles(userDataPath)).filter((file) => file.endsWith('.blob'));
  if (vaultFiles.length !== 1) {
    throw new Error(`Expected one encrypted private-input revision after relaunch, found ${vaultFiles.length}.`);
  }

  console.log(JSON.stringify({
    status: 'passed',
    app: path.dirname(path.dirname(path.dirname(executablePath))),
    firstPlanId: first.planId,
    generationId: second.generationId,
    encryptedRevisionCount: vaultFiles.length,
    plaintextScan: 'passed',
    relaunchDecryption: 'passed'
  }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      output: capturedOutput.map((capture) => capture()).join('\n').slice(-20_000)
    }));
    throw error;
  } finally {
    if (running) await stopPackagedApp(running).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function createFixtureRepository(repositoryPath, privateInputId) {
  await fs.mkdir(path.join(repositoryPath, '.taskmonki'), { recursive: true });
  await fs.writeFile(path.join(repositoryPath, '.taskmonki', 'preview.yaml'), `version: 1
inputs:
  ${privateInputId}: { type: private, label: Relaunch token }
jobs: {}
services:
  verifier:
    command: [node, -e, "if (!process.env.TASK_MONKI_SAFE_STORAGE_CANARY) process.exit(23); require('http').createServer((_request, response) => response.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')"]
    env:
      TASK_MONKI_SAFE_STORAGE_CANARY: { type: private-input, input: ${privateInputId} }
    ports:
      http: { env: PORT }
    ready: { type: tcp, port: http }
routes:
  verifier: { service: verifier, port: http, primary: true }
`);
  await fs.writeFile(path.join(repositoryPath, 'README.md'), '# Packaged safeStorage verifier\n');
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: repositoryPath });
  await execFileAsync('git', ['config', 'user.name', 'Task Monki Verifier'], { cwd: repositoryPath });
  await execFileAsync('git', ['config', 'user.email', 'verifier@taskmonki.invalid'], { cwd: repositoryPath });
  await execFileAsync('git', ['add', '.'], { cwd: repositoryPath });
  await execFileAsync('git', ['commit', '-m', 'Create packaged safeStorage fixture'], { cwd: repositoryPath });
}

async function launchPackagedApp({ executablePath, repositoryPath, userDataPath }) {
  const port = await reservePort();
  const child = spawn(executablePath, [
    `--user-data-dir=${userDataPath}`,
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run'
  ], {
    env: { ...process.env, TASK_MANAGER_REPO_PATH: repositoryPath },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
  child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
  const output = () => `${stdout}\n${stderr}`;
  try {
    const cdp = await connectToTrustedRenderer(port, child, output);
    return { child, cdp, output };
  } catch (error) {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => undefined);
    throw error;
  }
}

async function connectToTrustedRenderer(port, child, output) {
  const deadline = Date.now() + 45_000;
  let lastError;
  while (Date.now() < deadline) {
    let cdp;
    try {
      const target = await waitForRendererTarget(port, child, output);
      cdp = await CdpConnection.open(target.webSocketDebuggerUrl);
      const verifyTrustedApi = `(async () => {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline && (!window.taskManager || !window.previewPrivateInputs)) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (!window.taskManager || !window.previewPrivateInputs) {
          throw new Error('Trusted packaged renderer APIs did not become available.');
        }
        await window.taskManager.getDefaultRepositoryPath();
        return true;
      })()`;
      await cdp.evaluate(verifyTrustedApi);
      await delay(250);
      await cdp.evaluate(verifyTrustedApi);
      return cdp;
    } catch (error) {
      lastError = error;
      cdp?.close();
      if (child.exitCode !== null) break;
      await delay(100);
    }
  }
  throw new Error(
    `Timed out waiting for a stable trusted packaged renderer: ${lastError instanceof Error ? lastError.message : String(lastError)}\n${output()}`
  );
}

async function stopPackagedApp(runningApp) {
  const { child, cdp } = runningApp;
  const exited = child.exitCode === null ? once(child, 'exit') : Promise.resolve();
  await cdp.send('Browser.close').catch(() => undefined);
  cdp.close();
  try {
    await withTimeout(exited, 20_000, 'Packaged app did not exit after Browser.close.');
  } catch {
    child.kill('SIGTERM');
    await withTimeout(child.exitCode === null ? once(child, 'exit') : Promise.resolve(), 10_000, 'Packaged app did not exit after SIGTERM.');
  }
}

class CdpConnection {
  static async open(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return new CdpConnection(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('DevTools connection closed.'));
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? 'Packaged renderer evaluation failed.';
      throw new Error(description);
    }
    return result.result.value;
  }

  close() {
    if (this.socket.readyState < WebSocket.CLOSING) this.socket.close();
  }
}

async function waitForRendererTarget(port, child, output) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Packaged app exited before its renderer was ready.\n${output()}`);
    }
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const target = targets.find((candidate) => candidate.type === 'page' && candidate.url.startsWith('file:'));
      if (target?.webSocketDebuggerUrl) return target;
    } catch {}
    await delay(100);
  }
  throw new Error(`Timed out waiting for the packaged renderer.\n${output()}`);
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : undefined;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error('Could not reserve a loopback DevTools port.');
  return port;
}

async function assertCanaryAbsent(rootPath, value) {
  const needles = [value, Buffer.from(value, 'utf8').toString('base64'), Buffer.from(value, 'utf8').toString('hex'), encodeURIComponent(value)];
  for (const filePath of await listFiles(rootPath)) {
    const data = await fs.readFile(filePath).catch(() => undefined);
    if (!data) continue;
    for (const needle of needles) {
      if (data.includes(Buffer.from(needle, 'utf8'))) {
        throw new Error(`Private-input plaintext was found in durable packaged-app storage: ${path.relative(rootPath, filePath)}`);
      }
    }
  }
}

function assertTextDoesNotContainCanary(text, value, surface) {
  const needles = [value, Buffer.from(value, 'utf8').toString('base64'), Buffer.from(value, 'utf8').toString('hex'), encodeURIComponent(value)];
  if (needles.some((needle) => text.includes(needle))) {
    throw new Error(`Private-input plaintext was found in ${surface}.`);
  }
}

async function listFiles(rootPath) {
  const files = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  }
  await visit(rootPath);
  return files;
}

async function findPackagedExecutable(rootPath) {
  const entries = await fs.readdir(rootPath, { recursive: true });
  const suffix = path.join('Task Monki.app', 'Contents', 'MacOS', 'Task Monki');
  const matches = entries.filter((entry) => entry.endsWith(suffix)).map((entry) => path.join(rootPath, entry)).sort();
  if (matches.length === 0) {
    throw new Error('No packaged Task Monki .app executable was found under release/. Run npm run dist:dir first.');
  }
  return matches[0];
}

function appendBounded(current, chunk) {
  const next = `${current}${chunk}`;
  return next.length > 200_000 ? next.slice(-200_000) : next;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

await main();
