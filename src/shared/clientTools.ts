/**
 * Names of the tools Task Monki itself serves to agents, and how the UI describes a call to each.
 * Core defines each tool's schema beside its owner; the renderer only needs the names.
 */
export const INSPECT_DESIGN_TOOL_NAME = 'inspect_design';
export const INSPECT_PREVIEW_TOOL_NAME = 'inspect_preview';
export const PROPOSE_PREVIEW_CONFIGURATION_TOOL_NAME = 'propose_preview_configuration';

const CLIENT_TOOL_ACTIVITY_LABELS: Record<string, string> = {
  [INSPECT_DESIGN_TOOL_NAME]: 'Checking the design',
  [INSPECT_PREVIEW_TOOL_NAME]: 'Reading the preview',
  [PROPOSE_PREVIEW_CONFIGURATION_TOOL_NAME]: 'Proposing a configuration'
};

/** What a call to a Task Monki tool did, in the person's words; undefined for any other tool. */
export function clientToolActivityLabel(tool: string | undefined): string | undefined {
  return tool ? CLIENT_TOOL_ACTIVITY_LABELS[tool] : undefined;
}

/**
 * The Task Monki tool a provider's tool identifier names, if any. Providers spell MCP tool
 * names as `mcp__<server>__<tool>`, `<server>__<tool>`, `<server>_<tool>` or the bare name.
 */
export function clientToolNameFromIdentifier(identifier: string | undefined): string | undefined {
  if (!identifier) return undefined;
  return Object.keys(CLIENT_TOOL_ACTIVITY_LABELS).find(
    (tool) => identifier === tool || identifier.endsWith(`__${tool}`) || identifier.endsWith(`_${tool}`) || identifier.endsWith(`: ${tool}`)
  );
}
