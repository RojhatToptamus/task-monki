import { describe, expect, it } from 'vitest';
import type {
  CodexAppsMode,
  CodexExternalToolSettings,
  CodexMcpServersMode,
  CodexWebSearchMode
} from '../../../shared/agent';
import {
  assertCodexAttachmentExternalToolsDisabled,
  assertCodexDiscourseExternalToolsDisabled,
  codexExternalToolConfigOverrides,
  parseDisabledCodexMcpServerConfigOverrides,
  resolveCodexExternalToolConfigOverrides
} from './CodexToolConfig';

const WEB_SEARCH_MODES: CodexWebSearchMode[] = ['disabled', 'cached', 'live'];
const MCP_SERVER_MODES: CodexMcpServersMode[] = ['disabled', 'all'];
const APP_MODES: CodexAppsMode[] = ['disabled', 'enabled'];
const SAMPLE_MCP_DISABLE_OVERRIDE =
  'mcp_servers.docs={enabled=false, command="docs-mcp", args=["--stdio"]}';

describe('Codex external tool config', () => {
  it('requires all external tools to be disabled only for attachment runs', () => {
    const enabled: CodexExternalToolSettings = {
      webSearchMode: 'live',
      mcpServers: 'all',
      apps: 'enabled'
    };
    expect(() => assertCodexAttachmentExternalToolsDisabled(enabled, false)).not.toThrow();
    expect(() => assertCodexAttachmentExternalToolsDisabled(enabled, true)).toThrow(
      'web search, MCP servers, and apps'
    );
    expect(() =>
      assertCodexAttachmentExternalToolsDisabled(
        { webSearchMode: 'disabled', mcpServers: 'disabled', apps: 'disabled' },
        true
      )
    ).not.toThrow();
  });

  it('requires all external tools to be disabled for every discourse job', () => {
    expect(() =>
      assertCodexDiscourseExternalToolsDisabled({
        webSearchMode: 'disabled',
        mcpServers: 'disabled',
        apps: 'disabled'
      })
    ).not.toThrow();
    for (const settings of [
      { webSearchMode: 'live', mcpServers: 'disabled', apps: 'disabled' },
      { webSearchMode: 'disabled', mcpServers: 'all', apps: 'disabled' },
      { webSearchMode: 'disabled', mcpServers: 'disabled', apps: 'enabled' }
    ] as const) {
      expect(() => assertCodexDiscourseExternalToolsDisabled(settings)).toThrow(
        'Agent discourse requires'
      );
    }
  });

  it('emits exact web search and apps overrides for every supported mode', () => {
    for (const webSearchMode of WEB_SEARCH_MODES) {
      for (const apps of APP_MODES) {
        expect(
          codexExternalToolConfigOverrides({
            webSearchMode,
            mcpServers: 'disabled',
            apps
          })
        ).toEqual([
          `features.apps=${apps === 'enabled' ? 'true' : 'false'}`,
          `web_search="${webSearchMode}"`
        ]);
      }
    }
  });

  it('resolves every web search, MCP, and apps combination without flipping a switch', async () => {
    for (const webSearchMode of WEB_SEARCH_MODES) {
      for (const mcpServers of MCP_SERVER_MODES) {
        for (const apps of APP_MODES) {
          const settings: CodexExternalToolSettings = {
            webSearchMode,
            mcpServers,
            apps
          };

          await expect(
            resolveCodexExternalToolConfigOverrides({
              executable: '/not/used/when/overrides/are/provided',
              cwd: process.cwd(),
              settings,
              mcpServerConfigOverrides: [SAMPLE_MCP_DISABLE_OVERRIDE]
            })
          ).resolves.toEqual([
            `features.apps=${apps === 'enabled' ? 'true' : 'false'}`,
            `web_search="${webSearchMode}"`,
            ...(mcpServers === 'disabled' ? [SAMPLE_MCP_DISABLE_OVERRIDE] : [])
          ]);
        }
      }
    }
  });

  it('normalizes malformed values to disabled defaults before resolving overrides', async () => {
    await expect(
      resolveCodexExternalToolConfigOverrides({
        executable: '/not/used/when/overrides/are/provided',
        cwd: process.cwd(),
        settings: {
          webSearchMode: 'recent',
          mcpServers: true,
          apps: 'yes'
        } as unknown as CodexExternalToolSettings,
        mcpServerConfigOverrides: [SAMPLE_MCP_DISABLE_OVERRIDE]
      })
    ).resolves.toEqual([
      'features.apps=false',
      'web_search="disabled"',
      SAMPLE_MCP_DISABLE_OVERRIDE
    ]);
  });

  it('fails closed when browser-dev cannot completely discover enabled MCP servers', async () => {
    await expect(
      resolveCodexExternalToolConfigOverrides({
        executable: '/not/reached',
        cwd: process.cwd(),
        settings: {
          webSearchMode: 'disabled',
          mcpServers: 'all',
          apps: 'disabled'
        },
        failClosedMcpDiscovery: true
      })
    ).rejects.toThrow('external tools must all be disabled');
    await expect(
      resolveCodexExternalToolConfigOverrides({
        executable: '/definitely/not/codex',
        cwd: process.cwd(),
        settings: {
          webSearchMode: 'disabled',
          mcpServers: 'disabled',
          apps: 'disabled'
        },
        failClosedMcpDiscovery: true
      })
    ).rejects.toThrow('could not be completely inspected and disabled');

    expect(() =>
      parseDisabledCodexMcpServerConfigOverrides(
        JSON.stringify([
          {
            name: 'unsafe',
            enabled: true,
            transport: { type: 'unknown' }
          }
        ]),
        { requireCompleteDiscovery: true }
      )
    ).toThrow('could not be disabled safely');
    expect(() =>
      parseDisabledCodexMcpServerConfigOverrides('{}', {
        requireCompleteDiscovery: true
      })
    ).toThrow('could not be disabled safely');
  });
});
