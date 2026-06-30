import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CodexRuntimeResolutionError,
  discoverCodexRuntimeCandidates,
  resolveCodexRuntime,
  TASK_MONKI_CODEX_BIN_ENV,
  type TaskMonkiCodexAppServerMethod
} from './CodexRuntimeResolver';

describe('Codex runtime resolution', () => {
  it('discovers explicit, environment, PATH, app bundle, and VS Code extension candidates in order', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-codex-discover-'));
    const config = await writeFakeCodex(path.join(dir, 'config'), 'codex');
    const env = await writeFakeCodex(path.join(dir, 'env'), 'codex');
    const pathCandidate = await writeFakeCodex(path.join(dir, 'path'), 'codex');
    const app = await writeFakeCodex(
      path.join(dir, 'Codex.app', 'Contents', 'Resources'),
      'codex'
    );
    const extension = await writeFakeCodex(
      path.join(
        dir,
        'extensions',
        'openai.chatgpt-26.5623.61825-darwin-arm64',
        'bin',
        'macos-aarch64'
      ),
      'codex'
    );

    const candidates = await discoverCodexRuntimeCandidates({
      executable: config,
      cwd: dir,
      environment: {
        ...process.env,
        [TASK_MONKI_CODEX_BIN_ENV]: env
      },
      pathEntries: [path.dirname(pathCandidate)],
      appBundleCandidates: [app],
      extensionRoots: [path.join(dir, 'extensions')]
    });

    expect(candidates.map((candidate) => candidate.source)).toEqual([
      'config',
      'environment',
      'path',
      'codex-app-bundle',
      'vscode-extension-bundle'
    ]);
    expect(candidates.map((candidate) => candidate.executable)).toEqual([
      config,
      env,
      pathCandidate,
      app,
      extension
    ]);
  });

  it('skips an old incompatible PATH binary and selects a newer compatible runtime', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-codex-path-'));
    const oldCodex = await writeFakeCodex(path.join(dir, 'old'), 'codex', {
      version: '0.22.0',
      appServer: 'none'
    });
    const newCodex = await writeFakeCodex(path.join(dir, 'new'), 'codex', {
      version: '0.142.4'
    });

    const runtime = await resolveCodexRuntime({
      cwd: dir,
      environment: process.env,
      pathEntries: [path.dirname(oldCodex), path.dirname(newCodex)],
      appBundleCandidates: [],
      extensionRoots: [],
      requestTimeoutMs: 1_000
    });

    expect(runtime.executable).toBe(newCodex);
    expect(runtime.version).toBe('0.142.4');
    expect(runtime.diagnostics.find((result) => result.version === '0.22.0')).toMatchObject({
      compatible: false
    });
  });

  it('fails an incompatible explicit override instead of silently ignoring it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-codex-explicit-'));
    const oldCodex = await writeFakeCodex(path.join(dir, 'old'), 'codex', {
      version: '0.22.0',
      appServer: 'none'
    });
    const newCodex = await writeFakeCodex(path.join(dir, 'new'), 'codex', {
      version: '0.142.4'
    });

    await expect(
      resolveCodexRuntime({
        executable: oldCodex,
        cwd: dir,
        environment: process.env,
        pathEntries: [path.dirname(newCodex)],
        appBundleCandidates: [],
        extensionRoots: [],
        requestTimeoutMs: 1_000
      })
    ).rejects.toBeInstanceOf(CodexRuntimeResolutionError);
  });

  it('accepts a newer compatible runtime without a maximum-tested warning gate', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-codex-newer-'));
    const codex = await writeFakeCodex(path.join(dir, 'bin'), 'codex', {
      version: '0.999.0'
    });

    const runtime = await resolveCodexRuntime({
      cwd: dir,
      environment: process.env,
      pathEntries: [path.dirname(codex)],
      appBundleCandidates: [],
      extensionRoots: [],
      requestTimeoutMs: 1_000
    });

    expect(runtime.version).toBe('0.999.0');
    expect(runtime.compatibility.launch.argv).toEqual(['app-server', '--stdio']);
  });

  it('rejects a runtime that launches App Server but lacks a required JSON-RPC method', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-codex-missing-'));
    const incomplete = await writeFakeCodex(path.join(dir, 'incomplete'), 'codex', {
      version: '0.142.4',
      missingMethods: ['review/start']
    });

    await expect(
      resolveCodexRuntime({
        cwd: dir,
        environment: process.env,
        pathEntries: [path.dirname(incomplete)],
        appBundleCandidates: [],
        extensionRoots: [],
        requestTimeoutMs: 1_000
      })
    ).rejects.toThrow('review/start');
  });

  it('uses the documented listen stdio launch form when --stdio is unavailable', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-codex-listen-'));
    const codex = await writeFakeCodex(path.join(dir, 'bin'), 'codex', {
      appServer: 'listen'
    });

    const runtime = await resolveCodexRuntime({
      cwd: dir,
      environment: process.env,
      pathEntries: [path.dirname(codex)],
      appBundleCandidates: [],
      extensionRoots: [],
      requestTimeoutMs: 1_000
    });

    expect(runtime.compatibility.launch).toMatchObject({
      argv: ['app-server', '--listen', 'stdio://'],
      form: 'listen-stdio'
    });
  });
});

