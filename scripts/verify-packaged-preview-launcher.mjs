import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.platform !== 'darwin') {
  throw new Error('The Phase 1 packaged launcher verifier currently supports macOS only.');
}

const projectRoot = process.cwd();
const releaseRoot = path.join(projectRoot, 'release');
const appRoot = path.join(
  releaseRoot,
  process.arch === 'arm64' ? 'mac-arm64' : 'mac',
  'Task Monki.app'
);
const executablePath = path.join(appRoot, 'Contents', 'MacOS', 'Task Monki');
const launcherPath = path.join(appRoot, 'Contents', 'Resources', 'native-preview-launcher.mjs');
const managedStaticServerPath = path.join(
  appRoot,
  'Contents',
  'Resources',
  'managed-design-static-server.mjs'
);
await fs.access(launcherPath);
await fs.access(managedStaticServerPath);
await fs.access(executablePath);

const hostModule = await import(
  pathToFileURL(
    path.join(projectRoot, 'dist-electron', 'core', 'preview', 'runtime', 'NativeLauncherHost.js')
  ).href
);
const { NativeLauncherHost, readNativeLauncherReceipt } = hostModule;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-packaged-launcher-'));
const receiptPath = path.join(root, 'runtime', 'ownership.json');
const stdoutPath = path.join(root, 'stdout.log');
const stderrPath = path.join(root, 'stderr.log');
const sourcePath = path.join(root, 'source');
const expectedBody = '<!doctype html><title>Packaged Design Preview</title>\n';
await fs.mkdir(sourcePath, { mode: 0o700 });
await fs.writeFile(path.join(sourcePath, 'index.html'), expectedBody, { mode: 0o600 });
await fs.writeFile(stdoutPath, '', { mode: 0o600 });
await fs.writeFile(stderrPath, '', { mode: 0o600 });

let owned;
try {
  let preparedPersisted = false;
  const port = await reserveLoopbackPort();
  const host = new NativeLauncherHost(launcherPath, executablePath, {
    ELECTRON_RUN_AS_NODE: '1'
  });
  owned = await host.launch({
    receiptPath,
    executable: executablePath,
    argv: [managedStaticServerPath],
    cwd: sourcePath,
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      TASK_MONKI_MANAGED_STATIC_PORT: String(port),
      PATH: '/usr/bin:/bin',
      HOME: os.homedir()
    },
    stdoutPath,
    stderrPath,
    async persistPrepared(identity) {
      const receipt = await readNativeLauncherReceipt(identity.receiptPath);
      if (receipt.state !== 'PREPARED') {
        throw new Error(`Expected PREPARED receipt, received ${receipt.state}.`);
      }
      preparedPersisted = true;
    }
  });
  const response = await waitForPreview(port);
  if (!preparedPersisted) {
    throw new Error('Packaged launcher did not persist its prepared identity.');
  }
  if (response.statusCode !== 200 || response.body !== expectedBody) {
    throw new Error(`Packaged Design Preview response mismatch: ${JSON.stringify(response)}`);
  }
  if (response.headers['cache-control'] !== 'no-store, max-age=0') {
    throw new Error('Packaged Design Preview did not disable HTTP caching.');
  }
  if (!response.headers['content-security-policy']?.includes("frame-ancestors 'none'")) {
    throw new Error('Packaged Design Preview did not return its content security policy.');
  }
  const receipt = await owned.stop();
  owned = undefined;
  if (receipt.state !== 'STOPPED') {
    throw new Error(`Packaged Design Preview did not stop cleanly: ${JSON.stringify(receipt)}`);
  }
  console.log(
    JSON.stringify(
      {
        status: 'passed',
        app: appRoot,
        executable: executablePath,
        launcher: launcherPath,
        managedStaticServer: managedStaticServerPath,
        electronRunAsNode: true,
        systemNodeRequiredByLauncher: false,
        receiptState: receipt.state,
        previewStatusCode: response.statusCode,
        cacheControl: response.headers['cache-control']
      },
      null,
      2
    )
  );
} catch (error) {
  const [receipt, stdout, stderr] = await Promise.all([
    readNativeLauncherReceipt(receiptPath).catch(() => undefined),
    fs.readFile(stdoutPath, 'utf8').catch(() => ''),
    fs.readFile(stderrPath, 'utf8').catch(() => '')
  ]);
  console.error(
    JSON.stringify({ receipt, stdout, stderr, error: error instanceof Error ? error.message : String(error) })
  );
  throw error;
} finally {
  if (owned) await owned.stop();
  await fs.rm(root, { recursive: true, force: true });
}

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') throw new Error('Could not reserve a loopback port.');
  return address.port;
}

async function waitForPreview(port) {
  const deadline = Date.now() + 10_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await requestPreview(port);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Packaged Design Preview did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function requestPreview(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1_000 }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.once('timeout', () => request.destroy(new Error('HTTP request timed out.')));
    request.once('error', reject);
  });
}
