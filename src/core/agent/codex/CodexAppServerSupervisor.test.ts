import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  CodexAppsMode,
  CodexMcpServersMode,
  CodexWebSearchMode
} from '../../../shared/agent';
import {
  CodexAppServerSupervisor,
  CODEX_APP_SERVER_NOTIFICATION_OPT_OUTS,
  codexAppServerArgv,
  resolveCodexAppServerArgv
} from './CodexAppServerSupervisor';
import { FileTaskStore } from '../../storage/FileTaskStore';
import { writeNodeExecutable } from '../../../testSupport/fakeExecutable';
import {
  codexExternalToolConfigOverrides,
  parseDisabledCodexMcpServerConfigOverrides,
  parseEnabledCodexMcpServerNames
} from './CodexToolConfig';

const WEB_SEARCH_MODES: CodexWebSearchMode[] = ['disabled', 'cached', 'live'];
const MCP_SERVER_MODES: CodexMcpServersMode[] = ['disabled', 'all'];
const APP_MODES: CodexAppsMode[] = ['disabled', 'enabled'];
const SAMPLE_MCP_DISABLE_OVERRIDE =
  'mcp_servers.docs={enabled=false, command="docs-mcp", args=["--stdio"]}';

describe('Codex App Server launch configuration', () => {
  it('starts the embedded app-server with minimal built-in tool configuration overrides', () => {
    expect(codexAppServerArgv()).toEqual([
      'app-server',
      '--stdio',
      '-c',
      'features.apps=false',
      '-c',
      'web_search="disabled"'
    ]);
  });

  it('starts the embedded app-server with discovered MCP disable overrides', () => {
    expect(
      codexAppServerArgv({
        mcpServerConfigOverrides: [
          'mcp_servers.next-devtools={enabled=false, command="npx", args=["next-devtools-mcp@latest"]}'
        ]
      })
    ).toEqual([
      'app-server',
      '--stdio',
      '-c',
      'features.apps=false',
      '-c',
      'web_search="disabled"',
      '-c',
      'mcp_servers.next-devtools={enabled=false, command="npx", args=["next-devtools-mcp@latest"]}'
    ]);
  });

  it('uses documented Codex config overrides for opt-in external tools', () => {
    expect(
      codexAppServerArgv({
        toolSettings: {
          webSearchMode: 'live',
          mcpServers: 'all',
          apps: 'enabled'
        }
      })
    ).toEqual([
      'app-server',
      '--stdio',
      '-c',
      'features.apps=true',
      '-c',
      'web_search="live"'
    ]);
  });

  it('can build argv for a runtime that only exposes default stdio app-server launch', () => {
    expect(
      codexAppServerArgv({
        appServerArgv: ['app-server'],
        toolSettings: {
          webSearchMode: 'disabled',
          mcpServers: 'disabled',
          apps: 'disabled'
        }
      })
    ).toEqual([
      'app-server',
      '-c',
      'features.apps=false',
      '-c',
      'web_search="disabled"'
    ]);
  });

  it('does not inspect MCP configuration when all MCP servers are allowed', async () => {
    await expect(
      resolveCodexAppServerArgv({
        executable: '/definitely/not/codex',
        cwd: process.cwd(),
        toolSettings: {
          webSearchMode: 'cached',
          mcpServers: 'all',
          apps: 'disabled'
        }
      })
    ).resolves.toEqual([
      'app-server',
      '--stdio',
      '-c',
      'features.apps=false',
      '-c',
      'web_search="cached"'
    ]);
  });

  it('projects every external tool config variation into App Server argv', () => {
    for (const webSearchMode of WEB_SEARCH_MODES) {
      for (const mcpServers of MCP_SERVER_MODES) {
        for (const apps of APP_MODES) {
          expect(
            codexAppServerArgv({
              toolSettings: {
                webSearchMode,
                mcpServers,
                apps
              },
              mcpServerConfigOverrides:
                mcpServers === 'disabled' ? [SAMPLE_MCP_DISABLE_OVERRIDE] : []
            })
          ).toEqual([
            'app-server',
            '--stdio',
            '-c',
            `features.apps=${apps === 'enabled' ? 'true' : 'false'}`,
            '-c',
            `web_search="${webSearchMode}"`,
            ...(mcpServers === 'disabled' ? ['-c', SAMPLE_MCP_DISABLE_OVERRIDE] : [])
          ]);
        }
      }
    }
  });

  it('normalizes malformed launch settings back to local-only', () => {
    expect(codexExternalToolConfigOverrides(undefined)).toEqual([
      'features.apps=false',
      'web_search="disabled"'
    ]);
  });

  it('builds transport-shaped MCP disable overrides without keeping env data', () => {
    const json = JSON.stringify([
      {
        name: 'next-devtools',
        enabled: true,
        transport: { type: 'stdio', command: 'npx', args: ['next-devtools-mcp@latest'] }
      },
      {
        name: 'openaiDeveloperDocs',
        enabled: true,
        transport: { type: 'streamable_http', url: 'https://developers.openai.com/mcp' }
      },
      {
        name: 'ask-starknet',
        enabled: false,
        transport: { type: 'stdio', command: 'npx', env: { KEY: 'secret' } }
      },
      {
        name: 'unsafe.server',
        enabled: true,
        transport: { type: 'stdio', command: 'node' }
      }
    ]);

    expect(parseDisabledCodexMcpServerConfigOverrides(json)).toEqual([
      'mcp_servers.next-devtools={enabled=false, command="npx", args=["next-devtools-mcp@latest"]}',
      'mcp_servers.openaiDeveloperDocs={enabled=false, url="https://developers.openai.com/mcp"}'
    ]);
    expect(parseEnabledCodexMcpServerNames(json)).toEqual([
      'next-devtools',
      'openaiDeveloperDocs'
    ]);
  });

  it('opts out of high-volume notifications that are not Task Monki evidence', () => {
    expect(CODEX_APP_SERVER_NOTIFICATION_OPT_OUTS).toEqual(
      expect.arrayContaining([
        'item/agentMessage/delta',
        'item/commandExecution/outputDelta',
        'item/reasoning/summaryTextDelta',
        'turn/diff/updated'
      ])
    );
  });

  it('joins runtime resolution and cannot spawn after shutdown begins', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-monki-supervisor-start-race-'));
    const markerPath = path.join(dir, 'version-started');
    const releasePath = path.join(dir, 'release-version');
    const executable = await writeNodeExecutable(
      dir,
      'gated-codex',
      gatedRuntimeScript(markerPath, releasePath)
    );
    const store = new FileTaskStore(path.join(dir, 'store'));
    const supervisor = new CodexAppServerSupervisor(store, {
      cwd: dir,
      executable,
      appVersion: 'test',
      requestTimeoutMs: 2_000
    });

    const start = supervisor.start();
    const rejectedStart = expect(start).rejects.toThrow(
      'Codex App Server is shutting down.'
    );
    await waitForPath(markerPath);
    let shutdownSettled = false;
    const shutdown = supervisor.shutdown().then(() => { shutdownSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(shutdownSettled).toBe(false);

    await fs.writeFile(releasePath, 'release');
    await rejectedStart;
    await shutdown;

    const internals = supervisor as unknown as {
      child?: unknown;
      client?: unknown;
      startPromise?: Promise<unknown>;
      shutdownPromise?: Promise<unknown>;
    };
    expect((await store.snapshot()).agentServers).toHaveLength(0);
    expect(internals.child).toBeUndefined();
    expect(internals.client).toBeUndefined();
    expect(internals.startPromise).toBeUndefined();
    expect(internals.shutdownPromise).toBeUndefined();
    await expect(supervisor.start()).rejects.toThrow(
      'Codex App Server is shutting down.'
    );

    supervisor.resumeAfterShutdown();
    const restarted = await supervisor.start();
    expect(restarted).toBe(supervisor.currentClient);
    await supervisor.shutdown();
    expect((await store.snapshot()).agentServers).toHaveLength(1);
    expect(internals.child).toBeUndefined();
    expect(internals.client).toBeUndefined();
  }, 15_000);
});

function gatedRuntimeScript(markerPath: string, releasePath: string): string {
  return `
const fs = require('node:fs');
if (process.argv.includes('--version')) {
  fs.writeFileSync(${JSON.stringify(markerPath)}, 'started');
  const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(releasePath)})) return;
    clearInterval(timer);
    process.stdout.write('codex-cli 0.141.0\\n');
    process.exit(0);
  }, 5);
  return;
}
if (process.argv[2] === 'mcp' && process.argv[3] === 'list') {
  process.stdout.write('[]\\n');
  process.exit(0);
}
if (process.argv[2] === 'app-server' && process.argv.includes('--help')) {
  process.stdout.write('Usage: codex app-server [OPTIONS]\\n  --stdio\\n');
  process.exit(0);
}
const readline = require('node:readline');
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (!('id' in message)) return;
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: message.id, result: {
      userAgent: 'fake', codexHome: process.cwd(), platformFamily: 'unix', platformOs: 'macos'
    } }) + '\\n');
    return;
  }
  if (message.method === 'thread/start') {
    process.stdout.write(JSON.stringify({ id: message.id, result: {
      activePermissionProfile: { id: 'task_monki_capability_probe', extends: null },
      runtimeWorkspaceRoots: [message.params.cwd]
    } }) + '\\n');
    return;
  }
  process.stdout.write(JSON.stringify({ id: message.id, error: {
    code: -32602, message: 'capability exists; test params are intentionally invalid'
  } }) + '\\n');
});
`;
}

async function waitForPath(filePath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}
