import {
  DEFAULT_CODEX_EXTERNAL_TOOL_SETTINGS,
  type CodexExternalToolSettings
} from '../../../shared/agent';
import { sanitizeEnvironment } from '../../process/ProcessSupervisor';
import { execFilePortable } from '../../process/portableChildProcess';
const CODEX_MCP_LIST_TIMEOUT_MS = 5_000;

interface CodexMcpServerListEntry {
  name?: unknown;
  enabled?: unknown;
  transport?: unknown;
}

interface CodexMcpTransport {
  type?: unknown;
  command?: unknown;
  args?: unknown;
  cwd?: unknown;
  url?: unknown;
}

export function normalizeCodexExternalToolSettings(
  settings: CodexExternalToolSettings | undefined
): CodexExternalToolSettings {
  return {
    webSearchMode:
      settings?.webSearchMode === 'cached' || settings?.webSearchMode === 'live'
        ? settings.webSearchMode
        : 'disabled',
    mcpServers: settings?.mcpServers === 'all' ? 'all' : 'disabled',
    apps: settings?.apps === 'enabled' ? 'enabled' : 'disabled'
  };
}

export function assertCodexAttachmentExternalToolsDisabled(
  settings: CodexExternalToolSettings | undefined,
  hasAttachments: boolean
): void {
  if (!hasAttachments) return;
  const normalized = normalizeCodexExternalToolSettings(settings);
  if (
    normalized.webSearchMode !== 'disabled' ||
    normalized.mcpServers !== 'disabled' ||
    normalized.apps !== 'disabled'
  ) {
    throw new Error(
      'Attachments require Codex web search, MCP servers, and apps to be disabled.'
    );
  }
}

export function codexExternalToolConfigOverrides(
  settings: CodexExternalToolSettings = DEFAULT_CODEX_EXTERNAL_TOOL_SETTINGS
): string[] {
  const normalized = normalizeCodexExternalToolSettings(settings);
  return [
    `features.apps=${normalized.apps === 'enabled' ? 'true' : 'false'}`,
    `web_search=${tomlString(normalized.webSearchMode)}`
  ];
}

export async function resolveCodexExternalToolConfigOverrides(input: {
  executable: string;
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  settings?: CodexExternalToolSettings;
  mcpServerConfigOverrides?: readonly string[];
  failClosedMcpDiscovery?: boolean;
}): Promise<string[]> {
  const normalized = normalizeCodexExternalToolSettings(input.settings);
  if (
    input.failClosedMcpDiscovery &&
    (normalized.webSearchMode !== 'disabled' ||
      normalized.mcpServers !== 'disabled' ||
      normalized.apps !== 'disabled')
  ) {
    throw new Error(
      'Codex external tools must all be disabled for the browser development boundary.'
    );
  }
  const overrides = codexExternalToolConfigOverrides(normalized);
  if (normalized.mcpServers === 'all') {
    return overrides;
  }

  if (input.mcpServerConfigOverrides) {
    return [...overrides, ...input.mcpServerConfigOverrides];
  }

  try {
    return [
      ...overrides,
      ...(await listDisabledCodexMcpServerConfigOverrides(
        input.executable,
        input.cwd,
        input.environment,
        { requireCompleteDiscovery: input.failClosedMcpDiscovery === true }
      ))
    ];
  } catch (error) {
    if (input.failClosedMcpDiscovery) {
      throw new Error(
        'Codex MCP configuration could not be completely inspected and disabled for the browser development boundary.',
        { cause: error }
      );
    }
    return overrides;
  }
}

export async function listDisabledCodexMcpServerConfigOverrides(
  executable: string,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  options: { requireCompleteDiscovery?: boolean } = {}
): Promise<string[]> {
  const { stdout } = await execFilePortable(executable, ['mcp', 'list', '--json'], {
    cwd,
    env: sanitizeEnvironment(environment ?? process.env),
    timeout: CODEX_MCP_LIST_TIMEOUT_MS,
    maxBuffer: 1024 * 1024
  });
  return parseDisabledCodexMcpServerConfigOverrides(stdout, options);
}

export function parseEnabledCodexMcpServerNames(stdout: string): string[] {
  return parseDisabledCodexMcpServerConfigOverrides(stdout)
    .map((override) => /^mcp_servers\.([A-Za-z0-9_-]+)=/.exec(override)?.[1])
    .filter((name): name is string => name !== undefined);
}

export function parseDisabledCodexMcpServerConfigOverrides(
  stdout: string,
  options: { requireCompleteDiscovery?: boolean } = {}
): string[] {
  const payload = JSON.parse(stdout) as unknown;
  if (!Array.isArray(payload)) {
    if (options.requireCompleteDiscovery) throw incompleteMcpDiscovery();
    return [];
  }

  const overrides = new Map<string, string>();
  for (const item of payload) {
    if (!item || typeof item !== 'object') {
      if (options.requireCompleteDiscovery) throw incompleteMcpDiscovery();
      continue;
    }
    const entry = item as CodexMcpServerListEntry;
    if (entry.enabled !== true) {
      if (options.requireCompleteDiscovery && entry.enabled !== false) {
        throw incompleteMcpDiscovery();
      }
      continue;
    }
    const override = mcpDisableConfigOverride(entry);
    if (override) {
      overrides.set(override.name, override.config);
    } else if (options.requireCompleteDiscovery) {
      throw incompleteMcpDiscovery();
    }
  }
  return [...overrides.values()];
}

function incompleteMcpDiscovery(): Error {
  return new Error('Codex reported an enabled MCP server that could not be disabled safely.');
}

function mcpDisableConfigOverride(
  entry: CodexMcpServerListEntry
): { name: string; config: string } | undefined {
  if (
    entry.enabled !== true ||
    typeof entry.name !== 'string' ||
    !isCodexConfigBareKeySegment(entry.name) ||
    !entry.transport ||
    typeof entry.transport !== 'object'
  ) {
    return undefined;
  }

  const transport = entry.transport as CodexMcpTransport;
  const fields = ['enabled=false'];
  if (transport.type === 'stdio') {
    if (typeof transport.command !== 'string') {
      return undefined;
    }
    fields.push(`command=${tomlString(transport.command)}`);
    if (Array.isArray(transport.args) && transport.args.every((arg) => typeof arg === 'string')) {
      fields.push(`args=${tomlStringArray(transport.args)}`);
    }
    if (typeof transport.cwd === 'string') {
      fields.push(`cwd=${tomlString(transport.cwd)}`);
    }
  } else if (transport.type === 'streamable_http') {
    if (typeof transport.url !== 'string') {
      return undefined;
    }
    fields.push(`url=${tomlString(transport.url)}`);
  } else {
    return undefined;
  }

  return {
    name: entry.name,
    config: `mcp_servers.${entry.name}={${fields.join(', ')}}`
  };
}

function isCodexConfigBareKeySegment(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}