async function writeFakeCodex(
  directory: string,
  name: string,
  options: {
    version?: string;
    appServer?: 'stdio' | 'listen' | 'default' | 'none';
    missingMethods?: TaskMonkiCodexAppServerMethod[];
  } = {}
): Promise<string> {
  await fs.mkdir(directory, { recursive: true });
  const executable = path.join(directory, name);
  await fs.writeFile(executable, fakeCodexScript(options), { mode: 0o755 });
  return executable;
}

function fakeCodexScript({
  version = '0.141.0',
  appServer = 'stdio',
  missingMethods = []
}: {
  version?: string;
  appServer?: 'stdio' | 'listen' | 'default' | 'none';
  missingMethods?: TaskMonkiCodexAppServerMethod[];
}): string {
  return `#!/usr/bin/env node
const appServer = ${JSON.stringify(appServer)};
const missingMethods = new Set(${JSON.stringify(missingMethods)});

if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli ${version}\\n');
  process.exit(0);
}

if (process.argv[2] === 'app-server' && process.argv.includes('--help')) {
  if (appServer === 'none') {
    process.stdout.write('Usage: codex [OPTIONS] [PROMPT]\\n');
  } else if (appServer === 'stdio') {
    process.stdout.write('Usage: codex app-server [OPTIONS]\\n  --stdio\\n  --listen <URL>\\n');
  } else if (appServer === 'listen') {
    process.stdout.write('Usage: codex app-server [OPTIONS]\\n  --listen <URL>\\n');
  } else {
    process.stdout.write('Usage: codex app-server\\n');
  }
  process.exit(0);
}

if (process.argv[2] !== 'app-server') {
  process.stderr.write('unsupported command\\n');
  process.exit(2);
}

const launched =
  (appServer === 'stdio' && process.argv.includes('--stdio')) ||
  (appServer === 'listen' &&
    process.argv.includes('--listen') &&
    process.argv.includes('stdio://')) ||
  (appServer === 'default' && process.argv.length === 3);

if (!launched) {
  process.stderr.write('unsupported app-server launch form\\n');
  process.exit(2);
}

const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');

rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (!message.id || !message.method) return;
  if (message.method === 'initialize') {
    send({ id: message.id, result: {
      userAgent: 'fake-codex/${version}',
      codexHome: process.env.CODEX_HOME || process.cwd(),
      platformFamily: 'unix',
      platformOs: 'macos'
    } });
    return;
  }
  if (missingMethods.has(message.method)) {
    send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
    return;
  }
  send({ id: message.id, error: { code: -32602, message: 'Invalid params for ' + message.method } });
});
`;
}
