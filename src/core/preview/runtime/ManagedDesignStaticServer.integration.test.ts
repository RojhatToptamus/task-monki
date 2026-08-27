import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('close', resolve));
  }
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('managed-design-static-server', () => {
  it('serves only regular files with fixed security and cache headers', async () => {
    const fixture = await startFixture();
    const root = await request(fixture.port, '/');
    const script = await request(fixture.port, '/app.js', 'HEAD');
    const styles = await request(fixture.port, '/styles.css');
    const asset = await request(fixture.port, '/assets/mark.svg');

    expect(root).toMatchObject({
      status: 200,
      body: '<link rel="stylesheet" href="./styles.css"><h1>Design</h1><script src="./app.js" defer></script>\n'
    });
    expect(root.headers['content-security-policy']).toContain("default-src 'self'");
    expect(root.headers['content-security-policy']).toContain(
      "script-src 'self' 'unsafe-inline'"
    );
    expect(root.headers['content-security-policy']).toContain(
      "style-src 'self' 'unsafe-inline'"
    );
    expect(root.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(root.headers['cache-control']).toBe('no-store, max-age=0');
    expect(script).toMatchObject({ status: 200, body: '' });
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(styles).toMatchObject({ status: 200, body: 'body { color: navy; }\n' });
    expect(styles.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(asset).toMatchObject({
      status: 200,
      body: '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n'
    });
    expect(asset.headers['content-type']).toBe('image/svg+xml');
  });

  it('rejects traversal, malformed encoding, symlinks, directories, and unsupported methods', async () => {
    const fixture = await startFixture();
    const outside = path.join(fixture.root, 'outside.txt');
    await fs.writeFile(outside, 'outside');
    await fs.symlink(outside, path.join(fixture.source, 'escape.txt'));
    await fs.mkdir(path.join(fixture.source, 'directory'));

    await expectStatus(fixture.port, '/%2e%2e/outside.txt', 400);
    await expectStatus(fixture.port, '/..%2foutside.txt', 400);
    await expectStatus(fixture.port, '/%ZZ', 400);
    await expectStatus(fixture.port, '/escape.txt', 404);
    await expectStatus(fixture.port, '/directory', 404);
    await expectStatus(fixture.port, '/missing.txt', 404);
    await expectStatus(fixture.port, '/app.js', 405, 'POST');
  });
});

async function startFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-static-server-'));
  roots.push(root);
  const source = path.join(root, 'source');
  await fs.mkdir(path.join(source, 'assets'), { recursive: true });
  await fs.writeFile(
    path.join(source, 'index.html'),
    '<link rel="stylesheet" href="./styles.css"><h1>Design</h1><script src="./app.js" defer></script>\n'
  );
  await fs.writeFile(path.join(source, 'styles.css'), 'body { color: navy; }\n');
  await fs.writeFile(path.join(source, 'app.js'), 'console.log("design")\n');
  await fs.writeFile(
    path.join(source, 'assets', 'mark.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n'
  );
  const port = await reservePort();
  const serverPath = path.join(
    process.cwd(),
    'src/core/preview/runtime/managed-design-static-server.mjs'
  );
  const child = spawn(process.execPath, [serverPath], {
    cwd: source,
    env: { ...process.env, TASK_MONKI_MANAGED_STATIC_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.push(child);
  await waitUntilReady(child, port);
  return { root, source, port };
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test port is unavailable.');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitUntilReady(child: ChildProcess, port: number): Promise<void> {
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Static server exited early: ${stderr}`);
    const response = await request(port, '/').catch(() => undefined);
    if (response?.status === 200) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Static server did not become ready: ${stderr}`);
}

function request(port: number, requestPath: string, method = 'GET'): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      { host: '127.0.0.1', port, path: requestPath, method },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.once('end', () => resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8')
        }));
      }
    );
    outgoing.once('error', reject);
    outgoing.end();
  });
}

async function expectStatus(port: number, requestPath: string, status: number, method = 'GET') {
  await expect(request(port, requestPath, method)).resolves.toMatchObject({ status });
}
