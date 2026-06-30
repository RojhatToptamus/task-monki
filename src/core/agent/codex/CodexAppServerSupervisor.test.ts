import { describe, expect, it } from 'vitest';
import type {
  CodexAppsMode,
  CodexMcpServersMode,
  CodexWebSearchMode
} from '../../../shared/agent';
import {
  CODEX_APP_SERVER_NOTIFICATION_OPT_OUTS,
  codexAppServerArgv,
  resolveCodexAppServerArgv
} from './CodexAppServerSupervisor';
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
});
